# Each trip records the checkout that built its companion, and a bad checkout is refused

Status: draft (2026-10-19) · Issue: #127 (slice 1 of #190) · Track: T2 · Size: M · Tier: Normal
Security path: no (none of the three named invariants; touches the forced-command script, which runs as the Hermes host user) · Migration: yes · Live-trip behaviour: no (existing trips are not rebuilt)

> **Partly built on integration/sprint-7 (2026-10-19):** `818e3b8` puts `built_from` into the worker's log message. Still owed: everything else here — the `PROVENANCE` line, the trip-row column, the allow file and the release-tool report.

## Problem

A companion is rendered and its trip-mcp bridge wired by whichever checkout the
SSH forced command names, and the product keeps no durable record of which
(#127; `docs/future/release-channels-and-organizer-spinoffs.md`, Sequence 1:
"the commit, a dirty-tree flag and an allowed-ref check, shown to the fleet
monitor" — owner's decision 2026-09-25, "record and refuse").

What exists today, and where it stops:

- `scripts/companion-install-host.sh:543-552` writes `companion-provenance.json`
  beside the trip (commit, branch, wired_at) and prints `WIRED <profile> <commit>`
  (`:773`) — **only on the bridge path**. The profile render path prints
  `INSTALLED <profile>` with no provenance (`:808`), and it is the one that
  decides the companion's templates.
- No dirty-tree flag; `repo_commit` (`:543-545`) is `rev-parse --short HEAD`.
- No allowed-ref check: the 2026-09-20 install ran from a feature branch 12
  commits behind and printed `WIRED` (#127 body).
- The worker reads the commit (`control-plane/worker/control_plane_worker/mcp_bridge.py:210-218`)
  and puts it only in a log line (`provisioner.py:2026-2035`, `built_from`). The
  database, the fleet monitor and `kinerary-cp-release status` cannot see it.
- The `INSTALLED` parser (`companion_profile.py:276-280`) takes everything after
  the first space as the profile name, so appending a token there would break it.

## Behaviour

- Every companion install (render) and every bridge wiring states the commit it
  ran from, whether the tree was clean, and which allowed ref it matched.
- The install host **refuses** — exit non-zero, no profile rendered, no bridge
  wired — when its checkout is dirty or HEAD is not at an allowed ref. The
  provisioning job fails loudly with code `COMPANION_CHECKOUT_REFUSED`.
- The trip row records it; the fleet monitor shows it; `kinerary-cp-release
  status` lists each live trip's companion commit beside the control plane's
  `KINERARY_REV`, flagging a difference (reported, never refused: upgrades move
  the control plane on purpose and leave existing companions where they are).

**Allowed refs** live in a deployment file, `$KINERARY_DEPLOY_ROOT/companion-install.allow`
(readable by the Hermes host user, like `setup-mcp.sh`; never in this repo).
One rule per line: `tag:<glob>` (HEAD carries a matching tag, e.g. the release
tool's `deployed/*`) or `branch:<name>` (HEAD equals the last-fetched tip of
`origin/<name>`; behind it is refused — that is the #127 failure). No file →
refuse, saying which file is missing. The script never fetches.

## Acceptance criteria

- AC-1 Given a clean checkout whose HEAD carries tag `deployed/abc1234` and an
  allow file with `tag:deployed/*`, when a companion is installed, then stdout
  ends with `PROVENANCE abc1234 clean tag:deployed/abc1234` followed by
  `INSTALLED <profile>`, and `companion-provenance.json` gains `dirty:false`,
  `matched_ref`, and `rendered_at`.
- AC-2 Given a tracked file modified in the checkout, when an install or bridge
  request arrives, then the script exits 2 with
  `REFUSED_CHECKOUT dirty`, renders nothing, starts no gateway, wires no bridge.
- AC-3 Given HEAD one commit behind `origin/integration/sprint-7` and an allow
  file with only `branch:integration/sprint-7`, then it exits 2 with
  `REFUSED_CHECKOUT not-at-allowed-ref <commit>`.
- AC-4 Given no allow file, then it exits 2 with
  `REFUSED_CHECKOUT no-allow-file companion-install.allow`.
- AC-5 Given the bridge path succeeds, then stdout is
  `PROVENANCE <commit> clean <ref>` then `WIRED <profile> <commit>` (third token
  kept, so an older worker still parses it).
- AC-6 Given a host that prints no `PROVENANCE` line (older checkout), when the
  worker parses, then the install succeeds and the trip records
  `companion_built_from = 'unreported'`.
- AC-7 Given a `PROVENANCE` line, when the worker finishes the companion step,
  then `trips.companion_built_from`, `companion_built_clean`,
  `companion_built_ref`, `companion_built_at` hold it; after the bridge step,
  `bridge_built_from` likewise. A malformed line (commit not `[0-9a-f]{7,40}`,
  ref not `[A-Za-z0-9._/*:-]{1,100}`) is recorded as `unreported`, never stored
  raw.
- AC-8 Given a refusal, when the provisioning job ends, then it fails with
  `COMPANION_CHECKOUT_REFUSED` and the reason token, visible in the fleet MCP's
  job listing.
- AC-9 Given trips built from `abc1234` and a control plane at `def5678`, when
  `kinerary-cp-release status` runs, then each such trip is listed as
  "companion built from abc1234 (control plane def5678)", exit 0.
- AC-10 Given the fleet MCP `trip` tool, then it shows the four companion
  fields and `bridge_built_from`, and the monitor role can select exactly those
  new columns and no others.
- AC-11 Given `kinerary-cp-release upgrade <rev>` whose target checkout would be
  refused by the allow file, then Prepare fails ("companion installs from <rev>
  would be refused") before anything changes.

## Contracts

- `scripts/companion-install-host.sh`: `checkout_state()` (commit, clean, matched
  ref, or a refusal token), called before render and before bridge wiring; a
  `PROVENANCE` line before each verdict line; provenance file fields extended.
- `control-plane/worker/control_plane_worker/companion_profile.py` and
  `mcp_bridge.py`: parse an optional `PROVENANCE` line preceding the verdict
  line; `REFUSED_CHECKOUT` maps to error code `COMPANION_CHECKOUT_REFUSED`.
- `provisioner.py`: `_record_trip_companion` (`:721-739`) also writes the
  companion provenance; a new `_record_bridge_provenance`.
- Migration `control-plane/db/migrations/<YYYYMMDDHHMMSS>_trip_build_provenance.sql`:
  ```sql
  -- rollback: compatible — adds nullable columns; older code neither reads nor writes them
  ALTER TABLE control_plane.trips
    ADD COLUMN companion_built_from text CHECK (companion_built_from ~ '^([0-9a-f]{7,40}|unreported)$'),
    ADD COLUMN companion_built_clean boolean,
    ADD COLUMN companion_built_ref text,
    ADD COLUMN companion_built_at timestamptz,
    ADD COLUMN bridge_built_from text CHECK (bridge_built_from ~ '^([0-9a-f]{7,40}|unreported)$');
  ```
- `control-plane/deployment/monitor-db-role.sql` grant list (`:88-89`) gains the
  five columns; `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs` `trip` view.
- `control-plane/deployment/vm-release.py`: `cmd_status` lists provenance per
  live trip; `cmd_upgrade` Prepare checks the target against the allow file.
- Deployment file `companion-install.allow` — created in the private deployment
  repo for each host; documented generically in the runbook.

## Non-goals

Building from a release artifact (#127 option 2); pinning, channels, overlays
(slices 2-5); rebuilding existing companions; recording provenance for the trip
site itself (already `plans.release_id`).

## Security and boundary notes

The forced command's input is unchanged; the new lines are produced by the
script from `git` output and validated by the worker before storage (AC-7), so a
crafted branch name cannot inject a second verdict line. The allow file is read,
never executed. `sanitizeConfig` is unaffected: nothing here reaches a trip site.

## Test plan

Written first: `tests/scripts/test_companion_install_host.py` — AC-1 to AC-5
with a scratch git repo (tag, dirty file, branch behind origin) and the existing
fake `setup-mcp.sh`/`hermes`; `control-plane/worker/tests/test_companion_profile.py`
and `test_mcp_bridge.py` — AC-6, AC-7 (malformed lines), AC-8;
a DB-backed worker test against the CI test database — AC-7 columns;
`control-plane/api/test/migration-rollback.test.ts` covers the header;
`tests/scripts/test_vm_release.py` — AC-9, AC-11 with stubbed `psql`/`git`;
fleet MCP tests — AC-10 including the grant list.

## Rollout and regression

On the VM the forced command runs the release checkout's script, so it changes
at the upgrade that carries it: the allow file (`tag:deployed/*`) must exist on
the VM **before** that upgrade, and AC-11 makes the upgrade refuse otherwise.
On the Mac staging host, create the allow file naming the branch the forced
command's worktree tracks before the worker or that worktree is updated; the
`PROVENANCE` line is ignored by an older worker, so either order is safe. Live
trips: nothing changes until a trip is built. Regression plan: needed (adds a
migration; changes when provisioning refuses).

## Open questions

1. Refuse a dirty tree on the Mac staging host too, or allow an
   `allow-dirty` line there for development? Recommendation: refuse everywhere;
   staging is where #127 happened.
2. Should `restart-bridges` update `bridge_built_from` (it rewires from the
   current checkout), or leave the database to record builds only?
3. Record a refusal also as a trip `unreachable_reason` (needs a CHECK change),
   or is the failed job enough? Recommendation: the job is enough.
