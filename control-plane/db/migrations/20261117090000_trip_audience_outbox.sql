-- rollback: compatible — one new table and three nullable columns; the prior dispatcher marks a targeted row skipped (unknown type) and never sends it
-- Video Release 1C (docs/specs/sprint-9/x-video-r1-group-line.md): ONE LINE TO THE TRIP'S GROUP WHEN THE PLAN CHANGES.
--
-- Until now the outbox sent only to a chat id the enqueuer wrote into `recipient`, and the dispatcher sent to it as
-- given. Nothing re-checked, at send time, that the chat still belongs to the trip, and nothing could say "this trip's
-- group" without a caller naming a chat. This adds the two things a message to a trip's audience needs:
--
-- 1. notification_outbox.target / binding_id / dedupe_key.
--    * target       'trip_group' | 'trip_organizer': WHO the row is for, as a role of the trip, not a chat id.
--                   A targeted row has NO recipient (the CHECK below) and a trip: the chat is resolved from the trip's
--                   own open telegram_chat_bindings row, and re-read at the moment of sending. No caller passes a chat in.
--    * binding_id   the telegram_chat_bindings row the row was addressed to when it was enqueued. The dispatcher
--                   re-reads THAT row at send time and requires it open and on the row's own trip.
--    * dedupe_key   makes an enqueue idempotent: a second enqueue with the same key is a no-op. It stops a duplicate
--                   ENQUEUE, not a resend after a crash between the send and the state update (the dispatcher is
--                   at-least-once, as it always was). One row is written per audience binding, so the stored key is
--                   '<caller key>#<binding id>'; the partial unique index is over what is stored.
--    Every existing row has all three NULL and keeps today's path untouched.
--
-- 2. plan_change_cursors: one row per trip the group-line poller has seen. It holds NO plan text: the trip site is
--    the source and is asked again on every poll. `revision_id` is the plan the group last heard about (or the one
--    first seen, so a switch turned on never replays a trip's history); `pending_since` is when an unsent change was
--    first seen (the 15-minute cap); `held_for_night` says a change is waiting for 08:00 trip time.
--
-- WHAT THIS DOES NOT DO: it sends nothing and changes no existing row. The feature is off for every trip until an
-- operator turns the switch `plan_change_group_line` on. A prior API reading a targeted row finds an unknown
-- notification_type and marks it skipped; it never sends it and never reads `recipient` for it.

ALTER TABLE control_plane.notification_outbox
  ADD COLUMN target     text,
  ADD COLUMN binding_id text REFERENCES control_plane.telegram_chat_bindings(id),
  ADD COLUMN dedupe_key text;

ALTER TABLE control_plane.notification_outbox
  ADD CONSTRAINT notification_outbox_target_check
    CHECK (target IS NULL OR target IN ('trip_group', 'trip_organizer')),
  -- A targeted row is addressed to a role of a trip: never to a chat id, and never to no trip.
  ADD CONSTRAINT notification_outbox_target_no_recipient_check
    CHECK (target IS NULL OR (recipient IS NULL AND trip_id IS NOT NULL)),
  ADD CONSTRAINT notification_outbox_dedupe_key_check
    CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 300);

CREATE UNIQUE INDEX notification_outbox_dedupe_key_idx
  ON control_plane.notification_outbox (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE control_plane.plan_change_cursors (
  trip_id        text PRIMARY KEY REFERENCES control_plane.trips(id),
  revision_id    text NOT NULL CHECK (char_length(revision_id) BETWEEN 1 AND 100),
  pending_since  timestamptz,
  held_for_night boolean NOT NULL DEFAULT false,
  last_polled_at timestamptz,
  last_sent_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
