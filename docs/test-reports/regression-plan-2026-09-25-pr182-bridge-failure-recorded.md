# Regression plan: PR #182, a bridge failure recorded durably (2026-09-25)

**Verdict: OK to merge into `integration/sprint-6` for one narrow purpose.** After this change, a trip-mcp bridge failure during a worker run stays recorded when the chat binding succeeds afterwards. Two tests pin that, and both fail on the base code (measured below). The PR does **not** fix #119, does **not** help the two live production trips, and does **not** show that the agent key stays out of logs. Before a VM upgrade ships this change, one small consumer follow-up should land (section 8, item 1). Without it, `kinerary-cp-release restart-bridges` and the upgrade `verify` step skip exactly the trips this change marks as broken.

Mode: branch / pre-deploy. This replaces `regression-plan-2026-09-25-pr182-keep-bridge-key-stable.md`, which assessed the rejected NFS keep-file design. None of that plan's conclusions are reused here. I re-read the live fleet today through the read-only fleet MCP (`fleet-mcp.mjs`, stack `prod`). Nothing was written to production and nothing was deployed. The only writes were three private scratch databases on the test Postgres (`:5434`, `cptest_rp182_{pr,base,mut}`), created and then dropped.

---

## 1. Change set

| | |
|---|---|
| PR | #182 `fix(sprint6.4): record a failed trip-mcp bridge run as a reachability fact and keep it (#119)`, OPEN, MERGEABLE, all 7 CI checks SUCCESS (read 2026-09-25) |
| Branch | `origin/fix/119-keep-bridge-key-stable` @ `69f3ff4`, merged onto `origin/integration/sprint-6` @ `4f283d0`. `merge-tree` is clean, tree `ba573360`, and it equals this worktree's index. |
| Commits | `e6e1a16` (the **rejected** keep-file design: adds 22 lines to `provisioning/adapters.py`, and its message says "the key is now kept on the trip's own NFS mount"). `69f3ff4` (removes it). |
| Net diff (3 files) | `control-plane/worker/control_plane_worker/provisioner.py` +13/−1 · `control-plane/worker/tests/test_provisioner.py` +67 · `tests/provisioning/test_adapters.py` +57 |
| Not changed | `provisioning/adapters.py` is byte-identical to the base (it is not in `git diff origin/integration/sprint-6...origin/fix/119-keep-bridge-key-stable --stat`). |

## 2. Risk table

| Change | Surface (§2) | Blast radius | Migration | Compat break | Risk | Test | Min | Batch |
|---|---|---|---|---|---|---|---|---|
| `bridge_failed` skips `_record_reachability(reachable=True)` after a raised bridge (`provisioner.py:1930`) | worker (VM redeploy) | Only trips provisioned or reconciled after the upgrade whose bridge **raises**. Settled trips are untouched. | no | Behavioural. Three existing consumers now **exclude** these trips (section 3.2). | Medium, driven by the consumers rather than the line itself | 2 DB tests. Both fail on base. | <1 (suite 15 s) | isolated: it is a silent-state change, so assert the column |
| New worker tests (order, no-bridge-on-failed-deploy, "no key logged") | none | none | – | – | The "no key logged" test is **tautological** (section 3.3) | – | – | – |
| Adapter tests (second bootstrap mints a new key; no `set -x`/echo of the key) | none | none | – | – | Characterise the defect. A future real fix for #119 point 1 must flip them. | ran them | <1 | – |

## 3. Migration and compatibility findings

### 3.1 No SQL, no release, no seal
There is no migration file. `unreachable_reason` is free text in SQL: `0042_trip_reachability.sql` only requires `unreachable_reason IS NOT NULL` when unreachable, and the closed set lives in Python (`UNREACHABLE_REASONS`). Nothing under `site/`, `server/` or `shared/` changed, so there is no new release and `artifactDigest` does not change.

### 3.2 The real compatibility change: who reads `reachability = 'unreachable'`
The reason `TRIP_MCP_BRIDGE_FAILED` is already on `integration/sprint-6` (it came in with `1ab5c31`). It is **not on `origin/main`**: `git grep` finds 0 matches. On base it was *always* overwritten, because every path after the bridge writes a reachability value. A bound chat wrote `reachable`, and the others wrote `NO_ORGANIZER_CHAT`, `BINDING_REFUSED`, `TRIP_RETIRED` or `BINDING_FAILED`. So this PR is the first time a trip with an **open, profile-bearing binding** can sit at `unreachable`. Before, only a later failed companion install could produce that combination. Every consumer, read on 2026-09-25:

| Consumer | Query / code | Effect of a durable `TRIP_MCP_BRIDGE_FAILED` | Acceptable? |
|---|---|---|---|
| Fleet monitor: `fleet-mcp.mjs` `alerts` (:880), `list_trips`, `fleet_overview` (:397) | `WHERE t.reachability = 'unreachable'` | Intended. A live trip now alerts, quoting the reason. The alert cron only calls a model when the text changes, so there is no spam. `SOUL.md:41-43`'s reason list omits `TRIP_MCP_BRIDGE_FAILED` and `TRIP_RETIRED` (doc drift, not a failure). | yes |
| `/trips` (`chat-router.ts:1120`, `intake-copy.ts:587/727`) | `reachability === "unreachable"` → `(site not responding)` / `(האתר לא מגיב)` | A real organizer is told the **site** is not responding. The site works. What is broken is the companion's ability to read it. | Wrong copy, organizer-facing. Low harm, but false. |
| Relay restart: `gateway-wait.ts:47` `expectedGatewayProfiles` | `AND t.reachability <> 'unreachable'` | The trip's companion is dropped from the post-restart wait. Its gateway **is** running (only its trip tools fail). Messages sent during its reconnect backoff (up to 30 s, per the file header) can get the canned `COMPANION_PENDING` reply and be consumed. | Degrades a trip that is already degraded. Small. |
| **`vm-release.py:1270` `live_companions()`** (not in the brief) | `AND t.reachability <> 'unreachable'` | Used by **`kinerary-cp-release restart-bridges`** (:1851) and by upgrade/rollback **`verify`** (:1341). Both now **skip exactly this trip**. The operator's standard bridge repair tool never restarts the one broken bridge, and the post-upgrade verify never reports it. Before the PR the trip read `reachable` and was included. | **No.** This is a regression in the repair path. Fix before the VM upgrade (section 8, item 1). |
| Anything that **clears** it | The only `reachable=True` write in the repo is `provisioner.py:1931` (`git grep`, 2026-09-25) | A manual `setup-mcp.sh` re-run, or `restart-bridges`, repairs the bridge and leaves the fact standing **forever**. Only a worker run that reaches `_attach_companion` clears it: a re-provision, or `python -m control_plane_worker --reconcile-companion <trip_id>` (`__main__.py:59`). That tool needs `ready_private`, a succeeded provision and a resolvable organizer. It re-runs install (ALREADY_PRESENT) and the bridge, and queues the introduction at most once. | Acceptable once written down. The repair exists but no runbook names it for this reason. |

Also, the reason is single-slot. After a bridge failure, a missing organizer chat or a refused binding still overwrites `TRIP_MCP_BRIDGE_FAILED` with `NO_ORGANIZER_CHAT` or `BINDING_REFUSED`. The trip is still `unreachable`, so the monitor still alerts, but the bridge half of the story is lost. This existed before the PR and is noted, not blocking.

### 3.3 Do the tests pin what they claim? (measured 2026-09-25)
I ran the 4 new or extended worker tests against the merged tree and against the same tree with the **base** `provisioner.py`, on private scratch DBs:

```
=== pr    Ran 4 tests  OK
=== base  FAILED (failures=2)
  test_a_bridge_failure_is_not_logged_with_a_key        AssertionError: None != 'TRIP_MCP_BRIDGE_FAILED'
  test_a_failing_bridge_does_not_block_the_chat_binding AssertionError: ('reachable', None) != ('unreachable', 'TRIP_MCP_BRIDGE_FAILED')
```
The `bridge_failed` fix **is** pinned. The PR body says the reverse ("the rest are characterisation tests that pass on the base tree"). That is wrong, in the harmless direction.

**`test_a_bridge_failure_is_not_logged_with_a_key` is tautological in its key half.** I mutated only the fake (`LeakyBridge`) to raise `"... HERMES_API_KEY=" + "ab"*32`, and the test **failed**. The traceback, key included, is in the captured WARNING, because `provisioner.py:1753` logs with `exc_info=True`. So the worker does **not** "record a reason, not repeat detail", as the test comment claims. It repeats the adapter's exception text verbatim. Both real adapters put the remote script's output in that text: `SshMcpBridgeAdapter` uses `(stderr or stdout)[-500:]` (`mcp_bridge.py:156`), and `ShellMcpBridgeAdapter` uses `stderr[:500] or stdout[:500]` (:223). Whether a key can reach that output is a property of `companion-install-host.sh` plus `setup-mcp.sh`, and this test never touches either. One lead, read from the Mac's copy of the private `setup-mcp.sh`: its no-`--vmid` branch prints `Add HERMES_API_KEY=<key>` to stdout (:369). The worker always passes a vmid, so I did not find a reachable leak. I did not read the VM's copy. The test's only real assertion is the reason column, which duplicates the extended test. Rename it, or make it assert something true: pass a key-bearing error and require that it is redacted. That second option is a code change.

**"Exactly one bridge re-run after every deploy"** holds for the path the test drives: one `run_once`, fakes, a companion that installs. On real code the order is structural. The bootstrap happens inside `deploy()` (`compute.create_container` → `Provisioner.apply` → `create()`/`bootstrap()`), and the bridge runs in `_complete` → `_attach_companion` after the job commits. It does **not** hold when:
- the handoff is `None`, `install()` returns `None`, or `install()` raises. Then there is no bridge run after a deploy that may have bootstrapped. Reachability records `COMPANION_*` or `ORGANIZER_UNRESOLVED`, so it is at least loud.
- `setup()` returns `False` (no vmid, port or topology), or the adapter is `NullMcpBridgeAdapter`. Then there is no bridge run, and `reachable` **is** written. This is silent, and the PR body acknowledges it.
- the deploy raises after the bootstrap minted a key (deploy.sh, NPM or Cloudflare fails). Then there is no bridge run. A retry does not re-mint, because `.env` now exists, and wires the bridge. If all 3 attempts fail, a previously wired bridge on a re-provisioned trip stays stale. `test_no_bridge_run_when_the_deploy_did_not_complete` pins this as intended, and its fake fails before any bootstrap, so it cannot show the "bootstrap, then fail" case.
- A re-run of an existing job: `_claim` takes only `queued` jobs, and a lease-expired job re-runs the whole body. So "one per run" holds.
- `FakeDeployAdapter` never bootstraps, so the test pins **call order**, not "after a bootstrap". Whether the re-run picks up the new key is up to `setup-mcp.sh`, which is private and untested here (section 5).

The adapter tests run the real bootstrap block in bash (39/39 OK, measured). They are genuine: the keep-file design fails them. They pin the defect's mechanism, so whoever fixes #119 point 1 must rewrite them on purpose.

## 4. Live-fleet impact (read 2026-09-25, `fleet-mcp.mjs --stack prod`, read-only)

- Production has 52 trips. **Live, `ready_private`:** `orlando-florida-2026` (created 09-23, 1 provision job succeeded 1/3, private binding open) and `japan-tokyo-hakone-kyoto-osaka-2026` (created 09-14, 1 provision succeeded 1/3, private and group bindings open). Both read `reachable`. The `unreachable` filter returns none, and no failures affect live trips. There are 11 prospects (2 of them `intake_confirmed`, never built).
- **Production schema is `0051_trip_person_links.sql` (51 applied)**. The `bug_reports` tool says prod predates 0054. Production runs a pre-sprint-6 control plane, and `main` has no `TRIP_MCP_BRIDGE_FAILED` at all. **Both live trips' `reachable` means "a chat was bound", not "the bridge works".** Only a `/health` probe of their bridges can tell (a decision, section 9).
- **#119 exposure is unchanged from before.** `adapters.py` is identical, so the bootstrap still mints a fresh `HERMES_API_KEY` whenever `/opt/kinerary/.env` is absent (`adapters.py:309-323`). Both trips are exposed only *latently*. There is one provision each and no evidence of a re-bootstrap. The bridge-after-deploy order this PR tests already exists on base, and it passes there too.
- **Worker-driven bootstrap:** covered, given four conditions. (a) The trip dir on the bridge host has **no `trip.env`**, because `setup-mcp.sh` (Mac copy, :346-352) prefers `trip.env`'s key over the container's. The worker never writes one (`git grep`), but legacy or hand-made trips and anyone who ran `sync-env.sh` do. (b) The companion installs (section 3.3). (c) The job succeeds within its attempts. (d) The install host's forced command runs a checkout that has the `/health` check (#127, still OPEN, so on the VM this is unverified).
- **Not covered:** any change to `.env` outside a worker run. That includes a hand-run `python -m provisioning apply --execute`, `.env` recreated or restored by hand, and `setup-mcp.sh`'s own append path (:356-359, which writes a new key into a container `.env` that has none). It also includes `restart-bridges`/`--restart-only`, which reuse the bridge's stored key and never re-read the container's. Nothing periodic probes `/health`, so none of these is ever noticed.
- **After this PR deploys:** nothing changes on either live trip until a worker job touches it, for example an organizer correction that re-provisions it (`intake-correction.ts`) or a `--reconcile-companion`.

**Redeploy:** the **worker image only**. `Dockerfile:31` COPYs `control_plane_worker`, and `compose.vm.yml` runs `kinerary-cp/worker:${KINERARY_REV}` with no code overlay. On the VM that means `sudo kinerary-cp-release upgrade --dry-run`, then an upgrade to a revision that contains it. There is no API or relay restart, no migration and no release. On the Mac, `compose.local.yml:226` bind-mounts `control_plane_worker/`, so a worker restart from the right `WORKER_REPO_ROOT_HOST` is enough (`provisioning/` is unchanged this time). **Existing trips need nothing** for correctness.

## 5. The plan

| # | Run | Command | Checklist | Min (label) | Who |
|---|---|---|---|---|---|
| R1 | Merge gate | worker suite on a **private** test DB (not `cptest`); `tests/provisioning` | 540 OK / 39 OK | 1 (measured: 15 s + <1 s, Mac, 2026-09-25) | nobody. Done by verifier, and reproduced here |
| R2 | Consumer follow-up tests (after item 1 lands) | `npm test --prefix control-plane/api` on a private `*test*` DB; add a `TRIP_MCP_BRIDGE_FAILED` row to `relay-gateway-wait.test.ts`'s fixture; a `vm-release` unit or dry-run check for `live_companions()` | the bridge-failed trip is included in the wait and in `restart-bridges`; other unreachable reasons are still excluded | ~10 (estimate) | developer |
| R3 | Staging assertion, riding the next sprint-6 Mac e2e (`--scenario multi` or `manual`, **never `japan`**) | after the trip is built: `SELECT reachability, unreachable_reason FROM control_plane.trips WHERE slug=…` | healthy bridge → `reachable` (regression ring: the flag must not stop the healthy write) | +1 on an existing run | Dror (window; no VM overlap) |
| R4 | Staging failure drill (optional) | on that throwaway trip only: induce a bridge failure (e.g. move that trip's `topology.yaml` aside on the install host, so `companion-install-host.sh` dies with "no topology"), run `--reconcile-companion`, read the row, restore the file, run `--reconcile-companion` again | `unreachable/TRIP_MCP_BRIDGE_FAILED` survives the binding; reconcile clears it; `/trips` shows the label | ~20 (estimate) | Dror |
| R5 | Live bridge probe (decision, read-only) | on the VM, per live trip: `curl` the bridge `/health` with the key fed on stdin (as `bridge_reaches_trip` does) | `{"ok":true}` for both | ~5 (estimate) | Dror approves each |

## 6. Budget
- **Minimum to merge:** R1, already green. It proves the durable-fact fix and nothing broader.
- **Minimum before a VM upgrade that carries this:** item 1 of section 8 plus R2, about 30 min of developer time and ~10 min of tests (estimate). Without it, you are choosing that `restart-bridges` and `verify` go blind on precisely the broken trips.
- **+R3** (1 min on a run you are doing anyway) buys evidence that the healthy path still writes `reachable` on real adapters.
- **+R4** (~20 min) is the only thing that shows the fact survives on the real SSH adapter and that `--reconcile-companion` clears it.
- **+R5** (~5 min per trip) is the only way to know whether today's two live bridges work at all. Their `reachable` cannot tell you.

## 7. Go / no-go and the way back
- **Merge:** go, provided it is **squash-merged**. A merge commit carries `e6e1a16` into `integration/sprint-6`. That commit contains the rejected keep-file code and a message saying the key is kept on NFS, so a later revert or cherry-pick of `69f3ff4` alone would resurrect it.
- **VM deploy of a sprint-6 revision containing it:** no-go until item 1 lands, or until Dror explicitly accepts that `restart-bridges`/`verify` skip bridge-failed trips.
- **Way back:** `sudo kinerary-cp-release rollback`. There is no migration, so the database is kept. Rows written as `unreachable/TRIP_MCP_BRIDGE_FAILED` stay after a rollback. Clear them per trip with `--reconcile-companion` once the bridge is repaired.

## 8. What would reduce the risk (ranked by risk removed per minute)
1. **Keep bridge-failed trips in the repair and wait paths.** In `vm-release.py:1270` and `gateway-wait.ts:47`, change `t.reachability <> 'unreachable'` to `(t.reachability <> 'unreachable' OR t.unreachable_reason = 'TRIP_MCP_BRIDGE_FAILED')`: the gateway exists, and only its trip tools fail. Add one fixture row per test. About 30 min. Two surfaces: `control-plane/api` (relay restart) and the VM release tool. It can ride this sprint rather than this PR.
2. **Squash on merge**, or drop `e6e1a16` from the branch. About 0 min.
3. **Fix the tautological test.** Rename it to what it checks (the reason), or make the worker redact the exception text and assert that a key-bearing error is redacted. The first takes 2 min. The second is a small code change, and it is the only thing that would make "no key in the log" true.
4. **Write down the clearing step.** In the fleet monitor's `SOUL.md` reason list and the VM runbook, say that after any manual bridge repair you run `python -m control_plane_worker --reconcile-companion <trip_id>`, or the alert never clears. This belongs to `doc-keeper`. About 10 min.
5. **Correct the PR body** (section 9, item 4). About 5 min.
6. **`/trips` copy for this reason:** say "assistant can't read the trip yet" rather than "site not responding". It is organizer-facing Hebrew and English copy, so it is a product decision. About 20 min.

## 9. Decisions needed
1. Is item 1 a condition on the **merge**, or only on the **VM upgrade**? My recommendation is the upgrade.
2. Run R5 (probe the two live bridges' `/health`)? It is read-only but needs a VM shell and your approval per trip.
3. Change the `/trips` copy for this reason (item 6)?
4. PR body corrections for the author. Three points:
   - "every successful deploy is followed by exactly one bridge re-run": holds only when the companion installs and `setup()` does not skip.
   - "a bridge failure is recorded … with no key in the log": the key half is not tested.
   - "the rest pass on the base tree": two fail on base.

   The rest of the body holds up: "Refs", not "Fixes"; #119 stays open; live trips are not helped; #184 and #185 are filed and OPEN.

**Carried, not verified:** the VM's copy of `setup-mcp.sh` (I read the Mac's) · whether the VM's install-host forced command has `bridge_reaches_trip` (#127) · whether any live container's trip dir on the bridge host has a `trip.env`.
