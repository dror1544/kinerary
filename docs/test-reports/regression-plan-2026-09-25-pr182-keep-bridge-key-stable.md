SUPERSEDED by docs/test-reports/regression-plan-2026-09-25-pr182-bridge-failure-recorded.md: assessed the rejected keep-file design.

# Regression plan — PR #182 (keep a trip's agent key stable; keep a bridge failure recorded), 2026-09-25

**Verdict:** the suite is enough to merge into `integration/sprint-6`. It is **not** enough to say #119 is fixed on real trips. Nothing in this PR reaches production until the worker image is rebuilt and the VM is upgraded. Before that upgrade, the plan needs three things: an NFS ownership check (read-only, about 2 minutes, Dror approves), a staging key drill, and a decision about the two live production trips. With the code as it stands, those two trips are **not** protected by this fix.

Mode: branch / pre-deploy. The live fleet was read through the fleet monitor's read-only MCP (`fleet-mcp.mjs`, profile `trip-monitor`, `PGOPTIONS=default_transaction_read_only=on`) on 2026-09-25. Nothing was written and nothing was deployed.

---

## 1. Change set

| | |
|---|---|
| PR | #182 `fix(sprint6.4): keep a trip's agent key stable across re-bootstrap, keep bridge failure recorded (#119)`, OPEN |
| Branch | `origin/fix/119-keep-bridge-key-stable`, head `e6e1a16` (1 commit, based on `d1c44af`) |
| Target | `origin/integration/sprint-6` @ `70371d6` |
| Assessed tree | merged index of worktree `agent-ad36a9e73edb6adc1`, `git write-tree` = `688bc4ef` (merge-tree clean). The index's only other delta against the PR head is #180 (`organizer-trips.ts` and its test), which does not overlap. |
| Issue | #119 (open; the root cause, "which step removed the env file", is still unestablished there) |

Files (`git diff origin/integration/sprint-6...origin/fix/119-keep-bridge-key-stable --stat`):

| File | +/− | What |
|---|---|---|
| `provisioning/adapters.py` | +22 −1 | `_bootstrap_app_environment`: reuses a well-formed (`^[0-9a-f]{64}$`) key from `<nfs_mount_path>/.hermes-api-key` when `.env` is absent. After the `.env` block it always copies the `.env` key to that file (umask 077, `.tmp` then `mv`). Warns on stderr if it cannot. |
| `control-plane/worker/control_plane_worker/provisioner.py` | +13 −1 | `bridge_failed` flag. `_record_reachability(reachable=True)` after a successful binding is skipped if the bridge raised. |
| `tests/provisioning/test_adapters.py` | +62 | 3 tests that run the generated shell block in a temp dir |
| `control-plane/worker/tests/test_provisioner.py` | +10 | extends `test_a_failing_bridge_does_not_block_the_chat_binding_or_the_job` to assert `('unreachable','TRIP_MCP_BRIDGE_FAILED')` survives the binding |

No migration, no API change, nothing under `site/ server/ shared/` (release seal untouched), no intake-schema change.

## 2. Risk table

| # | Change | Surface (§2 row) | Blast radius | Migration | Compat break | Risk | Test | Minutes | Batch/isolate |
|---|---|---|---|---|---|---|---|---|---|
| A | Key reuse and keep file in the bootstrap | `provisioning/`: worker image | Every **new** trip writes a credential file to its NFS dir. An existing trip changes **only** if the worker re-bootstraps its container, and for a healthy container that does not happen (see §4). | no | no. Additive, and it falls back to the old behaviour (mint) on any failure. | **Medium.** Correctness fails open, but the failure is **silent** (§3.2), and it adds a credential at rest on the shared NFS export (§3.4). | unit (done); staging key drill (C2) | 0.3 s unit (measured); ~20 min drill (estimate) | **Isolated assertions** (silent-failure class), riding on one staging provision |
| B | `bridge_failed` suppresses the `reachable` write | `control-plane/worker/`: worker image | Only trips whose `mcp_bridge.setup()` raised. Healthy trips: no change. | no | no | **Low**, with a user-visible side effect: the `/trips` label and the relay gateway-wait (§3.5) | worker unit (done, per verifier) | verifier: 537 OK (duration not reported to me) | isolated. It cannot be induced cheaply on a real run, so the unit test is the evidence. |

## 3. Migration and compatibility findings

No SQL. `unreachable_reason` has a CHECK only on presence/absence (`0042_trip_reachability.sql:42-45`), and `TRIP_MCP_BRIDGE_FAILED` is already in `UNREACHABLE_REASONS`. Nothing in `site/ server/ shared/` changed, so no new release and no digest change. The findings that matter:

### 3.1 Existing trips get no protection in practice
The keep file is written only inside `_bootstrap_app_environment`. That runs from `create()` (new container) or from `bootstrap()` when `needs_bootstrap()` is true (`adapters.py:130-153`: a marker file is missing, **or** `pct exec` fails, e.g. the container is stopped). For a healthy, running, live container neither happens. So a trip provisioned before this fix gets its keep file only at a bootstrap, and the likely next bootstrap is the one where `.env` is already gone. By then the old key is unrecoverable and a new one is minted, exactly as before. The PR body's line "trips provisioned before this fix are covered at their next bootstrap" is literally true, but it protects nobody in the case #119 describes.

### 3.2 The "cannot keep it" warning goes nowhere
The step is `( … ) 2>/dev/null || echo 'WARNING: …' >&2`. `SubprocessSshTransport.run` (`adapters.py:38-57`) captures both streams and **returns stdout only on success**. It surfaces stderr only inside the `RuntimeError` of a failed command. The bootstrap succeeds after this step, so the warning is discarded, and the step's own error text (EACCES, ENOSPC) is also discarded by `2>/dev/null`. The only trace of a share that refused the write is a missing file. This is the repo's silent-downgrade bug class.

### 3.3 Leftovers and ordering on the NFS dir
- Share refuses file creation: no `.tmp` is created, no `mv` runs, warning (unseen). Nothing is left behind.
- `.tmp` created but `mv` fails (rare, same directory): `.hermes-api-key.tmp` stays, **holding the key**, mode 600. That is a second at-rest copy under a name nobody knows to look for.
- `.env` has no well-formed key (a hand-edited or legacy base64 key): with `pipefail` inherited into the subshell, grep's exit 1 fails the pipeline after the redirect has already created an **empty** `.tmp`. No `mv`, warning. The empty `.tmp` is harmless. Such a trip is never protected, and that is the same as before.
- **Duplicate `HERMES_API_KEY=` lines:** the keep step takes `head -n 1`, but systemd `EnvironmentFile=` applies the **last** assignment. `setup-mcp.sh` (kinerary-deploy, lines 355-359, Mac copy read 2026-09-25) *appends* `HERMES_API_KEY=` when its `source .env && echo $HERMES_API_KEY` comes back empty. In that case the file can hold two lines, the keep file would store the key the site does **not** use, and a later `.env` loss would restore the wrong key. Unlikely, but it costs one word to fix (`tail -n 1`). Whether any live container has duplicates is not checked: C1 below counts them without reading them.
- `_reset_trip_data` (`adapters.py:454-477`) wipes `server-data` and `media` but **not** `.hermes-api-key`. That wipe exists to stop a new occupant inheriting a previous occupant's state. For id-named NFS dirs (every topology built since the id change, `compute.py:257`) the directory is never reused, so this does not matter. For a legacy slug-named dir that is reused, the new trip would inherit the old trip's agent key.

### 3.4 Credential at rest widens to the NFS export
Before this PR the site's key lived in the container rootfs (`/opt/kinerary/.env`, 600) and in the bridge's `mcp/.env` on the companion host. It now also lives on the TrueNAS export: in every snapshot or replication of that dataset, readable by any client that can mount it. Mode 600 protects less than it appears to under `root_squash`. The file is then owned by the anonymous uid (65534), which every squashed client and every `nobody` process shares. Read on 2026-09-25: neither `compose.local.yml` nor `compose.vm.yml` mounts the trip NFS into the worker (no `PROVISIONER_TRIP_NFS_LOCAL_BASE`), so the worker container, which runs as `nobody`, cannot read it. The marginal exposure is bounded: whoever can read the export can already read the trip's SQLite and documents. But the key also lets them **write** through the live site's agent API, and an operator rotating the key by deleting `.env` now has to delete the keep file too, or the old key comes back. The PR body says as much ("teardown and archive procedures should treat it like `.env`"), but nothing enforces it. This is not one of `boundary-reviewer`'s three invariants. Accepting it is a decision (§9).

### 3.5 Change B has effects beyond the fleet monitor
`reachability = 'unreachable'` is read in four places (grep of `control-plane/api/src` and `.agents/skills`, 2026-09-25):
- `fleet-mcp.mjs` (`alerts`, `failures`, `list_trips`): the intended effect. A bridge failure on a live trip now alerts.
- `relay/gateway-wait.ts:47` `expectedGatewayProfiles`: a trip marked unreachable is **no longer waited for** at relay restart. The companion of a bridge-failed trip is installed and does talk. After a relay restart, messages sent before its gateway reconnects (up to about 30 s) get the canned `COMPANION_PENDING` reply and are consumed.
- `chat-router.ts:1120` `/trips` list: shows `tripUnreachable` = **"(site not responding)"** (`intake-copy.ts:588`). For a bridge failure that is wrong: the site responds, and the assistant cannot read it.
- **No clearing path after a manual repair.** The documented repair for a failed bridge is "re-run setup-mcp.sh by hand" (`mcp_bridge.py` header). That never writes `reachability`. Only a later successful provision+binding or `scripts/switch-trip-chat.py` does. So once repaired, the trip stays `unreachable` and keeps appearing in `alerts` indefinitely. The fingerprint dedups filing, but the digest never goes quiet.
- `generatePlan()` / `planner.ts` does **not** read `reachability` (it is absent from the grep). Release selection is unaffected.
- Healthy trips: `bridge_failed` is `False`, and the `reachable` write happens exactly as before. The Null bridge (`wired=False`, `mcp_bridge_skipped`) is not a failure and also still writes `reachable`.

## 4. Live-fleet impact (read 2026-09-25, read-only fleet MCP)

**Production (`prod` stack, VM):** 52 trips. Live, non-retired, past the `ready_private` line:

| trip | stage | reach | provisioned | jobs |
|---|---|---|---|---|
| `orlando-florida-2026` | ready_private | reachable | 2026-09-23 | 1 provision, succeeded 1/3, 2 m; private binding open |
| `japan-tokyo-hakone-kyoto-osaka-2026` | ready_private | reachable | 2026-09-15 | 1 provision, succeeded 1/3, 3 m; private + group bindings open |

Plus 2 `intake_in_progress` and 4 `draft` prospects. `filter unreachable`: none. Failures in the last 30 days affecting live trips: 0.

- **Exposed to the key-orphan bug today:** both live trips, *latently*. Each had a single provision job that succeeded first time, so there is no evidence either was ever re-bootstrapped. Neither has a keep file, because no fix is deployed. **They stay exposed after this PR deploys** unless seeded (§3.1). The two in-flight prospects will be provisioned by the VM's *current* worker if they finish before sprint-6 ships, and will join the same group.
- **"reachable" on those rows is not evidence that their bridges work.** The code that records `TRIP_MCP_BRIDGE_FAILED` at all (`1ab5c31`) is **not on `origin/main`** (`git merge-base --is-ancestor` → not an ancestor, 2026-09-25). If the VM runs a main-derived revision, a bridge failure there leaves only a WARNING line, and `reachable` is written after the binding regardless. I did not read the VM's `KINERARY_REV`, and I did not probe either bridge's `/health`. Whether their companions can read their trips right now is **not established**.
- **CT200 `trip-usa2026`:** memory says it is real production tracked by no control plane. It is absent from the prod trip list, which is consistent. It is not provisioned by the worker, so this code never touches it. (Memory claim; not verified on Proxmox.)
- **Mac staging (`local`):** 70 trips, none live. Every `ready_private` trip is retired.

**What reaches whom, and when (the two clocks):** both halves are in the **worker image** (`Dockerfile` COPYs `control_plane_worker` and `provisioning`). There is no release-tree side. They reach the VM only through `sudo kinerary-cp-release upgrade` of a revision that contains them, which in practice means sprint-6 → main → upgrade. At that moment nothing on any live trip changes: the worker pushes nothing to running containers. The first effect is the next provision. **Mac staging trap:** `compose.local.yml:226` overlays only `control_plane_worker/` from the host. `provisioning/` comes from the image's baked copy. A worker *restart* on the Mac therefore runs change B against the **old** bootstrap. Change A needs `docker compose build worker`. Verify by reading the running container (C0), not by trusting the checkout.

**Existing trips need a re-bootstrap?** Not for correctness: nothing in them is broken by this change. For **protection**, yes in effect, but a full re-bootstrap re-runs apt, rewrites the unit and nginx config and restarts nginx on a live family's site. The cheap equivalent is to seed the keep file from the container's `.env` (C3). That is a write to a live trip's NFS dir, and it needs Dror's approval per trip.

## 5. The plan

**C0: prove what the worker is running** (before any staging run; 1 min; read-only)
```bash
docker exec <mac worker container> grep -c 'hermes-api-key' /app/provisioning/adapters.py      # expect 2+
docker exec <mac worker container> grep -c 'bridge_failed' /app/control_plane_worker/provisioner.py
```
Both must be non-zero. If the first is 0, the image was not rebuilt, and C2 would test the old bootstrap.

**C1: settle root-squash on the real export, read-only** (about 2 min; **Dror approves**; runs on the Proxmox host, which is production infrastructure)
Use a **retired** trip's id-named NFS directory: same export, same writer, zero real people. Teardown leaves NFS data in place (`teardown-trip.py` header). If none survives, use `orlando-florida-2026`'s directory. The command only reads metadata and never touches the container or its data.
```bash
stat -c '%u:%g %a %n' <nfs_host_dir> <nfs_host_dir>/TRIP.txt <nfs_host_dir>/server-data
findmnt -no SOURCE,OPTIONS -T <nfs_host_dir>
```
`TRIP.txt` is written by host root at exactly the directory level the keep file uses (`adapters.py:247`), and a privileged LXC's root is host uid 0. If `TRIP.txt` exists, root file creation there succeeds. Its owner (0 or 65534) says whether writes are squashed, and therefore who else can read a 600 file (§3.4). For the two live containers, the same session can count keys **without reading them**: `pct exec <vmid> -- grep -c '^HERMES_API_KEY=' /opt/kinerary/.env` (expect `1`; `2` or more triggers §3.3).

**C2: staging key drill on the Mac** (about 20 min on top of a provision, estimate; Dror present; **needs a window**: the Mac and VM share Proxmox, NPM and Cloudflare, and the VM has provisioning on for a real organizer)
Ride it on the next sprint-6 staging provision, using `--scenario multi` or `manual`, **not `japan`**, which collides with the live Japan trip (memory). Then, on that throwaway trip only:
1. (A) `ls -ln <mount>/.hermes-api-key*`: file present, mode 600, no `.tmp`; note the owner.
2. (A) Hashes, never values: `pct exec <vmid> -- sh -c "grep '^HERMES_API_KEY=' /opt/kinerary/.env | cut -d= -f2- | sha256sum"` and `sha256sum < <nfs_host_dir>/.hermes-api-key` must match.
3. (A) Bridge `/health` answers `{"ok":true}` (needs #127's checkout on the companion host, or the old install script has no `/health`, per #119's correction).
4. (A, the #119 regression) Move `/opt/kinerary/.env` aside on that container, trigger a re-provision so `needs_bootstrap()` is true, and repeat step 2: **same hash**. Repeat step 3: **still ok**. The pre-fix code fails step 4.
5. (B) `SELECT reachability, unreachable_reason FROM control_plane.trips WHERE slug = '<trip>'` → `reachable`. Change B does not disturb the healthy path.
6. Tear down with `scripts/teardown-trip.py --execute` (Mac trips are pre-approved), then confirm what happened to `.hermes-api-key` in the NFS dir (§3.4 archive question).

**C3 (optional, a decision): seed the keep file on the two live prod trips** (about 2 min each; **Dror approves each**; a write to a real family's NFS dir; no restart, no container change)
Without printing the key: `pct exec <vmid> -- sh -c "umask 077; grep -E '^HERMES_API_KEY=[0-9a-f]{64}$' /opt/kinerary/.env | tail -n 1 | cut -d= -f2- > <mount>/.hermes-api-key"`, then compare hashes as in C2 step 2. Only after the sprint-6 worker is live, and only if Dror wants existing trips protected.

## 6. Budget

| Tier | What | Cost | Buys |
|---|---|---|---|
| **Merge gate (met)** | `tests/provisioning` + worker suite + integrator | 0.3 s wall for 40 tests (measured here, 2026-09-25, macOS `/bin/bash` 3.2). Worker 537 OK per verifier, duration not reported. | Shell logic and reachability branch correct in isolation |
| Pre-VM-upgrade minimum | C0 + C1 | about 3 min + Dror's yes | Knowing the fix can actually write on the real export, and who can read what it writes |
| + staging drill | C2 | about 20 min on a provision run (estimate), plus a window | The only evidence that #119's failure mode is closed on real infrastructure: Debian bash, the real NFS, the real re-bootstrap path. Without it you find out in production, on a family's companion. |
| + live seeding | C3 | about 5 min + approval | Protection for the two trips that exist today |

## 7. Go / no-go and the way back

- **Merge into `integration/sprint-6`: go.** No production reach, no migration, fails open.
- **VM upgrade carrying this: no-go** until C1 has been run, or the decision to skip it is recorded. If C1 shows the export refuses root-created files, change A does nothing in production, and does it silently.
- **Stop conditions in C2:** hashes differ after re-bootstrap; a `.tmp` is left behind; `/health` not ok; healthy-path `reachability` not `reachable`.
- **Way back:** worker-only, forward code with no schema, so rolling back is `kinerary-cp-release rollback` to the prior revision (its standard snapshot applies; migrations are unchanged, so the rollback is `compatible`). Keep files already written stay on NFS and are harmless to the old code, which never reads them, but they remain an at-rest credential until deleted.

## 8. What would reduce the risk (ranked by risk removed per minute)

1. **Make the keep failure loud** (about 20 min dev + test, before merge or as the first follow-up). After the bootstrap, have the adapter run `pct exec <vmid> -- test -s <mount>/.hermes-api-key` and log a WARNING (`provisioner.agent_key_not_kept`, trip id, no value) when it fails. Do **not** make the file a bootstrap marker: a refusing share would then re-bootstrap forever. This turns §3.2 from silent to visible.
2. **Run C1** (2 min, read-only, Dror). It settles the root-squash question and the §3.3 duplicate-line question in one sitting.
3. **`head -n 1` → `tail -n 1`** in the keep step, to match systemd's last-assignment-wins (1 min + test). It closes §3.3's wrong-key case.
4. **Add `tests/provisioning` to CI** (about 10 min). `control-plane.yml` runs only `control-plane/worker/tests`, so the three new shell tests run only in local `preflight-deploy.sh`. On `ubuntu-latest` they would also run under GNU bash and coreutils, which is closer to the Debian container than macOS bash 3.2.
5. **Run C2** on the next staging provision. It is the only real-infrastructure proof of the #119 fix.
6. **Clear `.hermes-api-key` and `.tmp` in `_reset_trip_data`** (5 min). This closes inheritance by a reused slug-named directory (§3.3).
7. **Give `TRIP_MCP_BRIDGE_FAILED` a clearing path and an honest label.** Have `setup-mcp.sh --restart-only` or the operator runbook reset `reachability` after a repair, and replace "(site not responding)" with a reason-aware string. Follow-up, not a blocker.
8. **Document rotation:** deleting `.env` no longer rotates the key; the keep file must go too. Add a line to the teardown and archive procedure (the PR body already asks for this).

## 9. Decisions needed (Dror)

1. **Is the suite sufficient?** My answer is in the next section: yes for merge, no for "safe for live trips". Do you accept the pre-upgrade conditions (C1, and C2 or an explicit skip)?
2. **Seed keep files on `orlando-florida-2026` and `japan-tokyo-hakone-kyoto-osaka-2026` (C3), or accept that existing trips stay unprotected?**
3. **Is a credential at rest on the TrueNAS export, including its snapshots, acceptable** (§3.4), or should it go to `boundary-reviewer` first?
4. **Items 1 and 3 of §8 before merge, or as follow-ups?**
5. **`/trips` "(site not responding)" and the relay no longer waiting for a bridge-failed trip's gateway** (§3.5): accept as-is for now?
6. **#119 stays open.** Which step removed `.env` (or rewrote it: `sync-env.sh` from a stale `trip.env`, or `setup-mcp.sh`'s append path, are the other candidates) is still unestablished. This PR covers the re-bootstrap hypothesis only.
7. **Probe the two live bridges' `/health`?** The `reachable` on their rows cannot tell you (§4).

## Is the suite (tests/provisioning + worker suite) sufficient?

**It is sufficient for merging into `integration/sprint-6`. It is not sufficient to call the fix safe or effective for live trips.**

What it proves: the generated shell (the real f-string output, sliced from the `.env` guard to the systemd unit) keeps one key across a `.env` loss in a local temp directory, adopts an existing `.env`'s key, rejects a malformed kept value, and does not print the key on that block's stdout or stderr. The worker test proves that a bridge exception now leaves `('unreachable','TRIP_MCP_BRIDGE_FAILED')` standing after a successful binding. It failed on the old code, because the fixture binds a verified chat. I read all four tests. I re-ran `tests/provisioning` myself (40 OK). The worker suite result (537 OK, nothing skipped, scratch DB) is the verifier's; I did not re-run it (`cptest` is shared across sessions).

What it does not prove, and what "safe for live trips" would need:
- **It never touches NFS.** Whether the real export accepts the write, and who owns the file, is exactly what C1 settles.
- **It ran under macOS `/bin/bash` 3.2 and BSD tools**, not the container's Debian bash and GNU coreutils. The constructs are portable, but that has not been shown.
- **It cannot see the silent failure**: a refused write is invisible end to end (§3.2).
- **It does not cover existing trips**, which never re-bootstrap (§3.1).
- **It does not establish #119's root cause.** If the rewrite was not a re-bootstrap after `.env` loss, this fix does not touch it.
- **It does not exercise change B's downstream effects**: the relay gateway-wait exclusion, the `/trips` label, and the missing clearing path.
- **`tests/provisioning` is not in CI.**

The staging drill C2 is the test that closes the gap between "correct shell" and "the bridge keeps working".

## Answers to the brief's eight questions (short form)

1. **Live trips:** nothing changes at deploy time. The worker pushes nothing to running containers. A trip provisioned before the fix gets a keep file only at its next bootstrap, and that effectively never happens to a healthy container. When it does, `.env` is usually already gone (§3.1). So pre-existing trips stay exposed unless seeded (C3).
2. **Exposed today (production, read-only, 2026-09-25):** `orlando-florida-2026` and `japan-tokyo-hakone-kyoto-osaka-2026`, latently. No re-bootstrap is on record for either (one provision job each). Their `reachable` does not vouch for their bridges, because bridge-failure recording is not on main. Two in-flight prospects will join them if provisioned before sprint-6 ships. CT200 is outside this path. Mac staging has no live trips.
3. **Other writers of the key or the env file:** in this repo, only the bootstrap mints for LXC trips. `server.js` rewrites `.env` in place and preserves the key. `scripts/hermes-pipeline/01-bootstrap-site-host.sh` mints for a self-hosted site host, not an LXC. `e2e-full-cycle.py` only reads it. The worker Python has no `.env` writes. In the Mac's `kinerary-deploy` (the VM's copy was not read): `setup-mcp.sh` **mints and appends** when it reads no key, and rewrites `.env` for `HERMES_URL` (key preserved, mtime changes). `sync-env.sh` / `deploy-trip.sh` overwrite the key from `trip.env`. `retarget-container.sh` restores `.env.bak-*`. None of them update the keep file.
4. **Root-squash:** a refused create leaves nothing behind. A failed `mv` leaves a `.tmp` holding the key. The warning is **not** surfaced: stderr is dropped on success and the step's own errors go to `/dev/null`. The settling check is C1's `stat` on a retired trip's NFS dir from the Proxmox host (read-only). Dror approves, because that is production infrastructure.
5. **Credential printed?** Not by the new code. The key is generated inside the container, never appears in the ssh argv, and passes through `printf` (a builtin), a heredoc and pipes, never a command line. There is no `set -x`. Test failure messages would print only test-generated keys. The existing leaks are in `setup-mcp.sh` (outside this repo): `echo HERMES_API_KEY=<key> >> .env` on an ssh command line, and the "no vmid" branch logs the key. Neither is introduced here.
6. **Skipping `reachable`:** no change on a healthy trip. `generatePlan` does not read `reachability`. On a bridge-failed trip: the monitor alerts (intended), the relay no longer waits for its gateway, `/trips` shows "(site not responding)", and nothing clears the state after a manual repair.
7. **Redeploy:** the worker image only (`provisioning/` and `control_plane_worker/` are both COPYed in). There is no release-tree side, so no new release and no digest change. VM: `kinerary-cp-release upgrade` to a revision containing it. Mac: an image **rebuild**, because a restart applies only change B. Existing trips need no re-bootstrap for correctness, but need seeding (C3) for protection.
8. **Sufficiency:** see the section above. It is sufficient for merge, and insufficient as evidence of safety on live trips.
