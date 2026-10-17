/**
 * The document registry (migration 0052): what a trip's documents are, how each
 * one arrived, and what was read out of it.
 *
 * Three identities, kept apart on purpose — see the migration header for the
 * long version:
 *
 *   trip_documents             content, once per trip
 *   source_artifacts           each delivery of that content
 *   trip_document_extractions  each reading of it, per processing configuration
 *
 * Every function here is scoped by trip. There is no lookup by digest alone,
 * because a digest is not an authorization: the same voucher on two trips is two
 * documents, and knowing its hash grants nothing on either.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { isCanonicalRecordSafe } from "./canonical.js";

type Db = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

// ── Documents ────────────────────────────────────────────────────────────────

export type IngestState = "reserved" | "stored" | "unstored";

export interface TripDocument {
  id: string;
  tripId: string;
  contentDigest: string;
  byteSize: number;
  mime: string | null;
  storageKey: string | null;
  ingestState: IngestState;
  createdAt: Date;
  storedAt: Date | null;
}

interface DocumentRow {
  id: string;
  trip_id: string;
  content_digest: string;
  byte_size: number;
  mime: string | null;
  storage_key: string | null;
  ingest_state: IngestState;
  created_at: Date;
  stored_at: Date | null;
}

const DOCUMENT_COLUMNS = "id, trip_id, content_digest, byte_size, mime, storage_key, ingest_state, created_at, stored_at";

function toDocument(row: DocumentRow): TripDocument {
  return {
    id: row.id,
    tripId: row.trip_id,
    contentDigest: row.content_digest,
    byteSize: row.byte_size,
    mime: row.mime,
    storageKey: row.storage_key,
    ingestState: row.ingest_state,
    createdAt: row.created_at,
    storedAt: row.stored_at,
  };
}

/**
 * Claim the content identity for these bytes on this trip.
 *
 * Idempotent on (trip, digest): the second upload of the same file gets the
 * first upload's row back with `created: false`, which is how a re-sent
 * confirmation avoids becoming a second document, a second extraction and a
 * second booking. Concurrent claims converge through the unique index.
 */
export async function reserveDocument(
  db: Db,
  input: { tripId: string; digest: string; byteSize: number; mime?: string | null },
): Promise<{ document: TripDocument; created: boolean }> {
  const inserted = await db.query<DocumentRow>(
    `INSERT INTO control_plane.trip_documents (id, trip_id, content_digest, byte_size, mime)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (trip_id, content_digest) DO NOTHING
     RETURNING ${DOCUMENT_COLUMNS}`,
    [newId("doc"), input.tripId, input.digest, input.byteSize, input.mime ?? null],
  );
  if (inserted.rows[0]) return { document: toDocument(inserted.rows[0]), created: true };

  const existing = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM control_plane.trip_documents
      WHERE trip_id = $1 AND content_digest = $2`,
    [input.tripId, input.digest],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("trip document vanished between claim and read");
  return { document: toDocument(row), created: false };
}

/**
 * Record that the bytes are on disk. Idempotent: marking an already-stored
 * document with the same key is a no-op success, and a different key is refused
 * — a document's storage key never silently moves.
 */
export async function markDocumentStored(
  db: Db,
  input: { tripId: string; documentId: string; storageKey: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE control_plane.trip_documents
        SET ingest_state = 'stored',
            storage_key = $3,
            stored_at = COALESCE(stored_at, now())
      WHERE id = $1 AND trip_id = $2
        AND (ingest_state IN ('reserved', 'unstored') OR storage_key = $3)`,
    [input.documentId, input.tripId, input.storageKey],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Record that the document was read but its bytes were not kept — no store is
 * configured, or the store refused the write. Only a reservation moves here: a
 * stored document never goes back to having no bytes.
 */
export async function markDocumentUnstored(
  db: Db,
  input: { tripId: string; documentId: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE control_plane.trip_documents
        SET ingest_state = 'unstored'
      WHERE id = $1 AND trip_id = $2 AND ingest_state IN ('reserved', 'unstored')`,
    [input.documentId, input.tripId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getTripDocument(db: Db, tripId: string, documentId: string): Promise<TripDocument | null> {
  const res = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM control_plane.trip_documents WHERE id = $1 AND trip_id = $2`,
    [documentId, tripId],
  );
  return res.rows[0] ? toDocument(res.rows[0]) : null;
}

/**
 * This trip's document for these bytes, if it has one. Trip-scoped like every
 * lookup here — it answers "has THIS trip already got it", which is what lets a
 * re-sent photo reuse its transcription instead of paying for a second one.
 */
export async function findTripDocumentByDigest(db: Db, tripId: string, digest: string): Promise<TripDocument | null> {
  const res = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM control_plane.trip_documents WHERE trip_id = $1 AND content_digest = $2`,
    [tripId, digest],
  );
  return res.rows[0] ? toDocument(res.rows[0]) : null;
}

export interface ListedDocument extends TripDocument {
  /** The most recent name a sender gave it — for the organizer's own recap. */
  filename: string | null;
  deliveries: number;
}

/** A trip's documents, oldest first, each with its latest filename. */
export async function listTripDocuments(db: Db, tripId: string): Promise<ListedDocument[]> {
  const res = await db.query<DocumentRow & { filename: string | null; deliveries: number }>(
    `SELECT d.id, d.trip_id, d.content_digest, d.byte_size, d.mime, d.storage_key,
            d.ingest_state, d.created_at, d.stored_at,
            (SELECT a.filename FROM control_plane.source_artifacts a
              WHERE a.document_id = d.id AND a.trip_id = d.trip_id
              ORDER BY a.received_at DESC LIMIT 1) AS filename,
            (SELECT count(*)::int FROM control_plane.source_artifacts a
              WHERE a.document_id = d.id AND a.trip_id = d.trip_id) AS deliveries
       FROM control_plane.trip_documents d
      WHERE d.trip_id = $1
      ORDER BY d.created_at, d.id`,
    [tripId],
  );
  return res.rows.map((row) => ({ ...toDocument(row), filename: row.filename, deliveries: row.deliveries }));
}

/**
 * Documents whose bytes never landed — a crash between the claim and the write.
 * Recovery retries the write if the bytes are still to hand, and otherwise the
 * row is removed so a later upload of the same file is not blocked behind it.
 */
export async function staleReservedDocuments(db: Db, olderThanSeconds: number): Promise<TripDocument[]> {
  const res = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM control_plane.trip_documents
      WHERE ingest_state = 'reserved' AND created_at < now() - make_interval(secs => $1)
      ORDER BY created_at`,
    [olderThanSeconds],
  );
  return res.rows.map(toDocument);
}

/** Drop a reservation whose bytes never landed. Never touches a stored document. */
export async function releaseReservation(db: Db, tripId: string, documentId: string): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM control_plane.trip_documents
      WHERE id = $1 AND trip_id = $2 AND ingest_state = 'reserved'`,
    [documentId, tripId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Deliveries ───────────────────────────────────────────────────────────────

/** A name worth showing back to the organizer, and nothing that could be markup. */
export function cleanFilename(filename: string | null | undefined): string | null {
  const cleaned = String(filename ?? "")
    // Control characters, including the bidi overrides that make
    // `txt.exe` render as `exe.txt` — a name is shown back to a person.
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 200);
  return cleaned || null;
}

export type DeliveryReviewStatus = "pending" | "approved" | "rejected" | "superseded";

/**
 * Record one delivery of a document.
 *
 * `sourceRef` identifies the delivery within its channel — for Telegram the chat
 * and message — so redelivery of the SAME message is one row, while the same
 * bytes sent again in a new message are a second delivery of one document.
 *
 * `provenance` is canonical-checked by the database. It is for short structured
 * facts only; anything that would fail that check is dropped here rather than
 * failing the insert, because losing a message id is better than losing the
 * record that a document arrived at all.
 */
export async function recordDelivery(
  db: Db,
  input: {
    tripId: string;
    documentId: string;
    digest: string;
    provider: string;
    sourceRef: string;
    filename?: string | null;
    reviewStatus: DeliveryReviewStatus;
    provenance?: Record<string, unknown>;
  },
): Promise<{ artifactId: string; duplicate: boolean }> {
  const provenance = input.provenance && isCanonicalRecordSafe(input.provenance) ? input.provenance : {};
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO control_plane.source_artifacts
       (id, trip_id, provider, source_ref, source_digest, review_status, provenance, document_id, filename)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (trip_id, provider, source_ref, source_digest) DO NOTHING
     RETURNING id`,
    [
      newId("art"),
      input.tripId,
      input.provider,
      input.sourceRef,
      input.digest,
      input.reviewStatus,
      JSON.stringify(provenance),
      input.documentId,
      cleanFilename(input.filename),
    ],
  );
  if (inserted.rows[0]) return { artifactId: inserted.rows[0].id, duplicate: false };

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM control_plane.source_artifacts
      WHERE trip_id = $1 AND provider = $2 AND source_ref = $3 AND source_digest = $4`,
    [input.tripId, input.provider, input.sourceRef, input.digest],
  );
  const id = existing.rows[0]?.id;
  if (!id) throw new Error("delivery vanished between claim and read");
  return { artifactId: id, duplicate: true };
}

// ── Extractions ──────────────────────────────────────────────────────────────

export type ExtractionStatus = "ok" | "empty" | "unreadable" | "failed";

export interface CoverageUnit {
  unit: "page" | "sheet" | "document" | "image";
  index: number;
  chars: number;
  usable: boolean;
  cut?: boolean;
}

export interface ProcessingConfig {
  /** The reader: parser version and its normalisation rules. */
  readerVersion: string;
  /** The extraction prompt and output schema. */
  extractorVersion: string;
  /** The runner task the call went through. */
  task: string;
  /** The task's pinned provider and model, as configured — never inferred. */
  provider: string | null;
  model: string | null;
}

/**
 * The idempotency key for one reading of a document.
 *
 * Everything that could change the answer is in it. A delivery retry produces
 * the same key and finds the stored result; a new reader, prompt, schema or
 * model produces a different one, so an intentional re-extraction is never
 * mistaken for a duplicate.
 */
export function processingKey(config: ProcessingConfig): string {
  const canonical = JSON.stringify([
    config.readerVersion,
    config.extractorVersion,
    config.task,
    config.provider ?? "",
    config.model ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface DocumentExtraction {
  id: string;
  documentId: string;
  tripId: string;
  processingKey: string;
  readerVersion: string;
  extractorVersion: string;
  provider: string | null;
  model: string | null;
  status: ExtractionStatus;
  failureReason: string | null;
  text: string | null;
  textChars: number | null;
  truncated: boolean;
  coverage: CoverageUnit[];
  result: unknown;
  createdAt: Date;
}

interface ExtractionRow {
  id: string;
  document_id: string;
  trip_id: string;
  processing_key: string;
  reader_version: string;
  extractor_version: string;
  provider: string | null;
  model: string | null;
  status: ExtractionStatus;
  failure_reason: string | null;
  text: string | null;
  text_chars: number | null;
  truncated: boolean;
  coverage: CoverageUnit[];
  result: unknown;
  created_at: Date;
}

const EXTRACTION_COLUMNS =
  "id, document_id, trip_id, processing_key, reader_version, extractor_version, provider, model, status, failure_reason, text, text_chars, truncated, coverage, result, created_at";

function toExtraction(row: ExtractionRow): DocumentExtraction {
  return {
    id: row.id,
    documentId: row.document_id,
    tripId: row.trip_id,
    processingKey: row.processing_key,
    readerVersion: row.reader_version,
    extractorVersion: row.extractor_version,
    provider: row.provider,
    model: row.model,
    status: row.status,
    failureReason: row.failure_reason,
    text: row.text,
    textChars: row.text_chars,
    truncated: row.truncated,
    coverage: row.coverage ?? [],
    result: row.result,
    createdAt: row.created_at,
  };
}

export async function findExtraction(
  db: Db,
  input: { tripId: string; documentId: string; processingKey: string },
): Promise<DocumentExtraction | null> {
  const res = await db.query<ExtractionRow>(
    `SELECT ${EXTRACTION_COLUMNS} FROM control_plane.trip_document_extractions
      WHERE trip_id = $1 AND document_id = $2 AND processing_key = $3`,
    [input.tripId, input.documentId, input.processingKey],
  );
  return res.rows[0] ? toExtraction(res.rows[0]) : null;
}

/**
 * Store one reading. Idempotent on (document, processing key): if a concurrent
 * worker already stored it, that row wins and is returned with `created: false`
 * — the second answer to the same question is discarded, never merged, so a
 * retried model call cannot produce two results for one document.
 */
export async function saveExtraction(
  db: Db,
  input: {
    tripId: string;
    documentId: string;
    config: ProcessingConfig;
    status: ExtractionStatus;
    failureReason?: string | null;
    text?: string | null;
    truncated?: boolean;
    coverage?: CoverageUnit[];
    result?: unknown;
  },
): Promise<{ extraction: DocumentExtraction; created: boolean }> {
  const key = processingKey(input.config);
  const inserted = await db.query<ExtractionRow>(
    `INSERT INTO control_plane.trip_document_extractions
       (id, document_id, trip_id, reader_version, extractor_version, provider, model,
        processing_key, status, failure_reason, text, text_chars, truncated, coverage, result)
     SELECT $1, d.id, d.trip_id, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb
       FROM control_plane.trip_documents d
      WHERE d.id = $2 AND d.trip_id = $3
     ON CONFLICT (document_id, processing_key) DO NOTHING
     RETURNING ${EXTRACTION_COLUMNS}`,
    [
      newId("dex"),
      input.documentId,
      input.tripId,
      input.config.readerVersion,
      input.config.extractorVersion,
      input.config.provider,
      input.config.model,
      key,
      input.status,
      input.failureReason ?? null,
      input.text ?? null,
      input.text == null ? null : input.text.length,
      input.truncated ?? false,
      JSON.stringify(input.coverage ?? []),
      input.result === undefined ? null : JSON.stringify(input.result),
    ],
  );
  if (inserted.rows[0]) return { extraction: toExtraction(inserted.rows[0]), created: true };

  const existing = await findExtraction(db, { tripId: input.tripId, documentId: input.documentId, processingKey: key });
  if (!existing) {
    // The SELECT found no document on this trip: a wrong trip id, not a race.
    throw new Error("document does not belong to this trip");
  }
  return { extraction: existing, created: false };
}
