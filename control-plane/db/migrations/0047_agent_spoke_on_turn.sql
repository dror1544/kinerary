-- When the interviewer agent last spoke through a real speaking tool, per turn.
--
-- Background. The agent is supposed to reach the organizer only through
-- `say_for_chat` / `ask_question_for_chat`, so the router keeps the keyboard,
-- the record and the order. It kept writing plain prose instead, and A1 dropped
-- that prose outright — which produced its own failure on 2026-09-05: 17
-- refused sends against 3 say_for_chat calls. The organizer silently got less
-- conversation, and a turn that produced nothing looked STALLED, so the
-- watchdog fired and re-asked the same question over and over.
--
-- The repair converted prose into a say rather than dropping it. That fixed the
-- stall, and opened a second door: prose the agent writes to ITSELF now reaches
-- the organizer too. Live on 2026-09-07 the agent narrated its own plumbing and
-- told the organizer it was "waiting for your answer" to a question the router
-- had never sent.
--
-- Both failures share one distinction the code could not previously draw: prose
-- INSTEAD of speaking is a message worth rescuing; prose AFTER speaking is
-- thinking out loud. This column draws it. Set the moment the agent uses a real
-- speaking tool; the conversion refuses once it is set.
--
-- Per TURN, not per session: each turn starts silent, so an agent that speaks
-- properly in one turn is not muted in the next.
ALTER TABLE control_plane.interview_agent_turns
  ADD COLUMN IF NOT EXISTS agent_spoke_at timestamptz;

COMMENT ON COLUMN control_plane.interview_agent_turns.agent_spoke_at IS
  'When the agent first used say_for_chat/ask_question_for_chat in this turn. Prose converted after this point is narration, not speech, and is dropped.';
