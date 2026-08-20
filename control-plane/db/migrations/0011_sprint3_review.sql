-- Sprint 3 review fixes
--
-- Add a partial unique index that enforces at most one active plan per trip at
-- the DB level. This closes a TOCTOU window in generatePlan: the pre-check
-- SELECT and the INSERT were separate statements, so two concurrent requests
-- could both pass the check and then race to insert. The index makes the INSERT
-- itself the atomic guard: if a concurrent insert wins, this one gets SQLSTATE
-- 23505, which generatePlan maps to PLAN_ALREADY_PENDING.
--
-- "Active" means pending_approval or approved. A plan is no longer active once
-- it moves to cancelled or the job completes (not modelled here yet).

CREATE UNIQUE INDEX plans_trip_active_idx ON control_plane.plans (trip_id)
  WHERE (status = 'pending_approval' OR status = 'approved');
