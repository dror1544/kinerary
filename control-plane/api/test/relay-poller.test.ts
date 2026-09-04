import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import {
  answerCallbackData,
  CONFIRM_CALLBACK_DATA,
  KEEP_PLANNING_CALLBACK_DATA,
  startFromDeepLink,
} from "../src/chat-router.js";
import { getSessionForChat } from "../src/interview.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { applyDecision, startTripBotPoller } from "../src/relay/poller.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import type { WireMessageEvent } from "../src/relay/protocol.js";
import type { BotSelf, ChatInfo, SendResult, TelegramClient } from "../src/relay/telegram-api.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

// ── Fakes ────────────────────────────────────────────────────────────────────

interface SentMessage {
  chatId: string;
  text: string;
  hasButtons: boolean;
  buttonData: string[];
}

/**
 * Records what the poller would have sent. Deliberately a recorder rather than
 * a mock with expectations: the assertions worth making are about what the
 * organizer ends up seeing, not about call order.
 */
class FakeTelegram implements TelegramClient {
  readonly sent: SentMessage[] = [];
  readonly answered: { callbackQueryId: string; text?: string }[] = [];
  webhookCleared = false;
  /** Queued getUpdates responses; each poll shifts one, then returns []. */
  queued: unknown[][] = [];
  polls = 0;

  async sendMessage(params: {
    chatId: string;
    text: string;
    replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] };
  }): Promise<SendResult> {
    this.sent.push({
      chatId: params.chatId,
      text: params.text,
      hasButtons: Boolean(params.replyMarkup),
      buttonData: (params.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data),
    });
    return { ok: true, messageId: String(this.sent.length) };
  }
  async editMessageText(): Promise<SendResult> { return { ok: true }; }
  async sendChatAction(): Promise<void> { /* no-op */ }
  async answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void> {
    this.answered.push(params);
  }
  async getChatInfo(): Promise<ChatInfo | null> { return null; }
  async getMe(): Promise<BotSelf | null> { return { id: "7000000001", username: "KineraryTestBot" }; }
  async getUpdates(): Promise<unknown[]> {
    this.polls += 1;
    return this.queued.shift() ?? [];
  }
  async deleteWebhookIfPresent(): Promise<void> { this.webhookCleared = true; }

  get lastSent(): SentMessage | undefined { return this.sent[this.sent.length - 1]; }
}

class FakeConnector {
  readonly pushed: WireMessageEvent[] = [];
  constructor(private readonly deliver = true) {}
  pushInbound(event: WireMessageEvent): boolean {
    this.pushed.push(event);
    return this.deliver;
  }
}

interface Fixture {
  pool: pg.Pool;
  tripId: string;
  userId: string;
  telegram: FakeTelegram;
  connector: FakeConnector;
}

async function withFixture(fn: (fix: Fixture) => Promise<void>, deliver = true): Promise<void> {
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
    const userId = testId("user");
    const tripId = testId("trip");
    await pool.query(
      "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')",
      [userId],
    );
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [
      tripId,
      tripId.replace(/_/g, "-"),
    ]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [testId("memb"), tripId, userId],
    );
    await fn({ pool, tripId, userId, telegram: new FakeTelegram(), connector: new FakeConnector(deliver) });
  } finally {
    await pool.end();
  }
}

function tap(chatId: string, data: string): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "cbq_1",
      data,
      from: { id: 777 },
      message: { message_id: 7, chat: { id: chatId, type: "private" } },
    },
  };
}

function msg(chatId: string, text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 7, from: { id: 777, first_name: "Dror" }, chat: { id: chatId, type: "private" }, text },
  };
}

/** Runs one update all the way through: dispatch decides, applyDecision acts. */
async function turn(fix: Fixture, update: TelegramUpdate): Promise<void> {
  const decision = await dispatchUpdate(fix.pool, update);
  await applyDecision(decision, { db: fix.pool, telegram: fix.telegram, connector: fix.connector });
}

/** Gets an interview going in `chatId` and returns its session id. */
async function beginInterview(fix: Fixture, chatId: string): Promise<string> {
  const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok);
  const started = await startFromDeepLink(fix.pool, chatId, issued.token);
  assert.equal(started.kind, "started");
  return started.kind === "started" ? started.sessionId : "";
}

// ── The organizer flow ───────────────────────────────────────────────────────

describe("the organizer's first taps are recorded", () => {
  test("a deep link produces a real question with real buttons", { skip: SKIP }, async () => {
    // The whole point of the router owning /start. Hermes's gateway discards
    // every /start before an agent sees it, which is what made one-tap
    // onboarding structurally impossible.
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      await turn(fix, msg("700100001", `/start ${issued.token}`));

      const sent = fix.telegram.lastSent;
      assert.ok(sent, "the organizer gets an immediate reply");
      assert.ok(sent.hasButtons, "the first intake question is tap-answerable");
      assert.ok(
        sent.buttonData.every((d) => d.startsWith("a:trip_type:")),
        "the buttons answer the question that was asked",
      );
    });
  });

  test("a tapped button is written to the session and the next question follows", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100002");
      await turn(fix, tap("700100002", answerCallbackData("trip_type", "family")));

      const session = await getSessionForChat(fix.pool, "700100002");
      assert.ok(session.ok);
      assert.equal(
        session.ok && session.view.nextQuestion?.id,
        "destination",
        "the answer landed, so the interview advanced",
      );

      // The tap is acknowledged — otherwise Telegram spins the button forever.
      assert.equal(fix.telegram.answered.length, 1);
      assert.equal(fix.telegram.lastSent?.text, "Where is the trip? (city/region/country)");
      assert.equal(fix.telegram.lastSent?.hasButtons, false, "a text question carries no keyboard");
    });
  });

  test("the answer is recorded against the chat's OWN session, never the payload's", { skip: SKIP }, async () => {
    // A forged or replayed callback_data claims only WHICH option was tapped.
    // Which session it lands in is resolved from the chat, inside the same
    // transaction that writes it.
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100003");
      const stranger = "700100004";
      await turn(fix, tap(stranger, answerCallbackData("trip_type", "couple")));

      const victim = await getSessionForChat(fix.pool, "700100003");
      assert.ok(victim.ok);
      assert.equal(
        victim.ok && victim.view.nextQuestion?.id,
        "trip_type",
        "the untouched interview is still on its first question",
      );
      // An interview-shaped tap from a chat with no interview is stale, and is
      // dropped rather than answered — there is no session to narrate, and it
      // must not fall through to the approval path.
      assert.equal(fix.telegram.sent.length, 0);
    });
  });

  test("an unknown option is refused rather than recorded", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100005");
      await turn(fix, tap("700100005", answerCallbackData("trip_type", "spelunking")));

      const session = await getSessionForChat(fix.pool, "700100005");
      assert.equal(session.ok && session.view.nextQuestion?.id, "trip_type", "nothing was written");
      assert.ok(fix.telegram.answered[0]?.text, "the organizer is told, not left guessing");
    });
  });
});

// ── Written answers ──────────────────────────────────────────────────────────

describe("written answers say what is actually true", () => {
  test("typing while a CHOICE question is pending points at the buttons", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100010");
      await turn(fix, msg("700100010", "it's a family trip"));
      assert.equal(fix.telegram.lastSent?.text, DEFAULT_STRINGS.tapAnOption);
    });
  });

  test("answering a TEXT question in writing admits it cannot be recorded", { skip: SKIP }, async () => {
    // The organizer did exactly as asked — "Where are you going?" has no
    // buttons to tap. Telling them to tap one would be nonsense, and a cheerful
    // "got it!" for something nothing stored would be worse: they would only
    // find out at the recap.
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100011");
      await turn(fix, tap("700100011", answerCallbackData("trip_type", "family")));
      await turn(fix, msg("700100011", "Japan"));

      assert.equal(fix.telegram.lastSent?.text, DEFAULT_STRINGS.writtenAnswerUnsupported);
      const session = await getSessionForChat(fix.pool, "700100011");
      assert.equal(
        session.ok && session.view.nextQuestion?.id,
        "destination",
        "nothing was silently recorded",
      );
    });
  });
});

// ── Confirmation ─────────────────────────────────────────────────────────────

describe("the confirm button is a real confirmation", () => {
  /** Answers every required question directly, leaving the session at the confirm step. */
  async function fillRequired(fix: Fixture, chatId: string): Promise<void> {
    const answers = {
      trip_type: { kind: "choice", option_id: "family", schema_version: 2, other_text: null },
      destination: { kind: "text", schema_version: 2, text: "Japan" },
      group_size: { kind: "choice", option_id: "3_to_5", schema_version: 2, other_text: null },
      trip_duration: { kind: "choice", option_id: "week", schema_version: 2, other_text: null },
      departure_date: { kind: "text", schema_version: 2, text: "2026-09-06" },
      return_date: { kind: "text", schema_version: 2, text: "2026-09-13" },
      travelers: { kind: "structured", schema_version: 2, data: [{ name: "Dror" }] },
      phases: { kind: "structured", schema_version: 2, data: [{ name: "Tokyo" }] },
    };
    await fix.pool.query(
      "UPDATE control_plane.intake_sessions SET answers = $1, state = 'awaiting_confirmation' WHERE telegram_chat_id = $2",
      [JSON.stringify(answers), chatId],
    );
  }

  test("tapping Confirm creates the immutable intake version", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100020");
      await fillRequired(fix, "700100020");
      await turn(fix, tap("700100020", CONFIRM_CALLBACK_DATA));

      const versions = await fix.pool.query(
        "SELECT version FROM control_plane.intake_versions WHERE trip_id = $1",
        [fix.tripId],
      );
      assert.equal(versions.rowCount, 1, "a labelled button satisfies the literal-CONFIRM rule");
      const trip = await fix.pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [
        fix.tripId,
      ]);
      assert.equal(trip.rows[0].lifecycle_state, "intake_confirmed");
    });
  });

  test("a double-tap confirms once and still reads as success", { skip: SKIP }, async () => {
    // The second tap arrives after the session is already confirmed. Locating
    // it must not exclude confirmed sessions, or a successful confirmation
    // would report NOT_FOUND back to the organizer.
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100021");
      await fillRequired(fix, "700100021");
      await turn(fix, tap("700100021", CONFIRM_CALLBACK_DATA));
      const afterFirst = fix.telegram.lastSent?.text;

      await turn(fix, tap("700100021", CONFIRM_CALLBACK_DATA));

      const versions = await fix.pool.query(
        "SELECT version FROM control_plane.intake_versions WHERE trip_id = $1",
        [fix.tripId],
      );
      assert.equal(versions.rowCount, 1, "no duplicate version");
      assert.ok(afterFirst?.includes("locked in"));
    });
  });

  test("Confirm before the required questions are done refuses and says so", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100022");
      await turn(fix, tap("700100022", CONFIRM_CALLBACK_DATA));

      const versions = await fix.pool.query(
        "SELECT version FROM control_plane.intake_versions WHERE trip_id = $1",
        [fix.tripId],
      );
      assert.equal(versions.rowCount, 0);
      assert.match(fix.telegram.lastSent?.text ?? "", /still a few things/);
    });
  });

  test("Keep planning leaves the intake unconfirmed", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100023");
      await fillRequired(fix, "700100023");
      await turn(fix, tap("700100023", KEEP_PLANNING_CALLBACK_DATA));

      const versions = await fix.pool.query(
        "SELECT version FROM control_plane.intake_versions WHERE trip_id = $1",
        [fix.tripId],
      );
      assert.equal(versions.rowCount, 0);
      const trip = await fix.pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [
        fix.tripId,
      ]);
      assert.notEqual(trip.rows[0].lifecycle_state, "intake_confirmed");
    });
  });
});

// ── Gateway hand-off ─────────────────────────────────────────────────────────

describe("turns handed to the gateway", () => {
  test("a bound chat's message reaches the gateway stamped with its profile", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, $3)",
        ["700100030", fix.tripId, "companion-japan"],
      );
      await turn(fix, msg("700100030", "what time is our flight?"));

      assert.equal(fix.connector.pushed.length, 1);
      assert.equal(fix.connector.pushed[0]?.source.profile, "companion-japan");
      assert.equal(fix.telegram.sent.length, 0, "a routed turn is answered by the agent, not by us");
    });
  });

  test("a turn the gateway cannot take is admitted, not silently dropped", { skip: SKIP }, async () => {
    // Nothing queues. Staying silent would leave the organizer waiting on an
    // answer that is never coming.
    await withFixture(async (fix) => {
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, $3)",
        ["700100031", fix.tripId, "companion-japan"],
      );
      await turn(fix, msg("700100031", "are we there yet?"));
      assert.equal(fix.telegram.lastSent?.text, DEFAULT_STRINGS.gatewayUnavailable);
    }, /* deliver */ false);
  });
});

// ── The loop ─────────────────────────────────────────────────────────────────

describe("the poll loop", () => {
  test("clears a webhook, subscribes to both update types, and advances its offset", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      fix.telegram.queued = [[msg("700100040", `/start ${issued.token}`)]];

      const stop = startTripBotPoller(
        { db: fix.pool, telegram: fix.telegram, connector: fix.connector },
        { longPollSeconds: 0, maxBackoffMs: 10 },
      );
      // Let the loop drain the queued batch and settle into backoff.
      await new Promise((resolve) => setTimeout(resolve, 300));
      stop();

      assert.equal(fix.telegram.webhookCleared, true, "getUpdates fails while a webhook is registered");
      assert.ok(fix.telegram.sent.length >= 1, "the queued update was actually dispatched");
      assert.ok(fix.telegram.lastSent?.hasButtons);
    });
  });

  test("a poisoned update cannot wedge the loop behind it", { skip: SKIP }, async () => {
    // The offset advances BEFORE handling. Telegram redelivers everything at or
    // after the offset until it moves, so an update that throws every time
    // would otherwise silence the bot permanently.
    await withFixture(async (fix) => {
      const exploding = { update_id: 5, message: { chat: { get id() { throw new Error("boom"); } } } };
      fix.telegram.queued = [[exploding], [msg("700100041", "hello?")]];

      const stop = startTripBotPoller(
        { db: fix.pool, telegram: fix.telegram, connector: fix.connector },
        { longPollSeconds: 0, maxBackoffMs: 10 },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      stop();

      assert.equal(
        fix.telegram.lastSent?.text,
        DEFAULT_STRINGS.unbound,
        "the update after the poisoned one was still processed",
      );
    });
  });
});

// ── Subsuming the signup poller ──────────────────────────────────────────────

describe("when the trip bot IS the signup bot", () => {
  // Telegram hands each update to exactly one getUpdates caller and answers a
  // second concurrent one with 409, so when the two bots are one bot this loop
  // has to carry the approval callbacks too rather than run beside
  // telegram-poller.ts. server.ts stands its own poller down on the same
  // comparison of resolved tokens.

  const APPROVAL_CONFIG = {
    superAdminSubjectDigest: "sha256:" + "0".repeat(64),
    actionSecret: "test-action-secret",
    actionTtlSeconds: 3600,
    messagingAdapter: "fake",
    signupRateLimitCooldownSeconds: 3600,
  };

  /** An approval-shaped callback: no interview session in this chat. */
  function approvalTap(data: string): TelegramUpdate {
    return {
      update_id: 3,
      callback_query: { id: "cbq_appr", data, from: { id: 391627336 } },
    };
  }

  test("an approval callback is answered when the config is present", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, approvalTap("not-a-real-signed-token"));
      assert.equal(decision.kind, "approval_callback");

      await applyDecision(decision, {
        db: fix.pool,
        telegram: fix.telegram,
        connector: fix.connector,
        approvals: { config: APPROVAL_CONFIG },
      });

      // The tap is always answered, even on refusal — otherwise Telegram spins
      // the button forever and the admin cannot tell refusal from a hang.
      assert.equal(fix.telegram.answered.length, 1);
      assert.equal(fix.telegram.answered[0]?.text, "Could not process this action");
    });
  });

  test("without the config the callback is dropped, not acted on", { skip: SKIP }, async () => {
    // The tokens are different, so this update cannot be ours. Acting on it
    // would mean deciding an approval this process was never configured for.
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, approvalTap("not-a-real-signed-token"));
      await applyDecision(decision, {
        db: fix.pool,
        telegram: fix.telegram,
        connector: fix.connector,
      });
      assert.equal(fix.telegram.answered.length, 0);
      assert.equal(fix.telegram.sent.length, 0);
    });
  });

  test("an interview tap is never mistaken for an approval", { skip: SKIP }, async () => {
    // The two share one update stream now, so the branch that tells them apart
    // is load-bearing: an interview button must reach the interview even with
    // approval handling configured.
    await withFixture(async (fix) => {
      await beginInterview(fix, "700100050");
      const decision = await dispatchUpdate(
        fix.pool,
        tap("700100050", answerCallbackData("trip_type", "family")),
      );
      assert.equal(decision.kind, "interview_callback");

      await applyDecision(decision, {
        db: fix.pool,
        telegram: fix.telegram,
        connector: fix.connector,
        approvals: { config: APPROVAL_CONFIG },
      });

      const session = await getSessionForChat(fix.pool, "700100050");
      assert.equal(session.ok && session.view.nextQuestion?.id, "destination");
    });
  });
});
