-- rollback: compatible — adds one new table that only this release reads or writes; the previous release never touches it, and its sign-in, Google and invite paths are unchanged
--
-- EMAIL SIGN-UP AND PASSWORD RESET FOR THE PORTAL (owner decision 2026-10-23).
--
-- One table holds every emailed, single-use action token. It stores the
-- sha256 of the token, never the token (the pattern of the Telegram link
-- token and the enrollment), and never the email address either: the address
-- is kept only as the same irreversible digest `user_identities` and
-- `password_credentials` use, so the table can be matched to an account
-- without holding anything that can be mailed.
--
-- AN UNVERIFIED SIGN-UP IS A ROW HERE, NOT AN ACCOUNT. `purpose = 'sign_up'`
-- carries the digest of the token and the return path, and NO PASSWORD AND NO
-- NAME: the person chooses both on the page the emailed link opens, in the same
-- request that spends the token. So whoever starts a sign-up for somebody
-- else's address never knows a password for the account that address will get,
-- and cannot put a name of their choosing on it or in the mail it sends. No `users`,
-- `user_identities` or `password_credentials` row exists until the token is
-- consumed, so an unverified sign-up cannot sign in (there is no credential to
-- match), cannot be claimed by anyone, and cannot stand in the way of an
-- operator's invitation or a Google sign-in for the same address: those resolve
-- the address through `resolveOrCreateEmailAccount` and find nothing here to
-- collide with.
--
-- 'password_reset' is bound to the user it was issued for. 'existing_notice'
-- records that a "you already have an account" message was sent (the token
-- digest is random and unusable, consumed at birth): the table is also the
-- per-address send budget, so mailing a stranger's address cannot be repeated
-- without limit, and the notice has to count against it like the others.
CREATE TABLE control_plane.email_action_tokens (
  id text PRIMARY KEY CHECK (id ~ '^eat_[A-Za-z0-9]{8,64}$'),
  purpose text NOT NULL CHECK (purpose IN ('sign_up', 'password_reset', 'existing_notice')),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  email_digest text NOT NULL CHECK (email_digest ~ '^sha256:[a-f0-9]{64}$'),
  user_id text REFERENCES control_plane.users(id) ON DELETE CASCADE,
  return_to text CHECK (return_to IS NULL OR return_to ~ '^/[A-Za-z0-9/_?=&.#%-]*$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (purpose <> 'password_reset' OR user_id IS NOT NULL)
);

-- The per-address send budget and "supersede the previous live token" both ask by address.
CREATE INDEX email_action_tokens_address_idx ON control_plane.email_action_tokens(email_digest, created_at DESC);
-- The purge of long-dead rows.
CREATE INDEX email_action_tokens_created_idx ON control_plane.email_action_tokens(created_at);
