-- Lets an interview stay open after the required questions are answered, and
-- remembers what the organizer chose to skip.
--
-- WHY THIS EXISTS
--
-- `deriveSessionState` was `allRequired.every(answered) ? awaiting_confirmation
-- : interviewing`. Nothing else was consulted — so the moment the last required
-- answer landed, the interview was over as far as the router was concerned. It
-- sent the confirm recap, and because the router re-sends whatever the current
-- state implies after every agent write (0033), each further answer re-sent the
-- whole recap on top of whatever the interviewer was asking next.
--
-- The 2026-09-04 live run walked straight into it. The organizer was asked
-- about pace, then about the assistant's name, and both times the recap landed
-- before they could answer. Every optional question — dietary, pace, timezone,
-- existing bookings, the assistant's name and tone, and `planning_help` added
-- that same morning — sat behind that wall, and `planning_help` was never asked
-- at all. Tapping "Keep planning" did not help: it printed a sentence and left
-- the state exactly where it was.
--
-- So the state needs a third meaning that the three-value `state` column cannot
-- express: "every required question is answered, and we are still collecting
-- optional ones". Rather than widen that CHECK constraint — `state` is read by
-- the planner, the correction path and the release pipeline, and each of them
-- understands exactly three values — the extra intent lives here, and
-- `deriveSessionState` combines the two.
--
-- SHAPE
--
--   { "finish_requested": true,            -- organizer tapped "that's everything"
--     "skipped": ["trip_pace", "dietary"] } -- optional questions declined
--
-- Both keys are optional and absent means false/empty, so an interview created
-- before this migration behaves exactly as it did: no skips, no finish request,
-- and with no optional questions left the state derives to
-- awaiting_confirmation the same way it always did.
--
-- Deliberately NOT a set of columns: these are UI intent, read only by the
-- router when deciding what to ask next. Nothing downstream — no plan, no
-- transformer, no intake version — reads them, and a JSONB blob keeps that
-- boundary visible rather than growing a column per button.

ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS ui_state jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The router's own question-ordering read: "is there an optional question this
-- organizer has not answered and has not skipped?" runs on every prompt.
COMMENT ON COLUMN control_plane.intake_sessions.ui_state IS
  'Router UI intent: {finish_requested, skipped[]}. Never read downstream of the interview.';
