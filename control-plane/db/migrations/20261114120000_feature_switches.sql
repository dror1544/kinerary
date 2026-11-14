-- rollback: compatible — new tables, an append-only trigger on one of them and a resolver function; nothing existing changes shape
-- Per-trip feature switches (#567, docs/specs/sprint-9/567-feature-switches.md).
--
-- A feature is written behind a named switch (shared/feature-switches.js is the
-- closed registry of names). An operator turns a switch on or off for ONE trip,
-- for EVERY trip, or for trips created from now on. The value for a trip is
-- resolved in this order and no other:
--
--   1. the trip's own setting
--   2. the every-trip setting
--   3. the future-trips setting, if the trip was created after it was set
--   4. OFF
--
-- Nothing is ever on by default, and the function below returns false whenever
-- no row applies. The only place that can say "on" is a row an operator wrote.
--
-- The registry is checked in code (feature-switches.ts), not here: a switch is
-- added by a code change, and a database that only learns names from rows would
-- let a typo become a stored switch. The CHECK on the name's shape is a
-- backstop, not the registry.
--
-- Nothing existing changes shape: two new tables and one function. The function
-- reads `trips`, which this migration does not touch. Rolling the code back
-- leaves the tables unread.
--
-- Modelled on model_task_settings (20260918110131): current state in one table,
-- an append-only history beside it, actors as a digest never a raw name.

CREATE TABLE IF NOT EXISTS control_plane.feature_switch_settings (
  switch         text NOT NULL,
  scope          text NOT NULL,
  -- NULL unless scope = 'trip'. Trip ids are text ('trip_...'), as everywhere
  -- else in this schema.
  trip_id        text REFERENCES control_plane.trips(id),
  enabled        boolean NOT NULL,
  -- Only 'new_trips' reads this: a trip created AFTER it is covered. It moves
  -- when the value changes, not when the same value is set again.
  effective_from timestamptz NOT NULL DEFAULT now(),
  -- sha256 of the operator's name, never the name.
  changed_by     text NOT NULL,
  changed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feature_switch_settings_switch_check CHECK (switch ~ '^[a-z][a-z0-9_]{2,40}$'),
  CONSTRAINT feature_switch_settings_scope_check CHECK (scope IN ('trip', 'all_trips', 'new_trips')),
  CONSTRAINT feature_switch_settings_trip_check CHECK ((scope = 'trip') = (trip_id IS NOT NULL)),
  CONSTRAINT feature_switch_settings_changed_by_check CHECK (changed_by ~ '^sha256:[a-f0-9]{64}$')
);

-- One row per (switch, scope, trip). trip_id is NULL outside the trip scope,
-- and NULLs never collide in a plain unique index, so fold it.
CREATE UNIQUE INDEX IF NOT EXISTS feature_switch_settings_one_per_scope
  ON control_plane.feature_switch_settings (switch, scope, COALESCE(trip_id, ''));

CREATE TABLE IF NOT EXISTS control_plane.feature_switch_history (
  id          text PRIMARY KEY,
  switch      text NOT NULL,
  scope       text NOT NULL,
  -- No foreign key on purpose: a history row outlives anything.
  trip_id     text,
  -- NULL: there was no row for this switch and scope before.
  old_enabled boolean,
  new_enabled boolean NOT NULL,
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feature_switch_history_id_is_opaque CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT feature_switch_history_switch_check CHECK (switch ~ '^[a-z][a-z0-9_]{2,40}$'),
  CONSTRAINT feature_switch_history_scope_check CHECK (scope IN ('trip', 'all_trips', 'new_trips')),
  CONSTRAINT feature_switch_history_trip_check CHECK ((scope = 'trip') = (trip_id IS NOT NULL)),
  CONSTRAINT feature_switch_history_changed_by_check CHECK (changed_by ~ '^sha256:[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS feature_switch_history_switch_idx
  ON control_plane.feature_switch_history (switch, changed_at DESC);

CREATE OR REPLACE FUNCTION control_plane.feature_switch_history_is_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'feature_switch_history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS feature_switch_history_append_only ON control_plane.feature_switch_history;
CREATE TRIGGER feature_switch_history_append_only
  BEFORE UPDATE OR DELETE ON control_plane.feature_switch_history
  FOR EACH ROW EXECUTE FUNCTION control_plane.feature_switch_history_is_append_only();

-- The resolution order, in one place. A trip that does not exist, a switch with
-- no row, an 'off' that applies: all false. The value is only ever true when a
-- row that applies says true.
CREATE OR REPLACE FUNCTION control_plane.feature_enabled(p_trip text, p_switch text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT s.enabled
       FROM control_plane.feature_switch_settings s
      WHERE s.switch = p_switch AND s.scope = 'trip' AND s.trip_id = p_trip),
    (SELECT s.enabled
       FROM control_plane.feature_switch_settings s
      WHERE s.switch = p_switch AND s.scope = 'all_trips'),
    (SELECT s.enabled
       FROM control_plane.feature_switch_settings s
       JOIN control_plane.trips t ON t.id = p_trip
      WHERE s.switch = p_switch AND s.scope = 'new_trips' AND t.created_at > s.effective_from),
    false
  );
$$;
