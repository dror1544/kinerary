-- The documents a trip is reconstructed from, and what we read out of them.
--
-- WHAT WAS THERE BEFORE. One jsonb column, `intake_sessions.source_document`
-- (0024), holding `{filename, text, savedAt}` for the LAST document read. A
-- second upload overwrote the first, a burst of five files was joined with
-- blank lines and stored as one blob, and nothing ever read the column back --
-- the re-extraction it was added for was never built. The bytes were never
-- kept at all: the relay re-hosts an attachment in memory for an hour and then
-- drops it. So a trip assembled from four confirmations had no record of the
-- four, no way to show an organizer the voucher behind a phase, and no way to
-- re-read a document when the extractor improved.
--
-- THREE IDENTITIES, THREE TABLES. The single-jsonb version failed by
-- conflating them:
--
--   trip_documents             WHAT the bytes are. One row per distinct
--                              content per trip.
--   source_artifacts (0001)    HOW it arrived. One row per delivery -- channel,
--                              reference, filename, when.
--   trip_document_extractions  WHAT WE READ out of it, under a named reader and
--                              model configuration. One row per document per
--                              processing version.
--
-- The same PDF forwarded twice is one document, two deliveries, one extraction.
-- Re-running an improved extractor over it is one document, two deliveries, two
-- extractions. Collapsing any pair of those makes one of those sentences
-- unsayable.
--
-- WHY source_artifacts IS REUSED RATHER THAN REPLACED. It has been in the
-- schema since 0001 with exactly the delivery shape -- provider, source_ref,
-- digest, provenance, review_status -- and no code has ever written to it. Note
-- what its UNIQUE (trip_id, provider, source_ref, source_digest) actually says:
-- it is per-DELIVERY, not per-content. The same bytes arriving in two Telegram
-- messages differ in source_ref and are correctly two rows. That is why content
-- identity needs a table of its own rather than leaning on this constraint,
-- which is the trap the column list looks like it already solves.
--
-- WHY THE TEXT IS NOT IN source_artifacts.provenance. That column carries the
-- canonical-safety CHECK (0002, re-added in 0004): a value containing
-- `Bearer `, `/Users/`, `/home/` or a private IP fails the INSERT. Document
-- text is uncontrolled input -- a saved booking page or a Mac-exported PDF
-- plausibly contains all four -- so putting extracted text there would reject
-- precisely the documents worth keeping. Text lives on the extraction row,
-- which carries no such CHECK, for the same reason 0024 put the source document
-- beside `data` rather than inside it: one is canonical trip state, the other
-- is bulk input. `provenance` keeps its intent -- short, safe, structured facts
-- about the delivery.
--
-- WHY THE BYTES ARE NOT IN POSTGRES. They belong on the same NFS storage every
-- other piece of trip media already uses (avatars, photos, the site's own
-- confirmation PDFs), which the deploy path already knows never to sync from
-- git. The registry stores a RELATIVE storage key, so the root stays
-- deployment configuration and moving it is not a migration.

-- -- What the bytes are ------------------------------------------------------

CREATE TABLE IF NOT EXISTS control_plane.trip_documents (
  id            text PRIMARY KEY,
  trip_id       text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  -- sha256 of the ORIGINAL bytes, in the `sha256:<hex>` shape every other
  -- digest in this schema uses. Content identity is per trip, never global: the
  -- same voucher on two trips is two documents with two authorizations, because
  -- someone entitled to read one has no claim on the other.
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  byte_size     integer NOT NULL CHECK (byte_size >= 0),
  -- As detected from the bytes and the sender's filename. Advisory only: the
  -- reader sniffs content and does not trust this to decide how to parse.
  mime          text,
  -- Relative to the configured document root -- `<trip_id>/<digest><ext>`.
  -- Never absolute, so the root stays configuration; never anything the
  -- uploader supplied, because a filename used as a path component is a
  -- traversal waiting to happen. A filename is metadata and lives on the
  -- delivery row.
  storage_key   text,
  -- 'reserved' the instant the row is claimed, 'stored' once the bytes are on
  -- disk with size and digest verified. Postgres and the filesystem cannot
  -- share a transaction, so this row IS the recovery record: a 'reserved' row
  -- with no blob is an interrupted write to retry or sweep, and a blob with no
  -- row is an orphan the sweeper may delete precisely because nothing points
  -- at it.
  --
  -- 'unstored' is a document we read but did not keep the bytes of — a relay
  -- with no document store configured, or a store that refused the write. It
  -- is still a document: it has an identity, deliveries and extractions. It
  -- is simply not one anybody can open, and the row says so rather than
  -- sitting in 'reserved' where a sweeper would mistake it for a crash.
  ingest_state  text NOT NULL DEFAULT 'reserved',
  created_at    timestamptz NOT NULL DEFAULT now(),
  stored_at     timestamptz,

  CONSTRAINT trip_documents_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT trip_documents_ingest_state_check
    CHECK (ingest_state IN ('reserved', 'stored', 'unstored')),
  -- A row may not claim to be stored without saying where and when.
  CONSTRAINT trip_documents_stored_has_key
    CHECK (ingest_state <> 'stored' OR (storage_key IS NOT NULL AND stored_at IS NOT NULL))
);

-- The content identity this whole feature turns on. Re-uploading the same file
-- must not create a second document, pay for a second extraction, or file a
-- second booking -- and an organizer re-sending a confirmation "in case it did
-- not arrive" is the ordinary case, not the edge one.
CREATE UNIQUE INDEX IF NOT EXISTS trip_documents_content_idx
  ON control_plane.trip_documents (trip_id, content_digest);

-- -- How it arrived ----------------------------------------------------------

-- A delivery points at content. Nullable because the column is added to an
-- existing table, and because a delivery can be recorded before the bytes
-- settle.
ALTER TABLE control_plane.source_artifacts
  ADD COLUMN IF NOT EXISTS document_id text
  REFERENCES control_plane.trip_documents(id) ON DELETE CASCADE;

-- The name the sender gave it, kept for the organizer's own recap ("I read
-- Yapan Tours.pdf"). Deliberately NOT in `provenance`, which is
-- canonical-checked and would reject perfectly ordinary filenames.
ALTER TABLE control_plane.source_artifacts
  ADD COLUMN IF NOT EXISTS filename text;

ALTER TABLE control_plane.source_artifacts
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS source_artifacts_document_idx
  ON control_plane.source_artifacts (document_id);

-- -- What we read out of it --------------------------------------------------

CREATE TABLE IF NOT EXISTS control_plane.trip_document_extractions (
  id            text PRIMARY KEY,
  document_id   text NOT NULL REFERENCES control_plane.trip_documents(id) ON DELETE CASCADE,
  -- Denormalised so a trip's extractions can be listed and scoped without a
  -- join, and so the row stays trip-scoped on its own terms.
  trip_id       text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  -- Everything that could change what this row would say if it ran again: the
  -- parser, the prompt and schema, and the task's pinned provider and model.
  -- Hashed together into `processing_key`. A delivery retry REUSES a row; an
  -- intentional re-extraction under an improved reader is a DIFFERENT row, and
  -- that difference is the point -- "we already did this" must never block the
  -- re-read that fixes a bad one.
  reader_version    text NOT NULL,
  extractor_version text NOT NULL,
  provider      text,
  model         text,
  processing_key text NOT NULL,
  -- 'ok' | 'empty' | 'unreadable' | 'failed'. Failure is a value here, as it is
  -- in the model runner: a document we could not read is a fact about the
  -- document that the organizer is owed, not an exception to swallow.
  status        text NOT NULL,
  failure_reason text,
  -- The normalised text this extraction actually saw. No canonical CHECK, for
  -- the reason in the header. Null on a failed read.
  text          text,
  text_chars    integer,
  -- Whether the reader had to stop early. A document that was cut off must
  -- never be reported as fully processed -- the silent slice is the bug this
  -- column exists to make impossible to repeat.
  truncated     boolean NOT NULL DEFAULT false,
  -- Per page, per sheet: `[{unit, index, chars, usable}]`. What we read, what we
  -- could not, and therefore what the organizer should be told. Our own shape,
  -- so canonical-safe by construction.
  coverage      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The model's own output, parsed and gated. Kept whole so a later
  -- reconciliation can be re-derived without paying for the call again.
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_document_extractions_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT trip_document_extractions_status_check
    CHECK (status IN ('ok', 'empty', 'unreadable', 'failed'))
);

-- One extraction per document per processing configuration. This is the
-- idempotency the document path has never had: today a redelivered burst pays
-- for the model call again every time, because the interpretation row it claims
-- is keyed by Telegram message ids and is never committed on the document
-- branch at all.
CREATE UNIQUE INDEX IF NOT EXISTS trip_document_extractions_processing_idx
  ON control_plane.trip_document_extractions (document_id, processing_key);

CREATE INDEX IF NOT EXISTS trip_document_extractions_trip_idx
  ON control_plane.trip_document_extractions (trip_id, created_at DESC);
