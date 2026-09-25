/**
 * An anonymized replay of one real trip's week, through the real relay, and
 * what the assistant-event table alone can then say about it (#177).
 *
 * The source is the 2026-09-23 hand evaluation
 * (docs/test-reports/nir-trip-assistant-experience-2026-09-23.md): four
 * document uploads in the organizer's DM, every one failing; a family group
 * that mostly talked among themselves; a document dropped into the group and
 * then asked about; questions answered within seconds to a minute. That
 * evaluation had to read transcripts to count any of it. Here the same counts
 * come out of `control_plane.assistant_events` — with no row holding an
 * identifier or a word anyone wrote.
 *
 * Production code does the work: `dispatchUpdate` with the options the poll
 * loop passes, `applyDecision`, a real `RelayConnector` on a real socket, the
 * emitter, the writer, the rollup. The edges are fakes: Telegram (a recorder),
 * the Hermes gateway (a WebSocket client that answers when told to), the model
 * runner (fails every read), and the clock the emitter reads, so every latency
 * is exact.
 *
 * Also held here: with the emitter's sink throwing or hanging the family sees
 * exactly the same messages in the same order (design §12); and with the
 * setting unset nothing is written at all.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { WebSocket } from "ws";
import { resolveChatRoute, startFromDeepLink } from "../src/chat-router.js";
import { issueEnrollment } from "../src/enrollment.js";
import { digestTelegramId } from "../src/identity.js";
import { confirmIntakeForChat } from "../src/interview.js";
import { applyMigrations } from "../src/migrations.js";
import type { RunnerResult, StructuredModelRunner } from "../src/model-runner.js";
import { inboundFacts } from "../src/analytics/relay-facts.js";
import {
  assistantEventsFromEnv,
  databaseEventSink,
  RelayAssistantEvents,
  type AssistantEventSink,
} from "../src/analytics/emitter.js";
import { rollupAssistantEvents } from "../src/analytics/store.js";
import { RelayConnector } from "../src/relay/connector.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { GroupContext } from "../src/relay/group-context.js";
import { MediaStore } from "../src/relay/media-store.js";
import type { TelegramMessage, TelegramUpdate } from "../src/relay/normalize.js";
import { PendingAttachments } from "../src/relay/pending-attachments.js";
import { applyDecision, settleDocumentCorrections, type TripBotPollerDeps } from "../src/relay/poller.js";
import { makeUpgradeToken, type WireMessageEvent } from "../src/relay/protocol.js";
import type { SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

// ── The cast, anonymized. Long, distinctive values so a substring search means something. ──

const ORGANIZER_ID = "7123456789"; // their Telegram user id — and their DM's chat id
const MEMBER_ID = "7234567891";
const GROUP = "-1009876543210";
const BOT = { id: "7000000001", username: "KineraryTestBot" };
const BOT_TOKEN = "7000000001:AAHfakeTokenForThePrivacyCheck0000";
const PROFILE = "companion-anon-trip";
const SECRET = "replay-gateway-secret";
const MEDIA_BASE = "http://127.0.0.1:4312";
const ORGANIZER_NAME = "Noam";
const ORGANIZER_DISPLAY = "נועם אלון";
const ORGANIZER_USERNAME = "noamalon";
const MEMBER_NAME = "Tamar";
const ITINERARY_URL = "https://tours.example/itinerary/anon-2026";

const DM_DOCUMENTS = [
  { name: "kyoto-hotel-voucher.pdf", body: "Kyoto hotel voucher KX-5512\n" },
  { name: "osaka-ryokan-booking.pdf", body: "Osaka ryokan booking OR-7781\n" },
  { name: "hakone-transfer.pdf", body: "Hakone transfer HT-3390\n" },
  { name: "tour-itinerary-noext", body: "Day by day itinerary\n" },
];
const GROUP_PDF = { file_id: "BQAC-anon-group-itinerary", file_name: "family-itinerary-final.pdf", mime_type: "application/pdf", file_size: 760998 };

const CHATTER = [
  [MEMBER_ID, "did everyone pack the rail passes"],
  [ORGANIZER_ID, "yes, in the blue bag"],
  [MEMBER_ID, "breakfast not before nine please"],
  [MEMBER_ID, `the tour company sent this ${ITINERARY_URL}`],
  [ORGANIZER_ID, "sending you all the plan now"],
] as const;
const ATTACH_IT = "ליב, תצרפי את זה לאתר";
const QUESTIONS = [
  { from: MEMBER_ID, text: "@KineraryTestBot what's the weather in Kyoto on Monday", latencyMs: 12_000, replyToBot: false },
  { from: ORGANIZER_ID, text: "Liv, where can we eat near tonight's hotel", latencyMs: 30_000, replyToBot: false },
  { from: MEMBER_ID, text: "and is it walkable from the station", latencyMs: 8_000, replyToBot: true },
];
const WHILE_DOWN = "Liv, how long to Kyoto station from here";
const NEVER_ANSWERED = "Liv, and what about tomorrow";
const REPLY_TEXT = "Here is what I found for you";

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeClock {
  constructor(public ms: number) {}
  now = () => this.ms;
  advance(ms: number): void { this.ms += ms; }
}

/** Telegram as the family sees it: every message, in order. */
class RecordingTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string }[] = [];
  async sendMessage(p: { chatId: string; text: string }): Promise<SendResult> {
    this.sent.push({ chatId: p.chatId, text: p.text });
    return { ok: true, messageId: String(9000 + this.sent.length) };
  }
  async fetchFile(fileId: string) { return { bytes: Buffer.from(`%PDF-1.4 ${fileId}`), mime: "application/pdf" }; }
  async editMessageText(): Promise<SendResult> { return { ok: true }; }
  async sendChatAction(): Promise<void> {}
  async answerCallbackQuery(): Promise<void> {}
  async getChatInfo() { return null; }
  async getMe() { return BOT; }
  async getUpdates(): Promise<unknown[]> { return []; }
  async deleteWebhookIfPresent(): Promise<void> {}
}

/** The companion's gateway, dialling in the way Hermes does, answering only when told. */
class FakeGateway {
  readonly inbound: WireMessageEvent[] = [];
  private readonly results = new Map<string, unknown>();
  private next = 0;
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      for (const line of String(raw).split("\n")) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as { type: string; event?: WireMessageEvent; requestId?: string; result?: unknown };
        if (frame.type === "inbound" && frame.event) this.inbound.push(frame.event);
        if (frame.type === "outbound_result" && frame.requestId) this.results.set(frame.requestId, frame.result);
      }
    });
  }

  static async dial(port: number): Promise<FakeGateway> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, {
      headers: { authorization: `Bearer ${makeUpgradeToken(PROFILE, SECRET, 300)}` },
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    return new FakeGateway(ws);
  }

  async received(count: number): Promise<WireMessageEvent> {
    await waitFor(() => (this.inbound.length >= count ? true : undefined));
    return this.inbound[count - 1]!;
  }

  /** A companion `send`, replying to the message it answers, as the gateway does. */
  async reply(to: WireMessageEvent, content: string): Promise<void> {
    const requestId = `req_${(this.next += 1)}`;
    this.ws.send(JSON.stringify({
      type: "outbound",
      requestId,
      action: { op: "send", chat_id: to.source.chat_id, content, reply_to: to.message_id, metadata: { expects_reply: false } },
    }) + "\n");
    await waitFor(() => (this.results.has(requestId) ? true : undefined));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => { this.ws.once("close", () => resolve()); this.ws.close(); });
  }
}

async function waitFor<T>(get: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every read fails, after the ~94 s a real PDF read took. */
function failingRunner(clock: FakeClock): StructuredModelRunner {
  return {
    describe: () => ({ provider: "scripted", model: "always-fails" }),
    async run<T>(): Promise<RunnerResult<T>> {
      clock.advance(94_000);
      return { ok: false, reason: "FAILED", detail: "stub: unreadable", attempts: 1, ms: 94_000 };
    },
  } as unknown as StructuredModelRunner;
}

// ── The trip ─────────────────────────────────────────────────────────────────

interface World {
  pool: pg.Pool;
  tripId: string;
  telegram: RecordingTelegram;
  events: RelayAssistantEvents | undefined;
  logs: string[];
}

async function withTrip(fn: (pool: pg.Pool, tripId: string) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
    const userId = id("user");
    const tripId = id("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)", [userId, ORGANIZER_NAME]);
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state, assistant_names) VALUES ($1, $2, 'draft', $3)",
      [tripId, tripId.replace(/_/g, "-"), ["ליב", "Liv"]],
    );
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [id("memb"), tripId, userId],
    );
    // A CONFIRMED trip: the organizer's DM is its interview chat.
    const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(enrollment.ok);
    const started = await startFromDeepLink(pool, ORGANIZER_ID, enrollment.token);
    assert.equal(started.kind, "started");
    const phase = { name: "Kyoto", name_en: "Kyoto", start: "2026-09-19", end: "2026-09-23" };
    await pool.query(
      "UPDATE control_plane.intake_sessions SET answers = $1, state = 'awaiting_confirmation' WHERE telegram_chat_id = $2",
      [JSON.stringify({
        trip_type: { kind: "choice", option_id: "family", schema_version: 2, other_text: null },
        destination: { kind: "text", schema_version: 2, text: "Japan" },
        departure_date: { kind: "text", schema_version: 2, text: "2026-09-19" },
        return_date: { kind: "text", schema_version: 2, text: "2026-09-23" },
        travelers: { kind: "structured", schema_version: 2, data: [{ name: ORGANIZER_NAME }] },
        phases: { kind: "structured", schema_version: 2, data: [phase] },
        bot_name: { kind: "text", schema_version: 2, text: "Liv" },
        bot_gender: { kind: "choice", option_id: "neutral", schema_version: 2, other_text: null },
        bot_tone: { kind: "choice", option_id: "warm", schema_version: 2, other_text: null },
        organizer_identity: { kind: "text", schema_version: 2, text: ORGANIZER_NAME },
      }), ORGANIZER_ID],
    );
    const confirmed = await confirmIntakeForChat(pool, ORGANIZER_ID);
    assert.ok(confirmed.ok, `confirm failed: ${JSON.stringify(confirmed)}`);
    for (const chat of [ORGANIZER_ID, GROUP]) {
      await pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, $4)",
        [id("tcb"), chat, tripId, PROFILE],
      );
    }
    // The organizer is a linked person on the trip (migration 0051); the member is not.
    await pool.query(
      `INSERT INTO control_plane.trip_person_links(id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
       VALUES ($1, $2, $3, $4, $5, 'organizer', 'interview_chat')
       ON CONFLICT (trip_id, telegram_user_id) DO NOTHING`,
      [id("tpl"), tripId, ORGANIZER_ID, ORGANIZER_USERNAME, ORGANIZER_DISPLAY],
    );
    await fn(pool, tripId);
  } finally {
    await pool.end();
  }
}

// Monday 2026-09-16 10:03 in Japan is 01:03 UTC; the group's Wednesday morning
// starts 07:15 JST = 22:15 UTC the day BEFORE — so a UTC rollup would put the
// group's day on the wrong date, and the local-day grouping is actually tested.
const DM_MORNING = Date.parse("2026-09-16T01:03:00Z");
const GROUP_MORNING = Date.parse("2026-09-17T22:15:00Z");

let messageSeq = 500;
function groupMessage(from: string, fields: Partial<TelegramMessage>): TelegramUpdate {
  messageSeq += 1;
  return {
    update_id: messageSeq,
    message: {
      message_id: messageSeq,
      from: { id: Number(from), first_name: from === ORGANIZER_ID ? ORGANIZER_NAME : MEMBER_NAME },
      chat: { id: GROUP, type: "supergroup", title: "Anon family Japan" },
      ...fields,
    },
  };
}

/**
 * The week, in order. Returns what the family saw. `events` undefined is the
 * setting-unset relay; otherwise the emitter decides where events go.
 */
async function playWeek(pool: pg.Pool, tripId: string, events: RelayAssistantEvents | undefined, clock: FakeClock): Promise<World> {
  const telegram = new RecordingTelegram();
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const media = new MediaStore();
  const mediaDeps = { telegram, store: media, baseUrl: MEDIA_BASE, log };
  const connector = new RelayConnector({
    gatewaySecrets: [SECRET],
    telegram,
    port: 0,
    log,
    // As server.ts wires it.
    interviewChat: async (chatId: string) => (await resolveChatRoute(pool, chatId)).kind === "interview",
    ...(events ? { assistantEvents: events } : {}),
  });
  await connector.listen();
  const runner = failingRunner(clock);
  const pendingAttachments = new PendingAttachments();
  const groupContext = new GroupContext();
  const deps: TripBotPollerDeps = {
    db: pool,
    telegram,
    connector,
    botIdentity: BOT,
    media: mediaDeps,
    modelRunner: runner,
    pendingAttachments,
    groupContext,
    log,
    ...(events ? { assistantEvents: events } : {}),
  };
  /** One update, the way the poll loop handles it (startTripBotPoller's options). */
  const route = async (update: TelegramUpdate) => {
    const decision = await dispatchUpdate(pool, update, DEFAULT_STRINGS, log, BOT, {
      media: mediaDeps,
      pendingAttachments,
      groupContext,
      modelRunner: runner,
      ...(deps.assistantEvents ? { assistantEvents: true } : {}),
      canReachProfile: (profile: string) => connector.canReachProfile(profile),
    });
    await applyDecision(decision, deps);
    return decision;
  };

  let gateway = await FakeGateway.dial(connector.address!);
  await waitFor(() => (connector.canReachProfile(PROFILE) ? true : undefined));
  try {
    // ── Monday, the organizer's DM: four documents, every read failing ──────
    //
    // These enter at applyDecision, as document-correction-flow.test.ts does,
    // because at 4769a3f `dispatchUpdate` cannot produce a `document_correction`
    // decision: it asks organizerDocumentRoute before any media is attached,
    // so `hasMedia` is always false (reported on #177 as outside this brief).
    // The descriptor is built by the same `inboundFacts` dispatch uses.
    clock.ms = DM_MORNING;
    const session = await pool.query<{ id: string }>(
      "SELECT id FROM control_plane.intake_sessions WHERE telegram_chat_id = $1", [ORGANIZER_ID]);
    for (const [index, doc] of DM_DOCUMENTS.entries()) {
      const key = media.put({ kind: "document", mime: "text/plain", size: doc.body.length, filename: doc.name, bytes: Buffer.from(doc.body) });
      assert.ok(key);
      await applyDecision({
        kind: "document_correction",
        chatId: ORGANIZER_ID,
        tripId,
        sessionId: session.rows[0]!.id,
        language: "en",
        event: {
          text: "",
          message_id: String(100 + index),
          message_type: "document",
          source: { platform: "telegram", chat_id: ORGANIZER_ID, chat_type: "dm", chat_name: null, user_id: ORGANIZER_ID, user_name: ORGANIZER_NAME, thread_id: null, chat_topic: null, profile: PROFILE },
          media_urls: [`${MEDIA_BASE}/relay/media/${key}`],
          media: [{ kind: "document", mime: "text/plain", size: doc.body.length, filename: doc.name }],
        },
        ...(events
          ? {
              analytics: {
                ...inboundFacts({ tripId, telegramChatType: "private", trigger: "dm", linkRole: "organizer", attachmentKind: "document", textLength: 0 }),
                documents: 1,
              },
            }
          : {}),
      }, deps);
      await settleDocumentCorrections();
      clock.advance(3 * 60_000);
    }

    // ── Wednesday, the family group ─────────────────────────────────────────
    clock.ms = GROUP_MORNING;
    for (const [from, text] of CHATTER) {
      await route(groupMessage(from, { text }));
      clock.advance(40_000);
    }
    // The itinerary PDF, addressed to nobody: held for its sender.
    await route(groupMessage(ORGANIZER_ID, { document: GROUP_PDF }));
    clock.advance(272_000);
    // "Attach it", by name: the held PDF joins the request and goes over.
    await route(groupMessage(ORGANIZER_ID, { text: ATTACH_IT }));
    let seen = 1;
    const attach = await gateway.received(seen);
    assert.equal(attach.media_urls?.length, 1, "the held document went with the request");
    clock.advance(45_000);
    await gateway.reply(attach, REPLY_TEXT);

    // Three questions, three ways of addressing the assistant, three answers.
    let lastBotMessageId = String(9000 + telegram.sent.length);
    for (const question of QUESTIONS) {
      clock.advance(60_000);
      await route(groupMessage(question.from, {
        text: question.text,
        ...(question.replyToBot
          ? { reply_to_message: { message_id: Number(lastBotMessageId), from: { id: Number(BOT.id), is_bot: true } } }
          : {}),
      }));
      const asked = await gateway.received((seen += 1));
      clock.advance(question.latencyMs);
      await gateway.reply(asked, REPLY_TEXT);
      lastBotMessageId = String(9000 + telegram.sent.length);
    }
    // …the last answer ran to a second message.
    clock.advance(4_000);
    await gateway.reply(gateway.inbound[seen - 1]!, `${REPLY_TEXT}, continued`);

    // The companion goes down; an addressed message has nowhere to go.
    await gateway.close();
    await waitFor(() => (connector.canReachProfile(PROFILE) ? undefined : true));
    clock.advance(120_000);
    await route(groupMessage(ORGANIZER_ID, { text: WHILE_DOWN }));

    // Back up. One more request — which the companion never answers.
    gateway = await FakeGateway.dial(connector.address!);
    await waitFor(() => (connector.canReachProfile(PROFILE) ? true : undefined));
    clock.advance(600_000);
    await route(groupMessage(ORGANIZER_ID, { text: NEVER_ANSWERED }));
    await gateway.received(1);

    if (events) await events.stop();
    return { pool, tripId, telegram, events, logs };
  } finally {
    await gateway.close().catch(() => {});
    await connector.close();
  }
}

// ── The replay ───────────────────────────────────────────────────────────────

describe("the week, replayed through the relay", () => {
  test("the table alone reproduces the hand evaluation's counts", { skip: SKIP }, async () => {
    await withTrip(async (pool, tripId) => {
      const clock = new FakeClock(DM_MORNING);
      const emitterLogs: string[] = [];
      const events = new RelayAssistantEvents({
        sink: databaseEventSink(pool), flushIntervalMs: 0, now: clock.now, batchSize: 500, log: (l) => emitterLogs.push(l),
      });
      const world = await playWeek(pool, tripId, events, clock);
      assert.deepEqual(emitterLogs, [], "a clean week logs nothing from the emitter");
      assert.equal(events.stats.dropped, 0);
      assert.equal(events.stats.rejected, 0);
      assert.equal(events.stats.queued, 0);

      const rollup = await rollupAssistantEvents(pool, { tripId, timeZone: "Asia/Tokyo" });
      console.log(`# rollup ${JSON.stringify(rollup, null, 1).replace(/\n/g, "\n# ")}`);
      assert.deepEqual(rollup.map((d) => d.local_day), ["2026-09-16", "2026-09-18"],
        "grouped by the trip's local day, not UTC's (the group's morning is 2026-09-17 in UTC)");
      const [dm, group] = rollup as [typeof rollup[number], typeof rollup[number]];

      // Monday: the organizer's four uploads, every read failed — the relay ran
      // the read itself, so this is a substantive outcome, not a delivery fact.
      assert.equal(dm.requests_to_relay, 4);
      assert.deepEqual(dm.documents.relay_read, { failed_tool: 4 });
      assert.deepEqual(dm.by_channel_role, [
        { channel_type: "organizer_dm", requester_role: "organizer", not_addressed: 0, forwarded: 0, to_relay: 4, lost: 0 },
      ]);
      assert.deepEqual(dm.group, { addressed: 0, not_addressed: 0 });

      // Wednesday: the group.
      assert.deepEqual(group.group, { addressed: 6, not_addressed: 6 }, "5 chatter + 1 PDF unaddressed; 6 addressed");
      assert.equal(group.requests_forwarded, 5, "attach-it, three questions, the one never answered");
      assert.deepEqual(group.turns, { reply_delivered_substantive_outcome_unknown: 4, unanswered: 1, lost: 1 });
      assert.deepEqual(group.reply_latency_ms, [45_000, 12_000, 30_000, 8_000], "one per replied turn, first reply");
      assert.deepEqual(group.replies, { delivered: 5, failed: 0, suppressed: 0, unattributed_delivered: 0 },
        "five messages for four turns: the last answer ran to two");
      assert.deepEqual(group.by_channel_role, [
        { channel_type: "group", requester_role: "organizer", not_addressed: 3, forwarded: 3, to_relay: 0, lost: 1 },
        { channel_type: "group", requester_role: "unknown", not_addressed: 3, forwarded: 2, to_relay: 0, lost: 0 },
      ], "the member is not a linked person, so they are `unknown`, never guessed into `participant`");
      assert.deepEqual(group.documents, {
        held: 1,
        joined: 1,
        forwarded: 1,
        forwarded_reply_delivered_substantive_outcome_unknown: 1,
        forwarded_unanswered: 0,
        relay_read: {},
      }, "the group PDF: held, joined, forwarded, replied to — outcome unknown to the relay");

      // §6.3: nothing the relay wrote claims the task succeeded.
      const outcomes = await pool.query<{ outcome: string }>("SELECT DISTINCT outcome FROM control_plane.assistant_events ORDER BY 1");
      assert.ok(!outcomes.rows.some((r) => r.outcome.startsWith("answered")), JSON.stringify(outcomes.rows));
      const byTrigger = await pool.query<{ trigger_type: string; n: number }>(
        `SELECT trigger_type, count(*)::int AS n FROM control_plane.assistant_events
          WHERE event_type IN ('request_forwarded', 'turn_lost', 'ignored_not_addressed') GROUP BY 1 ORDER BY 1`);
      assert.deepEqual(byTrigger.rows, [
        { trigger_type: "mention", n: 1 },
        { trigger_type: "name", n: 4 },
        { trigger_type: "not_addressed", n: 6 },
        { trigger_type: "reply_to_bot", n: 1 },
      ]);
      assert.ok(world.telegram.sent.some((m) => m.text === DEFAULT_STRINGS.companionPending), "the lost turn was answered honestly");
    });
  });

  test("no row holds an identifier or a word anyone wrote", { skip: SKIP }, async () => {
    await withTrip(async (pool, tripId) => {
      const clock = new FakeClock(DM_MORNING);
      const emitterLogs: string[] = [];
      const events = new RelayAssistantEvents({
        sink: databaseEventSink(pool), flushIntervalMs: 0, now: clock.now, batchSize: 500, log: (l) => emitterLogs.push(l),
      });
      const world = await playWeek(pool, tripId, events, clock);

      const { rows } = await pool.query<{ row: string }>(
        "SELECT row_to_json(e)::text AS row FROM control_plane.assistant_events e ORDER BY occurred_at, event_id");
      // 4 reads to the relay + their 4 outcomes, 6 unaddressed, 5 forwarded,
      // 1 lost, 5 replies.
      assert.equal(rows.length, 25, "the replay wrote every one of its events");
      const serialized = rows.map((r) => r.row).join("\n");
      // Everything the emitter logged, and every relay line about assistant
      // events. A clean week produces none of either — the positive control
      // that this scan can find something is the "analytics log lines" test below.
      const analyticsLogs = [...emitterLogs, ...world.logs.filter((l) => /assistant_event/.test(l))].join("\n");
      console.log(`# privacy: analytics log lines scanned: ${emitterLogs.length + world.logs.filter((l) => /assistant_event/.test(l)).length}`);

      const forbidden: [string, string][] = [
        ["organizer's Telegram id / DM chat id", ORGANIZER_ID],
        ["member's Telegram id", MEMBER_ID],
        ["group chat id", GROUP],
        ["group chat id, unsigned", GROUP.slice(1)],
        ["organizer's unkeyed digest", digestTelegramId(ORGANIZER_ID)],
        ["organizer's digest, hex only", digestTelegramId(ORGANIZER_ID).replace("sha256:", "")],
        ["member's unkeyed digest", digestTelegramId(MEMBER_ID).replace("sha256:", "")],
        ["bot token", BOT_TOKEN],
        ["organizer's name", ORGANIZER_NAME],
        ["organizer's display name", ORGANIZER_DISPLAY],
        ["organizer's site username", ORGANIZER_USERNAME],
        ["member's name", MEMBER_NAME],
        ["the gateway profile", PROFILE],
        ["the group's title", "Anon family Japan"],
        ["a shared URL", ITINERARY_URL],
        ["the relay's media URL", MEDIA_BASE],
        ["the attach-it text", ATTACH_IT],
        ["a reply's text", REPLY_TEXT],
        ["the lost message", WHILE_DOWN],
        ["the unanswered message", NEVER_ANSWERED],
        ["the group PDF's filename", GROUP_PDF.file_name],
        ["the group PDF's file id", GROUP_PDF.file_id],
        ...CHATTER.map(([, text]) => [`chatter: ${text}`, text] as [string, string]),
        ...QUESTIONS.map((q) => [`question: ${q.text}`, q.text] as [string, string]),
        ...DM_DOCUMENTS.flatMap((d) => [[`filename ${d.name}`, d.name], [`document text ${d.body.trim()}`, d.body.trim()]] as [string, string][]),
      ];
      const leaks = forbidden.filter(([, value]) => serialized.includes(value) || analyticsLogs.includes(value));
      console.log(`# privacy: ${rows.length} rows serialised, ${forbidden.length} forbidden values checked, ${leaks.length} found`);
      console.log(`# sample row: ${rows.find((r) => r.row.includes("request_forwarded"))?.row}`);
      assert.deepEqual(leaks.map(([label]) => label), []);
    });
  });

  test("a sink that throws, or never answers, changes nothing the family sees", { skip: SKIP }, async () => {
    const sentBy: Record<string, { chatId: string; text: string }[]> = {};
    const dropped: Record<string, number> = {};
    const writes: Record<string, number> = {};
    const emitterLogs: string[] = [];
    const worlds: [string, AssistantEventSink | undefined][] = [
      ["off", undefined],
      ["throwing", { write() { throw new Error("analytics database is down"); } }],
      ["hanging", { write: () => new Promise(() => {}) }],
    ];
    for (const [name, sink] of worlds) {
      await withTrip(async (pool, tripId) => {
        const clock = new FakeClock(DM_MORNING);
        const events = sink
          ? new RelayAssistantEvents({
              sink, flushIntervalMs: 0, now: clock.now, writeTimeoutMs: 50, batchSize: 5, log: (l) => emitterLogs.push(l),
            })
          : undefined;
        // Flush on every beat of the script, so a hanging write is in flight
        // while the relay keeps answering.
        const pump = events ? setInterval(() => void events.flush(), 5) : null;
        try {
          // playWeek ends with the relay's own shutdown step, events.stop().
          const world = await playWeek(pool, tripId, events, clock);
          sentBy[name] = world.telegram.sent;
          if (events) {
            assert.equal(events.stats.queued, 0, `${name}: stop() left nothing queued`);
            dropped[name] = events.stats.dropped;
            writes[name] = events.stats.writesStarted;
          }
          const rows = await pool.query("SELECT count(*)::int AS n FROM control_plane.assistant_events");
          assert.equal(rows.rows[0].n, 0, `${name}: nothing stored`);
        } finally {
          if (pump) clearInterval(pump);
        }
      });
    }
    console.log(`# fail-open: messages sent off=${sentBy.off!.length} throwing=${sentBy.throwing!.length} hanging=${sentBy.hanging!.length}; dropped throwing=${dropped.throwing} hanging=${dropped.hanging}; writes started throwing=${writes.throwing} hanging=${writes.hanging}`);
    assert.ok(sentBy.off!.length > 10);
    assert.deepEqual(sentBy.throwing, sentBy.off, "same messages, same order, with the sink throwing");
    assert.deepEqual(sentBy.hanging, sentBy.off, "same messages, same order, with the sink hanging");
    assert.equal(dropped.throwing, 25, "every event of the week, counted");
    assert.equal(dropped.hanging, 25, "every event of the week, counted");
    assert.equal(writes.hanging, 1, "a hung sink is written to once, all week — never a pile of hung writes");
    assert.ok(emitterLogs.some((l) => l.includes("relay.assistant_events_dropped")), "and the loss is logged");
    assert.ok(!emitterLogs.join("\n").includes("analytics database is down"), "by code, not by message");
  });

  test("turning events on adds a descriptor to a decision and changes nothing else in it", { skip: SKIP }, async () => {
    await withTrip(async (pool) => {
      const updates: [string, TelegramUpdate][] = [
        ["chatter", groupMessage(MEMBER_ID, { text: "did everyone pack" })],
        ["unaddressed document", groupMessage(ORGANIZER_ID, { document: GROUP_PDF })],
        ["addressed by name", groupMessage(ORGANIZER_ID, { text: "Liv, what's for dinner" })],
        ["addressed by mention", groupMessage(MEMBER_ID, { text: "@KineraryTestBot hi" })],
        ["organizer DM", { update_id: 1, message: { message_id: 1, from: { id: Number(ORGANIZER_ID), first_name: ORGANIZER_NAME }, chat: { id: ORGANIZER_ID, type: "private" }, text: "what time is checkout" } }],
      ];
      for (const [label, update] of updates) {
        const decide = (on: boolean) => dispatchUpdate(pool, update, DEFAULT_STRINGS, () => {}, BOT, {
          pendingAttachments: new PendingAttachments(),
          groupContext: new GroupContext(),
          canReachProfile: () => true,
          ...(on ? { assistantEvents: true } : {}),
        });
        const off = await decide(false);
        const on = await decide(true);
        assert.equal("analytics" in off, false, `${label}: off carries no descriptor`);
        const { analytics, ...rest } = on as typeof on & { analytics?: unknown };
        assert.ok(analytics, `${label}: on carries one`);
        assert.deepEqual(rest, off, `${label}: and nothing else differs`);
      }
      // Unreachable companion: the router's own answer, same either way.
      const down = (on: boolean) => dispatchUpdate(pool, groupMessage(ORGANIZER_ID, { text: WHILE_DOWN }), DEFAULT_STRINGS, () => {}, BOT, {
        canReachProfile: () => false,
        ...(on ? { assistantEvents: true } : {}),
      });
      const off = await down(false);
      const { analytics, ...rest } = (await down(true)) as Awaited<ReturnType<typeof down>> & { analytics?: { triggerType: string } };
      assert.deepEqual(rest, off);
      assert.equal(analytics?.triggerType, "name");
    });
  });

  test("a descriptor read that fails costs the descriptor, logged by code — never the decision", { skip: SKIP }, async () => {
    await withTrip(async (pool) => {
      // The person-link read is made ONLY for the descriptor on these two
      // paths (unaddressed chatter; the companion-unreachable answer). Make
      // it fail, with an error that quotes identifiers the way a driver would.
      const leaky = `relation lookup failed for ${MEMBER_ID} in ${GROUP}: "${ORGANIZER_DISPLAY}"`;
      const failing = {
        query: (text: string, values?: unknown[]) =>
          /trip_person_links/.test(text) ? Promise.reject(new Error(leaky)) : pool.query(text, values),
        connect: () => pool.connect(),
      } as unknown as pg.Pool;
      const cases: [string, TelegramUpdate, boolean][] = [
        ["unaddressed chatter", groupMessage(MEMBER_ID, { text: "did everyone pack the rail passes" }), true],
        ["companion unreachable", groupMessage(ORGANIZER_ID, { text: WHILE_DOWN }), false],
      ];
      for (const [label, update, reachable] of cases) {
        const logs: string[] = [];
        const decide = (db: pg.Pool, on: boolean) => dispatchUpdate(db, update, DEFAULT_STRINGS, (l) => logs.push(l), BOT, {
          pendingAttachments: new PendingAttachments(),
          groupContext: new GroupContext(),
          canReachProfile: () => reachable,
          ...(on ? { assistantEvents: true } : {}),
        });
        const off = await decide(pool, false);
        const withFailure = await decide(failing, true);
        assert.deepEqual(withFailure, off, `${label}: the decision is exactly the events-off decision, with no descriptor`);
        const failed = logs.filter((l) => l.includes("trip_bot.assistant_event_facts_failed"));
        console.log(`# descriptor failure (${label}): ${failed.join(" ")}`);
        assert.equal(failed.length, 1, `${label}: logged`);
        assert.match(failed[0]!, /"safe_error_code":"Error"/);
        for (const value of [MEMBER_ID, GROUP, ORGANIZER_DISPLAY, leaky]) {
          assert.ok(!logs.join("\n").includes(value), `${label}: the log carries no ${value}`);
        }
      }
    });
  });

  test("analytics log lines carry codes, never the values they choked on", { skip: SKIP }, async () => {
    // The positive control for the privacy test's log scan: here the emitter
    // DOES log — a failing sink, a malformed descriptor — and the lines are
    // scanned for the same forbidden values.
    const logs: string[] = [];
    const leaky = new Error(`insert failed: chat ${GROUP} user ${ORGANIZER_ID} said "${ATTACH_IT}"`);
    const events = new RelayAssistantEvents({
      sink: { write() { throw leaky; } },
      flushIntervalMs: 0,
      log: (l) => logs.push(l),
    });
    events.notAddressed({ ...inboundFacts({ tripId: `trip_${"a".repeat(32)}`, telegramChatType: "supergroup", trigger: "not_addressed", linkRole: null, attachmentKind: null, textLength: 12 }) });
    events.notAddressed({ ...inboundFacts({ tripId: GROUP, telegramChatType: "supergroup", trigger: "not_addressed", linkRole: null, attachmentKind: null, textLength: 12 }) });
    await events.flush();
    await events.stop();
    console.log(`# analytics log lines: ${logs.join(" | ")}`);
    assert.ok(logs.some((l) => l.includes("relay.assistant_event_invalid")));
    assert.ok(logs.some((l) => l.includes("relay.assistant_events_dropped")));
    for (const value of [GROUP, GROUP.slice(1), ORGANIZER_ID, ATTACH_IT, "insert failed"]) {
      assert.ok(!logs.join("\n").includes(value), `no ${value} in the analytics log`);
    }
  });

  test("with the setting unset, the week writes nothing", { skip: SKIP }, async () => {
    await withTrip(async (pool, tripId) => {
      const lines: string[] = [];
      const events = assistantEventsFromEnv({}, pool, (l) => lines.push(l));
      assert.equal(events, undefined);
      const world = await playWeek(pool, tripId, events, new FakeClock(DM_MORNING));
      const rows = await pool.query("SELECT count(*)::int AS n FROM control_plane.assistant_events");
      console.log(`# default-off: ${lines.join(" ")} rows=${rows.rows[0].n} messages_sent=${world.telegram.sent.length}`);
      assert.equal(rows.rows[0].n, 0);
      assert.ok(world.telegram.sent.length > 10, "the relay itself ran the whole week");
    });
  });
});
