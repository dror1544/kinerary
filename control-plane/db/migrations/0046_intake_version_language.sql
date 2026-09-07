-- The language the interview was held in, carried on the immutable intake
-- version rather than only on the session.
--
-- `intake_sessions.language` already records it, correctly — the interviewer
-- reports it with set_interview_language_for_chat once it can tell. But a
-- session is transient: it is deleted on reset and superseded on correction,
-- while the transformer works from the intake VERSION, which is immutable and
-- outlives it. So the one place that knew the answer was not the place that
-- needed it.
--
-- The cost of that gap, live on 2026-09-07: an interview conducted entirely in
-- Hebrew produced a trip with defaultLang 'en', and the companion greeted the
-- organizer and the family in English — with a Hebrew assistant name embedded
-- in the English sentence.
--
-- Nullable, and absent means English. Every version written before this column
-- existed has none, and must keep transforming exactly as it did.
ALTER TABLE control_plane.intake_versions
  ADD COLUMN IF NOT EXISTS language text;

ALTER TABLE control_plane.intake_versions
  DROP CONSTRAINT IF EXISTS intake_versions_language_check;

-- Constrained rather than free text: this value picks which strings the site
-- and the companion render, so an unrecognised code is not a variant, it is a
-- trip nobody can read. The transformer ALSO falls back, because a constraint
-- added today cannot vouch for a value that arrives some other way tomorrow.
ALTER TABLE control_plane.intake_versions
  ADD CONSTRAINT intake_versions_language_check
  CHECK (language IS NULL OR language IN ('en', 'he'));

COMMENT ON COLUMN control_plane.intake_versions.language IS
  'Language the interview was conducted in, from intake_sessions.language at confirm time. NULL means English.';
