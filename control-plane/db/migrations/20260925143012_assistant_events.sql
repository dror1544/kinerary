-- rollback: compatible — one new table and its indexes; nothing existing changes shape

-- Assistant events (#177, Track 2's first slice of the outcome-event pipeline).
--
-- One row per metadata-only fact the relay observes about a trip's
-- conversation: a group message the relevance gate did not address to the
-- assistant, a request handed to the assistant, a turn lost because nothing
-- could take it, a reply and whether Telegram accepted it, and the outcome of
-- the one tool the relay runs itself (reading an organizer's document after
-- confirmation). The contract is analytics/schemas/tripbot-event.v1.json;
-- control-plane/api/src/analytics/contract.ts mirrors it.
--
-- WHAT IS NOT HERE IS THE POINT. No column can hold message text, a caption, a
-- filename, a URL, a Telegram chat or user id, a digest of one (the unkeyed
-- sha256 in identity.ts is reversible by brute force and stable across trips),
-- a name, a tool argument or result, or a content fingerprint. Every value
-- column below is CHECKed against a closed set, each event type against its
-- own outcomes and required fields, and `metadata` may hold only three named
-- keys: two whole numbers 0..20 and a boolean. Adding a column is a
-- reviewed change: test/assistant-events-store.test.ts compares this table's
-- columns with a checked-in list and fails on any difference.
--
-- THE RELAY NEVER WRITES `answered`. It sees delivery, not tool results; design
-- doc §6.3 says `failed_tool` beats `answered`, so an emitter blind to tools
-- must not claim the task succeeded. The outcome set has no such value.
--
-- In this schema, not a separate one: the DB-backed test files reset the
-- database with DROP SCHEMA control_plane CASCADE, and a second schema would
-- survive every one of those resets. trip_id is ON DELETE SET NULL, as
-- funnel_events does, so deleting a trip never deletes or blocks on its history.
--
-- Written only when the relay is started with ASSISTANT_EVENTS_ENABLED=1.
-- Unset is OFF. Retention: purgeExpiredEvents (analytics/store.ts), 90 days by
-- default, is built but NOT scheduled — scheduling it is a precondition for
-- enabling this anywhere real.

CREATE TABLE IF NOT EXISTS control_plane.assistant_events (
  event_id              uuid PRIMARY KEY,
  trip_id               text REFERENCES control_plane.trips(id) ON DELETE SET NULL,
  occurred_at           timestamptz NOT NULL,
  source_service        text NOT NULL CHECK (source_service IN ('relay')),
  event_type            text NOT NULL CHECK (event_type IN (
    'ignored_not_addressed', 'request_forwarded', 'request_to_relay',
    'turn_lost', 'reply_sent', 'relay_tool_completed'
  )),
  turn_id               uuid,
  channel_type          text CHECK (channel_type IN ('group', 'organizer_dm', 'other', 'unclassified')),
  trigger_type          text CHECK (trigger_type IN (
    'dm', 'mention', 'name', 'reply_to_bot', 'reply_window', 'not_addressed', 'unclassified'
  )),
  requester_role        text CHECK (requester_role IN ('organizer', 'participant', 'unknown', 'unclassified')),
  outcome               text NOT NULL CHECK (outcome IN (
    'ignored_not_addressed', 'dispatched', 'lost_gateway_unavailable',
    'lost_companion_unreachable', 'reply_delivered', 'failed_delivery',
    'reply_suppressed', 'failed_tool', 'blocked_by_policy',
    'correction_proposed', 'no_new_information'
  )),
  response_latency_ms   integer CHECK (response_latency_ms BETWEEN 0 AND 86400000),
  message_length_bucket text CHECK (message_length_bucket IN ('none', '1_40', '41_160', '161_640', '641_plus')),
  media_kind            text CHECK (media_kind IN ('none', 'photo', 'document', 'audio', 'other', 'unclassified')),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The second line behind the contract (analytics/contract.ts), as strict as
  -- it is on everything a column can hold. CASE rather than AND/OR throughout:
  -- Postgres does not promise to evaluate AND left to right, and a cast
  -- reached out of order would raise a cast error instead of this check.

  -- metadata: three named keys; two whole numbers 0..20 and one boolean.
  CONSTRAINT assistant_events_metadata_allow_list CHECK (
    CASE
      WHEN jsonb_typeof(metadata) <> 'object' THEN false
      WHEN (metadata - ARRAY['attachments_joined', 'documents', 'document_held']) <> '{}'::jsonb THEN false
      WHEN metadata ? 'document_held' AND jsonb_typeof(metadata -> 'document_held') <> 'boolean' THEN false
      ELSE true
    END
  ),
  CONSTRAINT assistant_events_metadata_documents CHECK (
    CASE
      WHEN NOT metadata ? 'documents' THEN true
      WHEN jsonb_typeof(metadata -> 'documents') <> 'number' THEN false
      WHEN (metadata ->> 'documents') !~ '^[0-9]{1,2}$' THEN false
      ELSE (metadata ->> 'documents')::integer BETWEEN 0 AND 20
    END
  ),
  CONSTRAINT assistant_events_metadata_attachments_joined CHECK (
    CASE
      WHEN NOT metadata ? 'attachments_joined' THEN true
      WHEN jsonb_typeof(metadata -> 'attachments_joined') <> 'number' THEN false
      WHEN (metadata ->> 'attachments_joined') !~ '^[0-9]{1,2}$' THEN false
      ELSE (metadata ->> 'attachments_joined')::integer BETWEEN 0 AND 20
    END
  ),

  -- Each event type carries only its own outcomes (contract EVENT_RULES).
  CONSTRAINT assistant_events_outcome_for_type CHECK (
    CASE event_type
      WHEN 'ignored_not_addressed' THEN outcome = 'ignored_not_addressed'
      WHEN 'request_forwarded' THEN outcome = 'dispatched'
      WHEN 'request_to_relay' THEN outcome = 'dispatched'
      WHEN 'turn_lost' THEN outcome IN ('lost_gateway_unavailable', 'lost_companion_unreachable')
      WHEN 'reply_sent' THEN outcome IN ('reply_delivered', 'failed_delivery', 'reply_suppressed')
      WHEN 'relay_tool_completed' THEN outcome IN ('failed_tool', 'blocked_by_policy', 'correction_proposed', 'no_new_information')
      ELSE false
    END
  ),

  -- ...and every field the contract requires for it. EXCEPT trip_id: the
  -- contract requires it at write time, but a row must be able to outlive its
  -- trip (ON DELETE SET NULL), so the table cannot.
  CONSTRAINT assistant_events_required_for_type CHECK (
    CASE event_type
      WHEN 'ignored_not_addressed' THEN channel_type IS NOT NULL AND trigger_type IS NOT NULL
        AND requester_role IS NOT NULL AND message_length_bucket IS NOT NULL AND media_kind IS NOT NULL
      WHEN 'request_forwarded' THEN turn_id IS NOT NULL AND channel_type IS NOT NULL AND trigger_type IS NOT NULL
        AND requester_role IS NOT NULL AND message_length_bucket IS NOT NULL AND media_kind IS NOT NULL
      WHEN 'request_to_relay' THEN turn_id IS NOT NULL AND channel_type IS NOT NULL AND trigger_type IS NOT NULL
        AND requester_role IS NOT NULL AND message_length_bucket IS NOT NULL AND media_kind IS NOT NULL
      WHEN 'turn_lost' THEN channel_type IS NOT NULL AND trigger_type IS NOT NULL
        AND requester_role IS NOT NULL AND message_length_bucket IS NOT NULL AND media_kind IS NOT NULL
      WHEN 'reply_sent' THEN message_length_bucket IS NOT NULL
      WHEN 'relay_tool_completed' THEN turn_id IS NOT NULL
      ELSE false
    END
  )
);

-- The rollup's read: one trip, a time window.
CREATE INDEX IF NOT EXISTS assistant_events_trip_time_idx
  ON control_plane.assistant_events (trip_id, occurred_at);
