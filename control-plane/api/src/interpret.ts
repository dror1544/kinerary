/**
 * interpret — "which outstanding questions does this message answer, and with
 * what?"
 *
 * The model PROPOSES. Nothing here accepts. A `ProposedAnswer` is not an answer
 * that happens to be untrusted; it is a different type, and the only conversion
 * from one to the other runs through `validateAnswer` — the validator the
 * router and the buttons already use. So the model cannot invent an option id,
 * exceed a length, skip a required field, or hand a structured question the
 * wrong shape: `UNKNOWN_OPTION` and `checkComplete` were already there, and
 * this design's whole move is to put the model on the outside of that door.
 *
 * Design: docs/interview-without-an-agent.md §4.
 *
 * `applyProposals` is pure and is what the tests exercise; `interpretBurst`
 * wraps it with the one-shot model call. Any model failure returns
 * `{ ok: false }` and the router asks its own question from `intake-copy.ts` —
 * the interview cannot go silent because a provider rate-limited.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  INTAKE_QUESTIONS,
  RETIRED_QUESTION_IDS,
  validateAnswer,
  type IntakeAnswer,
  type IntakeQuestion,
} from "./interview.js";
import type { RunnerFailure, StructuredModelRunner } from "./model-runner.js";

// ── The proposal ─────────────────────────────────────────────────────────────

/**
 * Deliberately a separate union from `IntakeAnswer`, mirroring its discriminants
 * without being it. The mapping onto `validateAnswer`'s parameters is in
 * `validateProposed` below and is one-for-one.
 */
export type ProposedValue =
  | { kind: "choice"; optionId: string }
  | { kind: "choice_other"; otherText: string }
  | { kind: "multi_choice"; optionIds: string[] }
  | { kind: "text"; text: string }
  | { kind: "structured"; data: unknown };

export interface ProposedAnswer {
  questionId: string;
  value: ProposedValue;
  /** 0..1. Below the threshold the question simply stays outstanding. */
  confidence: number;
  /**
   * A verbatim span of what the organizer wrote. Checked, not decorative —
   * see `evidenceAppears`. Normalisation (a date phrase to ISO, a Hebrew name
   * to a Latin spelling) happens on `value`, never here, which is what keeps
   * the check meaningful for answers the model had to transform.
   */
  evidence: string;
  /** Which message of the burst it came from. Audit only; idempotency keys on
   *  the whole burst. */
  sourceMessageId: string;
}

export interface UnclearQuestion {
  questionId: string;
  why: string;
}

export interface InterpretPayload {
  proposals: ProposedAnswer[];
  unclear: UnclearQuestion[];
  /** Entries the parser threw away. A non-zero count is a prompt problem. */
  malformed: number;
}

export type InterpretResult =
  | { ok: true; payload: InterpretPayload; attempts: number; ms: number }
  | { ok: false; reason: RunnerFailure; detail?: string; attempts: number; ms: number };

// ── Parsing: this function is the schema ─────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function parseValue(raw: unknown): ProposedValue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  switch (v.kind) {
    case "choice": {
      const optionId = str(v.optionId);
      return optionId ? { kind: "choice", optionId } : null;
    }
    case "choice_other": {
      const otherText = str(v.otherText);
      return otherText ? { kind: "choice_other", otherText } : null;
    }
    case "multi_choice": {
      if (!Array.isArray(v.optionIds)) return null;
      const ids = v.optionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
      // An empty list is not a proposal — it is the model declining, and
      // `unclear` is where declining belongs.
      return ids.length > 0 ? { kind: "multi_choice", optionIds: ids } : null;
    }
    case "text": {
      const text = str(v.text);
      return text ? { kind: "text", text } : null;
    }
    case "structured":
      return v.data === undefined ? null : { kind: "structured", data: v.data };
    default:
      return null;
  }
}

/**
 * Parses one model reply. Returns null only when the TOP LEVEL is unusable —
 * an individual bad entry is dropped and counted, because five good proposals
 * should not be lost to a sixth malformed one. That is the same partial-success
 * stance `record_answers_for_chat` already takes.
 *
 * `allowedMessageIds` bounds attribution: a `sourceMessageId` the model made up
 * is replaced with the burst's first id rather than stored. It is audit data,
 * not a key, so a wrong one must not be able to poison anything.
 */
export function parseInterpretPayload(raw: unknown, allowedMessageIds: readonly string[] = []): InterpretPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.proposals)) return null;

  const fallbackId = allowedMessageIds[0] ?? "";
  const allowed = new Set(allowedMessageIds);
  const proposals: ProposedAnswer[] = [];
  let malformed = 0;

  for (const entry of root.proposals) {
    if (typeof entry !== "object" || entry === null) {
      malformed += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const questionId = str(e.questionId);
    const value = parseValue(e.value);
    const confidence = typeof e.confidence === "number" && Number.isFinite(e.confidence) ? e.confidence : null;
    if (!questionId || !value || confidence === null || confidence < 0 || confidence > 1) {
      malformed += 1;
      continue;
    }
    const claimed = typeof e.sourceMessageId === "string" ? e.sourceMessageId : "";
    proposals.push({
      questionId,
      value,
      confidence,
      evidence: typeof e.evidence === "string" ? e.evidence : "",
      sourceMessageId: allowed.has(claimed) ? claimed : fallbackId,
    });
  }

  const unclear: UnclearQuestion[] = [];
  if (Array.isArray(root.unclear)) {
    for (const entry of root.unclear) {
      if (typeof entry !== "object" || entry === null) continue;
      const u = entry as Record<string, unknown>;
      const questionId = str(u.questionId);
      if (questionId) unclear.push({ questionId, why: typeof u.why === "string" ? u.why : "" });
    }
  }

  return { proposals, unclear, malformed };
}

// ── Evidence ─────────────────────────────────────────────────────────────────

function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Is this evidence actually a span of what the organizer wrote?
 *
 * Cheap, and it catches the specific failure where a model fills a field from
 * its own prior rather than from the message it was given — the class that
 * produced a confident answer about a different family's trip. Whitespace and
 * case are folded, and surrounding punctuation is trimmed from the claim, so a
 * model quoting "Tel Aviv," against a source saying "Tel Aviv" still matches.
 */
export function evidenceAppears(evidence: string, source: string): boolean {
  const claim = fold(evidence).replace(/^[\p{P}\p{S}]+/u, "").replace(/[\p{P}\p{S}]+$/u, "").trim();
  if (!claim) return false;
  return fold(source).includes(claim);
}

// ── The gate ─────────────────────────────────────────────────────────────────

export type RejectReason =
  /** Confidence below the threshold, or the model gave none worth having. */
  | "LOW_CONFIDENCE"
  /** The quoted span is not in the message. */
  | "EVIDENCE_NOT_IN_SOURCE"
  /** Already answered: a change, and changes are confirmed, not applied. */
  | "ALREADY_ANSWERED"
  /** Not a question the interview is currently asking (or a retired one). */
  | "NOT_OUTSTANDING"
  /** Another proposal for the same question won on confidence. */
  | "DUPLICATE_PROPOSAL"
  /** Whatever `validateAnswer` said. */
  | "UNKNOWN_QUESTION"
  | "UNKNOWN_OPTION"
  | "OTHER_TEXT_REQUIRED"
  | "OTHER_NOT_ALLOWED"
  | "TEXT_TOO_LONG"
  | "TEXT_REQUIRED"
  | "CHOICE_REQUIRED"
  | "SESSION_CONFIRMED"
  | "DATA_REQUIRED"
  | "DATA_WRONG_SHAPE"
  | "OPTIONS_REQUIRED"
  | "INCOMPLETE_ANSWER";

export interface AcceptedProposal {
  questionId: string;
  answer: IntakeAnswer;
  proposal: ProposedAnswer;
}

export interface RejectedProposal {
  questionId: string;
  reason: RejectReason;
  detail?: string;
  proposal: ProposedAnswer;
}

export interface ProposalDecisions {
  accepted: AcceptedProposal[];
  rejected: RejectedProposal[];
  /** Questions to ask next: the model's `unclear`, plus everything rejected.
   *  A rejected proposal never becomes a silent gap. */
  askAnyway: string[];
}

export interface ApplyProposalsContext {
  /** Exactly the text the model was shown. Evidence is checked against this. */
  sourceText: string;
  /** Question ids the interview is currently missing, in router order. */
  outstanding: readonly string[];
  /** Question ids that already have an answer. */
  answered: readonly string[];
  unclear?: readonly UnclearQuestion[];
  questions?: readonly IntakeQuestion[];
  /** Default 0.7. One threshold, not a per-question table, until there is
   *  evidence a per-question one is needed. */
  minConfidence?: number;
}

export const DEFAULT_MIN_CONFIDENCE = 0.7;

/** The one-for-one mapping onto `validateAnswer`'s parameter list. */
function validateProposed(
  proposal: ProposedAnswer,
  questions: readonly IntakeQuestion[],
): ReturnType<typeof validateAnswer> {
  const { questionId, value } = proposal;
  switch (value.kind) {
    case "choice":
      return validateAnswer(questionId, value.optionId, null, questions);
    case "choice_other":
      return validateAnswer(questionId, "other", value.otherText, questions);
    case "multi_choice":
      return validateAnswer(questionId, null, null, questions, undefined, value.optionIds);
    case "text":
      return validateAnswer(questionId, null, value.text, questions);
    case "structured":
      return validateAnswer(questionId, null, null, questions, value.data);
  }
}

/**
 * Decides what, if anything, a set of proposals is allowed to write. Pure.
 *
 * Order matters and is cheapest-and-most-decisive first: a proposal for a
 * question the interview is not asking is rejected before we spend anything on
 * validating it.
 */
export function applyProposals(
  proposals: readonly ProposedAnswer[],
  ctx: ApplyProposalsContext,
): ProposalDecisions {
  const questions = ctx.questions ?? INTAKE_QUESTIONS;
  const minConfidence = ctx.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const outstanding = new Set(ctx.outstanding);
  const answered = new Set(ctx.answered);

  // Highest confidence wins a contested question; ties go to the earlier
  // proposal. The model's ordering carries no meaning, but its confidence does.
  const winner = new Map<string, number>();
  proposals.forEach((p, i) => {
    const held = winner.get(p.questionId);
    const holder = held === undefined ? undefined : proposals[held];
    if (!holder || p.confidence > holder.confidence) winner.set(p.questionId, i);
  });

  const accepted: AcceptedProposal[] = [];
  const rejected: RejectedProposal[] = [];

  proposals.forEach((proposal, i) => {
    const reject = (reason: RejectReason, detail?: string) =>
      rejected.push({ questionId: proposal.questionId, reason, detail, proposal });

    if (RETIRED_QUESTION_IDS.has(proposal.questionId)) return reject("NOT_OUTSTANDING", "retired question");
    if (answered.has(proposal.questionId)) return reject("ALREADY_ANSWERED");
    if (!outstanding.has(proposal.questionId)) return reject("NOT_OUTSTANDING");
    if (winner.get(proposal.questionId) !== i) return reject("DUPLICATE_PROPOSAL");
    if (proposal.confidence < minConfidence) return reject("LOW_CONFIDENCE");
    if (!evidenceAppears(proposal.evidence, ctx.sourceText)) return reject("EVIDENCE_NOT_IN_SOURCE");

    const validated = validateProposed(proposal, questions);
    if (!validated.ok) return reject(validated.reason, validated.detail);
    accepted.push({ questionId: proposal.questionId, answer: validated.answer, proposal });
  });

  // Anything the model was unsure of, and anything we refused, is a question
  // the router asks — which is what it would have done anyway. The cost of a
  // low-confidence read is one question, never a wrong answer.
  const ask = new Set<string>();
  for (const u of ctx.unclear ?? []) if (outstanding.has(u.questionId)) ask.add(u.questionId);
  for (const r of rejected) if (outstanding.has(r.questionId) && !answered.has(r.questionId)) ask.add(r.questionId);
  for (const a of accepted) ask.delete(a.questionId);

  return { accepted, rejected, askAnyway: [...ask] };
}

export interface SubmitArgs {
  optionId: string | "other" | null;
  otherText?: string;
  structuredData?: unknown;
  optionIds?: string[];
}

/**
 * An accepted proposal, as `submitAnswerForChat` takes it.
 *
 * The answer is written through the ordinary router write path rather than
 * inserted directly, so it re-runs `validateAnswer` and picks up phase
 * advancement, derivations and the digest exactly as a tapped button does.
 * The second validation is not redundant: it means there is still only ONE way
 * an answer reaches storage, which is the property that made the gate above
 * cheap to trust in the first place.
 */
export function submitArgsFor(value: ProposedValue): SubmitArgs {
  switch (value.kind) {
    case "choice":
      return { optionId: value.optionId };
    case "choice_other":
      return { optionId: "other", otherText: value.otherText };
    case "multi_choice":
      return { optionId: null, optionIds: value.optionIds };
    case "text":
      return { optionId: null, otherText: value.text };
    case "structured":
      return { optionId: null, structuredData: value.data };
  }
}

// ── The prompt ───────────────────────────────────────────────────────────────

function describeQuestion(q: IntakeQuestion): string {
  const head = `- id: ${q.id}  (${q.type}${q.required ? ", required" : ""})`;
  const lines = [head, `  asks: ${q.prompt.replace(/\s+/g, " ").trim()}`];
  if (q.options?.length) {
    lines.push(`  options: ${q.options.map((o) => `${o.id} = ${o.label}`).join(" | ")}`);
    if (q.allowsOther) lines.push(`  may also be answered freely: use kind "choice_other"`);
  }
  if (q.type === "structured") lines.push(`  shape: ${q.dataShape === "array" ? "array" : "object"}`);
  return lines.join("\n");
}

export interface BuildInterpretPromptArgs {
  sourceText: string;
  outstanding: readonly string[];
  language: string;
  questions?: readonly IntakeQuestion[];
}

/**
 * Asks for structure and nothing else. The model never addresses the organizer
 * and is never told to be conversational — there is no channel from its output
 * to a screen. Compare `buildExtractPrompt`, which this deliberately resembles.
 */
export function buildInterpretPrompt(args: BuildInterpretPromptArgs): string {
  const all = args.questions ?? INTAKE_QUESTIONS;
  const asked = all.filter((q) => args.outstanding.includes(q.id));
  return [
    `You are reading one message from someone planning a trip, written in ${args.language}.`,
    `Decide which of the questions below it answers. Answer ONLY with JSON.`,
    ``,
    `Rules:`,
    `- Propose a question only if the message actually answers it. Silence is correct.`,
    `- "evidence" must be text copied VERBATIM from the message. Never paraphrase it,`,
    `  never translate it, never write evidence for something the message does not say.`,
    `- "value" is the normalised answer: an ISO date, a Latin spelling, an option id.`,
    `  Normalise there; leave "evidence" as they wrote it.`,
    `- Use the exact option ids given. Never invent one. If they meant something not`,
    `  listed and the question allows it, use kind "choice_other".`,
    `- "confidence" is 0..1: how sure you are this is what they meant, not how sure`,
    `  you are that you understood the words.`,
    `- If the message gestures at a question without settling it, put it in "unclear".`,
    ``,
    `Questions still outstanding:`,
    ...asked.map(describeQuestion),
    ``,
    `Return exactly:`,
    `{"proposals":[{"questionId":"...","value":{"kind":"choice","optionId":"..."},`,
    ` "confidence":0.0,"evidence":"...","sourceMessageId":"..."}],`,
    ` "unclear":[{"questionId":"...","why":"..."}]}`,
    ``,
    `value kinds: {"kind":"choice","optionId":"x"} | {"kind":"choice_other","otherText":"x"}`,
    ` | {"kind":"multi_choice","optionIds":["x"]} | {"kind":"text","text":"x"}`,
    ` | {"kind":"structured","data":...}`,
    ``,
    `No commentary.`,
    ``,
    `Message:`,
    args.sourceText.slice(0, 8000),
  ].join("\n");
}

// ── The call ─────────────────────────────────────────────────────────────────

export const INTERPRET_TASK = "interpret";

export interface InterpretBurstArgs extends BuildInterpretPromptArgs {
  messageIds?: readonly string[];
}

/** One-shot. Failure is a value; the caller falls back to its own copy. */
export async function interpretBurst(
  runner: StructuredModelRunner,
  args: InterpretBurstArgs,
): Promise<InterpretResult> {
  const messageIds = args.messageIds ?? [];
  const result = await runner.run<InterpretPayload>({
    task: INTERPRET_TASK,
    prompt: buildInterpretPrompt(args),
    parse: (raw) => parseInterpretPayload(raw, messageIds),
  });
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail, attempts: result.attempts, ms: result.ms };
  return { ok: true, payload: result.value, attempts: result.attempts, ms: result.ms };
}

/**
 * The idempotency key for one burst: the messages it is made of, in a stable
 * order. Telegram redelivers, the relay restarts, and a crash between the model
 * answering and the answers being committed is an ordinary event — the relay
 * process died silently for ten minutes during run 15. Keyed on the burst
 * rather than the turn because the burst is what the model was actually shown.
 *
 * Falls back to a digest of the text when Telegram gave us no ids at all, so
 * the key is never empty.
 */
export function burstKey(messageIds: readonly string[], sourceText: string): string {
  const ids = [...new Set(messageIds.filter((id) => id && id.trim().length > 0))].sort();
  if (ids.length > 0) return ids.join(",");
  let hash = 0;
  for (let i = 0; i < sourceText.length; i += 1) hash = (Math.imul(31, hash) + sourceText.charCodeAt(i)) | 0;
  return `text:${(hash >>> 0).toString(16)}`;
}

// ── Idempotent persistence ───────────────────────────────────────────────────

export interface InterpretationRow {
  id: string;
  sessionId: string;
  chatId: string;
  burstKey: string;
  sourceText: string;
  proposals: ProposedAnswer[];
  outcomes: StoredOutcomes;
  failureReason: string | null;
  attempts: number;
  durationMs: number | null;
  committedAt: Date | null;
}

/** The gate's verdict, flattened for storage. Reasons are kept per question so
 *  a later run can be compared against this one without re-inferring why. */
export interface StoredOutcomes {
  accepted?: { questionId: string; confidence: number }[];
  rejected?: { questionId: string; reason: RejectReason; detail?: string }[];
  askAnyway?: string[];
  malformed?: number;
}

/**
 * Claims one burst for interpretation, or hands back what a previous attempt
 * already learned about it.
 *
 * `ON CONFLICT DO NOTHING` is the whole mechanism: the unique
 * (chat, burst_key) means a redelivered burst — or a retry after the relay died
 * mid-call — finds the earlier row instead of paying for a second model call
 * and writing the answers twice.
 *
 * `fresh: false` with `row.committedAt` set means the work is done and the
 * caller should do nothing. `fresh: false` with `committedAt` null is the crash
 * window: the model's answer survived but the commit did not, so the caller
 * resumes from the stored proposals rather than re-asking the model.
 */
export async function claimInterpretation(
  db: pg.Pool,
  args: { sessionId: string; chatId: string; burstKey: string; sourceText: string },
): Promise<{ fresh: true; id: string } | { fresh: false; row: InterpretationRow }> {
  const id = `interp_${randomBytes(16).toString("hex")}`;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO control_plane.interview_interpretations
       (id, session_id, telegram_chat_id, burst_key, source_text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_chat_id, burst_key) DO NOTHING
     RETURNING id`,
    [id, args.sessionId, args.chatId, args.burstKey, args.sourceText],
  );
  if (inserted.rowCount) return { fresh: true, id };
  const existing = await findInterpretation(db, args.chatId, args.burstKey);
  // Losing the insert race and then not finding the row would mean it was
  // deleted between the two statements. Treat it as fresh rather than throwing:
  // the worst case is one extra model call, and refusing to proceed would leave
  // the organizer waiting on nothing.
  if (!existing) return { fresh: true, id };
  return { fresh: false, row: existing };
}

export async function findInterpretation(
  db: pg.Pool,
  chatId: string,
  key: string,
): Promise<InterpretationRow | null> {
  const rows = await db.query(
    `SELECT id, session_id, telegram_chat_id, burst_key, source_text, proposals,
            outcomes, failure_reason, attempts, duration_ms, committed_at
       FROM control_plane.interview_interpretations
      WHERE telegram_chat_id = $1 AND burst_key = $2`,
    [chatId, key],
  );
  const r = rows.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    chatId: String(r.telegram_chat_id),
    burstKey: String(r.burst_key),
    sourceText: String(r.source_text),
    proposals: (r.proposals as ProposedAnswer[]) ?? [],
    outcomes: (r.outcomes as StoredOutcomes) ?? {},
    failureReason: r.failure_reason == null ? null : String(r.failure_reason),
    attempts: Number(r.attempts ?? 0),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    committedAt: (r.committed_at as Date | null) ?? null,
  };
}

/** Records what the model said. Separate from `markInterpretationCommitted` on
 *  purpose: between the two lies the crash window the resume path exists for. */
export async function recordInterpretationResult(
  db: pg.Pool,
  id: string,
  result: { proposals?: ProposedAnswer[]; failureReason?: string | null; attempts: number; durationMs: number },
): Promise<void> {
  await db.query(
    `UPDATE control_plane.interview_interpretations
        SET proposals = $2::jsonb, failure_reason = $3, attempts = $4, duration_ms = $5
      WHERE id = $1`,
    [id, JSON.stringify(result.proposals ?? []), result.failureReason ?? null, result.attempts, result.durationMs],
  );
}

export async function markInterpretationCommitted(
  db: pg.Pool,
  id: string,
  outcomes: StoredOutcomes,
): Promise<void> {
  await db.query(
    `UPDATE control_plane.interview_interpretations
        SET outcomes = $2::jsonb, committed_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(outcomes)],
  );
}

/** Flattens the gate's verdict for storage. */
export function storedOutcomes(decisions: ProposalDecisions, malformed: number): StoredOutcomes {
  return {
    accepted: decisions.accepted.map((a) => ({ questionId: a.questionId, confidence: a.proposal.confidence })),
    rejected: decisions.rejected.map((r) => ({ questionId: r.questionId, reason: r.reason, detail: r.detail })),
    askAnyway: decisions.askAnyway,
    malformed,
  };
}

// ── The per-session switch ───────────────────────────────────────────────────

/**
 * Is this session driven by interpret rather than by the agent?
 *
 * Read in two places that must agree: the poller, which decides whether to open
 * an agent turn at all, and the agent write routes, which refuse while it is
 * true. One writer per session (§5) is that agreement.
 */
export async function isInterpretPath(db: pg.Pool, chatId: string): Promise<boolean> {
  const rows = await db.query<{ interpret_path: boolean }>(
    `SELECT interpret_path FROM control_plane.intake_sessions
      WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
    [chatId],
  );
  return rows.rows[0]?.interpret_path === true;
}

export async function setInterpretPath(db: pg.Pool, chatId: string, on: boolean): Promise<boolean> {
  const rows = await db.query(
    `UPDATE control_plane.intake_sessions SET interpret_path = $2
      WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
    [chatId, on],
  );
  return (rows.rowCount ?? 0) > 0;
}
