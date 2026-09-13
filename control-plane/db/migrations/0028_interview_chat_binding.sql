-- Binds a Telegram chat to the intake session it is conducting, so the Trip
-- Bot router can resolve an inbound message to "which interview is this?"
-- from the chat id ALONE — never from the message text, and never from a
-- value an LLM relayed as a tool argument.
--
-- This is the interview-time counterpart to 0019's telegram_chat_bindings
-- (which binds a chat to an already-provisioned trip's companion profile).
-- Together they are the router's whole routing table:
--
--     bound in telegram_chat_bindings  -> that trip's companion
--     active session on this chat      -> interviewer, this session
--     neither                          -> unbound; only /start <token> is
--                                        accepted (fail closed)
--
-- VERIFIED, unlike 0022's notification_chat_id_hint. That column is an
-- LLM-relayed hint precisely because the interviewer agent had no
-- server-verified way to learn its own chat id, and 0022's header explains
-- at length why such a value must never reach user_identities and become an
-- authentication fact. This column has the opposite provenance: the router
-- owns the Telegram connection itself, so the chat id here is read off the
-- update the router received from Telegram's API over its own authenticated
-- outbound call. No agent, message body, or tool argument can influence it.
-- That is what makes it safe to route on.
--
-- Written by the router when it exchanges a /start <enrollment_token> deep
-- link for a session (interview.ts startSession) — the same single-use,
-- expiring, owner-scoped enrollment that already gates the interview.
ALTER TABLE control_plane.intake_sessions
  ADD COLUMN telegram_chat_id text;

-- One LIVE interview per chat, but a chat may hold many CONFIRMED sessions
-- over time: an organizer who finishes one trip's interview must be able to
-- start a second trip from the same DM (Sprint 5's "re-enter interview mode
-- for a new trip" requirement) without a second bot or a second chat. So the
-- uniqueness is scoped to sessions that are still running.
CREATE UNIQUE INDEX intake_sessions_live_chat_idx
  ON control_plane.intake_sessions (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL AND state <> 'confirmed';

CREATE INDEX intake_sessions_chat_idx
  ON control_plane.intake_sessions (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;
