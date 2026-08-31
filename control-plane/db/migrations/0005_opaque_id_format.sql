-- Sprint 0 review follow-up. 0001 constrained the shape of users.id and
-- trips.id but left every other primary key as free text, so the format
-- discipline the contracts depend on held for two tables out of twenty. The
-- pattern below is the one shared by contracts.py (_OPAQUE_ID) and the v1 JSON
-- contract schemas, so a row that reaches PostgreSQL now has to carry the same
-- identifier shape the adapter envelopes are validated against.
--
-- Correlation and request identifiers get the same treatment: they cross the
-- API/worker boundary and end up in audit records, so an unconstrained value
-- there defeats the point of correlating on them.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'user_identities', 'trip_memberships', 'interview_enrollments',
    'intake_versions', 'releases', 'plans', 'jobs', 'job_steps', 'resources',
    'verification_evidence', 'activations', 'organizer_profiles',
    'trip_contexts', 'messaging_bindings', 'service_connections',
    'trip_connection_bindings', 'source_artifacts', 'audit_events'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE control_plane.%I ADD CONSTRAINT %I CHECK (id ~ %L)',
      target, target || '_id_is_opaque', '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'
    );
  END LOOP;
END;
$$;

ALTER TABLE control_plane.jobs
  ADD CONSTRAINT jobs_correlation_id_is_opaque CHECK (correlation_id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$');
ALTER TABLE control_plane.audit_events
  ADD CONSTRAINT audit_events_correlation_id_is_opaque CHECK (correlation_id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$');
ALTER TABLE control_plane.job_steps
  ADD CONSTRAINT job_steps_request_id_is_opaque CHECK (
    request_id IS NULL OR request_id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'
  );
