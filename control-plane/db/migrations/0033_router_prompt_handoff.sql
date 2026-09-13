-- The router owns the keyboard; the agent owns judgement. That split is right,
-- but nothing carried the handoff BACK: when the interviewer agent recorded an
-- answer, the router was never told, so it never drew the next question's
-- buttons.
--
-- The effect was systemic rather than cosmetic. The first question arrives from
-- the router with real buttons; the moment an organizer TYPES instead of
-- tapping, the agent takes over, and every question after that is prose with no
-- buttons — for the rest of the interview. The agent cannot draw them itself:
-- `clarify` needs the relay `prompt` op, which this connector does not
-- advertise. The same gap left a completed interview with no Confirm button at
-- all, which is where a real organizer stopped on 2026-09-03.
--
-- So an agent write marks the session as owing a prompt, and the poller — which
-- is the only process holding the bot connection — claims it and renders.
--
-- A timestamp rather than a boolean: claiming is an UPDATE ... RETURNING that
-- clears it, so a crash between claim and send loses one prompt rather than
-- spamming an organizer forever, and the column doubles as evidence of when the
-- handoff happened.
ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS router_prompt_due_at timestamptz;

-- Partial: the sweep only ever looks for rows that owe a prompt, and there is
-- at most a handful at any moment.
CREATE INDEX IF NOT EXISTS intake_sessions_router_prompt_due_idx
  ON control_plane.intake_sessions (router_prompt_due_at)
  WHERE router_prompt_due_at IS NOT NULL;
