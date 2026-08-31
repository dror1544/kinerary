-- Sprint 0 review follow-up. Three defects in canonical_json_is_safe:
--
--   1. Sensitive keys were matched with (^|_)word($|_) boundaries, so only
--      snake_case was covered: api_key and apiKey were rejected but
--      accessToken was stored verbatim. redaction.ts matches the same words
--      as bare substrings, which left the database -- the last line of
--      defence -- weaker than the application layer it backstops. The word
--      list is now unanchored and aligned with redaction.ts, plus credential
--      and passphrase.
--
--   2. 0003 exempted any *_secret_ref key from the word check without looking
--      at the value, so {"db_secret_ref": "postgresql://u:PASSWORD@h/db"}
--      was accepted. A reference key now has to actually hold an opaque
--      env://, file:// or vault:// reference -- the same rule
--      service_connections.connection_secret_ref already carries as a column
--      CHECK -- and the match is case-style agnostic so secretRef counts too.
--
--   3. The private-address branch for 10./127. required only three numeric
--      groups, so it rejected ordinary text: the semver "10.15.7" and the
--      date "10.11.2025" both failed to store. plans.desired is exactly where
--      a release version or a date belongs, and the failure surfaced as an
--      opaque CHECK violation. A whole dotted quad is now required.
--
-- Replacing the function does not revalidate rows written under the looser
-- 0002/0003 definitions, so the constraints are dropped and re-added below to
-- force a full scan.

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
      IF entry.key ~* 'secret[_-]?ref$' THEN
        -- A reference key is allowed to name a secret, never to inline one.
        IF jsonb_typeof(entry.value) <> 'string'
          OR (entry.value #>> '{}') !~ '^(env|file|vault)://' THEN
          RETURN false;
        END IF;
      ELSIF entry.key ~* '(token|password|passphrase|credential|secret|authorization|cookie|api[_-]?key|private[_-]?key|oauth[_-]?grant|host[_-]?path|ip[_-]?address|vmid|telegram[_-]?id|chat[_-]?id)' THEN
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
    IF scalar ~* '(Bearer[[:space:]]+[^[:space:]]+|PVEAPIToken=|/Users/|/home/)' THEN
      RETURN false;
    END IF;
    IF scalar ~ '(^|[^0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9.]|$)' THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
END;
$$;

ALTER TABLE control_plane.plans
  DROP CONSTRAINT plans_desired_is_canonical,
  ADD CONSTRAINT plans_desired_is_canonical CHECK (control_plane.canonical_json_is_safe(desired));
ALTER TABLE control_plane.jobs
  DROP CONSTRAINT jobs_result_is_canonical,
  ADD CONSTRAINT jobs_result_is_canonical CHECK (control_plane.canonical_json_is_safe(result));
ALTER TABLE control_plane.job_steps
  DROP CONSTRAINT job_steps_result_is_canonical,
  ADD CONSTRAINT job_steps_result_is_canonical CHECK (control_plane.canonical_json_is_safe(result));
ALTER TABLE control_plane.source_artifacts
  DROP CONSTRAINT source_artifacts_provenance_is_canonical,
  ADD CONSTRAINT source_artifacts_provenance_is_canonical CHECK (control_plane.canonical_json_is_safe(provenance));
ALTER TABLE control_plane.audit_events
  DROP CONSTRAINT audit_evidence_is_canonical,
  ADD CONSTRAINT audit_evidence_is_canonical CHECK (control_plane.canonical_json_is_safe(evidence));
