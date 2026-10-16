-- rollback: compatible — adds two nullable columns to telegram_chat_bindings and widens assistant_events.trigger_type's closed set by one value; every existing row stays valid, and the prior version ignores the columns and never writes the new trigger value
-- A per-person conversation window for the companion in a family group.
--
-- Until now an untagged group message reached the companion only if it named
-- the assistant, @mentioned the bot, replied to the bot's message, or was the
-- one message after a send that ended in "?" (0053). A running conversation
-- with one person therefore broke whenever the companion's last message was
-- not a question: on 2026-10-16 an organizer's six of nine follow-ups were
-- dropped as NOT_ADDRESSED and had to be re-sent with the assistant's name.
--
-- Owner's decision (2026-10-16): once the companion is talking with person S
-- in a group, S's own following messages reach it without its name, for five
-- minutes after the companion's last send. Only S - every other member still
-- has to address it; if one does, the conversation moves to them (one current
-- partner per chat). The 0053 "?" window for anyone is untouched.
--
-- Same store-a-timestamp, compare-at-read-time shape as 0053's
-- awaiting_reply_since: no sweep job, a stale value is inert everywhere it is
-- read. Unlike that window this one is NOT consumed by a hit - the hit's own
-- forward renews it. The per-trip opt-out 0053 added
-- (trips.companion_reply_capture_enabled) covers this window as well.
--
-- READERS AND WRITERS MUST FILTER on closed_at IS NULL, as for every column on
-- this table (0029).
ALTER TABLE control_plane.telegram_chat_bindings
  ADD COLUMN IF NOT EXISTS conversation_user_id text,
  ADD COLUMN IF NOT EXISTS conversation_until timestamptz;

COMMENT ON COLUMN control_plane.telegram_chat_bindings.conversation_user_id IS
  'Telegram user id of the one member the companion is currently in conversation with in this group (a message of theirs was forwarded to it, or it answered them). Meaningful only while conversation_until is in the future. Read server-side only.';
COMMENT ON COLUMN control_plane.telegram_chat_bindings.conversation_until IS
  'When the conversation window closes for conversation_user_id: renewed to now() + the window length each time that member''s message is forwarded and each time the companion''s send succeeds. NULL or past = no open window.';

-- Analytics: a message admitted only by this window is neither a mention, a
-- name, a reply-to-bot nor the one-shot reply window, and calling it any of
-- them would make the trigger mix lie about how people reach the assistant.
-- Nothing else on the table names trigger_type's value list (the per-type
-- CHECKs only test it for NULL), so the one constraint is all that changes.
ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_trigger_type_check,
  ADD CONSTRAINT assistant_events_trigger_type_check
    CHECK (trigger_type IN (
      'dm', 'mention', 'name', 'reply_to_bot', 'reply_window', 'conversation_window',
      'not_addressed', 'unclassified'
    ));
