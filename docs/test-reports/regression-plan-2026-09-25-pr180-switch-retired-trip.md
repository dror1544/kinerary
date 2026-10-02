# Regression plan — PR #180: `/switch` refuses a retired trip (#105)

**Verdict: low blast radius, fully reversible, no migration. The new test plus
the existing suites are SUFFICIENT; nothing missing blocks the merge. A short
assessment is enough.** The residual teardown race is real (I reproduced it
against Postgres) and is the same one `bind_chat_to_trip` and
`redeemGroupBindingToken` already document and accept. It is not new and the
PR does not make it worse. One claim in the brief is wrong: the slug `UPDATE`
**does** conflict with the switch's FK lock. No deadlock follows from that
(§3c).

Assessed 2026-09-25 by `regression-planner`, branch mode, on the staged
merge of PR #180 (head `a4720c8`) into `integration/sprint-6` (`d1c44af`), in
worktree `agent-aba02dca82603a2d2` (branch `throwaway/int180`). Nothing
committed, nothing deployed.

---

## 1 — Change set

| PR | Branch | Files in the merged tree |
|---|---|---|
| #180 | `fix/105-switch-refuses-retired-trip` @ `a4720c8` | `control-plane/api/src/organizer-trips.ts` (+6), `control-plane/api/test/organizer-trips.test.ts` (+20) |

- `git diff --cached --stat` and `git diff --stat HEAD...a4720c8` (merge-base
  `4769a3f`) both show exactly these 2 files and 26 insertions.
- `gh pr view 180 --json files` also lists `docs/sprint6-tracks.md`. That change
  is already on `integration/sprint-6` in `4769a3f`, so the merge adds nothing
  there. GitHub's file list includes it and the merged tree does not.
- Sibling PR #181 (`8d8cbd8`) is out of scope. Per `gh pr view 181`, it touches
  `relay/dispatch.ts`, `connector.ts`, `poller.ts`, `server.ts`, `analytics/*`,
  migration `20260925143012_assistant_events.sql` and `migrations.test.ts`.
  Neither `organizer-trips.ts` nor `organizer-trips.test.ts` appears in that
  list, so the two PRs share no path. They do meet at runtime:
  `dispatch.ts:1075` calls `switchChatToTrip`. A #181 change to `applySwitch`
  or to the `/switch` branch of `dispatch.ts` would need a second look when
  #181 is assessed.

## 2 — Risk table

| Change | Surface (§2) | Blast radius | Migration? | Compat break? | Risk | Test | Minutes | Batched / isolated |
|---|---|---|---|---|---|---|---|---|
| `switchChatToTrip` ownership SELECT JOINs `trips` and applies `NOT_RETIRED_SQL` | `control-plane/api/src/`. The behaviour lives in the **relay** process, because `relay/dispatch.ts` is the only caller | organizers who use `/switch` or tap a `/trips` button in a DM. Groups are refused earlier (`NOT_PRIVATE_CHAT`) | none | none. It only narrows who gets `NOT_YOURS` | **low**. Fail direction is refusal, the refusal copy is unchanged, and the change is reversible by redeploying the previous rev | `organizer-trips.test.ts` (30 tests) | 0.3 measured | alone. Nothing else rides on it |

## 3 — Migration and compatibility findings

- **No migration.** No file under `control-plane/db/migrations/`, and no
  change to `migrations.test.ts`'s expected list from this PR. #181 adds one.
- **Release seal, intake schema, `trip.config.json`, needs/agent schema:**
  none touched. Nothing under `site/`, `server/` or `shared/`, and no new
  release.
- **Two writers, one shape.** `telegram_chat_bindings` has four writers. After
  this PR, three of them refuse a retired trip:

  | Writer | Retired check | Source |
  |---|---|---|
  | `switchChatToTrip` | **this PR** | `organizer-trips.ts:318` |
  | `redeemGroupBindingToken` | yes, `NOT EXISTS` subquery | `group-binding.ts:255-259` |
  | `bind_chat_to_trip` (worker) | yes, a slug SELECT first | `provisioner.py`, `TripRetired` |
  | `scripts/switch-trip-chat.py` | **none**. `grep retired` finds nothing | an operator test tool whose header says "do not grow it" |

  The fourth writer is operator-only and outside this PR. It is listed so that
  nobody reads "every binder is guarded" into this change.
- **The JOIN cannot drop a legitimate row.** `trip_memberships.trip_id` is
  `NOT NULL REFERENCES control_plane.trips(id)` (`0001_foundation.sql`), so an
  inner join loses no membership. `slug` is `NOT NULL`, so `NOT LIKE` is never
  NULL. The five existing "switched" tests all go through the new JOIN and
  pass (§5).

### 3c — Lock behaviour against `retire_in_db` (the brief's reading, checked)

The brief's reading was: a plain SELECT takes no row locks, the INSERT takes
FOR KEY SHARE on the trip through the FK, and "a non-key slug UPDATE does not
conflict with" that.

- **Part 1: the JOIN takes no row lock. VERIFIED.** With `pgrowlocks`, after
  the ownership SELECT runs inside an open transaction, `control_plane.trips`
  shows `[]` (experiment E0 below).
- **Part 2: the INSERT takes FOR KEY SHARE on the trip row. VERIFIED.** After
  the INSERT, `pgrowlocks('control_plane.trips')` reads `{"For Key Share"}` on
  the target row.
- **Part 3: "a non-key slug UPDATE does not conflict". REFUTED.** `trips.slug`
  is declared `slug text NOT NULL UNIQUE` (`0001_foundation.sql:13`).
  PostgreSQL treats an UPDATE to a column that has a non-partial unique index
  as a key update and takes the **FOR UPDATE** row lock. `pgrowlocks` shows
  `{Update}` held by the teardown transaction, and that lock conflicts with FOR
  KEY SHARE. I measured it both ways:
  - **E1:** the switch INSERTs first. Teardown's slug UPDATE then blocks, with
    `wait_event=transactionid`, until the switch commits.
  - **E2:** teardown renames first. The switch's INSERT then blocks until
    teardown commits.

  The #176 deadlock depended on this same conflict: the redemption's FK lock
  waited on the renamed trips row. `group-binding.ts`'s own docstring already
  assumes it.
- **Conclusion: the JOIN changes nothing about locking, and there is still no
  deadlock.** A deadlock needs each side to wait on a lock the other holds. The
  switch waits on teardown at only two points:
  - **At the `FOR UPDATE` on the chat's open binding (E3).** At that moment the
    switch holds no row locks at all.
  - **At the FK check on its INSERT (E2).** It then holds the chat's *previous*
    binding row, which is on a different trip, plus its own uncommitted row.
    Teardown's `UPDATE … WHERE trip_id = <retired>` does not qualify the other
    trip's row, and teardown never touches token rows or sessions that the
    switch holds.

  In the other direction, teardown waits on the switch only at the slug UPDATE
  (E1). The switch's FK lock comes from its last statement before `COMMIT`, so
  the switch never waits after that point. Two more interleavings are safe by
  inspection:
  - **Moving the chat *away from* the trip being retired:** teardown waits on
    the switch's FOR UPDATE row, then re-evaluates it as already closed and
    skips it.
  - **Retiring the trip the chat is moving to:** this is E1 or E2.

  No interleaving produces a cycle. The `#175` reorder in `teardown-trip.py`
  (tokens first) is irrelevant here, because the switch never touches
  `telegram_group_binding_tokens`.

<details><summary>Lock experiments: method and raw output</summary>

**Setup.**
- Private throwaway Postgres 16 (`postgres:16-alpine`, container
  `regplan-pr180-locks`, `127.0.0.1:5441`, database `regplanlocktest`). This
  is **not** `cptest` and not the other session's `pr180-regplan-pg`.
- Schema from the real migrations, applied by running
  `organizer-trips.test.ts` against that database.
- Two `pg` clients, plus one observer that reads `pgrowlocks` and
  `pg_stat_activity`.
- The switch statements are copied from `organizer-trips.ts:308-384` on the
  merged tree.
- The teardown statements are copied from `scripts/teardown-trip.py:579-584`
  (the rename branch: revoke tokens, close bindings, rename slug, expire
  sessions).
- "BLOCKED" means the statement had not returned after 1.5 s.

**Raw output:**

```
E0 plain JOIN SELECT row locks
   trips rowlocks after ownership SELECT: []
E1 switch INSERT first, then retire_in_db
   trips rowlocks after A INSERT: [{"locked_row":"(0,1)","modes":"{\"For Key Share\"}"}]
   B slug UPDATE: BLOCKED wait={"wait_event_type":"Lock","wait_event":"transactionid"}
   A COMMIT / B slug UPDATE now: done / B COMMIT
   open bindings: [{"chat_id":"111222333","slug":"retired-lockx-2026-20260925"}]
E2 retire_in_db through slug rename first, then switch
   trips rowlocks held by B: [{"locked_row":"(0,1)","modes":"{Update}"}]
   A ownership rows=1   (B's rename is uncommitted, so the switch still sees a live trip)
   A INSERT: BLOCKED ... / B COMMIT / A INSERT now: done / A COMMIT
   open bindings: [{"chat_id":"111222333","slug":"retired-lockx-2026-20260925"}]
E2' same, with a post-INSERT re-check of the slug in the switch
   A recheck rows=0 -> ROLLBACK
   open bindings: [{"chat_id":"111222333","slug":"locky-2026"}]   (race closed in this order)
E3 chat already bound to X; teardown closes bindings first; switch-to-X waits on FOR UPDATE
   A FOR UPDATE: BLOCKED / B COMMIT / A FOR UPDATE rows=0 -> proceeds to INSERT / A COMMIT
   open bindings: [{"chat_id":"111222333","slug":"retired-lockx-2026-20260925"}]
E4a HYPOTHETICAL: teardown renames BEFORE closing bindings + switch re-checks after INSERT; switch first
   B closed bindings: 1   open bindings: []
E4b same hypothetical, teardown first
   A recheck rows=0 -> ROLLBACK   open bindings: [{"chat_id":"111222333","slug":"locky-2026"}]
```

**What E3 shows.** The race also turns an "unchanged" tap into a fresh stale
binding. That happens when the organizer is already on X and taps X at the
same moment X is torn down: the switch's FOR UPDATE waits, finds the row now
closed, and inserts a new one.

**What E4 shows.** In both orders, the race closes if two things change
together: teardown renames the slug *before* it closes bindings, and each
binder re-checks the slug after its INSERT. This is measured for the switch
only. It is **not** measured against `redeemGroupBindingToken` or
`bind_chat_to_trip`, and it would reorder the transaction that #175 just
reordered. It is a follow-up idea, not part of this PR.

Scripts are in the session scratchpad and are not in the repo.

</details>

## 4 — Live-fleet impact

- **Where the behaviour runs.** `switchChatToTrip` has exactly one call site,
  `relay/dispatch.ts:1075`, inside `applySwitch`. That function is reached from
  two paths:
  - a typed `/switch <name>`, where the target is resolved from
    `listOrganizerTrips` at `dispatch.ts:709`;
  - a tapped `/trips` button, where the target is re-derived from
    `listOrganizerTrips` at `dispatch.ts:1136`.

  `organizer-trips.ts` is also imported by `chat-router.ts` and `interview.ts`.
  They use its other exports, not `switchChatToTrip`. So the change is felt
  only once the **relay** runs the new build.
- **Who feels it.** Only an organizer who switches, in a DM, to a trip that was
  torn down. Both paths already filter retired trips through the list
  (`organizer-trips.ts:204`), so before this PR the only way through was the
  gap between the list read and the switch transaction. After it, the refusal
  sits inside the function. That is a defence-in-depth fix: in practice it
  closes the path a future caller would open by bypassing the list, and it
  narrows the race window by the list-to-switch gap. The user-visible behaviour
  for a normal switch is identical.
- **Per-trip redeploys.** None. No release, no trip container, no companion or
  prompt refresh, and nothing depends on the pinned-release asymmetry.
- **Does production have `/switch` at all? Could not determine. This is a
  decision input, not a finding.**
  - `/trips` and `/switch` arrived in `c3ac940` (2026-09-12).
    `organizer-trips.ts` **does not exist on `origin/main`** (`130924b`,
    2026-09-23, per `git ls-tree`). `c3ac940` is contained only in sprint-6
    branches (`git branch -r --contains`).
  - The VM's relay runs `kinerary-cp/agent-runtime:${KINERARY_REV}`
    (`compose.vm.yml:192-194`). If that rev is main-derived, production has no
    `/switch` and this fix reaches production only when sprint-6 merges to
    `main` and a new rev is cut.
  - I could not read `KINERARY_REV`. Finding it needs a read of the VM's
    `vm.env`, or `sudo kinerary-cp-release` status on the VM.
- **Live fleet: not read today by me.** I found no `fleet-stacks.json` in any
  of the places `fleet-mcp.mjs` looks:
  - this worktree's root;
  - `/Users/elul/kinerary/`;
  - the skill directory;
  - `~/.config/kinerary/`;
  - the top level of `~/kinerary-deploy`.

  I did not open an ad-hoc production shell. Carried from
  `regression-plan-2026-09-25-pr176-group-binding-deadlock.md` §4 (read the
  same day through the fleet MCP, not re-verified): two real trips are
  `ready_private` (`orlando-florida-2026`, and the Japan family trip with an
  open group binding), plus a long tail of `retired-*` trips. Teardown is run
  against production regularly.
- **Owed before a VM deploy. Read-only, one query:**
  ```sql
  SELECT b.chat_id, t.slug, b.created_at
    FROM control_plane.telegram_chat_bindings b
    JOIN control_plane.trips t ON t.id = b.trip_id
   WHERE b.closed_at IS NULL AND t.slug LIKE 'retired-%';
  ```
  Empty means no stale binding exists today. Any row is #105 already live, and
  it is cleaned up as described in §Sufficiency (b).

## 5 — The plan

| # | Run | Command | Checklist | Minutes | Who |
|---|---|---|---|---|---|
| 1 | organizer-trips file against a **private** test DB | `CONTROL_PLANE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:<own port>/<name containing "test"> npm test --prefix control-plane/api -- …` (or `node --import tsx --test test/organizer-trips.test.ts`) | 30/30 pass, including `a RETIRED trip … (#105)` | **0.3, measured** (17.8 s wall, 30 pass, 0 fail, 2026-09-25) | nobody |
| 2 | Full control-plane API suite, private DB | `CONTROL_PLANE_TEST_DATABASE_URL=… npm test --prefix control-plane/api` | no failures, and no expected-noise failures from this PR (it adds no migration) | **17.4, measured**: 1615 tests, 1609 pass, 0 fail, 6 skipped (live extraction and Vault, which need external deps), 1042 s wall, 2026-09-25, Mac, private DB | nobody |
| 3 | `verifier` pass | whatever it selects | the integrator's standing condition | its own | — |

No end-to-end walk. `/switch` has never been part of the scenario walks, and
the path this PR changes is reachable only by a race that a walk cannot
provoke.

**Mutation check (done, 2026-09-25).** I ran the new test against the pre-fix
`organizer-trips.ts` (`git show HEAD:…`, restored from the index afterwards;
`git status` confirmed the staged tree was unchanged). Result: `not ok 1 - a
RETIRED trip …`, `# fail 1`. With the fix it passes. The test detects the
regression it was written for.

## 6 — Budget

- **Minimum gate:** runs 1 and 3. The organizer-trips file is the only suite
  that exercises the changed function, and it takes 18 seconds.
- **Run 2 (full API suite)** buys regression cover on the rest of the relay and
  API code. This PR changes one query in one function with one caller, so it
  adds little. It is the verifier's normal job anyway.
- **Not worth buying:** an E2E walk, a VM rehearsal, a migration rehearsal.

Full-suite result, measured here on the merged tree against a private DB on
2026-09-25: **1615 tests, 1609 pass, 0 fail, 6 skipped, 1042 s.** The six
skips are `a real extraction of the fixture…` and five `vault://` tests. They
need external dependencies and are unrelated to this PR.

## 7 — Go / no-go and the way back

- **Stop the merge if:** any `organizer-trips.test.ts` test fails after a
  re-run of the file alone (`cptest` and concurrency flake rules apply), or the
  verifier finds a failure that survives isolation.
- **Snapshot:** none needed for this PR. There is no migration and no data
  write.
- **Way back:** redeploy the previous rev. A VM rev change goes through
  `sudo kinerary-cp-release rollback` (dry-run first), which takes its own
  snapshot. Rolling back re-opens only the list-to-switch window.
- **Relay restart:** any rev carrying this recreates the relay. Use
  `control-plane/deployment/vm-relay-restart.sh` on the VM, never the Mac's
  script, and honour its `awaiting = 'machine'` refusal. A restart in the middle
  of a turn drops that turn. Hard rule 2 applies, and the deploy is Dror's call.

## 8 — What would reduce the risk

Ranked by risk removed per minute:

1. **Run the one stale-binding query in §4 against production before the next
   VM deploy.** About 2 minutes, read-only. It tells you whether #105 is live
   today, whatever this PR does.
2. **Make a stale binding loud.** Add the same query to the fleet monitor as an
   alert. Today `fleet-mcp.mjs` classifies `retired-*` trips as "torn down on
   purpose — not a problem" (lines 244, 271, 435) and excludes them from the
   unreachable list (399, 408). An open binding to a retired trip is therefore
   silent, and the organizer is the only one who notices. About 30 minutes. It
   is a monitor change, so it belongs in a separate issue.
3. **Follow-up issue: close the binder/teardown race for real.** E4 above
   points at the shape: teardown renames before closing bindings, and each
   binder re-checks the slug after its INSERT. It needs its own lock-order
   rehearsal against all three binders, because it reorders the #175
   transaction. Not for this PR.
4. **Nothing else for this PR.** It is small, reversible, and has no
   migration. Asking for more tests would buy little.

## 9 — Decisions needed

- **Which rev is the VM running?** If it is main-derived, this fix and every
  `/switch` behaviour reach production only through the sprint-6 → `main`
  merge. Someone with VM access has to read `KINERARY_REV`.
- **Accept the residual race here, as `bind_chat_to_trip` and
  `redeemGroupBindingToken` already do?** My recommendation is yes, with item 3
  as a separate issue. This is `sprint-scribe`'s or Dror's call to file. I have
  not filed anything.
- **`scripts/switch-trip-chat.py` has no retired check.** It is an operator
  test tool. Is that acceptable, or should it refuse retired trips like the
  other three writers? Outside this PR.

---

## Sufficiency

**(a) The new test plus the existing suites: SUFFICIENT.** No missing test
blocks the merge.

- **The new test covers the right contract.** It calls `switchChatToTrip`
  directly with a trip the sender still holds an active membership on, renamed
  to `retired-italy-2026-20260920`. It asserts three things: `NOT_YOURS`, no
  open binding, and no binding row at all, open or closed. Calling the function
  directly is the right choice: both dispatch paths already filter retired
  trips through the list, so a dispatch-level test would pass without the fix.
  I ran it both ways (§5): it fails on the pre-fix source and passes on the
  merged tree.
- **The callers are already covered.**
  - The typed `/switch` path (`dispatch.ts:709` → `resolveTripArgument` →
    `applySwitch`) and the callback path (`dispatch.ts:1136` → `trips.find` →
    `applySwitch`) both take their target from `listOrganizerTrips`.
  - `listOrganizerTrips` excludes retired slugs (`organizer-trips.ts:204`).
    That is asserted by "never lists a trip that was torn down"
    (`organizer-trips.test.ts:207-221`), and the "destroyed" variant covers the
    other marker.
  - There is no other caller, in `src/`, `tools/` or tests.
- **No existing test binds a chat to a retired-prefix trip.** The fixture slugs
  are `italy-2026`, `japan-2026` and `stranger-2026`. The only `retired-`
  slugs in `organizer-trips.test.ts` are at line 216 (the list test), line 360
  (the new test) and line 673 (`hasEarlierBuiltTrip`), and none of those calls
  `switchChatToTrip`. The other files that use `retired-` slugs are
  `group-binding.test.ts:232`, `relay-gateway-wait.test.ts:102-103` and
  `organizer-invite.test.ts:394`. None of them calls `switchChatToTrip`, so no
  existing expectation changes. All 30 tests in the file pass on the merged
  tree, and the five "switched" tests all go through the new JOIN.
- **Missing, non-blocking:**
  - A concurrency test pinning the accepted race (E1, E2 or E3). It would
    document the race, not prevent it. Worth writing only together with the
    follow-up fix.
  - A dispatch-level `/switch retired-…` test. This is already transitively
    covered by the list tests.
- **Pre-existing, unrelated, non-blocking.** The `describe("a returning
  organizer's second trip")` block at `organizer-trips.test.ts:591` has no
  `{ skip: SKIP }` (since `fc13b7d`, 2026-09-18). With no test database set,
  the file reports `# fail 5` instead of skipping (measured today with the
  variable unset). CI sets `CONTROL_PLANE_TEST_DATABASE_URL`
  (`.github/workflows/control-plane.yml:91,140`), so CI is unaffected. This
  bites only a local run without a database. Not this PR's concern.

**(b) Cost of the residual race on live trips: tiny probability, a confusing
but recoverable outcome, and nothing detects it.**

- **The window.** The window is the span from the ownership SELECT to COMMIT,
  a handful of statements: milliseconds. It needs an organizer's `/switch` or
  tap to land inside the same few milliseconds as an operator's hand-run
  `teardown-trip.py --execute` on that same trip. I reproduced all three
  interleavings (E1, E2, E3). The window is **not new**. Before this PR the
  same outcome came from the gap between the list read and the switch
  transaction, which was about as narrow. It is the same accepted race that
  `bind_chat_to_trip` documents (`provisioner.py` docstring: "a teardown that
  renames the slug between this SELECT and the INSERT below would not be seen.
  Accepted as a narrow residual risk"). `redeemGroupBindingToken` documents a
  sharper version (`group-binding.ts` docstring).
- **Live exposure.** `ready_private` trips can be torn down
  (`REFUSED_STATES = {activation_approved, active, completed, sealed}`). Per
  the #176 plan, both real production trips sit at `ready_private`. So the race
  is reachable against a real family's trip, though only if an operator tears
  down a trip its own organizer is switching to at that moment.
- **What the user sees.**
  - The stale binding routes the DM as a `companion` route (`resolveChatRoute`
    does not filter retired trips).
  - The retired trip's profile has been deleted, so `normalize.ts:496-498`
    (`canReach` false) or `:484` (NULL profile) returns `COMPANION_PENDING`.
  - The organizer then gets "Your trip is set up and the site is ready — I'm
    still finishing your assistant. Try me again shortly." (`dispatch.ts:306`)
    on **every** message. That is a false sentence about a trip that no longer
    exists.
  - The relay-restart cost that #105 originally carried (the full gateway-wait
    timeout on every restart) is gone: `expectedGatewayProfiles` excludes
    retired trips (`gateway-wait.ts:48`).
- **How it is cleaned up today.**
  - **Self-heal by the organizer.** `/trips` hides the retired trip. `/switch`
    to any other live trip of theirs closes the stale row
    (`closed_reason = organizer_switch`). An organizer with no other live trip
    is stuck.
  - **By the operator.** Re-run `scripts/teardown-trip.py --trip <retired-slug>
    --execute`. Its `database` step is planned whenever `open_bindings > 0`
    (`teardown-trip.py:636-640`), and `retire_in_db`'s already-retired branch
    closes the open bindings and revokes tokens in one transaction (`:555-570`).
  - **Detection.** Nothing detects the row. The fleet monitor treats retired
    trips as expected noise. Hence item 2 of §8.

**(c) Lock behaviour.** The JOIN does not change it. Two parts of the brief's
reading are verified; the third is refuted:

- The plain SELECT takes no row locks: **verified.**
- The INSERT takes FOR KEY SHARE on the trip: **verified.**
- "A non-key slug UPDATE does not conflict": **refuted.** `slug` is `UNIQUE`,
  so teardown's rename takes FOR UPDATE (`pgrowlocks` shows `{Update}`), and
  that conflicts with FOR KEY SHARE. It blocks in both orders (E1, E2).

It still cannot deadlock. The switch's trips lock comes from its last statement
before COMMIT, and no interleaving has teardown waiting on something the switch
holds while the switch waits on teardown. §3c has the details and raw output.
The conflict only serialises the two transactions by a few milliseconds. The
deliberate "no lock" choice from #175 is sound.

**(d) What must be redeployed.**

- **The relay only, for behaviour.** It is the sole caller. In practice that
  means a new control-plane rev with the relay recreated on it:
  - On the VM: `sudo kinerary-cp-release upgrade` (dry-run first), with the
    relay restarted through `vm-relay-restart.sh`, around live conversations.
  - On the Mac staging stack: `npm run build` in the served worktree, then
    `scripts/relay-restart.sh`.
- **Nothing else.** No migration, no `shared/`, no `server.js`, no release, no
  per-trip redeploy, no companion refresh.
- **Could not check without production access:**
  - the VM's `KINERARY_REV`, which decides whether production has `/switch` at
    all, since `organizer-trips.ts` is absent from `origin/main`;
  - whether any open binding to a retired trip exists in production today (the
    query is in §4);
  - the current fleet list, which is carried from the #176 plan and not
    re-read.

**A short assessment suffices.** This is one query in one function with one
caller, no migration, a reversible deploy and a mutation-checked test.

---

### Provenance

- **Lock semantics:** measured by me, 2026-09-25, PostgreSQL 16.15, a private
  scratch database built from the real migrations, with the production
  statement text.
- **`organizer-trips.test.ts`:** 30/30 pass in 17.8 s, measured 2026-09-25 on
  the merged tree. The mutation run gave 1/1 fail on the pre-fix source.
- **Full `control-plane/api` suite:** 1609 pass, 0 fail, 6 skipped of 1615, in
  1042 s, measured 2026-09-25 on the merged tree against the private database
  `regplanlocktest` (not `cptest`).
- **Fleet contents:** carried from
  `regression-plan-2026-09-25-pr176-group-binding-deadlock.md` §4, and not
  re-verified.
- **"VM provisioning on for a real organizer" and "cptest is shared":**
  standing memory, not re-verified. Carried as constraints only.
- **Where `/switch` lives:** `git ls-tree origin/main` (fetched 2026-09-25) and
  `git branch -r --contains c3ac940`.
