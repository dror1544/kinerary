-- rollback: compatible — adds one defaulted column to telegram_chat_bindings and widens assistant_events' CHECK constraints (trigger_type, event_type, outcome, metadata keys, per-type rules) by new values only; every row the prior version could write is still accepted, and the prior version ignores the column and never writes the new values
-- The group judge: a message no rule addressed to the assistant is asked of a
-- small model, "is this for the trip assistant?" (owner's decision,
-- 2026-10-16). Default ON; an organizer can switch it off for one group with
-- /listen off.
--
-- 1. telegram_chat_bindings.listen_judge_enabled
--
-- Per GROUP BINDING, not per trip: a trip may have an organizer DM and a
-- family group bound, and the opt-out is about a room full of people, not
-- about the trip. NOT NULL DEFAULT true so every existing binding keeps
-- working and a new one starts on without the writer saying so; a constant
-- default is a catalogue change only, no table rewrite. Closing a binding
-- (0029) keeps the value as history and a re-binding is a new row, which
-- starts on again - an organizer who turned it off tells the new binding too.
-- Readers filter on closed_at IS NULL like every column on this table.
ALTER TABLE control_plane.telegram_chat_bindings
  ADD COLUMN IF NOT EXISTS listen_judge_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN control_plane.telegram_chat_bindings.listen_judge_enabled IS
  'Whether the relay may ask the group judge (a bounded model call) if an unaddressed message in this group is for the assistant. Default true; an organizer switches it with /listen off|on. Meaningless for a private chat. Read server-side only.';

-- 2. assistant_events: the judge's decisions and their accuracy proxies
--
-- One new event_type, `group_judged`, and four outcomes:
--   judge_yes      the judge said the message is for the assistant (it is then
--                  forwarded: the same turn_id as its request_forwarded row)
--   judge_no       the judge said no, or said yes below the confidence threshold
--   judge_fallback the judge gave no usable answer (timeout, error, garbage,
--                  rate limit); the message is NOT_ADDRESSED exactly as before
--   judge_missed   a later event about an EARLIER judge_no: the same sender's
--                  next message in that chat within three minutes was addressed
--                  by name, @mention or reply. response_latency_ms is the gap.
-- response_latency_ms on the first three is the judge's own latency.
--
-- The judge sees message text; the event never does. Three new metadata keys,
-- each bounded: a whole number 0..100 (the confidence, as a percentage), the
-- configured model id (a short identifier from a restricted alphabet - deployment
-- configuration, not anything a traveller typed), and a fixed-set failure
-- reason. This loosens "numbers and one boolean" for exactly one text-shaped
-- key whose alphabet has no space, so a sentence cannot ride in it.
--
-- trigger_type gains `judge`: a message admitted only by the judge is none of
-- the existing triggers, and naming it as one would make the mix lie.
ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_trigger_type_check,
  ADD CONSTRAINT assistant_events_trigger_type_check
    CHECK (trigger_type IN (
      'dm', 'mention', 'name', 'reply_to_bot', 'reply_window', 'conversation_window', 'judge',
      'not_addressed', 'unclassified'
    ));

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_event_type_check,
  ADD CONSTRAINT assistant_events_event_type_check
    CHECK (event_type IN (
      'ignored_not_addressed', 'request_forwarded', 'request_to_relay',
      'turn_lost', 'reply_sent', 'relay_tool_completed', 'tool_call_completed',
      'group_judged'
    ));

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_outcome_check,
  ADD CONSTRAINT assistant_events_outcome_check
    CHECK (outcome IN (
      'ignored_not_addressed', 'dispatched', 'lost_gateway_unavailable',
      'lost_companion_unreachable', 'reply_delivered', 'failed_delivery',
      'reply_suppressed', 'failed_tool', 'blocked_by_policy',
      'correction_proposed', 'no_new_information', 'grounded_answer', 'missing_data',
      'judge_yes', 'judge_no', 'judge_fallback', 'judge_missed'
    ));

-- metadata: the three document keys of 20260925143012 plus the judge's four.
ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_metadata_allow_list,
  ADD CONSTRAINT assistant_events_metadata_allow_list CHECK (
    CASE
      WHEN jsonb_typeof(metadata) <> 'object' THEN false
      WHEN (metadata - ARRAY[
        'attachments_joined', 'documents', 'document_held',
        'judge_confidence_pct', 'judge_model', 'judge_fallback_reason', 'judge_below_threshold'
      ]) <> '{}'::jsonb THEN false
      WHEN metadata ? 'document_held' AND jsonb_typeof(metadata -> 'document_held') <> 'boolean' THEN false
      WHEN metadata ? 'judge_below_threshold' AND jsonb_typeof(metadata -> 'judge_below_threshold') <> 'boolean' THEN false
      ELSE true
    END
  );

ALTER TABLE control_plane.assistant_events
  ADD CONSTRAINT assistant_events_metadata_judge_confidence CHECK (
    CASE
      WHEN NOT metadata ? 'judge_confidence_pct' THEN true
      WHEN jsonb_typeof(metadata -> 'judge_confidence_pct') <> 'number' THEN false
      WHEN (metadata ->> 'judge_confidence_pct') !~ '^[0-9]{1,3}$' THEN false
      ELSE (metadata ->> 'judge_confidence_pct')::integer BETWEEN 0 AND 100
    END
  ),
  ADD CONSTRAINT assistant_events_metadata_judge_model CHECK (
    CASE
      WHEN NOT metadata ? 'judge_model' THEN true
      WHEN jsonb_typeof(metadata -> 'judge_model') <> 'string' THEN false
      ELSE (metadata ->> 'judge_model') ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,79}$'
    END
  ),
  ADD CONSTRAINT assistant_events_metadata_judge_fallback_reason CHECK (
    CASE
      WHEN NOT metadata ? 'judge_fallback_reason' THEN true
      WHEN jsonb_typeof(metadata -> 'judge_fallback_reason') <> 'string' THEN false
      ELSE (metadata ->> 'judge_fallback_reason') IN ('timeout', 'error', 'unparseable', 'rate_limited')
    END
  );

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_outcome_for_type,
  ADD CONSTRAINT assistant_events_outcome_for_type CHECK (
    CASE event_type
      WHEN 'ignored_not_addressed' THEN outcome = 'ignored_not_addressed'
      WHEN 'request_forwarded' THEN outcome = 'dispatched'
      WHEN 'request_to_relay' THEN outcome = 'dispatched'
      WHEN 'turn_lost' THEN outcome IN ('lost_gateway_unavailable', 'lost_companion_unreachable')
      WHEN 'reply_sent' THEN outcome IN ('reply_delivered', 'failed_delivery', 'reply_suppressed')
      WHEN 'relay_tool_completed' THEN outcome IN ('failed_tool', 'blocked_by_policy', 'correction_proposed', 'no_new_information')
      WHEN 'tool_call_completed' THEN outcome IN ('grounded_answer', 'failed_tool', 'missing_data')
      WHEN 'group_judged' THEN outcome IN ('judge_yes', 'judge_no', 'judge_fallback', 'judge_missed')
      ELSE false
    END
  );

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_required_for_type,
  ADD CONSTRAINT assistant_events_required_for_type CHECK (
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
      WHEN 'tool_call_completed' THEN tool_name IS NOT NULL
      WHEN 'group_judged' THEN channel_type IS NOT NULL AND trigger_type IS NOT NULL
        AND requester_role IS NOT NULL AND message_length_bucket IS NOT NULL AND media_kind IS NOT NULL
      ELSE false
    END
  );
