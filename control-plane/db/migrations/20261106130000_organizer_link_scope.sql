-- rollback: compatible — adds one defaulted column that only this release reads; the previous release ignores it and treats every link as it always did, so a rollback loses the per-trip scoping and nothing else
--
-- AN ORGANIZER LINK SAYS HOW FAR IT REACHES (#519, owner decision 2026-11-06).
--
-- "One organizer, one Telegram" asks, when an interview link is opened, whether the opener is the Telegram account the
-- organizer's ACCOUNT is bound to. Not every link may speak for the whole account:
--
--   account  the ordinary case: this Telegram redeemed one of the account's own interview links, or was carried over from
--            before (backfill). It stands for the account on every trip.
--   trip     it stands for ONE trip only. Two kinds:
--              - an approved replacement: the bound organizer said "this Telegram may run THIS trip";
--              - the dashboard's signed-in one-time link (`dashboard_link_token`): the owner added a Telegram to one
--                trip (lost-phone recovery). A leaked one must not open the account's other trips.
--
-- The default is 'account', so every row that exists keeps the reach it had; the one backfill below narrows the
-- dashboard-link rows to their own trip, which is what they were issued for. A dashboard Restore copies the scope of
-- the row it restores (telegram-link-token.ts), so Unlink + Restore changes nothing about how far a link reaches.

ALTER TABLE control_plane.telegram_organizer_trip_links
  ADD COLUMN IF NOT EXISTS binding_scope text NOT NULL DEFAULT 'account';

ALTER TABLE control_plane.telegram_organizer_trip_links
  DROP CONSTRAINT IF EXISTS telegram_organizer_trip_links_binding_scope_check;
ALTER TABLE control_plane.telegram_organizer_trip_links
  ADD CONSTRAINT telegram_organizer_trip_links_binding_scope_check
  CHECK (binding_scope IN ('account', 'trip'));

UPDATE control_plane.telegram_organizer_trip_links
   SET binding_scope = 'trip'
 WHERE verified_via = 'dashboard_link_token' AND binding_scope <> 'trip';

-- A dashboard Restore writes a NEW row (verified_via 'dashboard_restore') and marks the one it brings back with
-- `restored_link_id`. A restore of a one-time link's row is that one-time link again, so it reaches one trip too -- and so is
-- a restore of such a restore (Unlink, Restore, Unlink, Restore), hence the walk down the chain. A restore of an ordinary
-- redemption keeps the default.
WITH RECURSIVE chain(target, source_id, source_via) AS (
  SELECT r.id, o.id, o.verified_via
    FROM control_plane.telegram_organizer_trip_links r
    JOIN control_plane.telegram_organizer_trip_links o ON o.restored_link_id = r.id
   WHERE r.verified_via = 'dashboard_restore'
  UNION
  SELECT c.target, o.id, o.verified_via
    FROM chain c
    JOIN control_plane.telegram_organizer_trip_links o ON o.restored_link_id = c.source_id
)
UPDATE control_plane.telegram_organizer_trip_links l
   SET binding_scope = 'trip'
  FROM (SELECT DISTINCT target FROM chain WHERE source_via = 'dashboard_link_token') origin
 WHERE l.id = origin.target AND l.binding_scope <> 'trip';
