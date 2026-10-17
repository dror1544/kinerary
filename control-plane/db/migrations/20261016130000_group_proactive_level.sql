-- rollback: compatible — adds one defaulted, range-checked column to telegram_chat_bindings and widens assistant_events' CHECK constraints (trigger_type, event_type, outcome, metadata keys, per-type rules) by new values only; every row the prior version could write is still accepted, and the prior version ignores the column and never writes the new values
-- How much the assistant takes part in a group: the PROACTIVE LEVEL, and the
-- group judge that level 3 turns on (owner's decisions, 2026-10-16).
--
-- 1. telegram_chat_bindings.proactive_level
--
--   1 only when called  - its name, an @mention, a reply to one of its messages;
--   2 follows the conversation - 1, plus the one-shot "?" window (0053) and the
--     per-person conversation window (20261016120000); no judge. This is how the
--     relay behaved before the judge existed;
--   3 joins in - 2, plus the group judge: a message nothing else addressed to the
--     assistant is asked of a small model, "is this for the trip assistant?".
--     The default.
--
-- It is a PREFERENCE of a room, set by the trip's organizer with /proactive N,
-- not a privacy switch. Per GROUP BINDING, not per trip: a trip may have an
-- organizer DM and a family group bound, and the preference is about a room
-- full of people. smallint NOT NULL DEFAULT 3 with a CHECK of 1..3: every
-- existing binding becomes level 3 without the writer saying so, the constant
-- default is a catalogue change only, and nothing outside 1..3 can be stored.
-- Closing a binding (0029) keeps the value as history and a re-binding is a new
-- row, which starts at 3 again. Readers filter on closed_at IS NULL like every
-- column on this table. A trip that opted out of reply capture
-- (trips.companion_reply_capture_enabled, 0053) is read as level 1 whatever is
-- stored here: that switch already turns both windows off.
ALTER TABLE control_plane.telegram_chat_bindings
  ADD COLUMN IF NOT EXISTS proactive_level smallint NOT NULL DEFAULT 3;

ALTER TABLE control_plane.telegram_chat_bindings
  DROP CONSTRAINT IF EXISTS telegram_chat_bindings_proactive_level_check,
  ADD CONSTRAINT telegram_chat_bindings_proactive_level_check CHECK (proactive_level BETWEEN 1 AND 3);

COMMENT ON COLUMN control_plane.telegram_chat_bindings.proactive_level IS
  'How much the assistant takes part in this group: 1 only when called (name, @mention, reply), 2 also the "?" window and the conversation window, 3 also the group judge (default). Set by the trip organizer with /proactive N. Meaningless for a private chat. Read server-side only.';

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
-- One more event_type, `proactive_level_changed`, with outcomes `level_raised` /
-- `level_lowered` and one bounded metadata key, `proactive_level` (the NEW level,
-- 1..3, required for that type). Counts only - the trip, the direction, the level;
-- no chat and no person - so the daily report can show how many groups turn the
-- assistant down, which is the number that says whether it is welcome.
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
      'group_judged', 'proactive_level_changed'
    ));

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_outcome_check,
  ADD CONSTRAINT assistant_events_outcome_check
    CHECK (outcome IN (
      'ignored_not_addressed', 'dispatched', 'lost_gateway_unavailable',
      'lost_companion_unreachable', 'reply_delivered', 'failed_delivery',
      'reply_suppressed', 'failed_tool', 'blocked_by_policy',
      'correction_proposed', 'no_new_information', 'grounded_answer', 'missing_data',
      'judge_yes', 'judge_no', 'judge_fallback', 'judge_missed',
      'level_raised', 'level_lowered'
    ));

-- metadata: the three document keys of 20260925143012 plus the judge's four.
ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_metadata_allow_list,
  ADD CONSTRAINT assistant_events_metadata_allow_list CHECK (
    CASE
      WHEN jsonb_typeof(metadata) <> 'object' THEN false
      WHEN (metadata - ARRAY[
        'attachments_joined', 'documents', 'document_held',
        'judge_confidence_pct', 'judge_model', 'judge_fallback_reason', 'judge_below_threshold',
        'proactive_level'
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
  ADD CONSTRAINT assistant_events_metadata_proactive_level CHECK (
    CASE
      WHEN NOT metadata ? 'proactive_level' THEN true
      WHEN jsonb_typeof(metadata -> 'proactive_level') <> 'number' THEN false
      WHEN (metadata ->> 'proactive_level') !~ '^[1-3]$' THEN false
      ELSE true
    END
  ),
  ADD CONSTRAINT assistant_events_metadata_judge_fallback_reason CHECK (
    CASE
      WHEN NOT metadata ? 'judge_fallback_reason' THEN true
      WHEN jsonb_typeof(metadata -> 'judge_fallback_reason') <> 'string' THEN false
      ELSE (metadata ->> 'judge_fallback_reason') IN ('timeout', 'error', 'unparseable', 'rate_limited', 'circuit_open')
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
      WHEN 'proactive_level_changed' THEN outcome IN ('level_raised', 'level_lowered')
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
      WHEN 'proactive_level_changed' THEN channel_type IS NOT NULL AND requester_role IS NOT NULL
        AND metadata ? 'proactive_level'
      ELSE false
    END
  );
