-- rollback: compatible — two new tables nothing older reads; a link in it opens nothing in the previous release (it has no route that redeems one), so rolling back strands only the links in flight, which expire within 30 minutes
--
-- "SEND ME A SIGN-IN LINK" (docs/specs/sprint-9/x-member-sign-in.md, slice S3, AC-14 to AC-16; issue #614).
--
-- A member who cannot get in asks for a link on a sign-in screen. If the account exists and has a channel, a
-- single-use link goes to that channel; opening it signs the person in. This is the table behind the link.
--
-- WHAT A ROW IS WORTH. A live row (used_at IS NULL, expires_at in the future) is a credential: whoever holds the
-- token whose digest this is becomes `user_id`, with the session the redemption mints. It is therefore
--
--   * STORED AS A DIGEST ONLY  — `token_digest` is sha256 of a 32-byte random token that exists in plaintext only in
--                                the message that carries it (a Telegram DM or an email) and, for the seconds
--                                between the request and the dispatcher's send, in the payload of a
--                                `sign_in_link_notice` outbox row that the dispatcher blanks once it is sent or has
--                                failed for good (sign-in-link.ts). Nothing logs it.
--   * SHORT AND SINGLE USE     — 30 minutes (`expires_at`), and `used_at` is set under a row lock by the redemption,
--                                so two concurrent redemptions have one winner. Asking again ends the older link of
--                                the same account (`expires_at = now()`): only the newest one works.
--   * ABOUT AN ACCOUNT, NOT A  — there is no trip column: the account is what is being signed in. (`telegram_link_id`
--     TRIP                       below is the one exception, and it only ever NARROWS what the session may do.)
--
-- WHY A NEW TABLE and not `email_action_tokens` (20261023140000). That table is keyed by an email DIGEST and its CHECK
-- admits three purposes, all about an address; its rows are also the send budget for mail, so a Telegram link there
-- would spend an address's mail allowance. A link that may go to a Telegram chat has no address, and it has to carry
-- what the redemption must honour: the channel, the Telegram link that scopes the session, and the one-shot password
-- step. Widening the other table to fit would put each concern's constraints on the other.
--
-- `channel` records where the link was sent, for nothing but the record: nothing reads it to decide who may redeem. (The
-- per-channel ceilings of AC-16 do NOT count these rows: see `sign_in_link_requests` below.)
--
-- `telegram_link_id` is the `telegram_member_links` row of a GROUP CLAIM (`verified_via = 'mini_app_group_membership'`)
-- when the account holds one live at the time the link is issued. A session minted from such a link is a SCOPED
-- session of that link (portal-scope.ts): re-checked against the group, dormant when the switch is off, ended when the
-- claim is. Without that, a sign-in link would be a way around every one of those ("A2/A3/A4" of the spec). Not a
-- foreign key, like `web_sessions.telegram_link_id`: the row may be revoked later and the link then simply refuses.
--
-- `session_id` / `password_set_at` are the one-shot "set a new password" step. The page that the redemption opens may
-- offer it ONCE, and only to the session the redemption minted (a general "change my password without the old one"
-- route would be a new way for any stolen session to take the account). `session_id` names that session; the route
-- that sets the password asks for exactly this pair, within 15 minutes, and stamps `password_set_at`.
CREATE TABLE control_plane.sign_in_links (
  id               text        NOT NULL,
  token_digest     text        NOT NULL,
  user_id          text        NOT NULL REFERENCES control_plane.users(id) ON DELETE CASCADE,
  channel          text        NOT NULL,
  telegram_link_id text,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  session_id       text,
  password_set_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sign_in_links_pkey PRIMARY KEY (id),
  CONSTRAINT sign_in_links_token_digest_key UNIQUE (token_digest),
  CONSTRAINT sign_in_links_id_is_opaque CHECK (id ~ '^sil_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT sign_in_links_token_digest_shape CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT sign_in_links_channel_check CHECK (channel IN ('telegram', 'email')),
  CONSTRAINT sign_in_links_used_shape_check CHECK (session_id IS NULL OR used_at IS NOT NULL)
);

-- "How many links has this account been sent lately?" (the per-account ceiling) and "supersede the older ones".
CREATE INDEX sign_in_links_user_idx ON control_plane.sign_in_links (user_id, created_at DESC);
-- The per-channel ceiling and the purge of long-dead rows both ask by time.
CREATE INDEX sign_in_links_channel_idx ON control_plane.sign_in_links (channel, created_at DESC);
-- The password step finds its link by the session it minted.
CREATE INDEX sign_in_links_session_idx ON control_plane.sign_in_links (session_id) WHERE session_id IS NOT NULL;

-- THE PER-CHANNEL CEILINGS COUNT REQUESTS, NOT LINKS (AC-16; boundary review of S3, finding 1). If a ceiling counted issued
-- links, then a person who fills it to one short of full and sends a guess would learn, from whether their OWN link then
-- arrives, whether the guess qualified for a link (every answer is the same 202, so that was the only tell). So every
-- admitted request takes one slot in each ceiling it COULD have used, before anything is looked up and whatever it finds:
-- a name-door request one `telegram` slot; an email-door request one `telegram` and one `email` slot. A request that finds
-- a ceiling full takes no slot of its own. A row here says only "a request was admitted on this channel's ceiling at this
-- time": no account, no address, no name, nothing that identifies a request.
CREATE TABLE control_plane.sign_in_link_requests (
  channel    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sign_in_link_requests_channel_check CHECK (channel IN ('telegram', 'email'))
);
CREATE INDEX sign_in_link_requests_channel_idx ON control_plane.sign_in_link_requests (channel, created_at DESC);

-- RETENTION. Nothing here is purged by a job: every admitted request purges as it starts, which is cheap and needs no
-- scheduler. `sign_in_links` rows older than 2 days, `sign_in_link_requests` rows older than 1 hour (the ceilings look back
-- one minute and the per-account allowance one hour of `sign_in_links`), and any `sign_in_link_notice` outbox row still
-- pending after the link's 30 minutes (its payload, which holds the token until a dispatcher sends it, and its chat id are
-- blanked). A deployment that gets no request therefore keeps the rows of its last requests until the next one; a link is
-- dead after 30 minutes whatever the table holds.
