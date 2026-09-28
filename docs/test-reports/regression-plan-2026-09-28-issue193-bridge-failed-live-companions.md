# Regression plan: issue #193 (bridge-failed trips included in restart-bridges, verify and the relay's gateway wait)

**Verdict: safe to merge into `integration/sprint-6` on test evidence alone.** Nothing needs to
run against the production VM before the merge. Production was read today
(2026-09-28, read-only): no production trip is `unreachable` for any reason, and
the running production revision (`130924b`) cannot write `TRIP_MCP_BRIDGE_FAILED`
at all — `git grep TRIP_MCP_BRIDGE_FAILED` on that revision and on `origin/main`
both return 0 matches. So the new predicate returns exactly the same rows as the
old one against today's production data.

## 1. Change set

Worktree `agent-a92b4e5fae6e1304d`, branch `worktree-agent-a92b4e5fae6e1304d`,
merge-base `377de96` (== `integration/sprint-6` tip at assessment time). 6 files,
+88/-7:

- `control-plane/api/src/relay/gateway-wait.ts`: `expectedGatewayProfiles()`
  predicate becomes `(t.reachability <> 'unreachable' OR t.unreachable_reason =
  'TRIP_MCP_BRIDGE_FAILED')`. `NOT_RETIRED_SQL` is kept.
- `control-plane/deployment/vm-release.py`: the same change in
  `live_companions()`. Its only callers are `verify()` (line 1352) and
  `cmd_restart_bridges()` (line 1862).
- `control-plane/api/test/relay-gateway-wait.test.ts` and
  `tests/scripts/test_vm_release_database.py`: fixture/test coverage for both
  the include and exclude case; each fails on the pre-fix code.
- `docs/control-plane-vm-deployment.md`, `.agents/skills/trip-fleet-monitor/SOUL.md`:
  documentation and a monitor-prompt update.

## 2. Risk table

| Change | Surface | Blast radius | Migration? | Compat break? | Risk | Test | Minutes | Batched/isolated |
|---|---|---|---|---|---|---|---|---|
| gateway-wait.ts | `control-plane/api/src/relay/`; reaches production only via a VM image upgrade | every chat, only during the few seconds before the relay starts polling after a restart | no | no (reads pre-existing `unreachable_reason` column, confirmed queryable in production) | low — worst case one bridge-failed trip adds up to `RELAY_GATEWAY_WAIT_SECONDS` (default 40s, unset on the VM) per relay restart; messages queue at Telegram rather than drop | `relay-gateway-wait.test.ts`, CI TypeScript API job | ~11-14 min CI | isolated, own PR |
| vm-release.py | `control-plane/deployment/`; reaches the VM only via `install_tool_files()` after a passing upgrade verify, or `install` | operator tooling; affects live trips only when someone runs `restart-bridges`, upgrade or rollback | no | no | low today; changes operator behaviour (see §3) | `test_vm_release_database.py` — **not run by CI** (`tests/scripts` is in no workflow); re-run directly: 9/9 OK in 27s against real Postgres | 0.5 | isolated |
| SOUL.md (monitor) | `.agents/skills/`; live only when the monitor profile is refreshed | how the fleet monitor ranks one alert reason | no | no | judgement call, see §9 | none | - | - |
| docs, tests | none | none | - | - | none | - | - | - |

**Migration/auth/boundary?** No migration (nothing under `db/migrations/`), no
auth code, not on CLAUDE.md's named security-path list. `vm-release.py` spawns
`sudo env ... setup-mcp.sh` but the diff changes only which trips it loops over,
not the command or its environment — no boundary-reviewer needed. It does
change **relay behaviour** (the startup gate, not message routing), which is
why this got the full plan rather than "assessment: not needed."

## 3. Migration and compatibility findings

- **The fix's premise (a bridge-failed trip's Hermes gateway still reconnects)
  is not proven by the tests**, only by provisioner code order (the reason is
  written only after `self._companion.install()` returned a profile,
  `provisioner.py` ~1737-1772). If wrong, cost is bounded: up to 40s per relay
  restart, and `verify` correctly reports that companion "NOT connected".
- **`verify()` gets stricter, with a side effect.** Once the new tool is
  installed, a bridge-failed trip whose bridge is still down makes `verify()`
  fail (return code 2, "VERIFY FAILED" Telegram message, `install_tool_files`/
  `prune_after_upgrade` skipped) until the bridge is repaired or the trip is
  retired. An operator could roll back an upgrade that did nothing wrong, and
  later upgrades can't update the release tool itself while that trip stays
  broken. The failure message does point at `restart-bridges` as the fix.
- **Ordering on the VM is momentarily inconsistent, harmlessly.** The upgrade
  that delivers this file is run by the *old* tool; the new query applies from
  the next invocation. The new relay query applies as soon as the upgraded
  image starts. No state is written in the gap.
- **A pre-existing asymmetry gets slightly wider.** `live_companions()` has no
  retired-slug filter; the relay has `NOT_RETIRED_SQL`. A retired trip still
  marked `TRIP_MCP_BRIDGE_FAILED` with an open binding (the #105 shape) would
  now be included on the Python side only. Production has zero open bindings
  on retired trips today, so this can't happen right now — tracked as a
  follow-up (see §8).
- **The two copies of the SQL predicate can drift** (one TS, one Python; only
  comments tie them together now).

## 4. Live-fleet impact (read 2026-09-28, read-only: fleet MCP + SSH psql)

- Production stack at `130924b` (api/worker/relay images, up 4 days), schema
  `0051_trip_person_links.sql`. Cannot produce `TRIP_MCP_BRIDGE_FAILED` today.
- Reachability: 32 `reachable`, 20 `unknown`, **0 `unreachable`**.
- The two live trips (`japan-tokyo-hakone-kyoto-osaka-2026`,
  `orlando-florida-2026`) are both `ready_private`/`reachable` with no reason —
  the whole `live_companions()` set is unchanged by this fix, old predicate or
  new. **No trip needs redeploying** — this is control-plane/operator code, not
  trip runtime, and only reaches production with the Sprint 6 release (which is
  also what brings #182's bridge-failed-reason write — not on `main` yet). The
  bug this fixes only exists on `integration/sprint-6`; merging before Sprint 6
  cuts to `main` closes the gap before production could ever hit it.
- Could not locate a `trip-monitor` profile directory on the VM (checked
  `/opt/hermes-data/profiles/`, found only the two live trips plus
  `kinerary-extract`/`trip-intake`) — flagged as a question, not a finding
  about this change (see §9).

## 5. The plan

| # | Run | Checklist | Minutes | Who |
|---|---|---|---|---|
| R1 (gate, done) | `test_vm_release_database.py` | 9/9 OK incl. the new bridge-failed-trip test | 0.5 | done |
| R2 (gate) | PR CI (`gh pr checks`) | TypeScript API green (runs `relay-gateway-wait.test.ts`) | 11-14 (unattended) | lead reads result |
| R3 (at Sprint 6 release, read-only) | `sudo kinerary-cp-release restart-bridges --dry-run` after upgrade | lists exactly the live trips, no retired slug | ~2 | release runner |
| R4 (at Sprint 6 release, read-only) | relay log `grep relay.gateways_awaited` after new image starts | `expected` == open profile-bearing bindings on non-retired trips, `missing` empty | ~1 | release runner |
| R5 (optional, staging) | Mac drill: force a throwaway trip to `unreachable/TRIP_MCP_BRIDGE_FAILED`, restart via `scripts/relay-restart.sh`, check `gateways_awaited` | that trip's gateway shows `connected` | ~15 | lead, Mac only, not during the 02:00 nightly job |

No e2e walk needed — nothing here is visible in an interview or provisioning run.

## 6. Budget

Minimum gate for merge: R1+R2, both effectively done, 0 extra minutes. At the
release: R3+R4 add ~3 minutes, read-only — the only production confirmation
this fix ever needs. R5 is optional proof of the reconnect premise; without it,
worst case is discovered at the first real bridge failure, cost bounded at 40s.

## 7. Go/no-go and the way back

Stop the merge only if R2 is red. No migration, no data written — the way back
is reverting the commit; on the VM, `kinerary-cp-release rollback` is enough.

## 8. Risk-reduction follow-ups (not blocking this PR)

1. Land #193 before Sprint 6 cuts to `main` (ordering only, 0 min).
2. Add R3/R4 to the Sprint 6 release checklist (3 min, read-only).
3. Add `AND t.slug NOT LIKE 'retired-%'` to `live_companions()` to match the
   relay's `NOT_RETIRED_SQL` (~10 min) — **filed as #288**.
4. Make `verify()` distinguish a pre-existing bridge failure from a failure the
   upgrade itself caused, so it doesn't install the tool/prune the release, but
   also doesn't prompt an unneeded rollback (~30-45 min) — **filed as #289**.
5. A test asserting the two SQL predicate copies (TS/Python) stay identical
   (~10 min, could be a simple grep-both-files check).

## 9. Decisions needed (Dror)

1. **SOUL.md wording/severity for `TRIP_MCP_BRIDGE_FAILED`.** Current text
   calls it "milder" than other unreachable reasons. On a live `ready_private`
   trip this state means the companion tells a family it can't fetch their
   plan while every other health check looks fine — the exact symptom CLAUDE.md
   already documents as the costliest failure shape. Regression-planner's
   recommendation: keep full severity for `ready_private` trips, name the
   repair (`restart-bridges` + `--reconcile-companion`) rather than lowering
   priority.
2. **Should a pre-existing bridge failure keep blocking tool self-update and
   pruning on every upgrade** (§3, §8 item 4), or is that acceptable pressure
   to get the trip fixed?
3. **Where does the fleet monitor actually run on the VM, if anywhere?** Not
   found under `/opt/hermes-data/profiles/` during this read. Worth confirming
   directly rather than inferring from CLAUDE.md's description — if the
   monitor isn't actually running in production, none of this issue's alerting
   value reaches anyone regardless of what #193 fixes.

## Batching with #285 and #286

Can merge independently and ride the same release — no file overlap, both
green on CI (read 2026-09-28). #285 (`provisioning/adapters.py`,
`SubprocessSshTransport`) is used only for Proxmox/RPi transport, not bridge
wiring (`mcp_bridge.py`'s `SshMcpBridgeAdapter` is separate) — cannot produce a
bridge-failed trip. #286 (`mcp/mcp.js`) is the bridge process itself but only
changes the environment passed to `runHermesExtract`, not startup or
`/health` — also cannot produce a bridge-failed trip, though as a security path
(spawns a process with an environment) it needs its own evidence regardless,
not a shared-run credit. One interaction worth recording: the first
`restart-bridges` after a release carrying both #286 and #193 is what both
puts #286's `mcp.js` onto live bridges *and* now includes bridge-failed trips
in that restart — intended, not a conflict.
