# A failed verify retries once, then rolls back on its own

Status: draft (2026-10-19) · Issue: none yet (x-) · Track: T2 · Size: M · Tier: High
Security path: no (none of the three named invariants) · Migration: no · Live-trip behaviour: yes (an automatic rollback restarts the stack)

## Problem

On a failed verify, `cmd_upgrade` (`control-plane/deployment/vm-release.py:1557-1569`)
writes `verify-failed`, prints "To go back: kinerary-cp-release rollback", sends
the same sentence through `notify()` (`:1371-1389`) and returns 2. Nothing
retries the known fix and nothing rolls back. On 2026-10-18 the failure was
noticed within the hour only because an agent happened to be watching for the
Telegram message (`docs/future/control-plane-ota-upgrades.md`, "Where things
stand today"). An upgrade requested through the gate, or run unattended, cannot
rely on that.

The repair that worked is already in the tool, scattered: `s6-svc -r` for a stale
gateway (#420), `setup-mcp.sh --restart-only` plus a gateway restart for a bridge
(`cmd_restart_bridges`, `:1859-1880`). The way back also exists: `cmd_rollback`
(`:1571-1685`), with its undo stack and its refusal of `--restore-db` when trips
were built since.

## Behaviour

After the switch, an upgrade whose verify has **caused** failures (spec
`294-every-profile-verify.md`; pre-existing ones never trigger any of this):

1. **One targeted retry.** For each caused failure, the matching repair, once:
   `tools:<p>:*`, `gateway:<p>`, `companion-connected:<p>` → `s6-svc -r` that
   gateway's slot; `bridge:<slug>` → `setup-mcp.sh --restart-only` for that trip,
   then its gateway. Failures with no targeted repair (readyz, migrations, image
   tags, relay identity/409) get none. One wait (60 s), then **re-verify**
   against the same baseline.
2. **Clean after the retry** → result `remediated`, `install_tool_files` and prune
   run, the notification says which repair fixed what.
3. **Still failing** → **automatic rollback** through `cmd_rollback` with
   `to=from_rev`, actor `auto`, **only when the upgrade's migration verdict was
   `compatible`** (code-only rollback, database kept). It runs rollback's own
   guards and its own verify (which also retries once, but never rolls back
   again). Results: rollback row `ok` or `verify-failed`; upgrade row
   `auto-rolled-back`.
4. **Verdict `breaking`** → no automatic rollback: `--restore-db` discards data
   and refuses after a build, and that call stays a person's. Result
   `rollback-needs-person`; the notification gives the exact command.
5. **Every outcome is reported** through `notify()` (the trip bot to the
   operator chat the tool already uses) in one message: what failed, what was
   retried, the re-verify result, whether it rolled back and to what, and the way
   back from where it now stands. If `notify()` returns false, the report says
   so on the terminal and in the history row.

A person can opt out with `upgrade … --no-auto-rollback` (reserved for the
terminal; the gate refuses it, so an agent cannot turn the safety off). The site
file (`control-plane.env`, `SITE_FILE`) may set
`CP_AUTO_ROLLBACK=observe`: everything runs except the rollback, which is
reported as "would roll back now". Unset means `on`.

`restart-bridges` is rebuilt on the same repair functions, so the operator's
manual repair and the automatic one are one code path.

## Acceptance criteria

- AC-1 Given a verify whose only caused failure is `tools:trip-intake:interview`
  and a retry after which it passes, when the upgrade finishes, then exactly one
  `s6-svc -r` for `gateway-trip-intake` was issued, the result is `remediated`,
  no rollback ran, `install_tool_files` ran, and one notification names the repair.
- AC-2 Given a caused `bridge:japan` failure, when the retry runs, then it issues
  `setup-mcp.sh --restart-only --trip-dir <deploy root>/trips/japan` and then
  restarts that trip's gateway, and nothing for any other trip.
- AC-3 Given a caused failure that survives the retry and a `compatible` verdict,
  when the upgrade finishes, then `cmd_rollback(to=from_rev)` runs with actor
  `auto`, the history has an upgrade row `auto-rolled-back` and a rollback row,
  and the exit code is 2.
- AC-4 Given the same with a `breaking` verdict, then no rollback runs, the
  result is `rollback-needs-person`, and the notification contains
  `kinerary-cp-release rollback --restore-db`.
- AC-5 Given an automatic rollback whose own verify fails after its retry, then
  no further rollback or upgrade is attempted and the notification says "rolled
  back, but verify still fails" with the failing checks.
- AC-6 Given only pre-existing failures, then no retry and no rollback run.
- AC-7 Given a failure with no targeted repair (e.g. `readyz`), then no retry is
  issued for it; re-verify still runs once, then step 3 or 4 applies.
- AC-8 Given `CP_AUTO_ROLLBACK=observe`, then the retry runs, no rollback runs,
  the result is `verify-failed`, and the message says "would roll back to <rev>".
- AC-9 Given `--no-auto-rollback` from the terminal, then the behaviour equals
  AC-8; given `gate request upgrade main --no-auto-rollback`, then the gate
  refuses it.
- AC-10 Given a rollback guard refuses (a provisioning job in flight), then the
  rollback is not forced, the result is `rollback-refused`, and the notification
  names the guard and the command to run when it clears.
- AC-11 Given `notify()` fails, then the terminal and the history row record
  "operator not notified".

## Contracts

- `control-plane/deployment/vm-release.py`: `remediate(result) -> List[Repair]`,
  `REPAIRS` (check class → repair function), `auto_rollback(cp, record)`;
  `cmd_upgrade` step 5 rewritten; `cmd_rollback` gains `auto: bool`
  (retry yes, recursive rollback no); `cmd_restart_bridges` calls the repair
  functions. New results in `SWITCHED_RESULTS`/`RECOVERABLE_RESULTS`
  (`:421-422`): `remediated`, `auto-rolled-back`, `rollback-needs-person`,
  `rollback-refused`, so `recovery_point()` still finds the way back.
- `parse_gate_action` (`:540`): `--no-auto-rollback` joins the reserved set.
- Site file key `CP_AUTO_ROLLBACK` (`on` | `observe`), read by
  `site_from_texts` (`:249`); documented in the runbook, no default value names
  a deployment.
- `docs/control-plane-vm-deployment.md` "Upgrades and rollback" and the gate
  help text (`GATE_HELP`, `:2005`) — doc-keeper.

## Non-goals

Pulling images from GHCR; the offer/gate initiation flow; automatic
`--restore-db`; automatic snapshot restore (`vm-restore-snapshot.sh` stays a
person's, from outside the VM); more than one retry.

## Security and boundary notes

No new privilege: every action is one the tool already performs as root. The
agent path gains no new verb and loses the ability to disable auto-rollback.
Repair commands take profile names and slugs only from discovery and the
database, validated with the existing patterns, as argv.

## Test plan

Written first: `tests/scripts/test_vm_release.py` — `AutoRemediation`, with a
`ControlPlane` subclass whose `verify()` returns scripted `VerifyResult`s in
sequence and whose `sh.act` records argv (the `RollbackPreparation` stub
pattern, `:782-830`): AC-1, AC-2, AC-6, AC-7, AC-11; `AutoRollback` with
`cmd_rollback` patched to record its arguments: AC-3, AC-4, AC-5, AC-8, AC-10;
`GateParsing.test_auto_rollback_cannot_be_disabled_by_an_agent`: AC-9.
`tests/scripts/test_vm_release_rehearsal.py`: a `FAKE_DOCKER` mode in which a
gateway's first restart registers a short tool list and the second the full one
(`test_a_stale_gateway_is_remediated_without_rollback`), and one in which it
never does (`test_an_unfixable_verify_rolls_back_automatically`, asserting
`KINERARY_REV` is back at the old revision and the real database untouched).

## Rollout and regression

A self-acting tool must not first act on production untried. Order: (1)
rehearsal tests green in the local preflight; (2) Mac rehearsal run with a
forced stale gateway; (3) first production upgrade carrying it runs the target's
own tool file from a throwaway worktree, with `CP_AUTO_ROLLBACK=observe` in the
site file — the decision is reported, not acted on; (4) after one observed
upgrade whose decision was right, remove `observe`. Throughout, the installed
tool and its rollback are untouched until a green verify installs the new one.
An automatic rollback is a stack restart that trips feel as an upgrade (bot
pause; companions restart per spec `420-…`). Regression plan: needed (High tier,
acts on production without a person).

## Open questions

1. **The OTA document's interim question** ("is there a cheaper interim step —
   automate verify-failure → rollback, keep local builds — before pull-from-GitHub?").
   **Recommendation: yes, and this spec is it, applied to every release**, not
   only ones that touch a gateway's tool surface: whether a release touches that
   surface cannot be decided reliably from a diff (2026-10-18's cause was a
   process that had missed a month of changes), and a verify costs seconds. GHCR
   pulls change how Prepare gets images, not what Verify does with its verdict,
   so nothing here is thrown away when they come.
2. Auto-rollback when an interview guard refuses: wait (how long?) or force,
   since the upgrade already restarted the relay? Recommendation: wait up to
   5 minutes, then `--force-live` for interviews only; never past a job.
3. Should a `breaking`-verdict upgrade be refused unless `--no-auto-rollback`
   is given, so that every unattended upgrade is one that can roll itself back?
