-- Corrections a document proposes to a trip that is already confirmed.
--
-- Before confirmation, a document writes into the interview's answers like any
-- other answer. After confirmation the canonical record is an immutable intake
-- version, and nothing a model reads may change it without the organizer: model
-- confidence never authorizes. So a document received after confirmation
-- produces PROPOSALS here, each tied to the exact version it was computed
-- against, and only the organizer's approval turns one into a new version
-- (correctIntake).
--
-- One row per proposal:
--   kind 'changes'  everything the documents add or fill that disagrees with
--                   nothing held — approved or declined together
--   kind 'replace'  one disagreement: the document's value for one field of one
--                   entry, instead of the held value
--
-- A proposal is only ever applied to the version it was computed against. If
-- the trip has moved on — another correction, an organizer edit — approving it
-- marks it 'stale' and changes nothing: the organizer is asked to send the
-- document again, which costs no second model call (the reading is stored).
--
-- `status` moves pending -> applying -> approved | failed, or pending ->
-- rejected | stale. 'applying' exists so two taps on Approve cannot both apply.

CREATE TABLE IF NOT EXISTS control_plane.trip_document_corrections (
  id                 text PRIMARY KEY,
  trip_id            text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  kind               text NOT NULL,
  base_version_id    text NOT NULL REFERENCES control_plane.intake_versions(id) ON DELETE CASCADE,
  base_digest        text NOT NULL,
  -- The complete answer store this proposal would confirm — what correctIntake
  -- is handed, so what is approved is exactly what was shown.
  proposed_answers   jsonb NOT NULL,
  -- What changes, for showing the organizer and for the record.
  changes            jsonb NOT NULL,
  -- trip_answer_sources rows to write once approved.
  sources            jsonb NOT NULL DEFAULT '[]'::jsonb,
  document_ids       text[] NOT NULL,
  changes_digest     text NOT NULL,
  -- The organizer's own chat: the only place a decision is accepted from.
  requested_chat_id  text NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  failure_reason     text,
  decided_by         text,
  decided_at         timestamptz,
  result_version_id  text REFERENCES control_plane.intake_versions(id),
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_document_corrections_id_is_opaque CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT trip_document_corrections_kind_check CHECK (kind IN ('changes', 'replace')),
  CONSTRAINT trip_document_corrections_status_check
    CHECK (status IN ('pending', 'applying', 'approved', 'rejected', 'stale', 'failed')),
  CONSTRAINT trip_document_corrections_digest_check CHECK (changes_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT trip_document_corrections_decided_by_check CHECK (decided_by IS NULL OR decided_by ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT trip_document_corrections_approved_has_version
    CHECK (status <> 'approved' OR result_version_id IS NOT NULL),
  -- The same documents proposing the same change to the same version is one
  -- proposal, however many times the file is sent.
  CONSTRAINT trip_document_corrections_once UNIQUE (trip_id, base_version_id, changes_digest)
);

CREATE INDEX IF NOT EXISTS trip_document_corrections_pending_idx
  ON control_plane.trip_document_corrections (trip_id, status, created_at DESC);
