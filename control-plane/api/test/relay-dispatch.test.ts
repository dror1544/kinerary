import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink, answerCallbackData, CONFIRM_CALLBACK_DATA } from "../src/chat-router.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

interface Fixture {
  pool: pg.Pool;
  tripId: string;
  userId: string;
}

async function withFixture(fn: (fix: Fixture) => Promise<void>): Promise<void> {
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
    await fn({ pool, tripId, userId });
  } finally {
    await pool.end();
  }
}

function msg(chatId: string, text: string, chatType = "private"): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      from: { id: 777, first_name: "Dror" },
      chat: { id: chatId, type: chatType },
      text,
    },
  };
}

function tap(chatId: string | null, data: string, fromId = 777): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "cbq_1",
      data,
      from: { id: fromId },
      ...(chatId === null ? {} : { message: { message_id: 7, chat: { id: chatId, type: "private" } } }),
    },
  };
}

async function bindCompanion(fix: Fixture, chatId: string, profile: string): Promise<void> {
  await fix.pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3)",
    [chatId, fix.tripId, profile],
  );
}

describe("dispatchUpdate — the branch table", () => {
  test("a valid deep link starts the interview and replies with the first question", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);

      const decision = await dispatchUpdate(fix.pool, msg("700000111", `/start ${issued.token}`));
      assert.equal(decision.kind, "reply");
      if (decision.kind !== "reply") return;
      assert.equal(decision.reply.chatId, "700000111");
      // The question comes back on the first tap — no "hold on while I set up".
      assert.ok(decision.reply.text.length > 0);
      assert.ok(decision.reply.replyMarkup, "the first intake question is a choice, so it carries buttons");
    });
  });

  test("a /start is never forwarded to the gateway", { skip: SKIP }, async () => {
    // The entire reason the connector owns the socket: Hermes's gateway
    // discards every /start before an agent sees it.
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000222", "companion");
      const decision = await dispatchUpdate(fix.pool, msg("700000222", "/start something"));
      assert.notEqual(decision.kind, "to_gateway");
    });
  });

  test("a bound chat's ordinary message goes to the gateway with its profile", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000333", "companion-japan");
      const decision = await dispatchUpdate(fix.pool, msg("700000333", "what time is our flight?"));
      assert.equal(decision.kind, "to_gateway");
      if (decision.kind !== "to_gateway") return;
      assert.equal(decision.event.source.profile, "companion-japan");
      assert.equal(decision.event.text, "what time is our flight?");
    });
  });

  test("an unknown chat is refused, never routed", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, msg("700000444", "hello?"));
      assert.equal(decision.kind, "reply");
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.unbound);
    });
  });

  test("a bare /start explains itself instead of failing silently", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, msg("700000555", "/start"));
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.noPayload);
    });
  });

  test("a dead link gets a different sentence from a bare /start", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, msg("700000666", "/start deadtokenxyz"));
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.badLink);
    });
  });

  test("a deep link opened in a group is redirected to a DM", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      const decision = await dispatchUpdate(
        fix.pool,
        msg("-1005550000", `/start ${issued.token}`, "supergroup"),
      );
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.notPrivate);

      const state = await fix.pool.query(
        "SELECT state FROM control_plane.interview_enrollments WHERE id = $1",
        [issued.enrollmentId],
      );
      assert.equal(state.rows[0].state, "issued", "the link must survive to be used in a DM");
    });
  });

  test("the bot's own message is ignored, not echoed back into a turn", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000777", "companion");
      const update = msg("700000777", "an earlier reply of mine");
      update.message!.from = { id: 999, is_bot: true };
      const decision = await dispatchUpdate(fix.pool, update);
      assert.deepEqual(decision, { kind: "ignore", reason: "FROM_BOT" });
    });
  });
});

describe("dispatchUpdate — callback routing", () => {
  test("an interview button is routed to that chat's own session", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      const started = await startFromDeepLink(fix.pool, "700001000", issued.token);
      assert.equal(started.kind, "started");

      const decision = await dispatchUpdate(
        fix.pool,
        tap("700001000", answerCallbackData("trip_type", "family")),
      );
      assert.equal(decision.kind, "interview_callback");
      if (decision.kind !== "interview_callback") return;
      assert.equal(decision.chatId, "700001000");
      assert.equal(
        decision.sessionId,
        started.kind === "started" ? started.sessionId : "",
        "the session must come from the chat, not from the payload",
      );
    });
  });

  test("a replayed interview button cannot reach another organizer's session", { skip: SKIP }, async () => {
    // parseCallbackData yields only WHICH option was tapped. The session comes
    // from the chat the tap arrived in, so a stolen payload lands nowhere.
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      await startFromDeepLink(fix.pool, "700001100", issued.token);

      const decision = await dispatchUpdate(
        fix.pool,
        tap("700001199", answerCallbackData("trip_type", "family")),
      );
      assert.deepEqual(decision, { kind: "ignore", reason: "STALE_INTERVIEW_CALLBACK" });
    });
  });

  test("a confirm tap from a finished session is stale, not an approval token", { skip: SKIP }, async () => {
    // The dangerous confusion would be an interview-shaped callback falling
    // through to the signup-approval path, which acts on a signed token.
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700001200", "companion");
      const decision = await dispatchUpdate(fix.pool, tap("700001200", CONFIRM_CALLBACK_DATA));
      assert.deepEqual(decision, { kind: "ignore", reason: "STALE_INTERVIEW_CALLBACK" });
    });
  });

  test("an approval-shaped callback reaches the approval path with its sender", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, tap("700001300", "cbk_deadbeefdeadbeef", 12345));
      assert.equal(decision.kind, "approval_callback");
      if (decision.kind !== "approval_callback") return;
      // The sender identity comes off the observed Telegram event, never from
      // the payload — the webhook/callback trust boundary.
      assert.equal(decision.fromId, "12345");
      assert.equal(decision.data, "cbk_deadbeefdeadbeef");
    });
  });

  test("a callback with no sender is dropped", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const update = tap(null, "cbk_deadbeefdeadbeef");
      update.callback_query!.from = undefined;
      assert.deepEqual(await dispatchUpdate(fix.pool, update), {
        kind: "ignore",
        reason: "NO_CALLBACK_SENDER",
      });
    });
  });
});
