# Rehearse the newer Hermes on staging, before the release that carries it

Status: draft (2026-10-19) · Issue: #189 · Track: T3 · Size: M · Tier: Normal
Security path: yes (re-checks companion write confinement, #314, under the newer Hermes — `boundary-reviewer` evidence) · Migration: no · Live-trip behaviour: no (off production; nothing deploys)

## Problem

Production runs Hermes `ab0d984145` (2026-08-24); the target is `4097709b0c`
(the revision the patch set is rebased onto,
`control-plane/deployment/hermes-patches/README.md:17-23`). The staging Mac's
own Hermes install already runs the target, but only in its launchd shape,
which cannot show what the production container does
(notes folder, `regression-plans/2026-10-03-vm-hermes-upgrade-to-4097709b0c.md`,
"What the Mac test cannot cover"). Unproven, and each one a blocker or a way
back:

- **F1** container boot under the target registers named gateways down and
  folds them into a multiplexing root gateway with no relay credentials —
  predicted "no companion connected" after an unmodified upgrade.
- **F4** the target migrates `state.db` (26 → 31) and config (38 → 49); whether
  the old image boots over migrated data is untested, so the way back is
  unproven.
- **F8** container boot time, which is the length of a companion outage.
- The 2026-10-03 container rehearsal stopped at the build: the staging Docker
  engine predates BuildKit features the target Dockerfile uses (`COPY --link`,
  `COPY --chmod`), and upgrading it needs the owner at a Terminal.

The three readiness items exist so this rehearsal can pass: #379 (the image
build verifies), #380 (the relay's Hermes assumptions are pinned to the
target), #349 (the control plane, not Hermes' boot logic, starts each gateway).

## Behaviour

One rehearsal, two parts, on staging only, with made-up profiles. It ends with
a test report that either clears the Hermes component for the complete release
or names what blocks it. It never builds on, writes to, or upgrades production.
The production Hermes bump stays inside the one complete release behind the MVP
VM-upgrade gate (owner decision, 2026-10-03: all six conditions, in order) —
there is no standalone production Hermes bump.

## Entry criteria

- E-1 #379, #380 and #349 are merged to `main` and each spec is marked
  verified (verifier report, criterion by criterion).
- E-2 A build engine with a current BuildKit is available to staging (the
  owner's decision: upgraded Docker Desktop, Colima, or another builder he
  names).
- E-3 No other live or e2e run is using the staging stack in the window, and
  the window does not cross the nightly staging redeploy.
- E-4 The staging relay and interview sidecar are up (needed for part B).

## Acceptance criteria (the checklist)

Part A — container shape, isolated (synthetic data: a profile tree shaped like
production's — three made-up trip companions, the interviewer, the extraction
profile, the fleet monitor — with no secrets and no `auth.json`):

- AC-1 Given a fresh `git archive 4097709b0c` snapshot, when
  `build-hermes-image.sh --source <snapshot> --base-rev 4097709b0c` runs, then
  it builds, its verify step passes (#379), and `hermes-image-check.sh <image>`
  passes (manifest and psql).
- AC-2 Given the same snapshot, when `capture-hermes-mirror.py --check` runs
  against the committed fixture, then it exits 0 (#380).
- AC-3 Given the image started the way production starts it (`sleep infinity`,
  the Hermes uid, s6), when the container boots and the reconciler runs once,
  then every desired synthetic profile has exactly one gateway process, the root
  gateway multiplexes no Kinerary profile, and no "another gateway owns this
  host" warning appears (#349 AC-10, AC-14). Boot-to-converged seconds are
  recorded.
- AC-4 Given AC-3, when the container is restarted twice, then AC-3 holds each
  time with no reconciler action beyond starting what boot left down.
- AC-5 Given a test relay connector on a port the staging relay does not use,
  when the gateways dial it, then each connects under its own gateway id (none
  through `fallbackGatewayId`).
- AC-6 Given the data tree migrated by the target, when the current production
  image is started over a copy of it, then the result (boots and serves, or
  fails and how) is recorded — this decides whether an image-only rollback is
  usable or `--restore-hermes` / the snapshot is the only way back.
- AC-7 Given teardown of one synthetic trip, when it runs against the
  container, then its gateway stays stopped and its profile stays deleted
  through two reconciler ticks (#349 AC-11).

Part B — staging with the relay up (throwaway profiles and a test trip; the
owner's personal profiles are not touched):

- AC-8 An interview starts, takes a document, and confirms.
- AC-9 A companion turn that triggers a deferred tool call writes to the test
  site; the gateway log shows no tool-call parse error.
- AC-10 A PDF sent in the test group lands as a booking (media hand-off).
- AC-11 `/trips` and `/switch` route between two companions, and the relay log
  shows each turn served by the companion's own gateway id.
- AC-12 A companion reply carries `reply_to` from its triggering message (#177).
- AC-13 A companion write outside its allowed root is staged or denied,
  evidenced by `boundary-reviewer` with the actual request and response (#314).

## Contracts

None changed by this item. It uses: `control-plane/deployment/build-hermes-image.sh`,
`hermes-image-check.sh`, `scripts/capture-hermes-mirror.py` (#380),
`scripts/gateway-reconcile.py` (#349), `scripts/teardown-trip.py`, and the
staging stack as documented in CLAUDE.md. Rehearsal-only helpers (the
synthetic profile tree, the test connector run) live in the scratchpad or in
`kinerary-deploy`, not here.

## Non-goals

- Upgrading production Hermes, or building an image on the production host.
- Switching the staging Mac's real profiles; the owner's own Mac test (gate
  condition 3) is separate.
- The #346 approval lane.

## Security and boundary notes

Part A runs with no secrets (`--network none` except for the test connector's
loopback). Part B uses throwaway profiles. AC-13 is the security check:
write confinement under the newer Hermes is re-proved with live evidence, not
assumed from the old revision.

## Test plan

Evidence, not new suites. Exit evidence, all in one test report in the notes
folder (`$KINERARY_NOTES_DIR/test-reports/<date>-hermes-rehearsal.md`, never the
repo): per AC a verdict with the raw output; the image tag and its manifest;
boot seconds (AC-3, AC-4); the rollback verdict (AC-6); the verifier report for
AC-1/AC-2 and the `boundary-reviewer` report for AC-13. A failed AC becomes an
issue, named in the report, before the report is marked done. The report is an
input to gate condition 5 (the regression assessment), not a go decision.

## Rollout and regression

Nothing ships. The result feeds the complete release: if all ACs pass, the
release carries the Hermes bump with the #349 reconciler running in it before
the bump; if AC-6 fails, the release's way back for Hermes is `--restore-hermes`
or the snapshot, written into its upgrade plan (gate condition 4).

**Risks**
- The staging Docker engine is too old to build the target image and the
  upgrade needs the owner's admin password at a Terminal (E-2). Without it,
  part A cannot start.
- Staging relay or sidecar down (last seen down on 2026-10-03) blocks part B.
- If AC-3 fails even with `gateway.standalone: true`, #349's topology needs
  rework before the release — not a workaround in the rehearsal.
- The model is non-deterministic: part B is one sample per check.

## Open questions

1. E-2: which build engine, and when can you do the install?
2. If no staging engine is available in time, may part A's *build* (not the
   run) happen on another machine you name, with the image copied to staging?
3. Soak: how long should part B run on the target before the report is
   written (proposal: one day of nightly e2e against it)?
