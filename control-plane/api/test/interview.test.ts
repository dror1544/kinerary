import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { issueEnrollment } from "../src/enrollment.js";
import {
  INTAKE_QUESTIONS_V1,
  INTAKE_SCHEMA_VERSION,
  validateAnswer,
  buildRecap,
  computeIntakeDigest,
  startSession,
  getSession,
  submitAnswer,
  confirmIntake,
  getSessionStatus,
} from "../src/interview.js";
import { applyMigrations } from "../src/migrations.js";

const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function runMigrations(pool: pg.Pool) {
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); }
  finally { client.release(); }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── In-memory unit tests (no DB needed) ──────────────────────────────────────

describe("validateAnswer (unit)", () => {
  test("choice question: valid option accepted", () => {
    const result = validateAnswer("trip_type", "family", null);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.answer.kind, "choice");
    if (result.answer.kind !== "choice") throw new Error("unreachable");
    assert.equal(result.answer.option_id, "family");
    assert.equal(result.answer.schema_version, INTAKE_SCHEMA_VERSION);
  });

  test("choice question: unknown option id rejected", () => {
    const result = validateAnswer("trip_type", "invalid_option", null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "UNKNOWN_OPTION");
  });

  test("choice question: 'other' path requires other_text", () => {
    const result = validateAnswer("trip_type", "other", null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "OTHER_TEXT_REQUIRED");
  });

  test("choice question: 'other' with text accepted, stores literal text", () => {
    const result = validateAnswer("trip_type", "other", "extended family reunion");
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.answer.kind, "choice_other");
    if (result.answer.kind !== "choice_other") throw new Error("unreachable");
    assert.equal(result.answer.option_id, null);
    assert.equal(result.answer.other_text, "extended family reunion");
  });

  test("choice question: 'other' text exceeding maxLength rejected", () => {
    const q = INTAKE_QUESTIONS_V1.find((q) => q.id === "trip_type")!;
    const longText = "x".repeat((q.maxLength ?? 120) + 1);
    const result = validateAnswer("trip_type", "other", longText);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TEXT_TOO_LONG");
  });

  test("text question: accepted and stores text", () => {
    const result = validateAnswer("destination", "Japan", null);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.answer.kind, "text");
    if (result.answer.kind !== "text") throw new Error("unreachable");
    assert.equal(result.answer.text, "Japan");
  });

  test("text question: empty string accepted (optional questions can be skipped)", () => {
    const result = validateAnswer("trip_interests", "", null);
    assert.equal(result.ok, true);
  });

  test("text question: text exceeding maxLength rejected", () => {
    const q = INTAKE_QUESTIONS_V1.find((q) => q.id === "destination")!;
    const longText = "x".repeat((q.maxLength ?? 200) + 1);
    const result = validateAnswer("destination", longText, null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TEXT_TOO_LONG");
  });

  test("unknown question id rejected", () => {
    const result = validateAnswer("nonexistent_question", "any", null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "UNKNOWN_QUESTION");
  });
});

describe("buildRecap (unit)", () => {
  test("choice answer shows option label, not id", () => {
    const answers = {
      trip_type: { kind: "choice" as const, option_id: "family", schema_version: 1, other_text: null },
    };
    const recap = buildRecap(answers);
    const entry = recap.find((r) => r.questionId === "trip_type");
    assert.ok(entry);
    assert.equal(entry!.answerLabel, "Family");
  });

  test("'other' answer shows literal organizer text, not a reclassification", () => {
    const answers = {
      trip_type: { kind: "choice_other" as const, option_id: null, schema_version: 1, other_text: "extended family reunion" },
    };
    const recap = buildRecap(answers);
    const entry = recap.find((r) => r.questionId === "trip_type");
    assert.ok(entry);
    assert.ok(entry!.answerLabel.includes("extended family reunion"), "recap must show literal other_text");
    assert.ok(!entry!.answerLabel.includes("family") || entry!.answerLabel.toLowerCase().includes("other"), "must not silently reclassify");
  });

  test("text answer shows the organizer's text", () => {
    const answers = {
      destination: { kind: "text" as const, schema_version: 1, text: "Japan" },
    };
    const recap = buildRecap(answers);
    const entry = recap.find((r) => r.questionId === "destination");
    assert.ok(entry);
    assert.equal(entry!.answerLabel, "Japan");
  });
});

describe("computeIntakeDigest (unit)", () => {
  test("same inputs produce the same digest", () => {
    const answers = {
      trip_type: { kind: "choice" as const, option_id: "family", schema_version: 1, other_text: null },
      destination: { kind: "text" as const, schema_version: 1, text: "Japan" },
    };
    const d1 = computeIntakeDigest("trip_abc", answers);
    const d2 = computeIntakeDigest("trip_abc", answers);
    assert.equal(d1, d2);
    assert.ok(d1.startsWith("sha256:"));
  });

  test("different trip IDs produce different digests", () => {
    const answers = { destination: { kind: "text" as const, schema_version: 1, text: "Japan" } };
    assert.notEqual(computeIntakeDigest("trip_a", answers), computeIntakeDigest("trip_b", answers));
  });

  test("different answers produce different digests", () => {
    const answers1 = { trip_type: { kind: "choice" as const, option_id: "family", schema_version: 1, other_text: null } };
    const answers2 = { trip_type: { kind: "choice" as const, option_id: "couple", schema_version: 1, other_text: null } };
    assert.notEqual(computeIntakeDigest("trip_x", answers1), computeIntakeDigest("trip_x", answers2));
  });
});

// ── Database-backed integration tests ────────────────────────────────────────

interface TestFixture {
  pool: pg.Pool;
  ownerId: string;
  draftTripId: string;
}

async function setupFixture(pool: pg.Pool): Promise<TestFixture> {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const ownerId = `user_${suffix}`;
  const draftTripId = `trip_${suffix}`;

  await pool.query(
    "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')",
    [ownerId],
  );
  await pool.query(
    "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
    [draftTripId, `intv-test-${suffix}`],
  );
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [`memb_${suffix}`, draftTripId, ownerId],
  );

  return { pool, ownerId, draftTripId };
}

async function teardownFixture(fix: TestFixture) {
  const { pool, draftTripId, ownerId } = fix;
  await pool.query("DELETE FROM control_plane.intake_versions WHERE trip_id = $1", [draftTripId]);
  await pool.query("DELETE FROM control_plane.intake_sessions WHERE trip_id = $1", [draftTripId]);
  await pool.query("DELETE FROM control_plane.interview_enrollments WHERE trip_id = $1", [draftTripId]);
  await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = $1", [draftTripId]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [draftTripId]);
  await pool.query("DELETE FROM control_plane.user_identities WHERE user_id = $1", [ownerId]);
  await pool.query("DELETE FROM control_plane.users WHERE id = $1", [ownerId]);
}

async function issuedEnrollmentToken(fix: TestFixture): Promise<string> {
  const result = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: 3600 });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.token;
}

describe("startSession (DB)", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
    await runMigrations(pool);
  });

  after(async () => {
    if (SKIP) return;
    await pool?.end();
  });

  test("startSession: valid enrollment token starts session and transitions trip", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const result = await startSession(fix.pool, token);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");

      assert.ok(result.sessionId.startsWith("sess_"));
      assert.ok(result.sessionToken.length > 20);
      assert.equal(result.view.state, "interviewing");
      assert.ok(result.view.nextQuestion !== null);

      // Trip should now be 'intake_in_progress'
      const tripRow = await fix.pool.query<{ lifecycle_state: string }>(
        "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1",
        [fix.draftTripId],
      );
      assert.equal(tripRow.rows[0]?.lifecycle_state, "intake_in_progress");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("startSession: enrollment token cannot be reused (replay rejected)", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const first = await startSession(fix.pool, token);
      assert.equal(first.ok, true);

      const second = await startSession(fix.pool, token);
      assert.equal(second.ok, false);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("startSession: altered/unknown enrollment token rejected", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await startSession(fix.pool, "notvalidtoken");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "INVALID_TOKEN");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("startSession: expired enrollment token rejected", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const expiredResult = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: -1 });
      assert.equal(expiredResult.ok, true);
      if (!expiredResult.ok) throw new Error("unreachable");

      const result = await startSession(fix.pool, expiredResult.token);
      assert.equal(result.ok, false);
    } finally {
      await teardownFixture(fix);
    }
  });
});

describe("getSession / submitAnswer / confirmIntake (DB)", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
    await runMigrations(pool);
  });

  after(async () => {
    if (SKIP) return;
    await pool?.end();
  });

  test("getSession: valid token returns current view", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const view = await getSession(fix.pool, started.sessionToken);
      assert.equal(view.ok, true);
      if (!view.ok) throw new Error("unreachable");
      assert.equal(view.view.sessionId, started.sessionId);
      assert.equal(view.view.state, "interviewing");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("getSession: invalid token returns NOT_FOUND", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const view = await getSession(fix.pool, "bogustoken");
      assert.equal(view.ok, false);
      if (view.ok) throw new Error("unreachable");
      assert.equal(view.reason, "NOT_FOUND");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: valid choice answer accepted, stored with schema version", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const result = await submitAnswer(fix.pool, started.sessionToken, "trip_type", "family");
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");

      // Verify stored answer includes schema_version
      const row = await fix.pool.query<{ answers: Record<string, unknown> }>(
        "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
        [started.sessionId],
      );
      const answer = row.rows[0]?.answers?.["trip_type"] as { schema_version: number };
      assert.equal(answer?.schema_version, INTAKE_SCHEMA_VERSION);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: 'other' answer stores literal text, not a reclassification", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const result = await submitAnswer(fix.pool, started.sessionToken, "trip_type", "other", "extended family reunion");
      assert.equal(result.ok, true);

      const row = await fix.pool.query<{ answers: Record<string, unknown> }>(
        "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
        [started.sessionId],
      );
      const answer = row.rows[0]?.answers?.["trip_type"] as { kind: string; option_id: null; other_text: string };
      assert.equal(answer?.kind, "choice_other");
      assert.equal(answer?.option_id, null);
      assert.equal(answer?.other_text, "extended family reunion");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: unknown question id rejected", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const result = await submitAnswer(fix.pool, started.sessionToken, "nonexistent_question", "any");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "UNKNOWN_QUESTION");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: unknown option id rejected", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const result = await submitAnswer(fix.pool, started.sessionToken, "trip_type", "totally_unknown_option");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "UNKNOWN_OPTION");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: session advances to awaiting_confirmation once all required questions answered", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken } = started;

      // Answer all required questions
      await submitAnswer(fix.pool, sessionToken, "trip_type", "family");
      await submitAnswer(fix.pool, sessionToken, "destination", "Japan");
      await submitAnswer(fix.pool, sessionToken, "group_size", "3_to_5");
      const last = await submitAnswer(fix.pool, sessionToken, "trip_duration", "two_weeks");

      assert.equal(last.ok, true);
      if (!last.ok) throw new Error("unreachable");
      assert.equal(last.view.state, "awaiting_confirmation");
      assert.equal(last.view.nextQuestion, null);
      assert.ok(last.view.recap !== null);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: corrections overwrite previous answer (allowed before CONFIRM)", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken } = started;

      await submitAnswer(fix.pool, sessionToken, "trip_type", "family");
      await submitAnswer(fix.pool, sessionToken, "trip_type", "couple");

      const row = await fix.pool.query<{ answers: Record<string, unknown> }>(
        "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
        [started.sessionId],
      );
      const answer = row.rows[0]?.answers?.["trip_type"] as { option_id: string };
      assert.equal(answer?.option_id, "couple");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("confirmIntake: fails if not all required questions are answered", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      // Only answer one of four required questions
      await submitAnswer(fix.pool, started.sessionToken, "trip_type", "family");

      const result = await confirmIntake(fix.pool, started.sessionToken);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NOT_ALL_REQUIRED_ANSWERED");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("confirmIntake: creates immutable intake version with correct digest", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken } = started;

      await submitAnswer(fix.pool, sessionToken, "trip_type", "family");
      await submitAnswer(fix.pool, sessionToken, "destination", "Japan");
      await submitAnswer(fix.pool, sessionToken, "group_size", "3_to_5");
      await submitAnswer(fix.pool, sessionToken, "trip_duration", "two_weeks");

      const result = await confirmIntake(fix.pool, sessionToken);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");

      assert.ok(result.intakeVersionId.startsWith("intk_"));
      assert.ok(result.digest.startsWith("sha256:"));
      assert.equal(result.versionNumber, 1);

      // The digest in the DB matches
      const versionRow = await fix.pool.query<{ digest: string; confirmed_at: Date }>(
        "SELECT digest, confirmed_at FROM control_plane.intake_versions WHERE id = $1",
        [result.intakeVersionId],
      );
      assert.equal(versionRow.rows[0]?.digest, result.digest);
      assert.ok(versionRow.rows[0]?.confirmed_at instanceof Date);

      // Trip lifecycle transitioned to 'intake_confirmed'
      const tripRow = await fix.pool.query<{ lifecycle_state: string }>(
        "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1",
        [fix.draftTripId],
      );
      assert.equal(tripRow.rows[0]?.lifecycle_state, "intake_confirmed");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("confirmIntake: second CONFIRM is idempotent (same version returned)", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken } = started;

      await submitAnswer(fix.pool, sessionToken, "trip_type", "family");
      await submitAnswer(fix.pool, sessionToken, "destination", "Japan");
      await submitAnswer(fix.pool, sessionToken, "group_size", "3_to_5");
      await submitAnswer(fix.pool, sessionToken, "trip_duration", "two_weeks");

      const first = await confirmIntake(fix.pool, sessionToken);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");

      const second = await confirmIntake(fix.pool, sessionToken);
      assert.equal(second.ok, true);
      if (!second.ok) throw new Error("unreachable");

      assert.equal(first.intakeVersionId, second.intakeVersionId);
      assert.equal(first.digest, second.digest);
      assert.equal(first.versionNumber, second.versionNumber);

      // Only one intake_versions row exists
      const count = await fix.pool.query<{ count: string }>(
        "SELECT count(*) FROM control_plane.intake_versions WHERE trip_id = $1",
        [fix.draftTripId],
      );
      assert.equal(count.rows[0]?.count, "1");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: blocked after CONFIRM", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken } = started;

      await submitAnswer(fix.pool, sessionToken, "trip_type", "family");
      await submitAnswer(fix.pool, sessionToken, "destination", "Japan");
      await submitAnswer(fix.pool, sessionToken, "group_size", "3_to_5");
      await submitAnswer(fix.pool, sessionToken, "trip_duration", "two_weeks");
      await confirmIntake(fix.pool, sessionToken);

      const result = await submitAnswer(fix.pool, sessionToken, "destination", "Korea");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "SESSION_CONFIRMED");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("intake_versions digest is immutable: direct DB update blocked by UNIQUE constraint", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken } = started;

      await submitAnswer(fix.pool, sessionToken, "trip_type", "couple");
      await submitAnswer(fix.pool, sessionToken, "destination", "Italy");
      await submitAnswer(fix.pool, sessionToken, "group_size", "2");
      await submitAnswer(fix.pool, sessionToken, "trip_duration", "week");

      const confirmed = await confirmIntake(fix.pool, sessionToken);
      assert.equal(confirmed.ok, true);
      if (!confirmed.ok) throw new Error("unreachable");

      // Trying to insert another intake_versions row with the same digest fails
      await assert.rejects(
        () => fix.pool.query(
          "INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at) VALUES ($1, $2, 2, 'ref', $3, now())",
          [`intk_dup${Date.now().toString(36)}`, fix.draftTripId, confirmed.digest],
        ),
        /unique/i,
      );
    } finally {
      await teardownFixture(fix);
    }
  });

  test("getSessionStatus: returns state for the owning user", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const result = await getSessionStatus(fix.pool, started.sessionId, fix.ownerId);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.state, "interviewing");
      assert.equal(result.intakeVersionId, undefined);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("getSessionStatus: WRONG_USER returned for non-owner", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const result = await getSessionStatus(fix.pool, started.sessionId, "user_somebodyelse");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "WRONG_USER");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("API response never includes raw answer text in getSessionStatus", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken } = started;

      await submitAnswer(fix.pool, sessionToken, "trip_type", "other", "secret family details");
      await submitAnswer(fix.pool, sessionToken, "destination", "Hidden destination");

      const statusResult = await getSessionStatus(fix.pool, started.sessionId, fix.ownerId);
      assert.equal(statusResult.ok, true);
      if (!statusResult.ok) throw new Error("unreachable");

      // getSessionStatus only returns state, no answer content
      const serialized = JSON.stringify(statusResult);
      assert.ok(!serialized.includes("secret family details"), "status must not leak answer text");
      assert.ok(!serialized.includes("Hidden destination"), "status must not leak answer text");
    } finally {
      await teardownFixture(fix);
    }
  });
});
