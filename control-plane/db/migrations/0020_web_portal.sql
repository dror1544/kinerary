-- Organizer web portal: provider-neutral browser sessions, multi-trip metadata,
-- surface-specific access, operations review, runtime routing and invitations.

ALTER TABLE control_plane.trips
  ADD COLUMN title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  ADD COLUMN destination_label text CHECK (destination_label IS NULL OR char_length(destination_label) BETWEEN 1 AND 160),
  ADD COLUMN start_date date,
  ADD COLUMN end_date date,
  ADD COLUMN trip_type text CHECK (trip_type IS NULL OR trip_type IN ('family', 'group', 'couple', 'other')),
  ADD COLUMN draft_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT trips_date_order_check CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  ADD CONSTRAINT trips_draft_inputs_canonical_check CHECK (control_plane.canonical_json_is_safe(draft_inputs));

ALTER TABLE control_plane.trip_memberships
  ADD COLUMN dashboard_access boolean NOT NULL DEFAULT false,
  ADD COLUMN runtime_access boolean NOT NULL DEFAULT false;

UPDATE control_plane.trip_memberships
SET dashboard_access = true, runtime_access = true
WHERE role IN ('owner', 'organizer') AND status = 'active';

CREATE TABLE control_plane.web_auth_attempts (
  id text PRIMARY KEY CHECK (id ~ '^wauth_[A-Za-z0-9]{8,64}$'),
  state_digest text NOT NULL UNIQUE CHECK (state_digest ~ '^sha256:[a-f0-9]{64}$'),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  nonce text NOT NULL CHECK (char_length(nonce) BETWEEN 16 AND 128),
  return_to text NOT NULL CHECK (return_to ~ '^/[A-Za-z0-9/_?=&.#%-]*$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.web_sessions (
  id text PRIMARY KEY CHECK (id ~ '^wsess_[A-Za-z0-9]{8,64}$'),
  user_id text NOT NULL REFERENCES control_plane.users(id),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  csrf_digest text NOT NULL CHECK (csrf_digest ~ '^sha256:[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_sessions_user_idx ON control_plane.web_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE control_plane.telegram_interview_bindings (
  chat_id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  session_id text NOT NULL UNIQUE REFERENCES control_plane.intake_sessions(id),
  state text NOT NULL CHECK (state IN ('active', 'confirmed', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_interview_bindings_trip_idx ON control_plane.telegram_interview_bindings(trip_id);

CREATE TABLE control_plane.plan_operations_reviews (
  id text PRIMARY KEY CHECK (id ~ '^oprv_[A-Za-z0-9]{8,64}$'),
  plan_id text NOT NULL UNIQUE REFERENCES control_plane.plans(id),
  requested_by text NOT NULL REFERENCES control_plane.users(id),
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
  decided_by text REFERENCES control_plane.users(id),
  safe_rejection_code text CHECK (safe_rejection_code IS NULL OR safe_rejection_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
      OR (state <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE TABLE control_plane.runtime_routes (
  trip_id text PRIMARY KEY REFERENCES control_plane.trips(id),
  route_ref text NOT NULL UNIQUE CHECK (route_ref ~ '^route_[A-Za-z0-9]{8,64}$'),
  resource_id text REFERENCES control_plane.resources(id),
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing successful trips remain reachable during the transition. The
-- private provider URL stays in the job result; only this opaque key is added
-- to the browser-facing routing registry.
INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state)
SELECT DISTINCT ON (j.trip_id) j.trip_id, 'route_' || md5(j.trip_id), 'ready'
FROM control_plane.jobs j
JOIN control_plane.trips t ON t.id = j.trip_id
WHERE j.state = 'succeeded' AND j.result ? 'private_url'
ORDER BY j.trip_id, j.updated_at DESC
ON CONFLICT (trip_id) DO NOTHING;

CREATE TABLE control_plane.runtime_launch_grants (
  id text PRIMARY KEY CHECK (id ~ '^launch_[A-Za-z0-9]{8,64}$'),
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  user_id text NOT NULL REFERENCES control_plane.users(id),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  audience text NOT NULL CHECK (audience = 'runtime_gateway'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_launch_active_idx ON control_plane.runtime_launch_grants(trip_id, user_id) WHERE consumed_at IS NULL;

CREATE TABLE control_plane.site_invites (
  id text PRIMARY KEY CHECK (id ~ '^invite_[A-Za-z0-9]{8,64}$'),
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  created_by text NOT NULL REFERENCES control_plane.users(id),
  intended_display_name text NOT NULL CHECK (char_length(intended_display_name) BETWEEN 1 AND 120),
  runtime_username text NOT NULL CHECK (runtime_username ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('unused', 'redeemed', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  redeemed_by text REFERENCES control_plane.users(id),
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'redeemed' AND redeemed_at IS NOT NULL) OR state <> 'redeemed')
);
CREATE INDEX site_invites_trip_idx ON control_plane.site_invites(trip_id, created_at DESC);

-- Intentionally coarse product telemetry. No request metadata, URLs, tokens,
-- transcripts, provider addresses or free-form properties are retained.
CREATE TABLE control_plane.funnel_events (
  id text PRIMARY KEY CHECK (id ~ '^event_[A-Za-z0-9]{8,64}$'),
  event_name text NOT NULL CHECK (event_name IN (
    'landing_cta', 'google_auth', 'draft_created', 'interview_launched',
    'interview_confirmed', 'provisioning_requested', 'provisioning_approved',
    'provisioning_completed', 'runtime_launched', 'invitation_redeemed'
  )),
  outcome text CHECK (outcome IS NULL OR outcome IN ('success', 'failure')),
  user_id text REFERENCES control_plane.users(id) ON DELETE SET NULL,
  trip_id text REFERENCES control_plane.trips(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_name = 'google_auth') OR outcome IS NULL)
);
CREATE INDEX funnel_events_name_created_idx ON control_plane.funnel_events(event_name, created_at DESC);
