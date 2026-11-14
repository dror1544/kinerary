# One rollout command per trip

Status: approved (2026-11-14, by Dror: "Agree with your recommendations") · Issue: #568 (#127 and #190 are related) · Track: delivery · Size: L (three slices) · Tier: High
Security path: yes (the approval hooks; a process spawned with an environment) · Migration: yes · Live-trip behaviour: yes (it is the deploy)

Decision behind it: `CLAUDE.md`, "Faster delivery (owner's decision, 2026-11-14)", item 2
and the rule "a deploy is approved per rollout, not per step";
`docs/agent-team-plan.md` §9, decision 12.

## Problem

A merged change reaches a running trip in pieces, each run by hand, in an order that
matters, and nothing records the result.

- The order is written in a runbook, not in a command
  (`docs/control-plane-ops-runbook.md`, "A change that reaches a trip in pieces"):
  site payload, then the trip's bridge, then the companion's prompt.
- **No record says which version a trip runs.** `trips` has no such column; it can
  only be derived from the latest executed plan's `release_id`
  (`control-plane/db/migrations/0001_foundation.sql:77-87`), which a hand deploy does
  not touch. The companion's and bridge's commit exist only as a file on disk
  (`scripts/companion-install-host.sh:859-865`). `docs/specs/sprint-8/127-trip-build-provenance.md`
  covers part of this and is unscheduled.
- **The only redeploy path in code is a full re-provision** (`retryProvision`,
  `control-plane/api/src/planner.ts:271-445`): it excludes trips that are `active`,
  regenerates the trip's config from the interview, asks the organizer to approve
  again, sends the "your trip is ready" notification again, and always takes the
  newest release. The `upgrade` and `rollback` job types exist only as names in a
  CHECK list (`0001_foundation.sql:80,93`).
- **A release covers the site only.** Its manifest lists `site/`, `server/` and
  `shared/` (`control-plane/api/src/release-artifact.ts:47-60`). The bridge (`mcp/`)
  and the companion templates (`profile-templates/`) run from whatever checkout is on
  the host.
- **An existing companion cannot be re-rendered.** The installer answers
  `ALREADY_PRESENT` and leaves `SOUL.md` as it was
  (`scripts/companion-install-host.sh:1258-1270`).
- **Half of the hand-run steps are never prompted.** The hook classifies `deploy.sh`
  and `docker restart` as deploys, but not the bridge restart, the prompt refresh or
  a gateway restart (`scripts/claude-hooks/match-command.py:47-85`), and its prompt
  text never names a trip, a commit or a step
  (`scripts/claude-hooks/pretooluse-bash.sh:473-478`).

## Behaviour

One command brings a named release to named trips.

- `plan` shows, for each trip, the version it runs now, the version it would get, the
  steps that would run, and any reason it would be refused. It changes nothing and is
  never prompted.
- `execute` runs a plan that was written to a file. The approval prompt reads that
  file and names the commit, the trips and the steps. One approval covers exactly
  that plan.
- For each trip the steps run in order and stop at the first failure:
  1. **site**: the release's `site/`, `server/` and `shared/`, without touching the
     trip's own config or data, then a restart and the site's own health check;
  2. **bridge**: restart from the same release, then ask the bridge whether it can
     reach its trip;
  3. **companion**: re-render the profile's instructions and skills from the same
     release, clear the saved prompts, restart the gateway, and wait until its tools
     are registered;
  4. **switches**: write the trip's resolved feature switches (`567-feature-switches.md`,
     S2).
- The trip's row records the release it now runs and the one it ran before. Rolling
  back is the same command naming the previous release.
- Trips are done one at a time. With more than one trip, the first is a canary: the
  rest start only after it passed every step.
- The organizer is not asked to approve, is not notified, and the trip's lifecycle
  state does not move. A trip that is `active` can be rolled out.

Slices:

1. **R1: site, bridge, record, approval.** Steps 1 and 2, the record, the plan file,
   the hook.
2. **R2: companion.** Step 3, and the release manifest extended to carry `mcp/` and
   `profile-templates/`.
3. **R3: the fleet.** `--all`, the canary order, and the request-and-code gate for an
   agent on the production host.

## Acceptance criteria

R1

- AC-1 Given `plan --release <id> --trip <slug>`, then it prints the trip's current
  release, the target release and its commit, and the ordered steps, writes the same
  to the plan file, and changes nothing in the database or on any host.
- AC-2 Given a release that is not `available`, or whose `data_schema` range does not
  cover the trip, then `plan` refuses for that trip and says why.
- AC-3 Given `execute --plan-file F`, when a trip in F no longer runs the release the
  plan recorded as current, then that trip is refused and no step runs for it.
- AC-4 Given `execute`, then before the first step a `trip_rollouts` row exists with
  result `running`; after the last step it is `ok`; after a failed step it is
  `failed` with the step name; later steps did not run.
- AC-5 Given a completed rollout, then `trips.current_release_id` is the target and
  `trips.previous_release_id` is what it ran before. Given a failed site step, then
  neither column changed.
- AC-6 Given a rollout, then the trip's `trip.config.json`, its participants and its
  SQLite data are byte-identical before and after step 1.
- AC-7 Given a rollout, then no `plan_approvals` row, no organizer notification and
  no lifecycle transition was created.
- AC-8 Given step 2, when the bridge's health check answers anything but
  "reachable", then the step fails with the health code
  (`mcp/mcp.js:1732-1744`).
- AC-9 Given an environment in which the deployment root, the deploy script or the
  bridge script is not configured, then the command refuses and names the missing
  variable. No host, address, container name or path is defaulted in this repository.
- AC-10 Given Claude Code runs `execute`, then the hook asks under hard rule 2 with
  the plan file's commit, trips and steps in its text; `plan` is silent; a subagent
  is refused. Given the bridge-restart script, the prompt-refresh script or a gateway
  restart run on their own, then the hook asks.
- AC-11 Given the plan file is missing, unreadable or changed since `plan` wrote it
  (digest mismatch), then `execute` refuses.
- AC-12 Given `execute --release <previous>`, then the trip returns to the previous
  release by the same steps and the two columns swap.

R2

- AC-13 Given a release, then its manifest and digest cover `mcp/` and
  `profile-templates/` as well as the site, and an older release without them is
  refused for steps 2 and 3 with a clear message.
- AC-14 Given step 3, then the profile's `SOUL.md` and skills match a fresh render
  from the release for that trip, the profile's conversation history and memory are
  untouched, and a profile edited in place is reported and not overwritten unless the
  plan says so.
- AC-15 Given a conversation turn in flight, then step 3 waits up to a bounded time
  and fails rather than cutting the turn.
- AC-16 Given step 3 finished, then every tool the release's bridge declares is
  registered on the gateway, read from the gateway's own log.

R3

- AC-17 Given `plan --all`, then the plan file lists every eligible trip by name;
  `execute` never resolves "all" again.
- AC-18 Given more than one trip, when the first fails, then no other trip is
  touched and the output says so.
- AC-19 Given an agent on the production host requests a rollout, then the action is
  dry-run first, frozen, and runs only after the owner's one-time code, as
  `kinerary-cp-release gate` does today
  (`control-plane/deployment/vm-release.py:943-1087`).

## Contracts

**Command: `scripts/trip-rollout.py`** (new)

```
trip-rollout.py plan    --release <id|commit> (--trip <slug>[,<slug>…] | --all) --plan-file <path>
trip-rollout.py execute --plan-file <path> [--steps site,bridge,companion,switches]
trip-rollout.py status  [--trip <slug>]
```

- Resolves a trip the way `scripts/teardown-trip.py` does: the database row, then the
  trip's `topology.yaml` under the deployment root, then a check that the container's
  hostname is the one the topology names (`teardown-trip.py:287-322`, `:775-830`).
- Deployment values come only from the environment: `KINERARY_DEPLOY_ROOT`, the
  deployment's `provisioning.env` or `vm.env`, `KINERARY_TRIP_DEPLOY_CMD`,
  `KINERARY_BRIDGE_RESTART_CMD`. Unset is a refusal (AC-9). The defaults in
  `teardown-trip.py` and `trip-autostart.py` are on the `.preflight-allow` backlog and
  are not copied.
- Step 1 materializes the release (`release_source.materialize_release_source`,
  verifying the digest) and runs the deployment's deploy script with that tree and a
  restart, **without** the flag that overwrites the trip's config.
- A thin wrapper in the deployment repository supplies the values, as
  `bootstrap-monitor.sh` does for the fleet monitor.

**Migration: `<timestamp>_trip_rollouts.sql`**, header
`-- rollback: compatible — new table, two nullable columns`.

- `control_plane.trips` gains `current_release_id` and `previous_release_id`
  (nullable, referencing `releases`). Backfilled from each trip's latest executed
  plan whose provision job succeeded; a trip with none stays null and `plan` shows
  "unknown".
- `control_plane.trip_rollouts (id, trip_id, from_release_id, to_release_id, steps
  jsonb, result text CHECK (result IN ('running','ok','failed')), failed_step text,
  actor text, plan_digest text, started_at, finished_at)`, append-only apart from
  closing its own row.
- Both columns granted to the monitor's read-only role, so the fleet monitor can
  report each trip's version.

**Provisioning** (`control-plane/worker/control_plane_worker/provisioner.py`): a
successful provision sets `current_release_id` too, so the record is true for new
trips from their first day.

**Release manifest** (R2, `control-plane/api/src/release-artifact.ts`): add `mcp/` and
`profile-templates/` to the listed trees. Releases built before this stay valid for
the site step.

**Companion re-render** (R2): `scripts/companion-install-host.sh` gains a re-render
request kind; `render_profile.py` gains an in-place mode that replaces rendered files
only. `scripts/companion-refresh-prompts.sh` gains a wait for tool registration and a
`--dry-run`.

**Hooks**: `match-command.py` classifies `trip-rollout.py execute`, the bridge
restart, `companion-refresh-prompts.sh` and a gateway stop/start as deploys;
`trip-rollout.py plan|status` stay silent. `pretooluse-bash.sh` reads the plan file
inside its existing time budget and puts the commit, trips and steps in the prompt.
Tests in `tests/scripts/test_match_command.py` and `test_claude_hooks_bash.py`.

## Non-goals

- Per-trip version pinning as policy, channels and cohorts (#190). This records and
  moves a trip's version; it does not decide which trips should differ.
- Upgrading the control plane itself. That stays `kinerary-cp-release`.
- Parallel rollouts.
- Keeping a copy of the previous code on the trip's container. The way back is the
  previous release, materialized again from git.
- Replacing `retryProvision`. A trip that failed to build is still retried that way.
- The rest of #127 (refusing a dirty or unlisted checkout at install). R2 makes the
  companion come from a release, which removes the case; #127 is then re-read.

## Security and boundary notes

- **Hard rule 2.** `execute` is a deploy. One approval covers one plan file, bound by
  digest (AC-11); a changed plan asks again. A subagent is refused.
- **Hard rule 6.** No host, address, container name, VMID or path in the script, the
  spec or the tests. Tests use a fake deploy command and a fake topology.
- **A process spawned with an environment.** The deploy and bridge commands run with
  an allow-listed environment, as model children do since #192; a trip's keys are
  read inside the step, fed on stdin, never printed, logged or put on a command line.
- **Trip data is not read.** The rollout reads versions and health, never what
  travellers wrote (alpha-tester data policy).
- **The site step must not serve a field it did not serve before** merely because
  the code is newer: the boundary review reads `GET /api/config` and
  `GET /api/config/warnings` before and after a rollout on a staging trip.
- **The fleet monitor stays read-only**: it reads the two new columns and writes
  nothing.

## Test plan

Written first, from the criteria.

- `tests/scripts/test_trip_rollout.py`: AC-1 to AC-12 with a fake deploy command, a
  fake bridge and a `cptest_*` database; AC-9 with an empty environment.
- `tests/scripts/test_match_command.py`, `test_claude_hooks_bash.py`: AC-10.
- `control-plane/api/test/release-artifact.test.ts`: AC-13.
- `tests/scripts/test_companion_install_host.py`, a new
  `test_companion_refresh_prompts.py`: AC-14 to AC-16.
- `control-plane/worker/tests/`: provisioning sets `current_release_id`.
- `scripts/preflight-deploy.sh --deploy --auto`: after its trip is built, roll it out
  to the same release and to the one before, and assert the record.
- Staging, by hand, once per slice: roll one staging trip forward and back.

## Rollout and regression

- Carries a migration and changes the approval hooks: a regression plan is needed.
- The migration's backfill reads existing plans and writes two nullable columns; no
  live trip changes behaviour until a rollout is run for it.
- First production use: one trip nobody is travelling on, forward and back, before
  any other.
- The hook change means the bridge restart and prompt refresh start asking where
  they were silent. That is intended and is said in the PR.

## Decisions (Dror, 2026-11-14)

1. **The bridge and the companion templates go into the release** (R2), so a trip's
   site, bridge and companion are one version.
2. **A profile edited in place is refused and reported** (AC-14), never overwritten;
   it is captured first under the existing rule in `CLAUDE.md`.
3. **Staging bridges move to a LaunchAgent before R1 is exercised on staging.** That
   is deployment work on the staging host, outside this repository; until it is done
   the bridge step is expected to fail there and is proved in tests.
4. **A trip with no recorded release may be rolled out** from "unknown"; the plan
   says that no way back is recorded for that first rollout.
