-- Additions made after 0020 was already applied in real control-plane
-- databases. Keep these in a forward migration: altering an applied file
-- leaves existing installations without the schema/data it now describes.

CREATE TABLE IF NOT EXISTS control_plane.telegram_interview_bindings (
  chat_id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  session_id text NOT NULL UNIQUE REFERENCES control_plane.intake_sessions(id),
  state text NOT NULL CHECK (state IN ('active', 'confirmed', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_interview_bindings_trip_idx
  ON control_plane.telegram_interview_bindings(trip_id);

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

-- Intentionally coarse product telemetry. No request metadata, URLs, tokens,
-- transcripts, provider addresses or free-form properties are retained.
CREATE TABLE IF NOT EXISTS control_plane.funnel_events (
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
CREATE INDEX IF NOT EXISTS funnel_events_name_created_idx
  ON control_plane.funnel_events(event_name, created_at DESC);
