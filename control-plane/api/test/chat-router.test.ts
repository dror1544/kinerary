import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { confirmIntake, submitAnswer, INTAKE_QUESTIONS } from "../src/interview.js";
import {
  answerCallbackData,
  callbackDataFits,
  CONFIRM_CALLBACK_DATA,
  findQuestion,
  KEEP_PLANNING_CALLBACK_DATA,
  parseCallbackData,
  parseInbound,
  renderConfirmPrompt,
  renderQuestion,
  resolveChatRoute,
  startFromDeepLink,
} from "../src/chat-router.js";

// ── Pure decision logic — no database required ───────────────────────────────

describe("parseInbound", () => {
  test("extracts a deep-link payload from /start", () => {
    assert.deepEqual(parseInbound("/start abc123_-XY"), { kind: "start", payload: "abc123_-XY" });
  });

  test("strips the @botusername Telegram appends in group chats", () => {
    assert.deepEqual(parseInbound("/start@kinerary_bot abc123"), { kind: "start", payload: "abc123" });
  });

  test("a bare /start is a start with no payload, not a rejection", () => {
    // The user tapped Telegram's own Start button. That is a real entry point
    // and needs its own reply, so it must stay distinguishable here.
    assert.deepEqual(parseInbound("/start"), { kind: "start", payload: null });
    assert.deepEqual(parseInbound("/start@kinerary_bot"), { kind: "start", payload: null });
  });

  test("a payload outside Telegram's deep-link alphabet is treated as absent", () => {
    for (const bad of ["/start not a token", "/start ../../etc/passwd", "/start tok;DROP TABLE trips"]) {
      assert.deepEqual(parseInbound(bad), { kind: "start", payload: null }, bad);
    }
  });

  test("a payload longer than Telegram's 64-char limit is treated as absent", () => {
    assert.deepEqual(parseInbound(`/start ${"a".repeat(65)}`), { kind: "start", payload: null });
    const atLimit = "a".repeat(64);
    assert.deepEqual(parseInbound(`/start ${atLimit}`), { kind: "start", payload: atLimit });
  });

  test("other commands are classified as commands, not text", () => {
    assert.deepEqual(parseInbound("/select"), { kind: "command", name: "select" });
    assert.deepEqual(parseInbound("/HELP"), { kind: "command", name: "help" });
  });

  test("ordinary conversation is text", () => {
    assert.deepEqual(parseInbound("  we want to go in July  "), { kind: "text", text: "we want to go in July" });
  });

  test("a message that merely mentions /start is text, not a command", () => {
    assert.deepEqual(parseInbound("what does /start do?"), { kind: "text", text: "what does /start do?" });
  });
});

describe("callback data", () => {
  test("round-trips a question/option pair", () => {
    const data = answerCallbackData("trip_type", "group_of_families");
    assert.deepEqual(parseCallbackData(data), {
      kind: "answer",
      questionId: "trip_type",
      optionId: "group_of_families",
    });
  });

  test("recognises the confirm pair", () => {
    assert.deepEqual(parseCallbackData(CONFIRM_CALLBACK_DATA), { kind: "confirm" });
    assert.deepEqual(parseCallbackData(KEEP_PLANNING_CALLBACK_DATA), { kind: "keep_planning" });
  });

  test("rejects malformed or injected callback data", () => {
    for (const bad of ["", "a:", "a:only_one_part", "a:q:o:extra", "a:q:o'; DROP TABLE", "totally-unknown"]) {
      assert.deepEqual(parseCallbackData(bad), { kind: "unknown" }, JSON.stringify(bad));
    }
  });

  test("every real intake option fits Telegram's 64-byte callback_data limit", () => {
    // renderQuestion drops an option that would not fit, so a question whose
    // ids grew past the limit would silently lose a button. Catch it here.
    for (const question of INTAKE_QUESTIONS) {
      for (const option of question.options ?? []) {
        const data = answerCallbackData(question.id, option.id);
        assert.ok(callbackDataFits(data), `${data} exceeds 64 bytes`);
      }
    }
  });
});

describe("renderQuestion", () => {
  const choiceQuestion = INTAKE_QUESTIONS.find((q) => q.type === "choice" && (q.options?.length ?? 0) > 0);

  test("a choice question renders one button per option", () => {
    assert.ok(choiceQuestion, "expected at least one choice question in the intake set");
    const rendered = renderQuestion(choiceQuestion);
    assert.ok(rendered.replyMarkup, "choice question should carry a keyboard");
    assert.equal(rendered.replyMarkup.inline_keyboard.length, choiceQuestion.options?.length);
    for (const row of rendered.replyMarkup.inline_keyboard) {
      assert.equal(row.length, 1, "one option per row");
      assert.ok(callbackDataFits(row[0].callback_data));
    }
  });

  test("the options are not also echoed into the message text", () => {
    // Flagged twice in the live signup run: a list beside the buttons brings
    // back the "am I supposed to type this?" ambiguity the buttons remove.
    assert.ok(choiceQuestion);
    const rendered = renderQuestion(choiceQuestion);
    assert.equal(rendered.text, choiceQuestion.prompt);
    for (const option of choiceQuestion.options ?? []) {
      assert.ok(
        !rendered.text.includes(option.label),
        `option label "${option.label}" leaked into the message text`,
      );
    }
  });

  test("a text question renders no keyboard", () => {
    const textQuestion = INTAKE_QUESTIONS.find((q) => q.type === "text");
    assert.ok(textQuestion, "expected a text question in the intake set");
    assert.deepEqual(renderQuestion(textQuestion), { text: textQuestion.prompt, replyMarkup: null });
  });
});

describe("renderConfirmPrompt", () => {
  test("offers Confirm and Keep planning as buttons", () => {
    const rendered = renderConfirmPrompt("Here is your trip so far.");
    const [row] = rendered.replyMarkup!.inline_keyboard;
    assert.equal(row.length, 2);
    assert.deepEqual(
      row.map((b) => b.callback_data),
      [CONFIRM_CALLBACK_DATA, KEEP_PLANNING_CALLBACK_DATA],
    );
  });

  test("does not ask the organizer to type the word CONFIRM", () => {
    const rendered = renderConfirmPrompt("Here is your trip so far.");
    assert.ok(!rendered.text.includes("CONFIRM"));
  });
});

describe("findQuestion", () => {
  test("resolves a known id and refuses an unknown one", () => {
    assert.equal(findQuestion(INTAKE_QUESTIONS[0].id)?.id, INTAKE_QUESTIONS[0].id);
    assert.equal(findQuestion("no_such_question"), null);
  });
});

// ── Routing and the deep link — database required ───────────────────────────

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
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
      [tripId, tripId.replace(/_/g, "-")],
    );
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [testId("memb"), tripId, userId],
    );
    await fn({ pool, tripId, userId });
  } finally {
    await pool.end();
  }
}

async function issueToken(fix: Fixture): Promise<string> {
  const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok, `enrollment issue failed: ${JSON.stringify(issued)}`);
  return issued.token;
}

describe("resolveChatRoute (DB)", () => {
  test("an unknown chat is unbound — fail closed", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      assert.deepEqual(await resolveChatRoute(fix.pool, "999000111"), { kind: "unbound" });
    });
  });

  test("a chat with a live interview routes to that interview", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const token = await issueToken(fix);
      const started = await startFromDeepLink(fix.pool, "555000111", token);
      assert.equal(started.kind, "started");

      const route = await resolveChatRoute(fix.pool, "555000111");
      assert.equal(route.kind, "interview");
      assert.equal(route.kind === "interview" && route.tripId, fix.tripId);
    });
  });

  test("a bound chat with no live interview routes to the companion", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3)",
        ["555000222", fix.tripId, "trip-companion-abc"],
      );
      const route = await resolveChatRoute(fix.pool, "555000222");
      assert.equal(route.kind, "companion");
      assert.equal(route.kind === "companion" && route.hermesProfile, "trip-companion-abc");
    });
  });

  test("a live interview outranks a companion binding on the same chat", { skip: SKIP }, async () => {
    // The organizer's DM is already bound to trip one; they start trip two
    // from that same chat. Without this precedence the new interview could
    // never take a turn — every message would go to the companion.
    await withFixture(async (fix) => {
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3)",
        ["555000333", fix.tripId, "trip-companion-first"],
      );
      const token = await issueToken(fix);
      const started = await startFromDeepLink(fix.pool, "555000333", token);
      assert.equal(started.kind, "started");

      const route = await resolveChatRoute(fix.pool, "555000333");
      assert.equal(route.kind, "interview");
    });
  });

  test("confirming the interview hands the chat back to the companion", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3)",
        ["555000444", fix.tripId, "trip-companion-first"],
      );
      const token = await issueToken(fix);
      const started = await startFromDeepLink(fix.pool, "555000444", token);
      assert.equal(started.kind, "started");
      const sessionToken = started.kind === "started" ? started : null;
      assert.ok(sessionToken);

      // Drive the session to confirmed directly: this test is about the
      // routing flip, not about the answer validation covered elsewhere.
      await fix.pool.query(
        "UPDATE control_plane.intake_sessions SET state = 'confirmed' WHERE telegram_chat_id = $1",
        ["555000444"],
      );

      const route = await resolveChatRoute(fix.pool, "555000444");
      assert.equal(route.kind, "companion", "a confirmed session must stop outranking the binding");
    });
  });

  test("one chat's interview is invisible to another chat", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const token = await issueToken(fix);
      await startFromDeepLink(fix.pool, "555000555", token);
      assert.deepEqual(await resolveChatRoute(fix.pool, "555000556"), { kind: "unbound" });
    });
  });
});

describe("startFromDeepLink (DB)", () => {
  test("a valid token starts the interview and binds the chat", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const token = await issueToken(fix);
      const outcome = await startFromDeepLink(fix.pool, "555000777", token);
      assert.equal(outcome.kind, "started");
      assert.equal(outcome.kind === "started" && outcome.tripId, fix.tripId);

      const row = await fix.pool.query(
        "SELECT telegram_chat_id FROM control_plane.intake_sessions WHERE trip_id = $1",
        [fix.tripId],
      );
      assert.equal(row.rows[0].telegram_chat_id, "555000777");
    });
  });

  test("the first question comes back with the session, so the reply needs no second call", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const token = await issueToken(fix);
      const outcome = await startFromDeepLink(fix.pool, "555000778", token);
      assert.equal(outcome.kind, "started");
      assert.ok(outcome.kind === "started" && outcome.view.nextQuestion, "expected a first question");
    });
  });

  test("a replayed deep link is rejected — the enrollment is single use", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const token = await issueToken(fix);
      const first = await startFromDeepLink(fix.pool, "555000888", token);
      assert.equal(first.kind, "started");

      // A DIFFERENT chat replaying the same link must not get in, and must be
      // left with no trip context at all.
      const replay = await startFromDeepLink(fix.pool, "555000889", token);
      assert.equal(replay.kind, "rejected");
      assert.deepEqual(await resolveChatRoute(fix.pool, "555000889"), { kind: "unbound" });

      // The reason is deliberately not pinned here. consumeEnrollmentInTx
      // returns null for every non-issued state, so startSession reports
      // INVALID_TOKEN for a consumed, revoked or unknown token alike. That is
      // correct as security behavior — all three are refusals — but it means
      // the router cannot yet tell an organizer "you already used that link"
      // apart from "that link is not valid". Widening the taxonomy would
      // change a reason code the HTTP and MCP paths also consume, so it is a
      // deliberate follow-up, not a silent change made from here.
    });
  });

  test("an unknown token is rejected without starting anything", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const outcome = await startFromDeepLink(fix.pool, "555000999", "notarealtoken");
      assert.equal(outcome.kind, "rejected");
      assert.equal(outcome.kind === "rejected" && outcome.reason, "INVALID_TOKEN");
      assert.deepEqual(await resolveChatRoute(fix.pool, "555000999"), { kind: "unbound" });
    });
  });

  test("an expired token is rejected", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 1 });
      assert.ok(issued.ok);
      await fix.pool.query(
        "UPDATE control_plane.interview_enrollments SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [issued.enrollmentId],
      );
      const outcome = await startFromDeepLink(fix.pool, "555001000", issued.token);
      assert.equal(outcome.kind, "rejected");
    });
  });

  test("a bare /start with no payload is rejected, and consumes nothing", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const outcome = await startFromDeepLink(fix.pool, "555001100", null);
      assert.equal(outcome.kind, "rejected");
      assert.equal(outcome.kind === "rejected" && outcome.reason, "NO_PAYLOAD");
    });
  });

  test("a second link in a chat already interviewing leaves that token unconsumed", { skip: SKIP }, async () => {
    // The organizer taps an old link mid-interview. The running session must
    // survive, and the untouched token must still work afterwards.
    await withFixture(async (fix) => {
      const first = await issueToken(fix);
      const started = await startFromDeepLink(fix.pool, "555001200", first);
      assert.equal(started.kind, "started");

      const secondTripId = testId("trip");
      await fix.pool.query(
        "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
        [secondTripId, secondTripId.replace(/_/g, "-")],
      );
      await fix.pool.query(
        "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
        [testId("memb"), secondTripId, fix.userId],
      );
      const secondIssued = await issueEnrollment(fix.pool, fix.userId, secondTripId, {
        enrollmentTtlSeconds: 3600,
      });
      assert.ok(secondIssued.ok);

      const blocked = await startFromDeepLink(fix.pool, "555001200", secondIssued.token);
      assert.equal(blocked.kind, "already_in_interview");

      const state = await fix.pool.query(
        "SELECT state FROM control_plane.interview_enrollments WHERE id = $1",
        [secondIssued.enrollmentId],
      );
      assert.equal(state.rows[0].state, "issued", "the refused link must remain usable");
    });
  });

  test("a group chat cannot start an interview, and the link survives", { skip: SKIP }, async () => {
    // Telegram group ids are negative. An interview holds the organizer's own
    // answers and its enrollment is scoped to one owner, so it must stay in a
    // private DM; a group binds to a companion instead.
    //
    // The refusal has to come BEFORE the enrollment is consumed. interview.ts
    // records a binding only for the private-chat shape, so letting the start
    // through would burn a single-use link on a session no chat could reach.
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, {
        enrollmentTtlSeconds: 3600,
      });
      assert.ok(issued.ok);

      const outcome = await startFromDeepLink(fix.pool, "-1001234567890", issued.token);
      assert.equal(outcome.kind, "rejected");
      assert.equal(outcome.kind === "rejected" && outcome.reason, "NOT_PRIVATE_CHAT");

      const sessions = await fix.pool.query(
        "SELECT id FROM control_plane.intake_sessions WHERE trip_id = $1",
        [fix.tripId],
      );
      assert.equal(sessions.rowCount, 0, "no session may be created for a group chat");

      const state = await fix.pool.query(
        "SELECT state FROM control_plane.interview_enrollments WHERE id = $1",
        [issued.enrollmentId],
      );
      assert.equal(state.rows[0].state, "issued", "the link must still work in a DM");

      assert.deepEqual(await resolveChatRoute(fix.pool, "-1001234567890"), { kind: "unbound" });

      // And it really does still work, in the DM it was meant for.
      const inDm = await startFromDeepLink(fix.pool, "555001300", issued.token);
      assert.equal(inDm.kind, "started");
    });
  });
});
