-- Tokens that let an organizer bind a family group to their trip by posting
-- one line in that group.
--
-- The problem this solves: a group cannot be bound from the organizer's DM
-- (the control plane has no idea which group they mean) and it cannot be bound
-- from the group (nothing there proves who the organizer is, and on a shared
-- bot the answer "whoever spoke first" would hand one family's trip to
-- another). The token crosses that gap: it is issued into a channel where the
-- organizer's identity is already established, and redeemed in the group,
-- which proves they are in it.
--
-- REUSABLE, not single-use, and that is deliberate. The organizer is told to
-- make the bot an admin BEFORE posting it, because pinning and reading an
-- invite link both need that. They will sometimes forget, and "post it again"
-- has to work — a token that burned itself on first use would turn a forgotten
-- step into a support request. Re-posting re-runs the arrival: rebind, greet,
-- pin.
--
-- `issued_to_telegram_user_id` is what makes a leaked token useless. The token
-- alone would let anyone who saw it bind any group they are in; requiring the
-- sender to be the organizer it was issued to means a forwarded token binds
-- nothing. We always know that id, because the token is handed over in the
-- organizer's own DM.
CREATE TABLE IF NOT EXISTS control_plane.telegram_group_binding_tokens (
  id                          text PRIMARY KEY,
  trip_id                     text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  -- Digest, not the token. A readable token is posted into a group chat and
  -- may be screenshotted or forwarded; storing only its digest means our own
  -- database is not a second copy of every live one.
  token_digest                text NOT NULL UNIQUE,
  issued_to_telegram_user_id  text NOT NULL,
  expires_at                  timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  -- Observability only. Nothing branches on it: a reused token is the
  -- supported path, not an anomaly to detect.
  last_used_at                timestamptz,
  use_count                   integer NOT NULL DEFAULT 0,
  CONSTRAINT telegram_group_binding_tokens_window CHECK (expires_at > created_at)
);

-- One live token per trip at a time. Asking again supersedes rather than
-- accumulates, so an organizer who lost the message cannot end up with several
-- valid tokens in circulation and no idea which is current.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_group_binding_tokens_trip_idx
  ON control_plane.telegram_group_binding_tokens (trip_id);

CREATE INDEX IF NOT EXISTS telegram_group_binding_tokens_expiry_idx
  ON control_plane.telegram_group_binding_tokens (expires_at);
