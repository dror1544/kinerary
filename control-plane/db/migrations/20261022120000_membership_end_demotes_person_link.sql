-- rollback: compatible — replaces one trigger function that only this release's tables feed; the only extra effect is demoting a trip_person_links row from 'organizer' to 'participant' (less power, same row, same name), which the previous release reads as it reads any participant
--
-- A MEMBERSHIP THAT ENDS ALSO ENDS THE ORGANIZER POWERS THE BOT GAVE THAT TELEGRAM ACCOUNT.
--
-- Boundary review R1 (2026-10-21). `trip_person_links` (migration 0051) says
-- "this Telegram sender is the organizer of this trip"; provisioning writes it from
-- whichever Telegram account ran the interview - a forwardee, if the interview
-- link was forwarded - and `isTripOrganizer` trusts it. Unlinking that account
-- (telegram-mini-app.ts) ended its Mini App sign-in and its /trips, but not this
-- row, so it kept /proactive and the other organizer-only bot commands.
--
-- The Unlink path now demotes the row itself. This migration does the same for
-- the other way a link ends: the membership going away (member removal, admin
-- tooling, SQL). 20261021120000's trigger already revoked the trip's organizer
-- links and their sessions; it now also sets `role = 'participant'` on the person
-- link of every Telegram account whose link it just revoked, on that trip.
-- Demoted, not deleted: the person keeps the name the assistant calls them by.
--
-- The router also treats a revoked link for (Telegram account, trip) as overriding
-- an 'organizer' person link at read time (chat-router.ts `resolveTripPerson`),
-- because a re-provision upserts the role back to 'organizer'; this is the
-- database half so the stored fact is true too.
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
    -- that has no other live link to the trip (another user's link may still stand for it).
    UPDATE control_plane.trip_person_links p
       SET role = 'participant'
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
