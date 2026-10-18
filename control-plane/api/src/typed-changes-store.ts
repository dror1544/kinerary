/**
 * The waiting draft of a typed change (#206), in `intake_pending_changes`.
 *
 * ONE open draft per interview session. Every function here takes the session's
 * row lock FIRST — the same order `applyPendingChangeForChat` (interview.ts)
 * uses — so a proposal, a merge and an apply can never deadlock or interleave.
 *
 * What is stored is the mutation, not a description of one: `ops` (accumulated
 * across follow-ups), `base` (what was held, per touched question), `result`
 * (the validated answer that would be stored) and `preview` (the difference, as
 * data). Applying compares `base` against what is held and writes `result`; the
 * model is not consulted again. Slice 2 of #206: nothing calls this yet.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { AnswerStore, IntakeAnswer } from "./interview.js";
import { applyOps, applyPick, draftDigest, MAX_DRAFT_OPS, mergeOps, questionOfOp, type Line, type Op, type Unresolved } from "./typed-changes.js";
import { renderDraft } from "./typed-changes-render.js";

type Db = Pick<pg.Pool, "connect" | "query">;

export type DraftStatus = "pending" | "applied" | "cancelled" | "failed";

export interface Draft {
  id: string;
  sessionId: string;
  tripId: string;
  interpretationIds: string[];
  base: Record<string, IntakeAnswer | null>;
  ops: Op[];
  result: Record<string, IntakeAnswer>;
  preview: Line[];
  unresolved: Unresolved[];
  blocked: Line[];
  displacedPrompt: string | null;
  status: DraftStatus;
}

interface DraftRow {
  id: string;
  session_id: string;
  trip_id: string;
  interpretation_ids: string[];
  base: Draft["base"];
  ops: Op[];
  result: Draft["result"];
  preview: Line[];
  unresolved: Unresolved[];
  blocked: Line[];
  displaced_prompt: string | null;
  status: DraftStatus;
}

const COLUMNS =
  "id, session_id, trip_id, interpretation_ids, base, ops, result, preview, unresolved, blocked, displaced_prompt, status";

function toDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    sessionId: row.session_id,
    tripId: row.trip_id,
    interpretationIds: row.interpretation_ids,
    base: row.base,
    ops: row.ops,
    result: row.result,
    preview: row.preview,
    unresolved: row.unresolved,
    blocked: row.blocked,
    displacedPrompt: row.displaced_prompt,
    status: row.status,
  };
}

/** What a set of operations amounts to against what is held NOW. */
export function draftStateFor(held: AnswerStore, ops: readonly Op[]) {
  const outcome = applyOps(held, ops);
  const questions = outcome.ok
    ? outcome.touched
    : [...new Set(ops.map(questionOfOp))];
  const base: Draft["base"] = {};
  for (const questionId of questions) base[questionId] = held[questionId] ?? null;
  return outcome.ok
    ? { base, result: outcome.result, preview: outcome.preview, unresolved: [] as Unresolved[], blocked: [] as Line[] }
    : { base, result: {} as Draft["result"], preview: [] as Line[], unresolved: outcome.unresolved, blocked: outcome.blocked };
}

async function lockedSession(client: pg.PoolClient, sessionId: string): Promise<{ answers: AnswerStore; state: string } | null> {
  const row = await client.query<{ answers: AnswerStore; state: string }>(
    "SELECT answers, state FROM control_plane.intake_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  return row.rows[0] ?? null;
}

async function lockedAnswers(client: pg.PoolClient, sessionId: string): Promise<AnswerStore | null> {
  return (await lockedSession(client, sessionId))?.answers ?? null;
}

/**
 * The most a preview may say, in characters, in either language. Telegram
 * refuses a message over 4096; what is sent is this plus a one-line lead, and
 * 3500 leaves that and every language's wording well inside the limit.
 */
export const PREVIEW_BUDGET_CHARS = 3500;

/** The widest a draft's message would be, in the language that says it at greatest length. */
export function previewLength(state: {
  ops: Op[]; base: Draft["base"]; result: Draft["result"]; preview: Line[]; unresolved: Unresolved[]; blocked: Line[];
}): number {
  const draft = { id: `pchg_${"0".repeat(32)}`, ...state };
  return Math.max(...(["en", "he"] as const).map((language) => renderDraft(draft, language).text.length));
}

export type ProposeResult =
  | { kind: "created" | "merged" | "replay"; draft: Draft }
  | { kind: "no_session" }
  /** The interview is confirmed and immutable: nothing can be proposed to it. */
  | { kind: "confirmed" }
  /** The change would make the waiting draft too big to show in one message, or hold too many operations. Nothing was stored. */
  | { kind: "too_big"; merged: boolean }
  /** What is held cannot be edited by typing (an entry that is not an object). Nothing was stored. */
  | { kind: "uneditable"; question: "phases" | "travelers" };

export interface ProposeInput {
  sessionId: string;
  tripId: string;
  /** The interpretation this came from: the idempotency key. */
  interpretationId: string;
  ops: readonly Op[];
  /**
   * The prompt this change puts off the screen, to restore when it resolves. Kept
   * from the first proposal - unless a preview later goes out over something else
   * (`recordDisplacedPrompt`).
   */
  displacedPrompt?: string | null;
}

/**
 * Puts operations into the session's draft.
 *
 * An interpretation already recorded on ANY draft of this session is a replay
 * (the relay resumes from stored proposals after a crash) and changes nothing —
 * even when that draft has since been applied or cancelled. With a draft open,
 * the operations are MERGED into it by target and everything is recomputed
 * against what is held now; with none, one is created.
 */
/** Why a computed draft may not be stored, if it may not. */
function refusal(
  ops: Op[],
  state: ReturnType<typeof draftStateFor>,
  merged: boolean,
): Extract<ProposeResult, { kind: "too_big" | "uneditable" }> | null {
  const shape = state.blocked.find((l) => l.key === "blocked.unsupportedShape");
  if (shape) return { kind: "uneditable", question: shape.params.question === "travelers" ? "travelers" : "phases" };
  if (tooBig(ops, state)) return { kind: "too_big", merged };
  return null;
}

/** True when a computed draft is over the operation cap or would not fit one message. */
function tooBig(ops: Op[], state: ReturnType<typeof draftStateFor>): boolean {
  return ops.length > MAX_DRAFT_OPS || previewLength({ ops, ...state }) > PREVIEW_BUDGET_CHARS;
}

/**
 * Ends a draft that has become too big to show, IN THE OPEN TRANSACTION. A draft
 * that cannot be shown cannot be confirmed or cancelled by its buttons, and it
 * would block Confirm for good: so it is dropped (and the caller says so).
 */
async function dropTooBig(client: pg.PoolClient, draftId: string): Promise<void> {
  await client.query(
    `UPDATE control_plane.intake_pending_changes
        SET status = 'cancelled', resolved_at = now(), resolved_by = 'system', updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [draftId],
  );
}

export async function proposeChange(db: Db, input: ProposeInput): Promise<ProposeResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await lockedSession(client, input.sessionId);
    if (!locked) { await client.query("ROLLBACK"); return { kind: "no_session" }; }
    const held = locked.answers;
    // An immutable interview takes no proposal: the apply would refuse it later
    // and the organizer would have been shown a change that could never happen.
    if (locked.state === "confirmed") { await client.query("ROLLBACK"); return { kind: "confirmed" }; }

    const replay = await client.query<DraftRow>(
      `SELECT ${COLUMNS} FROM control_plane.intake_pending_changes
        WHERE session_id = $1 AND $2 = ANY(interpretation_ids) LIMIT 1`,
      [input.sessionId, input.interpretationId],
    );
    if (replay.rows[0]) { await client.query("ROLLBACK"); return { kind: "replay", draft: toDraft(replay.rows[0]) }; }

    const open = await client.query<DraftRow>(
      `SELECT ${COLUMNS} FROM control_plane.intake_pending_changes
        WHERE session_id = $1 AND status = 'pending' FOR UPDATE`,
      [input.sessionId],
    );
    let draft: DraftRow;
    let kind: "created" | "merged";
    if (open.rows[0]) {
      const ops = mergeOps(open.rows[0].ops, input.ops, held);
      const state = draftStateFor(held, ops);
      const refused = refusal(ops, state, true);
      if (refused) { await client.query("ROLLBACK"); return refused; }
      const updated = await client.query<DraftRow>(
        `UPDATE control_plane.intake_pending_changes
            SET ops = $2::jsonb, base = $3::jsonb, result = $4::jsonb, preview = $5::jsonb,
                unresolved = $6::jsonb, blocked = $7::jsonb,
                interpretation_ids = array_append(interpretation_ids, $8), updated_at = now()
          WHERE id = $1
        RETURNING ${COLUMNS}`,
        [open.rows[0].id, JSON.stringify(ops), JSON.stringify(state.base), JSON.stringify(state.result),
          JSON.stringify(state.preview), JSON.stringify(state.unresolved), JSON.stringify(state.blocked),
          input.interpretationId],
      );
      draft = updated.rows[0]!;
      kind = "merged";
    } else {
      const ops = [...input.ops];
      const state = draftStateFor(held, ops);
      const refused = refusal(ops, state, false);
      if (refused) { await client.query("ROLLBACK"); return refused; }
      const inserted = await client.query<DraftRow>(
        `INSERT INTO control_plane.intake_pending_changes
           (id, session_id, trip_id, interpretation_ids, base, ops, result, preview, unresolved, blocked, displaced_prompt)
         VALUES ($1, $2, $3, ARRAY[$4]::text[], $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11)
         RETURNING ${COLUMNS}`,
        [`pchg_${randomBytes(16).toString("hex")}`, input.sessionId, input.tripId, input.interpretationId,
          JSON.stringify(state.base), JSON.stringify(ops), JSON.stringify(state.result), JSON.stringify(state.preview),
          JSON.stringify(state.unresolved), JSON.stringify(state.blocked), input.displacedPrompt ?? null],
      );
      draft = inserted.rows[0]!;
      kind = "created";
    }
    await client.query("COMMIT");
    return { kind, draft: toDraft(draft) };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/** The draft (in any status) this interpretation's operations went into, if it has one. */
export async function getDraftForInterpretation(db: Db, sessionId: string, interpretationId: string): Promise<Draft | null> {
  const row = await db.query<DraftRow>(
    `SELECT ${COLUMNS} FROM control_plane.intake_pending_changes
      WHERE session_id = $1 AND $2 = ANY(interpretation_ids) LIMIT 1`,
    [sessionId, interpretationId],
  );
  return row.rows[0] ? toDraft(row.rows[0]) : null;
}

export async function getOpenDraft(db: Db, sessionId: string): Promise<Draft | null> {
  const row = await db.query<DraftRow>(
    `SELECT ${COLUMNS} FROM control_plane.intake_pending_changes WHERE session_id = $1 AND status = 'pending'`,
    [sessionId],
  );
  return row.rows[0] ? toDraft(row.rows[0]) : null;
}

export async function getDraft(db: Db, draftId: string): Promise<Draft | null> {
  const row = await db.query<DraftRow>(
    `SELECT ${COLUMNS} FROM control_plane.intake_pending_changes WHERE id = $1`,
    [draftId],
  );
  return row.rows[0] ? toDraft(row.rows[0]) : null;
}

/**
 * What a waiting draft's preview went out OVER, when that is not what the draft
 * was proposed under (#225). The prompt recorded at proposal time comes from the
 * session as it was when the message ARRIVED; a tap answered during the read can
 * have put something else on screen - the boundary offer, which is sent once and
 * comes back only if it is named here. False when the draft is no longer waiting.
 */
export async function recordDisplacedPrompt(db: Db, input: { draftId: string; sessionId: string; prompt: string }): Promise<boolean> {
  const res = await db.query(
    `UPDATE control_plane.intake_pending_changes
        SET displaced_prompt = $3, updated_at = now()
      WHERE id = $1 AND session_id = $2 AND status = 'pending'`,
    [input.draftId, input.sessionId, input.prompt],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Ends the session's open draft without applying it. False when this session has no such draft. */
export async function cancelDraft(db: Db, input: { draftId: string; sessionId: string; by: string }): Promise<boolean> {
  const res = await db.query(
    `UPDATE control_plane.intake_pending_changes
        SET status = 'cancelled', resolved_at = now(), resolved_by = $3, updated_at = now()
      WHERE id = $1 AND session_id = $2 AND status = 'pending'`,
    [input.draftId, input.sessionId, input.by],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * The stored operations, recomputed against what is held NOW — for a
 * confirmation that found its `base` out of date. Nothing is applied; the
 * refreshed change is shown again. Null when the session has no such open draft.
 */
export async function rebuildDraft(db: Db, input: { draftId: string; sessionId: string }): Promise<Draft | null | "too_big"> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const held = await lockedAnswers(client, input.sessionId);
    if (!held) { await client.query("ROLLBACK"); return null; }
    const open = await client.query<DraftRow>(
      `SELECT ${COLUMNS} FROM control_plane.intake_pending_changes
        WHERE id = $1 AND session_id = $2 AND status = 'pending' FOR UPDATE`,
      [input.draftId, input.sessionId],
    );
    if (!open.rows[0]) { await client.query("ROLLBACK"); return null; }
    const state = draftStateFor(held, open.rows[0].ops);
    // What is held can have grown since (a document): the same budget applies as
    // when the draft was made, and a draft over it is dropped, not left stuck.
    if (tooBig(open.rows[0].ops, state)) {
      await dropTooBig(client, input.draftId);
      await client.query("COMMIT");
      return "too_big";
    }
    const updated = await client.query<DraftRow>(
      `UPDATE control_plane.intake_pending_changes
          SET base = $2::jsonb, result = $3::jsonb, preview = $4::jsonb, unresolved = $5::jsonb, blocked = $6::jsonb,
              updated_at = now()
        WHERE id = $1
      RETURNING ${COLUMNS}`,
      [input.draftId, JSON.stringify(state.base), JSON.stringify(state.result), JSON.stringify(state.preview),
        JSON.stringify(state.unresolved), JSON.stringify(state.blocked)],
    );
    await client.query("COMMIT");
    return toDraft(updated.rows[0]!);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The person's answer to what the draft is asking — option `k` of a choice, or
 * candidate `k` of an ambiguous reference — folded into the draft's operations,
 * and everything recomputed against what is held now. Null when the session has
 * no such open draft, or `k` names nothing.
 */
export async function pickForDraft(
  db: Db,
  input: { draftId: string; sessionId: string; k: number; expectedDigest?: string },
): Promise<Draft | null | "updated" | "too_big"> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const held = await lockedAnswers(client, input.sessionId);
    if (!held) { await client.query("ROLLBACK"); return null; }
    const open = await client.query<DraftRow>(
      `SELECT ${COLUMNS} FROM control_plane.intake_pending_changes
        WHERE id = $1 AND session_id = $2 AND status = 'pending' FOR UPDATE`,
      [input.draftId, input.sessionId],
    );
    const row = open.rows[0];
    // The tap named the version it was drawn for; candidate `k` of an older
    // version can be a different entry now, so it is never applied to this one.
    if (row && input.expectedDigest !== undefined && input.expectedDigest !== draftDigest(row)) {
      await client.query("ROLLBACK");
      return "updated";
    }
    const ops = row ? applyPick(row.ops, row, held, input.k) : null;
    if (!row || !ops) { await client.query("ROLLBACK"); return null; }
    const state = draftStateFor(held, ops);
    // The pick can turn a short question ("which Tokyo?") into a long preview.
    if (tooBig(ops, state)) {
      await dropTooBig(client, row.id);
      await client.query("COMMIT");
      return "too_big";
    }
    const updated = await client.query<DraftRow>(
      `UPDATE control_plane.intake_pending_changes
          SET ops = $2::jsonb, base = $3::jsonb, result = $4::jsonb, preview = $5::jsonb,
              unresolved = $6::jsonb, blocked = $7::jsonb, updated_at = now()
        WHERE id = $1
      RETURNING ${COLUMNS}`,
      [row.id, JSON.stringify(ops), JSON.stringify(state.base), JSON.stringify(state.result),
        JSON.stringify(state.preview), JSON.stringify(state.unresolved), JSON.stringify(state.blocked)],
    );
    await client.query("COMMIT");
    return toDraft(updated.rows[0]!);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}
