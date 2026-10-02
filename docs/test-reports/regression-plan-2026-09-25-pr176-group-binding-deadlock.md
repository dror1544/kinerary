# Regression plan — PR #176 re-check at `ce15208`

**Mode:** branch / pre-deploy. **Date:** 2026-09-25.
**Change set:** `fix/175-group-binding-retired-trip` @ `ce15208`, base `integration/sprint-6` @ `064807f`, merge-base `377895f`.
**Assessor:** `regression-planner`. Supersedes the earlier assessment of the same
branch at `1e9cbbe`, which returned DECISION NEEDED on a reproduced `40P01`.

---

## 0 — Verdict on the deadlock (point 2, quotable verbatim)

> Yes — `ce15208` closes the exact cycle I found at `1e9cbbe`, and it closes it
> at the right end. The cycle needed two transactions taking the same two row
> locks in opposite orders: `redeemGroupBindingToken` takes the token row first
> (`FOR UPDATE OF tg`) and the `trips` row second (a `FOR KEY SHARE` lock the
> `INSERT INTO telegram_chat_bindings` acquires through its foreign key,
> whatever the `NOT EXISTS` subquery does), while `retire_in_db` took the
> `trips` row first (its slug `UPDATE`, which is a *key* update because
> `trips.slug` is `UNIQUE`, so it conflicts with `FOR KEY SHARE`) and the token
> row last. Moving `REVOKE_GROUP_TOKENS` to the top of both transaction
> branches makes teardown acquire the token row before it touches `trips`, so
> both sides now take the same two locks in the same order and no cycle can
> form; every other writer of these tables I checked
> (`issueGroupBindingToken`, including its `ON CONFLICT (trip_id) DO UPDATE`)
> already ran token-then-`trips`. I did not take this on the commit message's
> word: I re-derived the lock order from the schema (`0045` and `0019`/`0029`
> give both tables a foreign key to `trips`; `0001` makes `trips.slug` unique)
> and then reproduced both orders against a real PostgreSQL 16 with two
> concurrent sessions running the production statement sequences — the old
> order deadlocked in 3 of 3 deterministic runs, the new order in 0 of 11
> (5 raw + 6 with the production guards applied). One correction to the record
> while I am at it: this deadlock was never exposed to production. Neither
> `main` nor the merge-base has any token-revoke in `teardown-trip.py` at all,
> so the hazard was created by this PR's own first commit and is being fixed
> before it lands, not after it shipped.

---

## 1 — Change set

| Commit | What |
|---|---|
| `1e9cbbe` | `redeemGroupBindingToken` refuses a retired trip (`TRIP_RETIRED`); `teardown-trip.py` revokes live group tokens, revoke LAST |
| `ce15208` (head) | revoke FIRST in both branches; corrected comments; new real-DB concurrency test; dry-run counts live tokens; query aliasing |

Files (verified myself with `git diff --name-only 377895f ce15208`):

- `control-plane/api/src/group-binding.ts`
- `control-plane/api/test/group-binding.test.ts`
- `scripts/teardown-trip.py`
- `tests/scripts/test_teardown_trip.py`

**No migration.** Confirmed — nothing under `control-plane/db/migrations/` in
the diff. Section 3's whole ritual (snapshot, rehearsal against restored data,
the `migrations.test.ts` ordered-list failure) does not apply to this PR.

Merge shape independently consistent with the integrator's report: the base has
moved only by two `CLAUDE.md` doc commits (`e84e4af`, `064807f`) and one
unrelated docs file since `377895f`; no code overlap.

---

## 2 — Risk table

| # | Change | Surface (§2) | Blast radius | Migration | Compat break | Risk | Test | Min | Batch? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `redeemGroupBindingToken` retired-trip refusal + aliasing | `control-plane/api/src/` **and `src/relay/`** (`relay/dispatch.ts:554` is the only caller) | every live Telegram conversation at relay restart | no | no | med — it is the relay | `group-binding.test.ts` + `relay-dispatch.test.ts` in CI | 0 extra (CI) | batched |
| 2 | teardown revoke-first ordering | `scripts/` | nothing until a human runs the script | no | no | **high if wrong, zero until run** | Python order test + real-DB probe | 1 | isolated (done, §5.1) |
| 3 | dry-run counts live group tokens | `scripts/` | operator output only; but a new query against a table that must exist | no | soft: refuses on a control plane older than `0045` | low | `test_a_live_group_binding_token_is_counted…` | 0 | batched |
| 4 | new real-DB concurrency test | test only | none | no | no | low; see §3.3 for what it does and does not guard | it is the test | 0 | batched |

Nothing in this PR touches `site/`, `server/`, `shared/` or `trip-web/`. **No
release is needed and no trip has to be redeployed** — the usual "a fix does
not reach a live trip by deploying" asymmetry does not bite here.

---

## 3 — Lock-order and compatibility findings

### 3.1 The cycle, re-derived from the schema (not from the comments)

Read off the migrations in this tree today:

- `0045_group_binding_tokens.sql`: `trip_id text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE`, `token_digest text NOT NULL UNIQUE`, plus `UNIQUE INDEX … (trip_id)`.
- `0019` + `0029`: `telegram_chat_bindings.trip_id … REFERENCES control_plane.trips(id)`, and `CREATE UNIQUE INDEX telegram_chat_bindings_active_chat_idx ON (chat_id) WHERE closed_at IS NULL`.
- `0001_foundation.sql:13`: `slug text NOT NULL UNIQUE …`.

Consequences that matter:

1. The redemption's `INSERT INTO control_plane.telegram_chat_bindings` fires an
   RI check that takes `FOR KEY SHARE` on the referenced `trips` row. The
   docstring at `ce15208` now says this, and it is correct.
2. `UPDATE control_plane.trips SET slug = …` is a **key** update, because
   `slug` carries a non-partial unique index. It therefore takes a tuple lock
   of `FOR UPDATE` strength, which **conflicts** with `FOR KEY SHARE`. This is
   the second edge of the cycle and is the reason the deadlock was real rather
   than theoretical.
3. Teardown's revoke (`SET expires_at = now()`) does **not** take any lock on
   `trips`: `trip_id` is unchanged, so no RI check fires. Its tuple lock on the
   token row is `FOR NO KEY UPDATE`, which still conflicts with the
   redemption's `FOR UPDATE` — so the two transactions serialize on that row,
   which is exactly what the fix needs.

Order after `ce15208`, both sides: **token row → `trips` row.** No cycle.

### 3.2 Reproduced, both orders (my own run, 2026-09-25)

Two concurrent `psql` sessions against PostgreSQL 16.15 (`postgres:16-alpine`,
container `kinerary-sprint5-testdb`), in a scratch database `regplan176_test`
created and dropped for this purpose — `cptest` was **not** touched, since it is
shared between sessions. Schema was a minimal replica carrying the three
load-bearing constraint shapes from the migrations above (the FKs to `trips`,
`trips.slug UNIQUE`, the partial unique index on open bindings); the statements
were the production ones, copied from `group-binding.ts` and `teardown-trip.py`.
A 1 s `pg_sleep` in each transaction makes the interleaving deterministic
instead of relying on 40 random pairs.

| Order | Runs | Deadlocks |
|---|---|---|
| pre-`ce15208` (revoke last) | 3 | **3** (`40P01`) |
| `ce15208` (revoke first), redemption without guards | 5 | 0 |
| `ce15208`, redemption applying the real `expired` / `trip_retired` guards | 6 | 0 |

This independently corroborates the developer's 8–13/40 vs 0/40. Two details
worth keeping:

- **The deadlock victim is sometimes teardown itself.** In one of the three old-order
  runs the *teardown* transaction was aborted, leaving `slug` un-retired, two
  bindings open and the token still live. `teardown-trip.py`'s `psql()` raises
  `RuntimeError` on a non-zero exit, and the database step (6) runs *after* the
  infra step (5) — so that outcome is a trip whose Cloudflare record, NPM host
  and LXC are already gone while the control plane still believes it is live and
  its group token is still redeemable. That is issue #105's symptom, manufactured
  by the fix for #105. It is the strongest argument for not letting `1e9cbbe`'s
  order land.
- **The guarded runs behaved correctly, not just deadlock-free:** 4 of 6 ended
  `REFUSED EXPIRED` (teardown won the token row; the redemption re-read the
  updated row after unblocking — EvalPlanQual does see the new `expires_at`),
  2 of 6 ended `BOUND`.

### 3.3 The residual race is narrower than the PR says (not a blocker)

The PR's "Deliberately not done" keeps an accepted timing race: a redemption
that reads `trips` unlocked while a teardown has staged but not committed.
My measurement says revoke-first has largely **closed that race for the
redemption path as a side effect**, because both transactions now contend on
the token row before either does anything else:

- In both `BOUND` iterations above — the case where the redemption won the token
  row and inserted a brand-new binding *during* teardown — the end state was
  `open_bindings=0`. Teardown was blocked at its revoke until the redemption
  committed, so its bindings-close (which now runs *after* the revoke) saw and
  closed the new row.

What genuinely remains, and is worth one sentence in the docstring rather than
any code:

- a token **issued or re-issued during teardown** (`issueGroupBindingToken`)
  can escape the revoke and then be redeemed in the window before the slug
  rename commits. Narrow (it needs the organizer to ask for a new group code
  mid-teardown) and self-limiting (after commit, `trip_retired` refuses it).
- `bind_chat_to_trip` (`provisioner.py`) keeps its own documented race,
  untouched by this PR.

I am reporting this as a measurement with its caveats — replica schema, PG 16,
forced interleaving — not as a licence to delete the docstring paragraph.

### 3.4 Other compatibility notes

- `FOR UPDATE` → `FOR UPDATE OF tg` with a single table in `FROM` is
  semantically identical; the alias/qualification change is inert.
- `resolve()` now queries `control_plane.telegram_group_binding_tokens`
  unconditionally. Against a control plane older than migration `0045`, psql
  runs with `ON_ERROR_STOP=1`, so `teardown-trip.py` would now **refuse to plan
  at all** rather than degrade. Production is past `0045` (see §4), so this is
  a note, not a finding.
- **Doc landed ahead of code.** `e84e4af` and `064807f` on
  `integration/sprint-6` already document teardown's token revoke *and* its
  ordering rule in `CLAUDE.md`. Until #176 merges, `CLAUDE.md` on the
  integration branch describes behaviour the branch does not have. Merging
  resolves it; abandoning #176 means reverting those two commits.

---

## 4 — Live-fleet exposure (read from production today)

Read 2026-09-25 through the fleet monitor's read-only MCP
(`.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`, stack `prod` = the VM at
192.168.0.45), tools `list_trips` and `trip_detail`:

| Trip | Stage | Bindings | Notes |
|---|---|---|---|
| `orlando-florida-2026` | `ready_private` | private only, open since 09-23 | real organizer, created 2026-09-23, interview confirmed |
| `japan-tokyo-hakone-kyoto-osaka-2026` | `ready_private` | **group** open since 09-16, private open since 09-15 | a real family's trip |

Plus 4 prospects mid-intake and a long tail of retired trips — teardown is run
against production regularly (`retired-cpvm-td-test-20260911`, and every
`retired-…` slug in the list).

What this means for this PR:

1. **The group-binding redemption path is live in production.** A `group`
   binding exists on the japan trip and only `redeemGroupBindingToken` creates
   one, so migration `0045` is applied on the VM and the code path runs there.
   (Provenance: inferred from the binding's existence + `trip_detail`; I did
   not read `control_plane_schema_migrations` directly — the fleet MCP exposes
   no arbitrary SQL and I did not open an ad-hoc production shell.)
2. **No live trip is exposed to this deadlock right now.** `git show
   origin/main:scripts/teardown-trip.py` and the merge-base copy both contain
   **no** `REVOKE_GROUP_TOKENS` and never touch
   `telegram_group_binding_tokens`. Production teardown locks `trips` and
   bindings only, so a concurrent redemption can wait on it but cannot cycle
   with it. The hazard is entirely inside this PR.
3. **`ready_private` is not protected from teardown.** `REFUSED_STATES =
   {activation_approved, active, completed, sealed}` — both live production
   trips sit one state *below* the refusal line. So the "teardown runs
   concurrently with a redemption" scenario is reachable against a real
   family's trip, not only against test trips. That is an argument for the fix,
   and also a standing observation worth someone's attention separately.
4. **Deploying this reaches everyone at once, via the relay.**
   `relay/dispatch.ts:554` is the only caller, so the API/relay restart that
   ships it drops any conversation mid-turn. The japan trip's group is bound
   and live. Use `control-plane/deployment/vm-relay-restart.sh` (not the Mac's
   `scripts/relay-restart.sh`) and honour its `awaiting = 'machine'` refusal.
5. **Nothing has to be redeployed per trip.** No `site/`, `server/`, `shared/`
   or `trip-web/` change, so no release, no per-trip redeploy, no pinned-release
   asymmetry.

---

## 5 — The plan

### 5.1 Already executed by me (evidence in hand, do not re-pay for it)

| Run | Result | Cost |
|---|---|---|
| Lock-order probe, both orders, real PG 16 (§3.2) | old 3/3 deadlock, new 0/11 | ~6 min, done |
| `python3 -m unittest discover -s tests/scripts -p test_teardown_trip.py` at `ce15208` | **30 tests, OK, 0.045 s** (baseline at `064807f`: 24 tests, OK) | <1 min, done |
| Mutation check: revoke moved back to last → re-run the same suite | **3 failures**, both branches named — the ordering test has real power | <1 min, done |
| Read CI for `ce15208` (`gh run view 35907191928`) | see 5.2 | ~2 min, done |

Worktree restored clean afterwards; the scratch database was dropped.

### 5.2 The one thing that is actually open: CI on the PR head is RED

`Control plane / TypeScript API` **FAILURE** on `ce15208`
(run `35907191928`, job `107337699086`, 2026-09-23T19:18:43Z). Read the log
rather than the badge:

- `# pass 1606`, `# fail 0`, `# cancelled 2`.
- The only red is `control-plane/api/test/group-document-to-plan.integration.test.ts`:
  `Error: listen EADDRINUSE: address already in use :::38294` from
  `server/server.js`, so the helper server never became ready, `hookFailed`,
  and its 2 subtests were `cancelledByParent`. `38294` is
  `PORTS.groupDocumentServer`, uniquely owned by that file in
  `tests/helpers/ports.js` — something else on the runner held it.
- **This PR's own tests passed in that same run:**
  `ok 9 - teardown-trip.py's token-revoke and a live redemption do not deadlock`
  and `ok 144 - group binding tokens`. The new real-database test **ran** in CI
  (the job sets `CONTROL_PLANE_TEST_DATABASE_URL`), it did not skip.
- The other five checks — Python worker, Web SPA, Kinerary suite, Modern trip
  SPA, Runtime gateway, plus the regression-assessment job — are green.
- Base `064807f` is green, and this is the only failure in the last 25
  `Control plane` runs. One sample, unexplained, in a file this PR does not
  touch and does not feed.

**Action:** re-run that job on `ce15208` (CLAUDE.md's rule: re-run, then run the
file alone, before costing a fix). Cost: ~11 min of runner time, nobody present.
If it reproduces on the same commit, it is still not #176's doing — but it is
then a real defect in that test's server lifecycle and wants its own issue, and
#176 should not be held behind it.

### 5.3 Before merge (the gate)

| Order | Run | Command | Needs | Minutes | Who |
|---|---|---|---|---|---|
| 1 | CI re-run of `TypeScript API` on `ce15208` | re-run the failed job | GitHub | ~11 (unattended) | nobody |
| 2 | teardown script tests | `python3 -m unittest discover -s tests/scripts -p "test_teardown_trip.py"` | nothing | **<1 (measured)** | nobody |
| 3 | control-plane API suite locally, if CI stays red | `CONTROL_PLANE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/<your-own-test-db> npm test --prefix control-plane/api` | test Postgres; **name your own database, `cptest` is shared** | minutes | verifier |

Checklist for run 2/3, per change: (a) the revoke precedes the bindings-close in
**both** branches; (b) `group binding tokens › teardown-trip.py's token-revoke
and a live redemption do not deadlock` is `ok` and not `skipped`; (c)
`relay-dispatch.test.ts` green — the caller is the relay.

### 5.4 Before deploying the control plane to the VM (separate decision, later)

Nothing in this PR forces a deploy. When Sprint 6 does deploy:

1. `scripts/preflight-deploy.sh` (no `--deploy`) — tens of minutes, unattended.
   This is also the **only** place `tests/scripts` runs (see §8).
2. Schedule the relay restart around live conversations; `vm-relay-restart.sh`
   refuses `awaiting = 'machine'` within five minutes. The japan trip's group is
   bound and live.
3. Provisioning is ON for a real organizer on the VM (since 2026-09-14) — any VM
   test run needs a human's yes first, and VM and Mac runs must not overlap.

### 5.5 What must NOT be batched

- **Do not "verify" this by running `teardown-trip.py --execute` against a
  production trip.** Both live trips are `ready_private`, which teardown accepts.
  The deadlock question is already answered by §3.2 against a scratch database.
  If an end-to-end teardown rehearsal is wanted, it belongs on a Mac test trip
  (pre-approved per standing memory) or a fresh throwaway VM trip with explicit
  approval, never on `orlando-florida-2026` or `japan-tokyo-hakone-kyoto-osaka-2026`.
- The deadlock evidence stays its own line item; it is a concurrency property
  and "it came up in the e2e run" would not be evidence of it either way.

---

## 6 — Budget

| Tier | Cost | Buys |
|---|---|---|
| **Minimum gate** | ~11 min unattended + <1 min local | CI green on `ce15208`; the ordering test and the real-DB concurrency test both observed green |
| + local API suite with a private test DB | + minutes | independence from the CI flake; proves the DB-backed test runs on this machine too |
| + `scripts/preflight-deploy.sh` (no deploy) | + tens of minutes | the only run that executes `tests/scripts` at all, plus worker and guardrails — owed once before the sprint deploys, not once per PR |
| + a teardown rehearsal on a throwaway trip | + a person, a window | end-to-end proof that `retire_in_db` still retires correctly with the statements reordered. My §3.2 probe covers the lock behaviour; this would cover the *effect* (slug freed, bindings closed, token dead) on a real stack. Optional for merge, worthwhile before the sprint's deploy |

---

## 7 — Go / no-go, and the way back

**Go, on one condition:** the `TypeScript API` check is green on `ce15208`
(re-run; the current red is an unrelated `EADDRINUSE`).

**No-go if:** the re-run fails again *in this PR's own files*; or if anyone
proposes landing `1e9cbbe` without `ce15208` (that order is a reproduced
`40P01` whose victim can be teardown itself — §3.2).

**The way back is cheap, and that is a real part of the verdict:** no migration,
no release, no per-trip state. Reverting the merge and redeploying the API/relay
restores the previous behaviour exactly. No snapshot is required for this PR —
which is not a licence to skip one for whatever else rides on the same deploy.

---

## 8 — What would reduce the risk, ranked by risk removed per minute

1. **Re-run the failed CI job** (~11 min, unattended). It is the only open
   condition. Everything else here is already evidenced.
2. **Add `tests/scripts` to CI** (one job; the whole suite measured **5 m 34 s
   wall** on this Mac on 2026-09-25 — runner time will differ; the teardown file
   alone is 0.045 s). Today CI runs `control-plane/worker/tests` and `tests/`
   (npm) but **not** `tests/scripts`, so the one test with proven mutation power
   over teardown's statement order — it fails 3 assertions when the order is
   reverted, I checked — runs *only* inside `scripts/preflight-deploy.sh`. A
   future reordering regression would reach `main` with CI green. This is the
   highest-value item in this report after item 1, and it is not #176's debt to
   pay; file it.
3. **Couple the TS concurrency test to the Python source of truth** (~10 min).
   `group-binding.test.ts` hand-copies teardown's statement order; it cannot
   catch a reordering of `teardown-trip.py`, only a reordering of
   `redeemGroupBindingToken`. Either say so in its comment, or have it read the
   SQL from `teardown-trip.py`. Right now the two halves of the guarantee are
   joined by prose.
4. **One sentence in the docstring** recording that revoke-first also serializes
   the two transactions on the token row, so the "stale binding created DURING
   teardown" residual now needs a *concurrently issued* token to occur (§3.3).
   The current text is more pessimistic than the code, which is the safer
   direction to be wrong in, but it will send the next reader hunting a race
   that mostly is not there.
5. **Nothing else.** No migration, no release, no trips to redeploy, and the
   revert is a revert. For the deadlock itself this is now cheap and
   well-evidenced; I would not ask for more work on it.

---

## 9 — Decisions needed

1. **Dror's standing condition — my half is met, one other half is not.** As
   regression-planner I agree the test suite is sufficient **for this fix**:
   the Python test pins the order and fails when it is reverted (mutation-checked),
   the new real-database test pins the redemption side's order and ran green in
   CI, and I reproduced both orders myself. The gaps I name — `tests/scripts`
   absent from CI, and the TS test duplicating rather than importing teardown's
   order — are follow-ups, not merge blockers. **"Tests pass" is not currently
   true on the PR head**: CI is red for an unrelated `EADDRINUSE`. Re-run first.
   Integrator approval is not mine to give.
2. **Who owns the `group-document-to-plan` port collision** if the re-run
   reproduces it? Not #176.
3. **`tests/scripts` in CI** — yes/no, and which sprint owns it. It has no owner
   in the plan today, so it is surfaced here rather than assigned.
4. **`ready_private` is inside teardown's accepted range** while both live
   production trips sit in it. Deliberate, or worth tightening? Out of scope for
   this PR; nobody should decide it inside a merge.

### Provenance of load-bearing claims

- Lock semantics, both probe tables: measured by me, 2026-09-25, PostgreSQL 16.15, scratch database, replica schema, production statements.
- Test counts and timings: measured by me, 2026-09-25, this Mac, in an isolated worktree.
- CI outcome and per-test results: read from run `35907191928` (2026-09-23).
- Production fleet: read 2026-09-25 via the read-only fleet MCP against the VM.
- `0045` applied on the VM: **inferred**, not read — an open `group` binding exists on a production trip and only the redemption path creates one.
- "VM provisioning is on for a real organizer", "cptest is shared": standing memory, not re-verified today; both are carried as constraints on the plan, not asserted as facts.
