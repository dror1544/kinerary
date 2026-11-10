-- rollback: compatible — adds two nullable columns on users that only this release reads or writes; the previous release's inserts and selects name their columns and never see them
--
-- THE NAME AN ORGANIZER GAVE THE PRODUCT (#438, owner decision 2026-10-30).
--
-- The interview greets the organizer by name, and `users.display_name` cannot
-- be that name: it is whatever an account creator happened to write there -- the
-- local part of an email address for a Telegram signup or an operator's
-- invitation, Google's name or the same local part for a Google sign-in -- and
-- nothing says which. A greeting built from it opened "Welcome back,
-- dror.elul+kin7" once already (intake-copy.ts `introductionReturning`).
--
-- `given_name` is the name the person chose or Google verified, and ONLY that:
--   * the email sign-up page asks for it (portal-email-auth.ts), and stores it;
--   * a Google sign-in stores the verified `given_name` / `name` claim when the
--     account has none;
--   * `POST /v1/account/name` stores what an existing account types when the
--     dashboard asks once.
-- NULL means "nobody has told us", which is the state of every account created
-- before this change -- they are asked once, not guessed at.
--
-- `given_name_asked_at` is set when the dashboard has put the question to the
-- person (they answered or chose "not now"), so "asked once" is a fact on the
-- row rather than a browser's memory.
ALTER TABLE control_plane.users
  ADD COLUMN given_name text CHECK (given_name IS NULL OR char_length(given_name) BETWEEN 1 AND 80),
  ADD COLUMN given_name_asked_at timestamptz;
