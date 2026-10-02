# Regression plan: PR #192, an allow-listed child env for every model subprocess (#153, #58)

**Date:** 2026-09-25 · **Mode:** branch / pre-merge (local) · **Planner:** `regression-planner`
**Assessed tree:** worktree `agent-a4225f8ad31192b0d`, branch `integ/192-merged` = PR #192 head
`dbe2c4a` (`gh pr view 192`: OPEN, base `integration/sprint-6`, +768/−258).

**Verdict:** safe to merge into `integration/sprint-6` once one gate passes: the DB half of the
control-plane suite on the merge with the **current** tip, which has moved (see §1). Nothing in
production changes today. This is relay/API code, and `integration/sprint-6` has not reached
main or the VM. The PR adds no migration, changes no release payload, and needs no trip
redeployed. There is one false claim, and it should be fixed or reworded before merge: a
DB-loaded codex override is **not** "verified once". It is probed again on every 30 s refresh
for as long as the probe passes.

---

## 1. Change set

| Item | Files |
|---|---|
| PR #192 `fix/153-58-allowlisted-child-env` @ `dbe2c4a`, one commit | src: `model-runner.ts` (+137/−63), `model-task-settings.ts` (+46/−1), `itinerary-extract.ts` (+3/−3), `hermes-search.ts` (+2/−1). test: `claude-effort-inheritance` (new), `hermes-isolation` (new), `hermes-spawn-isolation` (new), `support/child-env-harness.ts` (new), `claude-isolation`, `codex-isolation`, `model-runner-env`, `model-switch` |
| Issues | #153 (OPEN, "Claude/Hermes structuring calls inherit the full relay env"), #58 |

**Correction to the brief. It was verified, not assumed.** The brief gives
`origin/integration/sprint-6` = `4f283d0`. Today it is **`96a2897`** (`git rev-parse`), four
commits later: #181 assistant events (with migration `20260925143012_assistant_events.sql`),
#119 bridge-failure fact, and docs. `git merge-tree --write-tree 96a2897 dbe2c4a` is clean
(tree `e3fc03b`). The only files both sides touch are `relay/server.ts`, `dispatch.ts` and
`poller.ts`, and #181's edits there are analytics wiring (`assistantEventsFromEnv`). They are
not on the model path, so I found no semantic overlap. The verifier's 1634/0/0/6 is a
result on `dbe2c4a` and **not** on what will land. See Run R1.

## 2. Risk table

| Change | Surface (§2) | Blast radius | Migration | Compat break | Risk | Test | Min | Batch |
|---|---|---|---|---|---|---|---|---|
| Hermes runner (`hermesSpec`) moves to an allow-list (`hermesChildEnv`) | `control-plane/api/src/`: the relay (VM redeploy / Mac relay restart) | Only a stack with `*_RUNNER=hermes` or a `/model hermes:` override. **None found** (§4) | no | A provider key that only the relay's env held stops reaching Hermes, which then silently falls through its provider chain | Low today, latent | `hermes-isolation.test.ts` (black box) | <1 | isolated (unit) |
| The three older direct Hermes spawns get `env: hermesChildEnv()` | API (`venue-links`, `destination-info`) and the sidecar (`consular-lookup`, `extractItinerary` fallback) | Only when `HERMES_*_PROFILE` is set. **None found** (§4) | no | Same as above, plus proxies | Low today, latent | `hermes-spawn-isolation.test.ts` | <1 | isolated |
| `specEnv()`: an env fn returning nothing gives an empty env. The default (no `env`) is the base allow-list, not a deny-list | every CLI spawn | All CLI runners. Claude's and Codex's sets are **byte-identical** to before (pinned by exact-set tests) | no | none: `hermeticEnv` export removed, no remaining importer (`git grep`, docs/agent prose only) | Low | `model-runner-env.test.ts` | <1 | isolated |
| Codex startup probe runs under `codexChildEnv()` instead of `hermeticEnv()` | relay boot | Stacks with a codex binding | no | none | Low | `codex-isolation.test.ts` "probe itself does not inherit" | <1 | isolated |
| `extract_intake` / `extract_itinerary` / `read_image` inherit `*_EFFORT` like runner+model | relay (and sidecar for `extract_itinerary`) | **Mac:** the two doc tasks move from personal `~/.claude` settings (xhigh, hooks, MCP) to `--effort medium --setting-sources "" --strict-mcp-config`. **VM:** no change expected (no `*_EFFORT` is forwarded, §3) | no | Behaviour: faster, and quality at medium for these tasks is unmeasured | **Medium on Mac staging, nil on VM** | `claude-effort-inheritance.test.ts` (argv) | <1 + optional R2 | R2 rides on one doc upload |
| Loud `model_runner.claude_effort_unset` warning | relay/sidecar boot | Logs only | no | none | Nil (it is the fix for a silent failure) | same file | — | — |
| `/model <task> codex:*` probes codex before saving; DB-loaded overrides probed in refresh | relay, super-admin DM only | The whole poll loop, for the probe's duration (§5) | no | none | Low, but a design cost | `model-switch.test.ts` (injected probe) | <1 | isolated |

## 3. Migration and compatibility findings

- **No migration.** The diff touches no file under `control-plane/db/migrations/`. The new tip's
  `assistant_events` migration belongs to #181, not this PR.
- **No release-seal change.** No file under `site/ server/ shared/`, so `artifactDigest` is
  untouched and no new release is needed.
- **No contract shape change.** `phases[].planned` / `.venues` are not touched.
- **Removed export `hermeticEnv`:** no importer left in code (`git grep` at `dbe2c4a`; mentions
  remain only in `.claude/agents/integrator.md` and the `.codex` mirror, as history). tsc is
  clean per the verifier. I did not re-run tsc.
- **Claude/Codex env sets are unchanged.** I compared the before/after lists line by line in
  the diff. Base (PATH, HOME, XDG_CONFIG_HOME, TMPDIR/TMP/TEMP, LANG/LC_ALL/LC_CTYPE,
  SSL_CERT_FILE/DIR, NODE_EXTRA_CA_CERTS) plus CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR,
  ANTHROPIC_API_KEY/BASE_URL/AUTH_TOKEN, XDG_CACHE_HOME for claude, or CODEX_HOME for codex.
  These are exactly the old lists, and both are pinned by `claude-isolation.test.ts:93` /
  `codex-isolation.test.ts:99`. **So the environment only changes for Hermes and for the codex
  probe.**
- **Oldest-release compatibility:** this does not apply. No trip site reads anything this
  PR changes.

## 4. Live-fleet impact

**Production (VM 110): not checked, by instruction.** No SSH and no fleet MCP, which
reaches production over SSH. Here is what the tree says, with provenance:
- `model-task-settings.ts` and migration `20260918110131_model_task_settings.sql` are **not on
  `origin/main`** (`git ls-tree origin/main`: empty, today). Memory says the VM runs
  main-based releases (last upgrade 2026-09-18). I did not re-check that. If it holds, **the VM
  has no `/model` and none of this PR's code**, and #192 reaches it only when sprint-6 merges
  to main and someone runs `kinerary-cp-release upgrade`.
- When it does reach the VM, `compose.vm.yml` (read today) forwards to the relay only
  `INTERPRET_RUNNER/MODEL`, `EXTRACT_RUNNER/MODEL`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, plus
  `env_file` `/opt/agent-auth/claude.env` and `openrouter.env`. **It forwards no `*_EFFORT`**,
  no `EXTRACT_INTAKE_*`/`EXTRACT_ITINERARY_*`, no `VISION_*`, no `HERMES_*`, and no proxy.
  **Unknown:** the contents of `vm.env` and the two `env_file`s (unreadable from here). If one
  of them carries `*_EFFORT`, the VM's doc tasks change behaviour the way the Mac's do.
- **No trip needs redeploying.** No trip-runtime file changed.

**Mac staging, read today from the running processes (variable names only, never values):**
- Relay: pid 71552 on :4312, started **2026-09-20 20:38** from
  `worktrees/sprint-6-integration/control-plane/api` (`ps`, `lsof`). Model-related names
  in its environment: `INTERPRET_RUNNER/MODEL/EFFORT`, `EXTRACT_RUNNER/MODEL/EFFORT`,
  `ITINERARY_EXTRACT_TIMEOUT_MS`, `INTERPRET_PATH_DEFAULT`. **Absent:** every
  `EXTRACT_INTAKE_*`/`EXTRACT_ITINERARY_*`, `VISION_*`, `PLAN_REVIEW_*`, `HERMES_*`, `*_PROXY`,
  `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_*`, `OPENROUTER_*`.
  `provisioning.env` shows the same model names (`grep -o '^[A-Z_]*='`). **Runner values
  come from the brief (claude, effort medium) and I did not read them.**
- That relay **predates document intake**: Slice B's forward-port `ddf943c` is dated 2026-09-21.
  It therefore does not run `extract_intake` at all, and nothing changes on the Mac until a
  relay restarts from a tree that contains #192.
- Sidecar: pid 66287 on :4311, started 2026-09-20 20:30. It has **no** `*_RUNNER`/`HERMES_*`
  names, so `extractItinerary` there has neither a runner nor a Hermes fallback. No change.
- API container `kinerary-control-plane-local-api-1`: no `*_RUNNER`/`HERMES_*`/proxy names. No change.
- Mac DB is at `0054_companion_bug_reports.sql` (read-only query). **7 migrations in this tree
  are unapplied**, including `document_registry` and `model_task_settings`. The relation
  `control_plane.model_task_settings` does not exist (query error today). So `/model` cannot
  save on the Mac, and **a relay restarted from sprint-6 against this DB will not read documents
  until the Mac API is brought up from the same tree.** This predates #192, but it blocks R2.

## 5. The five questions, answered

### Q1. What changes for a running relay on restart
- The warnings come from `runnerForBinding` when a **claude** binding has no effort from
  `<PREFIX>_EFFORT` or the inherited `<INHERITS>_EFFORT`. Each task warns once per process
  (module-level `Set`), through `console.warn`, which is the same stderr stream as the relay's
  own `log` (`relay/server.ts:50`). **When:** during `modelRunnerFromEnv()` at relay boot
  (`server.ts:276`), before `relay.ready`. After that, only when a `/model` override builds a
  claude runner for a task that has not warned yet. In the sidecar, on the first
  `extract_itinerary` tool call, because `extractItinerary`'s default parameter calls
  `modelRunnerFromEnv()` on each call. In the API (`server.ts:281`), only if it has a
  `PLAN_REVIEW_RUNNER`/other `*_RUNNER`.
- **Measured by simulation today** (`modelRunnerFromEnv` against the HEAD source):
  - Mac shape (INTERPRET and EXTRACT on claude, both efforts set): **0 warnings**.
  - VM compose shape (both runners claude, no efforts): **4 warnings**, one each for
    `interpret`, `extract`, `extract_intake` and `extract_itinerary`. A second build adds none.
    If the VM's `EXTRACT_RUNNER` is codex, only `interpret` warns.
- Other effects of a restart:
  - **Mac:** `extract_intake`/`extract_itinerary` get the effort flags.
  - **Hermes:** no process uses it (Q3).
  - **Codex startup probe:** runs only if some `*_RUNNER=codex`, and the Mac names none.
  - **Override refresh:** on the Mac it already fails (`relay.model_overrides_refresh_failed`
    every 30 s, because the table is missing). That is pre-existing and not caused by #192,
    but expect it in the log.
- The `consequence` text ("personal settings, hooks and MCP connectors") is a Mac description.
  On the VM the call takes its settings from `CLAUDE_CONFIG_DIR`. This is cosmetic.

### Q2. The Mac's document reading
- **Latency and behaviour: yes, they change.** Before, `EXTRACT_INTAKE_EFFORT` was the only
  name read, and it is unset, so `claude -p` ran with no `--effort` and loaded
  `~/.claude/settings.json` (the personal effortLevel xhigh, per CLAUDE.md), user hooks and MCP
  connectors. After, it inherits `EXTRACT_EFFORT` and runs `--effort medium --setting-sources ""
  --strict-mcp-config`. This is proven by argv in `claude-effort-inheritance.test.ts`, and I
  watched it fail on the base source. The task timeout is 90 s (`EXTRACT_INTAKE_TIMEOUT_MS` and
  `EXTRACT_TIMEOUT_MS` are both absent). The 2026-09-13 benchmark had claude-sonnet-5 at
  p50 67–76 s and **p95 126 s** (`docs/document-intake-operations.md`, effort not recorded).
  So under xhigh, a slow document could exceed 90 s, and medium makes that less likely.
  - **Quality at medium for `extract_intake` has not been measured** (that benchmark chose codex).
  - The Mac's **running** relay has no "before" to compare against, because it predates
    document intake.
- **Could a call that used to work now fail?** I found no plausible mechanism.
  - The same process already sends exactly these flags, with the same `claudeChildEnv`, for
    `interpret` and `extract`. `/tmp/relay.log` has 271 `interview.interpret_ok` events. The log
    line does not name the provider, so "that was claude" is the brief's claim, carried.
  - Auth therefore does not depend on the settings files that `--setting-sources ""` drops.
  - The one residual risk: a document that relied on xhigh's extra reasoning to come out right.
    That would show up as a worse answer, not an error.
- `extract_itinerary` on the Mac runs only in the sidecar, which has no runner, so this has no
  effect there.

### Q3. Hermes exposure
- **Mac: none found.**
  - The brief says no `*_RUNNER` names hermes (values not read).
  - The relay, sidecar and API environments have no `HERMES_*_PROFILE` (names read today).
  - Overrides cannot exist, because the table is missing.
  - `~/.local/bin/hermes` is a 4-line launcher that unsets PYTHONPATH/PYTHONHOME and execs an
    absolute venv path, so it needs nothing that the allow-list drops.
- **VM: none found in the tree, with gaps I could not check.**
  - `compose.vm.yml` sets no `HERMES_*` for api, relay or interview-mcp, and its own comment
    says "which it is not (here or on the Mac)".
  - `agent-runtime.Dockerfile` installs only `claude-code@2.1.236` and `codex@0.153.2`, and the
    api image adds nothing. Hermes lives in its own `hermes` container. So a Hermes spawn from
    those containers would ENOENT **whatever its env**.
  - **Unknown:** the contents of `vm.env` and the `env_file`s, and whether the running image
    matches this Dockerfile.
- **The latent failure is real and unannounced.** It hits the first deployment that configures
  a Hermes runner or search profile whose provider key sits in the relay's env rather than
  `~/.hermes/.env`. It would degrade silently to a metered fallback, which is this repo's
  bug class.
- Proxies: `*_PROXY` is newly dropped **for Hermes only**. Claude and codex never forwarded it.
  None of the Mac processes carry one.

### Q4. The `/model codex` probe
- **It runs a subprocess on the request path, and that path is serial.** `handleModelCommand` awaits
  `codexIsolationProblem(bin, 20_000)`, which is `execFile codex features list`. The call chain
  is dispatch.ts:517, then poller.ts:4106, where `await dispatchUpdate(...)` runs inside a
  per-update loop. So while it runs, **every chat's updates wait**: every live interview and
  every group on the one bot. On the Mac I measured `codex features list` at **0.26 s**.
- **The bound is 20 s, through execFile's `timeout` (SIGTERM).** The callback fires on `close`,
  so a child that ignores SIGTERM, or a grandchild that holds the pipe, would stall the loop
  past 20 s.
  - On the Mac, codex is a native Mach-O binary (`file`), so this does not apply.
  - On the VM image, codex comes from npm as a Node wrapper around the native binary. I did not
    verify that the wrapper forwards signals.
  - No test covers a slow or hung probe.
- **"Verified once" is not what the code does.** `verifyCodexOverrides` latches only on
  **failure**. On a pass it returns and records nothing, and `startTaskOverrideRefresh` calls it
  on every refresh. So while any override names codex, `codex features list` is spawned
  **every 30 s for the life of the relay**. This runs on a timer, off the request path, and
  delays `apply` by the probe's duration. No test pins either behaviour.
- The failure latch is permanent until restart, which is the safe direction. It does not
  retract a codex override runner that `switchableRunner` has already built and cached.
  This is an edge case.

### Q5. Is the suite sufficient
**Fail-before / pass-after:** I verified this myself today. I ran the new tests against
`4f283d0`'s `src` in a scratch copy, removing only the imports of symbols that did not exist yet.

| Test | On base | On head |
|---|---|---|
| `hermes-isolation` | fails: `OPENROUTER_API_KEY must not reach` | pass |
| `hermes-spawn-isolation` | 3/3 fail on the same assertion | pass |
| `codex-isolation` "probe itself does not inherit relay secrets" | fails | pass |
| `claude-effort-inheritance` | `extract_intake` and `extract_itinerary` argv tests plus the warning test fail; `extract` passes (as it should) | pass |
| `model-switch` "/model codex is verified" | refusal tests 1–2 fail | pass |
| `claude-isolation` | passes on base (refactor onto the harness; the claude set did not change) | pass |

The 7 changed files together: **38/38 pass, 5.8 s wall** (measured today on `dbe2c4a`).

**Exact-set pins:**
- Claude and codex are pinned exactly (a no-regression proof for the shared builder).
- Hermes is bounded by a black-box check: every variable in the test process must be in
  the test's own sanctioned set, and `HERMES_HOME` must reach the child. That is an upper
  bound, not an equality.
- `specEnv({})` is compared against `structuringChildEnv()` itself, which only shows the
  code agrees with itself.

**My verdict:**
- **It is sufficient as proof that the environment policy is what the PR says it is.** Every
  new behaviour has a black-box canary that I watched go from red to green, and the unchanged
  halves are pinned.
- **It is not sufficient for three other claims:**
  - (a) That the Mac's document reading is as good at medium. Only a real document can show that.
  - (b) That a Hermes stack still reaches its provider. No such stack exists, so this is not a
    gate today.
  - (c) The PR's own "verified once" claim, which the code contradicts.
- It is also not evidence about the VM at all.
- **Separately:** the verifier's green result is on a base that is no longer the tip.

## 6. The plan

**R1: gate. Full control-plane/api suite on the merge with the current tip.** Owner: `verifier`. No human.
- Build the merge of `dbe2c4a` into `96a2897` (tree `e3fc03b`), then run
  `CONTROL_PLANE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/<private>_test npm test --prefix control-plane/api`
  on a **private** database name, **not `cptest`**, which other sessions share. Also run
  `npx tsc --noEmit`.
- **Already done, the non-DB half:** I ran it in a scratch extract of `e3fc03b`, with
  `CONTROL_PLANE_TEST_DATABASE_URL` unset. Result: **1476 tests, 1045 pass, 5 fail, 426
  skipped, 41.5 s wall.**
- **The 5 failures are pre-existing and unrelated.** They are all in `organizer-trips.test.ts`
  `describe("a returning organizer's second trip")`, which has no `{ skip: SKIP }` (added
  `fc13b7d`, 2026-09-18). With no URL it connects to libpq's defaults and gets ECONNREFUSED.
  The same 5 failures reproduce on `dbe2c4a` alone. See §9 for why that block is a hazard.
- **DB half:** minutes. I have not measured it. The verifier's own number on `dbe2c4a` is 1634 tests.
- **Expected noise:** none from #192. #181's new migration already updated `migrations.test.ts`
  on the tip.

**R2: optional Mac staging acceptance, one document.** About 20–30 min plus Dror, once the Mac
stack has been brought up from a sprint-6 tree. That bring-up is a precondition, not part of
this run: the API applies the 7 missing migrations. Needs a window with no live Mac interview.
It is not the VM, and the bot is `@Tripinterviewer_bot`.
1. Restart the relay with `scripts/relay-restart.sh` from that checkout. **Check (Q1):** the
   relay log has **0** `model_runner.claude_effort_unset` lines.
2. Upload one real PDF in a test interview. **Check (Q2):** while the call runs,
   `ps -o command= -p <claude child>` shows `--effort medium --setting-sources  --strict-mcp-config`.
   The log shows the extraction's duration, well under 90 s. The proposals are sane. Record the
   duration: it is the first real Mac number at medium.
3. **Check (#153):** `ps eww -o command= -p <claude child> | tr ' ' '\n' | grep -oE '^[A-Z_]+='`
   lists only allow-listed names. This is live evidence of the policy, beyond the fake binary.

**Not recommended for this PR alone:** the 80-minute e2e. When sprint-6 goes to the VM, add
these checks to that release run:
- the VM relay's `claude_effort_unset` count matches what `vm.env` implies (4 if nothing is forwarded);
- one document reads correctly;
- `/models` answers.

## 7. Budget

| Tier | What | Cost | What it buys |
|---|---|---|---|
| **Minimum gate** | R1 (DB half + tsc on the merge) | minutes, unmeasured (non-DB half measured at 41.5 s) | Proof that what lands is what was tested. Without it you merge a combination nobody ran |
| + code fixes | §8 items 1–2 | ~15–30 min of developer time (estimate) | Makes the PR's own claim true, and bounds how long a probe can stall the bot |
| + R2 | one Mac document | ~20–30 min + Dror, after the Mac stack rebuild | The only evidence of Mac quality and latency at medium, and live evidence of the env policy |
| + VM checklist | rides on sprint-6's release run | ~0 extra | Resolves the VM unknowns in §4 |

## 8. Go / no-go and the way back

- **No-go** if R1 shows any failure other than the 5 known `organizer-trips` DB-less failures,
  or a failure in any of the 7 changed files. Apply the flaky-suite rule first: rerun, then run
  the file alone.
- **Way back (integration branch):** `git revert` of one commit. No schema, release or trip
  state is involved, so no snapshot is needed.
- **Way back (eventually, on the VM):** `sudo kinerary-cp-release rollback` (after `--dry-run`).
  This PR adds no migration that would make a rollback discard the database.

## 9. What would reduce the risk, ranked by risk removed per minute

1. **Run R1 on the merge with `96a2897`.** This takes minutes and no human. It is the only gap
   between "tested" and "what lands".
2. **Make the codex override check match its claim (~10 min).** Memoise a passing probe per
   `CODEX_BIN`, in the module or in `startTaskOverrideRefresh`'s closure. Add a test that two
   refreshes with a passing probe call it once. Otherwise, reword the PR and the
   `verifyCodexOverrides` doc to say "verified on every refresh". Either is fine, but a
   false "once" is not.
3. **Bound the `/model` probe to the serial loop's tolerance (~15 min).** Pass a short timeout
   (for example 5 s; the Mac measured 0.26 s) from `handleModelCommand`. Add a test with a fake
   `codex` that sleeps and assert that the refusal arrives inside the bound. This turns "can
   stall every chat for 20 s, or longer if SIGTERM is ignored" into a tested bound.
4. **Turn the latent Hermes fall-through loud before anyone configures it.** Add one line to
   `docs/control-plane-vm-deployment.md` / `docs/document-intake-operations.md`: "a Hermes
   runner's provider keys belong in `~/.hermes/.env`; the relay's env no longer reaches it
   (#192)". Route this to `doc-keeper`. It costs 5 minutes now; later it costs a metered bill
   and a quality drop nobody sees.
5. **Before sprint-6 reaches the VM, decide the effort pass-through** (a decision, below).
   Otherwise the four warnings are permanent noise, and noise teaches people to ignore
   the warning.
6. **R2 when the Mac stack is next rebuilt.** Do it then, not specially.

The honest summary: once R1 is green, this is a low-blast-radius merge. Items 2–3 are small
and make the new request-path behaviour explicit. Nothing here needs the 80-minute run.

## 10. Decisions needed (for Dror; nothing here is guessed)

1. **Should `INTERPRET_EFFORT`/`EXTRACT_EFFORT` be forwarded in `compose.vm.yml`?**
   - If yes, the VM's doc tasks switch from `CLAUDE_CONFIG_DIR` settings to an explicit effort
     with settings isolated. That is a behaviour change on production and needs its own check.
   - If no, the VM logs four `claude_effort_unset` lines on every boot, correctly.
   - The sources disagree on what the VM's `CLAUDE_CONFIG_DIR/settings.json` holds.
     `compose.vm.yml`'s comment says `{"effortLevel": "xhigh"}`, while CLAUDE.md says the VM
     "takes `medium` from `CLAUDE_CONFIG_DIR`". This needs a read on the VM.
2. **Should the §9 items 2–3 fixes happen before merge or as a follow-up?**
3. **Pre-existing hazard, not #192. Who owns it?** `organizer-trips.test.ts`
   `describe("a returning organizer's second trip")` has no `{ skip: SKIP }`. With
   `CONTROL_PLANE_TEST_DATABASE_URL` unset, `migratedPool()` runs `new pg.Pool({ connectionString:
   undefined })`, which means **libpq's defaults** (PGHOST/PGDATABASE, localhost:5432). Its
   first statement is `DROP SCHEMA IF EXISTS control_plane CASCADE`. This bypasses
   `test-database.ts`'s refusal entirely, which is the 2026-09-06 bug class. On this Mac nothing
   listens on 5432 (only 5433/5434 are mapped), so today it only fails. The fix is one token:
   add `{ skip: SKIP }`.
4. **Doc drift, for `doc-keeper`:**
   - CLAUDE.md's config block lists `EXTRACT_INTAKE_*`/`EXTRACT_ITINERARY_*=codex` in
     `provisioning.env`. **The file has neither name**, and neither does the running Mac relay
     (verified today, names only).
   - `docs/document-intake-operations.md` says codex for those two tasks is set in
     `compose.vm.yml`. **`compose.vm.yml` forwards neither**, so on the VM they inherit
     `EXTRACT_RUNNER`.
