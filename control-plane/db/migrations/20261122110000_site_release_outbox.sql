-- rollback: compatible — one new table and two triggers that write only that table; the previous release neither reads the table nor is changed by the triggers, and what a row is worth to it is nothing: a pending release an older release would simply never retry, which is exactly how releases behaved before this (told once after COMMIT, best effort)
--
-- DURABLE RELEASES OF A TRIP-SITE BINDING (docs/specs/sprint-9/x-member-sign-in.md, amendment A21; owner's decision 2026-11-22).
--
-- WHAT WAS WRONG. When a member's way into a trip ended (an organizer's Release of a group claim, the person leaving the
-- group, their own Unlink, a member removed, a redeemed invite revoked), the control plane told the trip site ONCE, after the
-- COMMIT and best effort, to release that person's binding. If the site was down or restarting at that moment the call was
-- lost and never retried. Browser access still ended (the gateway's liveness check reads the control plane), but the site-side
-- release is also what revokes the removed person's assistant (MCP) grants, and those talk straight to the trip site: after a
-- lost release a removed member's assistant went on reading the trip, and an already-issued managed site token went on working
-- on the trip's own hostname, until someone else was bound to that traveller.
--
-- WHAT A ROW OF site_release_outbox IS WORTH. A pending row says: "the trip site may still hold the binding of this control-
-- plane account to this participant (with this invite id, or none for a group claim's), and the control plane has already ended
-- everything on its own side". It is the instruction to finish a removal, not a credential: it carries ids and no secret. It is
-- written by THE DATABASE, in the transaction that ends the claim or the invite, so a crash between COMMIT and the HTTP call
-- loses nothing, and so does a writer that is not the portal (the membership trigger of 20261119120000, SQL, an admin tool):
-- the same reason that trigger lives in the database and not in each writer. A background pass (site-release-outbox.ts) retries
-- it with backoff until the site confirms. A release is idempotent on the site (a repeat answers released:false), so
-- at-least-once delivery is exactly right; and the site matches account + name (+ invite id for an invite's binding), so a late
-- release can never remove another account's, or a newer invite's, binding.
--
-- STATES. 'pending' (to do, or being done: `claimed_until` is the lease of the pass working on it), 'done' (the site confirmed,
-- or there was nothing left to release, or the control plane holds that binding again: `outcome` says which), 'given_up' (the site
-- refused for good, or the trip is gone: `outcome` says which). Done rows are purged a day after they complete, given-up rows 30
-- days after; a pending row is never purged. The unique index below keeps ONE pending row per (trip, account, name, invite).
--
-- NO FOREIGN KEYS, on purpose: a row must outlive nothing it depends on and must not block deleting anything; a trip or an
-- account that no longer exists makes the release moot, and the pass gives it up cleanly ('trip_gone').
--
-- THE OPERATOR'S QUERY (how many releases have been stuck for more than 15 minutes):
--   SELECT count(*) FROM control_plane.site_release_outbox WHERE state = 'pending' AND created_at < now() - interval '15 minutes';

CREATE TABLE control_plane.site_release_outbox (
  id               bigint      GENERATED ALWAYS AS IDENTITY,
  trip_id          text        NOT NULL,
  user_id          text        NOT NULL,
  runtime_username text        NOT NULL,
  -- NULL for a group claim's binding; the redeemed invite's id for an invited member's.
  invite_id        text,
  -- Why the way in ended (the claim's released_reason, or 'invite_revoked'; 'claim_commit_failed' for the compensating release
  -- of a claim whose COMMIT failed). Audit only: it is logged, never sent to the site.
  reason           text        NOT NULL,
  state            text        NOT NULL DEFAULT 'pending',
  -- HTTP attempts made, the prompt one after the COMMIT included.
  attempts         integer     NOT NULL DEFAULT 0,
  -- The first retry is due 30 seconds after the row is written, so the prompt attempt after COMMIT does not race the pass.
  next_attempt_at  timestamptz NOT NULL DEFAULT now() + interval '30 seconds',
  claimed_until    timestamptz,
  outcome          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT site_release_outbox_pkey PRIMARY KEY (id),
  CONSTRAINT site_release_outbox_state_check CHECK (state IN ('pending', 'done', 'given_up')),
  CONSTRAINT site_release_outbox_username_shape CHECK (runtime_username ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  CONSTRAINT site_release_outbox_reason_shape CHECK (reason ~ '^[a-z_]{1,40}$'),
  CONSTRAINT site_release_outbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT site_release_outbox_completed_shape CHECK ((state = 'pending') = (completed_at IS NULL))
);

CREATE UNIQUE INDEX site_release_outbox_pending_key
  ON control_plane.site_release_outbox (trip_id, user_id, runtime_username, (COALESCE(invite_id, '')))
  WHERE state = 'pending';
-- "What is due?" (the pass) and "how old is the oldest stuck one?" (the operator's query).
CREATE INDEX site_release_outbox_due_idx ON control_plane.site_release_outbox (next_attempt_at) WHERE state = 'pending';
CREATE INDEX site_release_outbox_created_idx ON control_plane.site_release_outbox (created_at) WHERE state = 'pending';
-- The purge.
CREATE INDEX site_release_outbox_completed_idx ON control_plane.site_release_outbox (completed_at) WHERE state <> 'pending';

-- A group claim that ENDS (released_at set), by whichever writer: the portal's Release / left-the-group / Unlink, or the membership
-- trigger of 20261119120000 (which fires this one in turn, inside the same transaction). A claim row is ended, never deleted.
CREATE OR REPLACE FUNCTION control_plane.trg_claim_ended_records_site_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO control_plane.site_release_outbox (trip_id, user_id, runtime_username, invite_id, reason)
  VALUES (NEW.trip_id, NEW.user_id, NEW.runtime_username, NULL, COALESCE(NEW.released_reason, 'unknown'))
  ON CONFLICT (trip_id, user_id, runtime_username, (COALESCE(invite_id, ''))) WHERE state = 'pending' DO NOTHING;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS claim_ended_records_site_release ON control_plane.trip_participant_claims;
CREATE TRIGGER claim_ended_records_site_release
  AFTER UPDATE OF released_at ON control_plane.trip_participant_claims
  FOR EACH ROW
  WHEN (OLD.released_at IS NULL AND NEW.released_at IS NOT NULL)
  EXECUTE FUNCTION control_plane.trg_claim_ended_records_site_release();

-- A REDEEMED invite that ends (removing the member, or revoking the redeemed invite): the invited member's binding on the site
-- carries the invite's id and is released only by a call that names it. An UNUSED invite that is revoked or expires bound nothing
-- (a redemption whose answer was lost is the control plane's `deadInviteIds` business, not this table's), so it records nothing.
CREATE OR REPLACE FUNCTION control_plane.trg_redeemed_invite_ended_records_site_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO control_plane.site_release_outbox (trip_id, user_id, runtime_username, invite_id, reason)
  VALUES (OLD.trip_id, OLD.redeemed_by, OLD.runtime_username, OLD.id, 'invite_revoked')
  ON CONFLICT (trip_id, user_id, runtime_username, (COALESCE(invite_id, ''))) WHERE state = 'pending' DO NOTHING;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS redeemed_invite_ended_records_site_release ON control_plane.site_invites;
CREATE TRIGGER redeemed_invite_ended_records_site_release
  AFTER UPDATE OF state ON control_plane.site_invites
  FOR EACH ROW
  WHEN (OLD.state = 'redeemed' AND NEW.state IS DISTINCT FROM 'redeemed' AND OLD.redeemed_by IS NOT NULL)
  EXECUTE FUNCTION control_plane.trg_redeemed_invite_ended_records_site_release();
