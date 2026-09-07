import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink, answerCallbackData, CONFIRM_CALLBACK_DATA } from "../src/chat-router.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { confirmIntakeForChat, getSessionForChat, submitAnswerForChat } from "../src/interview.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
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

async function bindCompanion(fix: Fixture, chatId: string, profile: string | null): Promise<void> {
  await fix.pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, $3)",
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

  test("a bound chat with no assistant yet is answered honestly, not told it has no trip", { skip: SKIP }, async () => {
    // The whole point of A4, at the only layer the organizer sees. On
    // 2026-09-06 a trip provisioned perfectly — site up, HTTP 200 — and the
    // organizer messaging the bot was told "I don't have a trip for this
    // chat", because the companion install had failed and routing was gated
    // behind it. Routing now exists independently, so the honest answer is
    // available: we know your trip, the assistant is not ready yet.
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000666", null);
      const decision = await dispatchUpdate(fix.pool, msg("700000666", "מתי הטיסה שלנו?"));
      assert.equal(decision.kind, "reply");
      assert.equal(
        decision.kind === "reply" && decision.reply.text,
        DEFAULT_STRINGS.companionPending,
      );
      assert.notEqual(
        decision.kind === "reply" && decision.reply.text,
        DEFAULT_STRINGS.unbound,
        "never claim the trip is unknown — it is bound, and the site is already up",
      );
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

describe("chat-addressed session writes", () => {
  // The router holds a router-verified chat id and never a session token.
  // These assert that the chat alone is a sufficient AND correctly scoped
  // credential — the reason submitAnswerForChat exists rather than the router
  // storing a token at rest to satisfy submitAnswer's signature.

  test("an answer written by chat id lands in that chat's session", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      const started = await startFromDeepLink(fix.pool, "700002000", issued.token);
      assert.equal(started.kind, "started");

      const result = await submitAnswerForChat(fix.pool, "700002000", "trip_type", "family");
      assert.ok(result.ok);
      assert.equal(result.ok && result.view.sessionId, started.kind === "started" ? started.sessionId : "");
      assert.equal(result.ok && result.view.nextQuestion?.id, "destination");
    });
  });

  test("a chat with no interview can write nothing", { skip: SKIP }, async () => {
    // Fail closed. The chat id is a routing fact; where it resolves to no
    // session it must grant nothing, not fall back to any default.
    await withFixture(async (fix) => {
      const result = await submitAnswerForChat(fix.pool, "700002001", "trip_type", "family");
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "NOT_FOUND");
    });
  });

  test("one organizer's chat cannot write into another's session", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const first = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(first.ok);
      await startFromDeepLink(fix.pool, "700002002", first.token);

      // A second chat, no session of its own, submitting the same payload.
      const result = await submitAnswerForChat(fix.pool, "700002003", "trip_type", "couple");
      assert.equal(result.ok, false);

      const victim = await getSessionForChat(fix.pool, "700002002");
      assert.ok(victim.ok);
      assert.equal(victim.ok && victim.view.nextQuestion?.id, "trip_type", "untouched");
    });
  });

  test("a confirmed session refuses further answers but still confirms idempotently", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      await startFromDeepLink(fix.pool, "700002004", issued.token);
      await fix.pool.query(
        `UPDATE control_plane.intake_sessions
         SET answers = $1, state = 'awaiting_confirmation'
         WHERE telegram_chat_id = $2`,
        [
          JSON.stringify({
            trip_type: { kind: "choice", option_id: "family", schema_version: 2, other_text: null },
            destination: { kind: "text", schema_version: 2, text: "Japan" },
            group_size: { kind: "choice", option_id: "3_to_5", schema_version: 2, other_text: null },
            trip_duration: { kind: "choice", option_id: "week", schema_version: 2, other_text: null },
            departure_date: { kind: "text", schema_version: 2, text: "2026-09-06" },
            return_date: { kind: "text", schema_version: 2, text: "2026-09-13" },
            travelers: { kind: "structured", schema_version: 2, data: [{ name: "Dror" }] },
            phases: { kind: "structured", schema_version: 2, data: [{ name: "Tokyo" }] },
          }),
          "700002004",
        ],
      );

      const first = await confirmIntakeForChat(fix.pool, "700002004");
      assert.ok(first.ok);

      // Locating by chat must NOT exclude confirmed sessions, or this second
      // call — an organizer double-tapping Confirm — would report NOT_FOUND
      // for a confirmation that in fact succeeded.
      const second = await confirmIntakeForChat(fix.pool, "700002004");
      assert.ok(second.ok);
      assert.equal(
        second.ok && second.intakeVersionId,
        first.ok ? first.intakeVersionId : "",
        "the same version, not a second one",
      );

      const late = await submitAnswerForChat(fix.pool, "700002004", "trip_type", "couple");
      assert.equal(late.ok === false && late.reason, "SESSION_CONFIRMED");
    });
  });

  test("a second interview in the same chat is the one that gets written", { skip: SKIP }, async () => {
    // An organizer who finished one trip must be able to start another from
    // the same DM (Sprint 5's "re-enter interview mode for a new trip"). The
    // chat then owns two sessions, so lockSession's ordering — live first — is
    // what decides where the answer goes, and it is load-bearing rather than
    // cosmetic.
    await withFixture(async (fix) => {
      const chatId = "700002005";

      // The first trip, taken all the way to confirmed through the real path
      // so the row has the shape the schema actually requires.
      const firstIssued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(firstIssued.ok);
      const firstStarted = await startFromDeepLink(fix.pool, chatId, firstIssued.token);
      assert.equal(firstStarted.kind, "started");
      const firstSessionId = firstStarted.kind === "started" ? firstStarted.sessionId : "";
      await fix.pool.query(
        `UPDATE control_plane.intake_sessions
         SET state = 'confirmed', updated_at = now() - interval '1 day'
         WHERE id = $1`,
        [firstSessionId],
      );

      // A second trip — a new interview is for a new trip, not a rerun of the
      // confirmed one.
      const secondTripId = testId("trip");
      await fix.pool.query(
        "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
        [secondTripId, secondTripId.replace(/_/g, "-")],
      );
      await fix.pool.query(
        "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
        [testId("memb"), secondTripId, fix.userId],
      );

      const secondIssued = await issueEnrollment(fix.pool, fix.userId, secondTripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(secondIssued.ok);
      const secondStarted = await startFromDeepLink(fix.pool, chatId, secondIssued.token);
      assert.equal(secondStarted.kind, "started", "a confirmed session does not block a new one");

      const result = await submitAnswerForChat(fix.pool, chatId, "trip_type", "couple");
      assert.ok(result.ok);
      assert.equal(
        result.ok && result.view.sessionId,
        secondStarted.kind === "started" ? secondStarted.sessionId : "",
        "the LIVE session, not the old confirmed one",
      );
      assert.equal(result.ok && result.view.tripId, secondTripId);
    });
  });
});

describe("the companion arriving in a group", { skip: SKIP }, () => {
  const joinUpdate = (chatId: string, status = "member", botId = "8463178587") => ({
    update_id: 90,
    my_chat_member: {
      chat: { id: chatId, type: "supergroup" },
      from: { id: 77, is_bot: false, first_name: "Dror" },
      old_chat_member: { user: { id: Number(botId), is_bot: true }, status: "left" },
      new_chat_member: { user: { id: Number(botId), is_bot: true }, status },
    },
  }) as never;

  test("introduces itself in a group that is bound to a trip", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002000777";
      await fix.pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')`,
        [chatId, fix.tripId],
      );
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({
          assistant_name: "Rio",
          trip_title: "Japan 2026",
          private_url: "https://japan-2026.example",
          language: "en",
          login_password: "seed-pw",
          proactive: { morning_briefing: "07:30" },
        })],
      );

      const decision = await dispatchUpdate(
        fix.pool, joinUpdate(chatId), undefined, undefined, { id: "8463178587" },
      );
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.equal(decision.chatId, chatId);
      assert.match(decision.text, /Rio/);
      assert.match(decision.text, /https:\/\/japan-2026\.example/);
      assert.match(decision.text, /seed-pw/);
      assert.match(decision.text, /07:30/);
      // It is already in the group; offering an add-to-group link would be absurd.
      assert.doesNotMatch(decision.text, /startgroup/);
    });
  });

  test("the password can be withheld from the group by one option", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002000888";
      await fix.pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')`,
        [chatId, fix.tripId],
      );
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({
          assistant_name: "Rio", private_url: "https://japan-2026.example",
          language: "en", login_password: "seed-pw", organizer: "Dror",
        })],
      );

      const decision = await dispatchUpdate(
        fix.pool, joinUpdate(chatId), undefined, undefined, { id: "8463178587" },
        { groupIntroIncludesPassword: false },
      );
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.doesNotMatch(decision.text, /seed-pw/);
      assert.match(decision.text, /Dror/);
    });
  });

  test("an unbound group is told so, not left in silence", async () => {
    // People just invited it into a room. Saying nothing reads as broken.
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(
        fix.pool, joinUpdate("-1002000999"), undefined, undefined, { id: "8463178587" },
      );
      assert.equal(decision.kind, "reply");
    });
  });

  test("a promotion to admin is not a second arrival", async () => {
    // Re-introducing on every permissions change would be noise in a live
    // family group.
    await withFixture(async (fix) => {
      const chatId = "-1002000111";
      await fix.pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')`,
        [chatId, fix.tripId],
      );
      const promoted = {
        update_id: 91,
        my_chat_member: {
          chat: { id: chatId, type: "supergroup" },
          old_chat_member: { user: { id: 8463178587, is_bot: true }, status: "member" },
          new_chat_member: { user: { id: 8463178587, is_bot: true }, status: "administrator" },
        },
      } as never;
      const decision = await dispatchUpdate(
        fix.pool, promoted, undefined, undefined, { id: "8463178587" },
      );
      assert.notEqual(decision.kind, "group_intro");
    });
  });

  test("a trip with no stored intro facts stays quiet rather than inventing a name", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002000222";
      await fix.pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')`,
        [chatId, fix.tripId],
      );
      const decision = await dispatchUpdate(
        fix.pool, joinUpdate(chatId), undefined, undefined, { id: "8463178587" },
      );
      assert.equal(decision.kind, "ignore");
    });
  });
});
