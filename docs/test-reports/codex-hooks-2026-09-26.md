# Codex hook repair — 2026-09-26

Branch: `fix/codex-hooks`, based on `origin/integration/sprint-6` at
`7d0a14c2ece8b6fe459773eec9446edba09abdc4`. At the verification handoff,
changes were uncommitted; this report records that pre-commit verification.
The product, integration checkout, production and user/global configuration
were not changed. Fixture commits were made only in a disposable repository
with no remotes, to prove the permitted case.

## 1. Root cause and evidence

Tested installed `codex-cli 0.153.2`, using real `codex exec` sessions and the
installed app-server's generated schema and `hooks/list` response.

There were several separate failures:

1. **Wrong configuration source during worktree experiments.** For the linked
   repair worktree, `hooks/list` reported the primary checkout's
   `.codex/hooks.json` as `sourcePath`, containing the original commands.
   Editing the linked worktree's hook file therefore did not change the loaded
   command. This explains why substituting an absolute capture script in that
   file could still fail without creating a capture. A separately supplied
   invocation-local absolute capture command ran successfully.
2. **Missing Claude environment variable.** Actual captured hook environments
   had `CLAUDE_PROJECT_DIR` unset. The original commands therefore pointed at
   scripts outside the repository. Baseline sessions reported both
   `SessionStart Failed` and `PreToolUse Failed`, then executed `printf`.
3. **Incompatible decision output.** Harmless probes returning the shared
   hook's raw `ask`, or plain `allow` with a reason and no input rewrite,
   reported `PreToolUse Failed` and executed the command. Explicit `deny`
   blocked. Empty JSON continued normally. This adapter translates both
   incompatible shapes rather than treating a successful command as proof
   that its hook succeeded.
4. **Different write payload.** Codex supplies `apply_patch` text in
   `tool_input.command`; the shared write hook expects one `file_path`.
   Forwarding it unchanged would miss protected paths.
5. **Missing protected namespace.** `.codex/` was absent from the shared
   policy-path classifier. A regression staging only `.codex/hooks.json`
   initially returned `allow`; it now returns `ask` before Codex translation.

Actual payload captures confirmed `Bash`, a string `tool_input.command`,
`session_id`, and a child tool call carrying `agent_id` plus
`agent_type: "default"`. Parent calls had no child identity. The real child
commit proof below confirms this identity reaches the shared policy.

The documented event/matcher contract is compatible with the existing
`SessionStart`, `PreToolUse`, `Bash` and `Write|Edit` registrations. Codex maps
the latter aliases to `apply_patch`. The official documentation also says
`ask` is unsupported, describes hook trust, and distinguishes tool hooks from
native permission requests. [OpenAI Docs: Hooks](https://learn.chatgpt.com/docs/hooks)

Evidence supplied alongside this report: `appserver-hooks.jsonl`,
`capture-sanitized.json`, `trusted.txt`, `inline-probe.txt`,
`subagent-persisted.txt`, and `failopen-runtime.txt`. Raw capture data is kept
locally outside git; the sanitized capture omits paths and unrelated payloads.

## 2. Changes and scope

- `.codex/hooks.json` resolves the active worktree through Git and calls
  `scripts/claude-hooks/codex-adapter.py`. No Claude-only environment variable
  is required. The outer timeout is 30 seconds for all three registrations.
- The adapter preserves the shared shell policies. It turns `ask` into an
  explicit denial requiring owner action, turns `allow` into `{}` (normal
  runtime processing), and preserves denials and SessionStart context.
- Every add/update/delete/move path in a patch is checked. Both the named path
  and its symlink destination are checked, and paths escaping this repository
  are refused. Child identity is preserved; a child ID without a role is denied.
- Malformed inputs/results, missing dependencies, wrong repository context,
  Python exceptions and detected child-process failures become denials. A
  single 20-second subprocess budget covers the whole event, including
  multiple file paths, to leave time to return before Codex's outer timeout.
- The one shared-policy change is adding `.codex/*` to protected paths. This
  intentionally tightens that omission for both clients, as approved during
  review. `match-command.py` and Claude's hook registration are unchanged.

There is no duplicated command classification and no replacement policy
engine. PermissionRequest is not used as a substitute: it does not force an
approval prompt for every command that the shared policy classifies as `ask`.

## 3. Tests

Python 3.9.6, from the isolated repair worktree:

```text
python3 -m unittest discover -s tests/scripts -v
Ran 408 tests in 418.700s
FAILED (errors=19, skipped=12)
```

The initial sandbox prevented localhost socket binds in `test_e2e_full_cycle`
and `test_vm_invite`, and prevented Git metadata writes in
`test_preflight_deployment_boundary` and `test_preflight_migrations`.
The 19 errors include subtest errors, not 19 distinct failing test methods.
Those four modules were rerun with the needed local permissions; the retry
result is recorded separately below:

```text
# test_e2e_full_cycle
Ran 10 tests in 0.044s
OK
# test_preflight_deployment_boundary + test_preflight_migrations + test_vm_invite
Ran 26 tests in 40.115s
OK
```

All original environment errors are resolved by those 36 rerun tests.
`scripts-environment-retry.txt` contains their actual output. The original
failing transcript remains in `scripts-suite.txt`.

The full discovery had loaded 15 adapter tests before the final review added
nine more. The final adapter suite was therefore rerun separately:

```text
python3 -m unittest discover -s tests/scripts -p test_codex_hook_adapter.py -v
Ran 24 tests in 9.419s
OK
```

Twelve existing database/release rehearsal tests skipped because Docker with
`postgres:16-alpine` was unavailable. They were not verified by this task.
See `adapter-suite-final.txt` for final adapter output.

`scripts/preflight-checks.sh --staged` exited 0: no blocks, with three existing
profile/checkout drift warnings (`preflight.txt`). `git diff --cached --check`
also exited 0 with no output. Only the six handoff files were staged; no commit
had been made in the repair worktree at the verification handoff.

Adapter coverage includes decision conversion, actual shared scripts, child
identity, every patch path operation, multiple paths, symlink aliases,
dependency failures, malformed output, and cumulative timeout handling.
The `.codex` regression additionally exercises the shared classifier directly.

Independent review confirmed the live outcomes and identified the inherited
classifier failure limitation recorded in section 5. No product suite is
needed: no product code, schema, authentication or serving route changed.

## 4. Real Codex proof

The six proof worktrees belong to a separate disposable fixture repository.
Its primary checkout contains the revised hooks, and each worktree contains
the final adapter and shared policy dependencies. This reproduces the loaded
configuration layer without editing the real primary checkout.

Invocations used `--approve-for-me` (workspace-write with normal automatic
approval review), `--add-dir` for the fixture's Git metadata, invocation-local
project trust and `--dangerously-bypass-hook-trust` for these vetted fixture
hooks. The last flag bypasses only hook trust for that invocation; no sandbox
or command-approval bypass was used, and no trust was written to user config.
The subagent proof omits `--ephemeral`: an earlier ephemeral child probe failed
to spawn with `no thread with id`, so it was not counted as a policy proof.

Push and Docker executables were inert recording stubs, there was no Git
remote, and Docker was also pointed at a nonexistent fixture socket. The
negative actions did not reach either stub.

| Required proof | Actual runtime evidence | Shared decision log |
|---|---|---|
| a. Docs-only feature commit | SessionStart Completed; PreToolUse Completed; `git commit -m 'x'` succeeded | `lead commit allow` |
| b. Policy-path commit | `Command blocked by PreToolUse hook: Owner approval required` | `lead commit ask` |
| c. `git push origin main` | `PreToolUse Blocked` | `lead push ask` |
| d. Docker compose up | `PreToolUse Blocked`; command never executed | `lead deploy ask` |
| e. SessionStart | `SessionStart Completed` in every final proof | SessionStart is not a decision-log event |
| Additional: protected patch | `PreToolUse Blocked`, naming the singular `trip/` hard rule | Write hook has no decision TSV |
| Additional: actual child commit | Runtime denial naming subagent `default` | `default commit deny` |

The TSV records the **shared policy** decision before translation; `ask` in
that log accompanies a runtime **denial**, not a native prompt or a failed hook.
Final transcripts have no `PreToolUse Failed` entries. The final docs commit
was `3bb0bd4`; all five negative fixture worktrees retained their baseline
HEAD, and the protected patch file was absent. `proof-state.json` records the
post-run checks. Exact final decision lines:

```text
2026-09-26T18:37:26Z	01a0df01-e20c-7fa0-97d5-73922794b118	lead	commit	allow
2026-09-26T18:37:28Z	01a0df01-e29c-7300-b0e3-a86c00044a76	lead	commit	ask
2026-09-26T18:37:31Z	01a0df01-e982-7f73-9b9b-20b4911631dc	lead	push	ask
2026-09-26T18:37:26Z	01a0df01-e208-7720-a63a-2dc01cc3656d	lead	deploy	ask
2026-09-26T18:37:44Z	01a0df01-e270-7f70-9c12-f311f9531cd5	default	commit	deny
```

Transcripts: `proof-docs.txt`, `proof-policy.txt`, `proof-push.txt`,
`proof-deploy.txt`, `proof-patch.txt`, `proof-child.txt`.
Corresponding logs: `docs-decisions.tsv`, `policy-decisions.tsv`,
`push-decisions.tsv`, `deploy-decisions.tsv`, `child-decisions.tsv`.
`run-proof.py` preserves the invocation arguments outside the repository.
All six proof worktrees and their branches, the standalone fixture repository,
and the empty capture-probe repository were removed after verification.
`cleanup.txt` records cleanup; evidence files and the repair worktree remain.

## 5. Fail-open finding and recommendation

`failopen-runtime.txt` records four separate harmless shell commands. For each,
Codex reported `PreToolUse Failed` and then printed the requested marker:

```text
hook exit 1          -> error_probe_ok
hook timeout        -> timeout_probe_ok
raw ask decision    -> ask_probe_ok
plain allow+reason  -> allow_probe_ok
```

No supported general switch to make hook startup errors or outer timeouts
block every tool was established from the installed CLI/help, schema probes,
and the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
A supported denial (or documented blocking exit
code) can block when the hook actually runs. Managed hook configuration can
control which hooks load; it does not establish a crash/timeout blocking
guarantee. No global setting was changed or is required for this repair.

Remaining limits are material:

- A missing interpreter, hook launch failure, runtime timeout, untrusted or
  disabled hook can occur before the adapter can return a denial.
- The shared Bash hook itself treats a classifier execution error as empty
  success. The adapter checks that the classifier exists, but cannot infer a
  swallowed failure from that output. This inherited behavior was left
  unchanged rather than silently broadening the approved policy change.
- Hooks cover their registered tool paths, not arbitrary side effects of all
  possible tools. An instruction to follow policy remains necessary.

Recommendation for the owner's later decision: keep native sandbox and
approval restrictions, treat hook health failures as a reason to stop sensitive
work, and use server-side branch controls and existing external deploy gates
for irreversible actions. Consider a separate shared-policy change making
classifier errors explicit, and an upstream runtime request for fail-closed
hook failures. This repair does not claim hooks alone enforce the whole trust
boundary.

## 6. Proposed commit message

```text
fix: adapt shared approval hooks to Codex runtime
```

## 7. Not verified or not activated

CLI 0.153.2 behavior is proven. The desktop app's current in-process hook
configuration and other Codex versions were not independently exercised.
The actual primary checkout still has the old hook configuration, as required
by the isolation brief. This branch therefore does not repair an already
running session merely by existing. After the owner accepts and installs the
change in the authoritative project layer, a fresh session must confirm the
loaded source and review/trust the changed hooks through the normal UI.

Native `ask` prompt parity with Claude is unavailable in the tested runtime;
Codex blocks those actions and the owner must perform or authorize a supported
workflow outside that denied call. No real push or deployment was attempted.
