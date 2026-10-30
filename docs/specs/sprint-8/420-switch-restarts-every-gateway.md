# The switch phase restarts every Hermes gateway

Status: draft (2026-10-19) · Issue: #420 (absorbs #288) · Track: T2 · Size: M · Tier: Normal
Security path: no (none of the three named invariants; spawns `docker exec` with no secret on argv) · Migration: no · Live-trip behaviour: yes

> **Unscheduled (2026-10-30):** the trip-intake half shipped in Sprint 7 (`199038a`); restarting every other gateway is not in Sprint 8.

> **Partly built on integration/sprint-7 (2026-10-19):** `199038a` restarts the **trip-intake** gateway after every switch and waits for its new tool registration, and `live_companions()` skips `retired-` slugs (#288). Still owed by this spec: every other gateway (companions, monitor), discovered rather than hard-coded, and the ordering with #349. The developer builds on `199038a`, not beside it.

## Problem

`ControlPlane.start_switched` (`control-plane/deployment/vm-release.py:1239-1254`)
recreates `api`, `worker`, `interview-mcp`, `companion-mcp` and the relay, and
the whole Hermes container only when `HERMES_REV` changes. It never restarts the
s6-supervised gateway **processes** inside the Hermes container. Each holds its
own MCP connections to the sidecars it was started against, and does not
re-establish them when a sidecar container is recreated underneath it.

- 2026-10-18 upgrade: verify failed with `trip-intake is MISSING tools: …_for_chat`
  (#420). The `trip-intake` gateway had run unchanged since 2026-09-18, so every
  `interview-mcp` tool change since then had silently not reached it. Fixed by
  hand with `s6-svc -r` on its slot.
- The same class sits unseen on every companion: `companion-mcp` (the
  `trip-control` server, `profile-templates/familytrip-companion/templates/config.overlay.yaml.tpl:57`)
  is recreated on every switch, and no companion gateway is restarted after it.
- The only profile list the tool has is `live_companions()`
  (`vm-release.py:1270-1286`), which has no retired-slug filter, unlike the
  relay's `expectedGatewayProfiles()` (`control-plane/api/src/relay/gateway-wait.ts`,
  `NOT_RETIRED_SQL` from `trip-retirement.ts:26`) — #288.

## Behaviour

After the containers come up, every gateway that is running in the Hermes
container is restarted once, while the relay is stopped, so Telegram holds the
messages and nothing is answered "companion pending". The set is read off the
supervisor, not typed into the tool. The operator sees one line per gateway:
restarted, skipped (and why), or failed. A rollback does the same, because it
runs the same `start_switched`.

**Discovery** (`ControlPlane.running_gateways()`), in this order:

1. **Running:** service directories named `gateway-<profile>` in the Hermes
   container's s6 scan directory (`docker exec $HERMES_CONTAINER ls /run/service`),
   kept only when `s6-svstat` says `up`. This is what is running, which is what
   needs restarting. Teardown already reads slots this way
   (`scripts/teardown-trip.py:311-343`).
2. **Skip, report:** a slot whose profile directory is gone
   (`$KINERARY_CP_HERMES_DATA/profiles/<profile>` missing) — a teardown leftover,
   not a gateway; and a slot whose profile is recorded on a **retired** trip only
   (`trips.hermes_profile` on a slug starting `retired-`). Both are anomalies to
   report, never processes to bring back.
3. **Expected:** `live_companions()` (with the retired filter added) plus the
   interview profile (`trip-intake`). An expected profile that is not running is
   reported here and failed by verify (spec `294-every-profile-verify.md`); the
   switch does **not** start it — which gateways *should* run is #349's decision.
   If #349's `desired_gateways()` (spec `349-gateway-reconciler.md`) has landed,
   the expected set **is** that function, not a third SQL copy.

**Order inside `start_switched`:** `compose up --wait` the four services →
`compose stop relay` → restart every discovered gateway (`s6-svc -r`, in
parallel, bounded) → `vm-relay-restart.sh --force-live`, whose existing
gateway wait (`RELAY_GATEWAY_WAIT_SECONDS`) holds polling until they reconnect →
Hermes container recreate only when `HERMES_REV` changed (which restarts them
all again; the per-gateway step is skipped in that case).

`s6-svc -r`, not `hermes -p <p> gateway stop/start`: a restart keeps the
recorded intent, so a failure cannot leave a gateway persistently stopped.

## Acceptance criteria

- AC-1 Given slots `gateway-trip-intake`, `gateway-trip-a`, `gateway-trip-monitor`
  all `up`, when `start_switched` runs without a Hermes change, then exactly those
  three receive one `s6-svc -r` each, after `compose up … interview-mcp companion-mcp`
  and after `compose stop relay`, and before `vm-relay-restart.sh`.
- AC-2 Given a slot `gateway-trip-b` whose profile directory does not exist, when
  discovery runs, then it is not restarted and the report says
  "trip-b: supervisor without a profile (teardown leftover)".
- AC-3 Given a trip with slug `retired-x-20261001`, an open binding and
  `hermes_profile = trip-x`, when `live_companions()` runs, then `trip-x` is
  absent; and a running `gateway-trip-x` slot is reported as "retired trip", not
  restarted.
- AC-4 Given `restart_hermes=True`, when `start_switched` runs, then no
  per-gateway `s6-svc -r` is issued and the Hermes container is recreated after
  the relay restart, as today.
- AC-5 Given one `s6-svc -r` exits non-zero, when the switch runs, then the other
  gateways are still restarted, the relay is still started, the failure is
  reported by profile name, and the run proceeds to verify (which judges it);
  it does not raise `Refused` (this is after the point of no return).
- AC-6 Given `--dry-run`, when an upgrade runs, then discovery runs for real and
  each restart is printed as a step, and no `s6-svc` or `compose stop relay` is
  executed.
- AC-7 Given the Python retired-slug prefix, when the test suite runs, then it
  equals `RETIRED_SLUG_PREFIX` read from `control-plane/api/src/trip-retirement.ts`
  (the two filters cannot drift apart silently).
- AC-8 Given discovery found no slot at all (`ls` fails or the container is
  down), when the switch runs, then it reports "could not read the Hermes
  supervisor" as a failure carried into verify — never "no gateways, nothing to
  restart".

## Contracts

- `control-plane/deployment/vm-release.py`: new `running_gateways() -> Gateways`
  (running, skipped-with-reason, expected-not-running); `restart_gateways()`;
  `start_switched` reordered as above; `live_companions()` gains
  `AND t.slug NOT LIKE 'retired-%'`; new constants `RETIRED_SLUG_PREFIX`,
  `INTERVIEW_PROFILE = "trip-intake"`, `S6_SCANDIR = "/run/service"` (the
  Hermes image's layout, not this deployment's).
- `cmd_restart_bridges` (`vm-release.py:1859-1880`) keeps its per-trip
  `gateway stop/start` for now; unifying it on `restart_gateways()` is spec
  `x-verify-retry-then-rollback.md`.
- `docs/control-plane-vm-deployment.md` "Upgrades and rollback", step 4 and
  "What trips notice" — doc-keeper, with the code.

## Non-goals

Starting gateways that are not running (#349). Restarting trip-mcp bridges (a
host process, not a gateway; see Open questions). The Mac stack. GHCR images.

## Security and boundary notes

No invariant from CLAUDE.md "Security-sensitive paths" is touched. The tool
reads profile names from the supervisor and the database and passes them as
argv elements (no shell); names are matched against the existing profile
pattern before use.

## Test plan

Written first:
- `tests/scripts/test_vm_release.py` — `GatewayDiscovery` (stubbed `sh.text` for
  `ls`/`s6-svstat`, temp `HERMES_DATA`): AC-2, AC-3 (slot half), AC-8;
  `SwitchOrder` (a `ControlPlane` subclass recording `sh.act` argv): AC-1, AC-4,
  AC-5, AC-6; `RetiredPrefixMatchesRelay`: AC-7.
- `tests/scripts/test_vm_release_database.py` —
  `test_live_companions_excludes_a_retired_trip` (AC-3, DB half; the existing
  `test_live_companions_includes_a_bridge_failed_trip` stays green).
- `tests/scripts/test_vm_release_rehearsal.py` — `FAKE_DOCKER` learns
  `exec hermes ls /run/service`, `s6-svstat`, `s6-svc -r` (records the restart
  in fake state and appends a fresh registration line to that profile's
  `agent.log`); `test_an_upgrade_restarts_every_running_gateway`.

These suites run in the local preflight, not in CI (`control-plane.yml` runs
only the worker's tests): the verifier runs them explicitly.

## Rollout and regression

Every live companion now restarts on **every** upgrade and rollback, not only on
a `HERMES_REV` change: about 16 s per gateway (runbook, 2026-09-18 measurement),
in parallel, while the relay is stopped, so new messages wait at Telegram. A
companion turn **in flight** at that moment is killed (10 s stop grace; turns
take 20-42 s) and the organizer resends.

The tool upgrades itself only after a green verify (`install_tool_files`,
`vm-release.py:1941-1954`), so the first upgrade carrying this runs the **old**
switch. Roll out by running the target's own `vm-release.py` from a throwaway
worktree of the target, `--dry-run` first, inside the MVP VM-upgrade gate's
release window — the installed tool and its rollback stay untouched until that
run is green. Regression plan: needed (changes live-trip behaviour during
upgrades); one rehearsal run plus one Mac-staging pass.

## Open questions

1. **Companion turns in flight.** Accept the lost turn (as for a Hermes
   recreate today), or add a best-effort quiet check (no `inbound message`
   without `response ready` in a live companion's `gateway.log` in the last
   2 minutes, wait up to 5)? Recommendation: accept for Sprint 7, guard later.
2. **Every gateway vs only changed servers.** The issue says every; a
   diff-based "restart only if a server it uses changed" would disrupt less but
   reintroduces the silent-drift class. Recommendation: every.
3. **Bridges.** A trip-mcp bridge keeps running old `mcp/mcp.js` after a switch.
   Restart bridges when `git diff <from> <to> -- mcp/` is non-empty, or leave it
   to `restart-bridges`? Recommendation: restart on diff, as a follow-up item.
4. **Conflict with spec `349-gateway-reconciler.md`.** That spec (AC-12) wants
   the switch to call `gateway-reconcile.py restart --desired` and to drive
   gateways only through `hermes -p <p> gateway start|stop`, never s6. This spec
   restarts *what is running* with `s6-svc -r`. Recommendation: keep the
   running-set discovery here (a restart must reach a running gateway the
   reconciler would not have chosen, until #349 owns that), put the restart
   behind one `restart_gateway(profile)` function, and switch that function to
   #349's driver when it lands. Dror to confirm which ships first.
