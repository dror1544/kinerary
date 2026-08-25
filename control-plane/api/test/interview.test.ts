import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { issueEnrollment } from "../src/enrollment.js";
import {
  INTAKE_QUESTIONS,
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
    const q = INTAKE_QUESTIONS.find((q) => q.id === "trip_type")!;
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

  test("required text question: blank input rejected with TEXT_REQUIRED", () => {
    // 'destination' is required; blank text must not advance the session
    const result = validateAnswer("destination", "", null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TEXT_REQUIRED");
  });

  test("required text question: whitespace-only input rejected with TEXT_REQUIRED", () => {
    const result = validateAnswer("destination", "   ", null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TEXT_REQUIRED");
  });

  test("optional text question: empty string accepted (can be skipped)", () => {
    // 'trip_interests' is optional; skipping with "" is intentional
    const result = validateAnswer("trip_interests", "", null);
    assert.equal(result.ok, true);
  });

  test("text question: text exceeding maxLength rejected", () => {
    const q = INTAKE_QUESTIONS.find((q) => q.id === "destination")!;
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

  test("structured question (array shape): valid array accepted", () => {
    const result = validateAnswer("travelers", null, null, INTAKE_QUESTIONS, [{ name: "Alex", age: 30, family: "Smith" }]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.answer.kind, "structured");
    if (result.answer.kind !== "structured") throw new Error("unreachable");
    assert.deepEqual(result.answer.data, [{ name: "Alex", age: 30, family: "Smith" }]);
  });

  test("structured question (array shape): object payload rejected", () => {
    const result = validateAnswer("travelers", null, null, INTAKE_QUESTIONS, { name: "Alex" });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "DATA_WRONG_SHAPE");
  });

  test("structured question (object shape): valid object accepted", () => {
    const result = validateAnswer("constraints", null, null, INTAKE_QUESTIONS, { dietary: "vegetarian" });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.answer.kind, "structured");
  });

  test("structured question (object shape): array payload rejected", () => {
    const result = validateAnswer("constraints", null, null, INTAKE_QUESTIONS, ["not", "an", "object"]);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "DATA_WRONG_SHAPE");
  });

  test("required structured question: missing data rejected with DATA_REQUIRED", () => {
    const result = validateAnswer("travelers", null, null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "DATA_REQUIRED");
  });

  test("optional structured question: missing data accepted as empty", () => {
    const result = validateAnswer("constraints", null, null);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.answer.kind, "structured");
    if (result.answer.kind !== "structured") throw new Error("unreachable");
    assert.deepEqual(result.answer.data, {});
  });

  test("multi_choice question: several valid options accepted", () => {
    const result = validateAnswer("dietary", null, null, INTAKE_QUESTIONS, undefined, ["vegetarian", "gluten_free"]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.answer.kind, "multi_choice");
    if (result.answer.kind !== "multi_choice") throw new Error("unreachable");
    assert.deepEqual(result.answer.option_ids, ["gluten_free", "vegetarian"]);
    assert.equal(result.answer.schema_version, INTAKE_SCHEMA_VERSION);
  });

  test("multi_choice question: one unknown option rejects the whole answer", () => {
    const result = validateAnswer("dietary", null, null, INTAKE_QUESTIONS, undefined, ["vegetarian", "pescatarian"]);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "UNKNOWN_OPTION");
  });

  test("multi_choice question: order and repeats are normalized away", () => {
    // Both are artifacts of however the chat UI serialised the taps, and both
    // would otherwise perturb the intake digest for an identical answer.
    const a = validateAnswer("dietary", null, null, INTAKE_QUESTIONS, undefined, ["vegan", "kosher", "vegan"]);
    const b = validateAnswer("dietary", null, null, INTAKE_QUESTIONS, undefined, ["kosher", "vegan"]);
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    assert.deepEqual(a.answer, b.answer);
  });

  test("multi_choice question: omitting optionIds entirely is rejected", () => {
    const result = validateAnswer("dietary", null, null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "OPTIONS_REQUIRED");
  });

  test("multi_choice question: an explicit empty selection is a valid optional answer", () => {
    const result = validateAnswer("dietary", null, null, INTAKE_QUESTIONS, undefined, []);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.answer.kind, "multi_choice");
    if (result.answer.kind !== "multi_choice") throw new Error("unreachable");
    assert.deepEqual(result.answer.option_ids, []);
  });

  test("date questions never state a format to the organizer", () => {
    // Organizers' own date conventions vary (DD/MM vs MM/DD vs written out);
    // the interviewer resolves whatever they say and confirms its reading back
    // in words. Naming a format just leaks an implementation detail.
    for (const id of ["departure_date", "return_date"]) {
      const q = INTAKE_QUESTIONS.find((q) => q.id === id)!;
      assert.ok(q, `${id} must exist`);
      assert.ok(!/YYYY|MM-DD|DD\/MM/i.test(q.prompt), `${id} prompt leaks a date format: ${q.prompt}`);
    }
  });

  test("no new choice question offers a free-text 'other'", () => {
    // Their answers become bilingual {he,en} strings in trip.config.json, and
    // organizer free text would only ever be the one language they typed.
    for (const id of ["trip_pace", "dietary", "bot_gender", "bot_tone", "bot_proactive"]) {
      const q = INTAKE_QUESTIONS.find((q) => q.id === id)!;
      assert.ok(q, `${id} must exist`);
      assert.ok(!q.allowsOther, `${id} must not allow free-text other`);
    }
  });

  test("every question added in schema v2 is optional", () => {
    // A required question here would block confirmation for an organizer who
    // simply doesn't want an assistant yet.
    for (const id of [
      "trip_pace", "dietary", "dietary_scope", "organizer_identity",
      "bot_name", "bot_gender", "bot_tone", "bot_proactive", "bot_limits",
    ]) {
      const q = INTAKE_QUESTIONS.find((q) => q.id === id)!;
      assert.ok(q, `${id} must exist`);
      assert.equal(q.required, false, `${id} must be optional`);
    }
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

  test("multi_choice answer shows every selected label, not ids", () => {
    const answers = {
      dietary: { kind: "multi_choice" as const, option_ids: ["kosher", "vegan"], schema_version: 2, other_text: null },
    };
    const recap = buildRecap(answers);
    const entry = recap.find((r) => r.questionId === "dietary");
    assert.ok(entry);
    assert.ok(entry!.answerLabel.includes("Kosher"), entry!.answerLabel);
    assert.ok(entry!.answerLabel.includes("Vegan"), entry!.answerLabel);
    assert.ok(!entry!.answerLabel.includes("undefined"), "must not fall through to the text branch");
  });

  test("empty multi_choice answer reads as (none), not blank", () => {
    const answers = {
      dietary: { kind: "multi_choice" as const, option_ids: [], schema_version: 2, other_text: null },
    };
    const recap = buildRecap(answers);
    assert.equal(recap.find((r) => r.questionId === "dietary")!.answerLabel, "(none)");
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

/** Answers every required question (post-Sprint-4-gap-closing schema) in one call. */
async function answerAllRequiredQuestions(pool: pg.Pool, sessionToken: string): Promise<void> {
  await submitAnswer(pool, sessionToken, "trip_type", "family");
  await submitAnswer(pool, sessionToken, "destination", "Japan");
  await submitAnswer(pool, sessionToken, "group_size", "3_to_5");
  await submitAnswer(pool, sessionToken, "trip_duration", "two_weeks");
  await submitAnswer(pool, sessionToken, "departure_date", "2026-09-06");
  await submitAnswer(pool, sessionToken, "return_date", "2026-09-20");
  await submitAnswer(pool, sessionToken, "travelers", null, undefined, undefined, [
    { name: "Test Traveler", age: 30, family: "Test" },
  ]);
  await submitAnswer(pool, sessionToken, "phases", null, undefined, undefined, [
    { name: "Test City", start: "2026-09-06", end: "2026-09-20" },
  ]);
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

  test("optionalRemaining exposes the optional questions nextQuestion never reaches", { skip: SKIP }, async () => {
    // nextQuestion only ever walks *required* questions. Without this list the
    // interviewer has no way to learn an optional question exists, which is
    // why dietary, pace and the whole assistant block would otherwise be
    // collected from every organizer exactly never.
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const ids = started.view.optionalRemaining.map((q) => q.id);
      for (const expected of ["dietary", "trip_pace", "bot_name", "bot_limits", "timezone"]) {
        assert.ok(ids.includes(expected), `optionalRemaining must include ${expected}, got ${ids.join(", ")}`);
      }
      assert.ok(!ids.includes("destination"), "required questions belong to nextQuestion, not this list");

      // Answering one drops it from the list.
      const after = await submitAnswer(
        fix.pool, started.sessionToken, "dietary", null, undefined, undefined, undefined, ["vegetarian"],
      );
      assert.equal(after.ok, true);
      if (!after.ok) throw new Error("unreachable");
      assert.ok(!after.view.optionalRemaining.map((q) => q.id).includes("dietary"));
    } finally {
      await teardownFixture(fix);
    }
  });

  test("optional questions never gate confirmation", { skip: SKIP }, async () => {
    // The whole point of optionalRemaining being advisory: an organizer who
    // wants no assistant at all must still be able to finish.
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      await answerAllRequiredQuestions(fix.pool, started.sessionToken);
      const view = await getSession(fix.pool, started.sessionToken);
      assert.equal(view.ok, true);
      if (!view.ok) throw new Error("unreachable");
      assert.equal(view.view.state, "awaiting_confirmation");
      assert.ok(view.view.optionalRemaining.length > 0, "still offering the unanswered optional questions");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: multi_choice answer stored as an option_ids array", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      const result = await submitAnswer(
        fix.pool, started.sessionToken, "bot_proactive", null, undefined, undefined, undefined,
        ["morning_briefing", "flight_changes"],
      );
      assert.equal(result.ok, true);

      const row = await fix.pool.query<{ answers: Record<string, any> }>(
        "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
        [started.sessionId],
      );
      const stored = row.rows[0].answers.bot_proactive;
      assert.equal(stored.kind, "multi_choice");
      assert.deepEqual(stored.option_ids, ["flight_changes", "morning_briefing"]);
      assert.equal(stored.schema_version, INTAKE_SCHEMA_VERSION);
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
      await submitAnswer(fix.pool, sessionToken, "trip_duration", "two_weeks");
      await submitAnswer(fix.pool, sessionToken, "departure_date", "2026-09-06");
      await submitAnswer(fix.pool, sessionToken, "return_date", "2026-09-20");
      await submitAnswer(fix.pool, sessionToken, "travelers", null, undefined, undefined, [{ name: "Test", age: 30, family: "Test" }]);
      const last = await submitAnswer(fix.pool, sessionToken, "phases", null, undefined, undefined, [{ name: "Test City", start: "2026-09-06", end: "2026-09-20" }]);

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

  test("confirmIntake: rejects an answer containing credential/private-address content, without writing", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken, sessionId } = started;

      await answerAllRequiredQuestions(fix.pool, sessionToken);
      // Overwrite one required answer with something the canonical guard
      // must catch — same regression this migration/guard exists for.
      await submitAnswer(fix.pool, sessionToken, "destination", "Authorization: Bearer sk-should-not-be-here");

      const result = await confirmIntake(fix.pool, sessionToken);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "UNSAFE_ANSWER_CONTENT");
      assert.match(result.unsafePath ?? "", /destination/);

      // Nothing durable was written, and the session is still answerable.
      const versionCount = await fix.pool.query<{ count: string }>(
        "SELECT count(*) FROM control_plane.intake_versions WHERE trip_id = $1",
        [fix.draftTripId],
      );
      assert.equal(versionCount.rows[0]?.count, "0");

      const sessionRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.intake_sessions WHERE id = $1",
        [sessionId],
      );
      assert.equal(sessionRow.rows[0]?.state, "awaiting_confirmation");
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

      await answerAllRequiredQuestions(fix.pool, sessionToken);

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

      await answerAllRequiredQuestions(fix.pool, sessionToken);

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

      await answerAllRequiredQuestions(fix.pool, sessionToken);
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

      await answerAllRequiredQuestions(fix.pool, sessionToken);

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

  test("submitAnswer: required text question with blank input rejected", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      // 'destination' is required; blank must not become a confirmed answer
      const result = await submitAnswer(fix.pool, started.sessionToken, "destination", "");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "TEXT_REQUIRED");

      // Whitespace-only is also rejected
      const wsResult = await submitAnswer(fix.pool, started.sessionToken, "destination", "   ");
      assert.equal(wsResult.ok, false);
      if (wsResult.ok) throw new Error("unreachable");
      assert.equal(wsResult.reason, "TEXT_REQUIRED");

      // Session did not advance: destination is still unanswered
      const row = await fix.pool.query<{ answers: Record<string, unknown> }>(
        "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
        [started.sessionId],
      );
      assert.equal(row.rows[0]?.answers?.["destination"], undefined);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("submitAnswer: mismatched expectedSessionId returns NOT_FOUND without writing", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");

      // Pass a sessionId that does not match the token's session.
      const result = await submitAnswer(fix.pool, started.sessionToken, "trip_type", "family", undefined, "sess_wrongsessionid");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NOT_FOUND");

      // The session must be unchanged — no answer was written.
      const row = await fix.pool.query<{ answers: Record<string, unknown> }>(
        "SELECT answers FROM control_plane.intake_sessions WHERE id = $1",
        [started.sessionId],
      );
      assert.equal(row.rows[0]?.answers?.["trip_type"], undefined);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("confirmIntake: mismatched expectedSessionId returns NOT_FOUND without writing", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken, sessionId } = started;

      await answerAllRequiredQuestions(fix.pool, sessionToken);

      // Pass the wrong sessionId — mismatch must prevent the confirm write.
      const result = await confirmIntake(fix.pool, sessionToken, () => {}, "sess_wrongsessionid");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NOT_FOUND");

      // No intake_versions row should exist, and session state must be unchanged.
      const versionCount = await fix.pool.query<{ count: string }>(
        "SELECT count(*) FROM control_plane.intake_versions WHERE trip_id = $1",
        [fix.draftTripId],
      );
      assert.equal(versionCount.rows[0]?.count, "0");

      const sessionRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.intake_sessions WHERE id = $1",
        [sessionId],
      );
      assert.equal(sessionRow.rows[0]?.state, "awaiting_confirmation");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("confirmIntake: returns sessionId so callers can verify path match", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("unreachable");
      const { sessionToken, sessionId } = started;

      await answerAllRequiredQuestions(fix.pool, sessionToken);

      const result = await confirmIntake(fix.pool, sessionToken);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.sessionId, sessionId);
    } finally {
      await teardownFixture(fix);
    }
  });
});
