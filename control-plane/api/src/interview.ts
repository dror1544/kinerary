import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { consumeEnrollmentInTx } from "./enrollment.js";
import { structuredLog } from "./redaction.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sessionTokenDigest(token: string): string {
  return `sha256:${sha256hex(token)}`;
}

// ── Question schema (versioned) ──────────────────────────────────────────────

export const INTAKE_SCHEMA_VERSION = 1;

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface IntakeQuestion {
  id: string;
  type: "choice" | "text";
  prompt: string;
  options?: ChoiceOption[];  // present for 'choice' questions
  allowsOther?: boolean;     // choice only: enables the 'other' follow-up
  otherPrompt?: string;      // follow-up prompt shown when 'other' is chosen
  maxLength?: number;        // max chars for text/other answers
  required: boolean;
}

export const INTAKE_QUESTIONS_V1: readonly IntakeQuestion[] = [
  {
    id: "trip_type",
    type: "choice",
    prompt: "What type of trip is this?",
    options: [
      { id: "family", label: "Family" },
      { id: "group_of_families", label: "Group of families" },
      { id: "couple", label: "Couple" },
    ],
    allowsOther: true,
    otherPrompt: "Describe the trip type briefly (max 120 chars):",
    maxLength: 120,
    required: true,
  },
  {
    id: "destination",
    type: "text",
    prompt: "Where is the trip? (city/region/country)",
    maxLength: 200,
    required: true,
  },
  {
    id: "group_size",
    type: "choice",
    prompt: "How many travelers?",
    options: [
      { id: "2", label: "2 people" },
      { id: "3_to_5", label: "3–5 people" },
      { id: "6_to_10", label: "6–10 people" },
      { id: "more_than_10", label: "More than 10" },
    ],
    allowsOther: true,
    otherPrompt: "Enter the number or range of travelers (max 40 chars):",
    maxLength: 40,
    required: true,
  },
  {
    id: "trip_duration",
    type: "choice",
    prompt: "How long will the trip be?",
    options: [
      { id: "weekend", label: "Weekend (2–3 days)" },
      { id: "week", label: "About a week" },
      { id: "two_weeks", label: "Two weeks" },
      { id: "month_or_more", label: "A month or more" },
    ],
    allowsOther: true,
    otherPrompt: "Describe the duration (max 80 chars):",
    maxLength: 80,
    required: true,
  },
  {
    id: "trip_interests",
    type: "text",
    prompt: "Any specific interests or must-sees? (optional — press skip to continue)",
    maxLength: 500,
    required: false,
  },
] as const;

// ── Answer store ─────────────────────────────────────────────────────────────

export interface ChoiceAnswer {
  kind: "choice";
  option_id: string;
  schema_version: number;
  other_text: null;
}

export interface OtherAnswer {
  kind: "choice_other";
  option_id: null;
  schema_version: number;
  other_text: string;
}

export interface TextAnswer {
  kind: "text";
  schema_version: number;
  text: string;
}

export type IntakeAnswer = ChoiceAnswer | OtherAnswer | TextAnswer;

export type AnswerStore = Record<string, IntakeAnswer>;

// ── Validation helpers ────────────────────────────────────────────────────────

export type AnswerValidationResult =
  | { ok: true; answer: IntakeAnswer }
  | { ok: false; reason: "UNKNOWN_QUESTION" | "UNKNOWN_OPTION" | "OTHER_TEXT_REQUIRED" | "OTHER_NOT_ALLOWED" | "TEXT_TOO_LONG" | "TEXT_REQUIRED" | "CHOICE_REQUIRED" | "SESSION_CONFIRMED" };

export function validateAnswer(
  questionId: string,
  optionId: string | "other" | null,
  otherText: string | null | undefined,
  questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS_V1,
): AnswerValidationResult {
  const question = questions.find((q) => q.id === questionId);
  if (!question) return { ok: false, reason: "UNKNOWN_QUESTION" };

  if (question.type === "choice") {
    if (optionId === "other") {
      if (!question.allowsOther) return { ok: false, reason: "OTHER_NOT_ALLOWED" };
      const text = otherText?.trim() ?? "";
      if (text.length === 0) return { ok: false, reason: "OTHER_TEXT_REQUIRED" };
      const max = question.maxLength ?? 500;
      if (text.length > max) return { ok: false, reason: "TEXT_TOO_LONG" };
      return {
        ok: true,
        answer: { kind: "choice_other", option_id: null, schema_version: INTAKE_SCHEMA_VERSION, other_text: text },
      };
    }
    if (!optionId) return { ok: false, reason: "CHOICE_REQUIRED" };
    const match = question.options?.find((o) => o.id === optionId);
    if (!match) return { ok: false, reason: "UNKNOWN_OPTION" };
    return {
      ok: true,
      answer: { kind: "choice", option_id: optionId, schema_version: INTAKE_SCHEMA_VERSION, other_text: null },
    };
  }

  // type === "text"
  const text = (optionId === null ? otherText : optionId) ?? "";
  const trimmed = text.trim();
  if (question.required && trimmed.length === 0) return { ok: false, reason: "TEXT_REQUIRED" };
  const max = question.maxLength ?? 500;
  if (trimmed.length > max) return { ok: false, reason: "TEXT_TOO_LONG" };
  return {
    ok: true,
    answer: { kind: "text", schema_version: INTAKE_SCHEMA_VERSION, text: trimmed },
  };
}

// ── Intake digest ─────────────────────────────────────────────────────────────

/** Canonical JSON serialisation of the intake for digest computation. */
function canonicalIntakePayload(tripId: string, answers: AnswerStore): string {
  const questionIds = INTAKE_QUESTIONS_V1.map((q) => q.id);
  const orderedAnswers: Record<string, unknown> = {};
  for (const qid of questionIds) {
    if (answers[qid] !== undefined) orderedAnswers[qid] = answers[qid];
  }
  return JSON.stringify({
    schema_version: INTAKE_SCHEMA_VERSION,
    trip_id: tripId,
    answers: orderedAnswers,
  });
}

export function computeIntakeDigest(tripId: string, answers: AnswerStore): string {
  const payload = canonicalIntakePayload(tripId, answers);
  return `sha256:${sha256hex(payload)}`;
}

// ── Recap ─────────────────────────────────────────────────────────────────────

export interface RecapEntry {
  questionId: string;
  prompt: string;
  answerLabel: string;
}

/**
 * Returns a human-readable recap of the current answers. For 'other' answers
 * the literal organizer text is shown; it is never reclassified or summarized.
 */
export function buildRecap(answers: AnswerStore, questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS_V1): RecapEntry[] {
  return questions
    .filter((q) => answers[q.id] !== undefined)
    .map((q) => {
      const ans = answers[q.id]!;
      let answerLabel: string;
      if (ans.kind === "choice") {
        answerLabel = q.options?.find((o) => o.id === ans.option_id)?.label ?? ans.option_id;
      } else if (ans.kind === "choice_other") {
        answerLabel = `Other: ${ans.other_text}`;
      } else {
        answerLabel = ans.text || "(skipped)";
      }
      return { questionId: q.id, prompt: q.prompt, answerLabel };
    });
}

// ── Session state ─────────────────────────────────────────────────────────────

export type SessionState = "interviewing" | "awaiting_confirmation" | "confirmed";

export interface SessionView {
  sessionId: string;
  tripId: string;
  state: SessionState;
  /** The next unanswered required question, or null when all required questions are answered. */
  nextQuestion: IntakeQuestion | null;
  /** Set when state is 'awaiting_confirmation': the recap for the organizer to review. */
  recap: RecapEntry[] | null;
}

function nextUnansweredQuestion(answers: AnswerStore, questions: readonly IntakeQuestion[]): IntakeQuestion | null {
  return questions.find((q) => q.required && answers[q.id] === undefined) ?? null;
}

function deriveSessionState(answers: AnswerStore, questions: readonly IntakeQuestion[]): SessionState {
  const allRequired = questions.filter((q) => q.required);
  const allAnswered = allRequired.every((q) => answers[q.id] !== undefined);
  return allAnswered ? "awaiting_confirmation" : "interviewing";
}

// ── Public API ────────────────────────────────────────────────────────────────

export type StartSessionResult =
  | { ok: true; sessionId: string; sessionToken: string; view: SessionView }
  | { ok: false; reason: "INVALID_TOKEN" | "EXPIRED" | "ALREADY_CONSUMED" | "REVOKED" | "TRIP_NOT_DRAFT" };

export type GetSessionResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: "NOT_FOUND" };

export type SubmitAnswerResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: "NOT_FOUND" | "SESSION_CONFIRMED" | "UNKNOWN_QUESTION" | "UNKNOWN_OPTION" | "OTHER_TEXT_REQUIRED" | "OTHER_NOT_ALLOWED" | "TEXT_TOO_LONG" | "TEXT_REQUIRED" | "CHOICE_REQUIRED" };

export type ConfirmIntakeResult =
  | { ok: true; sessionId: string; intakeVersionId: string; digest: string; versionNumber: number }
  | { ok: false; reason: "NOT_FOUND" | "NOT_ALL_REQUIRED_ANSWERED" };

/**
 * Exchanges a valid enrollment token for a session, atomically:
 *   1. Verifies and consumes the enrollment (FOR UPDATE lock)
 *   2. Transitions the trip from 'draft' → 'intake_in_progress'
 *   3. Creates the intake_sessions row with a fresh session token
 *
 * Returns the session ID and raw session token. The raw token is not stored —
 * only its SHA-256 digest is. Subsequent session API calls must present this
 * token to be authenticated.
 */
export async function startSession(
  db: pg.Pool,
  rawEnrollmentToken: string,
  log: (line: string) => void = () => {},
): Promise<StartSessionResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const enrollment = await consumeEnrollmentInTx(client, rawEnrollmentToken);
    if (!enrollment) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "INVALID_TOKEN" };
    }

    // Verify the trip is still in 'draft' (enrollment could be issued and
    // the trip could have moved if something went wrong on a prior attempt).
    const tripRow = await client.query<{ lifecycle_state: string }>(
      "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE",
      [enrollment.tripId],
    );
    const [trip] = tripRow.rows;
    if (!trip || trip.lifecycle_state !== "draft") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "TRIP_NOT_DRAFT" };
    }

    // Transition trip to 'intake_in_progress'.
    await client.query(
      "UPDATE control_plane.trips SET lifecycle_state = 'intake_in_progress', updated_at = now() WHERE id = $1",
      [enrollment.tripId],
    );

    // Create session with a fresh token.
    const rawSessionToken = randomBytes(32).toString("base64url");
    const digest = sessionTokenDigest(rawSessionToken);
    const sessionId = generateId("sess");

    await client.query(
      `INSERT INTO control_plane.intake_sessions
         (id, trip_id, user_id, enrollment_id, session_token_digest, state, answers)
       VALUES ($1, $2, $3, $4, $5, 'interviewing', '{}'::jsonb)`,
      [sessionId, enrollment.tripId, enrollment.userId, enrollment.enrollmentId, digest],
    );

    await client.query("COMMIT");

    log(structuredLog("info", "interview.session_started", { session_id: sessionId, trip_id: enrollment.tripId }));

    const view: SessionView = {
      sessionId,
      tripId: enrollment.tripId,
      state: "interviewing",
      nextQuestion: INTAKE_QUESTIONS_V1.find((q) => q.required) ?? null,
      recap: null,
    };
    return { ok: true, sessionId, sessionToken: rawSessionToken, view };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Looks up a session by its bearer token and returns the current view.
 * The session token is the sole credential — it was bound to one user and one
 * trip at issuance time, so no additional identity check is required.
 */
export async function getSession(
  db: pg.Pool,
  rawSessionToken: string,
): Promise<GetSessionResult> {
  const digest = sessionTokenDigest(rawSessionToken);
  const row = await db.query<{
    id: string;
    trip_id: string;
    user_id: string;
    state: SessionState;
    answers: AnswerStore;
  }>(
    `SELECT id, trip_id, user_id, state, answers
     FROM control_plane.intake_sessions
     WHERE session_token_digest = $1`,
    [digest],
  );
  const [session] = row.rows;
  if (!session) return { ok: false, reason: "NOT_FOUND" };

  return { ok: true, view: buildSessionView(session.id, session.trip_id, session.state, session.answers) };
}

function buildSessionView(
  sessionId: string,
  tripId: string,
  storedState: SessionState,
  answers: AnswerStore,
): SessionView {
  if (storedState === "confirmed") {
    return { sessionId, tripId, state: "confirmed", nextQuestion: null, recap: null };
  }
  const state = deriveSessionState(answers, INTAKE_QUESTIONS_V1);
  return {
    sessionId,
    tripId,
    state,
    nextQuestion: state === "interviewing" ? nextUnansweredQuestion(answers, INTAKE_QUESTIONS_V1) : null,
    recap: state === "awaiting_confirmation" ? buildRecap(answers) : null,
  };
}

/**
 * Submits an answer to a question in an active session.
 *
 * For choice questions: pass the option id (e.g. "family") or "other" plus
 * the free-text follow-up in otherText.
 * For text questions: pass the text in optionId (the same parameter slot,
 * since it's the primary answer value).
 *
 * The session must not be confirmed. A second submission for the same question
 * overwrites the previous answer (corrections are allowed before CONFIRM).
 */
export async function submitAnswer(
  db: pg.Pool,
  rawSessionToken: string,
  questionId: string,
  optionId: string | "other" | null,
  otherText?: string,
  expectedSessionId?: string,
): Promise<SubmitAnswerResult> {
  const digest = sessionTokenDigest(rawSessionToken);
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const row = await client.query<{
      id: string;
      trip_id: string;
      user_id: string;
      state: SessionState;
      answers: AnswerStore;
    }>(
      `SELECT id, trip_id, user_id, state, answers
       FROM control_plane.intake_sessions
       WHERE session_token_digest = $1 AND ($2::text IS NULL OR id = $2)
       FOR UPDATE`,
      [digest, expectedSessionId ?? null],
    );
    const [session] = row.rows;
    if (!session) { await client.query("ROLLBACK"); return { ok: false, reason: "NOT_FOUND" }; }
    if (session.state === "confirmed") { await client.query("ROLLBACK"); return { ok: false, reason: "SESSION_CONFIRMED" }; }

    const validation = validateAnswer(questionId, optionId, otherText);
    if (!validation.ok) {
      await client.query("ROLLBACK");
      return { ok: false, reason: validation.reason };
    }

    const updatedAnswers = { ...session.answers, [questionId]: validation.answer };
    const newState = deriveSessionState(updatedAnswers, INTAKE_QUESTIONS_V1);

    await client.query(
      "UPDATE control_plane.intake_sessions SET answers = $1, state = $2, updated_at = now() WHERE id = $3",
      [JSON.stringify(updatedAnswers), newState, session.id],
    );

    await client.query("COMMIT");

    return { ok: true, view: buildSessionView(session.id, session.trip_id, newState, updatedAnswers) };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Confirms the intake: creates an immutable intake_versions row and transitions
 * the trip to 'intake_confirmed'. Idempotent: a second CONFIRM returns the
 * existing version without creating a duplicate.
 *
 * The session token remains valid after confirmation so the caller can call
 * CONFIRM a second time and get the same result. Answer writes are blocked by
 * the SESSION_CONFIRMED guard in submitAnswer.
 */
export async function confirmIntake(
  db: pg.Pool,
  rawSessionToken: string,
  log: (line: string) => void = () => {},
  expectedSessionId?: string,
): Promise<ConfirmIntakeResult> {
  const digest = sessionTokenDigest(rawSessionToken);
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const row = await client.query<{
      id: string;
      trip_id: string;
      user_id: string;
      state: SessionState;
      answers: AnswerStore;
    }>(
      `SELECT id, trip_id, user_id, state, answers
       FROM control_plane.intake_sessions
       WHERE session_token_digest = $1 AND ($2::text IS NULL OR id = $2)
       FOR UPDATE`,
      [digest, expectedSessionId ?? null],
    );
    const [session] = row.rows;
    if (!session) { await client.query("ROLLBACK"); return { ok: false, reason: "NOT_FOUND" }; }

    // Idempotency: already confirmed — return the existing intake version.
    if (session.state === "confirmed") {
      const existing = await client.query<{ id: string; version: number; digest: string }>(
        "SELECT id, version, digest FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
        [session.trip_id],
      );
      await client.query("ROLLBACK");
      const [ver] = existing.rows;
      if (!ver) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, sessionId: session.id, intakeVersionId: ver.id, digest: ver.digest, versionNumber: ver.version };
    }

    // All required questions must be answered.
    const allRequired = INTAKE_QUESTIONS_V1.filter((q) => q.required);
    const allAnswered = allRequired.every((q) => session.answers[q.id] !== undefined);
    if (!allAnswered) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_ALL_REQUIRED_ANSWERED" };
    }

    // Compute the digest and determine the next version number.
    const intakeDigest = computeIntakeDigest(session.trip_id, session.answers);
    const versionRow = await client.query<{ max: number | null }>(
      "SELECT MAX(version) AS max FROM control_plane.intake_versions WHERE trip_id = $1",
      [session.trip_id],
    );
    const nextVersion = (versionRow.rows[0]?.max ?? 0) + 1;
    const versionId = generateId("intk");
    const artifactRef = `intake:sessions:${session.id}:v${nextVersion}`;

    await client.query(
      `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version, data)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb)`,
      [versionId, session.trip_id, nextVersion, artifactRef, intakeDigest, INTAKE_SCHEMA_VERSION, JSON.stringify(session.answers)],
    );

    // Transition trip to 'intake_confirmed'.
    await client.query(
      "UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed', updated_at = now() WHERE id = $1",
      [session.trip_id],
    );

    // Mark session confirmed. Token remains valid for idempotent re-confirmation.
    await client.query(
      "UPDATE control_plane.intake_sessions SET state = 'confirmed', updated_at = now() WHERE id = $1",
      [session.id],
    );

    await client.query("COMMIT");

    log(structuredLog("info", "interview.confirmed", {
      session_id: session.id,
      trip_id: session.trip_id,
      intake_version_id: versionId,
      version: nextVersion,
    }));

    return { ok: true, sessionId: session.id, intakeVersionId: versionId, digest: intakeDigest, versionNumber: nextVersion };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Looks up a session by its ID (not token) for the confirmed-idempotency path
 * and status display. Does not expose answers or transcripts — returns only
 * lifecycle state and the intake version if confirmed.
 */
export async function getSessionStatus(
  db: pg.Pool,
  sessionId: string,
  userId: string,
): Promise<
  | { ok: true; state: SessionState; intakeVersionId?: string; digest?: string }
  | { ok: false; reason: "NOT_FOUND" | "WRONG_USER" }
> {
  const row = await db.query<{ user_id: string; trip_id: string; state: SessionState }>(
    "SELECT user_id, trip_id, state FROM control_plane.intake_sessions WHERE id = $1",
    [sessionId],
  );
  const [session] = row.rows;
  if (!session) return { ok: false, reason: "NOT_FOUND" };
  if (session.user_id !== userId) return { ok: false, reason: "WRONG_USER" };

  if (session.state === "confirmed") {
    const ver = await db.query<{ id: string; digest: string }>(
      "SELECT id, digest FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
      [session.trip_id],
    );
    const [v] = ver.rows;
    return {
      ok: true,
      state: "confirmed",
      intakeVersionId: v?.id,
      digest: v?.digest,
    };
  }

  return { ok: true, state: session.state };
}
