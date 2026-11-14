-- rollback: compatible — adds two tables and widens two CHECK lists; the previous release never reads the tables, never writes the new values, and ignores the memberships/links the new code made (a secondary organizer is a runtime-only 'organizer' membership with no dashboard access, which the previous release already serves as it serves any member)
--
-- #523 — A MAIN TELEGRAM PER ACCOUNT, AND SECONDARY ORGANIZERS ADDED WITH A TRIP LINK.
-- (docs/specs/sprint-8/523-main-telegram-and-secondary-organizers.md; builds on #519.)
--
-- 1. THE MAIN TELEGRAM. The dashboard's "Link Telegram" (`lk_`, telegram-link-token.ts) now makes the opener the account's MAIN
--    Telegram: its links are written with binding_scope = 'account' on every trip the account runs, and linking another
--    replaces it. The replaced Telegram's account-scoped links are revoked through the Unlink function with a reason of their
--    own, so the dashboard's "Restore" (which lists only `owner_unlinked`) never offers a replaced main back.
--
--    Existing rows are NOT rewritten. #519's migration (20261106130000) narrowed `dashboard_link_token` links to their own
--    trip; they stay trip-scoped. Promoting them would declare every Telegram an organizer ever added to one trip a "main" one
--    and break "one main Telegram per account". What changes for existing `lk_` links is the ones still UNREDEEMED: redeemed
--    after this release they make a main Telegram. The owner turns an old trip-scoped Telegram into the main one by opening
--    "Link Telegram" from it.
--
-- 2. SECONDARY ORGANIZERS. The trip's main organizer (its owner) issues a trip link; whoever opens it in Telegram becomes a
--    secondary organizer of THAT trip only. Three tables carry it, and none of them is a Kinerary account the person signs up
--    for:
--      trip_secondary_organizer_tokens  the single-use, short-lived link (only a sha256 digest is stored, as for `lk_`);
--      trip_secondary_organizers        the binding itself: a Telegram digest, a role on one trip, who added it, when it ended;
--      (existing) users / trip_memberships / telegram_member_links  the same shape a site-invite member already has, so the
--        Mini App sign-in, the portal's scope rules and the runtime gateway need no new path: a hidden `users` row with no
--        email and no credential, an 'organizer' membership with dashboard_access = false and runtime_access = true, and a
--        member link for the Telegram account. dashboard_access = false is what keeps S out of every dashboard route.
--
-- Every reader of "who organizes this trip" joins the ACTIVE membership as well as this table, so a membership that ends by
-- any route (the dashboard's member removal included) ends the secondary organizer with it.

-- ── 1. A replaced main Telegram's links end with their own reason ──────────────────────────────────────────────────────
ALTER TABLE control_plane.telegram_organizer_trip_links
  DROP CONSTRAINT IF EXISTS telegram_organizer_trip_links_revoked_reason_check;
ALTER TABLE control_plane.telegram_organizer_trip_links
  ADD CONSTRAINT telegram_organizer_trip_links_revoked_reason_check
  CHECK (revoked_reason IS NULL OR revoked_reason IN ('owner_unlinked', 'membership_ended', 'main_telegram_replaced'));

-- A secondary organizer's Telegram link is a member link written by the trip link, not by a trip password or a site invite.
ALTER TABLE control_plane.telegram_member_links
  DROP CONSTRAINT IF EXISTS telegram_member_links_verified_via_check;
ALTER TABLE control_plane.telegram_member_links
  ADD CONSTRAINT telegram_member_links_verified_via_check
  CHECK (verified_via IN ('mini_app_trip_password', 'mini_app_invite_redemption', 'secondary_organizer_link'));

-- ── 2. The trip link ───────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS control_plane.trip_secondary_organizer_tokens (
  id               text        NOT NULL,
  trip_id          text        NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  -- The trip's main organizer who issued it. Re-checked at redemption: a link whose issuer no longer owns the trip is spent.
  issued_by        text        NOT NULL REFERENCES control_plane.users(id) ON DELETE CASCADE,
  token_digest     text        NOT NULL,
  state            text        NOT NULL DEFAULT 'issued',
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  consumed_at      timestamptz,
  consumed_secondary_id text,

  CONSTRAINT trip_secondary_organizer_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT trip_secondary_organizer_tokens_id_is_opaque CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT trip_secondary_organizer_tokens_digest_shape CHECK (token_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT trip_secondary_organizer_tokens_state_check CHECK (state IN ('issued', 'consumed', 'revoked')),
  CONSTRAINT trip_secondary_organizer_tokens_consumed_shape CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_secondary_organizer_tokens_digest_idx
  ON control_plane.trip_secondary_organizer_tokens (token_digest);
-- One live trip link per (trip, issuer): asking again replaces the previous, as `lk_` does.
CREATE UNIQUE INDEX IF NOT EXISTS trip_secondary_organizer_tokens_live_idx
  ON control_plane.trip_secondary_organizer_tokens (trip_id, issued_by) WHERE state = 'issued';

-- ── 3. The binding ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS control_plane.trip_secondary_organizers (
  id                       text        NOT NULL,
  trip_id                  text        NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  -- The hidden `users` row made for this binding (no email, no credential), and the member link that lets the Telegram
  -- account open the trip's organizer view.
  user_id                  text        NOT NULL REFERENCES control_plane.users(id) ON DELETE CASCADE,
  member_link_id           text,
  -- 'sha256:<hex>' of the Telegram numeric id, built exactly like identity.ts's digestTelegramId.
  telegram_subject_digest  text        NOT NULL,
  -- Display data only, from the verified update. Never decides anything.
  telegram_first_name      text,
  telegram_username        text,
  added_by                 text        NOT NULL REFERENCES control_plane.users(id) ON DELETE CASCADE,
  created_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  revoked_reason           text,
  revoked_by               text,

  CONSTRAINT trip_secondary_organizers_pkey PRIMARY KEY (id),
  CONSTRAINT trip_secondary_organizers_id_is_opaque CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT trip_secondary_organizers_digest_shape CHECK (telegram_subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT trip_secondary_organizers_revoked_reason_check
    CHECK (revoked_reason IS NULL OR revoked_reason IN ('removed_by_organizer', 'membership_ended', 'became_main_organizer')),
  CONSTRAINT trip_secondary_organizers_revoked_shape CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- At most one LIVE secondary binding per (trip, Telegram account). A revoked row is history; opening a new link writes a new row.
CREATE UNIQUE INDEX IF NOT EXISTS trip_secondary_organizers_live_idx
  ON control_plane.trip_secondary_organizers (trip_id, telegram_subject_digest) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS trip_secondary_organizers_digest_idx
  ON control_plane.trip_secondary_organizers (telegram_subject_digest) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trip_secondary_organizers_user_idx
  ON control_plane.trip_secondary_organizers (user_id);
