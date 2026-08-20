-- Sprint 4: provisioner, intake correction, and organizer notifications.
--
-- notification_outbox already exists since migration 0006 for signup
-- notifications. Extend that table for trip notifications instead of
-- recreating it with an incompatible schema.

ALTER TABLE control_plane.intake_versions
  ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Recover answers for intake versions created before this migration when the
-- original interview session is still present. Rows without a recoverable
-- session remain empty and are rejected explicitly by the provisioner.
UPDATE control_plane.intake_versions iv
SET data = s.answers
FROM control_plane.intake_sessions s
WHERE iv.data = '{}'::jsonb
  AND iv.artifact_ref LIKE 'intake:sessions:%'
  AND s.id = split_part(iv.artifact_ref, ':', 3)
  AND s.answers <> '{}'::jsonb;

ALTER TABLE control_plane.notification_outbox
  ADD COLUMN trip_id text REFERENCES control_plane.trips(id),
  ADD COLUMN kind text,
  ADD COLUMN recipient text,
  ADD COLUMN payload jsonb;

CREATE INDEX notification_outbox_trip_unsent_idx
  ON control_plane.notification_outbox (created_at)
  WHERE sent_at IS NULL AND trip_id IS NOT NULL;
