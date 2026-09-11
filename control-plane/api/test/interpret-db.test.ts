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
import { flushSettledInboundBursts } from "../src/relay/poller.js";
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
        storedOutcomes({ accepted: [{ questionId: "trip_type", answer: { kind: "choice", option_id: "family", schema_version: 3, other_text: null }, proposal: PROPOSAL }], rejected: [], askAnyway: [] }, 0),
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
describe("a reply that answers nothing", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
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
  async function say(pool: pg.Pool, chatId: string, text: string, telegram: Recorder) {
    seq += 1;
    await queueInboundMessage(pool, chatId, { text, message_id: `m${seq}` } as never);
    await flushSettledInboundBursts(
      { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: emptyRunner } as never,
      () => {},
      0,
    );
  }

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
          [a.chatId, q.id, JSON.stringify({ kind: "text", schema_version: 3, text: "x" })],
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
        [chatId, q.id, JSON.stringify(q.type === "choice"
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
          [a.chatId, q.id, JSON.stringify({ kind: "text", schema_version: 3, text: "x" })],
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
