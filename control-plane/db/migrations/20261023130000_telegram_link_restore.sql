-- rollback: compatible — adds nullable columns that only this release writes or reads, and widens one CHECK list by one value ('dashboard_restore') that only this release inserts; a rollback to a release that reads telegram_organizer_trip_links (the Sprint 7 candidate d0e3b73 does) keeps a restored account's access exactly as the owner left it, and one to a release from before that table (pre-Sprint 7) cannot see per-trip rows at all and so loses it, which fails closed
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
-- Nothing in this file touches telegram_organizer_links (the pre-Sprint-7
-- account-wide table). An Unlink already moved the pair's row out of it into the
-- history table; a restore does NOT move it back. So: a rollback to a release that
-- reads telegram_organizer_trip_links (the Sprint 7 candidate d0e3b73 does) sees the
-- restored row and keeps the account's access, as the owner left it; a rollback to a
-- release from before this table existed reads only the account-wide one, sees none
-- of the pair's trips, and the restored account loses access until it is linked again
-- (fail closed: it can cost access, never keep what the owner took away).
--
-- THE LINK'S DISPLAY LABEL (owner decision 2026-10-23, "name + confirm"). A restore is
-- one click on an account the owner may not recognise, so each link row carries a
-- short name of the Telegram account - first name and @username, in TWO columns so a
-- first name that says "@someone" can never pass for the handle - for the dashboard to
-- show next to it. Both are DISPLAY DATA ONLY. They are written only from
-- what Telegram delivered on a verified path (the update's `from`, or the user inside
-- signature-checked initData), never from a request body; it is bounded and stripped
-- of control characters before it gets here; and nothing ever decides anything from
-- it: the digest is the identity. Rows that exist already have none and show as
-- "Telegram account". The column is NULL-able and unchecked beyond its length.

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

ALTER TABLE control_plane.telegram_organizer_trip_links
  ADD COLUMN IF NOT EXISTS telegram_first_name text,
  ADD COLUMN IF NOT EXISTS telegram_username text;
ALTER TABLE control_plane.telegram_organizer_trip_links
  DROP CONSTRAINT IF EXISTS telegram_organizer_trip_links_name_shape_check;
ALTER TABLE control_plane.telegram_organizer_trip_links
  ADD CONSTRAINT telegram_organizer_trip_links_name_shape_check
  CHECK ((telegram_first_name IS NULL OR (char_length(telegram_first_name) BETWEEN 1 AND 40 AND position('@' in telegram_first_name) = 0))
         AND (telegram_username IS NULL OR telegram_username ~ '^[A-Za-z0-9_]{1,32}$'));

ALTER TABLE control_plane.telegram_member_links
  ADD COLUMN IF NOT EXISTS telegram_first_name text,
  ADD COLUMN IF NOT EXISTS telegram_username text;
ALTER TABLE control_plane.telegram_member_links
  DROP CONSTRAINT IF EXISTS telegram_member_links_name_shape_check;
ALTER TABLE control_plane.telegram_member_links
  ADD CONSTRAINT telegram_member_links_name_shape_check
  CHECK ((telegram_first_name IS NULL OR (char_length(telegram_first_name) BETWEEN 1 AND 40 AND position('@' in telegram_first_name) = 0))
         AND (telegram_username IS NULL OR telegram_username ~ '^[A-Za-z0-9_]{1,32}$'));
