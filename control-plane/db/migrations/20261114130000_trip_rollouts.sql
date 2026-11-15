-- rollback: compatible — new table, two nullable columns
--
-- #568 (docs/specs/sprint-9/568-trip-rollout.md), slice R1: WHICH RELEASE A TRIP RUNS, AND EVERY ROLLOUT THAT MOVED IT.
--
-- Until now nothing said which version a trip runs. `trips` had no such column; the closest answer was the `release_id`
-- of the trip's latest executed plan, which a hand deploy never touches. This adds the record, and a log of the one
-- command (scripts/trip-rollout.py) that now moves it.
--
-- 1. trips.current_release_id / previous_release_id — the release the trip's site runs now, and the one it ran before
--    (the way back: a rollback is the same command naming the previous release). Both nullable: NULL means "unknown",
--    which a plan shows as "unknown" and which a rollout may start from (the plan then says no way back is recorded).
--    BACKFILL: each trip's latest EXECUTED plan whose provision job SUCCEEDED. A trip with none stays NULL. A plan that
--    only reached 'approved', or whose job failed, says nothing about what is running. previous_release_id is not
--    backfilled: there is no earlier fact to read it from.
--
-- 2. trip_rollouts — one row per `trip-rollout.py execute` against one trip. The row is written as `running` BEFORE the
--    first step acts (so a crash mid-step leaves a row that says so, never nothing), and closed as `ok` or `failed`
--    with the NAME of the step that failed. No command output, path, address or key is ever stored here: a failed step
--    is a name, and the evidence is on the operator's console. At most one rollout per trip is `running` at a time.
--    Append-only apart from closing its own row: the trigger below refuses a delete, and an update of anything but
--    result / failed_step / finished_at on a row that is still running.
--
-- WHAT THIS DOES NOT DO: it creates no approval, no notification and no lifecycle change; a rollout is not a
-- provision. The previous release neither reads nor writes any of this, which is why a rollback to it is compatible.
--
-- The fleet monitor's read-only role is NOT widened here. That role is applied by an operator from
-- control-plane/deployment/monitor-db-role.sql, and applying it REVOKES any column it does not list, so a grant made
-- in a migration would be undone by the next apply; the two columns belong in that file together with the fleet
-- MCP query that reads them (tests/scripts/test_monitor_db_role.py requires both).

ALTER TABLE control_plane.trips
  ADD COLUMN current_release_id text REFERENCES control_plane.releases(id),
  ADD COLUMN previous_release_id text REFERENCES control_plane.releases(id);

UPDATE control_plane.trips t
   SET current_release_id = latest.release_id
  FROM (
    SELECT DISTINCT ON (p.trip_id) p.trip_id, p.release_id
      FROM control_plane.plans p
      JOIN control_plane.jobs j
        ON j.plan_id = p.id AND j.job_type = 'provision' AND j.state = 'succeeded'
     WHERE p.status = 'executed' AND p.release_id IS NOT NULL
     ORDER BY p.trip_id, p.created_at DESC, p.id DESC
  ) latest
 WHERE t.id = latest.trip_id;

CREATE TABLE control_plane.trip_rollouts (
  id text PRIMARY KEY CHECK (id ~ '^rollout_[a-z0-9]{8,64}$'),
  trip_id text NOT NULL REFERENCES control_plane.trips(id),
  from_release_id text REFERENCES control_plane.releases(id),
  to_release_id text NOT NULL REFERENCES control_plane.releases(id),
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) > 0),
  result text NOT NULL CHECK (result IN ('running', 'ok', 'failed')),
  failed_step text CHECK (failed_step IS NULL OR failed_step ~ '^[a-z][a-z0-9_]{0,31}$'),
  actor text NOT NULL CHECK (actor ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT trip_rollouts_failed_step_only_when_failed CHECK ((result = 'failed') OR failed_step IS NULL),
  CONSTRAINT trip_rollouts_finished_when_closed CHECK ((result = 'running') = (finished_at IS NULL))
);

CREATE INDEX trip_rollouts_trip_idx ON control_plane.trip_rollouts (trip_id, started_at DESC);
CREATE UNIQUE INDEX trip_rollouts_one_running_idx ON control_plane.trip_rollouts (trip_id) WHERE result = 'running';

CREATE FUNCTION control_plane.trip_rollouts_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trip_rollouts is append-only: a rollout row is never deleted';
  END IF;
  IF OLD.result <> 'running' THEN
    RAISE EXCEPTION 'trip_rollouts is append-only: rollout % is already closed', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.from_release_id IS DISTINCT FROM OLD.from_release_id
     OR NEW.to_release_id IS DISTINCT FROM OLD.to_release_id
     OR NEW.steps IS DISTINCT FROM OLD.steps OR NEW.actor IS DISTINCT FROM OLD.actor
     OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'trip_rollouts is append-only: only result, failed_step and finished_at close a row';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER trip_rollouts_guard_trg
  BEFORE UPDATE OR DELETE ON control_plane.trip_rollouts
  FOR EACH ROW EXECUTE FUNCTION control_plane.trip_rollouts_guard();
