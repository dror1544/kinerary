-- Sprint 1: signup approval flow
--
-- signup_approval_requests: one row per user. Tracks the pending/decided state
-- of the super-admin approval gate. The UNIQUE(user_id) constraint ensures at
-- most one live request per user; a new one can be created only after an
-- existing request has been decided (approved/rejected/expired).
--
-- notification_outbox: a transactional outbox for admin notifications. Created
-- in the same transaction as the signup request; the server sends it after the
-- transaction commits. Failed rows may be retried up to max_attempts.

CREATE TABLE control_plane.signup_approval_requests (
  id text PRIMARY KEY CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  user_id text NOT NULL UNIQUE REFERENCES control_plane.users(id),
  trip_id text REFERENCES control_plane.trips(id),
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  -- Expiry of the action token last issued to the super-admin. Used to detect
  -- stale pending requests so the user can re-request.
  action_expires_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A pending request has no decided_at; every other terminal state does.
  CHECK (state = 'pending' OR decided_at IS NOT NULL)
);

CREATE INDEX signup_approval_requests_pending_idx
  ON control_plane.signup_approval_requests(user_id)
  WHERE state = 'pending';

CREATE TABLE control_plane.notification_outbox (
  id text PRIMARY KEY CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  signup_request_id text NOT NULL REFERENCES control_plane.signup_approval_requests(id),
  notification_type text NOT NULL CHECK (notification_type IN ('admin_signup_approval')),
  adapter text NOT NULL CHECK (char_length(adapter) BETWEEN 1 AND 64),
  state text NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'skipped')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
