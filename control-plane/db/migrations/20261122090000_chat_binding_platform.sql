-- rollback: compatible — additive columns with defaults and one new table; the previous release never routes a WhatsApp-shaped row (its fleet monitor would mislabel one as a private chat, which a rollback note covers)
--
-- ROLLBACK NOTE (the verdict above stands: the schema is additive and a code-only rollback keeps this database). Rolling back
-- to a release OLDER than this one has three catches, all about WHATSAPP ROWS THAT ALREADY EXIST:
--   1. An older `scripts/teardown-trip.py` closes a trip's bindings without clearing `transport_address`, and this file's CHECK
--      refuses a closed row that still holds one: its transaction fails (23514) for a trip with an open WhatsApp binding.
--   2. An older gateway reconciler does not count a WhatsApp-only owner as current, so that trip's companion would stop.
--   3. An older config schema is strict and refuses a profile that carries a `relay.whatsapp` block.
-- So BEFORE rolling back past this release: remove any `relay.whatsapp` block from the profile, and close every WhatsApp binding
-- with its address cleared, in ONE statement (the CHECK needs both in the same UPDATE):
--     UPDATE control_plane.telegram_chat_bindings
--        SET closed_at = now(), closed_reason = 'rolled_back', transport_address = NULL, phone_last4 = NULL
--      WHERE platform = 'whatsapp' AND closed_at IS NULL;
-- (the person links and unused codes may stay: the older release reads a person link only by a numeric Telegram id, so a
-- `wa_` link matches none of its lookups, and its fleet monitor only counts links by role; it has no code table reader.)
--
-- LOCK HAZARD. The ALTERs below take ACCESS EXCLUSIVE locks on `telegram_chat_bindings` and `trip_person_links` while the old
-- API and relay are still serving, and production has `lock_timeout = 0`: a session idle in a transaction on either table would
-- stall this file, and every chat lookup after it would queue behind the stalled ALTER. `applyMigrations` runs each file in one
-- transaction, so the SET LOCAL below is effective and scoped to it: the migration FAILS after 5 seconds (55P03, everything in
-- the file rolled back, nothing half applied) instead of waiting forever, and is simply run again. No other migration in this
-- repository sets a lock or statement timeout, so none is added for statements.
--
-- WHATSAPP, SLICE S2 (docs/specs/sprint-9/625-whatsapp-via-relay.md, "Migration, S2"): the binding table and the
-- person-link table learn which platform a chat is on, and one new table holds the one-time codes that bind a WhatsApp
-- chat from the dashboard.
--
-- NOTHING IS RENAMED. `telegram_chat_bindings` keeps its name, its columns, its primary key and its partial unique index
-- `telegram_chat_bindings_active_chat_idx` (group-binding.ts matches that name). A rename would break the fleet monitor's
-- column grants (deployment/monitor-db-role.sql), about forty readers in four languages, and the `compatible` header.
--
-- THE CHAT ID NEVER HOLDS A PHONE NUMBER. Every WhatsApp chat id is an ALIAS built from a keyed hash: a private chat is
-- `wa_<32 hex>@p` (the person's opaque id plus `@p`), a group is `wa_<32 hex>@g` (a hash of the group's real id plus
-- `@g`). A group's real id is not stored in `chat_id`, old or new: an old group's id is `<creator's number>-<creation
-- time>@g.us` (owner's decision 2026-11-23: old groups are supported, so they are behind an alias too). The three shapes
-- (Telegram digits, with an optional minus; the group alias; the private alias) cannot overlap, so one unique index over
-- open `chat_id`s still means "one open binding per chat" across platforms, and a chat id alone selects its row without
-- anyone passing a platform in.
--
-- THE REAL ADDRESS rests in `transport_address`, on EVERY open WhatsApp binding, group or private, because the relay needs
-- it to send (for an old group it contains its creator's number). The database REQUIRES it on an open WhatsApp row and
-- refuses it anywhere else and on every closed row, and the monitor's role is not granted it (a test pins that).
--
-- THE PREVIOUS RELEASE keeps running on this schema: every column below is added with a default or as nullable, every
-- writer that names no platform gets 'telegram', and the CHECKs refuse such a writer a WhatsApp id instead of letting a
-- re-inserted row turn one into a Telegram row.

SET LOCAL lock_timeout = '5s';

-- ── telegram_chat_bindings ──────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE control_plane.telegram_chat_bindings
  ADD COLUMN platform          text NOT NULL DEFAULT 'telegram',
  ADD COLUMN transport_address text,
  ADD COLUMN chat_title        text,
  -- AC-16: the last four digits of the person's phone number, shown to the owner so they can tell their own phone from
  -- a stranger's. OPTIONAL: a person's WhatsApp id is normally a linked-identity (LID) address, not a phone number, so
  -- `transport_address` is an opaque string and nothing is parsed out of it. The relay passes this in at binding time
  -- when the bridge reported a phone number, and it is NULL otherwise. Only on an open WhatsApp PRIVATE binding.
  ADD COLUMN phone_last4       text;

ALTER TABLE control_plane.telegram_chat_bindings
  ADD CONSTRAINT telegram_chat_bindings_platform_ck
    CHECK (platform IN ('telegram', 'whatsapp')),
  -- Each platform's chat ids have their own shape. The second branch also stops a legacy writer that re-inserts a row
  -- without a platform from turning a WhatsApp id into a Telegram row.
  ADD CONSTRAINT telegram_chat_bindings_platform_chat_shape_ck
    CHECK (
      (platform = 'whatsapp' AND (chat_id ~ '^wa_[0-9a-f]{32}@g$' OR chat_id ~ '^wa_[0-9a-f]{32}@p$'))
      OR (platform = 'telegram' AND chat_id !~ '@')
    ),
  -- The real address is set on every OPEN WhatsApp binding and nowhere else: NULL on a Telegram row and on every closed
  -- row, and required on an open WhatsApp row (the relay could not send without it).
  ADD CONSTRAINT telegram_chat_bindings_transport_address_ck
    CHECK (
      (transport_address IS NOT NULL) = (platform = 'whatsapp' AND closed_at IS NULL)
      AND (transport_address IS NULL OR char_length(transport_address) BETWEEN 1 AND 256)
    ),
  ADD CONSTRAINT telegram_chat_bindings_phone_last4_ck
    CHECK (
      phone_last4 IS NULL
      OR (platform = 'whatsapp' AND chat_id ~ '^wa_[0-9a-f]{32}@p$' AND closed_at IS NULL AND phone_last4 ~ '^[0-9]{4}$')
    ),
  ADD CONSTRAINT telegram_chat_bindings_chat_title_ck
    CHECK (chat_title IS NULL OR char_length(chat_title) BETWEEN 1 AND 256);

-- ── trip_person_links ───────────────────────────────────────────────────────────────────────────────────────────────

-- On a WhatsApp row `telegram_user_id` (the column keeps its name) holds the opaque sender id `wa_<32 hex>`, and
-- `participant_username` may be NULL: an owner connecting their own WhatsApp usually has no traveller on the trip.
ALTER TABLE control_plane.trip_person_links
  ADD COLUMN platform        text NOT NULL DEFAULT 'telegram',
  ADD COLUMN account_user_id text REFERENCES control_plane.users(id);

ALTER TABLE control_plane.trip_person_links
  ALTER COLUMN participant_username DROP NOT NULL;

ALTER TABLE control_plane.trip_person_links
  DROP CONSTRAINT IF EXISTS trip_person_links_private_chat_shape,
  DROP CONSTRAINT IF EXISTS trip_person_links_role_check,
  DROP CONSTRAINT IF EXISTS trip_person_links_verified_via_check;

ALTER TABLE control_plane.trip_person_links
  ADD CONSTRAINT trip_person_links_platform_ck
    CHECK (platform IN ('telegram', 'whatsapp')),
  -- The old private-chat shape, per platform.
  ADD CONSTRAINT trip_person_links_private_chat_shape
    CHECK (
      (platform = 'telegram' AND telegram_user_id ~ '^[0-9]{1,20}$')
      OR (platform = 'whatsapp' AND telegram_user_id ~ '^wa_[0-9a-f]{32}$')
    ),
  ADD CONSTRAINT trip_person_links_role_check
    CHECK (role IN ('organizer', 'participant')),
  -- A WhatsApp link's stored role is ALWAYS 'participant' and is never read: the role is derived from the account's
  -- membership at the moment it is asked for (chat-binding-codes.ts, resolveWhatsAppPerson).
  ADD CONSTRAINT trip_person_links_whatsapp_role_ck
    CHECK (platform <> 'whatsapp' OR role = 'participant'),
  ADD CONSTRAINT trip_person_links_verified_via_check
    CHECK (
      (platform = 'telegram' AND verified_via = 'interview_chat')
      OR (platform = 'whatsapp' AND verified_via IN ('dashboard_code', 'group_membership'))
    ),
  -- A Telegram person always has a traveller name; only a WhatsApp link may have none.
  ADD CONSTRAINT trip_person_links_participant_username_ck
    CHECK (platform = 'whatsapp' OR participant_username IS NOT NULL);

-- One account has one WhatsApp number per trip, and one traveller has one WhatsApp claim per trip.
CREATE UNIQUE INDEX trip_person_links_wa_account_idx
  ON control_plane.trip_person_links (trip_id, account_user_id)
  WHERE platform = 'whatsapp' AND account_user_id IS NOT NULL;
CREATE UNIQUE INDEX trip_person_links_wa_traveller_idx
  ON control_plane.trip_person_links (trip_id, participant_username)
  WHERE platform = 'whatsapp' AND participant_username IS NOT NULL;

-- ── chat_binding_codes ──────────────────────────────────────────────────────────────────────────────────────────────

-- A one-time, short-lived code minted in a dashboard session and sent as a chat message from the chat it binds. Stored
-- only as a digest. Platform-neutral by name; only 'whatsapp' rows are written in this slice. Several codes may be live
-- for one trip (no one-per-trip index): the writer caps them at ten and expires the oldest.
CREATE TABLE control_plane.chat_binding_codes (
  id                 text        PRIMARY KEY,
  trip_id            text        NOT NULL REFERENCES control_plane.trips(id),
  platform           text        NOT NULL,
  -- 'me': binds the sender's private chat as the issuing account. 'group': binds the group it is sent in.
  kind               text        NOT NULL,
  issued_by_user_id  text        NOT NULL REFERENCES control_plane.users(id),
  code_digest        text        NOT NULL,
  state              text        NOT NULL DEFAULT 'issued',
  -- Set when redeemed: the binding the code opened (or, for a group that was already connected, the one it found).
  binding_id         text        REFERENCES control_plane.telegram_chat_bindings(id),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  redeemed_at        timestamptz,
  CONSTRAINT chat_binding_codes_id_is_opaque CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT chat_binding_codes_platform_ck CHECK (platform IN ('telegram', 'whatsapp')),
  CONSTRAINT chat_binding_codes_kind_ck CHECK (kind IN ('me', 'group')),
  CONSTRAINT chat_binding_codes_state_ck CHECK (state IN ('issued', 'redeemed', 'expired')),
  CONSTRAINT chat_binding_codes_digest_shape_ck CHECK (code_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chat_binding_codes_redeemed_ck CHECK ((state = 'redeemed') = (redeemed_at IS NOT NULL))
);

-- Redemption looks a code up by its digest among the codes still usable.
CREATE UNIQUE INDEX chat_binding_codes_digest_issued_idx
  ON control_plane.chat_binding_codes (code_digest)
  WHERE state = 'issued';

-- The cap per trip, teardown's expiry and the dashboard's count all read the trip's live codes.
CREATE INDEX chat_binding_codes_trip_idx
  ON control_plane.chat_binding_codes (trip_id, state, created_at);
