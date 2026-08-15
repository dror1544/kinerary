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
      IF entry.key ~* '(^|_)(token|password|secret|api_?key|private_?key|oauth_grant|refresh_token|host_path|ip_address|vmid)($|_)'
        AND entry.key !~* '(^|_)secret_ref$' THEN
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

ALTER TABLE control_plane.job_steps
  ADD CONSTRAINT job_steps_safe_error_code_format CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  ADD CONSTRAINT job_steps_failed_requires_safe_error CHECK (
    state <> 'failed' OR safe_error_code IS NOT NULL
  );

CREATE TRIGGER audit_events_reject_truncate
BEFORE TRUNCATE ON control_plane.audit_events
FOR EACH STATEMENT EXECUTE FUNCTION control_plane.reject_audit_mutation();
