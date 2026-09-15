-- Where each answer came from, and where two documents disagree.
--
-- The registry (0052) records what documents a trip has and what was read out
-- of each. It does not say which answer a document supplied, so a hotel card
-- could not point at its voucher and nobody could ask "where did this date come
-- from". And there was nowhere for a DISAGREEMENT to live: a later document that
-- contradicted an earlier one was simply refused, and the contradiction was
-- lost with it.
--
-- WHY A SIDECAR AND NOT A FIELD IN THE ANSWER. The answers are the canonical
-- trip state, and their digest is what an intake version and a plan are pinned
-- to. Writing source ids into them would change that digest every time a
-- document was merely re-read, and would put document ids inside
-- `intake_versions.data` under its canonical-safety CHECK. Provenance is about
-- the answers, so it sits beside them — the same reasoning 0024 applied to the
-- source document itself.
--
-- WHY `entry_key` AND A SNAPSHOT. An entry has no id of its own: a stop is a
-- name and dates, a booking a reference. `entry_key` is the identity the merge
-- rules compute (answer-merge.ts `entryIdentity`), and `entry_snapshot` is the
-- entry as this document described it — so that when an organizer renames a
-- stop and the key moves, the link can still be recovered from the rest of the
-- entry instead of silently pointing at nothing.

CREATE TABLE IF NOT EXISTS control_plane.trip_answer_sources (
  id              text PRIMARY KEY,
  trip_id         text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  question_id     text NOT NULL,
  -- '' for the answer as a whole: a destination, a date.
  entry_key       text NOT NULL DEFAULT '',
  document_id     text NOT NULL REFERENCES control_plane.trip_documents(id) ON DELETE CASCADE,
  extraction_id   text REFERENCES control_plane.trip_document_extractions(id) ON DELETE SET NULL,
  -- What this document's claim about this entry became:
  --   accepted    it supplied the entry, or the whole answer
  --   filled      it added fields a held entry lacked
  --   unchanged   it agreed with what was already held — still a supporting source
  --   conflict    it stated a field differently; the held value was kept
  --   ambiguous   it could describe more than one held entry; not applied
  --   rejected    the gate refused it (evidence, validation)
  disposition     text NOT NULL,
  -- The fields it supplied or disputed.
  paths           text[] NOT NULL DEFAULT '{}',
  entry_snapshot  jsonb,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_answer_sources_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT trip_answer_sources_disposition_check
    CHECK (disposition IN ('accepted', 'filled', 'unchanged', 'conflict', 'ambiguous', 'rejected'))
);

-- One row per claim. Re-reading the same document into the same answer records
-- nothing new — which is what lets a retry run the whole path again safely.
CREATE UNIQUE INDEX IF NOT EXISTS trip_answer_sources_claim_idx
  ON control_plane.trip_answer_sources (trip_id, question_id, entry_key, document_id, disposition);

CREATE INDEX IF NOT EXISTS trip_answer_sources_document_idx
  ON control_plane.trip_answer_sources (document_id);

-- A disagreement a person has to settle.
--
-- Deliberately NOT in `intake_sessions.ui_state`: that column is parsed through
-- an allowlist in both directions, and a field added without touching both is
-- written and then silently dropped on the next read — which is exactly how
-- `deferred` was lost the first time. A disagreement between two booking
-- documents is worth more than that.
CREATE TABLE IF NOT EXISTS control_plane.trip_answer_conflicts (
  id              text PRIMARY KEY,
  trip_id         text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  question_id     text NOT NULL,
  entry_key       text NOT NULL DEFAULT '',
  path            text NOT NULL,
  held            jsonb,
  incoming        jsonb,
  -- sha256 of the canonical incoming value, so the same disagreement raised by
  -- a re-read is one conflict, not a new question every time.
  incoming_digest text NOT NULL,
  document_id     text NOT NULL REFERENCES control_plane.trip_documents(id) ON DELETE CASCADE,
  -- open       waiting on a person
  -- kept       they kept the held value
  -- replaced   they took the document's value
  -- dismissed  set aside without a decision
  -- superseded the held value changed some other way, so the question no longer applies
  status          text NOT NULL DEFAULT 'open',
  resolved_at     timestamptz,
  resolved_by     text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_answer_conflicts_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT trip_answer_conflicts_status_check
    CHECK (status IN ('open', 'kept', 'replaced', 'dismissed', 'superseded')),
  CONSTRAINT trip_answer_conflicts_resolved_shape
    CHECK ((status = 'open') = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_answer_conflicts_claim_idx
  ON control_plane.trip_answer_conflicts (trip_id, question_id, entry_key, path, incoming_digest);

CREATE INDEX IF NOT EXISTS trip_answer_conflicts_open_idx
  ON control_plane.trip_answer_conflicts (trip_id, created_at)
  WHERE status = 'open';
