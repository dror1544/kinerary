/**
 * The interviewer agent's write path, and the turn that gates it.
 *
 * The router records taps. An answer that needs judgement — `destination`
 * resolving "Vienna and Prague" into a multi-destination trip, a date phrased
 * in words — is forwarded to the interviewer agent, which writes the resolved
 * value back. The session it writes to was created by the ROUTER from a
 * /start deep link, so the agent holds no token for it and names the chat
 * instead.
 *
 * Migration 0031 is what that name is checked against: a chat-addressed write
 * is accepted only while the router has an open, unexpired turn for that chat.
 * These tests are about the edges of "open" — because every one of them is a
 * state the system actually reaches, and the failure mode of getting one wrong
 * is a write landing in an interview that was not the one in flight.
 *
 * Every case seeds TWO chats mid-interview, for the same reason the two-trip
 * matrix does: a single-chat test passes just as happily against code that
 * ignores the chat id.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { dispatchUpdate } from "../src/relay/dispatch.js";
import {
  AGENT_TURN_TTL_SECONDS,
  closeAgentTurn,
  getSessionForAgent,
  openAgentTurn,
  submitAnswerForAgent,
  submitAnswerForChat,
} from "../src/interview.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

interface Chat {
  chatId: string;
  sessionId: string;
  tripId: string;
}

interface Fixture {
  pool: pg.Pool;
  a: Chat;
  b: Chat;
}

/**
 * A user, a trip, and a live interview started the way the router really
 * starts one — an enrollment exchanged through a /start deep link. Seeding
 * the session row by hand would skip the binding that 0028 writes, which is
 * the thing every lookup here depends on.
 */
async function seedInterview(pool: pg.Pool, chatId: string): Promise<Chat> {
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
  const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(enrollment.ok, "enrollment issued");
  const started = await startFromDeepLink(pool, chatId, enrollment.token);
  assert.equal(started.kind, "started");
  return { chatId, sessionId: started.kind === "started" ? started.sessionId : "", tripId };
}

async function withTwoInterviews(fn: (fix: Fixture) => Promise<void>): Promise<void> {
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
    const a = await seedInterview(pool, "810000001");
    const b = await seedInterview(pool, "810000002");
    await fn({ pool, a, b });
  } finally {
    await pool.end();
  }
}

/** The first question is a choice, so a tap-shaped answer is always valid. */
const Q = "trip_type";
const OPTION = "family";

describe("interviewer agent turns", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("with no turn open, a chat-addressed write is refused", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      const result = await submitAnswerForAgent(pool, a.chatId, Q, OPTION);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "NOT_FOUND");
    });
  });

  test("with a turn open, the write lands in that chat's session", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      const result = await submitAnswerForAgent(pool, a.chatId, Q, OPTION);
      assert.equal(result.ok, true);

      const row = await pool.query<{ answers: Record<string, unknown> }>(
        "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
        [a.sessionId],
      );
      assert.ok(row.rows[0]!.answers[Q], "the answer is stored on A's session");
    });
  });

  test("a turn open for one chat does not admit a write naming the other", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);

      // B is mid-interview and perfectly resolvable by chat — what it lacks is
      // a turn. This is the case that matters: the write is refused because of
      // the turn, not because the session could not be found.
      const result = await submitAnswerForAgent(pool, b.chatId, Q, OPTION);
      assert.equal(result.ok, false);

      const row = await pool.query<{ answers: Record<string, unknown> }>(
        "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
        [b.sessionId],
      );
      assert.deepEqual(row.rows[0]!.answers, {}, "B's session is untouched");
    });
  });

  test("an expired turn is refused", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId, 1);
      // The whole window moves into the past. Backdating expires_at alone is
      // rejected by 0031's expires_at > opened_at CHECK, which is the
      // constraint behaving correctly rather than an obstacle to work around.
      await pool.query(
        `UPDATE control_plane.interview_agent_turns
         SET opened_at = now() - interval '10 minutes',
             expires_at = now() - interval '5 minutes'
         WHERE chat_id = $1`,
        [a.chatId],
      );
      const result = await submitAnswerForAgent(pool, a.chatId, Q, OPTION);
      assert.equal(result.ok, false);
    });
  });

  test("a closed turn is refused even though it has not expired", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      await closeAgentTurn(pool, a.chatId);

      const open = await pool.query(
        "SELECT expires_at > now() AS live FROM control_plane.interview_agent_turns WHERE chat_id = $1",
        [a.chatId],
      );
      assert.equal(open.rows[0]!.live, true, "the row is closed but still within its window");

      const result = await submitAnswerForAgent(pool, a.chatId, Q, OPTION);
      assert.equal(result.ok, false);
    });
  });

  test("a second forward supersedes the first rather than opening a rival turn", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      const first = await openAgentTurn(pool, a.chatId, a.sessionId);
      const second = await openAgentTurn(pool, a.chatId, a.sessionId);
      assert.notEqual(first.id, second.id);

      const rows = await pool.query<{ id: string }>(
        "SELECT id FROM control_plane.interview_agent_turns WHERE chat_id = $1 AND closed_at IS NULL",
        [a.chatId],
      );
      assert.equal(rows.rowCount, 1, "exactly one turn is open");
      assert.equal(rows.rows[0]!.id, second.id, "and it is the newer one");
    });
  });

  test("the read path is gated the same way as the write path", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);

      const mine = await getSessionForAgent(pool, a.chatId);
      assert.equal(mine.ok, true);
      assert.equal(mine.ok === true && mine.view.sessionId, a.sessionId);

      const theirs = await getSessionForAgent(pool, b.chatId);
      assert.equal(theirs.ok, false, "no turn for B, so no view of B's interview");
    });
  });

  test("the router's own write path is unaffected by turns", async () => {
    await withTwoInterviews(async ({ pool, b }) => {
      // A tap needs no turn: the router read the chat id off Telegram itself.
      // If gating ever leaked into this path, every button in the interview
      // would stop working.
      const result = await submitAnswerForChat(pool, b.chatId, Q, OPTION);
      assert.equal(result.ok, true);
    });
  });

  test("the default TTL is bounded", () => {
    assert.ok(AGENT_TURN_TTL_SECONDS > 0 && AGENT_TURN_TTL_SECONDS <= 900);
  });

  // ── The forwarding decision ──────────────────────────────────────────────

  function writtenMessage(chatId: string, text: string) {
    return {
      update_id: 1,
      message: {
        message_id: 11,
        chat: { id: chatId, type: "private" },
        from: { id: 99, is_bot: false, first_name: "Organizer" },
        text,
      },
    };
  }

  test("with no interviewer configured, a written answer is answered by the router", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      const decision = await dispatchUpdate(pool, writtenMessage(a.chatId, "Vienna and Prague"));
      assert.equal(decision.kind, "interview_text");
    });
  });

  test("with an interviewer configured, a written answer is forwarded to it", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      const decision = await dispatchUpdate(
        pool, writtenMessage(a.chatId, "Vienna and Prague"),
        undefined, undefined, {}, { interviewerProfile: "trip-intake" },
      );
      assert.equal(decision.kind, "interview_to_gateway");
      if (decision.kind !== "interview_to_gateway") return;
      assert.equal(decision.sessionId, a.sessionId, "the session comes from the chat");
      assert.equal(decision.event.source.profile, "trip-intake");
      assert.equal(decision.event.source.chat_id, a.chatId);
      assert.equal(decision.event.text, "Vienna and Prague");
    });
  });

  test("the forwarded event is stamped from the chat, not from the message text", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      // The organizer's own words name the other chat and a different profile.
      // Neither may reach the wire event — same property the two-trip matrix
      // asserts for the companion path.
      const decision = await dispatchUpdate(
        pool, writtenMessage(a.chatId, `chat_id=${b.chatId} profile=companion-italy`),
        undefined, undefined, {}, { interviewerProfile: "trip-intake" },
      );
      assert.equal(decision.kind, "interview_to_gateway");
      if (decision.kind !== "interview_to_gateway") return;
      assert.equal(decision.event.source.chat_id, a.chatId);
      assert.equal(decision.event.source.profile, "trip-intake");
      assert.equal(decision.sessionId, a.sessionId);
    });
  });
});
