-- rollback: compatible — one new table that only this release reads or writes; the previous release ignores it, and a rollback leaves its rows inert (no pending request is ever acted on without this release's handler)
--
-- ONE ORGANIZER, ONE TELEGRAM (#519, owner decision 2026-11-06).
--
-- An interview link is a bearer token: whoever opened it in Telegram became an
-- organizer of the trip, whatever Telegram account the organizer already used.
-- This release refuses (or asks) when the account that opens the link is not the
-- one the organizer's account is bound to (organizer-trips.ts `organizerBindingVerdict`).
--
-- "Asks" needs a place to keep the question. Nothing existing fits:
--   signup_approval_requests   is one request per SIGNUP, decided by the operator
--                              through a signed action token; it has no trip,
--                              no enrollment and no second Telegram account.
--   telegram_callback_refs     only shortens a callback_data; it holds no state.
-- So: one row per (interview link, Telegram account that opened it).
--
--   pending     T0 (the bound account) has been asked and has not answered. At most one per
--               enrollment, so a link opened by many accounts never puts more than one question
--               in front of the organizer at a time.
--   approved    T0 tapped Approve (or typed it): T1 became the organizer for this trip.
--   declined    T0 said no. The same account opening the same link again is not asked again.
--   refused     the interview had already started, so there was nothing to approve: T1 was
--               refused and T0 told once. A repeat from the same account is refused silently.
--   expired     the link expired before T0 answered (written when a late answer finds it).
--
-- The raw Telegram ids are stored because the bot has to WRITE to both chats later (the
-- organizer link rows keep only a digest). They are the same ids the interview already stores
-- (intake_sessions.telegram_chat_id). Names are display data only, from the verified update.
--
-- ON DELETE CASCADE throughout: this is a record about a link, a trip and an account, and
-- must not stop an operator clearing any of them (trip-clear.ts, teardown).

CREATE TABLE IF NOT EXISTS control_plane.organizer_link_requests (
  id                    text        NOT NULL,
  enrollment_id         text        NOT NULL REFERENCES control_plane.interview_enrollments(id) ON DELETE CASCADE,
  trip_id               text        NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  user_id               text        NOT NULL REFERENCES control_plane.users(id) ON DELETE CASCADE,
  -- Who opened the link: the update's verified sender.
  requester_digest      text        NOT NULL,
  requester_chat_id     text        NOT NULL,
  requester_first_name  text,
  requester_username    text,
  requester_language    text,
  -- Who is asked: the bound Telegram account, and the chat that reaches it. NULL when the
  -- bound account could not be reached (no chat id on record): fail closed, nobody is asked.
  approver_digest       text,
  approver_chat_id      text,
  state                 text        NOT NULL DEFAULT 'pending',
  created_at            timestamptz NOT NULL DEFAULT now(),
  decided_at            timestamptz,

  CONSTRAINT organizer_link_requests_pkey PRIMARY KEY (id),
  CONSTRAINT organizer_link_requests_id_is_opaque CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT organizer_link_requests_requester_digest_shape CHECK (requester_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT organizer_link_requests_approver_digest_shape CHECK (approver_digest IS NULL OR approver_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT organizer_link_requests_requester_chat_shape CHECK (requester_chat_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT organizer_link_requests_approver_chat_shape CHECK (approver_chat_id IS NULL OR approver_chat_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT organizer_link_requests_state_check CHECK (state IN ('pending', 'approved', 'declined', 'refused', 'expired')),
  -- A question nobody can be asked is not a pending question.
  CONSTRAINT organizer_link_requests_pending_has_approver CHECK (state <> 'pending' OR (approver_digest IS NOT NULL AND approver_chat_id IS NOT NULL)),
  CONSTRAINT organizer_link_requests_name_shape_check
    CHECK ((requester_first_name IS NULL OR (char_length(requester_first_name) BETWEEN 1 AND 40 AND position('@' in requester_first_name) = 0))
           AND (requester_username IS NULL OR requester_username ~ '^[A-Za-z0-9_]{1,32}$'))
);

-- One row per (link, Telegram account that opened it): a retry finds its own row instead of making another.
CREATE UNIQUE INDEX IF NOT EXISTS organizer_link_requests_once_idx
  ON control_plane.organizer_link_requests (enrollment_id, requester_digest);
-- At most one open question per link.
CREATE UNIQUE INDEX IF NOT EXISTS organizer_link_requests_one_pending_idx
  ON control_plane.organizer_link_requests (enrollment_id) WHERE state = 'pending';
-- The typed "approve" / "decline": the pending questions waiting on one chat.
CREATE INDEX IF NOT EXISTS organizer_link_requests_approver_idx
  ON control_plane.organizer_link_requests (approver_chat_id) WHERE state = 'pending';
