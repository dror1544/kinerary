-- rollback: compatible — adds a DEFAULTed boolean to trips and two nullable columns to telegram_chat_bindings; every existing row stays valid and the prior version ignores all three
-- Lets the assistant's OWN question in a group chat open the addressing gate
-- for exactly one message, the same way an @mention/name-match/reply-to does
-- today (addressing.ts's isAddressedToAssistant). Without this, a family
-- answering the bot's question in the natural way — just typing a reply,
-- with no @mention, no wake-word, no tap-to-reply — is silently dropped as
-- NOT_ADDRESSED, which breaks the conversational flow the question created.
--
-- Scope decided deliberately narrow: anyone's next message counts (not just
-- whoever prompted the question — a group-wide question has no single
-- "right" answerer to scope to anyway), the window is short (a couple of
-- minutes), and consumption is blind — the very next message is treated as
-- the reply with no check that it's actually related. That is a real
-- false-capture risk on a chatty group, which is what the opt-out below is
-- for.

-- Per-trip opt-out. Default true (this ships on, not off) so every existing
-- trip gains the capability rather than silently losing it. Read
-- server-side only in chat-router.ts's addressing path, same discipline as
-- assistant_names (0030) on this table — no endpoint selects it, and none
-- may start.
ALTER TABLE control_plane.trips
  ADD COLUMN IF NOT EXISTS companion_reply_capture_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN control_plane.trips.companion_reply_capture_enabled IS
  'Per-trip opt-out for the group-chat reply-capture gate (migration 0053). Read server-side only; no endpoint may serve it raw.';

-- The capture window itself, per open companion binding. NULL means "no open
-- window" — the overwhelmingly common case. A timestamp rather than a
-- boolean for the reason 0033's router_prompt_due_at is one: claiming is an
-- UPDATE ... RETURNING that clears it, so the column doubles as evidence of
-- when the window opened and a crash between open and consume just lets it
-- lapse rather than wedging anything open. Same store-a-timestamp,
-- compare-at-read-time shape as intake_sessions' awaiting_since /
-- awaiting_floor_seconds (0038/0040) — lazy expiry, no sweep job needed; a
-- stale value is already inert everywhere it's read.
--
-- READERS MUST FILTER on closed_at IS NULL, same as every other column on
-- this table (0029) — an open window on a closed binding must never resolve.
ALTER TABLE control_plane.telegram_chat_bindings
  ADD COLUMN IF NOT EXISTS awaiting_reply_since timestamptz,
  ADD COLUMN IF NOT EXISTS awaiting_reply_floor_seconds integer;

COMMENT ON COLUMN control_plane.telegram_chat_bindings.awaiting_reply_since IS
  'Set when the assistant''s last companion send expects a reply; cleared the moment any message consumes it, or lazily ignored once older than awaiting_reply_floor_seconds. NULL = no open window.';
