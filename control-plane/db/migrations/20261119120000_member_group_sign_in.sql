-- rollback: compatible — one new table, one trigger that writes only that table, and two widened CHECKs on telegram_member_links; the previous release reads none of them, and a claim opens nothing in it (its launch exchange reads site_invites alone)
--
-- TRIP MEMBERS SIGN IN FROM THEIR TRIP'S TELEGRAM GROUP (docs/specs/sprint-9/x-member-sign-in.md, slice S1).
--
-- A person who is live in a trip's one open group may open the Mini App, pick their own name from the travellers
-- nobody has claimed, and sign in as that traveller, a `member` and nothing more. This migration is the data the
-- claim needs; the switch `member_group_sign_in` (shared/feature-switches.js) decides whether any trip uses it.
--
-- WHAT A ROW OF trip_participant_claims IS WORTH. A live row (released_at IS NULL) says: "on this trip, the trip-site
-- participant `runtime_username` is the control-plane account `user_id`". It is the SECOND way, beside a redeemed
-- site invite, that the runtime launch exchange (portal.ts, /internal/runtime-launch/consume) learns which trip-site
-- participant a portal session opens the trip as. So a row is a credential in the sense that matters here: whoever
-- holds the session of `user_id` opens that trip as that traveller. It is therefore
--
--   * ENDED, NEVER DELETED  — `released_at` + `released_reason`: an organizer's release, the person leaving the group,
--                             the person's own Unlink, or the membership ending (the trigger below). A released row
--                             is history, and the unique index below frees the traveller for the next claim.
--   * ONE LIVE ROW PER TRAVELLER — a partial unique index on (trip_id, runtime_username): two people can never hold
--                             the same traveller, and a concurrent double claim has exactly one winner in the database
--                             even if the application's own check is wrong.
--   * ANNOUNCED AND LISTED  — the organizers get a notice and a list with a Release button (portal.ts).
--
-- WHY A RELEASE IS A COLUMN AND NOT A MOVE. 20261020120000 moved an organizer link out of the table an older release
-- read, because that release would otherwise have gone on honouring access the owner had taken away. Here there is
-- nothing for an older release to honour. Verified against the code (portal.ts, /internal/runtime-launch/consume):
-- the previous release finds `runtime_username` through a REDEEMED site invite alone
-- (`SELECT ... FROM site_invites i WHERE i.redeemed_by = g.user_id AND i.state = 'redeemed'`). A claimed traveller has
-- no invite, so after a rollback the exchange answers `runtimeUsername: null`, the trip site refuses the identity
-- (IDENTITY_MISMATCH) and the person opens nothing. Rolling back can therefore cost a claimed traveller their access
-- and can never keep access an organizer released: a released claim's link is revoked in place (`revoked_at`, which
-- the previous release's loadAccess already reads), its sessions are ended (`web_sessions.revoked_at`) and its
-- membership is ended, all of which the previous release honours. The one thing an older release can still see is a
-- live member link whose `verified_via` it does not know: it only ever uses it to list the trip's title and dates,
-- exactly what any member sees. That is also why the CHECKs below are WIDENED rather than replaced by another table.
--
-- WIDENED CHECKs on telegram_member_links:
--   verified_via   + 'mini_app_group_membership'      (how a group claim's link was proved); keeps every value an earlier
--                                                    migration added ('secondary_organizer_link', 20261107120000)
--   revoked_reason + 'left_group'                     (the group re-check at a later launch said the person left)
--                  + 'claim_released'                 (an organizer's release)
-- The spec named the first; the second pair is what its AC-6 and AC-7 need and the CHECK would refuse them.

CREATE TABLE control_plane.trip_participant_claims (
  id               text        NOT NULL,
  trip_id          text        NOT NULL REFERENCES control_plane.trips(id),
  user_id          text        NOT NULL REFERENCES control_plane.users(id),
  -- The trip-site participant the account stands for. Shaped exactly like site_invites.runtime_username: the one
  -- pattern the trip site's participants and its identity bridge already enforce.
  runtime_username text        NOT NULL,
  -- 'group_membership' (slice S1) or 'invite' (slice S2's personal invite for an existing traveller).
  via              text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  released_reason  text,
  -- What the live group check needs and nothing else can supply: Telegram's `getChatMember` takes the person's numeric
  -- id, and everywhere else this system keeps only its digest (a digest of a short numeric id is brute-forceable, so
  -- it is as sensitive as the id). It is held ONLY WHILE THE CLAIM IS LIVE: ending a claim sets it NULL (the CHECK
  -- below makes a released row unable to keep one), the same rule the outbox applies to a recipient chat id.
  telegram_user_id text,
  -- When Telegram last said "in the group" for this claim's open session. The runtime liveness check asks again at most
  -- once per 10 minutes per claim (portal.ts); NULL = never asked since the claim.
  last_group_check_at timestamptz,

  CONSTRAINT trip_participant_claims_pkey PRIMARY KEY (id),
  CONSTRAINT trip_participant_claims_telegram_user_id_shape CHECK (telegram_user_id IS NULL OR telegram_user_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT trip_participant_claims_released_holds_no_id CHECK (released_at IS NULL OR telegram_user_id IS NULL),
  CONSTRAINT trip_participant_claims_id_is_opaque CHECK (id ~ '^tpc_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT trip_participant_claims_username_shape CHECK (runtime_username ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  CONSTRAINT trip_participant_claims_via_check CHECK (via IN ('group_membership', 'invite')),
  CONSTRAINT trip_participant_claims_released_reason_check
    CHECK (released_reason IS NULL OR released_reason IN ('organizer_released', 'left_group', 'membership_ended', 'unlinked')),
  CONSTRAINT trip_participant_claims_released_shape_check CHECK ((released_at IS NULL) = (released_reason IS NULL))
);

-- The invariant: at most one LIVE claim per traveller of a trip.
CREATE UNIQUE INDEX trip_participant_claims_live_idx
  ON control_plane.trip_participant_claims (trip_id, runtime_username)
  WHERE released_at IS NULL;
-- "Which traveller is this account?" (the launch exchange) and "which claims does this trip have?" (the organizer's list).
CREATE INDEX trip_participant_claims_user_idx
  ON control_plane.trip_participant_claims (trip_id, user_id)
  WHERE released_at IS NULL;

ALTER TABLE control_plane.telegram_member_links DROP CONSTRAINT IF EXISTS telegram_member_links_verified_via_check;
ALTER TABLE control_plane.telegram_member_links
  ADD CONSTRAINT telegram_member_links_verified_via_check
  CHECK (verified_via IN ('mini_app_trip_password', 'mini_app_invite_redemption', 'secondary_organizer_link', 'mini_app_group_membership'));

ALTER TABLE control_plane.telegram_member_links DROP CONSTRAINT IF EXISTS telegram_member_links_revoked_reason_check;
ALTER TABLE control_plane.telegram_member_links
  ADD CONSTRAINT telegram_member_links_revoked_reason_check
  CHECK (revoked_reason IS NULL OR revoked_reason IN
    ('owner_unlinked', 'trip_password_changed', 'membership_ended', 'invite_revoked', 'left_group', 'claim_released'));

-- A claim follows its membership. An organizer's ordinary "Remove member" (member-removal.ts) ends the membership, and
-- 20261020120000's trigger already revokes the Telegram link and its sessions; without this the traveller would stay
-- "claimed" by an account nobody can sign in as, and nobody could claim them again. Done in the database for the same
-- reason that trigger is: membership status has several writers (the portal, admin tooling, SQL), and a release that
-- depends on each writer remembering is the bug this repository keeps paying for. The route's own release and the
-- left-the-group path end the claim first with their own reason; this then finds nothing live and does nothing.
CREATE OR REPLACE FUNCTION control_plane.trg_membership_ended_releases_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE control_plane.trip_participant_claims
     SET released_at = now(), released_reason = 'membership_ended', telegram_user_id = NULL
   WHERE trip_id = NEW.trip_id AND user_id = NEW.user_id AND released_at IS NULL;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS membership_ended_releases_claim ON control_plane.trip_memberships;
CREATE TRIGGER membership_ended_releases_claim
  AFTER UPDATE OF status ON control_plane.trip_memberships
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION control_plane.trg_membership_ended_releases_claim();
