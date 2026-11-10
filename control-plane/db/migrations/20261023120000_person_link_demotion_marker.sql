-- rollback: compatible — adds one nullable column that only this release writes or reads, and replaces one trigger function whose only extra effect is to set that column; the previous release ignores the column and keeps reading trip_person_links.role as before
--
-- A RELINK RESTORES EXACTLY WHAT AN UNLINK TOOK, AND NOTHING ELSE.
--
-- Boundary review round 3 (2026-10-22), MF2. 20261022120000 demoted a
-- `trip_person_links` organizer row to 'participant' when the Telegram account's
-- link was revoked, and the dashboard relink promoted back "any participant whose
-- Telegram account has a revoked organizer link on the trip". That inference is
-- wrong for a person who was a participant all along and happens to have an old,
-- unrelated Unlinked link: redeeming a co-organizer's link would have made them an
-- organizer. The demotion therefore RECORDS itself.
--
-- `demoted_from_role` is NULL for every row that was never demoted. The Unlink
-- (telegram-mini-app.ts) and the membership-end trigger below set it to
-- 'organizer' in the same statement that sets the role to 'participant'; the
-- relink (telegram-link-token.ts) promotes only a row carrying it, and clears it.
-- A provisioner upsert that sets the role back to 'organizer' leaves a stale
-- marker on a row whose role is already organizer, which the restore ignores
-- (it also requires role = 'participant').
--
-- Rows demoted by 20261022120000 before this column existed carry no marker, so a
-- relink does not restore them (the environments that ran it are the Mac staging
-- database only). Guessing a marker for them from the revoked link is the
-- inference this migration exists to remove.
ALTER TABLE control_plane.trip_person_links
  ADD COLUMN IF NOT EXISTS demoted_from_role text;
ALTER TABLE control_plane.trip_person_links
  DROP CONSTRAINT IF EXISTS trip_person_links_demoted_from_role_check;
ALTER TABLE control_plane.trip_person_links
  ADD CONSTRAINT trip_person_links_demoted_from_role_check
  CHECK (demoted_from_role IS NULL OR demoted_from_role = 'organizer');

CREATE OR REPLACE FUNCTION control_plane.trg_membership_ended_revokes_organizer_telegram() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  link_ids text[];
BEGIN
  UPDATE control_plane.telegram_organizer_trip_links
     SET revoked_at = now(), revoked_reason = 'membership_ended'
   WHERE trip_id = NEW.trip_id AND user_id = NEW.user_id AND revoked_at IS NULL;
  SELECT coalesce(array_agg(id), ARRAY[]::text[]) INTO link_ids
    FROM control_plane.telegram_organizer_trip_links
   WHERE trip_id = NEW.trip_id AND user_id = NEW.user_id AND revoked_reason = 'membership_ended';
  IF cardinality(link_ids) > 0 THEN
    UPDATE control_plane.web_sessions
       SET revoked_at = now()
     WHERE telegram_link_id = ANY(link_ids) AND revoked_at IS NULL;
    -- The same Telegram accounts' organizer fact in the bot, on this trip only, and only for an account
    -- that has no other live link to the trip (another user's link may still stand for it). The demotion
    -- is RECORDED so a later relink can restore exactly this and nothing else.
    UPDATE control_plane.trip_person_links p
       SET role = 'participant', demoted_from_role = 'organizer'
     WHERE p.trip_id = NEW.trip_id AND p.role = 'organizer' AND p.telegram_user_id ~ '^[0-9]{1,20}$'
       AND EXISTS (
             SELECT 1 FROM control_plane.telegram_organizer_trip_links r
              WHERE r.id = ANY(link_ids)
                AND r.telegram_subject_digest = 'sha256:' || encode(sha256(convert_to(p.telegram_user_id, 'UTF8')), 'hex'))
       AND NOT EXISTS (
             SELECT 1 FROM control_plane.telegram_organizer_trip_links l
              WHERE l.trip_id = NEW.trip_id AND l.revoked_at IS NULL
                AND l.telegram_subject_digest = 'sha256:' || encode(sha256(convert_to(p.telegram_user_id, 'UTF8')), 'hex'));
  END IF;
  RETURN NEW;
END;
$$;
