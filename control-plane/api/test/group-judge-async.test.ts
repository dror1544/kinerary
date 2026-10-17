/**
 * The group judge OFF the poll loop (DB-backed, through the real poller).
 *
 * A CLI judge takes 5-8 s; the poll loop is the bot's one consumer of Telegram
 * updates, so awaiting the judge there would stall every chat - interviews and DMs
 * included. A message that needs the judge is parked on its chat's chain; the loop
 * moves on. These tests hold a judgement open on demand and watch what else happens.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { startTripBotPoller } from "../src/relay/poller.js";
import { inCompanionConversation } from "../src/chat-router.js";
import { createGroupJudge, JudgeRateLimiter, JUDGE_TASK, type GroupJudge, type JudgeOutcome } from "../src/relay/group-judge.js";
import { conversationMark } from "../src/relay/stay-silent.js";
import { GroupContext } from "../src/relay/group-context.js";
import type { StructuredModelRunner } from "../src/model-runner.js";
import type { WireMessageEvent } from "../src/relay/protocol.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import type { BotSelf, ChatInfo, SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import { RelayAssistantEvents } from "../src/analytics/emitter.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const X = "-1009000001";
const Y = "-1009000002";
const Z = "-1009000003";
const DM = "9100001";
const YES: JudgeOutcome = { kind: "yes", confidence: 0.9, ms: 5000, model: "fake/judge" };
const NO: JudgeOutcome = { kind: "no", confidence: 0.9, ms: 5000, model: "fake/judge", belowThreshold: false };

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

class FakeTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string }[] = [];
  readonly offsets: number[] = [];
  queued: unknown[][] = [];
  async sendMessage(params: { chatId: string; text: string }): Promise<SendResult> {
    this.sent.push({ chatId: params.chatId, text: params.text });
    return { ok: true, messageId: String(this.sent.length) };
  }
  async editMessageText(): Promise<SendResult> { return { ok: true }; }
  async sendChatAction(): Promise<void> {}
  async answerCallbackQuery(): Promise<void> {}
  async getChatInfo(): Promise<ChatInfo | null> { return null; }
  async getMe(): Promise<BotSelf | null> { return { id: "7000000001", username: "KineraryTestBot" }; }
  async getUpdates(params?: { offset?: number }): Promise<unknown[]> {
    this.offsets.push(params?.offset ?? -1);
    return this.queued.shift() ?? [];
  }
  async deleteWebhookIfPresent(): Promise<void> {}
}

class FakeConnector {
  readonly pushed: WireMessageEvent[] = [];
  pushInbound(event: WireMessageEvent): boolean {
    this.pushed.push(event);
    return true;
  }
}

/** A judge whose every call waits for the test to settle it. */
function controlled() {
  const calls: { chatId: string; text: string; settle: (outcome: JudgeOutcome) => void }[] = [];
  const judge: GroupJudge = {
    model: () => "fake/judge",
    judge: (input) => new Promise<JudgeOutcome>((resolve) => {
      calls.push({ chatId: input.chatId, text: input.text, settle: resolve });
    }),
  };
  return { judge, calls };
}

const group = (chat: string, text: string, from = 101, updateId = 1): TelegramUpdate => ({
  update_id: updateId,
  message: { message_id: updateId, from: { id: from, first_name: "Ann" }, chat: { id: chat, type: "supergroup" }, text },
} as TelegramUpdate);

interface Fix {
  pool: pg.Pool;
  telegram: FakeTelegram;
  connector: FakeConnector;
  groupContext: GroupContext;
  start: (judge: GroupJudge, extra?: Record<string, unknown>) => () => void;
}

async function withFix(fn: (f: Fix) => Promise<void>): Promise<void> {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  const stops: (() => void)[] = [];
  try {
    const userId = id("user");
    const tripId = id("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'O')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state, assistant_names) VALUES ($1, $2, 'draft', ARRAY['Liv'])", [tripId, tripId.replace(/_/g, "-")]);
    await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')", [id("memb"), tripId, userId]);
    for (const chat of [X, Y, Z, DM]) {
      await pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-colmar')",
        [chat, tripId],
      );
    }
    const telegram = new FakeTelegram();
    const connector = new FakeConnector();
    const groupContext = new GroupContext();
    const start = (judge: GroupJudge, extra: Record<string, unknown> = {}) => {
      const stop = startTripBotPoller(
        { db: pool, telegram, connector: connector as never, groupJudge: judge, groupContext, ...extra } as never,
        { longPollSeconds: 0, maxBackoffMs: 10 },
      );
      stops.push(stop);
      return stop;
    };
    await fn({ pool, telegram, connector, groupContext, start });
  } finally {
    for (const stop of stops) stop();
    await pool.end();
  }
}

const textsOf = (f: Fix) => f.connector.pushed.map((e) => e.text);

describe("the judge does not stall the poll loop", { skip: SKIP }, () => {
  test("another chat, and a DM, are handled while a judgement is pending; the pending message follows when its verdict is in", async () => {
    await withFix(async (f) => {
      const { judge, calls } = controlled();
      f.telegram.queued = [[
        group(X, "what time is check-in at the hotel?", 101, 1), // needs the judge
        group(Y, "Liv, what is the plan for today?", 102, 2), // addressed by name: no judge
        { update_id: 3, message: { message_id: 3, from: { id: 9100001, first_name: "Dror" }, chat: { id: DM, type: "private" }, text: "hello there" } } as TelegramUpdate,
      ]];
      f.start(judge);
      await until(() => calls.length === 1, "X reached the judge");
      await until(() => f.connector.pushed.length === 2, "Y and the DM were pushed while X's judgement is pending");
      assert.deepEqual(f.connector.pushed.map((e) => e.source.chat_id).sort(), [DM, Y].sort());
      assert.equal(f.connector.pushed.some((e) => e.source.chat_id === X), false, "X is still waiting");

      calls[0]!.settle(YES);
      await until(() => f.connector.pushed.length === 3, "X forwarded once the verdict arrived");
      const forwarded = f.connector.pushed.find((e) => e.source.chat_id === X)!;
      assert.ok(forwarded.text.startsWith(conversationMark()), "marked, as in the synchronous path");
      assert.ok(forwarded.text.endsWith("what time is check-in at the hotel?"));
      assert.equal(await inCompanionConversation(f.pool, X, "101"), true, "and the sender joined the conversation window");
    });
  });

  test("a NO is ignored after the wait, with the message kept as overheard context for the next addressed one", async () => {
    await withFix(async (f) => {
      const { judge, calls } = controlled();
      f.telegram.queued = [[group(X, "we should leave at nine", 101, 1)]];
      f.start(judge);
      await until(() => calls.length === 1, "judge asked");
      calls[0]!.settle(NO);
      let held = 0;
      await until(() => { held += f.groupContext.take(X).length; return held === 1; }, "the message was held as overheard context");
      assert.equal(f.connector.pushed.length, 0);
      assert.equal(await inCompanionConversation(f.pool, X, "101"), false, "no window for a no");
    });
  });

  test("a judge that throws is NOT_ADDRESSED, and the lane is free again afterwards", async () => {
    await withFix(async (f) => {
      let n = 0;
      const judge: GroupJudge = {
        model: () => "fake/judge",
        judge: async () => { n += 1; if (n === 1) throw new Error("boom"); return YES; },
      };
      f.telegram.queued = [[group(X, "should we try the ferry?", 101, 1)], [group(X, "what about dinner?", 101, 2)]];
      f.start(judge);
      await until(() => f.connector.pushed.length === 1, "the second message is judged yes after the first one failed");
      assert.ok(f.connector.pushed[0]!.text.endsWith("what about dinner?"));
    });
  });
});

describe("a chat's messages keep their order", { skip: SKIP }, () => {
  test("a follow-up addressed by name waits behind the pending judgement of the message before it", async () => {
    await withFix(async (f) => {
      const { judge, calls } = controlled();
      f.telegram.queued = [[
        group(X, "what time is check-in at the hotel?", 101, 1),
        group(X, "Liv, and what about check-out?", 101, 2),
      ]];
      f.start(judge);
      await until(() => calls.length === 1, "first message judged");
      await sleep(150);
      assert.equal(f.connector.pushed.length, 0, "the follow-up did NOT overtake its predecessor");
      calls[0]!.settle(YES);
      await until(() => f.connector.pushed.length === 2, "both forwarded");
      assert.deepEqual(textsOf(f).map((t) => t.split("\n").pop()), ["what time is check-in at the hotel?", "Liv, and what about check-out?"]);
    });
  });

  test("two judged messages in one chat are judged one after the other, never together", async () => {
    await withFix(async (f) => {
      const { judge, calls } = controlled();
      f.telegram.queued = [[group(X, "first question about the plan?", 101, 1), group(X, "second question about the hotel?", 102, 2)]];
      f.start(judge);
      await until(() => calls.length === 1, "first judged");
      await sleep(150);
      assert.equal(calls.length, 1, "the second waits for the first");
      calls[0]!.settle(NO);
      await until(() => calls.length === 2, "second judged after the first");
      calls[1]!.settle(YES);
      await until(() => f.connector.pushed.length === 1, "second forwarded");
    });
  });

  test("a /proactive from the organizer queued behind a pending judgement takes effect after it, in order", async () => {
    await withFix(async (f) => {
      await f.pool.query(
        `INSERT INTO control_plane.trip_person_links(id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
         SELECT 'tpl_' || md5(random()::text), trip_id, '7771001', 'dror', 'Dror', 'organizer', 'interview_chat' FROM control_plane.telegram_chat_bindings WHERE chat_id = $1`,
        [X],
      );
      const { judge, calls } = controlled();
      f.telegram.queued = [[group(X, "what time is check-in at the hotel?", 101, 1), group(X, "/proactive 1", 7771001, 2)]];
      f.start(judge);
      await until(() => calls.length === 1, "judged");
      await sleep(100);
      assert.equal((await f.pool.query("SELECT proactive_level AS l FROM control_plane.telegram_chat_bindings WHERE chat_id = $1", [X])).rows[0].l, 3, "not yet");
      calls[0]!.settle(YES);
      await until(() => f.telegram.sent.some((m) => m.chatId === X && /Level 1/.test(m.text)), "the command was answered");
      assert.equal(f.connector.pushed.length, 1, "the judged message was forwarded first");
    });
  });
});

describe("acknowledgement: the offset moves on receipt, as for every update", { skip: SKIP }, () => {
  test("the next getUpdates asks past a parked update while its judgement is still out; nothing is redelivered or handled twice", async () => {
    await withFix(async (f) => {
      const { judge, calls } = controlled();
      f.telegram.queued = [[group(X, "what time is check-in at the hotel?", 101, 41)]];
      f.start(judge);
      await until(() => calls.length === 1, "parked");
      await until(() => f.telegram.offsets.length >= 2, "the loop polled again");
      assert.ok(f.telegram.offsets.slice(1).every((o) => o === 42), `the loop asked for offset 42, got ${JSON.stringify(f.telegram.offsets)}`);
      assert.equal(calls.length, 1, "the update was judged once");
      calls[0]!.settle(YES);
      await until(() => f.connector.pushed.length === 1, "forwarded once");
      await sleep(100);
      assert.equal(f.connector.pushed.length, 1);
      assert.equal(calls.length, 1);
    });
  });

  test("stopping the poller with a judgement out does not crash, and the late verdict is harmless", async () => {
    await withFix(async (f) => {
      const { judge, calls } = controlled();
      f.telegram.queued = [[group(X, "what time is check-in at the hotel?", 101, 1)]];
      const stop = f.start(judge);
      await until(() => calls.length === 1, "parked");
      stop();
      calls[0]!.settle(NO);
      await sleep(100);
    });
  });
});

describe("concurrency cap and queue_full (the judge's own bounds, real judge, controllable runner)", { skip: SKIP }, () => {
  function runnerHeld() {
    const inFlight: { settle: (reply: string) => void }[] = [];
    let peak = 0;
    let running = 0;
    const runner: StructuredModelRunner = {
      describe: (task) => (task === JUDGE_TASK ? { provider: "fake", model: "vendor/m" } : null),
      run: (async (req: { parse: (raw: unknown) => unknown }) => {
        running += 1;
        peak = Math.max(peak, running);
        const reply = await new Promise<string>((resolve) => inFlight.push({ settle: resolve }));
        running -= 1;
        return { ok: true, value: req.parse(JSON.parse(reply)), attempts: 1, ms: 1 };
      }) as unknown as StructuredModelRunner["run"],
    };
    return { runner, inFlight, peak: () => peak };
  }
  const NOANSWER = '{"for_assistant": false, "confidence": 0.9}';
  const YESANSWER = '{"for_assistant": true, "confidence": 0.9}';

  test("at most JUDGE_CONCURRENCY calls at once; the rest wait for a slot and are served in turn", async () => {
    await withFix(async (f) => {
      const held = runnerHeld();
      const judge = createGroupJudge({ runner: held.runner, concurrency: 2, rateLimiter: new JudgeRateLimiter(1000) });
      f.telegram.queued = [[group(X, "question one about the plan?", 101, 1), group(Y, "question two about the plan?", 102, 2), group(Z, "question three about the plan?", 103, 3)]];
      f.start(judge);
      await until(() => held.inFlight.length === 2, "two calls started");
      await sleep(150);
      assert.equal(held.inFlight.length, 2, "the third chat waits for a slot");
      held.inFlight[0]!.settle(YESANSWER);
      await until(() => held.inFlight.length === 3, "the third started when a slot freed");
      held.inFlight[1]!.settle(NOANSWER);
      held.inFlight[2]!.settle(NOANSWER);
      await until(() => f.connector.pushed.length === 1, "the one yes was forwarded");
      assert.equal(held.peak(), 2, "never more than 2 at once");
    });
  });

  test("a full line is judge_fallback queue_full: that message is NOT_ADDRESSED at once, and the others are unaffected", async () => {
    await withFix(async (f) => {
      const held = runnerHeld();
      const events: unknown[] = [];
      const emitter = new RelayAssistantEvents({ sink: { write: async (e) => { events.push(...e); return { inserted: e.length, duplicates: 0, rejected: [] }; } }, flushIntervalMs: 0 });
      const judge = createGroupJudge({ runner: held.runner, concurrency: 1, maxQueued: 1, rateLimiter: new JudgeRateLimiter(1000) });
      f.telegram.queued = [[group(X, "question one about the plan?", 101, 1), group(Y, "question two about the plan?", 102, 2), group(Z, "question three about the plan?", 103, 3)]];
      f.start(judge, { assistantEvents: emitter });
      await until(() => held.inFlight.length === 1, "one running");
      await emitter.flush();
      await sleep(150);
      await emitter.flush();
      const rows = events as { event_type: string; outcome: string; metadata: Record<string, unknown> }[];
      const fallbacks = rows.filter((r) => r.event_type === "group_judged" && r.outcome === "judge_fallback");
      assert.equal(fallbacks.length, 1, "chat Z found no place in line");
      assert.equal(fallbacks[0]!.metadata.judge_fallback_reason, "queue_full");
      assert.equal(held.inFlight.length, 1, "and no extra call was made for it");
      held.inFlight[0]!.settle(YESANSWER);
      await until(() => held.inFlight.length === 2, "the queued chat got the slot");
      held.inFlight[1]!.settle(NOANSWER);
      await until(() => f.connector.pushed.length === 1, "the first chat's yes was forwarded");
    });
  });

  test("queue_full is a recordable fallback reason and the breaker does not count it as an outage", async () => {
    const { JUDGE_FALLBACK_REASONS } = await import("../src/analytics/contract.js");
    assert.ok((JUDGE_FALLBACK_REASONS as readonly string[]).includes("queue_full"));
    const held = runnerHeld();
    const judge = createGroupJudge({ runner: held.runner, concurrency: 1, maxQueued: 0, breakerThreshold: 2, rateLimiter: new JudgeRateLimiter(1000) });
    const input = { chatId: "-1", text: "hello there friend", assistantNames: ["Liv"], language: "en" as const };
    const running = judge.judge(input);
    for (let i = 0; i < 5; i += 1) {
      const out = await judge.judge({ ...input, chatId: `-${i + 2}` });
      assert.deepEqual({ kind: out.kind, reason: out.kind === "fallback" ? out.reason : "" }, { kind: "fallback", reason: "queue_full" });
    }
    held.inFlight[0]!.settle(NOANSWER);
    assert.equal((await running).kind, "no", "the circuit stayed closed: the running call is an ordinary no");
  });

  test("a wait longer than the call's own timeout also gives the place back as queue_full", async () => {
    const held = runnerHeld();
    const judge = createGroupJudge({ runner: held.runner, concurrency: 1, maxQueued: 5, timeoutMs: 60, rateLimiter: new JudgeRateLimiter(1000) });
    const input = { chatId: "-1", text: "hello there friend", assistantNames: ["Liv"], language: "en" as const };
    const running = judge.judge(input);
    const waiter = await judge.judge({ ...input, chatId: "-2" });
    assert.deepEqual({ kind: waiter.kind, reason: waiter.kind === "fallback" ? waiter.reason : "" }, { kind: "fallback", reason: "queue_full" });
    held.inFlight[0]?.settle(NOANSWER);
    await running.catch(() => {});
  });
});
