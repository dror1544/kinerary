-- 0026_plans_retryable_digest.sql
--
-- Sprint 4.7 — self-recovering re-provision.
--
-- 0001 gave control_plane.plans a table-level UNIQUE (trip_id, digest). Once a
-- provision job reaches a terminal state, _fail()/failJob() and
-- _complete()/completeJob() retire its plan to 'superseded' / 'executed' — but
-- the row, and its (trip_id, digest) pair, stays. Re-planning the same
-- confirmed intake against the same release produces an identical
-- desired-state digest, so the retry INSERT hits that constraint
-- (SQLSTATE 23505) and generatePlan reports PLAN_ALREADY_PENDING with no way
-- forward short of deleting rows by hand. This happened on every retry during
-- the Sprint 4.5 live work.
--
-- The intent behind the constraint is "don't create a second *active* plan for
-- the same desired state", not "this desired state may never recur". Narrow it
-- to the active statuses. plans_trip_active_idx (0011) already enforces at most
-- one active plan per trip regardless of digest; this keeps the digest-scoped
-- guard for the concurrent-identical-request race while letting a retired
-- plan's digest be reused by a fresh plan.

ALTER TABLE control_plane.plans DROP CONSTRAINT plans_trip_id_digest_key;

CREATE UNIQUE INDEX plans_active_digest_idx
  ON control_plane.plans (trip_id, digest)
  WHERE status IN ('pending_approval', 'approved');
