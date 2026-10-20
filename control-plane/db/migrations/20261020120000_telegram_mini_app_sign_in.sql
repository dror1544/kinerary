-- rollback: compatible — adds nullable columns, two new tables that no existing code reads, and triggers that write only those; the previous code runs unchanged (it never signs anyone in with Telegram, and still honours a revoked link for bot routing)
--
-- TELEGRAM LINKS BECOME A SIGN-IN PATH (#442) — AND SO THEY MUST BE REVOCABLE.
--
-- CONTRACT CHANGE of control_plane.telegram_organizer_links. Migration 0052
-- wrote down its own limit: "It is a read model for routing decisions, never a
-- credential, and never an authentication path". With the Mini App sign-in that
-- sentence is no longer true. A row now means "the holder of this Telegram
-- account may sign in to this control-plane user from the Mini App, with no
-- password". The table keeps its name and its columns; what changes is what a
-- row is worth, and therefore three things around it:
--
--   * it is REVOCABLE        (`revoked_at`, `revoked_reason`) — a row that
--                            signs people in cannot be append-only forever;
--   * it is OWNER-VISIBLE    — the signed-in user sees every Telegram account
--                            that can sign in as them and can unlink it
--                            (GET/DELETE /v1/account/telegram-links);
--   * it is ANNOUNCED        (`first_signed_in_at`) — the first Mini App
--                            sign-in through a link sends the Telegram account
--                            a notice, once.
--
-- Why this matters in practice: an organizer's link is written when an
-- interview link is redeemed from a Telegram chat. An interview link that was
-- forwarded to someone else is therefore a link to a Telegram account that is
-- not the organizer's, and before this change that cost nothing beyond bot
-- routing. From now on it costs a sign-in. The list and the Unlink button are
-- how the organizer finds out and closes it, and `web_sessions.telegram_link_id`
-- is how an Unlink also ends the sessions that link already minted instead of
-- leaving them alive for their seven days.
--
-- A revoked organizer link STAYS revoked: `linkTelegramOrganizerInTx` keeps its
-- ON CONFLICT DO NOTHING, so redeeming another interview link does not quietly
-- re-open a door the organizer shut. Every reader of the table skips a revoked
-- row — the Mini App resolver and the bot's own (/trips, /switch, "returning
-- organizer", isTripOrganizer) — so Unlink ends bot access too.
--
-- ── 1. Revocation and first-use bookkeeping on the existing table ──────────

ALTER TABLE control_plane.telegram_organizer_links
  ADD COLUMN IF NOT EXISTS revoked_at         timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_reason     text,
  ADD COLUMN IF NOT EXISTS first_signed_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_signed_in_at  timestamptz;

ALTER TABLE control_plane.telegram_organizer_links
  DROP CONSTRAINT IF EXISTS telegram_organizer_links_revoked_reason_check;
ALTER TABLE control_plane.telegram_organizer_links
  ADD CONSTRAINT telegram_organizer_links_revoked_reason_check
    CHECK (revoked_reason IS NULL OR revoked_reason IN ('owner_unlinked'));
ALTER TABLE control_plane.telegram_organizer_links
  DROP CONSTRAINT IF EXISTS telegram_organizer_links_revoked_shape_check;
ALTER TABLE control_plane.telegram_organizer_links
  ADD CONSTRAINT telegram_organizer_links_revoked_shape_check
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL));

-- ── 2. Phase 2: members who were never in telegram_organizer_links ─────────
--
-- A person who joined by site invite has no organizer link, and 0051's rule
-- stands: a private chat is not "organizer". So a member's link lives in its
-- own table, is scoped to ONE trip (the trip whose password or invite proved
-- it), and is read only by the Mini App resolver.
--
-- Written only when ONE request carries verified Telegram initData AND a
-- successful trip-password or invite redemption AND an explicit consent flag —
-- never from an existing cookie session (portal.ts, linkMemberInTx).
--
-- Trip scope is what makes the three revocation events below well-defined: the
-- link is proof of ability to enter THAT trip, so ending the trip's password,
-- the person's membership of it, or the invite it came from ends the link.
CREATE TABLE IF NOT EXISTS control_plane.telegram_member_links (
  id                       text        NOT NULL,
  user_id                  text        NOT NULL REFERENCES control_plane.users(id),
  trip_id                  text        NOT NULL REFERENCES control_plane.trips(id),
  -- 'sha256:<hex>' of the Telegram numeric id, built exactly like identity.ts's
  -- digestTelegramId. The raw id is not stored.
  telegram_subject_digest  text        NOT NULL,
  verified_via             text        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  revoked_reason           text,
  first_signed_in_at       timestamptz,
  last_signed_in_at        timestamptz,

  CONSTRAINT telegram_member_links_pkey PRIMARY KEY (id),
  CONSTRAINT telegram_member_links_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT telegram_member_links_digest_shape
    CHECK (telegram_subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT telegram_member_links_verified_via_check
    CHECK (verified_via IN ('mini_app_trip_password', 'mini_app_invite_redemption')),
  CONSTRAINT telegram_member_links_revoked_reason_check
    CHECK (revoked_reason IS NULL OR revoked_reason IN
      ('owner_unlinked', 'trip_password_changed', 'membership_ended', 'invite_revoked')),
  CONSTRAINT telegram_member_links_revoked_shape_check
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- At most one LIVE link per (account, user, trip). A revoked row is history:
-- proving the password again writes a new row rather than reviving the old one.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_member_links_live_idx
  ON control_plane.telegram_member_links (telegram_subject_digest, user_id, trip_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS telegram_member_links_user_idx
  ON control_plane.telegram_member_links (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS telegram_member_links_trip_user_idx
  ON control_plane.telegram_member_links (trip_id, user_id) WHERE revoked_at IS NULL;

-- ── 3. Which sessions a link minted, so Unlink can end them ────────────────
--
-- Not a foreign key: the id names a row in one of two tables. NULL for every
-- session that did not come from a Telegram link (all of them, until now).
ALTER TABLE control_plane.web_sessions
  ADD COLUMN IF NOT EXISTS telegram_link_id text;
CREATE INDEX IF NOT EXISTS web_sessions_telegram_link_idx
  ON control_plane.web_sessions (telegram_link_id)
  WHERE telegram_link_id IS NOT NULL AND revoked_at IS NULL;

-- ── 4. Replay accounting for Mini App launches ─────────────────────────────
--
-- Telegram's initData is signed, not single-use: the same string is valid for
-- its whole freshness window, and a WebView that reloads sends it again. The
-- policy is "at most 3 sessions per launch inside that window", counted on the
-- digest of the COMPUTED HMAC (so re-encoding the same fields cannot open a
-- second bucket) in Postgres (so a second API process shares the count). The
-- upsert in telegram-mini-app.ts is one statement, hence atomic.
--
-- `link_consumed_at` is the one-shot for phase-2 linking: one launch can write
-- at most one member link.
CREATE TABLE IF NOT EXISTS control_plane.telegram_mini_app_launches (
  replay_digest     text        NOT NULL,
  sessions_minted   integer     NOT NULL DEFAULT 0 CHECK (sessions_minted >= 0),
  link_consumed_at  timestamptz,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_mini_app_launches_pkey PRIMARY KEY (replay_digest),
  CONSTRAINT telegram_mini_app_launches_digest_shape
    CHECK (replay_digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS telegram_mini_app_launches_expiry_idx
  ON control_plane.telegram_mini_app_launches (expires_at);

-- The "you signed in with Telegram" notice is an outbox row of its own type
-- with no trip (it is about an account, not a trip). outbox-dispatcher.ts sends
-- it with every other row, by that type, and nulls the raw Telegram id in
-- `recipient` once the row is sent or has failed for good.
CREATE INDEX IF NOT EXISTS notification_outbox_mini_app_notice_idx
  ON control_plane.notification_outbox (created_at)
  WHERE state = 'pending' AND notification_type = 'mini_app_sign_in_notice';

-- ── 5. The three events that end a member link ─────────────────────────────
--
-- Done in the database, not in each route, because none of the three has a
-- single writer: membership status is changed by the portal, by admin tooling
-- and by SQL; the trip password is replaced by every redemption; an invite is
-- revoked by the portal. A revocation that depends on the writer remembering
-- is the shape of bug this repository keeps paying for, so the trigger is the
-- rule and the routes need not know it exists.
CREATE OR REPLACE FUNCTION control_plane.revoke_member_telegram_links(
  p_trip_id text, p_user_id text, p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  link_ids text[];
BEGIN
  UPDATE control_plane.telegram_member_links
     SET revoked_at = now(), revoked_reason = p_reason
   WHERE trip_id = p_trip_id AND user_id = p_user_id AND revoked_at IS NULL;
  -- Collect after the update so a link revoked a moment ago by someone else is
  -- still covered: its sessions must not outlive it.
  SELECT coalesce(array_agg(id), ARRAY[]::text[]) INTO link_ids
    FROM control_plane.telegram_member_links
   WHERE trip_id = p_trip_id AND user_id = p_user_id AND revoked_reason = p_reason;
  IF cardinality(link_ids) > 0 THEN
    UPDATE control_plane.web_sessions
       SET revoked_at = now()
     WHERE telegram_link_id = ANY(link_ids) AND revoked_at IS NULL;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.trg_membership_ended_revokes_telegram() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM control_plane.revoke_member_telegram_links(NEW.trip_id, NEW.user_id, 'membership_ended');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS membership_ended_revokes_telegram ON control_plane.trip_memberships;
CREATE TRIGGER membership_ended_revokes_telegram
  AFTER UPDATE OF status ON control_plane.trip_memberships
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION control_plane.trg_membership_ended_revokes_telegram();

CREATE OR REPLACE FUNCTION control_plane.trg_trip_password_changed_revokes_telegram() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM control_plane.revoke_member_telegram_links(OLD.trip_id, OLD.user_id, 'trip_password_changed');
    RETURN OLD;
  END IF;
  PERFORM control_plane.revoke_member_telegram_links(NEW.trip_id, NEW.user_id, 'trip_password_changed');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trip_password_changed_revokes_telegram ON control_plane.web_password_credentials;
CREATE TRIGGER trip_password_changed_revokes_telegram
  AFTER UPDATE OF password_hash ON control_plane.web_password_credentials
  FOR EACH ROW
  WHEN (OLD.password_hash IS DISTINCT FROM NEW.password_hash)
  EXECUTE FUNCTION control_plane.trg_trip_password_changed_revokes_telegram();
DROP TRIGGER IF EXISTS trip_password_deleted_revokes_telegram ON control_plane.web_password_credentials;
CREATE TRIGGER trip_password_deleted_revokes_telegram
  AFTER DELETE ON control_plane.web_password_credentials
  FOR EACH ROW
  EXECUTE FUNCTION control_plane.trg_trip_password_changed_revokes_telegram();

CREATE OR REPLACE FUNCTION control_plane.trg_invite_revoked_revokes_telegram() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.redeemed_by IS NOT NULL THEN
    PERFORM control_plane.revoke_member_telegram_links(NEW.trip_id, NEW.redeemed_by, 'invite_revoked');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS invite_revoked_revokes_telegram ON control_plane.site_invites;
CREATE TRIGGER invite_revoked_revokes_telegram
  AFTER UPDATE OF state ON control_plane.site_invites
  FOR EACH ROW
  WHEN (OLD.state <> 'revoked' AND NEW.state = 'revoked')
  EXECUTE FUNCTION control_plane.trg_invite_revoked_revokes_telegram();
