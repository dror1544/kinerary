-- rollback: compatible
--
-- ONE ADDRESS, ONE ORGANIZER — and the repair of the rows that say otherwise.
--
-- 0054 introduced an account an operator could create for somebody else, and
-- deliberately gave it NO `user_identities` row. The reasoning was sound as far
-- as it went: that table is UNIQUE on (provider, provider_subject_digest) and
-- is the authentication path, so a password identity with no credential behind
-- it would collide with `createOrVerifyPasswordIdentity`'s insert the moment
-- that address signed up for itself, and this system has no password reset to
-- undo the wedge.
--
-- What it produced instead was worse, because it was silent. An invited
-- organizer existed only as a digest in `organizer_invitations`, which no
-- authentication path reads. So:
--
--   * They could not log in — no credential, by design.
--   * Signing up with their own address minted a SECOND user_id, because
--     signup keys on `password_credentials` and found nothing.
--   * From that second account, the trip they were invited to — the one with
--     their family's interview in it — returned 404 from `GET /v1/trips/:id`
--     and NOT_OWNER from every owner-scoped route. Permanently. Nothing in the
--     data recorded that the two accounts were one person.
--   * A later invitation for the same address attached its new trip to
--     whichever account owned their most recent trip, so trips kept landing on
--     the one they could not log in with.
--
-- The fix is not to avoid the identity row. It is to let signup COMPLETE an
-- account instead of always creating one: `resolveOrCreateEmailAccount` is now
-- the single answer to "which user is this address?", the identity row is that
-- answer, and the credential arrives separately if and when the person chooses
-- a password. An identity with no credential is an ordinary state — nothing can
-- authenticate as it, because every login path reads the credential table.
--
-- This migration brings existing rows up to that invariant. It is written to be
-- safe to re-run.

-- ── 1. Every invited account becomes a real one ────────────────────────────
--
-- The address the account was created for is recorded, digest-only, on the
-- invitation, and `digestEmail` builds it exactly as identity.ts does — so the
-- invitation's digest IS the identity's subject digest, with no re-derivation
-- and no address in this file.
--
-- ON CONFLICT DO NOTHING covers both re-runs and the case section 2 repairs:
-- an address whose digest already names a DIFFERENT user because they signed
-- up separately. That conflict is not resolved here; it is resolved by moving
-- the trips, below.
--
-- NO CREDENTIAL IS WRITTEN HERE, and none can be: the hash is scrypt, which is
-- the application's to compute, not SQL's. Invitations issued from now on give
-- the account a credential nobody knows at the moment they create it, so the
-- accounts this section backfills are the only credential-less ones that will
-- ever exist. They stay signable-up-for on purpose — that is the one way their
-- organizer gets in before password recovery exists — and the guard in
-- `createOrVerifyPasswordIdentity` is what keeps that from being a way into
-- somebody else's account: an account another identity can already reach is
-- refused. Production has none of these rows; it never ran 0054.
INSERT INTO control_plane.user_identities (id, user_id, provider, provider_subject_digest, verified_at)
-- The id is derived from the pair rather than randomised, so re-running this
-- file cannot mint a second row for the same account. `gen_random_bytes` would
-- need pgcrypto, which this database does not install.
SELECT DISTINCT ON (i.email_digest)
       'idnt_' || md5(i.user_id || ':' || i.email_digest),
       i.user_id,
       'password',
       i.email_digest,
       i.created_at
  FROM control_plane.organizer_invitations i
 WHERE NOT EXISTS (
         SELECT 1 FROM control_plane.user_identities ui
          WHERE ui.user_id = i.user_id
            AND ui.provider = 'password'
            AND ui.provider_subject_digest = i.email_digest)
 ORDER BY i.email_digest, i.created_at
ON CONFLICT (provider, provider_subject_digest) DO NOTHING;

-- ── 2. Accounts the old code already split are merged ──────────────────────
--
-- An address that was invited AND then signed up for itself now holds two
-- user_ids: the invited one, which owns the trip, and the credentialed one,
-- which is the only one that can log in. The canonical account is the one the
-- identity row names — after section 1 that is the invited account where there
-- was no conflict, and the signed-up account where there was.
--
-- Everything owned by the other account moves to it. This is the step that
-- makes the invited trip reachable from the organizer's own login, which is
-- the entire point; leaving it out would fix the invariant for new invitations
-- and leave every existing one stranded.
CREATE TEMPORARY TABLE organizer_account_merges ON COMMIT DROP AS
SELECT DISTINCT i.user_id AS from_user_id, ui.user_id AS to_user_id
  FROM control_plane.organizer_invitations i
  JOIN control_plane.user_identities ui
    ON ui.provider = 'password' AND ui.provider_subject_digest = i.email_digest
 WHERE ui.user_id <> i.user_id;

-- Memberships first. ON CONFLICT covers the rare trip both accounts are
-- already members of, where the canonical row simply stays as it is.
UPDATE control_plane.trip_memberships m
   SET user_id = x.to_user_id
  FROM organizer_account_merges x
 WHERE m.user_id = x.from_user_id
   AND NOT EXISTS (
         SELECT 1 FROM control_plane.trip_memberships other
          WHERE other.trip_id = m.trip_id AND other.user_id = x.to_user_id);

DELETE FROM control_plane.trip_memberships m
 USING organizer_account_merges x
 WHERE m.user_id = x.from_user_id;

-- The Telegram links move too. `/trips` and `/switch` resolve a sender to
-- user_ids through this table and then join memberships — so a link left
-- pointing at the emptied account would lose the organizer their trip list on
-- the bot, which is the one surface that worked before this migration.
UPDATE control_plane.telegram_organizer_links l
   SET user_id = x.to_user_id
  FROM organizer_account_merges x
 WHERE l.user_id = x.from_user_id
   AND NOT EXISTS (
         SELECT 1 FROM control_plane.telegram_organizer_links other
          WHERE other.telegram_subject_digest = l.telegram_subject_digest
            AND other.user_id = x.to_user_id);

DELETE FROM control_plane.telegram_organizer_links l
 USING organizer_account_merges x
 WHERE l.user_id = x.from_user_id;

-- The audit record follows the merge, so "which user did this invitation
-- produce?" keeps answering with an account that still owns the trip.
UPDATE control_plane.organizer_invitations i
   SET user_id = x.to_user_id
  FROM organizer_account_merges x
 WHERE i.user_id = x.from_user_id;

-- The emptied accounts keep their row, because `users` is referenced from rows
-- this migration does not claim to understand — funnel events, approval
-- requests, sessions — and deleting them would take that history with them.
-- They are marked instead, so what is left does not read as a real organizer
-- with no trips.
--
-- 'deleted' rather than a new status word: `users.status` is CHECK-constrained
-- to ('pending', 'active', 'suspended', 'deleted') since 0001, and widening a
-- foundational constraint to describe a one-off repair is a worse trade than
-- reusing the value that already means "this account is not somebody". It also
-- makes the merged account fall out of the `u.status = 'active'` joins the
-- login paths already apply, which is the behavior wanted anyway.
--
-- By construction these accounts hold no identity row: a merge only happens
-- where section 1's insert hit the unique pair, meaning some OTHER user
-- already held this digest. The guard states that rather than trusting it.
UPDATE control_plane.users u
   SET status = 'deleted', updated_at = now()
  FROM organizer_account_merges x
 WHERE u.id = x.from_user_id
   AND u.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM control_plane.user_identities ui WHERE ui.user_id = u.id);

COMMENT ON TABLE control_plane.organizer_invitations IS
  'One row per interview link an operator issued on someone else''s behalf: which address (digest only), which user and trip it produced, who issued it. An audit record, not an identity namespace — the account it names is the address''s one canonical organizer, the same one their own signup or a verified Google sign-in resolves to. Not a credential and not an authentication path.';
