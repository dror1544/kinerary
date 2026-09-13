-- The interview's phase, as a state it ENTERS rather than a property recomputed
-- on every read.
--
-- `state` (0008) answers "can this be confirmed?" and is derived from the
-- answers each time it is read. That works for a form and fails for a
-- conversation, in two ways that both reached real organizers on 2026-09-04:
--
--   * There is no such thing as ENTERING confirmation, only BEING in it. So
--     the recap re-fired on top of every subsequent question (run 2), and
--     "essentials done" needed a flag of its own to be shown exactly once.
--   * Being derived, it can become unreachable. Run 6 answered every required
--     question and still could not finish: `awaiting_confirmation` needed
--     either all sixteen optional questions answered or a finish flag that
--     only a router-drawn button could set, and the agent was doing the
--     asking. The organizer typed approval at a session with no path to it.
--
-- A phase is entered once, leaves once, and carries entry actions that fire on
-- the transition rather than on every read. `ui_state`'s finish_requested and
-- offered_more were a state machine written the hard way; the transitions
-- below say the same thing where it can be reasoned about.
--
--   opening    -> essentials   the organizer sends a document, declines, or
--                              just starts talking
--   essentials -> optional     every required question is answered
--   optional   -> recap        they ask to finish, or nothing optional is left
--   recap      -> optional     "Keep planning"
--   recap      -> confirmed    the organizer's own tap on Confirm
--
-- `state` is kept and derived FROM phase, so every existing reader, API
-- response and confirmation guard behaves exactly as before. This migration
-- adds a source of truth; it does not change what anyone is allowed to do.

ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'opening'
    CHECK (phase IN ('opening', 'essentials', 'optional', 'recap', 'confirmed'));

-- Existing sessions predate the column. Place each one where its answers and
-- flags say it already is, so a live interview does not restart at the document
-- offer under someone mid-conversation.
UPDATE control_plane.intake_sessions
   SET phase = CASE
     WHEN state = 'confirmed' THEN 'confirmed'
     WHEN state = 'awaiting_confirmation' THEN 'recap'
     WHEN ui_state->>'offered_more' = 'true' THEN 'optional'
     WHEN answers = '{}'::jsonb THEN 'opening'
     ELSE 'essentials'
   END
 WHERE phase = 'opening';
