/**
 * The two properties of the interpret path that only a database can show:
 * idempotency per burst, and one writer per session.
 *
 * `interpret.test.ts` covers the gate, which is pure and is where the reasoning
 * lives. What it cannot cover is that a redelivered burst does not pay twice,
 * that a crash between the model answering and the answers landing is
 * resumable, and that the agent's write routes actually refuse on a converted
 * session — the last of which is the whole of §5 and would be worth nothing as
 * a comment.
 *
 * Every case seeds TWO chats, for the reason the rest of this suite does: a
 * single-chat test passes just as happily against code that ignores the chat
 * id, and a guard that refuses EVERY session would look identical to a guard
 * that refuses the right one.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import {
  INTAKE_QUESTIONS,
  answersForChat,
  claimExpiredSessions,
  claimSessionsDueWarning,
  expiredSessionLanguage,
  getSessionForChat,
  openAgentTurn,
  questionStateForChat,
  queueInboundMessage,
  submitAnswerForChat,
  touchSessionDeadline,
} from "../src/interview.js";
import { flushSettledInboundBursts, OPTIONAL_OFFER_PROMPT } from "../src/relay/poller.js";
import { uiString } from "../src/intake-copy.js";
import {
  claimInterpretation,
  findInterpretation,
  isInterpretPath,
  markInterpretationCommitted,
  recordInterpretationResult,
  setInterpretPath,
  storedOutcomes,
  type ProposedAnswer,
} from "../src/interpret.js";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
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

async function seedInterview(pool: pg.Pool, chatId: string): Promise<Chat> {
  const userId = testId("user");
  const tripId = testId("trip");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [
    tripId,
    tripId.replace(/_/g, "-"),
  ]);
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

async function withTwoInterviews(fn: (fix: { pool: pg.Pool; a: Chat; b: Chat }) => Promise<void>): Promise<void> {
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
    const a = await seedInterview(pool, "830000001");
    const b = await seedInterview(pool, "830000002");
    await fn({ pool, a, b });
  } finally {
    await pool.end();
  }
}

const PROPOSAL: ProposedAnswer = {
  questionId: "trip_type",
  value: { kind: "choice", optionId: "family" },
  confidence: 0.92,
  evidence: "family trip",
  sourceMessageId: "101",
};


/**
 * The roster written into a session by the stand-in answers below. A real
 * (one-person) roster rather than text, because the organizer's "x" is settled
 * only by someone on it — otherwise the organizer question, not the one a test
 * is about, would be what the router asks next.
 */
const ROSTER_STAND_IN = { kind: "structured", schema_version: 3, data: [{ name: "x" }] };

describe("interpret path — per-session switch", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("off by default, and switching one session leaves the other alone", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      assert.equal(await isInterpretPath(pool, a.chatId), false);
      assert.equal(await isInterpretPath(pool, b.chatId), false);

      assert.equal(await setInterpretPath(pool, a.chatId, true), true);
      assert.equal(await isInterpretPath(pool, a.chatId), true);
      assert.equal(await isInterpretPath(pool, b.chatId), false);
    });
  });

  test("an unknown chat is not on the path and cannot be switched onto it", async () => {
    await withTwoInterviews(async ({ pool }) => {
      assert.equal(await isInterpretPath(pool, "839999999"), false);
      assert.equal(await setInterpretPath(pool, "839999999", true), false);
    });
  });
});

describe("interpret path — idempotency", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  const burst = { burstKey: "101,102", sourceText: "family trip, four of us" };

  test("the same burst is claimed once; a redelivery finds the first row", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      const first = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      assert.equal(first.fresh, true);

      const second = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      assert.equal(second.fresh, false);
      assert.equal(second.fresh === false && second.row.id, first.fresh === true ? first.id : "");
    });
  });

  test("the same burst key in a different chat is a different burst", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      const inA = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      const inB = await claimInterpretation(pool, { sessionId: b.sessionId, chatId: b.chatId, ...burst });
      assert.equal(inA.fresh, true);
      assert.equal(inB.fresh, true);
    });
  });

  // The crash window: the model answered, the commit did not land. The stored
  // proposals are re-used rather than the model being asked again.
  test("an uncommitted row hands back its proposals to be resumed", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      const claim = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      assert.equal(claim.fresh, true);
      const id = claim.fresh === true ? claim.id : "";
      await recordInterpretationResult(pool, id, { proposals: [PROPOSAL], attempts: 1, durationMs: 1234 });

      const resumed = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      assert.equal(resumed.fresh, false);
      if (resumed.fresh === false) {
        assert.equal(resumed.row.committedAt, null, "not committed — this is the resumable state");
        assert.deepEqual(resumed.row.proposals, [PROPOSAL]);
        assert.equal(resumed.row.attempts, 1);
        assert.equal(resumed.row.durationMs, 1234);
      }
    });
  });

  test("a committed row says so, which is how the caller knows to do nothing", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      const claim = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      const id = claim.fresh === true ? claim.id : "";
      await recordInterpretationResult(pool, id, { proposals: [PROPOSAL], attempts: 1, durationMs: 10 });
      await markInterpretationCommitted(
        pool,
        id,
        storedOutcomes({ accepted: [{ questionId: "trip_type", answer: { kind: "choice", option_id: "family", schema_version: 3, other_text: null }, proposal: PROPOSAL }], rejected: [], askAnyway: [], suggested: [] }, 0),
      );

      const again = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      assert.equal(again.fresh, false);
      assert.ok(again.fresh === false && again.row.committedAt instanceof Date);
      assert.deepEqual(again.fresh === false && again.row.outcomes.accepted, [
        { questionId: "trip_type", confidence: 0.92 },
      ]);
    });
  });

  // A model failure is a recorded outcome, not a gap: the row still exists, so
  // the burst is not re-interpreted on the next tick.
  test("a failed interpretation is recorded with its reason", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      const claim = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      const id = claim.fresh === true ? claim.id : "";
      await recordInterpretationResult(pool, id, { failureReason: "RATE_LIMITED", attempts: 2, durationMs: 900 });
      const row = await findInterpretation(pool, a.chatId, burst.burstKey);
      assert.equal(row?.failureReason, "RATE_LIMITED");
      assert.equal(row?.attempts, 2);
      assert.deepEqual(row?.proposals, []);
    });
  });

  test("interpretations go away with their session", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, ...burst });
      await pool.query("DELETE FROM control_plane.intake_sessions WHERE id = $1", [a.sessionId]);
      assert.equal(await findInterpretation(pool, a.chatId, burst.burstKey), null);
    });
  });
});

describe("one writer per session", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  function appFor(pool: pg.Pool) {
    return buildApp(testProfile, { interviewAgent: { db: pool, apiKey: API_KEY } });
  }

  // Every POST the six MCP write tools forward to. Named individually rather
  // than looped over a prefix, because the thing being asserted is that no
  // route in this group was missed.
  const WRITE_ROUTES = [
    { url: "/internal/interview/agent/current/answer", payload: { questionId: "trip_type", optionId: "family" } },
    { url: "/internal/interview/agent/current/answers", payload: { answers: [{ questionId: "trip_type", optionId: "family" }] } },
    { url: "/internal/interview/agent/current/say", payload: { text: "hello" } },
    { url: "/internal/interview/agent/current/ask", payload: { questionId: "dietary" } },
    { url: "/internal/interview/agent/current/summary", payload: {} },
    { url: "/internal/interview/agent/current/language", payload: { language: "he" } },
  ];

  test("on the interpret path every agent write is refused", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      await setInterpretPath(pool, a.chatId, true);
      const app = appFor(pool);
      try {
        for (const route of WRITE_ROUTES) {
          const res = await app.inject({
            method: "POST",
            url: route.url,
            headers: { "x-api-key": API_KEY },
            payload: route.payload,
          });
          assert.equal(res.statusCode, 409, `${route.url} should refuse`);
          assert.equal(JSON.parse(res.body).error, "SESSION_NOT_AGENT_WRITABLE", route.url);
        }
      } finally {
        await app.close();
      }
    });
  });

  // The refusal must be about THIS session, not about the feature existing.
  test("a session not on the path is unaffected", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await setInterpretPath(pool, a.chatId, true);
      await openAgentTurn(pool, b.chatId, b.sessionId);
      const app = appFor(pool);
      try {
        const res = await app.inject({
          method: "POST",
          url: "/internal/interview/agent/current/answer",
          headers: { "x-api-key": API_KEY },
          payload: { questionId: "trip_type", optionId: "family" },
        });
        assert.notEqual(res.statusCode, 409);
      } finally {
        await app.close();
      }
    });
  });

  // Reading is not writing. An agent still pointed at a converted session
  // should be able to see the state it is refused permission to change.
  test("the read route stays open on the interpret path", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await openAgentTurn(pool, a.chatId, a.sessionId);
      await setInterpretPath(pool, a.chatId, true);
      const app = appFor(pool);
      try {
        const res = await app.inject({
          method: "GET",
          url: "/internal/interview/agent/current",
          headers: { "x-api-key": API_KEY },
        });
        assert.equal(res.statusCode, 200);
      } finally {
        await app.close();
      }
    });
  });

  test("the chat-addressed write route is guarded too, not only /current", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await setInterpretPath(pool, a.chatId, true);
      const app = appFor(pool);
      try {
        await openAgentTurn(pool, a.chatId, a.sessionId);
        const refused = await app.inject({
          method: "POST",
          url: `/internal/interview/agent/${a.chatId}/answer`,
          headers: { "x-api-key": API_KEY },
          payload: { questionId: "trip_type", optionId: "family" },
        });
        assert.equal(refused.statusCode, 409);

        await openAgentTurn(pool, b.chatId, b.sessionId);
        const allowed = await app.inject({
          method: "POST",
          url: `/internal/interview/agent/${b.chatId}/answer`,
          headers: { "x-api-key": API_KEY },
          payload: { questionId: "trip_type", optionId: "family" },
        });
        assert.notEqual(allowed.statusCode, 409);
      } finally {
        await app.close();
      }
    });
  });

  // The router's own write path is what the interpret path uses to record an
  // accepted proposal, so it must NOT be caught by the guard.
  test("the router can still write to a session on the interpret path", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      const before = await questionStateForChat(pool, a.chatId);
      assert.ok(before?.outstanding.includes("trip_type"));

      const written = await submitAnswerForChat(pool, a.chatId, "trip_type", "family");
      assert.equal(written.ok, true);

      const after = await questionStateForChat(pool, a.chatId);
      assert.ok(after?.answered.includes("trip_type"));
      assert.equal(after?.outstanding.includes("trip_type"), false);
    });
  });
});

/**
 * An interview that can end.
 *
 * Nothing in `intake_sessions` used to expire: someone who opened a link,
 * answered two questions and put their phone down left a session sitting open
 * and writable indefinitely. Three events now exist — a warning, a close, and
 * an answer for whoever writes afterwards — and each has to happen exactly once.
 */
describe("interview session expiry", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  /** Drags a session's deadline into the past, or into the warning window. */
  async function setDeadline(pool: pg.Pool, chatId: string, sql: string) {
    await pool.query(
      `UPDATE control_plane.intake_sessions SET expires_at = ${sql} WHERE telegram_chat_id = $1`,
      [chatId],
    );
  }

  test("a live conversation never expires under the person having it", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setDeadline(pool, a.chatId, "now() + interval '30 seconds'");
      await touchSessionDeadline(pool, a.chatId, 3600);
      assert.deepEqual(await claimExpiredSessions(pool), [], "writing pushed the deadline out");
      assert.deepEqual(await claimSessionsDueWarning(pool, 10, 600), [], "and out of the warning window");
    });
  });

  test("the warning fires once, not on every tick", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await setDeadline(pool, a.chatId, "now() + interval '5 minutes'");
      await setDeadline(pool, b.chatId, "now() + interval '5 hours'");

      const first = await claimSessionsDueWarning(pool, 10, 600);
      assert.deepEqual(first.map((s) => s.chatId), [a.chatId], "only the one inside the window");
      assert.deepEqual(await claimSessionsDueWarning(pool, 10, 600), [], "claimed, so not again");
    });
  });

  test("writing after a warning earns a fresh one next time", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setDeadline(pool, a.chatId, "now() + interval '5 minutes'");
      assert.equal((await claimSessionsDueWarning(pool, 10, 600)).length, 1);

      await touchSessionDeadline(pool, a.chatId, 3600);
      await setDeadline(pool, a.chatId, "now() + interval '5 minutes'");
      assert.equal((await claimSessionsDueWarning(pool, 10, 600)).length, 1, "the warning was reset by writing");
    });
  });

  test("expiry claims once, and carries the interview's own language", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await pool.query("UPDATE control_plane.intake_sessions SET language='he' WHERE telegram_chat_id=$1", [a.chatId]);
      await setDeadline(pool, a.chatId, "now() - interval '1 minute'");
      await setDeadline(pool, b.chatId, "now() + interval '5 hours'");

      const expired = await claimExpiredSessions(pool);
      assert.deepEqual(expired.map((s) => s.chatId), [a.chatId]);
      assert.equal(expired[0]?.language, "he", "telling someone in English that their Hebrew interview closed is its own insult");
      assert.deepEqual(await claimExpiredSessions(pool), [], "claimed, so not again");
    });
  });

  test("an expired session answers for its chat — but only while nothing is live", async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await setDeadline(pool, a.chatId, "now() - interval '1 minute'");
      await claimExpiredSessions(pool);

      assert.equal(await expiredSessionLanguage(pool, a.chatId), "en");
      assert.equal(await expiredSessionLanguage(pool, b.chatId), null, "a live session is not expired");
    });
  });

  // Getting this wrong locks people out permanently, which is worse than the
  // bug it fixes: a new deep link leaves the expired session in place, so a
  // naive "is there an expired session here" would refuse every message of the
  // replacement interview forever.
  test("a replacement interview on the same chat is not refused", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setDeadline(pool, a.chatId, "now() - interval '1 minute'");
      await claimExpiredSessions(pool);
      assert.equal(await expiredSessionLanguage(pool, a.chatId), "en", "closed, as expected");

      // A fresh link: a new session on the same chat, expired one left alone.
      await seedInterview(pool, a.chatId);
      assert.equal(await expiredSessionLanguage(pool, a.chatId), null, "the new interview speaks for the chat now");
    });
  });

  test("a confirmed interview is never warned or expired", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await pool.query("UPDATE control_plane.intake_sessions SET state='confirmed' WHERE telegram_chat_id=$1", [a.chatId]);
      await setDeadline(pool, a.chatId, "now() - interval '1 hour'");
      assert.deepEqual(await claimExpiredSessions(pool), []);
      assert.deepEqual(await claimSessionsDueWarning(pool, 10, 600), []);
    });
  });
});

/**
 * The silence, and the two rules that combine to produce it.
 *
 * A reply that answers nothing leaves the router wanting the question it just
 * asked, and "never send the same message twice" then sends nothing at all.
 * Found live on 2026-09-08 on the first real run: three answers recorded
 * perfectly, a message about a document, then `prompt_deduped q:departure_date`
 * as the last line in the log. The organizer spoke and got nothing back.
 *
 * The runner here proposes nothing, because "the model found no answer" IS the
 * condition — reproducing it needs no live model.
 */
const emptyRunner = {
  async run() {
    return { ok: true as const, value: { proposals: [], unclear: [], malformed: 0 }, attempts: 1, ms: 1 };
  },
};

class Recorder {
  readonly sent: { text: string; buttons: number }[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: unknown[][] } }) {
    this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat().length });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

let seq = 0;
/** One typed message, flushed through the real burst path. */
async function say(
  pool: pg.Pool,
  chatId: string,
  text: string,
  telegram: Recorder,
  modelRunner: unknown = emptyRunner,
) {
  seq += 1;
  await queueInboundMessage(pool, chatId, { text, message_id: `m${seq}` } as never);
  await flushSettledInboundBursts(
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner } as never,
    () => {},
    0,
  );
}

describe("a reply that answers nothing", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("answering the boundary in words gets an answer, not silence", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      // Everything required answered AND every optional one skipped — the only
      // way `nextQuestion` is genuinely null, which is what makes this the
      // boundary rather than a question still waiting.
      for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
        await pool.query(
          `UPDATE control_plane.intake_sessions
              SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
            WHERE telegram_chat_id = $1`,
          [a.chatId, q.id, JSON.stringify(q.id === "travelers" ? ROSTER_STAND_IN : { kind: "text", schema_version: 3, text: "x" })],
        );
      }
      const optionalIds = INTAKE_QUESTIONS.filter((x) => !x.required).map((x) => x.id);
      // The exact shape read off the stalled live session on 2026-09-10: the
      // boundary offer already shown, nothing left on screen, router holding
      // the turn.
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET language = 'he', state = 'awaiting_confirmation', awaiting = 'machine',
                phase = 'optional',
                ui_state = jsonb_build_object(
                  'offered_more', true,
                  'last_prompt', 'q:planning_help',
                  'skipped', $2::jsonb)
          WHERE telegram_chat_id = $1`,
        [a.chatId, JSON.stringify(optionalIds)],
      );
      const telegram = new Recorder();

      // "לא" — no, don't add more. It answers the OFFER, not any question in
      // the schema, so interpret proposes nothing and nothing is owed by the
      // ordinary rules. Live, that produced total silence until the session
      // expired.
      await say(pool, a.chatId, "לא", telegram);

      assert.ok(telegram.sent.length > 0, "the interview must not go silent on a person");
      const reply = telegram.sent[telegram.sent.length - 1]!;
      assert.ok(
        reply.text.includes(uiString("didNotFollow", "he")),
        "it says it did not follow, in the interview's own language",
      );
      assert.ok(
        reply.text.includes(uiString("essentialsDone", "he")),
        "and restates what it is actually waiting for",
      );
      assert.ok(reply.buttons >= 2, "with both exits tappable for someone whose words it cannot parse");
    });
  });

  test("the boundary is said where it is — above the first optional question, not after the last one", async () => {
    // 2026-09-16, live: "זה כל מה שבאמת צריך — מכאן זה רשות…" arrived as the LAST
    // message before the summary, after every optional question had been asked,
    // and both its buttons led to the summary. On this path the router walks the
    // optional questions itself, and the announcement only went out once there
    // was nothing left to walk.
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
        await pool.query(
          `UPDATE control_plane.intake_sessions
              SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
            WHERE telegram_chat_id = $1`,
          [a.chatId, q.id, JSON.stringify(q.id === "travelers" ? ROSTER_STAND_IN : { kind: "text", schema_version: 3, text: "x" })],
        );
      }
      // The moment the last required answer lands: the optional phase entered,
      // its entry not yet announced, the machine owing the next message.
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET language = 'he', state = 'interviewing', awaiting = 'machine', phase = 'optional',
                ui_state = jsonb_build_object('pending_entry', 'optional')
          WHERE telegram_chat_id = $1`,
        [a.chatId],
      );
      const { advanceRouterOwnedQuestions } = await import("../src/relay/poller.js");
      const { DEFAULT_STRINGS } = await import("../src/relay/dispatch.js");
      const telegram = new Recorder();
      const deps = { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: emptyRunner } as never;

      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});

      assert.equal(telegram.sent.length, 1, `one message — sent: ${JSON.stringify(telegram.sent)}`);
      const first = telegram.sent[0]!;
      // The boundary is its own message and asks nothing yet: the choice on
      // screen is whether to have the optional questions at all. Folded above
      // the first one, the only buttons were that question's — "Skip this one"
      // and "Finished" — so the answer to "do you want more?" had to be given
      // by a button claiming the interview was over (Dror, 2026-09-18).
      assert.equal(first.text, uiString("essentialsDone", "he"), `the announcement stands alone — got: ${first.text}`);
      assert.equal(first.buttons, 2, "with its own two choices: a few more questions, or skip");

      const after = await getSessionForChat(pool, a.chatId);
      assert.ok(after.ok);
      assert.equal(after.view.offeredMore, true, "said once");
      assert.equal(after.view.pendingEntry, null);

      assert.equal(after.view.lastPrompt, OPTIONAL_OFFER_PROMPT, "and recorded, so everything else can see it");

      // AND NOTHING FOLLOWS IT. Live on 2026-09-18 the offer and the first
      // optional question arrived together — "the optional question came and
      // immediately followed by another without waiting my response" — because
      // the walk reads `offeredMore`, which the offer itself had just set. A
      // choice nothing waits for is not a choice.
      await pool.query(
        "UPDATE control_plane.intake_sessions SET awaiting = 'machine' WHERE telegram_chat_id = $1",
        [a.chatId],
      );
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(
        telegram.sent.length, 1,
        `still just the offer — sent: ${JSON.stringify(telegram.sent)}`,
      );
      const waiting = await getSessionForChat(pool, a.chatId);
      assert.ok(waiting.ok);
      assert.equal(waiting.view.awaiting, "person", "and the turn is theirs, not a session owing a message");

      // "A few more questions" is what produces one: the offer asks nothing by
      // itself, and either button is an answer to it.
      const { askForMoreForChat } = await import("../src/interview.js");
      const more = await askForMoreForChat(pool, a.chatId);
      assert.ok(more.ok);
      await pool.query(
        "UPDATE control_plane.intake_sessions SET awaiting = 'machine' WHERE telegram_chat_id = $1",
        [a.chatId],
      );
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(telegram.sent.length, 2, "asking for more asks a question");
      assert.ok(
        !telegram.sent[1]!.text.includes(uiString("essentialsDone", "he")),
        "a question, not the offer again",
      );

      // And from there the walk runs on its own again: the offer is answered,
      // so the next optional question needs no second tap.
      const asked = await getSessionForChat(pool, a.chatId);
      assert.ok(asked.ok);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET awaiting = 'machine', ui_state = ui_state || jsonb_build_object('skipped', jsonb_build_array($2::text))
          WHERE telegram_chat_id = $1`,
        [a.chatId, asked.view.optionalRemaining[0]!.id],
      );
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(telegram.sent.length, 3, `the walk carries on — sent: ${JSON.stringify(telegram.sent)}`);
    });
  });

  test("what is on screen is recorded before it is sent, so a racing pass cannot send it twice", async () => {
    // 2026-09-18, live: "I had some duplication". `trip_interests` and
    // `trip_pace` each went out twice, both pairs straight after a `floor_lost`.
    //
    // The floor arbitrates between two would-be speakers, and it worked — one
    // lost. What went wrong is what the loser did next: a tap's reply retries
    // when it said nothing, and it read `lastPrompt` to decide whether anybody
    // else had. That was recorded AFTER the send, so for the whole Telegram
    // round trip the record said nobody had spoken, and the loser sent the same
    // question again.
    //
    // So the order is the fix, and the order is what this pins: by the time the
    // message is handed to Telegram, the session already says what is on screen.
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET language = 'he', state = 'interviewing', awaiting = 'machine', phase = 'essentials'
          WHERE telegram_chat_id = $1`,
        [a.chatId],
      );
      const { sendNextStep } = await import("../src/relay/poller.js");
      const { DEFAULT_STRINGS } = await import("../src/relay/dispatch.js");

      const promptsAtSendTime: (string | null)[] = [];
      const telegram = new Recorder();
      const watching = Object.assign(Object.create(Object.getPrototypeOf(telegram)), telegram, {
        sendMessage: async (p: { text: string; replyMarkup?: { inline_keyboard: unknown[][] } }) => {
          // What a concurrent pass would read at exactly this moment.
          const mid = await getSessionForChat(pool, a.chatId);
          promptsAtSendTime.push(mid.ok ? mid.view.lastPrompt ?? null : null);
          return telegram.sendMessage(p);
        },
      });
      const deps = { db: pool, telegram: watching, connector: { pushInbound: () => true }, modelRunner: emptyRunner } as never;

      const before = await getSessionForChat(pool, a.chatId);
      assert.ok(before.ok);
      const expected = `q:${before.view.nextQuestion!.id}`;

      assert.equal(await sendNextStep(before.view, a.chatId, deps, DEFAULT_STRINGS), true);
      assert.deepEqual(promptsAtSendTime, [expected], "named while the floor is still ours, not after Telegram answers");

      // And the loser, running on the view it already had, says nothing.
      assert.equal(
        await sendNextStep(before.view, a.chatId, deps, DEFAULT_STRINGS), false,
        "the second pass is deduped, not sent",
      );
      assert.equal(telegram.sent.length, 1, `one message — sent: ${JSON.stringify(telegram.sent)}`);
    });
  });

  test("the interview follows the language the organizer writes in, not the phone's", async () => {
    // 2026-09-15, live: the session took English from the Telegram app, the
    // organizer wrote every answer in Hebrew, and the interview, the site and the
    // companion were all English — nothing on this path ever replaced the hint.
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      await pool.query("UPDATE control_plane.intake_sessions SET language = 'en' WHERE telegram_chat_id = $1", [a.chatId]);
      const telegram = new Recorder();

      await say(pool, a.chatId, "היי, אנחנו נוסעים ליפן", telegram);

      const view = await getSessionForChat(pool, a.chatId);
      assert.equal(view.ok && view.view.language, "he", "the session now records Hebrew");
      const reply = telegram.sent[telegram.sent.length - 1];
      assert.ok(reply && /[\u05d0-\u05ea]/u.test(reply.text), `and the reply is in Hebrew — got: ${reply?.text}`);
    });
  });

  test("a Hebrew interview stays Hebrew when the organizer types a place name", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      await pool.query("UPDATE control_plane.intake_sessions SET language = 'he' WHERE telegram_chat_id = $1", [a.chatId]);

      await say(pool, a.chatId, "Tokyo", new Recorder());

      const view = await getSessionForChat(pool, a.chatId);
      assert.equal(view.ok && view.view.language, "he");
    });
  });

  test("a REQUIRED question steps aside instead of being repeated", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      // Hebrew, because "some of the bot's messages came in English" is a real
      // past failure and a new string is exactly where it would come back.
      await pool.query("UPDATE control_plane.intake_sessions SET language = 'he' WHERE telegram_chat_id = $1", [a.chatId]);
      const telegram = new Recorder();

      await say(pool, a.chatId, "היי", telegram);
      const opening = telegram.sent.length;
      assert.ok(opening > 0, "the router says something to begin with");

      const first = await getSessionForChat(pool, a.chatId);
      const asked = first.ok ? first.view.nextQuestion?.id : null;
      assert.ok(asked, "a required question is on screen");

      // Answer nothing. It must neither go silent NOR repeat the question:
      // repeating produced "עוד צריך את זה: מתי הטיול מתחיל?" after every
      // message about something else, which is nagging.
      await say(pool, a.chatId, "תסתכל במסמך שהעלתי", telegram);

      const after = await getSessionForChat(pool, a.chatId);
      assert.notEqual(after.ok && after.view.nextQuestion?.id, asked, "the interview moved on");
      const repeated = telegram.sent.filter((m) => m.text.includes(uiString("beforeWeFinish", "he")));
      assert.equal(repeated.length, 0, "and did not announce a blocker mid-interview");
    });
  });

  // 2026-09-11, the automated full cycle, verbatim: the stops were read with
  // LOW_CONFIDENCE, so `phases` stepped aside. The last required question was
  // then answered with a TAP (the assistant's tone), and the set-aside question
  // never came back — the router walked on to the optional ones, and "Finished"
  // did nothing at all. The return at the boundary lived only on the typed path.
  async function requiredSetAside(pool: pg.Pool, chatId: string, lastPrompt: string, remaining: string[]) {
    for (const q of INTAKE_QUESTIONS.filter((x) => x.required && !remaining.includes(x.id) && x.id !== "phases")) {
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
          WHERE telegram_chat_id = $1`,
        [chatId, q.id, JSON.stringify(q.id === "travelers" ? ROSTER_STAND_IN : q.type === "choice"
          ? { kind: "choice", option_id: q.options![0]!.id, schema_version: 3, other_text: null }
          : { kind: "text", schema_version: 3, text: "x" })],
      );
    }
    await pool.query(
      `UPDATE control_plane.intake_sessions
          SET language = 'en', awaiting = 'machine', phase = 'essentials',
              ui_state = jsonb_build_object('deferred', '["phases"]'::jsonb, 'last_prompt', $2::text)
        WHERE telegram_chat_id = $1`,
      [chatId, lastPrompt],
    );
  }

  /**
   * Taps a button the way production handles one: the callback, then a delivery
   * tick — a tap hands the floor to the organizer, and what the router says next
   * comes from the tick (see interview-transcript.test.ts `turn`). Returns what
   * the router logged, which is the reason for any silence.
   */
  async function tap(pool: pg.Pool, chat: Chat, data: string, telegram: Recorder): Promise<string> {
    const { applyDecision, renderDueRouterPrompts, advanceRouterOwnedQuestions } = await import("../src/relay/poller.js");
    const { DEFAULT_STRINGS } = await import("../src/relay/dispatch.js");
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    const deps = { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: emptyRunner, log } as never;
    await applyDecision(
      { kind: "interview_callback", chatId: chat.chatId, callbackQueryId: `cq${++seq}`, data, sessionId: chat.sessionId } as never,
      deps,
    );
    await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, log);
    await renderDueRouterPrompts(deps, DEFAULT_STRINGS, log, 0);
    return logs.map((l) => (JSON.parse(l) as { event?: string }).event).join(", ");
  }

  test("a required answer set aside comes back when the last one is answered with a tap", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      await requiredSetAside(pool, a.chatId, "q:bot_tone", ["bot_tone"]);
      const telegram = new Recorder();

      const events = await tap(pool, a, "a:bot_tone:warm", telegram);

      const last = telegram.sent[telegram.sent.length - 1];
      assert.ok(last, `the router says something after the tap (router logged: ${events})`);
      assert.ok(last.text.includes(uiString("beforeWeFinish", "en")),
        `the set-aside question comes back, said as the blocker it is — got: ${last.text}`);
      const view = await getSessionForChat(pool, a.chatId);
      assert.equal(view.ok && view.view.nextQuestion?.id, "phases");
    });
  });

  test("\"Finished\" with a required answer still set aside brings it back — never silence", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      // Every required question answered but the one set aside, and an optional
      // one on screen with its Finished button — the live stall's exact state.
      await requiredSetAside(pool, a.chatId, "q:trip_interests", []);
      const telegram = new Recorder();

      const events = await tap(pool, a, "c:done", telegram);

      assert.ok(telegram.sent.length > 0, `Finished must never be met with silence (router logged: ${events})`);
      const last = telegram.sent[telegram.sent.length - 1]!;
      assert.ok(last.text.includes(uiString("beforeWeFinish", "en")),
        `it says what is still needed — got: ${last.text}`);
    });
  });

  test("re-asking records nothing — it is the same question, not a new answer", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      const telegram = new Recorder();
      await say(pool, a.chatId, "היי", telegram);
      const before = await questionStateForChat(pool, a.chatId);
      await say(pool, a.chatId, "לא קשור", telegram);
      const after = await questionStateForChat(pool, a.chatId);
      assert.deepEqual(after?.answered, before?.answered);
    });
  });

  // The other half of the pacing rule, which the offline run proved first: an
  // OPTIONAL question is passed over rather than re-asked, so nothing loops.
  test("an OPTIONAL question is passed over instead of re-asked", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      const telegram = new Recorder();
      for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
        await pool.query(
          `UPDATE control_plane.intake_sessions
              SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
            WHERE telegram_chat_id = $1`,
          [a.chatId, q.id, JSON.stringify(q.id === "travelers" ? ROSTER_STAND_IN : { kind: "text", schema_version: 3, text: "x" })],
        );
      }
      await say(pool, a.chatId, "היי", telegram);
      const first = await getSessionForChat(pool, a.chatId);
      const asked = first.ok ? first.view.lastPrompt : null;
      if (!asked?.startsWith("q:")) return;

      const optionalId = asked.slice(2);
      await say(pool, a.chatId, "לא משנה", telegram);
      const after = await getSessionForChat(pool, a.chatId);
      assert.equal(
        after.ok && after.view.optionalRemaining.some((q) => q.id === optionalId),
        false,
        "the optional question is behind us, not offered again",
      );
    });
  });
});

/**
 * THE BOUNDARY, ANSWERED IN WORDS.
 *
 * One message offers two ways on — a few more questions, or skip to the
 * summary — and both of them are buttons. Live on 2026-09-10 an organizer
 * answered it with "לא" and was told the bot did not quite follow, under the
 * same offer again. They had followed it exactly. They had just not tapped.
 *
 * Dror, 2026-09-18, on rejecting "show the buttons harder" as the fix:
 * "Every action offered as a button should also be reachable naturally through
 * conversation. Buttons are shortcuts, not required syntax."
 *
 * So these tests are about the seam, not the model: a reading comes back, and
 * what happens next is `setFinishRequestedForChat` and `askForMoreForChat` —
 * the same two functions the buttons call. The stand-in runner returns raw
 * objects and lets the real `parseBoundaryReading` judge them, so a model that
 * answers outside the closed set is refused here exactly as it would be live.
 */
describe("the boundary, answered in words", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  /**
   * Answers both calls of one turn: `interpret` first, the boundary reading
   * second, told apart by the schema each asks for — which is how they differ
   * in production too, since they share the `interpret` task name.
   */
  function scripted(options: {
    boundary?: unknown | Error;
    proposals?: ProposedAnswer[];
  }) {
    const calls: { schema: string; prompt: string }[] = [];
    return {
      calls,
      async run(req: {
        prompt: string;
        schema?: { properties?: Record<string, unknown> };
        parse: (raw: unknown) => unknown;
      }) {
        const boundary = Boolean(req.schema?.properties?.intent);
        calls.push({ schema: boundary ? "boundary" : "interpret", prompt: req.prompt });
        const raw = boundary ? options.boundary : { proposals: options.proposals ?? [], unclear: [] };
        if (raw instanceof Error) {
          return { ok: false as const, reason: "FAILED", detail: raw.message, attempts: 1, ms: 1 };
        }
        const parsed = req.parse(raw);
        if (parsed === null) return { ok: false as const, reason: "BAD_OUTPUT", detail: "", attempts: 1, ms: 1 };
        return { ok: true as const, value: parsed, attempts: 1, ms: 1 };
      },
    };
  }

  /**
   * The real boundary: every required question answered, no optional one
   * touched yet, the offer sent and recorded as what is on screen.
   *
   * The optional questions are deliberately left OUTSTANDING — the shape that
   * makes "a few more questions" mean something, and the one where a careless
   * restatement would put an optional question on screen in place of the
   * choice the organizer is in the middle of making.
   */
  async function offerOnScreen(pool: pg.Pool, chatId: string, language = "he") {
    for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
          WHERE telegram_chat_id = $1`,
        [chatId, q.id, JSON.stringify(q.id === "travelers" ? ROSTER_STAND_IN : { kind: "text", schema_version: 3, text: "x" })],
      );
    }
    await pool.query(
      `UPDATE control_plane.intake_sessions
          SET language = $2, state = 'interviewing', awaiting = 'person', phase = 'optional',
              ui_state = jsonb_build_object('offered_more', true, 'last_prompt', $3::text)
        WHERE telegram_chat_id = $1`,
      [chatId, language, OPTIONAL_OFFER_PROMPT],
    );
    await setInterpretPath(pool, chatId, true);
  }

  const didNotFollow = (t: { text: string }, language: "he" | "en" = "he") =>
    t.text.includes(uiString("didNotFollow", language));

  test('"no, I think that\'s everything" finishes, the way the button does', async () => {
    await withTwoInterviews(async ({ pool, a, b }) => {
      await offerOnScreen(pool, a.chatId, "en");
      await offerOnScreen(pool, b.chatId, "en");
      const telegram = new Recorder();
      const runner = scripted({ boundary: { intent: "finish", confidence: 0.95 } });

      await say(pool, a.chatId, "No, I think that's everything", telegram, runner);

      const after = await getSessionForChat(pool, a.chatId);
      assert.ok(after.ok);
      assert.equal(after.view.state, "awaiting_confirmation", "the interview moved, exactly as a tap would move it");
      assert.ok(telegram.sent.length > 0, "and said so");
      assert.ok(
        telegram.sent.some((m) => m.text.includes(uiString("recapHeader", "en"))),
        `the summary is what comes next — sent: ${JSON.stringify(telegram.sent.map((m) => m.text.slice(0, 60)))}`,
      );
      assert.ok(
        !telegram.sent.some((m) => didNotFollow(m, "en")),
        "and nothing tells a person who was understood that they were not",
      );

      // The other interview is where it was: a reading applies to the session
      // it was read for, and a transition that ignored the chat id would look
      // identical on a single-chat test.
      const other = await getSessionForChat(pool, b.chatId);
      assert.ok(other.ok);
      assert.equal(other.view.state, "interviewing");
    });
  });

  test('"yes, there are a few more things" carries on, and asks one', async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await offerOnScreen(pool, a.chatId, "en");
      const telegram = new Recorder();
      const runner = scripted({ boundary: { intent: "more", confidence: 0.9 } });

      await say(pool, a.chatId, "Yes, there are a few more things", telegram, runner);

      const after = await getSessionForChat(pool, a.chatId);
      assert.ok(after.ok);
      assert.equal(after.view.state, "interviewing", "nothing has finished");
      const last = telegram.sent[telegram.sent.length - 1]!;
      assert.ok(!didNotFollow(last, "en"), `understood, not restated — got: ${last.text}`);
      assert.ok(
        !last.text.includes(uiString("essentialsDone", "en")),
        "a question, not the offer again",
      );
      assert.ok(
        after.view.lastPrompt?.startsWith("q:"),
        `an optional question is on screen — lastPrompt: ${after.view.lastPrompt}`,
      );
    });
  });

  test("something they forgot is captured first, and the choice is then put back — not as a failure to follow", async () => {
    // Dror's own example: "Wait, I forgot that we also want a day at Disney."
    // It is not an exit. It is a detail, arriving at the moment the interview
    // asked whether there were any more. Losing it to a classification would be
    // the worst of both worlds, so the ordinary capture runs first and this
    // reads what is left.
    await withTwoInterviews(async ({ pool, a }) => {
      await offerOnScreen(pool, a.chatId, "en");
      const telegram = new Recorder();
      const runner = scripted({
        boundary: { intent: "answer_only", confidence: 0.9 },
        proposals: [{
          questionId: "trip_interests",
          value: { kind: "text", text: "a day at Disney" },
          confidence: 0.9,
          evidence: "a day at Disney",
          sourceMessageId: "",
        }],
      });

      await say(pool, a.chatId, "Wait, I forgot that we also want a day at Disney", telegram, runner);

      const store = await answersForChat(pool, a.chatId);
      assert.equal(
        (store?.answers.trip_interests as { text?: string } | undefined)?.text,
        "a day at Disney",
        "the thing they remembered is on record",
      );
      const last = telegram.sent[telegram.sent.length - 1]!;
      assert.ok(!didNotFollow(last, "en"), `they were followed — got: ${last.text}`);
      assert.equal(last.text, uiString("moreOrSummary", "en"), "the choice is put back, short");
      assert.equal(last.buttons, 2, "with both exits still tappable");
      const after = await getSessionForChat(pool, a.chatId);
      assert.ok(after.ok);
      assert.equal(after.view.state, "interviewing", "and nothing was decided for them");
      assert.equal(after.view.lastPrompt, OPTIONAL_OFFER_PROMPT, "the boundary is still what is on screen");
    });
  });

  test("a half-heard answer is confirmed in words, and the confirmation is what makes “yes” mean something", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await offerOnScreen(pool, a.chatId, "en");
      const telegram = new Recorder();

      // Leaning towards finishing, without enough to act on.
      await say(pool, a.chatId, "nah we're good i guess", telegram,
        scripted({ boundary: { intent: "finish", confidence: 0.55 } }));

      const asked = await getSessionForChat(pool, a.chatId);
      assert.ok(asked.ok);
      assert.equal(asked.view.state, "interviewing", "a guess moves nothing");
      const confirm = telegram.sent[telegram.sent.length - 1]!;
      assert.equal(confirm.text, uiString("confirmFinish", "en"), "it names its guess and asks");
      assert.equal(confirm.buttons, 2, "with the buttons still there for anyone who would rather tap");
      assert.equal(asked.view.lastPrompt, "optional_offer_confirm:finish", "and records WHICH exit it asked about");

      // AND NOTHING WALKS PAST IT. A confirmation leaves the choice as open as
      // the offer did, so the router's own walk must not start asking optional
      // questions on top of a question the organizer is in the middle of
      // answering — the 2026-09-18 failure, one message further along.
      const sentSoFar = telegram.sent.length;
      const { advanceRouterOwnedQuestions } = await import("../src/relay/poller.js");
      const { DEFAULT_STRINGS } = await import("../src/relay/dispatch.js");
      await pool.query(
        "UPDATE control_plane.intake_sessions SET awaiting = 'machine' WHERE telegram_chat_id = $1",
        [a.chatId],
      );
      await advanceRouterOwnedQuestions(
        { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: emptyRunner } as never,
        DEFAULT_STRINGS,
        () => {},
      );
      assert.equal(telegram.sent.length, sentSoFar, "the confirmation is the only thing on screen");
      const held = await getSessionForChat(pool, a.chatId);
      assert.ok(held.ok);
      assert.equal(held.view.awaiting, "person", "and the turn is theirs, not a session owing a message forever");

      // …which is the whole point of recording it: a bare "yes" means nothing
      // at the boundary and everything under a question that named one exit.
      const second = scripted({ boundary: { intent: "finish", confidence: 0.95 } });
      await say(pool, a.chatId, "yes", telegram, second);

      const boundaryPrompt = second.calls.find((c) => c.schema === "boundary")?.prompt ?? "";
      assert.ok(
        boundaryPrompt.includes("wrap up and show the summary"),
        "the reader is told what was being confirmed, so it is not guessing at a bare yes",
      );
      const after = await getSessionForChat(pool, a.chatId);
      assert.ok(after.ok);
      assert.equal(after.view.state, "awaiting_confirmation", "and then it finishes");
    });
  });

  test("a reading that fails falls back to the buttons, restated — the behaviour it is layered on", async () => {
    await withTwoInterviews(async ({ pool, a }) => {
      await offerOnScreen(pool, a.chatId);
      const telegram = new Recorder();

      await say(pool, a.chatId, "מה?", telegram, scripted({ boundary: new Error("model down") }));

      const last = telegram.sent[telegram.sent.length - 1]!;
      assert.ok(didNotFollow(last), `the old path, unchanged — got: ${last.text}`);
      assert.ok(last.text.includes(uiString("essentialsDone", "he")), "with the offer itself restated");
      assert.equal(last.buttons, 2, "and both exits tappable");
      const after = await getSessionForChat(pool, a.chatId);
      assert.ok(after.ok);
      assert.equal(after.view.state, "interviewing", "nothing moved on a failed reading");
    });
  });

  test("the model cannot name a transition — only one of four words", async () => {
    // The closed set IS the safety property. `confirm_intake` is a real thing
    // the interview can do, and the reader has no way to ask for it: the parser
    // refuses the word, the call is BAD_OUTPUT, and BAD_OUTPUT lands where a
    // rate limit lands.
    await withTwoInterviews(async ({ pool, a }) => {
      await offerOnScreen(pool, a.chatId);
      const telegram = new Recorder();

      await say(pool, a.chatId, "כן בטח", telegram,
        scripted({ boundary: { intent: "confirm_intake", confidence: 1 } }));

      const after = await getSessionForChat(pool, a.chatId);
      assert.ok(after.ok);
      assert.equal(after.view.state, "interviewing", "no session was confirmed by a word");
      assert.ok(didNotFollow(telegram.sent[telegram.sent.length - 1]!), "it fell back, visibly");
    });
  });

  test("nothing is read when the boundary is not on screen", async () => {
    // The second call is paid for by a typed message at one point in the
    // interview, and nowhere else. A reader that ran on every message would
    // double the cost of the whole conversation to answer a question nobody
    // asked.
    await withTwoInterviews(async ({ pool, a }) => {
      await setInterpretPath(pool, a.chatId, true);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET language = 'en', state = 'interviewing', awaiting = 'person', phase = 'essentials'
          WHERE telegram_chat_id = $1`,
        [a.chatId],
      );
      const telegram = new Recorder();
      const runner = scripted({ boundary: { intent: "finish", confidence: 1 } });

      await say(pool, a.chatId, "it's a family trip", telegram, runner);

      assert.deepEqual(runner.calls.map((c) => c.schema), ["interpret"], "one call, mid-interview");
    });
  });
});
