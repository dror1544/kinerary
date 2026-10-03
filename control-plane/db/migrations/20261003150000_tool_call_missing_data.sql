-- rollback: compatible — widens the outcome CHECK to admit `missing_data`,
-- widens the per-type outcome/required CHECKs for `tool_call_completed`
-- accordingly, and adds a new nullable `tool_name` column with its own
-- closed-set CHECK. Every row the OLD code could write (no `missing_data`,
-- no `tool_name`) is still accepted unchanged, so a rollback that keeps this
-- schema and reverts the code loses nothing the old code ever wrote. A row
-- the NEW code writes (tool_name set, or outcome = 'missing_data') would be
-- rejected by the OLD code's narrower CHECKs if written after a real
-- rollback — exactly what "compatible" means here: forward-compatible data
-- is fine, this migration is not one a rollback needs to strip first.

-- The missing-information control loop (Sprint 6 build list,
-- docs/sprint6-tracks.md decision 22: "detect a missing fact, record it,
-- show the top missing items in the daily report" — the organizer-request
-- and fulfillment-tracking thirds are explicitly deferred past this sprint).
--
-- `tool_call_completed`'s classifier (.agents/hermes-plugins/assistant-
-- events/__init__.py) used to fold two different facts into one
-- `failed_tool` outcome: the tool genuinely erroring, and the tool running
-- fine but the trip's own data having nothing to answer with (an empty
-- result, no error) — its own docstring named this as a KNOWN LIMIT rather
-- than engineered around. `missing_data` is the second fact, split out: not
-- a software failure, a data-completeness one, which is exactly the signal
-- "detect a missing fact" needs.
--
-- `tool_name` is the "which fact" dimension decision 22's "top missing
-- items" needs — the only new column in this migration, a closed-set text
-- column mirroring every other enum-shaped column on this table
-- (channel_type, trigger_type, requester_role), not metadata (which stays
-- numbers-and-one-boolean only, analytics/contract.ts's own invariant).
-- Required for `tool_call_completed` specifically; every other event type
-- has no comparable "which thing" dimension to name, and stays NULL for it.

ALTER TABLE control_plane.assistant_events
  ADD COLUMN tool_name text CHECK (tool_name IN (
    'health_check', 'get_config', 'get_agent_brief', 'get_photos', 'add_photo',
    'delete_photo', 'set_participant_avatar', 'add_participant',
    'reset_participant_password', 'bind_participant_telegram', 'remove_participant',
    'set_telegram_group', 'get_today', 'get_companion_inbox', 'publish_companion_reply',
    'publish_companion_group_update', 'set_companion_connection', 'set_trip_timezone',
    'publish_daily_message', 'get_budget', 'add_budget_item', 'update_budget_item',
    'delete_budget_item', 'get_rsvps', 'get_ratings', 'get_tasks', 'get_lost_found',
    'post_lost_found', 'resolve_lost_found', 'get_venue_comments', 'post_venue_comment',
    'get_photo_comments', 'post_photo_comment', 'get_bookings', 'add_booking',
    'update_booking', 'delete_booking', 'upload_booking_confirmation',
    'get_booking_confirmation', 'get_trivia_state', 'trivia_control', 'get_trivia_scores',
    'get_trivia_questions', 'add_trivia_question', 'get_phase_plan', 'swap_plan_days',
    'set_plan_day_label', 'add_plan_item', 'update_plan_item', 'delete_plan_item',
    'import_plan_from_bookings', 'get_assistant_names', 'set_assistant_names', 'report_bug'
  ));

ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_outcome_check,
  ADD CONSTRAINT assistant_events_outcome_check
    CHECK (outcome IN (
      'ignored_not_addressed', 'dispatched', 'lost_gateway_unavailable',
      'lost_companion_unreachable', 'reply_delivered', 'failed_delivery',
      'reply_suppressed', 'failed_tool', 'blocked_by_policy',
      'correction_proposed', 'no_new_information', 'grounded_answer', 'missing_data'
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
      WHEN 'tool_call_completed' THEN outcome IN ('grounded_answer', 'failed_tool', 'missing_data')
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
      ELSE false
    END
  );
