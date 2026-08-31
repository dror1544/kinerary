CREATE SCHEMA IF NOT EXISTS control_plane;

CREATE TABLE control_plane.users (
  id text PRIMARY KEY CHECK (id ~ '^user_[A-Za-z0-9]{8,64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'deleted')),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.trips (
  id text PRIMARY KEY CHECK (id ~ '^trip_[A-Za-z0-9]{8,64}$'),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN (
    'pending_signup_approval', 'draft', 'intake_in_progress', 'intake_confirmed',
    'planned', 'provisioning_approved', 'provisioning', 'ready_private',
    'activation_approved', 'active', 'completed', 'sealed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.user_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES control_plane.users(id),
  provider text NOT NULL,
  provider_subject_digest text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject_digest)
);

CREATE TABLE control_plane.trip_memberships (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  user_id text NOT NULL REFERENCES control_plane.users(id),
  role text NOT NULL CHECK (role IN ('owner', 'organizer', 'member')),
  status text NOT NULL CHECK (status IN ('active', 'invited', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id)
);

CREATE TABLE control_plane.interview_enrollments (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  user_id text NOT NULL REFERENCES control_plane.users(id),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('issued', 'consumed', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.intake_versions (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  version integer NOT NULL CHECK (version > 0),
  artifact_ref text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, version),
  UNIQUE (trip_id, digest)
);

CREATE TABLE control_plane.releases (
  id text PRIMARY KEY,
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
  artifact_digest text NOT NULL UNIQUE CHECK (artifact_digest ~ '^sha256:[a-f0-9]{64}$'),
  application_schema integer NOT NULL CHECK (application_schema > 0),
  data_schema_min integer NOT NULL CHECK (data_schema_min > 0),
  data_schema_max integer NOT NULL CHECK (data_schema_max >= data_schema_min),
  status text NOT NULL CHECK (status IN ('candidate', 'verified', 'available', 'deprecated', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.plans (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  release_id text REFERENCES control_plane.releases(id),
  kind text NOT NULL CHECK (kind IN ('provision', 'activate', 'upgrade', 'rollback', 'archive')),
  digest text NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'superseded', 'executed')),
  desired jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, digest)
);

CREATE TABLE control_plane.jobs (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  plan_id text NOT NULL REFERENCES control_plane.plans(id),
  job_type text NOT NULL CHECK (job_type IN ('provision', 'activate', 'upgrade', 'rollback', 'archive', 'cleanup')),
  idempotency_key text NOT NULL UNIQUE,
  correlation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'failed' OR safe_error_code IS NOT NULL)
);

CREATE INDEX jobs_claimable_idx ON control_plane.jobs (created_at)
  WHERE state IN ('queued', 'leased');

CREATE TABLE control_plane.job_steps (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES control_plane.jobs(id),
  step_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped')),
  idempotency_key text NOT NULL UNIQUE,
  request_id text,
  safe_error_code text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, step_key)
);

CREATE TABLE control_plane.resources (
  id text PRIMARY KEY,
  trip_id text REFERENCES control_plane.trips(id),
  provider text NOT NULL,
  resource_type text NOT NULL,
  provider_resource_ref text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'development', 'production')),
  test_run_id text,
  state text NOT NULL CHECK (state IN ('planned', 'creating', 'ready', 'failed', 'retained', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_resource_ref),
  CHECK (environment <> 'test' OR (test_run_id IS NOT NULL AND test_run_id ~ '^tr_[a-z0-9]{8,64}$')),
  CHECK (environment = 'test' OR test_run_id IS NULL)
);

CREATE TABLE control_plane.verification_evidence (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  deployment_ref text,
  check_name text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'skipped')),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.activations (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  plan_id text NOT NULL REFERENCES control_plane.plans(id),
  approval_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'verified', 'active', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.organizer_profiles (
  id text PRIMARY KEY,
  organizer_user_id text NOT NULL UNIQUE REFERENCES control_plane.users(id),
  profile_ref text NOT NULL UNIQUE,
  policy_bundle_version integer NOT NULL CHECK (policy_bundle_version > 0),
  memory_bundle_version integer NOT NULL CHECK (memory_bundle_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.trip_contexts (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  organizer_profile_id text NOT NULL REFERENCES control_plane.organizer_profiles(id),
  channel text NOT NULL CHECK (channel IN ('private', 'group', 'admin')),
  requester_role text NOT NULL CHECK (requester_role IN ('owner', 'organizer', 'member', 'super_admin', 'agent')),
  lifecycle_state text NOT NULL,
  action_families text[] NOT NULL CHECK (cardinality(action_families) > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.messaging_bindings (
  id text PRIMARY KEY,
  provider text NOT NULL,
  bot_ref text NOT NULL,
  chat_ref text NOT NULL,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  organizer_profile_id text NOT NULL REFERENCES control_plane.organizer_profiles(id),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  supersedes_id text REFERENCES control_plane.messaging_bindings(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, bot_ref, chat_ref, valid_from)
);

CREATE TABLE control_plane.service_connections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES control_plane.users(id),
  provider text NOT NULL,
  provider_subject_ref text NOT NULL,
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) > 0),
  consent_status text NOT NULL CHECK (consent_status IN ('active', 'revoked', 'expired')),
  connection_secret_ref text NOT NULL CHECK (connection_secret_ref ~ '^(env|file|vault)://'),
  consented_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, provider_subject_ref)
);

CREATE TABLE control_plane.trip_connection_bindings (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  service_connection_id text NOT NULL REFERENCES control_plane.service_connections(id),
  allowed_capabilities text[] NOT NULL CHECK (cardinality(allowed_capabilities) > 0),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, service_connection_id)
);

CREATE TABLE control_plane.source_artifacts (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  provider text NOT NULL,
  source_ref text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  review_status text NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected', 'superseded')),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, provider, source_ref, source_digest)
);

CREATE TABLE control_plane.audit_events (
  id text PRIMARY KEY,
  actor_ref text NOT NULL,
  action text NOT NULL,
  target_ref text NOT NULL,
  correlation_id text NOT NULL,
  before_digest text,
  after_digest text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
