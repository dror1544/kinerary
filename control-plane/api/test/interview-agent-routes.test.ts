/**
 * The HTTP surface of the interviewer agent's write path.
 *
 * `interview-agent-turn.test.ts` covers the turn gate by calling
 * `submitAnswerForAgent`/`getSessionForAgent` directly. That leaves the two
 * routes in front of them — and the dependency block that mounts them —
 * untested, which is exactly how the whole path shipped unreachable: the
 * block is optional, `server.ts` never constructed one, and both routes
 * answered 503 in every real deployment while the direct-call tests stayed
 * green.
 *
 * So the first test here is the one that would have caught it: absent the
 * dependency, these routes 503, and that is a state a deployment must never
 * be in silently.
 *
 * Every case seeds TWO chats mid-interview, for the same reason the turn
 * tests and the two-trip matrix do: a single-chat test passes just as
 * happily against code that ignores the chat id.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
// `claimDueRouterPrompts(pool, 10, 0)` throughout: these are about the HANDOFF
// — a write leaves a prompt owing, claimed exactly once, only for the chat
// written to. The settle window that debounces a burst of writes is a
// separate property, tested in interview.test.ts, and waiting three seconds
// in each of these would only make them slow.
import { openAgentTurn, resolveChatFromOpenTurn, claimDueRouterPrompts, submitAnswerForAgent } from "../src/interview.js";
import { buildApp, type InterviewAgentDependencies } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const API_KEY = "test-interview-agent-key";

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

const testProfile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
});

interface Chat {
  chatId: string;
  sessionId: string;
  tripId: string;
}

/**
 * A live interview started the way the router really starts one — an
 * enrollment exchanged through a /start deep link — so the 0028 binding every
 * chat-addressed lookup depends on actually exists.
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

interface Fixture {
  pool: pg.Pool;
  a: Chat;
  b: Chat;
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
    const a = await seedInterview(pool, "820000001");
    const b = await seedInterview(pool, "820000002");
    await fn({ pool, a, b });
  } finally {
    await pool.end();
  }
}

/** The first question is a choice, so a tap-shaped answer is always valid. */
const Q = "trip_type";
const OPTION = "family";

describe("interviewer agent routes", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("without the dependency block both routes are unreachable, not open", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      // No `interviewAgent` — the state every real deployment was in.
      const app = buildApp(testProfile, {});
      try {
        const get = await app.inject({
          method: "GET",
          url: `/internal/interview/agent/${a.chatId}`,
          headers: { "x-api-key": API_KEY },
        });
        assert.equal(get.statusCode, 503);
        assert.equal(JSON.parse(get.body).error, "INTERVIEW_AGENT_NOT_CONFIGURED");

        const post = await app.inject({
          method: "POST",
          url: `/internal/interview/agent/${a.chatId}/answer`,
          headers: { "x-api-key": API_KEY },
          payload: { questionId: Q, optionId: OPTION },
        });
        assert.equal(post.statusCode, 503);
        assert.equal(JSON.parse(post.body).error, "INTERVIEW_AGENT_NOT_CONFIGURED");
      } finally {
        await app.close();
      }
    });
  });

  test("the session view is served for a chat with an open turn", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      const interviewAgent: InterviewAgentDependencies = { db: pool, apiKey: API_KEY };
      const app = buildApp(testProfile, { interviewAgent });
      try {
        const res = await app.inject({
          method: "GET",
          url: `/internal/interview/agent/${a.chatId}`,
          headers: { "x-api-key": API_KEY },
        });
        assert.equal(res.statusCode, 200);
        const view = JSON.parse(res.body);
        assert.equal(view.state, "interviewing");
      } finally {
        await app.close();
      }
    });
  });

  test("a chat with no open turn gets 404, not another chat's interview", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      // A holds the only open turn. B is mid-interview and perfectly
      // resolvable by chat — what it lacks is a turn.
      await openAgentTurn(pool, a.chatId, a.sessionId);
      const interviewAgent: InterviewAgentDependencies = { db: pool, apiKey: API_KEY };
      const app = buildApp(testProfile, { interviewAgent });
      try {
        const res = await app.inject({
          method: "GET",
          url: `/internal/interview/agent/${b.chatId}`,
          headers: { "x-api-key": API_KEY },
        });
        assert.equal(res.statusCode, 404);
      } finally {
        await app.close();
      }
    });
  });

  describe("addressing the interview without a chat id", () => {
    // The agent cannot name its own chat: the gateway never renders the chat
    // id into the prompt. These routes exist so it does not have to.

    test("resolves the one chat whose turn is open", async () => {
      await withTwoInterviews(async ({ pool, a }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        const resolved = await resolveChatFromOpenTurn(pool);
        assert.equal(resolved.ok, true);
        assert.equal(resolved.ok === true && resolved.chatId, a.chatId);
      });
    });

    test("REFUSES when two chats have turns open, rather than guessing", async () => {
      // Picking the newest here would write one organizer's answer into the
      // other organizer's trip.
      await withTwoInterviews(async ({ pool, a, b }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        await openAgentTurn(pool, b.chatId, b.sessionId);
        const resolved = await resolveChatFromOpenTurn(pool);
        assert.equal(resolved.ok, false);
        assert.equal(resolved.ok === false && resolved.reason, "AMBIGUOUS");
      });
    });

    test("finds nothing when no turn is open", async () => {
      await withTwoInterviews(async ({ pool }) => {
        const resolved = await resolveChatFromOpenTurn(pool);
        assert.equal(resolved.ok, false);
        assert.equal(resolved.ok === false && resolved.reason, "NOT_FOUND");
      });
    });

    test("GET /current serves that chat's session view", async () => {
      await withTwoInterviews(async ({ pool, a }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        const app = buildApp(testProfile, { interviewAgent: { db: pool, apiKey: API_KEY } });
        try {
          const res = await app.inject({
            method: "GET", url: "/internal/interview/agent/current",
            headers: { "x-api-key": API_KEY },
          });
          assert.equal(res.statusCode, 200);
          assert.equal(JSON.parse(res.body).sessionId, a.sessionId);
        } finally { await app.close(); }
      });
    });

    test("POST /current/answer lands in that chat's session and no other", async () => {
      await withTwoInterviews(async ({ pool, a, b }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        const app = buildApp(testProfile, { interviewAgent: { db: pool, apiKey: API_KEY } });
        try {
          const res = await app.inject({
            method: "POST", url: "/internal/interview/agent/current/answer",
            headers: { "x-api-key": API_KEY },
            payload: { questionId: Q, optionId: OPTION },
          });
          assert.equal(res.statusCode, 200);
          const rows = await pool.query<{ id: string; answers: Record<string, unknown> }>(
            "SELECT id, answers FROM control_plane.intake_sessions WHERE id = ANY($1)",
            [[a.sessionId, b.sessionId]],
          );
          const byId = new Map(rows.rows.map((r) => [r.id, r.answers]));
          assert.ok(byId.get(a.sessionId)![Q], "recorded on the chat with the open turn");
          assert.equal(byId.get(b.sessionId)![Q], undefined, "the other chat is untouched");
        } finally { await app.close(); }
      });
    });

    test("two open turns give 409, and neither interview is written to", async () => {
      await withTwoInterviews(async ({ pool, a, b }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        await openAgentTurn(pool, b.chatId, b.sessionId);
        const app = buildApp(testProfile, { interviewAgent: { db: pool, apiKey: API_KEY } });
        try {
          const res = await app.inject({
            method: "POST", url: "/internal/interview/agent/current/answer",
            headers: { "x-api-key": API_KEY },
            payload: { questionId: Q, optionId: OPTION },
          });
          assert.equal(res.statusCode, 409);
          assert.equal(JSON.parse(res.body).error, "AMBIGUOUS");
          const rows = await pool.query<{ answers: Record<string, unknown> }>(
            "SELECT answers FROM control_plane.intake_sessions WHERE id = ANY($1)",
            [[a.sessionId, b.sessionId]],
          );
          for (const r of rows.rows) assert.equal(r.answers[Q], undefined, "nothing written");
        } finally { await app.close(); }
      });
    });

    test("/current is auth-gated and unmounted without the block", async () => {
      await withTwoInterviews(async ({ pool, a }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        const noDeps = buildApp(testProfile, {});
        try {
          const r = await noDeps.inject({ method: "GET", url: "/internal/interview/agent/current", headers: { "x-api-key": API_KEY } });
          assert.equal(r.statusCode, 503);
        } finally { await noDeps.close(); }
        const app = buildApp(testProfile, { interviewAgent: { db: pool, apiKey: API_KEY } });
        try {
          const r = await app.inject({ method: "GET", url: "/internal/interview/agent/current", headers: { "x-api-key": "wrong" } });
          assert.equal(r.statusCode, 401);
        } finally { await app.close(); }
      });
    });
  });

  describe("handing the turn back to the router", () => {
    // The agent records the answer; only the router can draw the next
    // question's buttons. Before this handoff existed, the first TYPED answer
    // ended the tap flow for the rest of the interview, and a completed
    // interview had no Confirm button at all — where a real organizer stopped
    // on 2026-09-03.

    test("an agent write leaves a prompt owing to that chat", async () => {
      await withTwoInterviews(async ({ pool, a }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        assert.deepEqual(await claimDueRouterPrompts(pool, 10, 0), [], "nothing owed before the write");

        const written = await submitAnswerForAgent(pool, a.chatId, Q, OPTION);
        assert.equal(written.ok, true);

        const due = await claimDueRouterPrompts(pool, 10, 0);
        assert.equal(due.length, 1);
        assert.equal(due[0]!.chatId, a.chatId);
        assert.equal(due[0]!.sessionId, a.sessionId);
      });
    });

    test("a prompt is claimed exactly once", async () => {
      // Two poll ticks overlapping must not both send the same question.
      await withTwoInterviews(async ({ pool, a }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        await submitAnswerForAgent(pool, a.chatId, Q, OPTION);

        const first = await claimDueRouterPrompts(pool, 10, 0);
        const second = await claimDueRouterPrompts(pool, 10, 0);
        assert.equal(first.length, 1);
        assert.deepEqual(second, [], "a second claim finds nothing");
      });
    });

    test("only the chat that was written to is owed a prompt", async () => {
      await withTwoInterviews(async ({ pool, a, b }) => {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        await submitAnswerForAgent(pool, a.chatId, Q, OPTION);
        const due = await claimDueRouterPrompts(pool, 10, 0);
        assert.equal(due.length, 1);
        assert.notEqual(due[0]!.chatId, b.chatId);
      });
    });

    test("a refused agent write owes nothing", async () => {
      // No turn open, so the write fails — the router must not then ask a
      // question as though something had been recorded.
      await withTwoInterviews(async ({ pool, a }) => {
        const written = await submitAnswerForAgent(pool, a.chatId, Q, OPTION);
        assert.equal(written.ok, false);
        assert.deepEqual(await claimDueRouterPrompts(pool, 10, 0), []);
      });
    });
  });

  test("a wrong key is refused even with a turn open", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      const interviewAgent: InterviewAgentDependencies = { db: pool, apiKey: API_KEY };
      const app = buildApp(testProfile, { interviewAgent });
      try {
        for (const headers of [{ "x-api-key": "wrong-key" }, {}]) {
          const res = await app.inject({
            method: "POST",
            url: `/internal/interview/agent/${a.chatId}/answer`,
            headers,
            payload: { questionId: Q, optionId: OPTION },
          });
          assert.equal(res.statusCode, 401);
        }
        // and nothing was written
        const row = await pool.query<{ answers: Record<string, unknown> }>(
          "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
          [a.sessionId],
        );
        assert.equal(row.rows[0]!.answers[Q], undefined);
      } finally {
        await app.close();
      }
    });
  });

  test("an answer posted for an open turn lands in that chat's session", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      const interviewAgent: InterviewAgentDependencies = { db: pool, apiKey: API_KEY };
      const app = buildApp(testProfile, { interviewAgent });
      try {
        const res = await app.inject({
          method: "POST",
          url: `/internal/interview/agent/${a.chatId}/answer`,
          headers: { "x-api-key": API_KEY },
          payload: { questionId: Q, optionId: OPTION },
        });
        assert.equal(res.statusCode, 200);

        const rows = await pool.query<{ id: string; answers: Record<string, unknown> }>(
          "SELECT id, answers FROM control_plane.intake_sessions WHERE id = ANY($1)",
          [[a.sessionId, b.sessionId]],
        );
        const byId = new Map(rows.rows.map((r) => [r.id, r.answers]));
        assert.ok(byId.get(a.sessionId)![Q], "the answer is stored on A's session");
        assert.equal(byId.get(b.sessionId)![Q], undefined, "B's session is untouched");
      } finally {
        await app.close();
      }
    });
  });

  test("a turn open for one chat does not admit a write naming the other", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      const interviewAgent: InterviewAgentDependencies = { db: pool, apiKey: API_KEY };
      const app = buildApp(testProfile, { interviewAgent });
      try {
        const res = await app.inject({
          method: "POST",
          url: `/internal/interview/agent/${b.chatId}/answer`,
          headers: { "x-api-key": API_KEY },
          payload: { questionId: Q, optionId: OPTION },
        });
        assert.equal(res.statusCode, 404);

        const row = await pool.query<{ answers: Record<string, unknown> }>(
          "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
          [b.sessionId],
        );
        assert.equal(row.rows[0]!.answers[Q], undefined, "B's session is untouched");
      } finally {
        await app.close();
      }
    });
  });
});
