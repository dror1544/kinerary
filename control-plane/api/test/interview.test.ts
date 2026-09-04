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
  getSessionForChat,
  selectedOptionIds,
  askForMoreForChat,
  claimDueRouterPrompts,
  submitAnswerForAgent,
  closeAgentTurn,
  hasOpenAgentTurn,
  openAgentTurn,
  recordLastPromptForChat,
  markOfferedMoreForChat,
  nominateQuestionForChat,
  setFinishRequestedForChat,
  setLanguageForChat,
  nominateQuestionForChat,
  skipQuestionForChat,
  toggleMultiChoiceForChat,
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

describe("buildRecap: structured answers (unit)", () => {
  // "5 item(s) recorded" is what the recap used to say for travelers and
  // phases — the two answers most worth checking before an immutable version
  // is written. Asking someone to confirm a count is not a confirmation step.
  test("a roster shows who is on it, not how many", () => {
    const recap = buildRecap({
      travelers: {
        kind: "structured",
        schema_version: INTAKE_SCHEMA_VERSION,
        data: [
          { name: "Dror", age: 45, family: "Elul" },
          { name: "Maya", age: 12, family: "Elul" },
        ],
      },
    } as never);
    const entry = recap.find((e) => e.questionId === "travelers");
    assert.ok(entry);
    assert.ok(entry!.answerLabel.includes("Dror"), entry!.answerLabel);
    assert.ok(entry!.answerLabel.includes("Maya"), entry!.answerLabel);
    assert.ok(!/item\(s\)/.test(entry!.answerLabel), "no counts");
  });

  test("an unconventional key still renders something checkable", () => {
    // These payloads are LLM-assembled, so `name` is a convention rather than
    // a guarantee. A formatter that assumed one key would print nothing at all
    // the first time a phase came back as `title`.
    const recap = buildRecap({
      phases: {
        kind: "structured",
        schema_version: INTAKE_SCHEMA_VERSION,
        data: [{ title: "Tokyo" }, { place: "Kyoto" }],
      },
    } as never);
    const entry = recap.find((e) => e.questionId === "phases");
    assert.ok(entry);
    assert.ok(entry!.answerLabel.includes("Tokyo"), entry!.answerLabel);
    assert.ok(entry!.answerLabel.includes("Kyoto"), entry!.answerLabel);
  });

  test("a long roster is trimmed, not wrapped — the recap is one message", () => {
    const recap = buildRecap({
      travelers: {
        kind: "structured",
        schema_version: INTAKE_SCHEMA_VERSION,
        data: Array.from({ length: 9 }, (_, i) => ({ name: `Traveller ${i + 1}` })),
      },
    } as never);
    const entry = recap.find((e) => e.questionId === "travelers");
    assert.ok(entry);
    assert.ok(entry!.answerLabel.includes("+3 more"), entry!.answerLabel);
  });

  test("an empty structured answer says so plainly", () => {
    const recap = buildRecap({
      constraints: { kind: "structured", schema_version: INTAKE_SCHEMA_VERSION, data: {} },
    } as never);
    assert.equal(recap.find((e) => e.questionId === "constraints")!.answerLabel, "(none)");
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

// The verified private-chat id a router-side write is located by. Positive
// integer shape on purpose: interview.ts records a binding for nothing else.
const CHAT_ID = "391627336";

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

  test("startSession: well-formed telegramChatIdHint is persisted onto the trip", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const result = await startSession(fix.pool, token, () => {}, "391627336");
      assert.equal(result.ok, true);

      const tripRow = await fix.pool.query<{ notification_chat_id_hint: string | null }>(
        "SELECT notification_chat_id_hint FROM control_plane.trips WHERE id = $1",
        [fix.draftTripId],
      );
      assert.equal(tripRow.rows[0]?.notification_chat_id_hint, "391627336");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("startSession: malformed telegramChatIdHint is ignored, not stored", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const result = await startSession(fix.pool, token, () => {}, "not-a-chat-id; DROP TABLE trips;");
      assert.equal(result.ok, true);

      const tripRow = await fix.pool.query<{ notification_chat_id_hint: string | null }>(
        "SELECT notification_chat_id_hint FROM control_plane.trips WHERE id = $1",
        [fix.draftTripId],
      );
      assert.equal(tripRow.rows[0]?.notification_chat_id_hint, null);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("startSession: omitted telegramChatIdHint leaves the trip's hint null", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const result = await startSession(fix.pool, token);
      assert.equal(result.ok, true);

      const tripRow = await fix.pool.query<{ notification_chat_id_hint: string | null }>(
        "SELECT notification_chat_id_hint FROM control_plane.trips WHERE id = $1",
        [fix.draftTripId],
      );
      assert.equal(tripRow.rows[0]?.notification_chat_id_hint, null);
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

  test("optionalRemaining lists the optional questions still outstanding", { skip: SKIP }, async () => {
    // The interviewer reads this to know what is still open. Since 0034 the
    // router also walks these itself once the required ones are done — this
    // list is what tells both of them which questions are left.
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

  test("skipping an optional question retires it and moves the interview on", { skip: SKIP }, async () => {
    // Without a skip an optional question has only one exit — answering it —
    // which is how "optional" became "mandatory" for an organizer who did not
    // want to discuss dietary restrictions at all.
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");
      await answerAllRequiredQuestions(fix.pool, started.sessionToken);

      const nominated = await nominateQuestionForChat(fix.pool, CHAT_ID, "trip_pace");
      if (!nominated.ok) throw new Error("unreachable");
      assert.equal(nominated.view.pendingAsk?.id, "trip_pace", "the router asks what the agent nominated");

      const after = await skipQuestionForChat(fix.pool, CHAT_ID, "trip_pace");
      assert.equal(after.ok, true);
      if (!after.ok) throw new Error("unreachable");
      assert.equal(after.view.pendingAsk, null, "a skipped question is not left queued");
      assert.ok(
        !after.view.optionalRemaining.some((q) => q.id === "trip_pace"),
        "and it stops being listed as outstanding",
      );

      // Skipping is for optional questions only: a skipped required question
      // would derive to awaiting_confirmation and then fail at CONFIRM, which
      // reads as the interview breaking at the last step.
      const refused = await skipQuestionForChat(fix.pool, CHAT_ID, "destination");
      assert.equal(refused.ok, false);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("a burst of agent writes produces one prompt, not one per answer", { skip: SKIP }, async () => {
    // Run 6: the agent recorded a document's worth of answers, each write
    // scheduled a prompt, and the organizer got nine messages in a row.
    // Deduplication cannot help — every write genuinely produces a different
    // next question — so the router waits for the writing to stop.
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");

      // The agent writes through the turn the router opened for it — same
      // authority as every other chat-scoped write.
      await openAgentTurn(fix.pool, CHAT_ID, started.sessionId);
      await submitAnswerForAgent(fix.pool, CHAT_ID, "trip_type", "family");
      await submitAnswerForAgent(fix.pool, CHAT_ID, "destination", null, "Japan");
      await submitAnswerForAgent(fix.pool, CHAT_ID, "departure_date", null, "2026-09-19");

      // Mid-burst: three writes, and the router has said nothing.
      assert.deepEqual(await claimDueRouterPrompts(fix.pool), [], "silent while it is still writing");

      // Once the burst settles, exactly one claim — for the session, not per write.
      const settled = await claimDueRouterPrompts(fix.pool, 10, 0);
      assert.equal(settled.length, 1);
      assert.equal(settled[0]?.chatId, CHAT_ID);

      // And claiming consumes it: nothing owed until the next write.
      assert.deepEqual(await claimDueRouterPrompts(fix.pool, 10, 0), []);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("the router will not repeat itself, and will not stack turns on the agent", { skip: SKIP }, async () => {
    // Run 5's bombardment, as two properties. Every agent write asks the router
    // to speak, so an agent recording five answers off one document asked five
    // times; and the handback opened a turn on an agent that already had one,
    // whose next write asked again. Nine turns, twenty-eight messages.
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");

      const view = await getSessionForChat(fix.pool, CHAT_ID);
      if (!view.ok) throw new Error("unreachable");
      const first = view.view.nextQuestion!.id;
      assert.equal(view.view.lastPrompt, null, "nothing said yet");

      await recordLastPromptForChat(fix.pool, CHAT_ID, `q:${first}`);
      const after = await getSessionForChat(fix.pool, CHAT_ID);
      if (!after.ok) throw new Error("unreachable");
      assert.equal(after.view.lastPrompt, `q:${first}`);
      assert.equal(after.view.nextQuestion?.id, first, "same question still pending — so it is a repeat");

      // Answering moves it on, which is what makes the next send legitimate.
      await submitAnswer(fix.pool, started.sessionToken, "trip_type", "family");
      const moved = await getSessionForChat(fix.pool, CHAT_ID);
      if (!moved.ok) throw new Error("unreachable");
      assert.notEqual(moved.view.nextQuestion?.id, first);
      assert.equal(moved.view.lastPrompt, `q:${first}`, "the memory survives the answer");

      // And the turn guard: with one open, the router must not open another.
      assert.equal(await hasOpenAgentTurn(fix.pool, CHAT_ID), false);
      await openAgentTurn(fix.pool, CHAT_ID, started.sessionId);
      assert.equal(await hasOpenAgentTurn(fix.pool, CHAT_ID), true);
      await closeAgentTurn(fix.pool, CHAT_ID);
      assert.equal(await hasOpenAgentTurn(fix.pool, CHAT_ID), false, "and it frees up once closed");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("the organizer can reach the summary without the interviewer's help", { skip: SKIP }, async () => {
    // The safety net for the run-4 failure: the interviewer fumbled its tool
    // call, told the organizer the interview could not continue, and no button
    // anywhere could move them on. Pacing is the agent's job; being STUCK must
    // never be its consequence.
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");
      await answerAllRequiredQuestions(fix.pool, started.sessionToken);

      const more = await askForMoreForChat(fix.pool, CHAT_ID);
      if (!more.ok) throw new Error("unreachable");
      assert.ok(more.view.pendingAsk, "a question is queued without the agent nominating one");
      const first = more.view.pendingAsk!.id;

      // Skipping and asking again walks forward rather than re-offering it.
      await skipQuestionForChat(fix.pool, CHAT_ID, first);
      const second = await askForMoreForChat(fix.pool, CHAT_ID);
      if (!second.ok) throw new Error("unreachable");
      assert.notEqual(second.view.pendingAsk?.id, first);

      // The boundary offer is shown once, not after every optional answer.
      assert.equal(second.view.offeredMore, false);
      await markOfferedMoreForChat(fix.pool, CHAT_ID);
      const marked = await getSessionForChat(fix.pool, CHAT_ID);
      if (!marked.ok) throw new Error("unreachable");
      assert.equal(marked.view.offeredMore, true);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("asking for more when nothing is left goes to the summary, not nowhere", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");
      await answerAllRequiredQuestions(fix.pool, started.sessionToken);

      const view = await getSessionForChat(fix.pool, CHAT_ID);
      if (!view.ok) throw new Error("unreachable");
      for (const q of view.view.optionalRemaining) {
        await skipQuestionForChat(fix.pool, CHAT_ID, q.id);
      }

      const result = await askForMoreForChat(fix.pool, CHAT_ID);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.view.state, "awaiting_confirmation");
      assert.ok(result.view.recap, "it lands on the recap rather than a dead end");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("the interviewer chooses which optional question is asked, and when", { skip: SKIP }, async () => {
    // The two failures this sits between, both from live runs on 2026-09-04:
    // run 2 never asked an optional question at all, and run 3 asked every one
    // of them in schema order — a form, which is the thing this interview is
    // explicitly not. Selection is the agent's (it is in the conversation),
    // rendering is the router's (only it can draw a keyboard).
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");
      await answerAllRequiredQuestions(fix.pool, started.sessionToken);

      const idle = await getSessionForChat(fix.pool, CHAT_ID);
      if (!idle.ok) throw new Error("unreachable");
      assert.equal(idle.view.pendingAsk, null, "nothing is queued on its own");

      // Out of schema order on purpose: dietary is not the first optional
      // question, and the agent asking for it is the whole point.
      const nominated = await nominateQuestionForChat(fix.pool, CHAT_ID, "dietary");
      if (!nominated.ok) throw new Error("unreachable");
      assert.equal(nominated.view.pendingAsk?.id, "dietary");

      // Asking for it again after a decline un-skips it: an explicit request is
      // a clearer signal than the earlier "not now".
      await skipQuestionForChat(fix.pool, CHAT_ID, "dietary");
      const again = await nominateQuestionForChat(fix.pool, CHAT_ID, "dietary");
      if (!again.ok) throw new Error("unreachable");
      assert.equal(again.view.pendingAsk?.id, "dietary");

      // And a nomination reopens an interview the organizer had finished.
      await setFinishRequestedForChat(fix.pool, CHAT_ID, true);
      const reopened = await nominateQuestionForChat(fix.pool, CHAT_ID, "trip_pace");
      if (!reopened.ok) throw new Error("unreachable");
      assert.equal(reopened.view.state, "interviewing");
      assert.equal(reopened.view.pendingAsk?.id, "trip_pace");

      const unknown = await nominateQuestionForChat(fix.pool, CHAT_ID, "not_a_question");
      assert.equal(unknown.ok, false);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("'that's everything' ends the questions; 'keep planning' reopens them", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");
      await answerAllRequiredQuestions(fix.pool, started.sessionToken);

      const finished = await setFinishRequestedForChat(fix.pool, CHAT_ID, true);
      if (!finished.ok) throw new Error("unreachable");
      assert.equal(finished.view.state, "awaiting_confirmation");
      assert.equal(finished.view.nextQuestion, null);
      assert.ok(finished.view.recap, "the recap is what awaiting_confirmation is for");

      // The regression this exists for: Keep planning used to print a sentence
      // and leave the state alone, so the recap came straight back on the next
      // answer and the organizer was stuck in it.
      const reopened = await setFinishRequestedForChat(fix.pool, CHAT_ID, false);
      if (!reopened.ok) throw new Error("unreachable");
      assert.equal(reopened.view.state, "interviewing");
      assert.ok(reopened.view.optionalRemaining.length > 0, "and there are questions to go back to");
    } finally {
      await teardownFixture(fix);
    }
  });


  test("Telegram's own locale draws the first message before the agent reports one", { skip: SKIP }, async () => {
    // The file acknowledgement exists to arrive BEFORE the model has read
    // anything — so it cannot wait for the interviewer to report a language.
    // On the 2026-09-04 run 4 it went out in English for exactly that reason.
    // Telegram hands us the sender's client locale on the first update, so the
    // router has something to draw with from the very first message.
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID, "he-IL");
      if (!started.ok) throw new Error("unreachable");
      assert.equal(started.view.language, "he");

      // A hint, not a decision: it is the phone's setting, not what the
      // organizer typed, so the interviewer's report still wins.
      const corrected = await setLanguageForChat(fix.pool, CHAT_ID, "en");
      if (!corrected.ok) throw new Error("unreachable");
      assert.equal(corrected.view.language, "en");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("an absent or unknown locale leaves the interview in English, not broken", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID, "zz-QQ");
      if (!started.ok) throw new Error("unreachable");
      assert.equal(started.view.language, "en");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("the interview's language drives everything the router draws", { skip: SKIP }, async () => {
    // The agent speaks whatever the organizer writes; the router draws the
    // buttons and the recap and had no idea what that was, so it drew English
    // always. One live interview alternated languages message by message.
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");
      assert.equal(started.view.language, "en", "English until the agent says otherwise");

      const set = await setLanguageForChat(fix.pool, CHAT_ID, "he");
      if (!set.ok) throw new Error("unreachable");
      assert.equal(set.view.language, "he");

      // Whatever the model actually sends — "Hebrew", "he-IL" — resolves to the
      // same language rather than silently leaving the interview in English.
      const messy = await setLanguageForChat(fix.pool, CHAT_ID, "he-IL");
      if (!messy.ok) throw new Error("unreachable");
      assert.equal(messy.view.language, "he");

      // A language nobody has translated is refused rather than stored: it
      // would render as English anyway, and storing it would make a missing
      // translation look like a broken one.
      assert.equal((await setLanguageForChat(fix.pool, CHAT_ID, "klingon")).ok, false);

      await answerAllRequiredQuestions(fix.pool, started.sessionToken);
      const done = await setFinishRequestedForChat(fix.pool, CHAT_ID, true);
      if (!done.ok) throw new Error("unreachable");
      const recap = done.view.recap!;
      const stops = recap.find((e) => e.questionId === "phases")!;
      assert.equal(stops.prompt, "תחנות", "recap lines are named in the interview's language");
      // And the agent-facing spec never reaches the confirmation screen.
      assert.ok(!recap.some((e) => e.prompt.includes("Dallas")), "no field spec in the recap");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("a multi-select accumulates taps, and 'none' is exclusive", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const token = await issuedEnrollmentToken(fix);
      const started = await startSession(fix.pool, token, () => {}, undefined, CHAT_ID);
      if (!started.ok) throw new Error("unreachable");
      await answerAllRequiredQuestions(fix.pool, started.sessionToken);

      // Each tap carries one option; the answer is the whole set. Recording a
      // tap as the answer would lose every earlier selection.
      const one = await toggleMultiChoiceForChat(fix.pool, CHAT_ID, "dietary", "vegetarian");
      if (!one.ok) throw new Error("unreachable");
      const two = await toggleMultiChoiceForChat(fix.pool, CHAT_ID, "dietary", "gluten_free");
      if (!two.ok) throw new Error("unreachable");
      assert.deepEqual(
        selectedOptionIds(two.view, "dietary").sort(),
        ["gluten_free", "vegetarian"],
      );

      // Tapping a selected option again removes it.
      const off = await toggleMultiChoiceForChat(fix.pool, CHAT_ID, "dietary", "vegetarian");
      if (!off.ok) throw new Error("unreachable");
      assert.deepEqual(selectedOptionIds(off.view, "dietary"), ["gluten_free"]);

      // "None of these" alongside "gluten-free" is not a preference anyone
      // holds; it would hand the trip assistant a contradiction.
      const none = await toggleMultiChoiceForChat(fix.pool, CHAT_ID, "dietary", "none");
      if (!none.ok) throw new Error("unreachable");
      assert.deepEqual(selectedOptionIds(none.view, "dietary"), ["none"]);

      const back = await toggleMultiChoiceForChat(fix.pool, CHAT_ID, "dietary", "vegan");
      if (!back.ok) throw new Error("unreachable");
      assert.deepEqual(selectedOptionIds(back.view, "dietary"), ["vegan"], "and picking one drops 'none'");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("optional questions never gate confirmation, but do keep the interview open", { skip: SKIP }, async () => {
    // Two properties that pull in opposite directions and both have to hold.
    //
    // The interview stays OPEN while optional questions remain — before 0034
    // the last required answer flipped it to awaiting_confirmation, the router
    // sent the recap over whatever was being asked, and every optional
    // question was unreachable (2026-09-04 run 2).
    //
    // Confirmation is still gated on the REQUIRED set alone, so an organizer
    // who wants none of it can finish anyway.
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
      assert.equal(view.view.state, "interviewing", "still collecting the optional answers");
      // The router asks no optional question on its own — the interviewer
      // nominates one. Both halves are asserted in "the interviewer chooses…".
      assert.equal(view.view.nextQuestion, null, "no required question is outstanding");
      assert.equal(view.view.pendingAsk, null, "and none is queued until the agent asks for it");
      assert.ok(view.view.optionalRemaining.length > 0, "still offering the unanswered optional questions");

      const confirmed = await confirmIntake(fix.pool, started.sessionToken);
      assert.equal(confirmed.ok, true, "unanswered optional questions must not block CONFIRM");
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

  test("submitAnswer: the last required answer leaves the interview open for the optional ones", { skip: SKIP }, async () => {
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
      // Answering the last REQUIRED question no longer ends the interview.
      // Before 0034 it did, and the router — which re-asks whatever the state
      // implies after every write — sent the confirm recap on top of whatever
      // was being asked next, permanently.
      assert.equal(last.view.state, "interviewing");
      assert.equal(last.view.nextQuestion, null, "no required question left");
      assert.ok(last.view.optionalRemaining.length > 0, "and the optional ones are still open");
      assert.equal(last.view.recap, null, "no recap until the organizer is finished");
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
      assert.notEqual(sessionRow.rows[0]?.state, "confirmed", "the rejected CONFIRM wrote nothing");
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
      assert.notEqual(sessionRow.rows[0]?.state, "confirmed", "the rejected CONFIRM wrote nothing");
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
