-- rollback: compatible — adds nullable columns that only this release writes or reads and widens one CHECK list by one value ('dashboard_restore') that only this release inserts; the previous release never reads telegram_organizer_trip_links, and a restored link is a per-trip row it cannot see, so a rollback can cost a restored account its access and can never keep one the owner took away
--
-- RESTORE WITHOUT TELEGRAM (owner request, round-3 staging test, 2026-10-23).
--
-- A link the owner Unlinked can be brought back from the dashboard with one
-- click, with no Telegram round trip: the Telegram account is the SAME one the
-- owner linked before, so the "Telegram half" was already proven when the link
-- was made, and the signed-in FULL session proves the account half again. A
-- brand-new Telegram account still needs the one-time lk_ link.
--
-- A RESTORE WRITES A NEW LIVE ROW; IT DOES NOT CLEAR THE REVOCATION. Three
-- reasons, in order of weight:
--
--   1. The file's own rule (20261021120000): "a revoked row is history: relinking
--      writes a NEW row, so 'when did this start' stays true". Clearing
--      revoked_at would erase the Unlink from the table that records it.
--   2. Sessions. Every web session an Unlink ended points at the OLD link id
--      (web_sessions.telegram_link_id). A new id means those sessions can never
--      come back through a revocation check: nothing refers to the new row yet,
--      so restoring cannot revive a session.
--   3. The sign-in notice is "first sign-in on a link": a new row has no
--      first_signed_in_at, so the restored account announces itself again, which
--      is what the owner asked for ("a restore counts as new").
--
-- The history is kept on both rows:
--
--   revoked_by        the user who unlinked (the Unlink writes it from now on;
--                     NULL on rows revoked before this release and on rows the
--                     membership-end trigger revoked).
--   restored_at       }  set on the REVOKED row when it is restored, so it can be
--   restored_by       }  restored once, the card stops offering it, and the table
--   restored_link_id  }  says who brought it back, when, and as which row.
--
-- The new row's verified_via is 'dashboard_restore'.
--
-- Nothing in this file touches telegram_organizer_links (the previous release's
-- account-wide table). An Unlink already moved the pair's row out of it into the
-- history table; a restore does NOT move it back, so after a rollback the older
-- readers still see none of the pair's trips (fail closed).

ALTER TABLE control_plane.telegram_organizer_trip_links
  ADD COLUMN IF NOT EXISTS revoked_by text,
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_by text,
  ADD COLUMN IF NOT EXISTS restored_link_id text;

ALTER TABLE control_plane.telegram_organizer_trip_links
  DROP CONSTRAINT IF EXISTS telegram_organizer_trip_links_verified_via_check;
ALTER TABLE control_plane.telegram_organizer_trip_links
  ADD CONSTRAINT telegram_organizer_trip_links_verified_via_check
  CHECK (verified_via IN ('enrollment_redemption', 'backfill_intake_session', 'dashboard_link_token', 'dashboard_restore'));

-- Only an owner Unlink can be restored, and a restore leaves all three facts together.
ALTER TABLE control_plane.telegram_organizer_trip_links
  DROP CONSTRAINT IF EXISTS telegram_organizer_trip_links_restored_shape_check;
ALTER TABLE control_plane.telegram_organizer_trip_links
  ADD CONSTRAINT telegram_organizer_trip_links_restored_shape_check
  CHECK (
    (restored_at IS NULL AND restored_by IS NULL AND restored_link_id IS NULL)
    OR (restored_at IS NOT NULL AND restored_by IS NOT NULL AND restored_link_id IS NOT NULL
        AND revoked_reason = 'owner_unlinked')
  );

-- The dashboard's read path for a card's unlinked accounts: one user's revoked
-- rows that can still be restored.
CREATE INDEX IF NOT EXISTS telegram_organizer_trip_links_restorable_idx
  ON control_plane.telegram_organizer_trip_links (user_id, trip_id)
  WHERE revoked_reason = 'owner_unlinked' AND restored_at IS NULL;
