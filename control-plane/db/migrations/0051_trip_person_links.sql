-- Who a Telegram sender IS on a trip — the fact provisioning had and threw away.
--
-- Routing was always captured. `telegram_chat_bindings` answers "which
-- companion serves this chat", and it is written at provisioning from the
-- organizer's own interview chat, which is why their DM reaches their
-- assistant at all. But that table has four columns — chat, trip, profile,
-- closed — and none of them is a person. The group's row has the same shape as
-- the organizer's, and the only thing separating them is Telegram's convention
-- that a group id is negative.
--
-- So a companion could route perfectly and still not know it was talking to
-- the organizer. It inferred that from the chat TYPE: a private chat is bound
-- only if the interview happened in it, so "private" stood in for "the
-- organizer". That inference holds exactly until someone speaks in the group,
-- where every message is anonymous and the only name attached to it is the
-- Telegram display name — which the sender sets themselves, and which is
-- therefore not identity at all.
--
-- Both halves of the missing join were in hand in the same transaction:
-- `_resolve_organizers` had already matched the organizer_identity answer to a
-- participant ("ניר סולומון" -> `nirsolomon`, which is what writes
-- agent.organizers), and the provisioner had the chat id it was about to bind.
-- Nothing joined them, so `participants[].telegram_id` on the site stayed NULL
-- on every trip ever provisioned, and `set_telegram_group` — which refuses
-- until a Telegram-bound organizer exists — could never be used.
--
-- WHY NOT telegram_organizer_links (0050, feat/trip-bot-trip-commands). That
-- table answers "which control-plane users does this Telegram person own",
-- for /trips and /switch. Its subject is a user_id and it deliberately stores
-- only a digest, because scoping a trip list is all it ever does. This one's
-- subject is a PARTICIPANT — a person on a trip, with a name to call them by —
-- and it is read on every inbound message to decide whose voice this is. Two
-- questions, two tables; merging them would give each the other's constraints.
--
-- WHY THE RAW ID. `telegram_chat_bindings.chat_id` already holds this exact
-- number: a private chat's id IS the user's id, and that row is written from
-- the same fact a line earlier. Digesting it here would protect nothing that
-- is not already sitting in the table next door, and would cost the router a
-- hash on every update for the privilege.
--
-- NOT A CREDENTIAL. Nothing here authenticates anyone. A row says "the sender
-- with this Telegram id is ניר on this trip" — the same claim Telegram's own
-- connection makes about who sent an update, joined to a name. Writes come
-- only from facts the control plane established itself; a sender cannot type
-- anything that reaches this table.
CREATE TABLE IF NOT EXISTS control_plane.trip_person_links (
  id                text PRIMARY KEY,
  trip_id           text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  -- The sender, as Telegram identifies them on every update. Private-chat
  -- shape only: a group id is not a person, and the writer enforces it.
  telegram_user_id  text NOT NULL,
  -- The site's own username for them — `nirsolomon`. The join key to the
  -- trip: participants, plan authorship, and `agent.organizers` all speak it.
  participant_username text NOT NULL,
  -- What to CALL them, in the trip's language. The router stamps this over the
  -- Telegram display name, so the assistant hears "ניר סולומון" rather than
  -- whatever the sender has set as their Telegram name this week.
  display_name      text,
  -- 'organizer' | 'participant'. Only the organizer is written today; the
  -- column exists because the next writer is a family member binding
  -- themselves, and a role read off a hardcoded assumption is how the DM
  -- inference got here in the first place.
  role              text NOT NULL,
  -- How we know. One value today; named rather than implied so a later
  -- self-service binding cannot be mistaken for one the control plane
  -- established.
  verified_via      text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_person_links_role_check
    CHECK (role IN ('organizer', 'participant')),
  CONSTRAINT trip_person_links_verified_via_check
    CHECK (verified_via IN ('interview_chat')),
  -- Private-chat shape, enforced in the schema as well as the writer: the
  -- same rule interview.ts applies before it records a chat id as a person's.
  CONSTRAINT trip_person_links_private_chat_shape
    CHECK (telegram_user_id ~ '^[0-9]{1,20}$')
);

-- One person per Telegram id per trip. A re-provision of the same trip is the
-- normal case, so the writer upserts against this rather than reading first.
CREATE UNIQUE INDEX IF NOT EXISTS trip_person_links_trip_sender_idx
  ON control_plane.trip_person_links (trip_id, telegram_user_id);

-- The read path: one lookup per inbound message, by the trip the chat is
-- already routed to and the sender the update carries.
CREATE INDEX IF NOT EXISTS trip_person_links_sender_idx
  ON control_plane.trip_person_links (telegram_user_id);
