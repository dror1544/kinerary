-- Records that the router has forwarded an interview turn for a chat to the
-- interviewer agent, and for how long that forward stays open.
--
-- WHY THIS EXISTS
--
-- 0028 lets the router resolve "which interview is this chat conducting?"
-- from the chat id alone, and submitAnswerForChat writes an answer using that
-- chat id as the locator. That covers every answer the ROUTER itself produces
-- — a tapped button carries only which option was chosen, and the router read
-- the chat id off the Telegram update it fetched over its own authenticated
-- call.
--
-- It does not cover a WRITTEN answer. `destination` is free text that needs
-- judgement ("Vienna and Prague" is a multi-destination trip, not a city), so
-- the text is forwarded to the interviewer agent, which resolves it and writes
-- the structured result back. The agent reaches the interview over MCP, and
-- the session it must write to was created by the ROUTER from a /start
-- <enrollment_token> deep link — not by the agent calling start_interview — so
-- the agent holds no session token for it.
--
-- The wire contract offers no way to hand the agent a per-turn secret: the
-- gateway->connector op set is send/edit/typing/get_chat_info, the message
-- event carries no free-form context slot, and the MCP connection is one
-- static endpoint shared by every chat the interviewer serves.
--
-- So the agent names the chat it is acting for, and this table is what that
-- name is checked against. A chat-addressed write is accepted only while a
-- row here says the router forwarded that chat's turn and the window has not
-- expired. The router opens the row at the moment it forwards; nothing an
-- agent says opens one.
--
-- FUTURE: replace the agent-supplied chat id with gateway-injected trusted
-- context, once the relay contract can carry it. This table becomes
-- unnecessary at that point — the identity would arrive with the turn instead
-- of being asserted and checked.

CREATE TABLE control_plane.interview_agent_turns (
  id         text        PRIMARY KEY,
  chat_id    text        NOT NULL,
  -- The session the router resolved for this chat when it forwarded. Pinning
  -- it here means a write lands in the interview that was actually in flight:
  -- if the session ends between forward and write, the turn no longer matches
  -- and the write is refused rather than landing in whatever session the chat
  -- holds by then.
  session_id text        NOT NULL REFERENCES control_plane.intake_sessions (id) ON DELETE CASCADE,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  -- Bounded on purpose. An abandoned turn stops being usable on its own,
  -- without anything having to notice that it was abandoned.
  expires_at timestamptz NOT NULL,
  closed_at  timestamptz,

  CONSTRAINT interview_agent_turns_id_format
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT interview_agent_turns_window
    CHECK (expires_at > opened_at)
);

-- At most one turn open per chat, expressed the way 0028 and 0029 express
-- "the one in force" — a partial unique index over the rows that are still
-- current, rather than a key over everything the table has ever held. A second
-- forward for a chat closes the first; it does not open a rival row.
CREATE UNIQUE INDEX interview_agent_turns_open_chat_idx
  ON control_plane.interview_agent_turns (chat_id)
  WHERE closed_at IS NULL;

-- READERS MUST FILTER on both closed_at IS NULL and expires_at > now().
-- Neither alone is the open set: a turn the router superseded is closed but
-- may not have expired, and an abandoned one is expired but never closed.
CREATE INDEX interview_agent_turns_lookup_idx
  ON control_plane.interview_agent_turns (chat_id, expires_at)
  WHERE closed_at IS NULL;
