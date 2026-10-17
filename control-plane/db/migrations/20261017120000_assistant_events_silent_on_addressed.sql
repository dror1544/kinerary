-- rollback: compatible — widens assistant_events' metadata allow-list by one boolean key (silent_on_addressed); every row the prior version could write is still accepted, and the prior version never writes the key
-- The companion answered a turn that NAMED it (its name, an @mention, a reply to
-- it) with the silence sentinel. The relay cannot repair that (there is no answer
-- to invent) but counts it: reply_sent / reply_suppressed rows carry
-- metadata.silent_on_addressed = true, and the daily report shows the count as a
-- defect. A boolean only - no text, no id. Staging run, 2026-10-17 (A3).
ALTER TABLE control_plane.assistant_events
  DROP CONSTRAINT assistant_events_metadata_allow_list,
  ADD CONSTRAINT assistant_events_metadata_allow_list CHECK (
    CASE
      WHEN jsonb_typeof(metadata) <> 'object' THEN false
      WHEN (metadata - ARRAY[
        'attachments_joined', 'documents', 'document_held',
        'judge_confidence_pct', 'judge_model', 'judge_fallback_reason', 'judge_below_threshold',
        'proactive_level', 'silent_on_addressed'
      ]) <> '{}'::jsonb THEN false
      WHEN metadata ? 'document_held' AND jsonb_typeof(metadata -> 'document_held') <> 'boolean' THEN false
      WHEN metadata ? 'judge_below_threshold' AND jsonb_typeof(metadata -> 'judge_below_threshold') <> 'boolean' THEN false
      WHEN metadata ? 'silent_on_addressed' AND jsonb_typeof(metadata -> 'silent_on_addressed') <> 'boolean' THEN false
      ELSE true
    END
  );
