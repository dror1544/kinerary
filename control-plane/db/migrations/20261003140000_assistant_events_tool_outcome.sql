-- rollback: compatible — widens control_plane.assistant_events's CHECK
-- constraints to admit a new source_service, event_type and outcome; every
-- row the OLD code could write (source_service='relay', its six event types,
-- its eleven outcomes) is still accepted unchanged, so a rollback that keeps
-- this schema and reverts the code loses nothing the old code ever wrote.

-- Assistant-side tool-outcome events (the slice #177/#326 named but did not
-- build: "the relay observes delivery facts only; this arrives with a later
-- slice's assistant-side events", analytics/rates.ts).
--
-- A Hermes plugin running INSIDE a trip's companion sees something the relay
-- never can: whether the trip-mcp tool call it just made actually returned
-- usable data. One new event type, `tool_call_completed`, carries that fact,
-- written by a new source_service, `hermes`, through the authenticated
-- ingest route (control-plane/api/src/hermes-ingest.ts) rather than any
-- existing emitter.
--
-- NOT an `answered` outcome, deliberately — analytics/contract.ts's module
-- doc explains why at length: the new outcome is `grounded_answer`, reused
-- alongside the ALREADY-EXISTING `failed_tool` (the relay's own
-- relay_tool_completed already uses it; this is the same meaning, a
-- different source). No new column, no new metadata field, no turn_id (the
-- relay's hand-off id never reaches the assistant) — trip_id alone, same as
-- every other event type's required dimension.

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_source_service_check,
  ADD CONSTRAINT assistant_events_source_service_check
    CHECK (source_service IN ('relay', 'hermes'));

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_event_type_check,
  ADD CONSTRAINT assistant_events_event_type_check
    CHECK (event_type IN (
      'ignored_not_addressed', 'request_forwarded', 'request_to_relay',
      'turn_lost', 'reply_sent', 'relay_tool_completed', 'tool_call_completed'
    ));

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_outcome_check,
  ADD CONSTRAINT assistant_events_outcome_check
    CHECK (outcome IN (
      'ignored_not_addressed', 'dispatched', 'lost_gateway_unavailable',
      'lost_companion_unreachable', 'reply_delivered', 'failed_delivery',
      'reply_suppressed', 'failed_tool', 'blocked_by_policy',
      'correction_proposed', 'no_new_information', 'grounded_answer'
    ));

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
      WHEN 'tool_call_completed' THEN outcome IN ('grounded_answer', 'failed_tool')
      ELSE false
    END
  );

-- Every branch but this one is unchanged from 20260925143012; tool_call_completed
-- has no table-level dimension beyond the columns' own NOT NULL (event_id,
-- occurred_at, source_service, event_type, outcome) — trip_id is required by
-- the CONTRACT at write time (ingest route), not by the table, for the same
-- reason none of the other branches require it: ON DELETE SET NULL has to
-- survive a trip's deletion.
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
      WHEN 'tool_call_completed' THEN true
      ELSE false
    END
  );
