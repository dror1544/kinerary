-- Lets the bot answer "which trips are mine?" — the link from a verified
-- Telegram sender to the control-plane users they have been PROVEN to own.
--
-- WHY THIS IS NOT user_identities. That table is the obvious home, and it is
-- the wrong one, for a reason that only shows up in its constraints:
--
--     UNIQUE (provider, provider_subject_digest)
--
-- One Telegram id may therefore name exactly one user_id. That is correct for
-- an authentication table — six lookups in app.ts and signup.ts do
-- `SELECT user_id ... WHERE provider = $1 AND digest = $2` and then take
-- `rows[0]`, which is only deterministic while the constraint holds — and it
-- is exactly wrong for the question this migration exists to answer. On this
-- deployment one physical organizer owns TEN user_ids, because each test
-- signup used a differently plus-addressed email and every distinct email
-- digest mints a fresh user. That is not a bug to be repaired here; it is the
-- observed shape of the data, already recorded in chat-router.ts's comment
-- ("two signups made minutes apart by the SAME physical person get two
-- entirely different control-plane user_ids").
--
-- So: a separate, append-only, MANY-user_ids-per-digest table. Relaxing
-- user_identities' unique constraint instead would have made those six auth
-- lookups silently pick an arbitrary row, which is a worse failure than the
-- one being fixed.
--
-- WHAT MAKES A ROW TRUSTWORTHY. Only the control plane writes here, and only
-- from two facts it established itself:
--
--   enrollment_redemption   an enrollment issued to user X was redeemed from
--                           Telegram chat C, where C was read by the router
--                           off its own authenticated connection. Neither half
--                           came from a message body.
--   backfill_intake_session the same pair, recorded by an interview that
--                           already happened — intake_sessions.telegram_chat_id
--                           is the verified id migration 0028 introduced, and
--                           .user_id is the enrollment's owner.
--
-- Nothing a sender can type reaches this table. It is a read model for
-- routing decisions, never a credential, and never an authentication path:
-- possessing a Telegram id proves you are that Telegram id, which is what
-- Telegram's own connection already told us.

CREATE TABLE control_plane.telegram_organizer_links (
  id                       text        NOT NULL,
  user_id                  text        NOT NULL REFERENCES control_plane.users(id),
  -- 'sha256:<hex>', identical in construction to identity.ts's
  -- digestTelegramId. The raw id is deliberately NOT stored: this table is
  -- only ever read to scope a trip list, and the one place a raw chat id is
  -- needed (sending a message) already has it from the update itself.
  telegram_subject_digest  text        NOT NULL,
  verified_via             text        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT telegram_organizer_links_pkey PRIMARY KEY (id),
  CONSTRAINT telegram_organizer_links_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT telegram_organizer_links_digest_shape
    CHECK (telegram_subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT telegram_organizer_links_verified_via_check
    CHECK (verified_via IN ('enrollment_redemption', 'backfill_intake_session'))
);

-- The pair is the row. A repeat redemption from the same chat by the same
-- owner is the normal case, so writers use ON CONFLICT DO NOTHING against
-- this rather than reading first.
CREATE UNIQUE INDEX telegram_organizer_links_pair_idx
  ON control_plane.telegram_organizer_links (telegram_subject_digest, user_id);

-- The only read path: every user_id this Telegram person owns.
CREATE INDEX telegram_organizer_links_digest_idx
  ON control_plane.telegram_organizer_links (telegram_subject_digest);

-- Backfill from interviews that already happened.
--
-- Without this the feature ships inert: a link is written when an enrollment
-- is redeemed, and an organizer whose interviews are all behind them would
-- never redeem another one. Their trips would be invisible to /trips forever,
-- which is precisely the organizer most likely to ask.
--
-- The evidence is the same evidence a fresh redemption produces, recorded at
-- the time by the same code path — so this backfills facts, not guesses.
-- Restricted to the private-chat id shape for the same reason interview.ts
-- restricts what it writes: a group id is not a person.
INSERT INTO control_plane.telegram_organizer_links
  (id, user_id, telegram_subject_digest, verified_via)
SELECT DISTINCT ON (s.telegram_chat_id, s.user_id)
       'tol_' || md5(s.telegram_chat_id || ':' || s.user_id),
       s.user_id,
       'sha256:' || encode(sha256(convert_to(s.telegram_chat_id, 'UTF8')), 'hex'),
       'backfill_intake_session'
  FROM control_plane.intake_sessions s
 WHERE s.telegram_chat_id IS NOT NULL
   AND s.telegram_chat_id ~ '^[0-9]{1,20}$'
ON CONFLICT DO NOTHING;
