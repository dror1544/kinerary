-- Sprint 4: provisioner, intake correction, and organizer notification
--
-- 1. Add data jsonb to intake_versions so the provisioner can read answers
--    in a single query without joining back through intake_sessions.
--    Populated by confirmIntake (Sprint 2) and correctIntake (Sprint 4).
--    Existing rows keep the DEFAULT empty object; only the provisioner
--    reads this column and it always operates on the latest confirmed version.
-- 2. Create notification_outbox for provisioning completion/failure events
--    that the organizer notification adapter reads and dispatches.

-- ── intake_versions.data ──────────────────────────────────────────────────────

ALTER TABLE control_plane.intake_versions
  ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── notification_outbox ───────────────────────────────────────────────────────
--
-- kind values used in Sprint 4: 'provisioning_complete', 'provisioning_failed'.
-- recipient: 'organizer' for per-trip notifications, 'super_admin' for signup
-- events (not used in this sprint). No CHECK constraint so future sprints can
-- extend the vocabulary without a migration that only touches the enum.

CREATE TABLE control_plane.notification_outbox (
  id         text        PRIMARY KEY CHECK (id ~ '^notif_[A-Za-z0-9]{8,64}$'),
  trip_id    text        NOT NULL REFERENCES control_plane.trips(id),
  kind       text        NOT NULL,
  recipient  text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

CREATE INDEX notification_outbox_unsent_idx
  ON control_plane.notification_outbox (created_at)
  WHERE sent_at IS NULL;
