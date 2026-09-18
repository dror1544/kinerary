/**
 * Answer provenance and document disagreements (migration 0053).
 *
 * Sources say which documents an answer was built from — including the ones
 * that merely agreed with it, and the ones whose claims were refused, because
 * "three documents say this" and "one document said otherwise and was set aside"
 * are both things a person may need to know.
 *
 * Conflicts are the disagreements a person has to settle. Opening one is
 * idempotent on the disagreement itself, and resolving one is idempotent on the
 * decision: a double tap resolves it once and reports success both times.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { canonical } from "./answer-merge.js";

type Db = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export type SourceDisposition = "accepted" | "filled" | "unchanged" | "conflict" | "ambiguous" | "rejected";

export interface AnswerSource {
  tripId: string;
  questionId: string;
  entryKey: string;
  documentId: string;
  extractionId?: string | null;
  disposition: SourceDisposition;
  paths?: readonly string[];
  entrySnapshot?: unknown;
  reason?: string | null;
}

/** Record claims. A claim already recorded is left as it was. Returns how many were new. */
export async function recordAnswerSources(db: Db, sources: readonly AnswerSource[]): Promise<number> {
  let created = 0;
  for (const source of sources) {
    const res = await db.query(
      `INSERT INTO control_plane.trip_answer_sources
         (id, trip_id, question_id, entry_key, document_id, extraction_id, disposition, paths, entry_snapshot, reason)
       SELECT $1, d.trip_id, $3, $4, d.id, $6, $7, $8::text[], $9::jsonb, $10
         FROM control_plane.trip_documents d
        WHERE d.id = $5 AND d.trip_id = $2
       ON CONFLICT (trip_id, question_id, entry_key, document_id, disposition) DO NOTHING`,
      [
        newId("asrc"),
        source.tripId,
        source.questionId,
        source.entryKey,
        source.documentId,
        source.extractionId ?? null,
        source.disposition,
        [...(source.paths ?? [])],
        source.entrySnapshot === undefined ? null : JSON.stringify(source.entrySnapshot),
        source.reason ?? null,
      ],
    );
    created += res.rowCount ?? 0;
  }
  return created;
}

export interface StoredAnswerSource {
  questionId: string;
  entryKey: string;
  documentId: string;
  disposition: SourceDisposition;
  paths: string[];
}

export async function listAnswerSources(db: Db, tripId: string): Promise<StoredAnswerSource[]> {
  const res = await db.query<{
    question_id: string;
    entry_key: string;
    document_id: string;
    disposition: SourceDisposition;
    paths: string[];
  }>(
    `SELECT question_id, entry_key, document_id, disposition, paths
       FROM control_plane.trip_answer_sources
      WHERE trip_id = $1
      ORDER BY question_id, entry_key, created_at, id`,
    [tripId],
  );
  return res.rows.map((r) => ({
    questionId: r.question_id,
    entryKey: r.entry_key,
    documentId: r.document_id,
    disposition: r.disposition,
    paths: r.paths ?? [],
  }));
}

// ── Conflicts ────────────────────────────────────────────────────────────────

export type ConflictStatus = "open" | "kept" | "replaced" | "dismissed" | "superseded";

export interface AnswerConflict {
  id: string;
  tripId: string;
  questionId: string;
  entryKey: string;
  path: string;
  held: unknown;
  incoming: unknown;
  documentId: string;
  status: ConflictStatus;
  createdAt: Date;
}

interface ConflictRow {
  id: string;
  trip_id: string;
  question_id: string;
  entry_key: string;
  path: string;
  held: unknown;
  incoming: unknown;
  document_id: string;
  status: ConflictStatus;
  created_at: Date;
}

const CONFLICT_COLUMNS = "id, trip_id, question_id, entry_key, path, held, incoming, document_id, status, created_at";

function toConflict(row: ConflictRow): AnswerConflict {
  return {
    id: row.id,
    tripId: row.trip_id,
    questionId: row.question_id,
    entryKey: row.entry_key,
    path: row.path,
    held: row.held,
    incoming: row.incoming,
    documentId: row.document_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

function valueDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

/**
 * Open a disagreement, or find the one already open or settled for it. The
 * same document re-read raises the same disagreement, and it must not come
 * back as a new question — least of all one the organizer already answered.
 */
export async function openConflict(
  db: Db,
  input: {
    tripId: string;
    questionId: string;
    entryKey: string;
    path: string;
    held: unknown;
    incoming: unknown;
    documentId: string;
  },
): Promise<{ conflict: AnswerConflict; created: boolean }> {
  const digest = valueDigest(input.incoming);
  const inserted = await db.query<ConflictRow>(
    `INSERT INTO control_plane.trip_answer_conflicts
       (id, trip_id, question_id, entry_key, path, held, incoming, incoming_digest, document_id)
     SELECT $1, d.trip_id, $3, $4, $5, $6::jsonb, $7::jsonb, $8, d.id
       FROM control_plane.trip_documents d
      WHERE d.id = $9 AND d.trip_id = $2
     ON CONFLICT (trip_id, question_id, entry_key, path, incoming_digest) DO NOTHING
     RETURNING ${CONFLICT_COLUMNS}`,
    [
      newId("cfl"),
      input.tripId,
      input.questionId,
      input.entryKey,
      input.path,
      JSON.stringify(input.held ?? null),
      JSON.stringify(input.incoming ?? null),
      digest,
      input.documentId,
    ],
  );
  if (inserted.rows[0]) return { conflict: toConflict(inserted.rows[0]), created: true };

  const existing = await db.query<ConflictRow>(
    `SELECT ${CONFLICT_COLUMNS} FROM control_plane.trip_answer_conflicts
      WHERE trip_id = $1 AND question_id = $2 AND entry_key = $3 AND path = $4 AND incoming_digest = $5`,
    [input.tripId, input.questionId, input.entryKey, input.path, digest],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("document does not belong to this trip");
  return { conflict: toConflict(row), created: false };
}

/** The oldest disagreement still waiting on a person. */
export async function nextOpenConflict(db: Db, tripId: string): Promise<AnswerConflict | null> {
  const res = await db.query<ConflictRow>(
    `SELECT ${CONFLICT_COLUMNS} FROM control_plane.trip_answer_conflicts
      WHERE trip_id = $1 AND status = 'open'
      ORDER BY created_at, id
      LIMIT 1`,
    [tripId],
  );
  return res.rows[0] ? toConflict(res.rows[0]) : null;
}

export async function getConflict(db: Db, tripId: string, conflictId: string): Promise<AnswerConflict | null> {
  const res = await db.query<ConflictRow>(
    `SELECT ${CONFLICT_COLUMNS} FROM control_plane.trip_answer_conflicts WHERE id = $1 AND trip_id = $2`,
    [conflictId, tripId],
  );
  return res.rows[0] ? toConflict(res.rows[0]) : null;
}

/**
 * Settle a disagreement. Only an OPEN one moves; returns whether this call moved
 * it, so a double tap applies the decision once.
 */
export async function resolveConflict(
  db: Db,
  input: { tripId: string; conflictId: string; status: Exclude<ConflictStatus, "open">; resolvedBy: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE control_plane.trip_answer_conflicts
        SET status = $3, resolved_at = now(), resolved_by = $4
      WHERE id = $1 AND trip_id = $2 AND status = 'open'`,
    [input.conflictId, input.tripId, input.status, input.resolvedBy],
  );
  return (res.rowCount ?? 0) > 0;
}
