# The control plane decides which companion gateways run

Status: draft (2026-10-19) · Issue: #349 · Track: T3 · Size: L · Tier: High
Security path: yes (spawns processes that hold a trip's credentials; boundary review required) · Migration: yes · Live-trip behaviour: yes

> **Superseded in Sprint 7:** the reconciler was built differently by PR #461 (landed through #478, released 2026-10-27), from Dror's 2026-10-20 companion model. This draft is not a record of what was built; the Hermes bump it unblocks is still open (#189).

## Problem

Whether a gateway runs is decided by whoever last started it, and remembered by
Hermes, not by the control plane.

- **Every start is ad hoc.** Provisioning starts a companion
  (`scripts/companion-install-host.sh:497-517`, `hermes -p <p> gateway stop`
  then `start`), the release tool restarts some (`control-plane/deployment/vm-release.py:1858-1880`),
  the fleet monitor bootstrap starts its own (`scripts/bootstrap-fleet-monitor.sh:232`),
  prompt refresh restarts one (`scripts/companion-refresh-prompts.sh:73-75`),
  teardown stops one (`scripts/teardown-trip.py`, step 3). Nothing owns the
  list.
- **A restart relies on Hermes' memory.** The Hermes container runs `sleep
  infinity` and each gateway is an s6 slot whose `gateway start` "records the
  intent that brings it back on the next boot" (`control-plane/deployment/compose.vm.yml:396-400`).
  The newer Hermes registers every *named* profile's gateway as stopped at boot
  unless `gateway.standalone: true`, and warns when two starters compete for one
  profile (#349 owner comment, 2026-10-15; seen on the staging machine on
  2026-10-13). After the upgrade a live trip's companion may simply not come
  back, and nothing notices.
- **What the target Hermes does, read from its code** (notes folder,
  `regression-plans/2026-10-03-vm-hermes-upgrade-to-4097709b0c.md`, F1/F2; not
  yet run): at `4097709b0c`, `hermes_cli/container_boot.py:87-147`
  (`reconcile_profile_gateways`) registers every named slot *down* unless the
  profile sets `gateway.standalone: true`, and folds their `running` intent into
  the root slot, which multiplexes every profile — with no relay credentials,
  since those live in each profile's `.env`. The host gateway lock refuses a
  second gateway (exit 75, retried by s6). `gateway stop` writes a
  `gateway.parked` marker; the multiplexer skips standalone and parked profiles
  (`hermes_cli/profiles.py:1107-1131`). Predicted result of an unmodified
  upgrade: no companion and no interviewer connected to the relay. Kinerary
  routes per gateway id = profile (`control-plane/api/src/relay/connector.ts:104-123`),
  with `fallbackGatewayId` existing only for a multiplexing gateway.
- **The list already exists twice and has drifted.** `expectedGatewayProfiles`
  (`control-plane/api/src/relay/gateway-wait.ts:54-66`) excludes retired slugs
  (`NOT_RETIRED_SQL`); `live_companions` (`vm-release.py:1270-1286`) does not.
  Track 2 (#420: a switch restarts every gateway; #294/#289: verify checks every
  profile) is about to need a third copy.
- **Teardown leans on a Hermes feature that is going away.** Step 2 edits the
  interviewer's `multiplex_profile_allowlist` (`scripts/teardown-trip.py:9-17`,
  `:307`, `:436-460`); the newer Hermes has no such allowlist.

Position paper review: "you cannot supervise a lifecycle you do not own, you
can only guess at it" (`docs/future/agent-runtime-position-paper-review.md:69`).

## Behaviour

1. **One answer to "which gateways should run"**: a database function,
   `control_plane.desired_gateways()`, returning one row per known companion
   profile with `desired` and a fixed `reason`. Every consumer reads it: the
   relay's gateway wait, the release tool's switch and verify, the fleet
   monitor, the reconciler. Infrastructure gateways (the interviewer, the
   extraction profile, the fleet monitor) are named by configuration and are
   always desired.
2. **A reconciler** (`scripts/gateway-reconcile.py`, host-side, generic) reads
   that answer, reads what is running through Hermes' CLI, and starts what is
   desired and not running, and stops what is undesired and running. It runs
   after the Hermes container starts, on a timer, and on demand. It is
   idempotent and never restarts a running gateway.
3. **Every action is recorded** with its reason (`gateway_reconcile_actions`),
   so the fleet monitor can tell "stopped because the trip ended" from "not
   running and should be".
4. **The reconciler is the only steady-state starter.** s6 stays the process
   supervisor (it restarts a crashed gateway); Hermes stays the runtime. The
   reconciler talks to Hermes only through `hermes -p <profile> gateway
   start|stop|status` (the interface provisioning already uses) — never s6
   directories or intent records, and no Hermes config beyond the one topology
   key in item 5, set through the CLI. Swapping the runtime later
   (position paper) means swapping one driver.
5. **Topology is a profile property; running is the control plane's call.**
   Owner decision 2026-10-03 (D1): per-trip gateways managed by the control
   plane — not upstream's single multiplexing gateway, and not a static
   per-profile flag deciding whether a gateway runs. On the target Hermes a
   named profile can only have its own gateway with `gateway.standalone: true`,
   so every Kinerary-rendered profile carries it as a *topology* setting,
   written by its template at install time, inert on the current Hermes
   (unknown key — to be confirmed in the rehearsal). Whether it runs is still
   decided only by `desired_gateways()`. The reconciler reads the flag through
   the Hermes CLI and refuses to start a profile that lacks it on a Hermes that
   needs it, rather than starting into the host lock.

### What "desired" means (proposal; the grace period is Dror's decision)

A trip's companion profile (`trips.hermes_profile`, else an open binding's
`hermes_profile`) is desired unless one of these holds, checked in this order —
the first match is the `reason`:

| reason | when |
|---|---|
| `held` | a row in `gateway_holds` names the profile (teardown, operator) |
| `retired` | the slug matches `NOT_RETIRED_SQL`'s prefix |
| `unreachable` | `reachability = 'unreachable'` and the reason is not `TRIP_MCP_BRIDGE_FAILED` (today's rule, both copies) |
| `trip_ended` | a grace period is configured, `end_date` is set, and today is past `end_date + grace` |
| `live` | otherwise — **desired** |

With no grace configured (the default), no gateway is stopped for date reasons:
day one reproduces exactly today's set, retired-slug fix included.

## Acceptance criteria

- AC-1 Given trips covering every row of the table above, when
  `desired_gateways(grace_days)` is called, then each profile gets the expected
  `desired` and `reason`, and `grace_days => NULL` yields no `trip_ended`.
- AC-2 Given `expectedGatewayProfiles` and the release tool's companion list,
  when either runs, then it reads `desired_gateways()` (no second SQL copy
  remains; a test greps both files for the old query).
- AC-3 Given a desired profile that is not running, when the reconciler runs,
  then it issues exactly one `gateway start` for it and records `start/live`.
- AC-4 Given a desired profile that is running, when the reconciler runs (any
  number of times), then it issues no Hermes command for it and records nothing
  but a summary line (idempotent, never restarts).
- AC-5 Given an undesired trip profile that is running and has no relay
  activity within `GATEWAY_STOP_QUIET_MINUTES` (default 10), when the reconciler
  runs, then it issues one `gateway stop` and records `stop/<reason>`; given
  recent activity, then it records `deferred/<reason>` and stops nothing.
- AC-6 Given a running profile that is neither in `desired_gateways()` nor in
  `GATEWAY_INFRA_PROFILES`, when the reconciler runs, then it is left running
  and recorded `unmanaged` (it never stops what it does not know — this covers
  a companion installed a moment before its trip row is written).
- AC-7 Given the database is unreachable or the function errors, when the
  reconciler runs, then it starts nothing, stops nothing, and exits non-zero
  with the reason (no plan is never "stop everything").
- AC-8 Given a profile name that fails `^[a-z0-9][a-z0-9_-]{0,63}$` or is
  absent from `hermes profile list`, when it appears in the plan, then it is
  never passed to Hermes and is recorded `refused`.
- AC-9 Given the reconciler spawns `hermes`, then the child's environment is
  exactly an allow-list (`PATH` fixed to the script's own constant, `HOME`,
  `LANG`, `LC_ALL`, `USER`, plus the named `KINERARY_HERMES_*` variables it
  needs), argv is a list (no shell), and stdin is closed; a test sets a canary
  secret in the parent and asserts it is absent in the child.
- AC-10 Given a Hermes container restart with N live trips, when the reconciler
  has run once, then each of the N profiles has exactly one gateway process
  (`gateway status` and a process count agree) and no "Another profile's
  standalone gateway owns this host" warning appears in the Hermes log since
  the restart. (Proved in the #189 rehearsal against both Hermes versions.)
- AC-11 Given teardown of a trip, when it runs, then it inserts a
  `gateway_holds(profile, 'teardown')` row before stopping the gateway, so a
  reconciler run between the stop and the slug retirement does not restart it;
  and the allowlist step is skipped, recorded "not applicable", when the
  interviewer config has no `multiplex_profile_allowlist` key.
- AC-12 Given `kinerary-cp-release`'s switch restarts gateways (Track 2, #420,
  spec `420-switch-restarts-every-gateway.md`), when it runs after this lands,
  then its *expected* set is `desired_gateways()` plus `GATEWAY_INFRA_PROFILES`,
  and its `restart_gateway(profile)` function (introduced by #420) calls this
  reconciler's driver (`gateway-reconcile.py restart --profile P`) — one spawn
  path, one allow-listed environment. #420's discovery of the *running* set
  stays (a restart must reach whatever is running).
- AC-14 Given the target Hermes and a desired profile previously stopped (so
  carrying `gateway.parked`), when the reconciler starts it, then it is running
  and connected to the relay under its own gateway id, and the root gateway
  logs no `[MULTIPLEX] Profile '<p>'` line for any Kinerary profile. (Rehearsal.)
- AC-15 Given a desired profile without `gateway.standalone: true` on a Hermes
  whose boot reconciler needs it, when the reconciler runs, then it does not
  start it and records `refused/not_standalone`; on the current Hermes the
  flag is not required.
- AC-16 Given each Kinerary profile template (companion, extraction,
  interviewer, fleet monitor bootstrap), when a profile is rendered, then its
  config carries `gateway.standalone: true`, and the interviewer's
  `multiplex_profile_allowlist: []` stays (on the current Hermes an absent
  allowlist means serve every profile).
- AC-13 Given the fleet MCP, when the monitor asks, then it can read the last
  reconcile run per profile (action, reason, outcome, time) read-only, with free
  text folded per `foldSql`.

## Contracts

- **Migration** `control-plane/db/migrations/<YYYYMMDDHHMMSS>_gateway_desired_state.sql`:
  ```sql
  -- rollback: compatible — adds a function and two tables nothing older reads; the prior version keeps working and ignores them
  CREATE TABLE control_plane.gateway_holds (profile text PRIMARY KEY CHECK (char_length(profile) BETWEEN 1 AND 64),
    reason text NOT NULL CHECK (reason IN ('teardown','operator')), note text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz);
  CREATE TABLE control_plane.gateway_reconcile_actions (id bigserial PRIMARY KEY, run_id text NOT NULL, profile text NOT NULL,
    trip_id text, action text NOT NULL CHECK (action IN ('start','stop','restart','deferred','unmanaged','refused','noop')),
    reason text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('ok','failed','skipped')), detail text, at timestamptz NOT NULL DEFAULT now());
  CREATE FUNCTION control_plane.desired_gateways(grace_days integer DEFAULT NULL)
    RETURNS TABLE (profile text, trip_id text, slug text, desired boolean, reason text) …;
  ```
  Retention for actions: rows older than 90 days pruned by the reconciler itself.
- **New** `scripts/gateway-reconcile.py` — verbs `plan` (read-only, JSON),
  `reconcile` (default), `restart --desired` (for the release switch),
  `restart --profile P`. Platform drivers: Linux (Hermes CLI, which under the
  container is s6), macOS (launch agents, the split `teardown-trip.py:84,311-318`
  already makes). Configuration by environment only:
  `GATEWAY_INFRA_PROFILES` (comma list), `GATEWAY_ACTIVE_GRACE_DAYS` (unset =
  off), `GATEWAY_STOP_QUIET_MINUTES`, plus the container/psql variables
  `teardown-trip.py` already reads (`KINERARY_HERMES_CONTAINER`, its Postgres
  container variable). Exit 0 converged, 1 an action failed, 2 refused to plan.
  One host-wide lock file so two runs never overlap.
- **Changed** `control-plane/api/src/relay/gateway-wait.ts` (reads the function),
  `control-plane/deployment/vm-release.py` (`live_companions`, `cmd_restart_bridges`,
  and #420's switch call the reconciler), `scripts/teardown-trip.py` (hold,
  allowlist step conditional), the fleet MCP (one read-only query).
- **Changed** templates (AC-16): `profile-templates/familytrip-companion/`,
  `profile-templates/kinerary-extract/`,
  `profile-templates/trip-intake-interviewer/templates/config.overlay.yaml.tpl`
  (the `gateway:` block at `:35`), `scripts/bootstrap-fleet-monitor.sh`.
  Already-installed profiles get the key through a one-off, idempotent
  `gateway-reconcile.py ensure-topology` (Hermes CLI `config set`, logged per
  profile), run in the release before the Hermes bump — the only config write
  the script makes, and only that key.
- **Deployment side (`kinerary-deploy`, not this repo):** the timer/launch agent
  that runs `reconcile` every 5 minutes and after the Hermes container starts,
  and the `GATEWAY_*` values.

## Non-goals

- Changing who *installs* a companion (`companion-install-host.sh` still starts
  the gateway it installs; the reconciler then agrees with it).
- Adopting upstream's single multiplexing gateway (an architecture change to
  `connector.ts` routing, ruled out by D1), or letting `gateway.standalone`
  decide whether a gateway runs.
- A grace period value, or stopping gateways of ended trips by default.
- Per-user activity rules beyond the open binding (Sprint 8+ if wanted).
- The #346 approval lane.

## Security and boundary notes

This spawns processes that hold a trip's companion credentials — boundary
review required before merge.

- **Allow-listed environment**, the `claudeChildEnv`/`codexChildEnv` model
  (`control-plane/api/src/model-runner.ts:501-552`, #192) and trip-mcp's
  (#284): nothing from the reconciler's own environment reaches Hermes unless
  named (AC-9). Under the container, gateways inherit the container's env via
  s6 `with-contenv`, not the caller's — the allow-list keeps it that way.
- **No shell, validated names, existing profiles only** (AC-8); the reconciler
  never creates, edits or deletes a profile.
- **Fail closed on uncertainty** (AC-6, AC-7): unknown profiles are left alone,
  a missing plan changes nothing. The one destructive verb, `stop`, needs a
  positive reason from the database and a quiet period.
- **No new network surface.** Host-side script reading the database the way
  the release tool does; no route, no key. It never gains the Docker socket for
  the Hermes container (compose.vm.yml's rule stands).
- The fleet MCP gains a read; it stays read-only.

## Test plan

Written first:
- `control-plane/api/test/gateway-desired.test.ts` (DB suite, test database
  only): AC-1 per row of the table; AC-2 relay wait equals the function's
  desired set.
- `tests/scripts/test_gateway_reconcile.py`, with a stand-in `hermes` and
  `docker` on `PATH` recording argv and environment, and a stand-in psql
  answering the plan: AC-3..AC-9, AC-12 (the release switch's dry run lists the
  reconciler's plan), lock-file overlap.
- `tests/scripts/test_teardown_trip.py`: AC-11 (hold before stop; allowlist
  step "not applicable" when the key is absent).
- `tests/scripts/test_vm_release.py`, `test_vm_release_rehearsal.py`: the
  companion list comes from the reconciler (AC-2, AC-12).
- `tests/scripts/test_fleet_mcp.py`: AC-13.
- `tests/scripts/test_gateway_reconcile.py` also: AC-15 (stand-in `hermes`
  reporting a version that needs the flag), `ensure-topology` idempotence and
  that it writes only `gateway.standalone`.
- Template render tests (existing suites for each template, plus
  `tests/scripts/test_fleet_monitor.py` for the bootstrap): AC-16.

Suites: control-plane API (with `CONTROL_PLANE_TEST_DATABASE_URL`), `tests/scripts`.
Manual: AC-10 and AC-14 in the #189 container rehearsal, with made-up
profiles, on both the current and the target Hermes.

## Rollout and regression

Live-trip behaviour: a gateway can now be started or stopped without a person.
Day one is shadow mode: `reconcile --dry-run` on the timer for one week of
staging, recording what it would do; then live on staging; on production only
inside the complete release behind the MVP VM-upgrade gate, before the Hermes
bump in that release. Needs a per-PR regression plan (migration, process
spawning, relay wait).

**Track 2 dependency (explicit).** #420 (switch restarts every gateway) and #294
(verify every profile) need "which gateways should run". This spec is the single
source of that list. Proposed order: PR 1 — the migration with
`desired_gateways()` and the `gateway-wait.ts` switch-over, small, ahead of
#420; #420 and #294 then read the function instead of `live_companions()`;
PR 2 — the reconciler, after which #420's `restart_gateway()` delegates to its
driver (AC-12). If #420 must ship before PR 1, it adds the retired filter to
`live_companions()` as its spec says, and PR 1 deletes that copy.

## Open questions

0. Confirm the reading of D1 (2026-10-03): `gateway.standalone: true` on every
   Kinerary profile as the *mechanism* that lets per-trip gateways exist on the
   target Hermes, with the run decision staying in `desired_gateways()`. If D1
   meant "no standalone flag at all", the only other route is multiplex-only,
   which D1 also rules out — so this needs your word before build.
1. Grace period after `end_date` before a companion stops (proposal: off for
   the MVP; 7 days when turned on). And: should a trip *before* its start date
   run its companion (today: yes)?
2. Where the reconciler runs: host-side script (proposed; the API and worker
   containers have no way into the Hermes container and should not get one) vs
   the worker over the forced-command SSH path provisioning uses.
3. The source for "recent relay activity" per companion (AC-5): the relay's
   assistant events (#177) or a new last-activity column on the binding.
4. Should the interviewer and the fleet monitor be rows in the database
   (visible to the monitor like companions) instead of `GATEWAY_INFRA_PROFILES`?
