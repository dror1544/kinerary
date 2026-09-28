-- control-plane/deployment/monitor-db-role.sql — the fleet monitor's database
-- role: it can read what the fleet MCP reads, and nothing else.
--
-- WHY. The fleet monitor (.agents/skills/trip-fleet-monitor/fleet-mcp.mjs)
-- keeps its database URL in its Hermes profile, and a Hermes host can run
-- every profile — traveller-facing companions included — in one container,
-- as one uid, over one data directory. Whatever credential that URL carries,
-- a companion that is talked into reading the file carries too. The control
-- plane's own login writes everything; this role reads a column list. The
-- MCP's read-only session default (PGOPTIONS) is a setting the caller
-- chooses, so it cannot be the control: the PRIVILEGES are.
--
-- WHAT IT GRANTS. SELECT on exactly the columns the MCP's queries touch, and
-- nothing at table level, so `SELECT *` is refused as well. Column-level on
-- purpose: `trips.companion_intro` holds each site's login password in plain
-- text, `intake_sessions.answers` every interview answer, `trip_person_links`
-- people's names and Telegram ids, `interview_enrollments.token_digest` the
-- link digests — none of which the monitor reads, and a table-level grant
-- would hand all of them to whoever holds the URL.
--
-- HOW IT IS KEPT HONEST. tests/scripts/test_monitor_db_role.py requires the
-- relations below to equal the ones fleet-mcp.mjs names, and — against a real
-- PostgreSQL carrying every migration — requires every tool to run as this
-- role and every granted column to be one some query needs. A new query on a
-- new column fails that test; the fix is a line here AND re-applying the role
-- on every deployment (a monitor query on an ungranted column fails loudly
-- with "permission denied", never as an empty answer).
--
-- NOT A MIGRATION. A role is cluster-wide, carries a password, and is a
-- deployment's choice (a stack with no monitor needs no such login); a
-- migration runs on every stack, including test databases dropped and
-- recreated by the suites. So it is applied by an operator, through
-- scripts/create-monitor-db-role.sh, which also sets the password.
--
-- RUN IT THROUGH THE SCRIPT. By hand it is also safe, as a superuser:
--   psql -v role=kinerary_fleet_ro -f monitor-db-role.sql            (apply)
--   psql -v check_only=true -f monitor-db-role.sql                   (verify only)
-- psql variables (all optional):
--   role              the login to create or correct   (default kinerary_fleet_ro)
--   connection_limit  concurrent sessions              (default 20: trip_detail
--                     opens 9 at once, and the alert cron and the agent can
--                     overlap — enough for two tools, not for a flood)
--   check_only        true = verify and probe, change nothing, ROLLBACK
--   verifier          a SCRAM-SHA-256 verifier to set as the password. The
--                     script computes it client-side, so the plaintext never
--                     reaches the server or its logs. No password is in this
--                     file, and none belongs in the repository.
--
-- Everything happens in ONE transaction, which also verifies the result and
-- proves, as the role, that writes are refused — so an apply that would leave
-- the role wrong leaves it as it was instead.

\set ON_ERROR_STOP on
\if :{?role}
\else
  \set role kinerary_fleet_ro
\endif
\if :{?connection_limit}
\else
  \set connection_limit 20
\endif
\if :{?check_only}
\else
  \set check_only false
\endif

-- ── THE GRANT LIST ──────────────────────────────────────────────────────────
-- One line per relation: `schema.relation: column column ...`. A relation may
-- take several lines. Every other relation in the database stays unreadable.
SELECT set_config('kinerary_fleet_ro.role', :'role', false) AS fleet_ro_role,
       set_config('kinerary_fleet_ro.connection_limit', :'connection_limit', false) AS fleet_ro_limit,
       set_config('kinerary_fleet_ro.grants', $grants$
control_plane.assistant_events: trip_id occurred_at event_type channel_type requester_role outcome
control_plane.assistant_events: response_latency_ms media_kind
control_plane.companion_bug_reports: id trip_id reported_at kind summary detail quote surface
control_plane.intake_sessions: id trip_id state created_at updated_at source_document language phase
control_plane.intake_sessions: awaiting awaiting_since interpret_path expires_at expired_at
control_plane.intake_versions: trip_id confirmed_at
control_plane.interview_enrollments: trip_id state expires_at consumed_at created_at
control_plane.interview_interpretations: session_id failure_reason created_at
control_plane.job_steps: job_id step_key state safe_error_code updated_at
control_plane.jobs: id trip_id job_type state attempt safe_error_code result created_at updated_at
control_plane.jobs: last_heartbeat_at max_attempts
control_plane.notification_outbox: id notification_type state attempt max_attempts sent_at created_at
control_plane.notification_outbox: updated_at trip_id kind
control_plane.telegram_chat_bindings: chat_id trip_id hermes_profile created_at closed_at closed_reason
control_plane.trip_person_links: trip_id role verified_via
control_plane.trips: id slug lifecycle_state created_at updated_at title destination_label start_date
control_plane.trips: end_date reachability unreachable_reason reachability_checked_at
public.control_plane_schema_migrations: version
$grants$, false) AS fleet_ro_grants
\gset

BEGIN;

\if :check_only
\else
-- ── APPLY ───────────────────────────────────────────────────────────────────
-- Every step is a no-op when the role already matches, so a second run leaves
-- the catalog as the first one did.
DO $apply$
DECLARE
  r      text := current_setting('kinerary_fleet_ro.role');
  lim    int  := current_setting('kinerary_fleet_ro.connection_limit')::int;
  ro     oid;
  x      record;
  col    text;
BEGIN
  IF r !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'role name "%" is not a plain lower-case identifier', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I', r);
  END IF;
  ro := (SELECT oid FROM pg_roles WHERE rolname = r);

  -- Attributes. NOINHERIT and no memberships: it holds its own grants, and
  -- PUBLIC's, and nothing it could reach by SET ROLE.
  EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                 'NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s', r, lim);
  EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', r);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r, '20s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '60s');
  FOR x IN SELECT m.roleid::regrole::text AS granted FROM pg_auth_members m WHERE m.member = ro LOOP
    EXECUTE format('REVOKE %s FROM %I', x.granted, r);
  END LOOP;

  -- The database: connect, nothing else. TEMP is a PUBLIC default, and what
  -- PUBLIC holds every role holds, so it is taken from PUBLIC. That touches
  -- only roles that are neither superuser nor the database's owner.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM %I', current_database(), r);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);

  -- Schemas: never CREATE anywhere; USAGE where the granted relations live.
  -- CREATE on `public` is PUBLIC's by default before PostgreSQL 15.
  FOR x IN SELECT nspname FROM pg_namespace
            WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema' LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', x.nspname, r);
  END LOOP;
  FOR x IN SELECT DISTINCT split_part(rel, '.', 1) AS nsp
             FROM (SELECT btrim(split_part(l, ':', 1)) AS rel
                     FROM regexp_split_to_table(current_setting('kinerary_fleet_ro.grants'), E'\n') AS l
                    WHERE btrim(l) <> '') g LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', x.nsp);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', x.nsp, r);
  END LOOP;

  -- Relations. Anything the role holds directly that the list does not name
  -- is revoked; then exactly the listed columns are granted.
  FOR x IN
    WITH g AS (
      SELECT btrim(split_part(l, ':', 1))::regclass AS rel,
             regexp_split_to_table(btrim(split_part(l, ':', 2)), '\s+') AS col
        FROM regexp_split_to_table(current_setting('kinerary_fleet_ro.grants'), E'\n') AS l
       WHERE btrim(l) <> ''
    )
    SELECT c.oid, c.oid::regclass::text AS rel, c.relkind,
           (SELECT array_agg(g.col ORDER BY g.col) FROM g WHERE g.rel = c.oid) AS cols,
           EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = ro) AS has_table_acl,
           EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                    WHERE att.attrelid = c.oid AND a.grantee = ro
                      AND (a.privilege_type <> 'SELECT'
                           OR att.attname::text <> ALL (coalesce((SELECT array_agg(g.col) FROM g WHERE g.rel = c.oid), '{}'))))
             AS has_unwanted_column_acl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  LOOP
    IF x.cols IS NULL THEN
      IF x.has_table_acl OR x.has_unwanted_column_acl THEN
        EXECUTE format('REVOKE ALL ON %s %s FROM %I',
                       CASE WHEN x.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, x.rel, r);
      END IF;
    ELSE
      IF x.has_table_acl THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', x.rel, r);
      END IF;
      IF x.has_unwanted_column_acl THEN
        -- A column privilege it should not hold: clear every column entry it
        -- has on this relation; the GRANT below puts back exactly the list.
        FOR col IN
          SELECT att.attname::text
            FROM pg_attribute att
           WHERE att.attrelid = x.oid AND att.attnum > 0 AND NOT att.attisdropped
             AND EXISTS (SELECT 1 FROM aclexplode(att.attacl) a WHERE a.grantee = ro)
        LOOP
          EXECUTE format('REVOKE ALL (%I) ON TABLE %s FROM %I', col, x.rel, r);
        END LOOP;
      END IF;
      EXECUTE format('GRANT SELECT (%s) ON TABLE %s TO %I',
                     (SELECT string_agg(quote_ident(cl), ', ') FROM unnest(x.cols) cl), x.rel, r);
    END IF;
  END LOOP;
END
$apply$;

\if :{?verifier}
ALTER ROLE :"role" PASSWORD :'verifier';
\endif
\endif

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- Effective privileges (has_*_privilege counts PUBLIC's grants too), not just
-- what this file granted: a grant somebody added by hand is found here.
DO $verify$
DECLARE
  r        text := current_setting('kinerary_fleet_ro.role');
  lim      int  := current_setting('kinerary_fleet_ro.connection_limit')::int;
  ro       oid;
  a        record;
  x        record;
  problems text[] := '{}';
  nrel     int;
  ncol     int;
BEGIN
  SELECT * INTO a FROM pg_roles WHERE rolname = r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet monitor role "%" does not exist — run scripts/create-monitor-db-role.sh', r;
  END IF;
  ro := a.oid;
  IF NOT a.rolcanlogin THEN problems := problems || 'cannot log in'::text; END IF;
  IF a.rolsuper THEN problems := problems || 'is a SUPERUSER'::text; END IF;
  IF a.rolcreatedb THEN problems := problems || 'has CREATEDB'::text; END IF;
  IF a.rolcreaterole THEN problems := problems || 'has CREATEROLE'::text; END IF;
  IF a.rolinherit THEN problems := problems || 'has INHERIT'::text; END IF;
  IF a.rolreplication THEN problems := problems || 'has REPLICATION'::text; END IF;
  IF a.rolbypassrls THEN problems := problems || 'has BYPASSRLS'::text; END IF;
  IF a.rolconnlimit <> lim THEN
    problems := problems || format('connection limit is %s, not %s', a.rolconnlimit, lim);
  END IF;
  IF NOT coalesce(a.rolconfig @> ARRAY['default_transaction_read_only=on', 'statement_timeout=20s',
                                       'idle_in_transaction_session_timeout=60s'], false) THEN
    problems := problems || format('role settings are %s', coalesce(a.rolconfig::text, 'none'));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setrole = ro AND setdatabase <> 0) THEN
    problems := problems || 'has per-database settings that override its own'::text;
  END IF;
  FOR x IN SELECT m.roleid::regrole::text AS granted FROM pg_auth_members m WHERE m.member = ro LOOP
    problems := problems || format('is a member of %s', x.granted);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
                                        AND refobjid = ro AND deptype = 'o') THEN
    problems := problems || 'owns objects (an owner holds every privilege on them)'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) e WHERE e.grantee = ro) THEN
    problems := problems || 'is named in default privileges (future objects would be granted)'::text;
  END IF;

  IF NOT has_database_privilege(ro, current_database(), 'CONNECT') THEN
    problems := problems || 'cannot CONNECT'::text;
  END IF;
  IF has_database_privilege(ro, current_database(), 'CREATE') THEN
    problems := problems || 'can CREATE schemas in the database'::text;
  END IF;
  IF has_database_privilege(ro, current_database(), 'TEMPORARY') THEN
    problems := problems || 'can create TEMPORARY tables (PUBLIC still holds TEMP on the database?)'::text;
  END IF;
  FOR x IN SELECT nspname FROM pg_namespace
            WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
              AND has_schema_privilege(ro, oid, 'CREATE') LOOP
    problems := problems || format('can CREATE in schema %s', x.nspname);
  END LOOP;

  FOR x IN
    WITH g AS (
      SELECT btrim(split_part(l, ':', 1)) AS rel,
             regexp_split_to_table(btrim(split_part(l, ':', 2)), '\s+') AS col
        FROM regexp_split_to_table(current_setting('kinerary_fleet_ro.grants'), E'\n') AS l
       WHERE btrim(l) <> ''
    )
    SELECT g.rel, g.col FROM g
     WHERE to_regclass(g.rel) IS NULL
        OR NOT EXISTS (SELECT 1 FROM pg_attribute att
                        WHERE att.attrelid = to_regclass(g.rel) AND att.attname = g.col
                          AND att.attnum > 0 AND NOT att.attisdropped)
  LOOP
    problems := problems || format('%s.%s is in the grant list but not in this database', x.rel, x.col);
  END LOOP;

  -- Every relation outside the system schemas: no write, no table-level read.
  FOR x IN
    SELECT c.oid, c.oid::regclass::text AS rel, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY 2
  LOOP
    IF x.relkind = 'S' THEN
      IF has_sequence_privilege(ro, x.oid, 'USAGE, SELECT, UPDATE') THEN
        problems := problems || format('holds a privilege on sequence %s', x.rel);
      END IF;
      CONTINUE;
    END IF;
    IF has_table_privilege(ro, x.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      problems := problems || format('can write %s', x.rel);
    END IF;
    IF has_table_privilege(ro, x.oid, 'SELECT') THEN
      problems := problems || format('can SELECT every column of %s (a table-level grant)', x.rel);
    END IF;
  END LOOP;

  -- Every column: readable exactly when the list names it, never writable.
  FOR x IN
    WITH g AS (
      SELECT to_regclass(btrim(split_part(l, ':', 1))) AS rel,
             regexp_split_to_table(btrim(split_part(l, ':', 2)), '\s+') AS col
        FROM regexp_split_to_table(current_setting('kinerary_fleet_ro.grants'), E'\n') AS l
       WHERE btrim(l) <> ''
    )
    SELECT c.oid, c.oid::regclass::text AS rel, att.attname::text AS col,
           EXISTS (SELECT 1 FROM g WHERE g.rel = c.oid AND g.col = att.attname::text) AS wanted
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
     WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     ORDER BY 2, 3
  LOOP
    IF has_column_privilege(ro, x.oid, x.col, 'INSERT, UPDATE, REFERENCES') THEN
      problems := problems || format('can write column %s.%s', x.rel, x.col);
    END IF;
    IF x.wanted AND NOT has_column_privilege(ro, x.oid, x.col, 'SELECT') THEN
      problems := problems || format('cannot read %s.%s, which the fleet MCP reads', x.rel, x.col);
    ELSIF NOT x.wanted AND has_column_privilege(ro, x.oid, x.col, 'SELECT') THEN
      problems := problems || format('can read %s.%s, which is not in the grant list', x.rel, x.col);
    END IF;
  END LOOP;

  FOR x IN SELECT p.oid::regprocedure::text AS fn
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prosecdef AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
              AND has_function_privilege(ro, p.oid, 'EXECUTE') LOOP
    problems := problems || format('can execute SECURITY DEFINER function %s', x.fn);
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'fleet monitor role "%" does not match monitor-db-role.sql:%', r,
      E'\n  - ' || array_to_string(problems, E'\n  - ');
  END IF;

  SELECT count(DISTINCT btrim(split_part(l, ':', 1))),
         sum(cardinality(regexp_split_to_array(btrim(split_part(l, ':', 2)), '\s+')))
    INTO nrel, ncol
    FROM regexp_split_to_table(current_setting('kinerary_fleet_ro.grants'), E'\n') AS l
   WHERE btrim(l) <> '';
  RAISE NOTICE 'fleet_ro verified: role %, LOGIN NOINHERIT, connection limit %, SELECT on % columns of % relations and nothing else',
    r, lim, ncol, nrel;
END
$verify$;

-- ── PROBE ───────────────────────────────────────────────────────────────────
-- As the role, in a transaction that is NOT read-only: what refuses these is
-- the privileges, not the session default a client can switch off. Rolled
-- back whatever happens; lock_timeout keeps a misconfigured grant from
-- queueing behind production traffic.
SAVEPOINT fleet_ro_probe;
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE :"role";
DO $probe$
DECLARE
  stmt    text;
  allowed text[] := '{}';
  refused int := 0;
BEGIN
  FOREACH stmt IN ARRAY ARRAY[
    'INSERT INTO control_plane.trips DEFAULT VALUES',
    'UPDATE control_plane.trips SET slug = slug WHERE false',
    'DELETE FROM control_plane.trips WHERE false',
    'TRUNCATE control_plane.companion_bug_reports',
    'CREATE TABLE control_plane.fleet_ro_probe (x int)',
    'CREATE TEMPORARY TABLE fleet_ro_probe (x int)',
    'SELECT companion_intro FROM control_plane.trips LIMIT 0',
    'SELECT * FROM control_plane.trips LIMIT 0'
  ] LOOP
    BEGIN
      EXECUTE stmt;
      allowed := allowed || stmt;
    EXCEPTION WHEN insufficient_privilege THEN
      refused := refused + 1;
    END;
  END LOOP;
  IF cardinality(allowed) > 0 THEN
    RAISE EXCEPTION 'fleet monitor role was ALLOWED: %', array_to_string(allowed, '; ');
  END IF;
  RAISE NOTICE 'fleet_ro probe: all % write and out-of-list statements refused with permission denied, as the role, in a read-write transaction',
    refused;
END
$probe$;
ROLLBACK TO SAVEPOINT fleet_ro_probe;
RESET ROLE;

\if :check_only
ROLLBACK;
\else
COMMIT;
\endif
