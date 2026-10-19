# Verify every gateway's tools and every bridge's health, against a baseline

Status: draft (2026-10-19) · Issue: #294, #289 · Track: T2 · Size: M · Tier: Normal
Security path: no (none of the three named invariants; reads each bridge's MCP key, see notes) · Migration: no · Live-trip behaviour: no

## Problem

`ControlPlane.verify()` (`control-plane/deployment/vm-release.py:1288-1368`):

- **Checks tool registration for one profile only.** `trip-intake` against
  `interview-mcp.ts` (`:1330-1344`, agent log path hard-coded at `:1332`). A
  companion whose `trip-control` (companion-mcp) or `trip-mcp` connection went
  stale is reported green — strictly worse than the loud failure of 2026-10-18.
- **Reads the newest registration line, whatever its age.** A line written by a
  gateway before the upgrade satisfies the check; it never asks whether the
  registration happened after this switch.
- **Checks that a bridge port listens, not that it works** (`:1363-1366`,
  `ss -ltnH`). A bridge with a stale key (#119) listens and passes while every
  trip tool returns 401 (#294).
- **Cannot tell an old failure from a new one** (#289). A trip whose bridge broke
  yesterday makes every upgrade and rollback "VERIFY FAILED"; `install_tool_files`
  and `prune_after_upgrade` are then skipped (`:1560-1562`), so the tool cannot
  update itself, and an operator may roll back an upgrade that did nothing wrong.

## Behaviour

Verify produces a list of **checks**, each with a stable id, a pass/fail and a
short code. Checks per gateway come from what that profile is configured to use,
not from a list in the tool. An upgrade or rollback takes a **baseline** — the
same checks, run in the Guards phase before anything changes — and after the
switch classifies every failure:

- **caused** — failed now, passed (or did not exist) in the baseline;
- **pre-existing** — failed in the baseline with the same code, *and* the check
  is in an exemptable class (below). Reported, listed in the notification, but it
  does not fail the upgrade and does not skip `install_tool_files`/prune.

Exemptable classes are only those the upgrade does not own: `bridge:<slug>`,
`companion-connected:<profile>`, and `tools:<profile>:trip-mcp` when that trip's
`bridge:` check is itself pre-existing. Everything the switch restarts or
replaces — readyz, migrations, image tags, relay, and every other `tools:` check —
always counts, because a freshly restarted gateway that lacks a tool is this
upgrade's problem even if the old one lacked it too (the 2026-10-18 case).

Standalone `kinerary-cp-release verify` with no baseline reports all failures as
"origin unknown" and exits 2 on any, as today.

**Per-gateway tool checks.** For each profile from `running_gateways()` (spec
`420-switch-restarts-every-gateway.md`) plus each expected profile:

- MCP server names come from the profile's `config.yaml` `mcp_servers` keys.
- The registration line must be **newer than the restart**: the tool records
  each `agent.log`'s size before `s6-svc -r` and reads only after that offset
  (the pattern `companion-install-host.sh` uses, `LOG_FROM`). No fresh line
  within the wait (default 60 s) is `tools:<p>:<server>` fail `NOT_REGISTERED`.
- Expected tool sets, where the server's source is a container the switch just
  replaced: `interview` → `extract_agent_tools(interview-mcp.ts)` (existing);
  `trip-control` → a new `extract_companion_tools(companion-mcp.ts)`. Missing
  names fail `MISSING:<n>`. Any other server (`trip-mcp`, a monitor's servers)
  must register ≥1 tool.
- An expected profile that is not running: `gateway:<p>` fail `NOT_RUNNING`.

**Bridge checks** (`bridge:<slug>`): port check first (as today, cheap), then
`GET /health` on `127.0.0.1:<MCP_PORT>` with header `X-API-Key` read from the
trip's `mcp/.env`, in-process (`urllib`), 15 s timeout. Codes mirror
`bridge_health_code` in `scripts/companion-install-host.sh`: `ok`, `HTTP_<n>`,
`E<errno>`, `BRIDGE_401`, `NO_KEY`, `NO_HEALTH_ROUTE`, `none`, `UNRECOGNIZED`.

## Acceptance criteria

- AC-1 Given profile `trip-a` whose `config.yaml` names `trip-mcp` and
  `trip-control`, and a fresh `agent.log` line registering `trip-control` without
  `report_bug`, when verify runs, then it fails `tools:trip-a:trip-control`
  with `MISSING:report_bug`.
- AC-2 Given an `agent.log` whose only `interview` registration line predates
  the recorded restart offset, when verify runs after the switch, then
  `tools:trip-intake:interview` fails `NOT_REGISTERED`.
- AC-3 Given a bridge that listens and answers `/health` with
  `{"ok":false,"code":"HTTP_401"}`, when verify runs, then `bridge:<slug>` fails
  with `HTTP_401` and the report names `restart-bridges` as the repair.
- AC-4 Given a bridge whose `/health` answers 404 `Cannot GET /health`, when
  verify runs, then the code is `NO_HEALTH_ROUTE` and the report says "cannot be
  verified", distinct from a failure.
- AC-5 Given a baseline in which `bridge:japan` failed `HTTP_401`, and the same
  after the switch, when the upgrade's verify classifies, then it is
  pre-existing, the history row result is `ok`, `install_tool_files` and
  `prune_after_upgrade` run, and the notification lists it under "already
  failing before this upgrade".
- AC-6 Given a baseline in which `bridge:japan` failed `HTTP_401` and after the
  switch it fails `ECONNREFUSED`, then it is caused (different code).
- AC-7 Given a baseline in which `tools:trip-intake:interview` failed, and the
  same after the switch, then it is caused (non-exemptable class) and the result
  is `verify-failed`.
- AC-8 Given standalone `verify` with no baseline and one failing check, then
  the exit code is 2 and the failure is labelled "origin unknown".
- AC-9 Given any run, then the bridge key never appears in argv of any spawned
  process, in the report, in the baseline file, or in the history.
- AC-10 Given a baseline file, then it is JSON under `$KINERARY_CP_STATE_DIR`
  holding `{id, ok, code}` per check and nothing else, and the history row names
  its path in a new `baseline` field; old `history.tsv` files without the field
  still read.

## Contracts

- `control-plane/deployment/vm-release.py`: `verify()` returns a
  `VerifyResult(checks: List[Check], caused, preexisting, unknown)`; callers in
  `cmd_upgrade` (`:1557`), `cmd_rollback` (`:1680`), `cmd_restart_bridges`
  (`:1878`), and the standalone `verify` command in `main()` (`:2251`) and the
  gate (`:2072`) adapt. New `take_baseline()`, `classify(baseline,
  now)`, `bridge_health(port, key) -> str`, `profile_mcp_servers(profile)`,
  `extract_companion_tools(source)`, `EXEMPTABLE` (the class rule above).
- `HISTORY_FIELDS` (`:386`) gains `baseline`; `read_history` tolerates its
  absence.
- Gate (`parse_gate`, `:511`): `verify` stays argument-free for the agent.
- `docs/control-plane-vm-deployment.md` step 5 — doc-keeper.

## Non-goals

Repairing anything (spec `x-verify-retry-then-rollback.md`). Clearing a trip's
`TRIP_MCP_BRIDGE_FAILED` mark (that stays `--reconcile-companion`, #287).
Changing the bridge's `/health` route.

## Security and boundary notes

The MCP key is read from the trip's `mcp/.env` (root-readable, already read at
`:1360`) and sent only in a request header to loopback, from the tool's own
process — never on a command line, where `ps` shows it (the reason the install
script feeds curl on stdin). Codes are matched against
`[A-Za-z0-9_]{1,40}` before they enter the report, so a bridge's body cannot
forge a second line.

## Test plan

Written first, in `tests/scripts/test_vm_release.py`: `ProfileToolChecks`
(temp `HERMES_DATA` with `config.yaml` + `agent.log` fixtures, offsets): AC-1,
AC-2; `BridgeHealth` (a loopback `HTTPServer` answering each body shape, as the
rehearsal's readyz server does): AC-3, AC-4, AC-9 (assert recorded argv);
`BaselineClassification` (pure function on two check lists): AC-5 to AC-8;
`HistoryCompat`: AC-10. Rehearsal: `test_a_preexisting_bridge_failure_does_not_fail_the_upgrade`.
Local preflight runs them; CI does not.

## Rollout and regression

No trip feels this; it changes what the operator is told. It ships with
`420-…` (verify needs the restart offsets) and is run, like it, from the target's
own tool file on the first upgrade. Assessment: not needed beyond the T2
regression plan (no live-trip behaviour; the tool's verdict changes).

## Open questions

1. A pre-existing failure whose **code changed** — caused (as specified, the
   safe reading) or pre-existing?
2. `NO_HEALTH_ROUTE` — pass with a note (bridge predates #127), or fail? Today
   no VM bridge should lack it; recommendation: fail as caused only if it passed
   in the baseline.
