import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { assertCanonicalRecordSafe, UnsafeCanonicalRecordError } from "./canonical.js";
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

// Bumped to 2 when the persona/dietary/pace questions and the 'multi_choice'
// type landed. Nothing branches on this at read time — a stored answer's
// schema_version records which question set produced it, and an answer of
// kind 'multi_choice' could not have come from v1. Releases advertise the
// range they accept via releases.data_schema_min/max, so a bump here needs a
// matching widening there or generatePlan finds no eligible release.
export const INTAKE_SCHEMA_VERSION = 2;

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface IntakeQuestion {
  id: string;
  type: "choice" | "multi_choice" | "text" | "structured";
  prompt: string;
  options?: ChoiceOption[];  // present for 'choice' and 'multi_choice' questions
  allowsOther?: boolean;     // choice only: enables the 'other' follow-up
  otherPrompt?: string;      // follow-up prompt shown when 'other' is chosen
  maxLength?: number;        // max chars for text/other answers
  // structured only: the interviewer submits a JSON payload rather than a
  // string; this only checks the JSON's top-level shape (list vs. object),
  // not a full schema — the interviewer is a capable LLM assembling this
  // from conversation, not a form validating untrusted input.
  dataShape?: "array" | "object";
  required: boolean;
}

export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
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
  // No date format in either prompt, deliberately. The interviewer resolves
  // whatever the organizer says into YYYY-MM-DD before submitting, and
  // confirms its reading back in words ("so departure September 6th?") —
  // that is what catches DD/MM vs MM/DD ambiguity. Naming a format here just
  // leaks an implementation detail at a non-technical organizer.
  {
    id: "departure_date",
    type: "text",
    prompt: "What day does the trip start?",
    maxLength: 40,
    required: true,
  },
  {
    id: "return_date",
    type: "text",
    prompt: "What day does everyone head home?",
    maxLength: 40,
    required: true,
  },
  {
    id: "timezone",
    type: "text",
    prompt: "What timezone should times be shown in? (e.g. Asia/Tokyo, or just the destination city — optional, we can infer it)",
    maxLength: 100,
    required: false,
  },
  {
    id: "travelers",
    type: "structured",
    prompt: "Who's coming? List each person's name, age, and family/household group.",
    dataShape: "array",
    required: true,
  },
  {
    id: "phases",
    type: "structured",
    prompt: "Where are you going, and when? List each stop: a short place name (city or region — e.g. \"Dallas\", not \"Dallas (boys; Mavericks game September 6)\"), date range, and accommodation (with confirmation number) if already booked. Keep any extra context — who's on this leg, an event, a plan detail — out of the name; it's fine to just not record it structurally.",
    dataShape: "array",
    required: true,
  },
  {
    id: "travel_anchors",
    type: "structured",
    prompt: "Any flights, hotels, or cars already booked? List them with confirmation numbers. (optional — skip if nothing's booked yet)",
    dataShape: "array",
    required: false,
  },
  {
    id: "constraints",
    type: "structured",
    prompt: "Anything the group needs to know about — mobility needs, budget expectations, or family dynamics? (optional)",
    dataShape: "object",
    required: false,
  },

  // ── Everything below is optional and tap-answerable ───────────────────────
  // These restore what the older human-driven interview
  // (.agents/skills/create-trip/INTERVIEW.md §9) collected and this one had
  // dropped. None of them block confirmation; they surface to the interviewer
  // through SessionView.optionalRemaining, not nextQuestion.
  //
  // None of the choice questions below set allowsOther. Their answers become
  // bilingual {he,en} strings in trip.config.json (participants[].needs[].text,
  // agent.standing_instructions[].text), and a free-text 'other' would only
  // ever be in the one language the organizer typed. Anything off-menu belongs
  // in bot_limits, which is structured and bilingual by construction.
  {
    id: "trip_pace",
    type: "choice",
    prompt: "What pace suits this group?",
    options: [
      { id: "easygoing", label: "Easygoing — late starts, few things a day" },
      { id: "balanced", label: "Balanced — a main plan a day, room to drift" },
      { id: "intense", label: "Intense — early starts, pack it in" },
    ],
    required: false,
  },
  {
    id: "dietary",
    type: "multi_choice",
    prompt: "Does any of this apply to anyone travelling? (tap all that apply)",
    options: [
      { id: "none", label: "None of these" },
      { id: "kosher", label: "Kosher" },
      { id: "kosher_style", label: "Kosher-style — no pork or shellfish, regular beef and chicken is fine" },
      { id: "vegetarian", label: "Vegetarian" },
      { id: "vegan", label: "Vegan" },
      { id: "lactose_free", label: "Lactose intolerant" },
      { id: "gluten_free", label: "Gluten-free / celiac" },
      { id: "nut_allergy", label: "Nut allergy" },
    ],
    required: false,
  },
  {
    id: "dietary_scope",
    type: "structured",
    prompt: "For each thing ticked above: everyone, or specific people? Keys are the option ids, values are \"everyone\" or a list of traveler names.",
    dataShape: "object",
    required: false,
  },
  {
    id: "organizer_identity",
    type: "text",
    prompt: "Which of the travelers are you? (this sets up your private organizer channel with the trip assistant)",
    maxLength: 80,
    required: false,
  },
  {
    id: "bot_name",
    type: "text",
    prompt: "What should the trip assistant be called? Give the name the family would actually type.",
    maxLength: 80,
    required: false,
  },
  {
    // Hebrew conjugates verbs by gender, so the assistant cannot form a
    // sentence without this. It is grammatical, not social — 'neutral' means
    // "prefer gender-avoidant phrasing", which reads slightly stiffer.
    id: "bot_gender",
    type: "choice",
    prompt: "How should the assistant refer to itself?",
    options: [
      { id: "male", label: "Male" },
      { id: "female", label: "Female" },
      { id: "neutral", label: "Neither — avoid gendered phrasing" },
    ],
    required: false,
  },
  {
    id: "bot_tone",
    type: "choice",
    prompt: "What tone should it take?",
    options: [
      { id: "warm", label: "Warm" },
      { id: "playful", label: "Playful" },
      { id: "dry", label: "Dry" },
    ],
    required: false,
  },
  {
    id: "bot_proactive",
    type: "multi_choice",
    prompt: "What should it send on its own, without being asked? (tap all that apply)",
    options: [
      { id: "none", label: "Nothing — only answer when asked" },
      { id: "morning_briefing", label: "Morning briefing — today's plan" },
      { id: "tomorrow_preview", label: "Evening look-ahead at tomorrow" },
      { id: "photo_recap", label: "Photo recap when people upload" },
      { id: "flight_changes", label: "Flight changes" },
      { id: "packing_reminders", label: "Packing reminders the day before" },
    ],
    required: false,
  },
  {
    id: "bot_limits",
    type: "structured",
    prompt: "Anything it should keep in mind about these people, or stay away from? One entry per thing, each as {he, en}.",
    dataShape: "array",
    required: false,
  },
  // Additive-optional, like phases[].days — no INTAKE_SCHEMA_VERSION bump. A v2
  // intake answered before these existed simply has no entry, and the
  // transformer treats an absent answer as "not provided".
  {
    id: "home_country",
    type: "text",
    prompt: "Which country are you (the organizer) from? This only sets which embassy the site lists for emergencies — optional; we default to your own country.",
    maxLength: 80,
    required: false,
  },
  {
    id: "budget_detail",
    type: "structured",
    prompt: "A rough budget, if you want it on the site: an overall currency and party size, plus one line per known cost — { currency, party_size?, items: [{ phase?, category, description, amount, estimate? }] }. category is one of flight/hotel/car/attraction/food/insurance/other. Use amount 0 with estimate true for a cost you know matters but not the figure. (optional)",
    dataShape: "object",
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

export interface StructuredAnswer {
  kind: "structured";
  schema_version: number;
  data: unknown;
}

/**
 * A multi-select answer. `option_ids` is deliberately a real array rather than
 * a delimited or JSON-encoded string stuffed into ChoiceAnswer.option_id:
 * encoding it would sail past the length/option validation below and reach the
 * transformer as an opaque blob it would have to re-parse.
 */
export interface MultiChoiceAnswer {
  kind: "multi_choice";
  option_ids: string[];
  schema_version: number;
  other_text: null;
}

export type IntakeAnswer = ChoiceAnswer | OtherAnswer | TextAnswer | StructuredAnswer | MultiChoiceAnswer;

export type AnswerStore = Record<string, IntakeAnswer>;

// ── Validation helpers ────────────────────────────────────────────────────────

export type AnswerValidationResult =
  | { ok: true; answer: IntakeAnswer }
  | { ok: false; reason: "UNKNOWN_QUESTION" | "UNKNOWN_OPTION" | "OTHER_TEXT_REQUIRED" | "OTHER_NOT_ALLOWED" | "TEXT_TOO_LONG" | "TEXT_REQUIRED" | "CHOICE_REQUIRED" | "SESSION_CONFIRMED" | "DATA_REQUIRED" | "DATA_WRONG_SHAPE" | "OPTIONS_REQUIRED" };

export function validateAnswer(
  questionId: string,
  optionId: string | "other" | null,
  otherText: string | null | undefined,
  questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS,
  structuredData?: unknown,
  optionIds?: readonly string[],
): AnswerValidationResult {
  const question = questions.find((q) => q.id === questionId);
  if (!question) return { ok: false, reason: "UNKNOWN_QUESTION" };

  if (question.type === "multi_choice") {
    if (!optionIds) return { ok: false, reason: "OPTIONS_REQUIRED" };
    // Order and repeats come from however the chat UI serialised the taps;
    // neither is meaningful, and both would perturb the intake digest.
    const unique = [...new Set(optionIds)];
    for (const id of unique) {
      if (!question.options?.some((o) => o.id === id)) return { ok: false, reason: "UNKNOWN_OPTION" };
    }
    if (question.required && unique.length === 0) return { ok: false, reason: "CHOICE_REQUIRED" };
    return {
      ok: true,
      answer: { kind: "multi_choice", option_ids: unique.sort(), schema_version: INTAKE_SCHEMA_VERSION, other_text: null },
    };
  }

  if (question.type === "structured") {
    if (structuredData === undefined || structuredData === null) {
      if (question.required) return { ok: false, reason: "DATA_REQUIRED" };
      return { ok: true, answer: { kind: "structured", schema_version: INTAKE_SCHEMA_VERSION, data: question.dataShape === "array" ? [] : {} } };
    }
    const isArray = Array.isArray(structuredData);
    const isPlainObject = typeof structuredData === "object" && !isArray;
    if (question.dataShape === "array" && !isArray) return { ok: false, reason: "DATA_WRONG_SHAPE" };
    if (question.dataShape === "object" && !isPlainObject) return { ok: false, reason: "DATA_WRONG_SHAPE" };
    return { ok: true, answer: { kind: "structured", schema_version: INTAKE_SCHEMA_VERSION, data: structuredData } };
  }

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
  const questionIds = INTAKE_QUESTIONS.map((q) => q.id);
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
export function buildRecap(answers: AnswerStore, questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS): RecapEntry[] {
  return questions
    .filter((q) => answers[q.id] !== undefined)
    .map((q) => {
      const ans = answers[q.id]!;
      let answerLabel: string;
      if (ans.kind === "choice") {
        answerLabel = q.options?.find((o) => o.id === ans.option_id)?.label ?? ans.option_id;
      } else if (ans.kind === "choice_other") {
        answerLabel = `Other: ${ans.other_text}`;
      } else if (ans.kind === "multi_choice") {
        answerLabel = ans.option_ids.length === 0
          ? "(none)"
          : ans.option_ids.map((id) => q.options?.find((o) => o.id === id)?.label ?? id).join(", ");
      } else if (ans.kind === "structured") {
        const count = Array.isArray(ans.data) ? ans.data.length : Object.keys(ans.data as Record<string, unknown>).length;
        answerLabel = count > 0 ? `${count} item(s) recorded` : "(none)";
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
  /**
   * Unanswered *optional* questions, in question order.
   *
   * `nextQuestion` only ever walks required questions, so without this the
   * interviewer had no way to learn an optional question existed — it could
   * only ask the ones it happened to remember from its reference doc, which
   * meant timezone, interests, anchors, dietary and the whole assistant block
   * were silently never asked. This is advisory: it does not gate
   * confirmation, and the organizer can decline any of it.
   */
  optionalRemaining: IntakeQuestion[];
  /** Set when state is 'awaiting_confirmation': the recap for the organizer to review. */
  recap: RecapEntry[] | null;
}

function nextUnansweredQuestion(answers: AnswerStore, questions: readonly IntakeQuestion[]): IntakeQuestion | null {
  return questions.find((q) => q.required && answers[q.id] === undefined) ?? null;
}

function unansweredOptionalQuestions(answers: AnswerStore, questions: readonly IntakeQuestion[]): IntakeQuestion[] {
  return questions.filter((q) => !q.required && answers[q.id] === undefined);
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
  | { ok: false; reason: "NOT_FOUND" | "SESSION_CONFIRMED" | "UNKNOWN_QUESTION" | "UNKNOWN_OPTION" | "OTHER_TEXT_REQUIRED" | "OTHER_NOT_ALLOWED" | "TEXT_TOO_LONG" | "TEXT_REQUIRED" | "CHOICE_REQUIRED" | "DATA_REQUIRED" | "DATA_WRONG_SHAPE" | "OPTIONS_REQUIRED" };

export type ConfirmIntakeResult =
  | { ok: true; sessionId: string; intakeVersionId: string; digest: string; versionNumber: number }
  | { ok: false; reason: "NOT_FOUND" | "NOT_ALL_REQUIRED_ANSWERED" | "UNSAFE_ANSWER_CONTENT"; unsafePath?: string };

// A private Telegram chat id is always a positive integer in string form —
// reject anything else rather than storing whatever an LLM tool-call
// argument happened to contain (see migration 0022's header on why this
// value is a best-effort hint, never treated as verified identity).
const TELEGRAM_CHAT_ID_HINT_PATTERN = /^\d{1,20}$/;

/**
 * Exchanges a valid enrollment token for a session, atomically:
 *   1. Verifies and consumes the enrollment (FOR UPDATE lock)
 *   2. Transitions the trip from 'draft' → 'intake_in_progress'
 *   3. Creates the intake_sessions row with a fresh session token
 *   4. Records telegramChatIdHint (if present and well-formed) as the
 *      trip's best-effort notification delivery hint — see migration 0022.
 *
 * Returns the session ID and raw session token. The raw token is not stored —
 * only its SHA-256 digest is. Subsequent session API calls must present this
 * token to be authenticated.
 */
export async function startSession(
  db: pg.Pool,
  rawEnrollmentToken: string,
  log: (line: string) => void = () => {},
  telegramChatIdHint?: string,
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

    if (telegramChatIdHint && TELEGRAM_CHAT_ID_HINT_PATTERN.test(telegramChatIdHint)) {
      await client.query(
        "UPDATE control_plane.trips SET notification_chat_id_hint = $1 WHERE id = $2 AND notification_chat_id_hint IS DISTINCT FROM $1",
        [telegramChatIdHint, enrollment.tripId],
      );
    }

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
      nextQuestion: INTAKE_QUESTIONS.find((q) => q.required) ?? null,
      optionalRemaining: unansweredOptionalQuestions({}, INTAKE_QUESTIONS),
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
    return { sessionId, tripId, state: "confirmed", nextQuestion: null, optionalRemaining: [], recap: null };
  }
  const state = deriveSessionState(answers, INTAKE_QUESTIONS);
  return {
    sessionId,
    tripId,
    state,
    nextQuestion: state === "interviewing" ? nextUnansweredQuestion(answers, INTAKE_QUESTIONS) : null,
    // Listed in both states, unlike nextQuestion/recap: an optional question is
    // still worth offering once the required ones are done, and in practice
    // that's when the good answers arrive — the organizer is warmed up and the
    // roster is already on the table.
    optionalRemaining: unansweredOptionalQuestions(answers, INTAKE_QUESTIONS),
    recap: state === "awaiting_confirmation" ? buildRecap(answers) : null,
  };
}

/**
 * Submits an answer to a question in an active session.
 *
 * For choice questions: pass the option id (e.g. "family") or "other" plus
 * the free-text follow-up in otherText.
 * For multi_choice questions: pass every selected option id in optionIds.
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
  structuredData?: unknown,
  optionIds?: readonly string[],
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

    const validation = validateAnswer(questionId, optionId, otherText, INTAKE_QUESTIONS, structuredData, optionIds);
    if (!validation.ok) {
      await client.query("ROLLBACK");
      return { ok: false, reason: validation.reason };
    }

    const updatedAnswers = { ...session.answers, [questionId]: validation.answer };
    const newState = deriveSessionState(updatedAnswers, INTAKE_QUESTIONS);

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
      source_document: unknown;
    }>(
      `SELECT id, trip_id, user_id, state, answers, source_document
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
    const allRequired = INTAKE_QUESTIONS.filter((q) => q.required);
    const allAnswered = allRequired.every((q) => session.answers[q.id] !== undefined);
    if (!allAnswered) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_ALL_REQUIRED_ANSWERED" };
    }

    // Answers are organizer-controlled free-form content (free text, "other"
    // follow-ups, and structured travelers/phases/travel_anchors/constraints
    // payloads) about to become an immutable, durable record. Check it here
    // for a named field path in the error; the database CHECK constraint on
    // intake_versions.data (migration 0015) is the actual backstop, same
    // relationship validateBeforeProvider has to its own profile checks.
    try {
      assertCanonicalRecordSafe(session.answers);
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof UnsafeCanonicalRecordError) {
        return { ok: false, reason: "UNSAFE_ANSWER_CONTENT", unsafePath: error.path };
      }
      throw error;
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
      `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version, data, source_document)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb, $8::jsonb)`,
      [
        versionId, session.trip_id, nextVersion, artifactRef, intakeDigest,
        INTAKE_SCHEMA_VERSION, JSON.stringify(session.answers),
        session.source_document ? JSON.stringify(session.source_document) : null,
      ],
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

// ── source document: the raw plan an organizer shared, kept for re-extraction ─

const SOURCE_DOCUMENT_MAX_CHARS = 200_000;

/** Stage the plan document text on the session. It is copied onto the
 * immutable intake_versions row at confirm. Best-effort — a failure here never
 * blocks the interview (the interviewer already extracted from it live). */
export async function saveSourceDocument(
  db: pg.Pool,
  rawSessionToken: string,
  text: string,
  filename?: string,
): Promise<{ ok: true; chars: number } | { ok: false; reason: "NOT_FOUND" | "INVALID_REQUEST" }> {
  const body = String(text ?? "");
  if (!body.trim()) return { ok: false, reason: "INVALID_REQUEST" };
  const doc = {
    filename: String(filename ?? "").replace(/[<>]/g, "").slice(0, 200) || null,
    text: body.slice(0, SOURCE_DOCUMENT_MAX_CHARS),
    savedAt: new Date().toISOString(),
  };
  const res = await db.query(
    `UPDATE control_plane.intake_sessions
     SET source_document = $2::jsonb, updated_at = now()
     WHERE session_token_digest = $1 AND state <> 'confirmed'`,
    [sessionTokenDigest(rawSessionToken), JSON.stringify(doc)],
  );
  if (res.rowCount === 0) return { ok: false, reason: "NOT_FOUND" };
  return { ok: true, chars: doc.text.length };
}

// ── country_reference: cross-trip consular contacts ──────────────────────────

export type ConsularContact = { name: { he: string; en: string }; phone: string };

const CONSULAR_MAX_AGE_DAYS = 180;

function normaliseCountry(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
}

/** The site renders contact.name through `_biSpan` (raw HTML) and phone into a
 * `tel:` href — same XSS posture as the itinerary `days` text, so strip markup
 * here rather than trust the search model's output. */
function cleanConsularContacts(raw: unknown): ConsularContact[] {
  if (!Array.isArray(raw)) return [];
  const plain = (v: unknown) => String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  const out: ConsularContact[] = [];
  for (const entry of raw.slice(0, 8)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const nameObj = (e.name && typeof e.name === "object" ? e.name : {}) as Record<string, unknown>;
    const nameStr = typeof e.name === "string" ? e.name : "";
    const he = plain(nameObj.he ?? nameStr);
    const en = plain(nameObj.en ?? nameStr);
    const phone = plain(e.phone).replace(/[^\d+()\-\s]/g, "").trim().slice(0, 40);
    if ((!he && !en) || !phone) continue;
    out.push({ name: { he: he || en, en: en || he }, phone });
  }
  return out;
}

export async function sessionActive(db: pg.Pool, rawSessionToken: string): Promise<boolean> {
  const row = await db.query(
    "SELECT 1 FROM control_plane.intake_sessions WHERE session_token_digest = $1 AND state <> 'confirmed'",
    [sessionTokenDigest(rawSessionToken)],
  );
  return row.rows.length > 0;
}

/** Read a cached consular row. `found` is true only when a row exists and is
 * fresher than CONSULAR_MAX_AGE_DAYS — the interviewer's tool then skips the
 * web search entirely. */
export async function consularContactsFor(
  db: pg.Pool,
  rawSessionToken: string,
  destinationCountry: string,
  homeCountry: string,
): Promise<
  | { ok: true; found: boolean; contacts: ConsularContact[]; fetchedAt?: string }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_REQUEST" }
> {
  const dest = normaliseCountry(destinationCountry);
  const home = normaliseCountry(homeCountry);
  if (!dest || !home) return { ok: false, reason: "INVALID_REQUEST" };
  if (!(await sessionActive(db, rawSessionToken))) return { ok: false, reason: "NOT_FOUND" };

  const row = await db.query<{ contacts: unknown; fetched_at: string; stale: boolean }>(
    `SELECT contacts, fetched_at,
            (fetched_at < now() - ($3 || ' days')::interval) AS stale
     FROM control_plane.country_reference
     WHERE destination_country = $1 AND home_country = $2`,
    [dest, home, String(CONSULAR_MAX_AGE_DAYS)],
  );
  const [hit] = row.rows;
  if (!hit) return { ok: true, found: false, contacts: [] };
  return {
    ok: true,
    found: !hit.stale,
    contacts: cleanConsularContacts(hit.contacts),
    fetchedAt: hit.fetched_at,
  };
}

/** Upsert a consular row the interviewer's web search produced, for every later
 * trip to the same (destination, home) pair to reuse. */
export async function saveConsularContacts(
  db: pg.Pool,
  rawSessionToken: string,
  destinationCountry: string,
  homeCountry: string,
  contacts: unknown,
  source?: string,
): Promise<
  | { ok: true; contacts: ConsularContact[] }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_REQUEST" | "NO_USABLE_CONTACTS" }
> {
  const dest = normaliseCountry(destinationCountry);
  const home = normaliseCountry(homeCountry);
  if (!dest || !home) return { ok: false, reason: "INVALID_REQUEST" };
  if (!(await sessionActive(db, rawSessionToken))) return { ok: false, reason: "NOT_FOUND" };

  const clean = cleanConsularContacts(contacts);
  if (clean.length === 0) return { ok: false, reason: "NO_USABLE_CONTACTS" };

  await db.query(
    `INSERT INTO control_plane.country_reference (destination_country, home_country, contacts, source, fetched_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (destination_country, home_country)
     DO UPDATE SET contacts = EXCLUDED.contacts, source = EXCLUDED.source, fetched_at = now()`,
    [dest, home, JSON.stringify(clean), (source ?? "").slice(0, 200) || null],
  );
  return { ok: true, contacts: clean };
}
