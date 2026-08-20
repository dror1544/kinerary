-- Sprint 3: Planner, approvals, durable jobs, and release selection
--
-- 1. Add schema_version to intake_versions so the planner can select a
--    compatible release without inferring version from artifact_ref content.
-- 2. Add last_heartbeat_at and max_attempts to jobs for durable lease tracking
--    and bounded retries.
-- 3. Extend jobs.state to include waiting_for_user_action (human approval gate).
-- 4. Add job_attempt to job_steps so per-attempt step history is preserved
--    across bounded retries rather than overwritten.
-- 5. Create plan_approvals: expiring one-time records that bind a specific plan
--    digest before the private worker can claim provisioning work. The worker
--    checks for a valid, non-expired, non-used approval when claiming a job,
--    then marks it used atomically with the lease transition.

-- ── intake_versions ──────────────────────────────────────────────────────────

ALTER TABLE control_plane.intake_versions
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0);

-- ── jobs: heartbeat and bounded retries ──────────────────────────────────────

ALTER TABLE control_plane.jobs
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1);

-- Extend state to include waiting_for_user_action. The inline column CHECK
-- was auto-named jobs_state_check by PostgreSQL; drop and re-add with the
-- new set.
ALTER TABLE control_plane.jobs DROP CONSTRAINT jobs_state_check;
ALTER TABLE control_plane.jobs ADD CONSTRAINT jobs_state_check CHECK (
  state IN (
    'queued', 'leased', 'running', 'waiting',
    'waiting_for_user_action', 'succeeded', 'failed', 'cancelled'
  )
);

-- ── job_steps: per-attempt history ───────────────────────────────────────────

-- job_attempt records which job-level attempt this step belongs to, allowing
-- the same step_key to appear once per attempt rather than being overwritten.
ALTER TABLE control_plane.job_steps
  ADD COLUMN job_attempt integer NOT NULL DEFAULT 0 CHECK (job_attempt >= 0);

-- Widen the uniqueness constraint from (job_id, step_key) to
-- (job_id, job_attempt, step_key) so retries produce new rows.
ALTER TABLE control_plane.job_steps DROP CONSTRAINT job_steps_job_id_step_key_key;
ALTER TABLE control_plane.job_steps ADD CONSTRAINT job_steps_attempt_step_unique
  UNIQUE (job_id, job_attempt, step_key);

-- ── plan_approvals ────────────────────────────────────────────────────────────

CREATE TABLE control_plane.plan_approvals (
  id         text        PRIMARY KEY CHECK (id ~ '^appr_[A-Za-z0-9]{8,64}$'),
  plan_id    text        NOT NULL REFERENCES control_plane.plans(id),
  -- Bind the approval to the exact plan state at approval time.
  plan_digest text       NOT NULL CHECK (plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- SHA-256 of the raw approval token; the raw token is never stored.
  token_digest text      NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  issued_by  text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── index updates ─────────────────────────────────────────────────────────────

-- Replace the broad claimable index (covers queued+leased) with a narrower one
-- covering only the states the worker selects from.
DROP INDEX control_plane.jobs_claimable_idx;
CREATE INDEX jobs_queued_idx ON control_plane.jobs (created_at) WHERE state = 'queued';
CREATE INDEX jobs_leased_idx ON control_plane.jobs (lease_expires_at) WHERE state = 'leased';
