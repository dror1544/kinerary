-- Sprint 1 follow-up: replace UNIQUE(user_id) on signup_approval_requests with
-- two partial unique indexes.
--
-- The original constraint forced the re-request path to DELETE the old row so
-- a new one could be inserted.  But notification_outbox.signup_request_id holds
-- a plain FK reference to every request row — no CASCADE — so any DELETE that
-- has a child outbox row raises a FK violation.
--
-- Partial indexes enforce the same "one active request per user" invariant
-- without blocking history rows:
--
--   one_pending_per_user  — at most one 'pending' row per user; transitioning
--                           to 'expired'/'rejected' frees the slot for the next
--                           attempt without touching old rows.
--
--   one_approved_per_user — at most one 'approved' row per user; a user who has
--                           a draft trip can't open a second approval gate.
--
-- Rejected and expired rows are retained indefinitely for audit and for the
-- rate-limit cooldown check (which reads decided_at on the most recent rejection).

ALTER TABLE control_plane.signup_approval_requests
  DROP CONSTRAINT signup_approval_requests_user_id_key;

CREATE UNIQUE INDEX signup_approval_requests_one_pending_per_user
  ON control_plane.signup_approval_requests(user_id)
  WHERE state = 'pending';

CREATE UNIQUE INDEX signup_approval_requests_one_approved_per_user
  ON control_plane.signup_approval_requests(user_id)
  WHERE state = 'approved';
