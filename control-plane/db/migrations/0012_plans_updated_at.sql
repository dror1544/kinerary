-- Add the timestamp used by planner and approval state transitions.
--
-- Earlier planner code updated plans.updated_at, but the original plans table
-- did not define it. Keeping the timestamp in the schema makes those updates
-- valid on both fresh databases and upgraded installations.

ALTER TABLE control_plane.plans
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
