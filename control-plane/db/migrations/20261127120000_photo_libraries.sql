-- rollback: compatible — new tables only
-- A photo library per user (#699, docs/specs/sprint-9/699-user-photo-library.md, slice S1a).
--
-- photo_connections: a user's connection to a photo library they own (Immich now, Google Photos in S3). One per service
-- per user (L3). The credential is never stored in the clear: `credential_ct` is AES-256-GCM ciphertext
-- (control-plane/api/src/photo-credentials.ts) and `credential_key_id` names the key that sealed it, so the key can be
-- rotated. Disconnecting deletes the row, and with it the credential (AC-5).
--
-- At most one default per user, enforced by the partial unique index below. It is not deferrable, so whoever moves the
-- default clears the old one before setting the new one, in one transaction (photo-library.ts does).
--
-- trip_photo_library: the per-trip organizer setting ("copy this trip's photos to my photo library"). Read and written
-- from S2; created here because the spec's one migration names both tables.
--
-- Nothing existing changes shape and no release before this one reads either table: a code-only rollback keeps them.

CREATE TABLE control_plane.photo_connections (
  id text PRIMARY KEY CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  user_id text NOT NULL REFERENCES control_plane.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('immich', 'google_photos')),
  server_url text CHECK (server_url IS NULL OR server_url ~ '^https?://'),
  public_url text CHECK (public_url IS NULL OR public_url ~ '^https?://'),
  credential_ct text NOT NULL CHECK (length(credential_ct) > 0),
  credential_key_id text NOT NULL CHECK (credential_key_id ~ '^k_[0-9a-f]{16}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect')),
  is_default boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider),
  -- An Immich connection is an address; a Google Photos one is not.
  CHECK (provider <> 'immich' OR server_url IS NOT NULL)
);

CREATE UNIQUE INDEX photo_connections_one_default_per_user
  ON control_plane.photo_connections (user_id) WHERE is_default;

CREATE TABLE control_plane.trip_photo_library (
  trip_id text PRIMARY KEY REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  sync_enabled boolean NOT NULL DEFAULT true,
  updated_by text REFERENCES control_plane.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
