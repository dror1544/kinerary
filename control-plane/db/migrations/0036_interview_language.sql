-- The language the interview is being conducted in.
--
-- WHY THIS EXISTS
--
-- The interview has two speakers. The agent speaks whatever the organizer
-- writes; the router draws every button, question and recap, and had no idea
-- what language that was — so it drew them in English, always. A Hebrew
-- interview alternated languages message by message, and the confirmation
-- screen — the one place a person is asked to approve something immutable —
-- was English in a Hebrew conversation.
--
-- It is a column rather than another key in `ui_state` because it is not UI
-- intent: it is a fact about the conversation, set once from what the
-- organizer actually wrote, and the transformer may later want it to decide
-- what language the trip SITE is built in. `ui_state` stays the bag of
-- router-only bookkeeping.
--
-- NULL means "not established yet", which is different from English: the
-- router falls back to English to draw something, but a null here says the
-- agent has not yet reported what the organizer is writing, and it is
-- expected to. There is no default for that reason.
--
-- The CHECK is a shape, not a whitelist: two to eight lowercase letters,
-- hyphens allowed ('en', 'he', 'pt-br'). Which languages the router can
-- actually draw is a code question (`intake-copy.ts`), and an unrenderable
-- value degrades to English rather than being rejected at the database.

ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS language text
    CONSTRAINT intake_sessions_language_shape
    CHECK (language IS NULL OR language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$');

COMMENT ON COLUMN control_plane.intake_sessions.language IS
  'Language the interview is conducted in, set by the interviewer from what the organizer writes. NULL = not yet established.';
