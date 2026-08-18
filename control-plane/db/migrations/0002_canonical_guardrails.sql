CREATE OR REPLACE FUNCTION control_plane.canonical_json_is_safe(document jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry record;
  item jsonb;
  scalar text;
BEGIN
  IF document IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(document) = 'object' THEN
    FOR entry IN SELECT pair.key, pair.value FROM jsonb_each(document) AS pair LOOP
      IF entry.key ~* '(^|_)(token|password|api_?key|private_?key|oauth_grant|refresh_token|host_path|ip_address|vmid)($|_)' THEN
        RETURN false;
      END IF;
      IF NOT control_plane.canonical_json_is_safe(entry.value) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR item IN SELECT element.value FROM jsonb_array_elements(document) AS element LOOP
      IF NOT control_plane.canonical_json_is_safe(item) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'string' THEN
    scalar := document #>> '{}';
    IF scalar ~* '(Bearer[[:space:]]+[^[:space:]]+|PVEAPIToken=|/Users/|/home/|(^|[^0-9])(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9]{1,3}\.[0-9]{1,3})' THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
END;
$$;

ALTER TABLE control_plane.plans
  ADD CONSTRAINT plans_desired_is_canonical CHECK (control_plane.canonical_json_is_safe(desired));
ALTER TABLE control_plane.jobs
  ADD CONSTRAINT jobs_result_is_canonical CHECK (control_plane.canonical_json_is_safe(result));
ALTER TABLE control_plane.job_steps
  ADD CONSTRAINT job_steps_result_is_canonical CHECK (control_plane.canonical_json_is_safe(result));
ALTER TABLE control_plane.source_artifacts
  ADD CONSTRAINT source_artifacts_provenance_is_canonical CHECK (control_plane.canonical_json_is_safe(provenance));
ALTER TABLE control_plane.audit_events
  ADD CONSTRAINT audit_evidence_is_canonical CHECK (control_plane.canonical_json_is_safe(evidence));

CREATE OR REPLACE FUNCTION control_plane.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON control_plane.audit_events
FOR EACH ROW EXECUTE FUNCTION control_plane.reject_audit_mutation();
