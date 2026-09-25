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
import { applyOps, applyPick, mergeOps, questionOfOp, type Line, type Op, type Unresolved } from "./typed-changes.js";

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

async function lockedAnswers(client: pg.PoolClient, sessionId: string): Promise<AnswerStore | null> {
  const row = await client.query<{ answers: AnswerStore }>(
    "SELECT answers FROM control_plane.intake_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  return row.rows[0]?.answers ?? null;
}

export type ProposeResult =
  | { kind: "created" | "merged" | "replay"; draft: Draft }
  | { kind: "no_session" };

export interface ProposeInput {
  sessionId: string;
  tripId: string;
  /** The interpretation this came from: the idempotency key. */
  interpretationId: string;
  ops: readonly Op[];
  /** The prompt this change puts off the screen, to restore when it resolves. Kept from the first proposal. */
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
export async function proposeChange(db: Db, input: ProposeInput): Promise<ProposeResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const held = await lockedAnswers(client, input.sessionId);
    if (!held) { await client.query("ROLLBACK"); return { kind: "no_session" }; }

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
export async function rebuildDraft(db: Db, input: { draftId: string; sessionId: string }): Promise<Draft | null> {
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
  input: { draftId: string; sessionId: string; k: number },
): Promise<Draft | null> {
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
    const ops = row ? applyPick(row.ops, row, held, input.k) : null;
    if (!row || !ops) { await client.query("ROLLBACK"); return null; }
    const state = draftStateFor(held, ops);
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
