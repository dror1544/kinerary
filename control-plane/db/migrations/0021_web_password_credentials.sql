-- Trip-scoped portal password credentials for invitees who joined without
-- Google. Runtime passwords remain per-trip; this table only lets those users
-- regain a portal session later so the gateway can mint a fresh launch grant.

CREATE TABLE control_plane.web_password_credentials (
  user_id text NOT NULL REFERENCES control_plane.users(id) ON DELETE CASCADE,
  trip_id text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  runtime_username text NOT NULL CHECK (runtime_username ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 32 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, trip_id),
  UNIQUE (trip_id, runtime_username)
);

CREATE INDEX web_password_credentials_trip_username_idx
  ON control_plane.web_password_credentials(trip_id, runtime_username);

CREATE UNIQUE INDEX site_invites_trip_runtime_live_idx
  ON control_plane.site_invites(trip_id, runtime_username)
  WHERE state IN ('unused', 'redeemed');
