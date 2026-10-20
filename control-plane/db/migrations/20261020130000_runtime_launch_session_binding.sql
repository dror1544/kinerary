-- rollback: compatible — adds one nullable column; the prior version never reads or writes it, and a grant without it keeps the prior behaviour (any live portal session of the person)
-- A trip session opened from the dashboard is tied to the portal session that
-- launched it, so signing out on one device ends the trip session opened there
-- and not the one opened from another device.
--
-- It holds the web session's ID (wsess_…), not its token digest: the ID is a row
-- name, the digest is derived from a credential and has no business in a cookie
-- the gateway seals. Deliberately NOT a foreign key: the check asks "is the
-- session with this ID live?", and a deleted session must answer no, not be
-- rewritten to NULL (which would silently fall back to "any session").
-- NULL = a grant minted before this column existed; the gateway treats it as
-- before until it expires (grants live 90 seconds).
ALTER TABLE control_plane.runtime_launch_grants
  ADD COLUMN session_id text CHECK (session_id IS NULL OR session_id ~ '^wsess_[A-Za-z0-9]{8,64}$');
