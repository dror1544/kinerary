-- Sprint 1's carried-forward review item ("assertCanonicalRecordSafe still
-- has no caller... waiting on Sprint 2's intake writer") was never closed:
-- Sprint 2 (intake) and Sprint 4 (structured travelers/phases/travel_anchors/
-- constraints answers) both landed since, and intake_versions.data now holds
-- exactly the kind of organizer-controlled free-form JSON this guard exists
-- for -- free text, "other" answers, and now whole structured objects/arrays
-- -- with zero canonical-safety checking at either layer. Every other
-- durable/canonical column (plans.desired, jobs.result, job_steps.result,
-- source_artifacts.provenance, audit_events.evidence) has carried this CHECK
-- since 0004; this one was simply missed when 0013 added the column.
ALTER TABLE control_plane.intake_versions
  ADD CONSTRAINT intake_versions_data_is_canonical
  CHECK (control_plane.canonical_json_is_safe(data));
