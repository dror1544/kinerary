-- Sprint 2: authorized interview and immutable intake
--
-- intake_sessions: one session per enrollment. Holds the in-progress interview
-- state (answers, current step) for the Hermes interviewer. A session is
-- created when the organizer exchanges a valid enrollment token; the enrollment
-- is marked consumed in the same transaction. The session_token_digest is the
-- SHA-256 of the opaque bearer token returned to the caller — the raw token is
-- never stored. On CONFIRM the session transitions to 'confirmed' and an
-- intake_versions row is created atomically.
--
-- The answer store (jsonb) records { option_id, schema_version, other_text }
-- for choice questions and { text, schema_version } for free-text questions.
-- Schema version is the integer question-schema version active when the answer
-- was written, so future migrations can interpret old answers correctly.
--
-- A confirmed session is immutable: no further answer writes are accepted and
-- the session_token_digest is cleared so the bearer token becomes inert.

CREATE TABLE control_plane.intake_sessions (
  id text PRIMARY KEY CHECK (id ~ '^sess_[A-Za-z0-9]{8,64}$'),
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  user_id text NOT NULL REFERENCES control_plane.users(id),
  enrollment_id text NOT NULL UNIQUE REFERENCES control_plane.interview_enrollments(id),
  -- SHA-256 of the session bearer token, cleared on confirmation.
  session_token_digest text CHECK (
    session_token_digest IS NULL
    OR session_token_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  state text NOT NULL CHECK (state IN ('interviewing', 'awaiting_confirmation', 'confirmed')),
  -- Answers keyed by question ID. See module comment for value shape.
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup by session token digest (used on every session API call).
CREATE UNIQUE INDEX intake_sessions_token_idx
  ON control_plane.intake_sessions (session_token_digest)
  WHERE session_token_digest IS NOT NULL;
