-- Whose turn it is to speak — a fact about the SESSION, not about a turn or a
-- question.
--
-- Dror, 2026-09-05 run 7, and the framing is his:
--
--   "almost every question I get at least twice, seems like one from the router
--    and one from the agent, look like the timeout is not reset, furthermore
--    waiting to a person response need to be handled from the session
--    perspective not by one question"
--
-- Measured that run: 10 router prompts and 6 agent messages for roughly ten
-- questions, and ZERO deduplications — because the two speakers write different
-- words for the same question, and the dedupe compares prompt keys the agent's
-- messages never carry. The recap was sent with its Confirm keyboard and then
-- buried under agent prose, so an interview that had reached
-- `awaiting_confirmation` with 14 answers still could not be confirmed.
--
-- Two speakers, each deciding independently that something is owed. No amount
-- of deduplication fixes that, because they genuinely disagree.
--
-- THE MODEL. At any moment the conversation waits on exactly one party:
--
--   awaiting = 'machine'  the organizer has spoken; we owe the next message.
--                         The deadline runs. Whoever speaks first — the
--                         interviewer with its own words, or the router with
--                         the next question once the deadline passes — speaks,
--                         and flips this to 'person'.
--   awaiting = 'person'   we have spoken; it is their turn. NOTHING is sent,
--                         and the deadline is not running. Silence is correct.
--
-- One organizer message therefore produces exactly one reply, whichever half
-- produces it. That is what makes a question arriving twice impossible rather
-- than merely unlikely.
--
-- This subsumes four guards added between 2026-09-04 and 2026-09-05, each of
-- which was approximating this one fact badly: the per-turn watchdog, the
-- router-prompt settle window, the prompt dedupe, and the handback guard.

ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS awaiting text NOT NULL DEFAULT 'person'
    CHECK (awaiting IN ('person', 'machine'));

-- When the current wait began. Only meaningful while awaiting = 'machine';
-- the deadline is measured from here, so it restarts on each organizer message
-- rather than running against a person who is simply reading.
ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS awaiting_since timestamptz NOT NULL DEFAULT now();

-- Live sessions are mid-conversation. 'person' is the safe placement: it means
-- the router says nothing until the organizer speaks again, which is a pause,
-- where the other direction would be a message nobody asked for.
