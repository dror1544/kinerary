-- rollback: compatible — adds tables and a trigger that only this release reads or writes; the previous release's account-wide telegram_organizer_links rows are left exactly as they were, and a per-trip Unlink moves the pair's account-wide row into the history table, so older bot readers can only lose sight of an unlinked account, never keep it
--
-- TELEGRAM LINKS ARE PER TRIP (#442, owner decision 2026-10-20).
--
-- 20261020120000 made a `telegram_organizer_links` row a sign-in path and gave
-- the owner an Unlink for it. Acceptance exposed the shape of the mistake: the
-- row names a USER, not a trip, so Unlinking it took EVERY trip the organizer
-- has out of the bot's /trips and /switch at once, and a revoked pair stays
-- revoked by design — so there was no way back from the dashboard.
--
-- The link is now one row per (Telegram account, user, TRIP):
--
--   telegram_organizer_trip_links   the new source of truth for every reader
--                                   of an organizer's Telegram link — the bot's
--                                   /trips and /switch, "is this sender the
--                                   organizer", the returning-organizer opening
--                                   and the Mini App sign-in. Revocable in
--                                   place (`revoked_at`), because no older
--                                   release reads this table.
--   telegram_link_tokens            the one-time, short-lived deep links the
--                                   signed-in organizer's dashboard hands out
--                                   to (re)link a Telegram account to ONE trip.
--                                   It is the only way back after an Unlink.
--
-- WHAT HAPPENS TO THE ACCOUNT-WIDE ROWS. They keep working, and they are not
-- touched. Section 3 turns each one into per-trip rows — one for every trip the
-- user holds an active membership of — so an organizer who linked once keeps
-- every trip until they change one. The old row itself stays in
-- `telegram_organizer_links`, so the previous release (after a rollback) runs
-- unchanged. This release stops WRITING that table and stops READING it; the
-- only thing it does to it is on a per-trip Unlink, below.
--
-- ROLLBACK SAFETY OF A PER-TRIP UNLINK. The previous release reads only the
-- account-wide table, joined to all of a user's memberships: it has no way to
-- hide ONE trip. So when an organizer unlinks any one trip, the pair's
-- account-wide row is MOVED into `telegram_organizer_link_revocations` (the
-- history table 20261020120000 made for exactly this) by
-- telegram-mini-app.ts, in the same transaction. After a rollback the old
-- readers then see none of that pair's trips: an Unlink can cost an organizer
-- bot access until they relink, and can never leave behind access they took
-- away. The same property, one level up: a row that is not in the table cannot
-- be honoured by code that has never heard of the revocation.
--
-- ── 1. The per-trip organizer link ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS control_plane.telegram_organizer_trip_links (
  id                       text        NOT NULL,
  user_id                  text        NOT NULL REFERENCES control_plane.users(id),
  trip_id                  text        NOT NULL REFERENCES control_plane.trips(id),
  -- 'sha256:<hex>' of the Telegram numeric id, built exactly like identity.ts's
  -- digestTelegramId. The raw id is not stored.
  telegram_subject_digest  text        NOT NULL,
  -- enrollment_redemption   an interview link redeemed from this Telegram account
  -- backfill_intake_session carried over from 0052's backfill
  -- dashboard_link_token    the organizer's own dashboard handed out a link for
  --                         this trip and this Telegram account redeemed it
  verified_via             text        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  first_signed_in_at       timestamptz,
  last_signed_in_at        timestamptz,
  revoked_at               timestamptz,
  revoked_reason           text,

  CONSTRAINT telegram_organizer_trip_links_pkey PRIMARY KEY (id),
  CONSTRAINT telegram_organizer_trip_links_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT telegram_organizer_trip_links_digest_shape
    CHECK (telegram_subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT telegram_organizer_trip_links_verified_via_check
    CHECK (verified_via IN ('enrollment_redemption', 'backfill_intake_session', 'dashboard_link_token')),
  CONSTRAINT telegram_organizer_trip_links_revoked_reason_check
    CHECK (revoked_reason IS NULL OR revoked_reason IN ('owner_unlinked', 'membership_ended')),
  CONSTRAINT telegram_organizer_trip_links_revoked_shape_check
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- At most one LIVE link per (Telegram account, user, trip). A revoked row is
-- history: relinking writes a NEW row, so "when did this start" stays true.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_organizer_trip_links_live_idx
  ON control_plane.telegram_organizer_trip_links (telegram_subject_digest, user_id, trip_id)
  WHERE revoked_at IS NULL;
-- The bot's read path: every live link of one Telegram account.
CREATE INDEX IF NOT EXISTS telegram_organizer_trip_links_digest_idx
  ON control_plane.telegram_organizer_trip_links (telegram_subject_digest) WHERE revoked_at IS NULL;
-- The dashboard's read path: the live links of one trip's owner.
CREATE INDEX IF NOT EXISTS telegram_organizer_trip_links_trip_idx
  ON control_plane.telegram_organizer_trip_links (trip_id, user_id) WHERE revoked_at IS NULL;
-- "Was this exact pair ever unlinked?" — the interview-link redemption refuses
-- to quietly re-open one.
CREATE INDEX IF NOT EXISTS telegram_organizer_trip_links_revoked_idx
  ON control_plane.telegram_organizer_trip_links (telegram_subject_digest, user_id, trip_id)
  WHERE revoked_at IS NOT NULL;

-- ── 2. The one-time link tokens ────────────────────────────────────────────
--
-- Same pattern as interview_enrollments (0009): the raw token exists only in
-- the URL handed to the signed-in organizer; the table holds its sha256. One
-- live token per (user, trip) — issuing again revokes the previous one.
-- Redeemed by the bot, from a verified Telegram update (chat-router.ts), which
-- is what proves the Telegram half; the dashboard session that issued it
-- proved the account half.
CREATE TABLE IF NOT EXISTS control_plane.telegram_link_tokens (
  id               text        NOT NULL,
  user_id          text        NOT NULL REFERENCES control_plane.users(id),
  trip_id          text        NOT NULL REFERENCES control_plane.trips(id),
  token_digest     text        NOT NULL,
  state            text        NOT NULL DEFAULT 'issued',
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  consumed_at      timestamptz,
  -- The link the redemption wrote (or found already live), for the record.
  consumed_link_id text,

  CONSTRAINT telegram_link_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT telegram_link_tokens_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT telegram_link_tokens_digest_shape
    CHECK (token_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT telegram_link_tokens_state_check
    CHECK (state IN ('issued', 'consumed', 'revoked')),
  CONSTRAINT telegram_link_tokens_consumed_shape_check
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_link_tokens_digest_idx
  ON control_plane.telegram_link_tokens (token_digest);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_link_tokens_live_idx
  ON control_plane.telegram_link_tokens (user_id, trip_id) WHERE state = 'issued';

-- ── 3. Account-wide links become per-trip links ────────────────────────────
--
-- One row per (account-wide link × active membership of that user). Everything
-- the old row granted — /trips, /switch, the Mini App — it granted for every
-- trip the user was an active member of, so that is the set carried over; the
-- readers keep their own joins to membership, retirement and destruction.
-- Sign-in bookkeeping is copied so a link that has already announced itself
-- does not announce itself again. The id is derived from the pair, so running
-- this file twice cannot mint a second row; `gen_random_uuid` is avoided for the
-- same reason `20260922060001` avoids pgcrypto.
--
-- Pairs already moved to `telegram_organizer_link_revocations` (an owner's
-- Unlink on the one environment that ran 20261020120000) have no account-wide
-- row, so they get no per-trip rows: they stay unlinked, and the dashboard's
-- Link is the way back.
INSERT INTO control_plane.telegram_organizer_trip_links
  (id, user_id, trip_id, telegram_subject_digest, verified_via, created_at, first_signed_in_at, last_signed_in_at)
SELECT 'otl_' || md5(l.id || ':' || m.trip_id),
       l.user_id, m.trip_id, l.telegram_subject_digest, l.verified_via,
       l.created_at, l.first_signed_in_at, l.last_signed_in_at
  FROM control_plane.telegram_organizer_links l
  JOIN control_plane.trip_memberships m ON m.user_id = l.user_id AND m.status = 'active'
ON CONFLICT DO NOTHING;

-- Sessions an account-wide link already minted keep pointing at the old link
-- id; ending a per-trip link must end them too (telegram-mini-app.ts reads
-- this table for the pair's legacy id). Nothing to alter: the column is text.

-- ── 4. A membership that ends takes the Telegram link with it ──────────────
--
-- The readers all join active membership, so an ended membership already
-- hides the link. This makes the end PERMANENT: without it, adding the same
-- person back to the trip later (as a plain member, say) would silently
-- revive a link that was made when they ran it. Done in the database because
-- membership status has more than one writer (the portal, admin tooling, SQL).
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
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS membership_ended_revokes_organizer_telegram ON control_plane.trip_memberships;
CREATE TRIGGER membership_ended_revokes_organizer_telegram
  AFTER UPDATE OF status ON control_plane.trip_memberships
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION control_plane.trg_membership_ended_revokes_organizer_telegram();
