# One lock order for re-provisioning: `retryProvision` vs the worker's `_complete`

Status: draft (2026-10-19) · Issue: #387 · Track: Housekeeping · Size: S · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (operator retry path on any trip; control-plane API restart)

## Problem

Two transactions lock the same `jobs` and `trips` rows in opposite orders —
the deadlock shape this repo has already fixed once (#175) and again inside
`trip-clear.ts` (#378, R4-2).

**`retryProvision`** (`control-plane/api/src/planner.ts:294`), one transaction:

1. `SELECT lifecycle_state FROM trips WHERE id = $1 FOR UPDATE` — **trips**
2. plain read of `intake_versions`
3. `SELECT … FROM jobs WHERE trip_id = $1 AND job_type = 'provision' AND state NOT IN (terminal) FOR UPDATE` — **jobs**
4. `UPDATE plans SET status = 'superseded'` (active plans) — **plans**
5. `UPDATE jobs SET state = 'cancelled'` (ids from 3)
6. `UPDATE trips SET lifecycle_state = 'intake_confirmed'`

**Worker `_complete`** (`control-plane/worker/control_plane_worker/provisioner.py:1649`),
one transaction:

1. `UPDATE jobs SET state = 'succeeded' WHERE id = … AND lease_owner = … AND state = 'leased'` — **jobs**
2. `UPDATE plan_approvals SET used_at = now()` — **plan_approvals**
3. `UPDATE plans SET status = 'executed'` — **plans**
4. `UPDATE trips SET lifecycle_state = 'ready_private'` — **trips**
5. runtime route upsert, notification outbox, …

So `retryProvision` is **trips → jobs → plans**; `_complete` is
**jobs → plans → trips**. An operator retry (`POST` retry route in `app.ts:886`,
or the admin dashboard's retry in `admin-mutations.ts`) that lands while a
worker is committing a finished build: the worker holds the job row and waits
for `trips`; the retry holds `trips` and waits for the job row → Postgres
detects `40P01` after `deadlock_timeout` and aborts one side.

**Why it matters more than "one side retries":** if Postgres picks the
**worker** as the victim, `_complete` raises, the worker's `except` calls
`_fail()` (`provisioner.py` ~1344), and a trip whose site was built and
verified is recorded as a **failed** job. If it picks the retry, the operator
gets a 500 instead of `PROVISION_IN_PROGRESS`. Not reproduced live; same class
as #175 and #378 R4-2.

**The codebase convention is jobs (and session/enrollment/token rows) before
`trips`, `trips` last** — documented in `trip-clear.ts`'s header (steps 1–3)
and followed by `_complete`, `startSession`, `confirmIntakeVia`,
`redeemGroupBindingToken`, and the portal plan-reject. `retryProvision` is the
outlier.

**Second instance, same class (issue comment, #378 round 6):**
`scripts/teardown-trip.py`'s `retire_in_db` (rename branch) runs tokens →
bindings → **trips** → **sessions**, while `executeClear` runs jobs →
tokens/enrollments/**sessions**/bindings → **trips**. Reproduced live as a real
`40P01` by forced interleaving.

## Behaviour

An operator retry and a worker completion on the same trip at the same instant
serialize: one waits for the other, and both end in a defined state. The
worker's successful build is never recorded as failed because of a retry, and
the operator gets a normal answer (`PROVISION_IN_PROGRESS`, or a retry that
supersedes the now-finished build, exactly as it would have a second later).
A teardown and a clear racing on the same trip likewise wait, not deadlock.

## Acceptance criteria

- AC-1 `retryProvision` takes its row locks in the order **jobs → plans →
  trips**: it locks the non-terminal provision jobs `FOR UPDATE` first, then
  `trips` `FOR UPDATE`, and only then decides. The trip's existence and
  `RETRYABLE_STATES` check is made (or re-made) **after** the `trips` lock, so
  the decision is still taken under it.
- AC-2 After taking the `trips` lock, `retryProvision` re-reads non-terminal
  provision jobs **plainly** (no second `FOR UPDATE` — that would reopen the
  deadlock). A job that appeared between the two reads (committed by a
  concurrent `generatePlan`, which itself locks `trips`) makes it refuse with
  `PROVISION_IN_PROGRESS`, never cancel a job it did not lock and never leave
  an orphan job pointing at a superseded plan. Same argument as `trip-clear.ts`
  step 4.
- AC-3 Given a worker transaction mirroring `_complete` exactly (job
  `succeeded` first, then `plan_approvals`, `plans`, `trips`) holding its job
  row, when `retryProvision` is called concurrently on that trip, then it
  **blocks** (not settled after 250 ms); when the worker side commits, the
  job's state is `succeeded`, no `40P01` is raised on either side, and the retry
  resolves to a defined result (`ok`, or a named reason) — never a thrown
  error. This test fails (a real `40P01`) on the current code.
- AC-4 Given a worker claim (`FOR UPDATE OF j, pa, t SKIP LOCKED` then
  `leased`) holding its locks, when `retryProvision` runs, then it waits for
  the claim, sees a live lease and returns `PROVISION_IN_PROGRESS`; nothing is
  cancelled.
- AC-5 All existing `retryProvision` tests (`planner.test.ts`
  `describe("retryProvision")`, `admin-mutations.test.ts`) pass unchanged in
  their expectations.
- AC-6 `retire_in_db` (both branches) closes intake sessions **before** the
  bindings update and before the `trips` slug update, so its order becomes
  tokens → sessions → bindings → trips, compatible with `executeClear`. A
  concurrent DB test mirroring `retire_in_db`'s fixed statement order against a
  real `executeClear` on a trip with a live unconfirmed session and no live
  group token settles without a `40P01`.
- AC-7 Each changed function's comment states its lock order and names the
  transactions it must agree with (as `trip-clear.ts` does), and the
  `trip-clear.ts` header's list of "every path that locks `trips`" stays true.

## Contracts

- `control-plane/api/src/planner.ts` — `retryProvision` statement order only;
  result type and reasons unchanged.
- `scripts/teardown-trip.py` — `retire_in_db` statement order only (`CLOSE_SESSIONS`
  moved earlier in both branches).
- Worker unchanged: `_complete` already follows the convention.
- No migration, no route or config change.

## Non-goals

A general lock-order linter; changing `_complete`, `_claim` or
`generatePlan`; retrying on `40P01` (F-R9-1's single-retry pattern is for a
lock order that cannot be fixed, which this one can).

## Test plan

Written first, against a real Postgres test database only:
`CONTROL_PLANE_TEST_DATABASE_URL` naming a database whose name says it is for
tests (`test/support/test-database.ts` refuses anything else). Prefer a
dedicated name over the shared `cptest`, which other sessions reset
mid-run.

- `control-plane/api/test/planner.test.ts` (or a new
  `provision-lock-order.test.ts` using the same fixture helpers): AC-2, AC-3,
  AC-4. Shape copied from `trip-clear.test.ts`'s R4-2 tests (~line 734): a
  second `pool.connect()` `holder` runs `BEGIN` and the other side's statements
  in that side's exact order; the function under test is fired without
  `await`; a 250 ms wait asserts `settled === false` ("blocks, not deadlock");
  the holder finishes and commits; then both outcomes are asserted. The
  `group-binding.test.ts` #175 test (~line 269) is the second model: both sides
  run concurrently under `Promise.all`, so a real `40P01` surfaces as a
  thrown error rather than being swallowed.
- AC-3's holder mirrors `_complete`'s SQL statement for statement; its comment
  points at `provisioner.py`'s `_complete` so a future change there is seen as
  a test to update (the R4-2 test carries the same coupling).
- AC-6: a DB-backed test in `control-plane/api/test/trip-clear.test.ts`
  mirroring `retire_in_db`'s new order against `executeClear`; and
  `tests/scripts/test_teardown_trip.py` — the existing order assertions (the
  bindings → `intake_sessions` check near line 142 changes; the token-first
  check stays).
- Suites: `npm test --prefix control-plane/api` (DB suites with the test URL),
  `tests/scripts`.

## Rollout and regression

API restart (approved, as any) puts the retry change live; `teardown-trip.py`
is an operator script, live when the checkout running it updates.
Assessment: not needed — no migration, no auth or boundary path, no relay
change; the change is statement order inside two operator-only transactions,
covered by concurrency tests.

## Open questions

1. Keep the teardown half (AC-6) in this item, as the issue comment suggests,
   or split it into its own issue? (Proposed: keep — one convention, one PR.)
