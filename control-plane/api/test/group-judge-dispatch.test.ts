/**
 * The group judge through `dispatchUpdate` (DB-backed): where it sits in the
 * order of the gate, what a yes / no / failure does to a message, the
 * per-group `/listen` switch and who may flip it, and every path that must NOT
 * ask a model. Units of the judge itself are in group-judge.test.ts.
 *
 * Owner's decision, 2026-10-16: a group message no rule addressed goes to a
 * bounded model call; yes forwards it (marked, sender joins the window); no,
 * error, timeout, garbage or low confidence is NOT_ADDRESSED exactly as before.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { dispatchUpdate } from "../src/relay/dispatch.js";
import { inCompanionConversation, setCompanionExpectsReply } from "../src/chat-router.js";
import { conversationMark } from "../src/relay/stay-silent.js";
import { GroupContext } from "../src/relay/group-context.js";
import { PendingAttachments } from "../src/relay/pending-attachments.js";
import { createGroupJudge, JudgeRateLimiter, JUDGE_TASK, type GroupJudge, type JudgeOutcome } from "../src/relay/group-judge.js";
import type { StructuredModelRunner } from "../src/model-runner.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import type { InboundFacts } from "../src/analytics/relay-facts.js";
import { digestTelegramId } from "../src/identity.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const DROR = 777;
const NOA = 555;
const NAMES = ["Liv"];
const YES: JudgeOutcome = { kind: "yes", confidence: 0.9, ms: 300, model: "fake/judge" };
const NO: JudgeOutcome = { kind: "no", confidence: 0.9, ms: 250, model: "fake/judge", belowThreshold: false };

interface Fixture { pool: pg.Pool; tripId: string; userId: string }

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

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
    await fn({ pool, tripId, userId });
  } finally {
    await pool.end();
  }
}

async function bindNamed(fix: Fixture, chatId: string): Promise<void> {
  await fix.pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-colmar')",
    [chatId, fix.tripId],
  );
  await fix.pool.query("UPDATE control_plane.trips SET assistant_names = $2 WHERE id = $1", [fix.tripId, NAMES]);
}

function from(chatId: string, text: string, fromId = DROR, extra: Record<string, unknown> = {}, messageExtra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: 3,
    message: {
      message_id: 9,
      from: { id: fromId, first_name: fromId === DROR ? "Dror" : "Noa", ...extra },
      chat: { id: chatId, type: "supergroup" },
      text,
      ...messageExtra,
    },
  } as TelegramUpdate;
}

function privateMsg(chatId: string, text: string): TelegramUpdate {
  return { update_id: 1, message: { message_id: 7, from: { id: DROR, first_name: "Dror" }, chat: { id: chatId, type: "private" }, text } } as TelegramUpdate;
}

/** A judge that answers from a script and records what it was asked (the text is only ever in the call, never a log). */
function scripted(...outcomes: JudgeOutcome[]): GroupJudge & { calls: { chatId: string; text: string; assistantNames: readonly string[]; language: string }[] } {
  const calls: { chatId: string; text: string; assistantNames: readonly string[]; language: string }[] = [];
  let i = 0;
  return {
    calls,
    model: () => "fake/judge",
    async judge(input) {
      calls.push({ chatId: input.chatId, text: input.text, assistantNames: input.assistantNames, language: input.language });
      return outcomes[Math.min(i++, outcomes.length - 1)]!;
    },
  };
}

async function dispatch(fix: Fixture, update: TelegramUpdate, options: Record<string, unknown> = {}, lines: string[] = [], bot: { id?: string; username?: string } = {}) {
  return dispatchUpdate(fix.pool, update, undefined, (l) => lines.push(l), bot, options);
}

const facts = (d: unknown) => (d as { analytics?: InboundFacts }).analytics;
const eventText = (d: unknown) => (d as { event?: { text?: string } }).event?.text ?? "";

describe("the group judge in the gate", { skip: SKIP }, () => {
  test("without a judge an unaddressed message is NOT_ADDRESSED, as before", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000001";
      await bindNamed(fix, chat);
      assert.deepEqual(await dispatch(fix, from(chat, "what time is check-in?")), { kind: "ignore", reason: "NOT_ADDRESSED" });
    });
  });

  test("EXISTING RULES FIRST: name, @mention, reply-to-bot, the '?' window and the conversation window never reach the judge", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000002";
      await bindNamed(fix, chat);
      const judge = scripted(NO);
      const options = { groupJudge: judge };
      const bot = { id: "4242", username: "KinneryBot" };

      assert.equal((await dispatch(fix, from(chat, "Liv, what time is check-in?", NOA), options, [], bot)).kind, "to_gateway", "by name");
      assert.equal((await dispatch(fix, from(chat, "@KinneryBot what time is check-in?", NOA, {}), options, [], bot)).kind, "to_gateway", "by @mention");
      const reply = from(chat, "ok thanks", NOA, {}, { reply_to_message: { message_id: 1, from: { id: 4242, is_bot: true } } });
      assert.equal((await dispatch(fix, reply, options, [], bot)).kind, "to_gateway", "by replying to the bot");

      // Dror joined the window by being addressed by name; his untagged follow-up rides it.
      await dispatch(fix, from(chat, "Liv, hello", DROR), options, [], bot);
      assert.equal((await dispatch(fix, from(chat, "and what about Saturday", DROR), options, [], bot)).kind, "to_gateway", "by the conversation window");

      // The one-shot '?' window admits a stranger to the conversation.
      await fix.pool.query("UPDATE control_plane.telegram_chat_bindings SET conversation_until = NULL, conversation_user_ids = NULL WHERE chat_id = $1", [chat]);
      await setCompanionExpectsReply(fix.pool, chat, true);
      assert.equal((await dispatch(fix, from(chat, "Friday works", NOA), options, [], bot)).kind, "to_gateway", "by the '?' window");

      assert.equal(judge.calls.length, 0, "not one model call for any message an earlier rule addressed");
    });
  });

  test("YES: forwarded with the conversation mark, trigger 'judge', and the sender joins the window", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000003";
      await bindNamed(fix, chat);
      const judge = scripted(YES);
      const lines: string[] = [];
      const decision = await dispatch(fix, from(chat, "what time is check-in at the hotel?"), { groupJudge: judge, assistantEvents: true }, lines);
      assert.equal(decision.kind, "to_gateway");
      assert.ok(eventText(decision).startsWith(conversationMark()), "marked, so the companion can still stay silent");
      assert.ok(eventText(decision).endsWith("what time is check-in at the hotel?"));
      assert.deepEqual(judge.calls.map((c) => [c.chatId, c.text, [...c.assistantNames], c.language]), [[chat, "what time is check-in at the hotel?", NAMES, "en"]]);

      assert.equal(facts(decision)?.triggerType, "judge");
      assert.deepEqual(
        { outcome: facts(decision)?.judge?.outcome, latencyMs: facts(decision)?.judge?.latencyMs, model: facts(decision)?.judge?.model, confidencePct: facts(decision)?.judge?.confidencePct },
        { outcome: "judge_yes", latencyMs: 300, model: "fake/judge", confidencePct: 90 },
      );

      assert.equal(await inCompanionConversation(fix.pool, chat, String(DROR)), true, "the sender joined the conversation window like any forward");
      const follow = await dispatch(fix, from(chat, "and the check-out?"), { groupJudge: judge }, lines);
      assert.equal(follow.kind, "to_gateway", "their next message rides the window");
      assert.equal(judge.calls.length, 1, "without another judge call");
      assert.ok(lines.some((l) => l.includes("trip_bot.group_judged")));
    });
  });

  test("NO: NOT_ADDRESSED with the overheard context kept, and the descriptor says judge_no", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000004";
      await bindNamed(fix, chat);
      const ctx = new GroupContext();
      const decision = await dispatch(fix, from(chat, "we should leave at nine"), { groupJudge: scripted(NO), groupContext: ctx, assistantEvents: true });
      assert.equal(decision.kind, "ignore");
      assert.equal((decision as { reason?: string }).reason, "NOT_ADDRESSED");
      assert.equal(ctx.take(chat).length, 1, "overheard context is held exactly as before");
      assert.equal(facts(decision)?.triggerType, "not_addressed");
      assert.equal(facts(decision)?.judge?.outcome, "judge_no");
      assert.equal(await inCompanionConversation(fix.pool, chat, String(DROR)), false, "no window for a no");
    });
  });

  test("every other outcome fails closed: below-threshold, garbage, runner failure, throw and hang all end NOT_ADDRESSED", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000005";
      await bindNamed(fix, chat);
      const runner = (reply: () => Promise<unknown>): StructuredModelRunner => ({
        describe: (task) => (task === JUDGE_TASK ? { provider: "fake", model: "fake/judge" } : null),
        run: (async (req: { parse: (raw: unknown) => unknown }) => {
          const raw = await reply();
          const parsed = req.parse(raw);
          return parsed === null
            ? { ok: false, reason: "BAD_OUTPUT", attempts: 1, ms: 1 }
            : { ok: true, value: parsed, attempts: 1, ms: 1 };
        }) as unknown as StructuredModelRunner["run"],
      });
      const cases: [string, StructuredModelRunner, string][] = [
        ["low confidence", runner(async () => ({ for_assistant: true, confidence: 0.4 })), "judge_no"],
        ["wrong shape", runner(async () => ({ for_assistant: "yes", confidence: 5 })), "judge_fallback"],
        ["not JSON at all", runner(async () => null), "judge_fallback"],
        ["a throw", runner(async () => { throw new Error("socket hang up"); }), "judge_fallback"],
        ["a hang", runner(() => new Promise(() => {})), "judge_fallback"],
      ];
      for (const [label, r, expected] of cases) {
        const ctx = new GroupContext();
        const judge = createGroupJudge({ runner: r, timeoutMs: 40, rateLimiter: new JudgeRateLimiter(100) });
        const decision = await dispatch(fix, from(chat, "should we try the ferry?"), { groupJudge: judge, groupContext: ctx, assistantEvents: true });
        assert.deepEqual({ kind: decision.kind, reason: (decision as { reason?: string }).reason }, { kind: "ignore", reason: "NOT_ADDRESSED" }, label);
        assert.equal(facts(decision)?.judge?.outcome, expected, label);
        assert.equal(ctx.take(chat).length, 1, `${label}: overheard kept`);
      }
    });
  });

  test("past the per-chat rate limit the message is NOT_ADDRESSED and the runner is not called", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000006";
      await bindNamed(fix, chat);
      let calls = 0;
      const runner: StructuredModelRunner = {
        describe: () => ({ provider: "fake", model: "fake/judge" }),
        run: (async (req: { parse: (raw: unknown) => unknown }) => {
          calls += 1;
          return { ok: true, value: req.parse({ for_assistant: false, confidence: 0.9 }), attempts: 1, ms: 1 };
        }) as unknown as StructuredModelRunner["run"],
      };
      const judge = createGroupJudge({ runner, rateLimiter: new JudgeRateLimiter(10) });
      let last: unknown;
      for (let i = 0; i < 11; i += 1) last = await dispatch(fix, from(chat, `message number ${i}`), { groupJudge: judge, assistantEvents: true });
      assert.equal(calls, 10, "ten calls a minute for a chat");
      assert.deepEqual({ kind: (last as { kind: string }).kind, reason: (last as { reason?: string }).reason }, { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.equal(facts(last)?.judge?.fallbackReason, "rate_limited");
    });
  });

  test("never asked: a DM, a captionless photo, a lone emoji, a judge with no binding, an unreachable companion", async () => {
    await withFixture(async (fix) => {
      const group = "-1004000007";
      await bindNamed(fix, group);
      const dm = "9000001";
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-colmar')",
        [dm, fix.tripId],
      );
      const judge = scripted(YES);

      assert.equal((await dispatch(fix, privateMsg(dm, "what time is check-in?"), { groupJudge: judge })).kind, "to_gateway", "a DM is addressed by construction");

      const photo = from(group, "", DROR, {}, { text: undefined, photo: [{ file_id: "p1", file_size: 10 }] });
      const held = await dispatch(fix, photo, { groupJudge: judge });
      assert.deepEqual(held, { kind: "ignore", reason: "NOT_ADDRESSED" }, "an uncaptioned photo keeps today's behaviour");

      assert.deepEqual(await dispatch(fix, from(group, "👍"), { groupJudge: judge }), { kind: "ignore", reason: "NOT_ADDRESSED" }, "nothing to read");
      assert.deepEqual(await dispatch(fix, from(group, "?!"), { groupJudge: judge }), { kind: "ignore", reason: "NOT_ADDRESSED" });

      const dormant: GroupJudge = { model: () => null, judge: async () => { throw new Error("must not be asked"); } };
      assert.deepEqual(await dispatch(fix, from(group, "what time is check-in?"), { groupJudge: dormant }), { kind: "ignore", reason: "NOT_ADDRESSED" });

      const down = await dispatch(fix, from(group, "what time is check-in?"), { groupJudge: judge, canReachProfile: () => false });
      assert.notEqual(down.kind, "to_gateway");
      assert.equal(judge.calls.length, 0, "no call for any of them");
    });
  });

  test("a captioned document is judged on its caption: no keeps the hold-until-addressed behaviour, yes forwards it", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000008";
      await bindNamed(fix, chat);
      const doc = (caption: string): TelegramUpdate => from(chat, "", DROR, {}, {
        text: undefined,
        caption,
        document: { file_id: "BQAC-x", file_name: "booking.pdf", mime_type: "application/pdf" },
      });
      const pending = new PendingAttachments();
      const lines: string[] = [];
      const no = scripted(NO);
      const held = await dispatch(fix, doc("this is the Lyon booking"), { groupJudge: no, pendingAttachments: pending }, lines);
      assert.deepEqual(held, { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.ok(lines.some((l) => l.includes("trip_bot.attachment_held")), "held for the sender's next addressed message");
      assert.equal(no.calls[0]?.text, "this is the Lyon booking", "the caption is what was judged");

      const yes = scripted(YES);
      const sent = await dispatch(fix, doc("please add this booking to the plan"), { groupJudge: yes, pendingAttachments: new PendingAttachments() });
      assert.equal(sent.kind, "to_gateway");
    });
  });

  test("a failing /listen read (relay ahead of its migration) is NOT_ADDRESSED and loud, never a judge call", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000009";
      await bindNamed(fix, chat);
      await fix.pool.query("ALTER TABLE control_plane.telegram_chat_bindings RENAME COLUMN listen_judge_enabled TO listen_judge_enabled_gone");
      const judge = scripted(YES);
      const lines: string[] = [];
      const decision = await dispatch(fix, from(chat, "what time is check-in?"), { groupJudge: judge }, lines);
      assert.deepEqual(decision, { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.equal(judge.calls.length, 0);
      assert.ok(lines.some((l) => l.includes("trip_bot.group_judge_listen_read_failed")));
    });
  });

  test("the trip's reply-capture opt-out switches the judge off too", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000010";
      await bindNamed(fix, chat);
      await fix.pool.query("UPDATE control_plane.trips SET companion_reply_capture_enabled = false WHERE id = $1", [fix.tripId]);
      const judge = scripted(YES);
      assert.deepEqual(await dispatch(fix, from(chat, "what time is check-in?"), { groupJudge: judge }), { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.equal(judge.calls.length, 0);
    });
  });

  test("the judge is told the trip's language and nothing else about the people", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000011";
      await bindNamed(fix, chat);
      await fix.pool.query("UPDATE control_plane.trips SET companion_intro = '{\"language\":\"he\",\"login_password\":\"hunter2\"}'::jsonb WHERE id = $1", [fix.tripId]);
      const judge = scripted(NO);
      await dispatch(fix, from(chat, "מה שעת הצ'ק אין?"), { groupJudge: judge });
      assert.deepEqual(judge.calls.map((c) => c.language), ["he"]);
      assert.deepEqual(Object.keys(judge.calls[0]!).sort(), ["assistantNames", "chatId", "language", "text"], "no sender name, id or history is handed to the judge");
    });
  });

  test("the message text is never written to a log line", async () => {
    await withFixture(async (fix) => {
      const chat = "-1004000012";
      await bindNamed(fix, chat);
      const secret = "the safe code is 4417 and Grandma's birthday is private";
      const lines: string[] = [];
      await dispatch(fix, from(chat, secret), { groupJudge: scripted(YES) }, lines);
      await dispatch(fix, from(chat, `${secret} again`), { groupJudge: scripted(NO) }, lines);
      assert.ok(lines.length > 0);
      for (const line of lines) assert.ok(!line.includes("4417") && !line.includes("Grandma"), line);
    });
  });
});

describe("/listen - the organizer's switch for one group", { skip: SKIP }, () => {
  const column = async (fix: Fixture, chat: string) =>
    (await fix.pool.query("SELECT listen_judge_enabled AS on FROM control_plane.telegram_chat_bindings WHERE chat_id = $1", [chat])).rows[0].on as boolean;
  const reply = (d: unknown) => (d as { reply?: { text: string } }).reply?.text ?? "";
  const linkOrganizer = (fix: Fixture, telegramId: number) => fix.pool.query(
    `INSERT INTO control_plane.trip_person_links
       (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
     VALUES ('tpl_' || md5(random()::text), $1, $2, 'ron', 'Ron', 'organizer', 'interview_chat')`,
    [fix.tripId, String(telegramId)],
  );

  test("default ON for every group binding", async () => {
    await withFixture(async (fix) => {
      const chat = "-1005000001";
      await bindNamed(fix, chat);
      assert.equal(await column(fix, chat), true);
    });
  });

  test("a non-organizer is refused politely and nothing changes", async () => {
    await withFixture(async (fix) => {
      const chat = "-1005000002";
      await bindNamed(fix, chat);
      const lines: string[] = [];
      const decision = await dispatch(fix, from(chat, "/listen off", NOA), {}, lines);
      assert.equal(decision.kind, "reply");
      assert.match(reply(decision), /Only the trip organizer can change this/);
      assert.equal(await column(fix, chat), true);
      assert.ok(lines.some((l) => l.includes("trip_bot.listen_refused")));
    });
  });

  test("the organizer (by trip person link) turns it off and on; the judge follows, and it persists per binding", async () => {
    await withFixture(async (fix) => {
      const chat = "-1005000003";
      await bindNamed(fix, chat);
      await linkOrganizer(fix, DROR);
      const judge = scripted(YES);

      const off = await dispatch(fix, from(chat, "/listen off", DROR));
      assert.match(reply(off), /Listening is off in this group/);
      assert.equal(await column(fix, chat), false);
      assert.deepEqual(await dispatch(fix, from(chat, "what time is check-in?", NOA), { groupJudge: judge }), { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.equal(judge.calls.length, 0, "/listen off: no judge");

      const status = await dispatch(fix, from(chat, "/listen", NOA));
      assert.match(reply(status), /Listening is off/, "anyone can read the setting");

      const on = await dispatch(fix, from(chat, "/listen@KinneryBot on", DROR));
      assert.match(reply(on), /Listening is on in this group/);
      assert.equal(await column(fix, chat), true);
      assert.equal((await dispatch(fix, from(chat, "what time is check-in?", NOA), { groupJudge: judge })).kind, "to_gateway");
      assert.equal(judge.calls.length, 1);
    });
  });

  test("the organizer proven by their verified Telegram identity and an owner membership is accepted too", async () => {
    await withFixture(async (fix) => {
      const chat = "-1005000004";
      await bindNamed(fix, chat);
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_organizer_links(id, user_id, telegram_subject_digest, verified_via) VALUES ($1, $2, $3, 'enrollment_redemption')",
        [testId("tol"), fix.userId, digestTelegramId(String(DROR))],
      );
      assert.match(reply(await dispatch(fix, from(chat, "/listen off", DROR))), /Listening is off/);
      assert.equal(await column(fix, chat), false);
    });
  });

  test("an unknown argument gets the usage; /listen in a private chat or an unbound chat says so", async () => {
    await withFixture(async (fix) => {
      const chat = "-1005000005";
      await bindNamed(fix, chat);
      assert.match(reply(await dispatch(fix, from(chat, "/listen maybe", DROR))), /\/listen on .*\n\/listen off/);
      assert.equal(await column(fix, chat), true);

      const dm = "9000002";
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-colmar')",
        [dm, fix.tripId],
      );
      assert.match(reply(await dispatch(fix, privateMsg(dm, "/listen off"))), /belongs to the family group/);
      assert.equal(await column(fix, dm), true, "a DM binding is untouched");

      const unbound = await dispatch(fix, from("-1005999999", "/listen off", DROR));
      assert.equal(unbound.kind, "reply");
      assert.doesNotMatch(reply(unbound), /Listening/);
    });
  });

  test("replies in the trip's language (Hebrew)", async () => {
    await withFixture(async (fix) => {
      const chat = "-1005000006";
      await bindNamed(fix, chat);
      await linkOrganizer(fix, DROR);
      await fix.pool.query("UPDATE control_plane.trips SET companion_intro = '{\"language\":\"he\"}'::jsonb WHERE id = $1", [fix.tripId]);
      assert.match(reply(await dispatch(fix, from(chat, "/listen off", DROR))), /[֐-׿]/);
      assert.match(reply(await dispatch(fix, from(chat, "/listen", NOA))), /כבויה/);
      assert.match(reply(await dispatch(fix, from(chat, "/listen off", NOA))), /רק מי שארגן את הטיול/);
    });
  });

  test("is listed in the group /help, and not in a private one", async () => {
    await withFixture(async (fix) => {
      const chat = "-1005000007";
      await bindNamed(fix, chat);
      assert.match(reply(await dispatch(fix, from(chat, "/help", DROR))), /\/listen/);
      const dm = "9000003";
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-colmar')",
        [dm, fix.tripId],
      );
      assert.doesNotMatch(reply(await dispatch(fix, privateMsg(dm, "/help"))), /\/listen/);
    });
  });

  test("a chat moved to a new id (group becomes supergroup) keeps its setting", async () => {
    await withFixture(async (fix) => {
      const chat = "-1005000008";
      await bindNamed(fix, chat);
      await linkOrganizer(fix, DROR);
      await dispatch(fix, from(chat, "/listen off", DROR));
      const { migrateChatBinding } = await import("../src/chat-router.js");
      assert.equal(await migrateChatBinding(fix.pool, chat, "-1005999008"), true);
      assert.equal(await column(fix, "-1005999008"), false);
    });
  });
});
