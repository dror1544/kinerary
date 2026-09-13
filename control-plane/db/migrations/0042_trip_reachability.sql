-- Whether a provisioned trip can actually be REACHED, recorded as its own
-- fact rather than inferred from anything else.
--
-- 2026-09-06: the first successful provisioning run reported success — job
-- 'succeeded', lifecycle_state 'ready_private', site answering HTTP 200 on
-- both addresses — while the organizer messaging the bot got "I don't have a
-- trip for this chat". Nothing in the database disagreed with "ready",
-- because nothing in the database recorded reachability at all. The entire
-- run emitted one log line, at that.
--
-- Deliberately NOT part of lifecycle_state. `activation_approved` and
-- `active` already exist in that enum with no writer, and docs/
-- activation-scope.md is explicit that they must not be implemented merely
-- because they exist. Reachability is a smaller, answerable question that
-- Phase A needs now: can the organizer talk to this trip's companion?
-- Whatever the activation lifecycle turns out to be, it can read this.
--
-- 'unknown' is the default and the fail-safe. A trip that has never been
-- provisioned, and a trip whose provisioning did not reach the question,
-- both say 'unknown' rather than claiming health nobody established. Only
-- an open chat binding to an installed companion sets 'reachable', and it is
-- set from the same code path that opens the binding — never derived later
-- from the binding row's existence, because a binding can outlive the thing
-- it points at.
ALTER TABLE control_plane.trips
  ADD COLUMN IF NOT EXISTS reachability text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS unreachable_reason text,
  ADD COLUMN IF NOT EXISTS reachability_checked_at timestamptz;

ALTER TABLE control_plane.trips
  DROP CONSTRAINT IF EXISTS trips_reachability_check;
ALTER TABLE control_plane.trips
  ADD CONSTRAINT trips_reachability_check
  CHECK (reachability IN ('unknown', 'reachable', 'unreachable'));

-- A reason is required exactly when unreachable, and meaningless otherwise:
-- "unreachable with no reason" is the silent failure this migration exists to
-- end, and "reachable, but here's why it isn't" is incoherent.
ALTER TABLE control_plane.trips
  DROP CONSTRAINT IF EXISTS trips_unreachable_reason_check;
ALTER TABLE control_plane.trips
  ADD CONSTRAINT trips_unreachable_reason_check
  CHECK (
    (reachability = 'unreachable' AND unreachable_reason IS NOT NULL)
    OR (reachability <> 'unreachable' AND unreachable_reason IS NULL)
  );

-- Operators ask "which provisioned trips can nobody talk to?" — that is the
-- whole point — so make it a cheap question.
CREATE INDEX IF NOT EXISTS trips_unreachable_idx
  ON control_plane.trips (reachability)
  WHERE reachability <> 'reachable';
