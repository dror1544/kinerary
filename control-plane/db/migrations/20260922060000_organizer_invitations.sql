-- rollback: compatible — a nullable column + CHECK on trips (with a same-migration backfill), and one new table (organizer_invitations) with its indexes; nothing existing changes shape
--
-- Two facts a second trip for the same organizer needs, and the record of who
-- was invited to one.
--
-- THE COMPANION PROFILE BELONGS TO THE TRIP, NOT TO A CHAT. `hermes_profile`
-- has only ever existed on `telegram_chat_bindings` (0019, nullable since
-- 0043), so a trip's companion is only named while some chat points at it.
-- Every way that breaks is a trip with a working assistant nobody can reach:
--
--   * A trip whose binding was REFUSED has no row at all, so the profile the
--     provisioner just installed is recorded nowhere.
--   * With the organizer's chat retargeting to their newest trip, the trip it
--     moved AWAY from is left with only a CLOSED row. `/switch` going back had
--     to read a closed binding to find the companion — using a row whose whole
--     purpose is to say "this no longer routes" as the source of truth for
--     what does.
--
-- Either way `/switch` binds the chat with a NULL profile, and the trip answers
-- "I'm still finishing your assistant" for good, with its assistant installed
-- and running beside it.
--
-- So the trip carries its own companion, written when the profile installs,
-- whatever happens to any chat afterwards. Bindings keep their column: it is
-- what routing reads, and a binding may legitimately point at a profile the
-- trip no longer uses.
ALTER TABLE control_plane.trips
  ADD COLUMN IF NOT EXISTS hermes_profile text
    CHECK (hermes_profile IS NULL OR char_length(btrim(hermes_profile)) BETWEEN 1 AND 64);

COMMENT ON COLUMN control_plane.trips.hermes_profile IS
  'The companion profile installed for this trip, independent of any chat binding. Written when the profile installs; the binding''s own column is what routing reads.';

-- Backfill: every trip that has a binding naming a profile already knows its
-- companion, closed bindings included — a trip whose chat was detached still
-- has the profile it was built with. Newest binding wins on the rare trip with
-- more than one.
UPDATE control_plane.trips t
   SET hermes_profile = b.hermes_profile
  FROM (
    SELECT DISTINCT ON (trip_id) trip_id, hermes_profile
      FROM control_plane.telegram_chat_bindings
     WHERE hermes_profile IS NOT NULL
     ORDER BY trip_id, created_at DESC
  ) b
 WHERE b.trip_id = t.id AND t.hermes_profile IS NULL;

-- WHO WAS INVITED, BY WHOM, AND WHICH TRIP IT MADE.
--
-- An operator can hand someone an interview link without that person ever
-- typing a password, so there is a kind of account the auth tables cannot
-- describe: `password_credentials` exists only once somebody has chosen a
-- password, and `user_identities` is UNIQUE on (provider, digest), so writing
-- a password identity with no credential behind it would leave the invited
-- address unable to ever sign up for itself — the row would be there, the
-- credential would not, and `createOrVerifyPasswordIdentity` would collide on
-- the insert. There is no password reset in this system to rescue that.
--
-- This table therefore holds the email digest instead, and nothing about it is
-- a credential: it cannot authenticate anyone, and possessing an address it
-- names grants nothing. It answers two questions — "have I invited this
-- address before, and what did it get?" and "who issued this invitation, and
-- when?" — the second of which is the audit record an operator write needs to
-- leave behind, kept separately from the act itself.
--
-- The digest is built exactly as password-identity.ts builds it (sha256 of the
-- trimmed, lowercased address), so an address that later signs up for itself
-- is recognisable as the same person rather than being a coincidence nobody
-- can check.
CREATE TABLE IF NOT EXISTS control_plane.organizer_invitations (
  id            text        PRIMARY KEY CHECK (id ~ '^invt_[A-Za-z0-9]{8,64}$'),
  email_digest  text        NOT NULL CHECK (email_digest ~ '^sha256:[a-f0-9]{64}$'),
  user_id       text        NOT NULL REFERENCES control_plane.users(id),
  trip_id       text        NOT NULL REFERENCES control_plane.trips(id),
  -- 'new' (nobody had this address), 'resume' (their trip was still a draft, so
  -- this replaced its link) or 'returning' (they had a trip already, so this
  -- opened another). It is what the invitation message was written for, and
  -- what the greeting the organizer meets was chosen by.
  kind          text        NOT NULL CHECK (kind IN ('new', 'resume', 'returning')),
  -- The language the INVITATION was written in. Not the interview's language:
  -- that still comes from the organizer's own Telegram client, because it is
  -- the only statement of preference they have actually made themselves.
  language      text        NOT NULL CHECK (language IN ('en', 'he')),
  -- Free text naming the human who asked for it, from the operator tool that
  -- issued it. Never a model's assertion about who it is acting for.
  invited_by    text        NOT NULL CHECK (char_length(btrim(invited_by)) BETWEEN 1 AND 120),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organizer_invitations_email_idx
  ON control_plane.organizer_invitations (email_digest, created_at DESC);

CREATE INDEX IF NOT EXISTS organizer_invitations_created_idx
  ON control_plane.organizer_invitations (created_at DESC);

COMMENT ON TABLE control_plane.organizer_invitations IS
  'One row per interview link an operator issued on someone else''s behalf: which address (digest only), which user and trip it produced, who issued it. Not a credential and not an authentication path.';
