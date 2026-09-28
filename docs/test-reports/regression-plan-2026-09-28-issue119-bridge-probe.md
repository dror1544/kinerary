# Regression plan: issue #119, the idle-loop bridge probe (PR #297)

Assessed 2026-09-28 by `regression-planner` against the staged round-1 change (base `ae544d9`), production read
read-only the same day. Round 2 (PR #297, `5523913`) fixed the findings marked **fixed in round 2** below. The
verdict and the release conditions still stand.

**Verdict:** safe to merge into `integration/sprint-6` once #290 has merged (it has, `4f006ef`) and the three small
fixes below are in (they are). It does not have to wait for a production window, but it is **not in `release/a`**
(`a744c28`) and it changes what a *settled* live trip's row can say, so it ships with the explicit conditions in §7.
Owner decision 2026-09-28: the probe ships ON.

## 1. What it is

The provisioner worker's idle poll loop re-asks each live trip's trip-mcp bridge `/health` (default every 30 min,
`PROVISIONER_BRIDGE_PROBE_MINUTES`, `0` = off) through the existing companion forced command (new request kind
`trip_mcp_bridge_probe`) and records the result with conditional writes to `control_plane.trips.reachability` /
`unreachable_reason`. Alert only. No migration, no restart, no automatic repair.

## 2. Findings that shaped round 2 (all fixed in round 2 unless noted)

1. **Failure reports invisible in production.** The worker's log format is `%(levelname)s %(name)s %(message)s`, so
   every `extra={...}` field is dropped; a probe error rendered as the bare line
   `WARNING control_plane_worker.mcp_bridge provisioner.bridge_probe_error`. The fleet monitor does not read worker
   logs, so a probe that can never ask would stay silent forever. *Fixed for the new lines* (facts in the message
   text). The worker-wide gap is #292.
2. **An empty env var stopped the worker.** `PROVISIONER_BRIDGE_PROBE_MINUTES=""` (the house `${VAR:-}` style) exited
   2 with `not a number of minutes: ''`: a crash-loop, provisioning stops. *Fixed* (empty = default; both compose
   files pass it through).
3. **A site outage was labelled a bridge failure** and the alert sent the operator to `restart-bridges`, which
   restarts a live companion (hard rule 2) and does not fix a dead site. *Fixed* (code-aware repair text; site codes
   still mark the trip).
4. **A dead companion host could stall job pickup** (N x 45 s). *Fixed* (circuit breaker after 3 could-not-ask
   results; 5 s `statement_timeout` on the sweep's connection).
5. `NO_KEY` counts as a failure, although `verify()` treats a missing `mcp/.env` as a note. *Decision kept* (a
   companion with no bridge cannot read its trip); recorded in the code.
6. **Ordering with #290.** Without it a trip the probe marks drops out of `restart-bridges`, `verify` and the relay
   wait, so the repair the alert names skips exactly that trip. *Satisfied* (#290 merged first).
7. **`verify()` does not check `/health`** (`vm-release.py:1341-1356` checks the bridge port is listening), so a
   key-mismatch bridge, which is the #119 bug, passes `verify()` even with #290. Tracked as #294.
8. The probe checks the bridge-to-site hop only: a gateway that parked its trip-mcp server (the 2026-09-12
   `japan2026` case) passes it. Not a defect of this change; a limit worth knowing.

Security review (43 crafted requests against the forced command, 2026-09-28): PASS. Its hardening ask exposed a
real hole, **fixed in round 2**: a tab in a topology address shifted the tab-separated fields so the bridge key
would have been sent to the trip site's own port (13 hostile topologies x both request kinds are now refused).

## 3. Live-fleet impact (read 2026-09-28, read-only)

- **It runs in production.** The running worker has `PROVISIONER_MCP_BRIDGE_ENABLED=1`, the companion SSH host and
  key set (`vm.env` overrides `compose.vm.yml`'s default of `0`); its startup line reads `companion adapter: ssh`.
- **Forced command on the VM** pins `/opt/kinerary/scripts/companion-install-host.sh` (the production checkout), so
  it moves in step with the worker image on upgrade and rollback. **On the Mac** it names the
  `sprint-6-integration` worktree (see the memory note `companion-install-forced-command`).
- **Trips the first sweep touches: exactly two**, both `ready_private` / `reachable`, both running now (config
  date ranges 09-18 to 10-03 and 09-23 to 10-01). The plan replayed the sweep's steps as the `hermes` user with the
  key read in-process and never printed: topology parsed, profiles present, `/health` returned ok for both. **The
  first sweep would stamp `reachability_checked_at` and change nothing else.**
- **When it arrives:** not Saturday. The first upgrade after Release A that carries #119.
- **Who sees an alert:** the monitor runs on the Mac until Saturday's cut-over (#291); after it, the VM. Until then
  the always-on places a mark shows are the DB row and the organizer's `/trips` label (#296 gives it accurate
  wording).

## 4. Risk table

| Change | Where it lands | Blast radius | Migration | Risk | Test |
|---|---|---|---|---|---|
| probe sweep in the worker | `control-plane/worker/`, by upgrade | every live trip, every 30 min (the surface table's "worker touches only trips being provisioned" stops being true) | no | medium: it writes reachability of trips families use now | worker tests + Mac drill (R3) |
| `trip_mcp_bridge_probe` in the forced command | `scripts/`, live on every SSH call | companion host, as the `hermes` user | no | medium: a trust boundary; security review PASS, hardened | `tests/scripts/test_companion_install_host.py`, **not in any CI workflow** |
| `poll_loop` extraction | worker | every provisioning job | no | low | `test_main_cli` |

## 5. The plan

| # | Run | Checklist | Who |
|---|---|---|---|
| R0 | done: worker 617, `tests/provisioning` 39, companion-install-host + parse 41, compose readers 25 | all green, DB-backed tests ran | done |
| R1 | author fixes + re-run R0 | done (round 2) | done |
| R2 | merge #290 first, then #119; CI "Control plane" ~14 min; the forced command is a trust boundary and `tests/scripts` is not in CI, so a local merged-tree run stands in | merged-tree verifier on the tip | lead |
| R3 | Mac staging drill, **run alone** (not with a VM run, not during the 02:00 nightly job; scenario `multi` or `manual`, never `japan`), with the owner at the Terminal | (1) startup line says the probe is ON; (2) restart the bridge from Terminal, the mark clears; (3) kill the bridge, after two sweeps the trip is marked with code `none`; (4) `/trips` in the Mac bot shows the label; (5) worker log lines name the trip; (6) measure time per probe; (7) restart, the mark clears; (8) tear down | lead + owner |
| R4 | on the VM after the upgrade that carries it, read-only, ~5 min plus a 35 min wait | (1) worker startup line says ON; (2) `reachability_checked_at` for each live trip is at or after the deploy time; (3) no trip newly `unreachable`; (4) if one is, `curl` its `/health` by hand before any repair | operator |

## 6. No-go and the way back

No-go if: #290 is not in the same release or an earlier one; the worker startup line is missing at upgrade; after
the upgrade a live trip is newly marked while its `/health` answers ok by hand. No migration, so a rollback keeps
the database. Undo: `PROVISIONER_BRIDGE_PROBE_MINUTES=0` in `vm.env` plus a worker recreate. A false mark clears
itself on the next healthy probe; a manual `UPDATE` is a write and needs approval; `--reconcile-companion`
restarts a live bridge and gateway, so it falls under hard rule 2.

## 7. Conditions for the release that carries it

- #290 is in the same release or an earlier one (met).
- `PROVISIONER_BRIDGE_PROBE_MINUTES` is set **explicitly** in `vm.env` (30).
- R3 done before, R4 done after.
- Someone is named to watch for the first 24 h unless the monitor already runs on the VM (#291, Saturday).
- The runbook paragraph that says fixing a bridge "does not clear the mark by itself" is updated when this ships:
  with the probe a healthy verdict clears it within one interval (doc-keeper).

## 8. Decisions taken by the owner (2026-09-28) and still open

Taken: ship ON; the `/trips` wording for a bridge failure (English "(assistant can't read the trip right now)",
Hebrew "(לצערי אני לא יכול לקרוא את נתוני הטיול כרגע)", #296). Still open: whether a flip should also send an
operator Telegram message; whether repeated could-not-ask should become a recorded fact (#295 covers the staleness
alert); auto-repair (needs a narrow "refresh key" mode; whether an unattended gateway restart is acceptable is the
owner's call).

Follow-ups: #292, #294, #295, #296, #284.
