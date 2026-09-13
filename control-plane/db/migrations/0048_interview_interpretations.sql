-- The interview without an agent, first slice: interpretation records and the
-- per-session switch that decides which path a session is on.
--
-- Design: docs/interview-without-an-agent.md §5 and §6.
--
-- `interview_interpretations` exists for idempotency, not for history. Telegram
-- redelivers, the relay restarts, and a crash between the model answering and
-- the answers being committed is an ordinary event rather than a hypothetical:
-- the relay process died silently for ten minutes during run 15. Keyed on the
-- BURST (`burst_key` is the message ids that made it up, sorted) rather than on
-- the turn, because the burst is what the model was actually shown — a turn can
-- outlive several, and a redelivery arrives with no turn at all.
--
-- The unique constraint is the mechanism. `claimSettledInboundBursts` already
-- guarantees two poll ticks cannot both flush one burst; this extends that
-- across the model call, which happens outside the claim and is the expensive
-- half. A second attempt at the same burst finds the row and reuses it.
--
-- `committed_at` separates "we know what this message meant" from "the answers
-- are written". A row with proposals and no `committed_at` is precisely the
-- crash window, and is resumable rather than repeatable.
CREATE TABLE IF NOT EXISTS control_plane.interview_interpretations (
  id text PRIMARY KEY CHECK (id ~ '^interp_[A-Za-z0-9]{8,64}$'),
  session_id text NOT NULL REFERENCES control_plane.intake_sessions(id) ON DELETE CASCADE,
  telegram_chat_id text NOT NULL,
  -- Sorted, comma-joined Telegram message ids; a digest of the text when
  -- Telegram gave none, so this is never empty. See `burstKey`.
  burst_key text NOT NULL,
  -- Exactly what the model was shown, so a rejected proposal's evidence can be
  -- re-checked later against the same source rather than a reconstruction.
  source_text text NOT NULL,
  -- What the model proposed, before our gate ran.
  proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What the gate decided: accepted, rejected with reason, asked anyway.
  outcomes jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Null when the model could not be reached or its output was refused; the
  -- router asked its own question and that is a normal, recorded outcome.
  failure_reason text,
  attempts integer NOT NULL DEFAULT 0,
  duration_ms integer,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (telegram_chat_id, burst_key)
);

CREATE INDEX IF NOT EXISTS interview_interpretations_session_idx
  ON control_plane.interview_interpretations (session_id, created_at DESC);

COMMENT ON TABLE control_plane.interview_interpretations IS
  'One row per settled inbound burst on the interpret path. The unique (chat, burst_key) is the idempotency key; committed_at marks the answers as written.';

-- Which path this session is on. Per session, not global: the agent path stays
-- intact and untouched for every session not switched over, which is what makes
-- the benchmark in §8 a comparison rather than a migration.
--
-- It is also the one-writer switch (§5). While this is true the agent's write
-- routes (/internal/interview/agent/current/*) refuse: running both writers in
-- one session would preserve exactly the competing-writer failure this design
-- exists to remove, and would make any measurement a property of the mixture.
ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS interpret_path boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN control_plane.intake_sessions.interpret_path IS
  'True when this session is driven by interpret + the router rather than by the interviewer agent. Also refuses agent writes: exactly one writer per session.';
