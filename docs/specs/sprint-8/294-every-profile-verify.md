# Verify every gateway's tools and every bridge's health, against a baseline

Status: draft, refreshed against 4510301 (2026-10-30) · Issue: #294, #289 · Track: T2 · Size: M (L if Open question 3 pulls #420's remainder in) · Tier: Normal
Security path: no (none of the three named invariants; reads each bridge's MCP key, see notes) · Migration: no · Live-trip behaviour: no

> **Sprint 8 (2026-10-30): in scope.**

## Problem

`ControlPlane.verify()` (`control-plane/deployment/vm-release.py:1554-1631`):

- **Checks tool registration for one profile only.** `trip-intake` against
  `interview-mcp.ts` (`:1597-1607`; agent log path hard-coded in
  `trip_intake_log()`, `:1425-1426`). A
  companion whose `trip-control` (companion-mcp) or `trip-mcp` connection went
  stale is reported green — strictly worse than the loud failure of 2026-10-18.
- **Reads the newest registration line, whatever its age.** A line written by a
  gateway before the upgrade satisfies the check (`registrations[-1]`,
  `:1599-1600`); it never asks whether the registration happened after this
  switch. (#420's partial fix, `199038a`, made the *switch* wait for a new
  trip-intake line — `restart_trip_intake_gateway`, `:1428-1445`, counting
  lines before `s6-svc -r` — but when none arrives it only notes "verify will
  say if tools are missing", and verify then accepts the old line.)
- **Checks that a bridge port listens, not that it works** (`:1626-1630`,
  `ss -ltnH`). A bridge with a stale key (#119) listens and passes while every
  trip tool returns 401 (#294).
- **Cannot tell an old failure from a new one** (#289). A trip whose bridge broke
  yesterday makes every upgrade and rollback "VERIFY FAILED"; `install_tool_files`
  and `prune_after_upgrade` are then skipped (`cmd_upgrade`, `:1935-1940`), so the tool cannot
  update itself, and an operator may roll back an upgrade that did nothing wrong.

**What moved on main since 03c0e1c (checked 2026-10-30).**

- `199038a` (#420, trip-intake half): the switch restarts the trip-intake
  gateway and waits up to 60 s for a new registration line (see above). The
  rest of spec `420-switch-restarts-every-gateway.md` — restarting every other
  gateway, `running_gateways()` — is **unscheduled**, not in Sprint 8 (its own
  tag line). `running_gateways()` does not exist on main. This spec previously
  assumed it shipped together with 420; see Open question 3.
- `199038a` (#288): `live_companions()` (`:1483-1518`) skips `retired-` slugs.
- #349/#461 (gateway reconciler, in #478): `live_companions()` also skips a
  **dormant** companion — one the reconciler stopped on purpose and the host
  confirmed stopped (`:1492-1511`). Its companion and bridge checks are not run.
- #478: `verify_web()` (`:1526-1552`) adds portal and runtime-gateway checks
  (image tag, `/v1/auth/capabilities` through the portal, gateway `/health`)
  when the web profile is on. These are switch-owned, so never exemptable.
- #470 (CI assessment) does not touch this tool.
- Nothing on main implements per-profile tool checks, bridge `/health` from
  verify, a baseline, or classification. Every AC below is still owed.

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

**Per-gateway tool checks.** For each expected profile — `trip-intake` plus
`live_companions()` (which already excludes retired and dormant companions) —
and, if #420's remainder has landed, each profile from its `running_gateways()`:

- MCP server names come from the profile's `config.yaml` `mcp_servers` keys.
- For a gateway **the switch restarted** (trip-intake always, since
  `199038a`; every gateway when Hermes itself was restarted), the registration
  line must be **newer than the restart**: the tool keeps the line count it
  read before `s6-svc -r` (`restart_trip_intake_gateway` already reads it,
  `count_interview_registrations`, but discards it after waiting) and verify
  reads only lines after it (the pattern `companion-install-host.sh` uses,
  `LOG_FROM`, `:1188`). No fresh line within the wait (default 60 s) is
  `tools:<p>:<server>` fail `NOT_REGISTERED`.
- For a gateway the switch did **not** restart while it recreated a server that
  gateway uses (`companion-mcp` → `trip-control`), its newest registration
  predates the switch, and per #420's Problem it does not re-establish the
  connection. Until #420's remainder lands this is reported as
  `tools:<p>:<server>` fail `STALE_REGISTRATION` — a real problem the switch
  caused. How it counts is Open question 3.
- Expected tool sets, where the server's source is a container the switch just
  replaced: `interview` → `extract_agent_tools(interview-mcp.ts)` (existing,
  `:418`);
  `trip-control` → a new `extract_companion_tools(companion-mcp.ts)`. Missing
  names fail `MISSING:<n>`. Any other server (`trip-mcp`, a monitor's servers)
  must register ≥1 tool.
- An expected profile that is not running: `gateway:<p>` fail `NOT_RUNNING`.

**Bridge checks** (`bridge:<slug>`): port check first (as today, cheap), then
`GET /health` on `127.0.0.1:<MCP_PORT>` with header `X-API-Key` read from the
trip's `mcp/.env`, in-process (`urllib`), 15 s timeout. Codes mirror
`bridge_health_code` in `scripts/companion-install-host.sh` (`:881-895`,
key read `:902`): `ok`, `HTTP_<n>`,
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
- AC-8 Given standalone `verify` (CLI `main()` or the agent gate) with no
  baseline and one failing check, then the exit code is 1, as today
  (`:2633`, `:2454`; the 2026-10-19 draft said 2, which is what `cmd_upgrade`
  and `cmd_rollback` return on a failed verify, not standalone), and the
  failure is labelled "origin unknown".
- AC-9 Given any run, then the bridge key never appears in argv of any spawned
  process, in the report, in the baseline file, or in the history.
- AC-10 Given a baseline file, then it is JSON under `$KINERARY_CP_STATE_DIR`
  holding `{id, ok, code}` per check and nothing else, and the history row names
  its path in a new `baseline` field; old `history.tsv` files without the field
  still read.
- AC-11 Given a companion that `live_companions()` treats as dormant (#349),
  when verify runs, then no `companion-connected:`, `bridge:` or `tools:` check
  exists for it — in the baseline or after — so a reconciler stop is never
  classified as caused.
- AC-12 Given the web profile on and the portal's proxy check failing in both
  the baseline and after the switch, then it is caused (switch-owned class),
  as for AC-7.

## Contracts

- `control-plane/deployment/vm-release.py`: `verify()` returns a
  `VerifyResult(checks: List[Check], caused, preexisting, unknown)`; callers in
  `cmd_upgrade` (`:1843`, verify at `:1935`), `cmd_rollback` (`:1950`, verify
  at `:2060`), `cmd_restart_bridges` (`:2240`, verify at `:2260`), the
  standalone `verify` command in `main()` (`:2632-2633`) and the gate
  (`cmd_gate`, `:2453-2454`) adapt. `verify_web()` (`:1526`) emits checks too.
  The baseline is taken in "2/5 Guards" (`cmd_upgrade` `:1874`, `cmd_rollback`
  `:2021`). New `take_baseline()`, `classify(baseline,
  now)`, `bridge_health(port, key) -> str`, `profile_mcp_servers(profile)`,
  `extract_companion_tools(source)`, `EXEMPTABLE` (the class rule above).
- `HISTORY_FIELDS` (`:498`) gains `baseline`; `read_history` (`:506`)
  tolerates its absence.
- Gate (`parse_gate`, `:623`): `verify` stays argument-free for the agent.
- `restart_trip_intake_gateway` (`:1428`) keeps its pre-restart line count on
  the instance for verify, instead of a separate offset mechanism.
- `docs/control-plane-vm-deployment.md` step 5 — doc-keeper.

## Non-goals

Repairing anything (spec `x-verify-retry-then-rollback.md`). Clearing a trip's
`TRIP_MCP_BRIDGE_FAILED` mark (that stays `--reconcile-companion`, #287).
Changing the bridge's `/health` route.

## Security and boundary notes

The MCP key is read from the trip's `mcp/.env` (root-readable; verify already
reads that file, for `MCP_PORT` only, at `:1626`) and sent only in a request header to loopback, from the tool's own
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
own tool file on the first upgrade. Since #420's remainder is unscheduled, it
no longer "ships with 420": see Open question 3. Assessment: not needed beyond the T2
regression plan (no live-trip behaviour; the tool's verdict changes).

## Open questions

1. A pre-existing failure whose **code changed** — caused (as specified, the
   safe reading) or pre-existing?
2. `NO_HEALTH_ROUTE` — pass with a note (bridge predates #127), or fail? Today
   no VM bridge should lack it; recommendation: fail as caused only if it passed
   in the baseline.
3. (New, 2026-10-30) #420's every-gateway restart is unscheduled. Without it,
   every switch that recreates `companion-mcp` but not Hermes leaves each
   companion's `trip-control` registration stale, and this spec's verify would
   correctly fail every such upgrade. Choose: (a) pull #420's remainder into
   Sprint 8 with this item (size → L); (b) report `STALE_REGISTRATION` as a
   caused failure anyway (honest, but every code-only upgrade goes red); or
   (c) report it as a named, non-failing "not re-registered — #420" note until
   #420 lands. Recommendation: (a), or (b) if the restart is to stay manual.
4. (New) The #349 reconciler can start or stop a gateway between the baseline
   and the post-switch verify. A gateway it starts appears only "after", so a
   failing check on it reads as caused. Accept that (it is new and failing), or
   take the expected set once, at baseline time, and check only that set?
