# One lock order for re-provisioning: `retryProvision` vs the worker's `_complete`

Status: draft, refreshed against 4510301 (2026-10-30) · Issue: #387 · Track: Housekeeping · Size: S (M if AC-8 is kept in) · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (operator retry path on any trip; control-plane API restart)

> **Sprint 8 (2026-10-30): in scope.**

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

**Worker `_complete`** (`control-plane/worker/control_plane_worker/provisioner.py:1716`),
one transaction:

1. `UPDATE jobs SET state = 'succeeded' WHERE id = … AND lease_owner = … AND state = 'leased'` — **jobs**
2. `UPDATE plan_approvals SET used_at = now()` — **plan_approvals**
3. `UPDATE plans SET status = 'executed'` — **plans**
4. `UPDATE trips SET lifecycle_state = 'ready_private'` — **trips**
5. runtime route upsert, notification outbox, …

So `retryProvision` is **trips → jobs → plans**; `_complete` is
**jobs → plans → trips**. An operator retry (`POST /v1/trips/:id/plan/retry`,
`app.ts:862`, calling `retryProvision` at `:889`; or the admin dashboard's
`retryTripViaAdmin`, `admin-mutations.ts:211`) that lands while a
worker is committing a finished build: the worker holds the job row and waits
for `trips`; the retry holds `trips` and waits for the job row → Postgres
detects `40P01` after `deadlock_timeout` and aborts one side.

**Why it matters more than "one side retries":** if Postgres picks the
**worker** as the victim, `_complete` raises, the worker's `except` calls
`_fail()` (`provisioner.py:1418`), and a trip whose site was built and
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

**Third instance, found in this refresh (2026-10-30):** `correctIntake`
(`control-plane/api/src/intake-correction.ts:97`, transaction from `:130`) runs
**trips** (`FOR UPDATE`, `:133`) → `intake_versions` insert → **plans**
(`UPDATE … SET status = 'superseded'`, `:169`) → **jobs** (`UPDATE … SET state =
'cancelled'`, `:178`) → **trips**. `CORRECTABLE_STATES` (`:32`) includes
`provisioning_approved`, and the worker's `_claim` does not move the trip out of
that state while it builds (only `_complete` sets `ready_private`), so an
organizer correction (`POST /v1/trips/:id/intake/correct`, `app.ts:1027`, or a
document correction via `document-correction.ts:497`) landing while the worker
commits a finished build is the same `trips`-first vs `jobs`-first shape: the
worker holds the job and plan rows and waits for `trips`; the correction holds
`trips` and waits for the plan row. Not reproduced; same reasoning as above.
See Open question 2.

**What moved on main since 03c0e1c (checked 2026-10-30).** `retryProvision`
(`planner.ts`) and `trip-clear.ts` are unchanged. `_complete`'s lock sequence
is unchanged (the file moved +67 lines, mostly #461's portal-origin and
reconciler support). `retire_in_db` (`scripts/teardown-trip.py:628`) gained one
statement from #349/#461: `CLEAR_TEARDOWN_PIN` (`:581`), which clears this
trip's teardown pin in `companion_gateways` as the **last** statement of both
branches. Its order is now tokens → bindings → (rename branch: **trips**) →
**sessions** → `companion_gateways`. The new row has no ordering constraint
against `trips`: no other transaction locks both. The reconciler
(`gateway_reconcile.py`), `relay/gateway-wait.ts` and `vm-release.py` read
`trips` plainly, and `pin_gateway_off` (`teardown-trip.py:670`) writes
`companion_gateways` in its own transaction under the advisory lock, touching
no `trips` row. Nothing on main fixes any of the three instances.

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
  tokens → sessions → bindings → trips → teardown-pin clear, compatible with
  `executeClear`. `CLEAR_TEARDOWN_PIN` stays inside the same transaction
  (the #349 pin tests at `tests/scripts/test_teardown_trip.py:561-575` stay
  green unchanged). A
  concurrent DB test mirroring `retire_in_db`'s fixed statement order against a
  real `executeClear` on a trip with a live unconfirmed session and no live
  group token settles without a `40P01`.
- AC-7 Each changed function's comment states its lock order and names the
  transactions it must agree with (as `trip-clear.ts` does), and the
  `trip-clear.ts` header's list of "every path that locks `trips`" stays true.
- AC-8 (only if Open question 2 keeps it in this item) `correctIntake` takes
  its locks in the order **jobs → plans → trips**, with the state check made
  after the `trips` lock, by the same pattern as AC-1/AC-2. Given a holder
  mirroring `_complete` on a trip in `provisioning_approved`, a concurrent
  `correctIntake` blocks, then settles without a `40P01`, and the worker's job
  ends `succeeded`. All existing `intake-correction.test.ts` and
  `document-correction-flow.test.ts` expectations pass unchanged.

## Contracts

- `control-plane/api/src/planner.ts` — `retryProvision` statement order only;
  result type and reasons unchanged.
- `scripts/teardown-trip.py` — `retire_in_db` statement order only (`CLOSE_SESSIONS`
  moved earlier in both branches; `CLEAR_TEARDOWN_PIN` stays last).
- `control-plane/api/src/intake-correction.ts` — `correctIntake` statement order
  only, if AC-8 is kept.
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
  AC-4. Shape copied from `trip-clear.test.ts`'s R4-2 tests (`:734`): a
  second `pool.connect()` `holder` runs `BEGIN` and the other side's statements
  in that side's exact order; the function under test is fired without
  `await`; a 250 ms wait asserts `settled === false` ("blocks, not deadlock");
  the holder finishes and commits; then both outcomes are asserted. The
  `group-binding.test.ts` #175 test (`:270`) is the second model: both sides
  run concurrently under `Promise.all`, so a real `40P01` surfaces as a
  thrown error rather than being swallowed.
- AC-3's holder mirrors `_complete`'s SQL statement for statement; its comment
  points at `provisioner.py`'s `_complete` so a future change there is seen as
  a test to update (the R4-2 test carries the same coupling).
- AC-6: a DB-backed test in `control-plane/api/test/trip-clear.test.ts`
  mirroring `retire_in_db`'s new order against `executeClear`; and
  `tests/scripts/test_teardown_trip.py` — the existing order assertions (the
  bindings → `intake_sessions` check at `:141-142` and the rename-branch
  checks at `:166-170` change; the token-first check and the #349 pin tests
  stay).
- AC-8 (if kept): `control-plane/api/test/intake-correction.test.ts`
  (`describe("correctIntake")`, `:115`), same holder shape as AC-3.
- Suites: `npm test --prefix control-plane/api` (DB suites with the test URL),
  `tests/scripts`.

## Rollout and regression

API restart (approved, as any) puts the retry change live; `teardown-trip.py`
is an operator script, live when the checkout running it updates.
Assessment: not needed — no migration, no auth or boundary path, no relay
change; the change is statement order inside two operator-only transactions
(three with AC-8, the third organizer-reachable), covered by concurrency tests.

## Open questions

1. Keep the teardown half (AC-6) in this item, as the issue comment suggests,
   or split it into its own issue? (Proposed: keep — one convention, one PR.)
2. (New, 2026-10-30) `correctIntake` is a third instance of the same
   trips-first shape (see Problem). Fold it in as AC-8 (one convention, one PR;
   size S→M) or file it as its own issue? It is organizer-reachable, not only
   operator-reachable, so it is arguably the likelier of the races.
