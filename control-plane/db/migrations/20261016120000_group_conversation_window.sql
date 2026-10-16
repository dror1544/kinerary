-- rollback: compatible — adds two nullable columns to telegram_chat_bindings and widens assistant_events.trigger_type's closed set by one value; every existing row stays valid, and the prior version ignores the columns and never writes the new trigger value
-- A conversation window for the companion in a family group: the members it is
-- talking with are heard without its name.
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
-- minutes after the companion's last send. Many may join: any member whose
-- message is forwarded to the companion, by whatever route, joins the chat's
-- conversation and nobody is displaced - they all share the chat's one
-- deadline. A member who is not in it still has to address the companion. The
-- 0053 "?" window for anyone is untouched.
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
  ADD COLUMN IF NOT EXISTS conversation_user_ids text[],
  ADD COLUMN IF NOT EXISTS conversation_until timestamptz;

COMMENT ON COLUMN control_plane.telegram_chat_bindings.conversation_user_ids IS
  'Telegram user ids of the members the companion is currently in conversation with in this group (each had a message forwarded to it), oldest first, bounded by the writer. Meaningful only while conversation_until is in the future: an expired set reads as empty and the next forward starts a fresh one. Read server-side only.';
COMMENT ON COLUMN control_plane.telegram_chat_bindings.conversation_until IS
  'When the conversation window closes for every member in conversation_user_ids: extended to now() + the window length each time a member''s message is forwarded and renewed each time the companion''s send succeeds. NULL or past = no open window.';

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
