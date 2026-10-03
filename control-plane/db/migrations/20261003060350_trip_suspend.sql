-- rollback: compatible — two new nullable columns on an existing table; nothing existing changes shape, and nothing reads them until slice 2's admin routes ship

-- Super-admin dashboard slice 2 (Sprint 6, decision 23 in docs/sprint6-tracks.md):
-- suspend/retry controls. Retry reuses planner.ts's existing `retryProvision`
-- (Sprint 4.7) outright — no schema change needed for it. Suspend has no
-- existing mechanism, so this is that mechanism.
--
-- WHAT SUSPEND IS, deliberately narrow: a pause on job claiming for this trip,
-- not a lifecycle state. `lifecycle_state` already drives generatePlan,
-- retryProvision's RETRYABLE_STATES and the worker's deploy branches — folding
-- "suspended" into that enum would mean every one of those call sites has to
-- learn a new state it was never designed to see, and resuming would have to
-- remember which state to go BACK to. An orthogonal nullable timestamp does
-- not have that problem: the trip's lifecycle_state is untouched by a
-- suspend/resume cycle, so resume always returns the trip to exactly where it
-- was. This mirrors `control_plane.trips.reachability` (migration 0042) —
-- another orthogonal flag the worker checks before acting, not a lifecycle
-- state of its own.
--
-- What suspend does NOT do, on purpose (narrower than "suspend/archive" in the
-- sprint plan's manual test list, which is a separate, heavier,
-- no-force-flag operation — scripts/teardown-trip.py):
--   - it does not touch the live site, its data, or any container;
--   - it does not stop the relay from engaging the trip's companion. The
--     retired-slug filtering CLAUDE.md documents for `live_companions()` /
--     `expectedGatewayProfiles()` (#288) is a real precedent for "a trip
--     state the relay checks before engaging a companion", but that one
--     exists because a RETIRED trip's chat bindings must stop being served
--     forever. A SUSPENDED trip is the opposite case — temporary, reversible,
--     and the companion answering during a pause is not a safety problem the
--     way a retired trip's companion still answering would be. Wiring the
--     relay to this flag too is a real future option, not something this
--     migration or slice 2's brief asks for; doing it now would be scope
--     creep past "pause job processing".
--
-- `suspended_reason` is operator-authored free text (why this trip was
-- paused), not traveler or organizer text — the same trust tier as the
-- X-API-Key holder who requests the suspend in the first place, not the
-- "never traveler text" risk `control_plane.audit_events.evidence`'s
-- allow-list exists to contain (see admin-dashboard.ts's module doc). It is
-- bounded here for the same reason release-registry.ts bounds `promoted_by`
-- at the DB layer, not only in application code: a CHECK constraint holds
-- even against a future direct SQL write or a bug in the app-layer validator.
--
-- #review 2026-10-03 [P2]: the pair was originally kept consistent by
-- construction as an equivalence (suspended if and only if both columns are
-- set), and resumeTrip nulled both together. That lost the only record of
-- WHY a trip had been paused the moment it was un-paused, with nothing else
-- durable holding it (admin_events.evidence deliberately never gets a copy
-- of operator free text — see this file's own note above, and
-- admin-mutations.ts's module doc). The constraint is now one-directional:
-- suspended implies a reason, but a reason may outlive the suspension that
-- wrote it. resumeTrip clears only `suspended_at`; `suspended_reason` keeps
-- the last reason as a plain operational fact until the NEXT suspend
-- overwrites it. `suspended_at IS NULL` alone is still the one thing every
-- reader (job-queue.ts, provisioner.py, suspendTrip/resumeTrip's own checks)
-- already treats as "is this trip currently suspended" — none of them ever
-- read `suspended_reason` for that, so nothing downstream changes meaning.
ALTER TABLE control_plane.trips
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_reason text
    CHECK (suspended_reason IS NULL OR char_length(suspended_reason) BETWEEN 1 AND 500);

ALTER TABLE control_plane.trips
  ADD CONSTRAINT trips_suspended_pair
  CHECK (suspended_at IS NULL OR suspended_reason IS NOT NULL);
