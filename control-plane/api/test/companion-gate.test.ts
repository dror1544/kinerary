/**
 * The companion gate (#625, S1): one platform-neutral function decides the
 * companion path of the relay, for any platform.
 *
 * What this pins that the existing relay suites do not: the gate is driven
 * directly with an `InboundTurn`, for `platform: "telegram"` AND
 * `platform: "whatsapp"`, over ONE table of cases, and must give the same
 * decision for both (S1 has no per-platform wording - that is S3). The
 * existing suites (relay-dispatch, group-judge-dispatch, relay-group-attachments
 * and the rest) pin that Telegram sees not one byte of difference; this file
 * pins that nothing in the gate knows which platform it is serving.
 *
 * The second half pins AC-2's "imports no Telegram type": `companion-gate.ts`
 * and the relay modules it imports are read as text.
 *
 * DB-backed cases need the control-plane test database.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { setCompanionExpectsReply, type ChatRoute } from "../src/chat-router.js";
import { applyMigrations } from "../src/migrations.js";
import {
  companionGate,
  type AttachmentRef,
  type GateDecision,
  type GateDeps,
  type GateOutcome,
  type InboundTurn,
} from "../src/relay/companion-gate.js";
import { GroupContext } from "../src/relay/group-context.js";
import type { GroupJudge, JudgeOutcome } from "../src/relay/group-judge.js";
import { PendingAttachments } from "../src/relay/pending-attachments.js";
import type { WireMessageEvent } from "../src/relay/protocol.js";
import { addressedMark, conversationMark, reactionAnswerMark } from "../src/relay/stay-silent.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const PLATFORMS = ["telegram", "whatsapp"] as const;
type Platform = (typeof PLATFORMS)[number];

const NAMES = ["Liv"];
const HANDLE = "KinneryBot";
const PROFILE = "companion-colmar";
const ANN = "101";
const BEN = "102";
const YES: JudgeOutcome = { kind: "yes", confidence: 0.9, ms: 300, model: "fake/judge" };
const NO: JudgeOutcome = { kind: "no", confidence: 0.9, ms: 250, model: "fake/judge", belowThreshold: false };
const DOC: AttachmentRef = { fileId: "file-1", kind: "document", mime: "application/pdf", filename: "plan.pdf" };

/** One chat id per platform: the shape a binding of that platform has. */
const GROUP_ID: Record<Platform, string> = { telegram: "-1004100001", whatsapp: "120363041000001@g.us" };
const DM_ID: Record<Platform, string> = { telegram: "101", whatsapp: "972500000001@p" };

interface Fixture {
  pool: pg.Pool;
  tripId: string;
}

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** A trip with a group and a DM bound for BOTH platforms' chat ids, so the windows can be read and written. */
async function withFixture(fn: (fix: Fixture) => Promise<void>): Promise<void> {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    const userId = testId("user");
    const tripId = testId("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [testId("memb"), tripId, userId],
    );
    await pool.query("UPDATE control_plane.trips SET assistant_names = $2 WHERE id = $1", [tripId, NAMES]);
    for (const platform of PLATFORMS) {
      for (const chatId of [GROUP_ID[platform], DM_ID[platform]]) {
        await pool.query(
          "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, $3)",
          [chatId, tripId, PROFILE],
        );
      }
    }
    await fn({ pool, tripId });
  } finally {
    await pool.end();
  }
}

/** What `resolveInbound` hands a routed turn: a companion route with a profile. */
type RoutedRoute = Extract<GateOutcome, { kind: "event" }>["route"];

function route(fix: Fixture, hermesProfile: string | null = PROFILE): ChatRoute {
  return { kind: "companion", tripId: fix.tripId, hermesProfile, assistantNames: NAMES };
}

/** A decision only a platform hook can add (Telegram's organizer-document route is one). */
type PlatformDecision = { kind: "platform_route"; note: string };

interface TurnSpec {
  text?: string;
  group?: boolean;
  sender?: string | null;
  senderName?: string | null;
  attachment?: AttachmentRef | null;
  caption?: string;
  isReplyToAssistant?: boolean;
  repliedToText?: string;
  repliedToSenderId?: string;
  repliedToAttachment?: (AttachmentRef & { caption?: string }) | null;
}

function turnFor(platform: Platform, spec: TurnSpec = {}): InboundTurn {
  const group = spec.group ?? true;
  const text = spec.text ?? "";
  return {
    platform,
    chatId: group ? GROUP_ID[platform] : DM_ID[platform],
    chatType: group ? "group" : "dm",
    // The SAME raw type for both platforms, on purpose: it feeds analytics' channel
    // classification, which has no WhatsApp wording until S3. "whatsapp" here would
    // make assistant-event facts differ ("unclassified" vs "group"), and S1 has no
    // per-platform behaviour to pin.
    rawChatType: group ? "supergroup" : "private",
    chatName: null,
    senderId: spec.sender === undefined ? ANN : spec.sender,
    senderName: spec.senderName === undefined ? "Ann" : spec.senderName,
    text,
    ...(spec.caption ? { caption: spec.caption } : {}),
    messageId: "9",
    isReplyToAssistant: spec.isReplyToAssistant ?? false,
    ...(spec.repliedToSenderId ? { repliedToSenderId: spec.repliedToSenderId } : {}),
    ...(spec.repliedToText ? { repliedToText: spec.repliedToText } : {}),
    attachment: spec.attachment ?? null,
    repliedToAttachment: spec.repliedToAttachment ?? null,
  };
}

/** What a platform's own normalisation hands the gate: the wire event for the turn, and the resolved route. */
function eventOutcome(turn: InboundTurn, fix: Fixture): GateOutcome & { kind: "event" } {
  // `GateOutcome`'s event arm has no `attachment`: the gate reads the turn's.
  const event: WireMessageEvent = {
    text: turn.text,
    message_type: "text",
    source: {
      platform: turn.platform,
      chat_id: turn.chatId,
      chat_type: turn.chatType,
      chat_name: turn.chatName,
      user_id: turn.senderId,
      user_name: turn.senderName,
      thread_id: null,
      chat_topic: null,
      profile: PROFILE,
    },
    message_id: turn.messageId,
  };
  return { kind: "event", event, route: route(fix) as RoutedRoute };
}

function scriptedJudge(...outcomes: JudgeOutcome[]): GroupJudge & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    model: () => "fake/judge",
    async judge(input) {
      calls.push(input.text);
      return outcomes[Math.min(i++, outcomes.length - 1)]!;
    },
  };
}

function depsFor(fix: Fixture, extra: Partial<GateDeps<PlatformDecision>> = {}): GateDeps<PlatformDecision> {
  return {
    db: fix.pool,
    log: () => {},
    assistantHandle: HANDLE,
    resolvePerson: async () => null,
    outageNotices: { allow: () => true },
    companionPendingText: "still finishing",
    ...extra,
  };
}

/**
 * The decision with the two things that legitimately differ between platforms
 * taken out, BY FIELD (a global replace would also rewrite a sender id that
 * happens to equal a DM chat id): the chat ids, and `source.platform`, which
 * is the turn's own and is passed through, not decided.
 */
function shape(decision: GateDecision<PlatformDecision> | GateDecision<PlatformDecision>[], platform: Platform): unknown {
  const chatKeys = new Set(["chatId", "chat_id", "chatKey"]);
  return JSON.parse(
    JSON.stringify(decision, (key, value) => {
      if (typeof value === "function") return "[fn]";
      if (chatKeys.has(key) && value === GROUP_ID[platform]) return "<GROUP>";
      if (chatKeys.has(key) && value === DM_ID[platform]) return "<DM>";
      if (key === "platform" && value === platform) return "<platform>";
      if (key === "tripId") return "<trip>";
      return value;
    }),
  );
}

/**
 * One table. Each case runs for each platform, in its own fresh database, and
 * `check` receives the decision with the platform's chat ids replaced by
 * <GROUP> / <DM>, so the SAME expectation holds for both.
 */
interface Case {
  name: string;
  run(platform: Platform, fix: Fixture): Promise<GateDecision<PlatformDecision> | GateDecision<PlatformDecision>[]>;
  expect(shaped: unknown, platform: Platform): void;
}

const eventOf = (d: unknown) => (d as { event: WireMessageEvent }).event;

const CASES: Case[] = [
  {
    name: "a DM is addressed by construction and forwarded with no mark",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "what time is check-in?", group: false });
      return companionGate(turn, eventOutcome(turn, fix), depsFor(fix));
    },
    expect(d) {
      assert.equal((d as { kind: string }).kind, "to_gateway");
      assert.equal(eventOf(d).text, "what time is check-in?");
      assert.equal((d as { explicit?: boolean }).explicit, undefined);
    },
  },
  {
    name: "a group message that addresses nobody is NOT_ADDRESSED, and held as overheard context",
    async run(platform, fix) {
      const context = new GroupContext();
      const addressed = turnFor(platform, { text: "Liv, where is the hotel?", sender: BEN });
      const chatter = turnFor(platform, { text: "I am so tired" });
      const first = await companionGate(chatter, eventOutcome(chatter, fix), depsFor(fix, { groupContext: context }));
      const second = await companionGate(addressed, eventOutcome(addressed, fix), depsFor(fix, { groupContext: context }));
      return [first, second];
    },
    expect(d) {
      const [first, second] = d as unknown as Array<{ kind: string; reason?: string; event?: WireMessageEvent }>;
      assert.deepEqual(first, { kind: "drop", reason: "NOT_ADDRESSED" });
      assert.equal(second!.kind, "to_gateway");
      assert.equal(
        second!.event!.text,
        `${addressedMark(HANDLE)}\n\n`.replace(/^/, "[overheard in the group since you last spoke — background only, not addressed to you]\nAnn: I am so tired\n[end of overheard]\n\n")
          + "Liv, where is the hotel?",
      );
    },
  },
  {
    name: "addressed by name: forwarded, explicit, with the addressed mark",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "Liv, where is the hotel?" });
      return companionGate(turn, eventOutcome(turn, fix), depsFor(fix));
    },
    expect(d) {
      assert.equal((d as { kind: string }).kind, "to_gateway");
      assert.equal((d as { explicit?: boolean }).explicit, true);
      assert.equal(eventOf(d).text, `${addressedMark(HANDLE)}\n\nLiv, where is the hotel?`);
    },
  },
  {
    name: "addressed by the assistant's handle",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: `@${HANDLE} where is the hotel?` });
      return companionGate(turn, eventOutcome(turn, fix), depsFor(fix));
    },
    expect(d) {
      assert.equal((d as { explicit?: boolean }).explicit, true);
    },
  },
  {
    name: "a reply to one of the assistant's messages is explicit",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "ok thanks", isReplyToAssistant: true });
      return companionGate(turn, eventOutcome(turn, fix), depsFor(fix));
    },
    expect(d) {
      assert.equal((d as { explicit?: boolean }).explicit, true);
      assert.equal(eventOf(d).text, `${addressedMark(HANDLE)}\n\nok thanks`);
    },
  },
  {
    name: "the one-shot reply window: the next message is addressed, unmarked, and the window is consumed",
    async run(platform, fix) {
      await setCompanionExpectsReply(fix.pool, GROUP_ID[platform], true);
      const turn = turnFor(platform, { text: "yes please" });
      const first = await companionGate(turn, eventOutcome(turn, fix), depsFor(fix));
      const again = turnFor(platform, { text: "and another thing", sender: BEN, senderName: "Ben" });
      const second = await companionGate(again, eventOutcome(again, fix), depsFor(fix));
      return [first, second];
    },
    expect(d) {
      const [first, second] = d as unknown as Array<{ kind: string; explicit?: boolean; event?: WireMessageEvent; reason?: string }>;
      assert.equal(first!.kind, "to_gateway");
      assert.equal(first!.explicit, undefined);
      assert.equal(first!.event!.text, "yes please");
      assert.deepEqual(second, { kind: "drop", reason: "NOT_ADDRESSED" });
    },
  },
  {
    name: "the conversation window: after being addressed, the same sender's untagged follow-up is forwarded with the conversation mark",
    async run(platform, fix) {
      const named = turnFor(platform, { text: "Liv, hello" });
      await companionGate(named, eventOutcome(named, fix), depsFor(fix));
      const follow = turnFor(platform, { text: "and what about dinner?" });
      const other = turnFor(platform, { text: "and what about dinner?", sender: BEN, senderName: "Ben" });
      return [
        await companionGate(follow, eventOutcome(follow, fix), depsFor(fix)),
        await companionGate(other, eventOutcome(other, fix), depsFor(fix)),
      ];
    },
    expect(d) {
      const [follow, other] = d as unknown as Array<{ kind: string; event?: WireMessageEvent; reason?: string }>;
      assert.equal(follow!.kind, "to_gateway");
      assert.equal(follow!.event!.text, `${conversationMark()}\n\nand what about dinner?`);
      assert.deepEqual(other, { kind: "drop", reason: "NOT_ADDRESSED" });
    },
  },
  {
    name: "a bare reaction is not forwarded, and is not judged",
    async run(platform, fix) {
      const judge = scriptedJudge(YES);
      const turn = turnFor(platform, { text: "\u{1F44D}" });
      const decision = await companionGate(turn, eventOutcome(turn, fix), depsFor(fix, { groupJudge: judge }));
      return [decision, { kind: "drop", reason: `judge asked ${judge.calls.length}` } as GateDecision<PlatformDecision>];
    },
    expect(d) {
      const [decision, asked] = d as unknown as Array<{ kind: string; reason?: string }>;
      assert.deepEqual(decision, { kind: "drop", reason: "NOT_ADDRESSED" });
      assert.equal(asked!.reason, "judge asked 0");
    },
  },
  {
    name: "a reaction in reply to a question of the assistant's is an answer, marked as one",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "\u{1F44D}", isReplyToAssistant: true, repliedToText: "Should I update the site?" });
      return companionGate(turn, eventOutcome(turn, fix), depsFor(fix));
    },
    expect(d) {
      assert.equal((d as { kind: string }).kind, "to_gateway");
      assert.equal((d as { explicit?: boolean }).explicit, true);
    },
  },
  {
    name: "the group judge: yes forwards with the conversation mark; no does not; neither is asked for a DM",
    async run(platform, fix) {
      await fix.pool.query("UPDATE control_plane.telegram_chat_bindings SET proactive_level = 3 WHERE chat_id = $1", [GROUP_ID[platform]]);
      const yes = scriptedJudge(YES);
      const no = scriptedJudge(NO);
      const turn = turnFor(platform, { text: "does anyone know the wifi password?" });
      const forwarded = await companionGate(turn, eventOutcome(turn, fix), depsFor(fix, { groupJudge: yes }));
      const other = turnFor(platform, { text: "does anyone know the wifi password?", sender: BEN, senderName: "Ben" });
      const refused = await companionGate(other, eventOutcome(other, fix), depsFor(fix, { groupJudge: no }));
      return [forwarded, refused];
    },
    expect(d) {
      const [forwarded, refused] = d as unknown as Array<{ kind: string; event?: WireMessageEvent }>;
      assert.equal(forwarded!.kind, "to_gateway");
      assert.equal(forwarded!.event!.text, `${conversationMark()}\n\ndoes anyone know the wifi password?`);
      assert.deepEqual(refused, { kind: "drop", reason: "NOT_ADDRESSED" });
    },
  },
  {
    name: "the deferred judge: judge_pending first, then the same turn again with the verdict",
    async run(platform, fix) {
      await fix.pool.query("UPDATE control_plane.telegram_chat_bindings SET proactive_level = 3 WHERE chat_id = $1", [GROUP_ID[platform]]);
      const judge = scriptedJudge(YES);
      const turn = turnFor(platform, { text: "does anyone know the wifi password?" });
      const first = await companionGate(turn, eventOutcome(turn, fix), depsFor(fix, { groupJudge: judge, deferJudge: true }));
      assert.equal(first.kind, "judge_pending");
      assert.equal(judge.calls.length, 0, "deferred: nothing asked yet");
      const verdict = await (first as Extract<GateDecision, { kind: "judge_pending" }>).ask();
      assert.equal(judge.calls.length, 1);
      const again = turnFor(platform, { text: "does anyone know the wifi password?" });
      const second = await companionGate(again, eventOutcome(again, fix), depsFor(fix, { groupJudge: judge, judgedOutcome: verdict }));
      assert.equal(judge.calls.length, 1, "never asked twice");
      return [{ kind: "drop", reason: "pending", ...{ chatId: (first as { chatId: string }).chatId } } as unknown as GateDecision<PlatformDecision>, second];
    },
    expect(d) {
      const [pending, second] = d as unknown as Array<{ chatId?: string; kind: string; event?: WireMessageEvent }>;
      assert.equal(pending!.chatId, "<GROUP>");
      assert.equal(second!.kind, "to_gateway");
      assert.equal(second!.event!.text, `${conversationMark()}\n\ndoes anyone know the wifi password?`);
    },
  },
  {
    name: "a document sent to the group addressing nobody is held, and joins its sender's next addressed message",
    async run(platform, fix) {
      const pending = new PendingAttachments();
      const media = {
        fetchAttachment: async () => ({ bytes: Buffer.from("%PDF-1.4 fake"), mime: "application/pdf" }),
        mediaStore: { put: () => "m1" },
        mediaBaseUrl: "http://relay.test",
      };
      const sent = turnFor(platform, { text: "", attachment: DOC });
      const held = await companionGate(sent, eventOutcome(sent, fix), depsFor(fix, { pendingAttachments: pending, ...media }));
      const ask = turnFor(platform, { text: "Liv, put that on the site" });
      const joined = await companionGate(ask, eventOutcome(ask, fix), depsFor(fix, { pendingAttachments: pending, ...media }));
      return [held, joined];
    },
    expect(d) {
      const [held, joined] = d as unknown as Array<{ kind: string; reason?: string; event?: WireMessageEvent }>;
      assert.deepEqual(held, { kind: "drop", reason: "NOT_ADDRESSED" });
      assert.equal(joined!.kind, "to_gateway");
      assert.deepEqual(joined!.event!.media_urls, ["http://relay.test/relay/media/m1"]);
      assert.equal(joined!.event!.message_type, "document");
      assert.equal(joined!.event!.media![0]!.filename, "plan.pdf");
    },
  },
  {
    name: "a document replied to joins only for the same sender",
    async run(platform, fix) {
      const media = {
        fetchAttachment: async () => ({ bytes: Buffer.from("%PDF-1.4 fake"), mime: "application/pdf" }),
        mediaStore: { put: () => "m2" },
        mediaBaseUrl: "http://relay.test",
      };
      const mine = turnFor(platform, { text: "Liv, add this", repliedToSenderId: ANN, repliedToAttachment: { ...DOC, caption: "the plan" } });
      const theirs = turnFor(platform, { text: "Liv, add this", repliedToSenderId: BEN, repliedToAttachment: DOC });
      return [
        await companionGate(mine, eventOutcome(mine, fix), depsFor(fix, { ...media })),
        await companionGate(theirs, eventOutcome(theirs, fix), depsFor(fix, { ...media })),
      ];
    },
    expect(d) {
      const [mine, theirs] = d as unknown as Array<{ event: WireMessageEvent }>;
      assert.equal(mine!.event.media?.length, 1);
      assert.equal(mine!.event.media![0]!.caption, "the plan");
      assert.equal(theirs!.event.media, undefined);
    },
  },
  {
    name: "beforeMarks runs after the sender is identified and, when it decides, ends the turn before any mark",
    async run(platform, fix) {
      const seen: string[] = [];
      const turn = turnFor(platform, { text: "Liv, add this", sender: ANN });
      const outcome = eventOutcome(turn, fix);
      const decision = await companionGate(
        turn,
        outcome,
        depsFor(fix, {
          resolvePerson: async () => ({ username: "ann", displayName: "Ann (organizer)", role: "organizer" }),
          beforeMarks: async (_turn, routed, ctx) => {
            seen.push(`${routed.tripId === fix.tripId}|${ctx.event.source.user_name}|${ctx.event.text}`);
            return { kind: "platform_route", note: "handled elsewhere" };
          },
        }),
      );
      return [decision, { kind: "drop", reason: seen.join(",") } as GateDecision<PlatformDecision>];
    },
    expect(d) {
      const [decision, seen] = d as unknown as Array<{ kind: string; note?: string; reason?: string }>;
      assert.equal(decision!.kind, "platform_route");
      assert.equal(decision!.note, "handled elsewhere");
      assert.equal(seen!.reason, "true|Ann (organizer)|Liv, add this");
    },
  },
  {
    name: "beforeMarks answering null leaves the turn to the marks",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "Liv, add this" });
      return companionGate(turn, eventOutcome(turn, fix), depsFor(fix, { beforeMarks: async () => null }));
    },
    expect(d) {
      assert.equal((d as { kind: string }).kind, "to_gateway");
      assert.equal(eventOf(d).text, `${addressedMark(HANDLE)}\n\nLiv, add this`);
    },
  },
  {
    name: "a known sender is named as the trip knows them",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "Liv, hi", group: false });
      return companionGate(
        turn,
        eventOutcome(turn, fix),
        depsFor(fix, { resolvePerson: async () => ({ username: "ann", displayName: "Ann Cohen", role: "participant" }) }),
      );
    },
    expect(d) {
      assert.equal(eventOf(d).source.user_name, "Ann Cohen");
    },
  },
  {
    name: "assistant events on: the forward carries metadata only, with the sender's link role",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "Liv, hi" });
      return companionGate(
        turn,
        eventOutcome(turn, fix),
        depsFor(fix, {
          assistantEvents: true,
          resolvePerson: async () => ({ username: "ann", displayName: null, role: "organizer" }),
        }),
      );
    },
    expect(d) {
      const analytics = (d as { analytics: Record<string, unknown> }).analytics;
      assert.equal(analytics.triggerType, "name");
      assert.equal(analytics.requesterRole, "organizer");
      assert.equal(analytics.attachmentsJoined, 0);
    },
  },
  // ── the pending-companion branch ────────────────────────────────────────────
  {
    name: "pending: a trip whose assistant was never announced is told, in the platform-neutral fixed text",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "hello?", group: false });
      return companionGate(turn, { kind: "dropped", reason: "COMPANION_PENDING", route: route(fix) }, depsFor(fix));
    },
    expect(d) {
      assert.deepEqual(d, { kind: "reply", reply: { chatId: "<DM>", text: "still finishing" } });
    },
  },
  {
    name: "pending: once announced, an outage line goes to a DM, and to an addressed group message at most once a window; chatter never",
    async run(platform, fix) {
      await fix.pool.query(
        `INSERT INTO control_plane.notification_outbox
           (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, sent_at)
         VALUES ('nob_' || md5(random()::text), $1, 'companion_ready', '700000000', '{}'::jsonb, NULL, 'companion_ready', 'provisioner', 'sent', now())`,
        [fix.tripId],
      );
      let allowed = true;
      const limiter = { allow: () => { const was = allowed; allowed = false; return was; } };
      const dm = turnFor(platform, { text: "hello?", group: false });
      const chatter = turnFor(platform, { text: "so tired" });
      const named = turnFor(platform, { text: "Liv, are you there?" });
      const namedAgain = turnFor(platform, { text: "Liv, are you there?" });
      const pendingOutcome = (): GateOutcome => ({ kind: "dropped", reason: "COMPANION_PENDING", route: route(fix) });
      const deps = depsFor(fix, { outageNotices: limiter });
      return [
        await companionGate(dm, pendingOutcome(), deps),
        await companionGate(chatter, pendingOutcome(), deps),
        await companionGate(named, pendingOutcome(), deps),
        await companionGate(namedAgain, pendingOutcome(), deps),
      ];
    },
    expect(d) {
      const [dm, chatter, named, namedAgain] = d as unknown as Array<{ kind: string; reason?: string; reply?: { text: string } }>;
      assert.equal(dm!.kind, "reply");
      assert.notEqual(dm!.reply!.text, "still finishing", "announced: the outage line is owed, not 'still finishing'");
      assert.deepEqual(chatter, { kind: "drop", reason: "NOT_ADDRESSED" });
      assert.equal(named!.kind, "reply");
      assert.deepEqual(namedAgain, { kind: "drop", reason: "COMPANION_UNAVAILABLE_NOTICE_LIMITED" });
    },
  },
  // ── F1/F3: the gate does not trust its caller for the route, the profile, the chat or the sender ──
  ...(
    [
      ["an unbound route", (o: Record<string, unknown>, fix: Fixture) => { o.route = { kind: "unbound" }; void fix; }],
      ["an interview route", (o: Record<string, unknown>, fix: Fixture) => { o.route = { kind: "interview", sessionId: "s", tripId: fix.tripId }; }],
      ["a profile that is not the route's", (o: Record<string, unknown>) => { (o.event as WireMessageEvent).source.profile = "companion-someone-else"; }],
      ["a route with no profile", (o: Record<string, unknown>, fix: Fixture) => { o.route = route(fix, null); }],
      ["an event for a different chat", (o: Record<string, unknown>) => { (o.event as WireMessageEvent).source.chat_id = "-1009999999"; }],
      ["an event from a different sender", (o: Record<string, unknown>) => { (o.event as WireMessageEvent).source.user_id = "999"; }],
    ] as const
  ).map(([what, tamper]): Case => ({
    name: `ROUTE_MISMATCH: ${what} is dropped before anything is read, written or forwarded`,
    async run(platform, fix) {
      const lines: string[] = [];
      const judge = scriptedJudge(YES);
      const context = new GroupContext();
      const turn = turnFor(platform, { text: "Liv, where is the hotel?" });
      const outcome = eventOutcome(turn, fix) as unknown as Record<string, unknown>;
      tamper(outcome, fix);
      await fix.pool.query("UPDATE control_plane.telegram_chat_bindings SET proactive_level = 3 WHERE chat_id = $1", [turn.chatId]);
      const decision = await companionGate(
        turn,
        outcome as unknown as GateOutcome,
        depsFor(fix, { log: (line) => lines.push(line), groupJudge: judge, groupContext: context, assistantEvents: true, beforeMarks: async () => { lines.push("beforeMarks ran"); return null; } }),
      );
      // No window was opened for the sender, the judge was never asked, and the one line logged names no text or id.
      const opened = await fix.pool.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND conversation_until IS NOT NULL", [turn.chatId]);
      assert.equal(opened.rowCount, 0, "no conversation window was opened");
      assert.equal(judge.calls.length, 0);
      assert.ok(!lines.includes("beforeMarks ran"), "the platform hook did not run");
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /trip_bot\.route_mismatch/);
      assert.ok(!lines[0]!.includes("hotel") && !lines[0]!.includes(turn.chatId) && !lines[0]!.includes(fix.tripId), "the log line carries no text and no id");
      return decision;
    },
    expect(d) {
      assert.deepEqual(d, { kind: "drop", reason: "ROUTE_MISMATCH" });
    },
  })),
  {
    name: "every other drop reason is a drop with that reason",
    async run(platform, fix) {
      const turn = turnFor(platform, { text: "x" });
      return companionGate(turn, { kind: "dropped", reason: "NO_TEXT" }, depsFor(fix));
    },
    expect(d) {
      assert.deepEqual(d, { kind: "drop", reason: "NO_TEXT" });
    },
  },
];

describe("companionGate: one decision for both platforms", { skip: SKIP }, () => {
  for (const testCase of CASES) {
    test(testCase.name, async () => {
      const results = new Map<Platform, unknown>();
      for (const platform of PLATFORMS) {
        await withFixture(async (fix) => {
          const out = await testCase.run(platform, fix);
          const shaped = shape(out, platform);
          testCase.expect(shaped, platform);
          results.set(platform, shaped);
        });
      }
      assert.deepEqual(results.get("whatsapp"), results.get("telegram"), "the gate must decide the same for both platforms");
    });
  }
});

// ── AC-2: imports no Telegram type ──────────────────────────────────────────────

const relayDir = fileURLToPath(new URL("../src/relay/", import.meta.url));
const TELEGRAM_TYPE = /\bTelegram[A-Z][A-Za-z]*\b/;

function importsOf(source: string): Array<{ names: string; from: string }> {
  const found: Array<{ names: string; from: string }> = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+"([^"]+)"/g)) {
    found.push({ names: match[1]!, from: match[2]! });
  }
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{[^}]*\}\s+from\s+"([^"]+)"/g)) {
    found.push({ names: "", from: match[1]! });
  }
  return found;
}

describe("companion-gate.ts imports no Telegram type (AC-2)", () => {
  const gateSource = readFileSync(`${relayDir}companion-gate.ts`, "utf8");

  test("its own text names no Telegram type", () => {
    assert.equal(TELEGRAM_TYPE.exec(gateSource)?.[0], undefined);
  });

  test("it does not import the Telegram modules", () => {
    const modules = importsOf(gateSource).map((i) => i.from);
    for (const forbidden of ["./normalize.js", "./telegram-api.js", "./dispatch.js", "./poller.js", "../identity.js"]) {
      assert.ok(!modules.includes(forbidden), `companion-gate.ts must not import ${forbidden}`);
    }
  });

  test("no import specifier names a Telegram type", () => {
    for (const { names, from } of importsOf(gateSource)) {
      assert.equal(TELEGRAM_TYPE.exec(names)?.[0], undefined, `import from ${from} names a Telegram type`);
    }
  });

  test("the relay modules it imports name none either (one level down)", () => {
    const local = importsOf(gateSource)
      .map((i) => i.from)
      .filter((from) => from.startsWith("./"))
      .map((from) => from.replace(/\.js$/, ".ts"));
    assert.ok(local.length > 0);
    for (const file of local) {
      const source = readFileSync(`${relayDir}${file.slice(2)}`, "utf8");
      assert.equal(TELEGRAM_TYPE.exec(source)?.[0], undefined, `${file} names a Telegram type`);
      for (const { from } of importsOf(source)) {
        assert.notEqual(from, "./normalize.js", `${file} imports ./normalize.js`);
      }
    }
  });
});
