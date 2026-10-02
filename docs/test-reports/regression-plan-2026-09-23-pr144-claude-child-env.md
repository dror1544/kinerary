# Regression plan — PR #144 (allowlisted Claude child environment) into `integration/sprint-6`

**Date:** 2026-09-23 · **Mode:** branch / pre-merge · **Planner:** `regression-planner`
**Assessed tree:** worktree `agent-ad6e3398421d0c4d7`, branch `integrator/pr144-resolve`,
HEAD `a0394b7` — which is **exactly** `origin/integration/sprint-6` as of this run
(`git rev-parse` today), so the reconciliation is against the current tip, not a stale one.

**Verdict:** merge-safe. No migration, no release-payload change, no cross-version contract.
The one question that could have made this dangerous — does the allowlist starve the CLI of
something it needs — resolves **no** against the environment the VM relay is actually given,
and the two variables whose loss caused real outages (`CLAUDE_CODE_OAUTH_TOKEN` 2026-09-11,
`CLAUDE_CONFIG_DIR` effort) are both allowlisted and one of them is asserted by test.
The real gap is not risk, it is **evidence**: the call site the integrator added to the policy
(`runWithInput`, the document path) has a spawn harness that already exists and does not
assert the environment. Closing that is ~10 lines in a passing file.

---

## 1 — Change set

| Item | Branch | State | Files |
|---|---|---|---|
| **PR #144** *fix(model-runner): give the CLI path an allowlisted child environment* | `fix/58-claude-path-hermetic` → `integration/sprint-6` | OPEN, `mergeable: CONFLICTING` (read via `gh pr view 144` today) | `control-plane/api/src/model-runner.ts` (+47/−1), `control-plane/api/test/claude-isolation.test.ts` (new, +127), `control-plane/api/test/codex-isolation.test.ts` (+35/−8) |
| **Integrator reconciliation** (uncommitted, in this worktree) | `integrator/pr144-resolve` @ `a0394b7` | working tree | same three files; `git diff --stat` vs HEAD after staging: 57 / 127 / 43 lines |
| Issue **#58** | — | stays OPEN by Dror's instruction on the PR | closes only on verification *where it runs* |

**Not in this change set, but queued behind it** (fetched today):

| PR | Branch | Files | Surface |
|---|---|---|---|
| #149 *bind chats only from a verified identity* | `fix/32-verified-identity` | `control-plane/worker/control_plane_worker/provisioner.py`, `tests/test_provisioner.py` | worker / provisioning |
| #108 *teardown carries no IP pool* | `fix/teardown-ip-pool-required` | `scripts/teardown-trip.py`, `tests/scripts/test_teardown_trip.py` | `scripts/` — reaches nothing until a human runs it |

**Housekeeping finding, unrelated to the fix:** the local `integration/sprint-6` ref in this
repo is **one commit ahead of origin** — `27453ed docs(FRAMEWORK): …`, unpushed, docs only.
`scripts/project-state.py show` therefore reports the branch "at 27453ed" while origin and this
worktree are at `a0394b7`. Harmless, but push it or merge onto it deliberately rather than
discovering it later.

**Lock state, verified today** (`scripts/project-state.py show`): sprint lock **OPEN** since
2026-09-20, baseline **LOCKED** at `97582b6`. Standing memory says "Sprint 6 locked; main merge
pending" — **that memory is stale**; the ledger says the sprint may be assessed, merged and
deployed through the normal gates. Corrected here, read from `.project/sprint.json` via the script.

---

## 2 — Risk table

| # | Change | Surface (§2) | Blast radius | Migration | Compat break | Risk | Test | Min | Batch? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `claudeChildEnv()` + `CliSpec.env`, applied at `runOnce` | `control-plane/api/src/` → VM redeploy | **every organizer mid-interview, at relay restart**; every `interpret`/`extract` call on Mac and VM | no | no | **Medium** — a starved child exits non-zero → `FAILED` → the router silently does less. Reversible by redeploy, but the damage window is invisible from the conversation | `claude-isolation.test.ts` + a direct read of `interview_interpretations.failure_reason` after the first live turn | 3 + 5 | deploy batched, **evidence isolated** |
| 2 | Same policy extended to `runWithInput` (attachments/document path) — integrator's addition | `control-plane/api/src/` → VM redeploy | **nobody today**: `read_image` is unconfigured on both stacks (below). Becomes live the moment `VISION_RUNNER` is set or a `/model read_image claude:…` override is written | no | no | **Low today, Medium latent** — the highest-value path (untrusted PDF bytes) with the thinnest evidence | `document-vision.test.ts` spawns a real child here but asserts argv only, **never the env**; needs the env assertion added | 10 to write | isolated assertion, no run of its own |
| 3 | `claude-isolation.test.ts` (new) | test only | none | no | no | None | itself | 0 | — |
| 4 | `codex-isolation.test.ts` rewritten to restate its policy as literals | test only | none | no | no | None — this *removes* a tautology that passed under mutation | itself | 0 | — |

---

## 3 — Migration and compatibility findings

**No migration.** Verified, not assumed:

```
git diff --name-only origin/integration/sprint-6...HEAD -- control-plane/db/migrations   → empty
git status --short -- control-plane/db/migrations                                        → empty
```

So none of §3 applies: no forward-only file, no snapshot owed, no `migrations.test.ts`
ordered-list churn, no `rollback:` header to write.

**No release-seal change.** `PAYLOAD_ROOTS = site, server, shared` are untouched — the diff is
confined to `control-plane/api/`. `artifactDigest` is unchanged, no new release is required, and
no provision can fail on a stale digest because of this.

**No intake-schema move.** `data_schema_min/max` and the `release_accepts_intake_schema_vN`
ritual are not involved; `planner.ts` selection is unaffected.

**No two-producer contract.** `phases[].planned` vs `phases[].venues` are downstream of the
model's *answer*, not of its environment. This change cannot alter which shape is produced —
it can only make a call succeed or fail, and a failure is already a modelled value
(`FAILED` / `NOT_CONFIGURED`), handled by the router's fallback.

**The one real cross-cutting property, confirmed by reading the code:** `CliSpec.env` is
optional and defaults to `hermeticEnv`, so the *other* adapters are untouched.

- `hermesSpec()` (`model-runner.ts:387`) declares **no** `env` field → still `hermeticEnv` at
  both call sites. The PR body's claim that "that adapter's behaviour is unchanged" is
  **verified**, not taken on trust. This matters: the Hermes agent adapter reaches its providers
  through the relay's own configuration, and narrowing it at the spawn would break extraction.
- `codexSpec()` goes through `runCodexOnce`, which already used `codexChildEnv()` (line 739).
  Untouched.
- `codexIsolationProblem()` (line 694) still spawns `codex features list` under **`hermeticEnv`** —
  i.e. with every relay secret. Its argv is a fixed literal, so no untrusted text reaches it and
  this is not an injection surface; but it is a **third spawn site still on the denylist**, and
  the function's own comment says it is unwired on Slice A. Worth naming in #58's closure notes
  so "the CLI path is allowlisted" is not later read as "every spawn in this file is".

---

## 4 — The environment question: does the allowlist starve the CLI?

This is the question that decides the whole assessment, and the 2026-09-11 precedent
(stripping `CLAUDE_CODE_OAUTH_TOKEN` made every interpret call `FAILED` until the interview
stalled on the first typed answer) is exactly the right thing to be afraid of.

**The allowlist, read from the merged file** (`claudeChildEnv`, `model-runner.ts:470`):

```
PATH  HOME
CLAUDE_CODE_OAUTH_TOKEN  CLAUDE_CONFIG_DIR
ANTHROPIC_API_KEY  ANTHROPIC_BASE_URL  ANTHROPIC_AUTH_TOKEN
XDG_CONFIG_HOME  XDG_CACHE_HOME
TMPDIR  TMP  TEMP
LANG  LC_ALL  LC_CTYPE
SSL_CERT_FILE  SSL_CERT_DIR  NODE_EXTRA_CA_CERTS
```

**What the VM relay actually holds**, read from `control-plane/deployment/compose.vm.yml`
lines 192–250 today. A compose service's container environment is exactly its `environment:`
block plus its `env_file:`s — `--env-file provisioning.env --env-file vm.env` on the command
line supplies *substitution* variables, not container environment — so this list is closed:

| Variable | Source | Under the new allowlist | Consequence |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `env_file /opt/agent-auth/claude.env` | **kept** | the 2026-09-11 outage cannot recur |
| `CLAUDE_CONFIG_DIR=/home/node/.claude-config` | `environment:` | **kept** | **load-bearing**: the VM sets no `INTERPRET_EFFORT`/`EXTRACT_EFFORT`, so effort comes only from that dir's `settings.json` (`{"effortLevel":"xhigh"}`). Losing it is the *quality* downgrade of 2026-09-11 (answers mapped to the wrong question), not a hard failure |
| `PATH`, `HOME` | base image | **kept** | the CLI runs and finds its config |
| `OPENROUTER_API_KEY` | `env_file /opt/agent-auth/openrouter.env` | **withheld** | **this is the fix.** The key stopped reaching a child that is handed untrusted organizer text |
| `INTERPRET_*`, `EXTRACT_*`, `INTERPRET_PATH_DEFAULT` | `environment:` | withheld | the nested CLI never read them; the parent resolves the binding |
| `CODEX_HOME=/codex` | `environment:` | withheld | irrelevant to `claude`; still allowlisted for `codexChildEnv` |
| `TELEGRAM_API_ROOT` | `environment:` | withheld | only the relay's own Bot API client reads it |
| `CONTROL_PLANE_ARCHITECTURE_PROFILE` | `environment:` | withheld | a path the parent reads |
| DB URL, bot tokens, gateway secret, approval keys | `secrets:` → files under `/run/secrets` | were never env | unchanged |

The **interview-MCP sidecar** (same compose file, ~lines 289–308) has the identical shape —
`EXTRACT_RUNNER`, `CLAUDE_CONFIG_DIR`, the same two `env_file`s — so the same conclusion holds
for the sidecar's `extract` calls.

**The Mac relay** is the bigger win and the lower risk. It is a host process launched by
`scripts/relay-restart.sh`, which sources the whole of `provisioning.env` — Proxmox, NPM,
Cloudflare, Telegram, database URLs — all of which previously reached every `claude -p`.
`INTERPRET_EFFORT=medium` / `EXTRACT_EFFORT=medium` **are** set there (verified: lines 133–134),
so `claudeSpec` appends `--effort medium --setting-sources "" --strict-mcp-config` and the Mac
does not depend on `HOME`-resident settings for effort at all. `HOME` is still allowlisted, which
is what lets the CLI find its keychain login on the Mac.

**Verified by test, not by reading:** `claude-isolation.test.ts:127` asserts
`login === "the-cli-own-login"` — i.e. the fail-safe runs in the other direction too, so a future
edit that drops the token from the allowlist fails the suite instead of stalling an interview.

### Residual environment risks — small, named, and two of them unchecked

1. **No proxy variables in the allowlist.** `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `ALL_PROXY`
   are absent. Verified not set in `compose.vm.yml` or `provisioning.env` today, so nothing breaks
   now. But if the VM ever gains an egress proxy, `claude` stops reaching Anthropic and the
   symptom is `FAILED` → a silent router downgrade, i.e. precisely this file's recurring bug class.
   Cheap mitigation: a comment beside the allowlist saying so, or add the four names.
2. **The relay container's real `printenv` was not read.** SSH to `debian@192.168.0.45` was
   **blocked by this session's sandbox classifier**, so I could not run
   `sudo docker exec <relay> printenv`. Compose declares the environment and is authoritative for
   what compose sets, but it cannot tell you what the `agent-runtime` base image adds. **Unchecked,
   not cleared** — see the plan, run P0.
3. **Production `model_task_settings` overrides were not read**, for the same reason. A super-admin
   `/model read_image claude:…` override would activate the attachments path immediately.
   Check with `/models` to the bot, or `SELECT task, runner, model FROM control_plane.model_task_settings;`.

### Is the attachments path live in production today? No.

Traced through `modelRunnerFromEnv` (`model-runner.ts:1342`) and `MODEL_TASKS`:

- `interpret` ← `INTERPRET_RUNNER=claude` — **live on both stacks**
- `extract` ← `EXTRACT_RUNNER=claude` — **live on both stacks**
- `extract_intake`, `extract_itinerary` ← inherit `EXTRACT_*` whole → claude — **live**
- `plan_review` ← `PLAN_REVIEW_RUNNER` unset → not configured (deterministic half only)
- `read_image` ← `VISION_RUNNER` unset on the Mac (`provisioning.env` has no `VISION_*`) and
  not passed into any VM container by `compose.vm.yml` → **not configured**

`attachments` is passed by exactly one caller in the tree — `document-vision.ts:212`, on the
`read_image` task (`ATTACHMENT_TASKS = {read_image}`). `itinerary-extract` sends *text*, not bytes.
So `runWithInput` — the line the integrator changed — is **dark in production today**. That makes
the change safe to ship and makes its missing assertion cheap debt rather than an emergency; it
also means a live run will not exercise it, which is the argument for a unit assertion instead.

---

## 5 — Live-fleet impact

Read today, 2026-09-23, off production through the fleet monitor's **read-only** MCP
(`fleet-mcp.mjs`, `PGOPTIONS` read-only), stack `prod` = the control-plane VM.

**Trips:**

| Trip | Stage | Class | Note |
|---|---|---|---|
| `japan-tokyo-hakone-kyoto-osaka-2026` (`trip_66617c87…`) | `ready_private` | **live** | created 2026-09-14, idle 172h, reachable. **Real people are on it** — past the line `teardown-trip.py` and `fresh-interview.py` both refuse |
| 4 × `draft-sreq-…` | `draft` | prospect | 10h / 62h / 65h / 163h idle |
| ~35 × `retired-…` | various | retired | test residue |

**Open interviews:** `stalled_interviews` returns 6 rows, **all `awaiting: person`, all `EXPIRED`**.
So at the moment of this read there is **no conversation a relay restart would drop**. That is a
snapshot, not a permit — re-read it in the minutes before the restart, because the relay is also
the signup bot and a new organizer can arrive at any time.

**Baseline for the post-deploy assertion,** captured now from the live trip so "after" has a
"before":

```
MODEL CALLS IN THE INTERVIEW  (failures the organizer never sees as errors)
  outcome   | count | last
  succeeded | 16    | 09-15 18:30
```

**Who feels this change, and when:**

- **Everyone, at relay restart.** `control-plane/api/src/` reaches production by VM redeploy
  (`KINERARY_REV`, `sudo kinerary-cp-release upgrade`), and the relay additionally by
  `control-plane/deployment/vm-relay-restart.sh`. The interview's model calls are made in the
  relay, so this change is felt the moment that process restarts.
- **The live trip's site is not affected and does not need redeploying.** This is the asymmetry
  worth stating plainly in both directions: the fix cannot reach a trip site (it is not in a
  release payload), and it does not need to — nothing on a trip site calls `model-runner.ts`.
  So unlike PR #86's site-upload auth fix, **no per-trip redeploy is owed here**.
- **Not reached at all:** CT200 `trip-usa2026` (real production that no control plane tracks —
  standing memory, not re-verified today), companion containers, `trip-mcp` bridges, the portal.
- **Provisioning is ON on the VM for a real organizer** (since 2026-09-14, standing memory —
  **could not re-verify today**, SSH blocked). Any VM test run needs a human's yes first, and
  test scripts that switch provisioning off on exit must not be run unattended here.

---

## 6 — Batch or isolate

**Batch the deploy with #149 and #108. Isolate #144's evidence.** The reasoning, against §6's
four refusal tests:

| Test | #144 vs #149 / #108 | Verdict |
|---|---|---|
| Same observable? | No. #144's observable is "the interview still understands a typed answer"; #149's is "which chat got bound to which trip" (worker, provisioning only); #108's is a teardown script that reaches nobody until run | batchable |
| Can one mask the other? | No. #149 cannot make a model call succeed or fail; #108 does not deploy | batchable |
| Silent failure mode? | **#144: yes.** A starved child returns `FAILED`, the router falls back to its own questions, and the organizer sees a reasonable conversation that is quietly worse. This is the repo's own bug class | **direct assertion required, not an e2e impression** |
| Security path? | #144 is an isolation change, so its *evidence* is request/response-grade by nature — but it is not `sanitizeConfig`/visibility/`authRequired`, so it does not need `boundary-reviewer`'s pass. #149 *is* a trust-boundary change (identity for a binding) and should get one | route #149 to `boundary-reviewer`; #144 does not need it |
| One-way migration? | None of the three | — |

The resolution: one deploy carrying all three is correct and cheaper. What must **not** be shared
is the conclusion — #144 is not proven by "the e2e run went fine", because a downgrade looks like
a fine run. It is proven by reading `interview_interpretations.failure_reason`, which attributes
by itself and costs five minutes.

**One caveat on sample size.** `interpret` is a model in the loop, so one green interview is one
sample. Two scenarios, not one, if a full e2e is run at all (see the budget tier T3).

---

## 7 — The plan

Numbers marked **measured** were run by me in this worktree today. Numbers marked *estimated*
are labelled as such.

### P0 — Pre-merge, no deploy (**measured: 4 s of compute**)

| Step | Command | Result today |
|---|---|---|
| a | `node --import tsx --test --test-concurrency=1 --test-timeout=300000 test/claude-isolation.test.ts test/codex-isolation.test.ts test/model-runner-env.test.ts test/model-runner.test.ts test/model-runner-tasks.test.ts test/model-switch.test.ts` (from `control-plane/api`) | **54 tests, 54 pass, 0 fail, 2.9 s wall — measured 2026-09-23** |
| b | same runner on `test/document-vision.test.ts test/document-intake-flow.test.ts` | **15 tests, 15 pass, 0 fail, 1.0 s wall — measured 2026-09-23.** This is the suite that actually spawns a child through the changed `runWithInput` line; it was **not** in the verifier's six files and is the one gap in the verification already done |
| c | `scripts/preflight-checks.sh --staged` | **exit 0 — measured 2026-09-23**; three warnings, all pre-existing Hermes-profile drift, none from these files |

Nothing else in P0. The DB-backed suites are not owed by this change: no schema, no query, no
route. Their absence is a real gap for *other* sprint-6 work, not for this one — say so rather
than carrying it as a blocker on #144.

### P1 — The assertion that is owed before deploy (*estimated 10–15 min, developer*)

Add an environment assertion to the **attachments** path, in the fixture that already exists.
`document-vision.test.ts:161` ("the claude CLI gets the file as a stream-json content block, and
no tools") already writes a fake `claude`, spawns it through `runWithInput`, and reports
`process.argv`. It reports **no** environment. Add `env: Object.keys(process.env).sort()` to its
`seen` object and reuse `claude-isolation.test.ts`'s two assertions (named secrets absent, subset
sanctioned). Also assert `CLAUDE_CONFIG_DIR` **reaches** the child — the current isolation test
asserts only the OAuth token, and `CLAUDE_CONFIG_DIR` is the VM's sole source of effort.

Why this and not a live run: the attachments path is dark in production (§4), so no live run can
exercise it. A unit assertion is the only evidence available, and the harness is already written
and green.

### P2 — Read the VM before deploying (*estimated 5 min, needs a shell on the VM*)

Neither step is performable from this session — SSH was blocked by the sandbox classifier — so
both are handed over rather than reported clean.

```bash
# 1. What the relay child could actually inherit. Names only; never values.
sudo docker exec <relay container> printenv | cut -d= -f1 | sort
#    Look for: anything the claude CLI needs that is NOT in claudeChildEnv —
#    in particular *_PROXY, NODE_EXTRA_CA_CERTS, SSL_CERT_*.

# 2. Is read_image pinned by a super-admin override? (activates the attachments path)
#    Either: send /models to the bot as super admin
#    Or:     SELECT task, runner, model FROM control_plane.model_task_settings;
```

### P3 — Deploy and the first-turn assertion (*estimated 20–30 min including the upgrade; Dror present*)

Order matters, and the relay restart is the hazard, not the code.

1. **Re-read the fleet immediately before**, from any checkout:
   ```bash
   KINERARY_FLEET_CONFIG=~/.hermes/profiles/trip-monitor/fleet-stacks.json \
     node .agents/skills/trip-fleet-monitor/fleet-mcp.mjs --tool stalled_interviews --stack prod
   ```
   Any row with `awaiting: machine` updated in the last five minutes → **wait**.
   `vm-relay-restart.sh` enforces this; do not talk it out of it.
2. **Snapshot + upgrade** via `sudo kinerary-cp-release upgrade` — `--dry-run` first, always.
   Never hand-edit `KINERARY_REV`. The tool snapshots the VM from the Proxmox host and dumps the
   database; that dump is the way back (§8). Note its storage guard refuses any upgrade,
   `--dry-run` included, while a network filesystem is mounted on the VM (standing memory,
   2026-09-18; verify at the time).
3. **Post-restart checks** from the runbook's own list: `readyz` → `"status":"ready"`;
   `logs relay` shows `relay.bot_identity` naming `@Kinerary_bot`, `relay.ready … polling:true`,
   **no 409**; `INTERPRET_RUNNER` / `EXTRACT_RUNNER` / `INTERPRET_PATH_DEFAULT` set *inside* the
   container.
4. **The assertion that makes the silent failure loud** — one typed answer through a fresh
   interview, then:
   ```bash
   KINERARY_FLEET_CONFIG=~/.hermes/profiles/trip-monitor/fleet-stacks.json \
     node .agents/skills/trip-fleet-monitor/fleet-mcp.mjs --tool trip_detail --stack prod --trip <slug>
   ```
   Read **MODEL CALLS IN THE INTERVIEW**. Baseline on the live trip today: `succeeded 16`, zero
   failures. Any `FAILED` / `UNAUTHORIZED` / `NOT_CONFIGURED` appearing after the deploy is this
   change until proven otherwise — that is the whole point of asserting on the column rather than
   on the conversation.
   **Note:** this section is present in the repo's `fleet-mcp.mjs` but **absent from the deployed
   `trip-monitor` profile copy** (preflight flags the drift; I confirmed the installed copy's
   `trip_detail` prints no MODEL CALLS block). Either run the repo copy with
   `KINERARY_FLEET_CONFIG` as above, or deploy the skill first:
   `scripts/install-hermes-skill.sh trip-fleet-monitor trip-monitor`.
5. Confirm `interpret_path` is still `t` on the new session — the standing check for the interview
   silently growing an agent back.

### P4 — Optional, only if batching #149 (*documented ~80 min for all scenarios; a person + an agreed window*)

`scripts/preflight-deploy.sh --deploy --auto --scenario multi --cleanup`, or the VM's
`scripts/e2e-full-cycle.py` with `KINERARY_COMPOSE_PROJECT` / `KINERARY_RELAY_CONTAINER` /
`KINERARY_RELAY_RESTART` set. Two standing hazards apply and are not optional:

- **The Mac and the VM must not run at once** — same Proxmox, NPM, Cloudflare, tunnel, and the
  same slug derived from the same scenario. Ask for a window.
- **Do not use the `japan` scenario.** Standing memory: the japan e2e fixture collides with a real
  trip on the same cities *and* dates, slug derivation is nondeterministic, and there is no guard
  in code. Use `multi` or `manual`.
- Provisioning is on for a real organizer on the VM; any VM run needs Dror's yes first.

---

## 8 — Budget

| Tier | What | Cost | What it buys |
|---|---|---|---|
| **T0 — the gate** | P0 (a,b,c) + P1 | **4 s measured** + ~15 min to write the test | Proves the change does not break either call site, and turns the document path from "covered by code-sharing" into "asserted". This is the minimum I would merge on |
| **T1 — before deploy** | + P2 | ~5 min on the VM | Converts the two things I could not check from "assumed fine" into "read". Without it you are deploying on a compose file that is correct about what compose sets and silent about what the image adds |
| **T2 — the deploy** | + P3 | ~20–30 min, Dror present | The only tier that proves the CLI still authenticates and still runs at the intended effort **where it runs** — which is also the condition Dror set for closing #58 |
| **T3 — batched acceptance** | + P4 | ~80 min documented, + a window | Only needed if #149 rides along; it proves the provisioning path, not this one. For #144 alone it buys one extra sample of a non-deterministic call, which the T2 assertion already measures more directly |

**T2 is the honest floor for closing #58.** T0+T1 is the honest floor for *merging*. Those are
different questions and the PR body already separates them correctly.

---

## 9 — Go / no-go, and the way back

**Stop the merge if:** P0(b) goes red — that is the suite covering the line PR #144 never wrote;
or P1 reveals the attachments child inherits something unsanctioned, which would mean the policy
is not actually shared between the two call sites.

**Stop the deploy if:** P2 shows the relay holds a variable the CLI needs that is not allowlisted
(any `*_PROXY`, an image-injected `NODE_EXTRA_CA_CERTS` that is *not* passed, a cert path);
or `stalled_interviews` shows `awaiting: machine` within five minutes; or a live conversation is
in progress; or `kinerary-cp-release --dry-run` refuses.

**The way back:** `sudo kinerary-cp-release rollback`, using the snapshot and database dump the
upgrade recorded. No migration means the rollback is a pure code revert — the database does not
have to come back with it, and the `rollback: compatible|breaking` header question does not arise
because no migration file exists in this change set. **This is the cheapest rollback shape the
control plane has**, and it is a genuine argument for shipping this change on its own rather than
waiting to batch it behind something that does carry a migration.

**Who decides:** the upgrade and the restart are Dror's, per hard rule 2. Nothing in this plan is
an approval.

---

## 10 — What would reduce the risk, ranked by risk removed per minute

1. **Add the env assertion to `document-vision.test.ts:161`** (~10 min). The fixture, the spawn and
   the fake binary already exist and pass; only the `env` key and two assertions are missing. This
   is the single highest-value item: it closes the exact gap between "the integrator extended the
   policy to `runWithInput`" and "anything proves it".
2. **Assert `CLAUDE_CONFIG_DIR` reaches the child** in `claude-isolation.test.ts` (~3 min). The
   test guards the OAuth token — the *hard* failure of 2026-09-11 — but not the config dir, which
   is the *silent* one: without it the VM falls back to the CLI's default effort, the mode in
   which it once mapped answers to the wrong question. Losing the token fails loudly; losing the
   config dir does not, so it is the one that needs the test more.
3. **Run P2's `printenv` on the VM before deploying** (~5 min). It is the only way to know what the
   `agent-runtime` image adds beneath compose. I could not run it; nobody should assume it came
   back clean.
4. **Add `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`ALL_PROXY` to the allowlist, or a comment saying
   why not** (~2 min). Not needed today — verified absent from both `compose.vm.yml` and
   `provisioning.env` — but the failure mode if the VM ever gains an egress proxy is `FAILED` →
   silent downgrade, which is precisely the class this file keeps paying for.
5. **Deploy the fleet-monitor skill to the `trip-monitor` profile** (~2 min,
   `scripts/install-hermes-skill.sh trip-fleet-monitor trip-monitor`). The MODEL CALLS section —
   the assertion this plan leans on — exists in the repo and not in the running monitor. Until
   then the monitor cannot see the failures the organizer never sees either.
6. **Name `codexIsolationProblem`'s `hermeticEnv` spawn in #58's closing notes** (~2 min). Not a
   bug; but "the CLI path is allowlisted" should not be read later as "every spawn in this file is".
7. **Push or merge onto the local `27453ed`** so `project-state.py` stops reporting a branch
   position neither origin nor this worktree holds (~1 min).

Nothing here asks for a new suite, a rehearsal against restored data, or an 80-minute run on
#144's account. The change is small in blast radius *because* it is reversible without a database,
and the plan says so rather than manufacturing work.

---

## 11 — Decisions needed (nothing guessed)

1. **Does #144 deploy alone or batched with #149?** Batched is cheaper and safe on the analysis in
   §6; the only cost is attribution during a live run, which the §7 P3 assertion recovers. Dror's
   call. #108 touches `scripts/` only and can ride along with either.
2. **Is provisioning still ON on the VM for a real organizer?** Standing memory says yes since
   2026-09-14; **I could not re-verify today** (SSH blocked). If it is, any VM test run needs an
   explicit yes and must not be left unattended.
3. **Is `read_image` overridden to `claude` in production `model_task_settings`?** Unread. If yes,
   the attachments path is live today and item 1 of §10 moves from "cheap debt" to "owed before
   deploy".
4. **Does #58 close on T2, or does Dror want an attachment-carrying turn on the VM too?** Per his
   2026-09-21 instruction the issue closes on verification where it runs; the plain-prompt path can
   be verified there today, the attachments path cannot be until `VISION_RUNNER` is configured.
5. **Does #149 get a `boundary-reviewer` pass before the shared deploy?** It changes how a chat
   binding derives identity — the webhook/callback trust-boundary class. Out of scope for this
   plan; flagged because a shared deploy would otherwise carry it in unreviewed.

---

### Provenance of every load-bearing claim

| Claim | Source | When |
|---|---|---|
| Change set, PR state `CONFLICTING` | `gh pr view 144` | 2026-09-23 |
| HEAD == `origin/integration/sprint-6` | `git rev-parse`, after `git fetch` | 2026-09-23 |
| No migration | `git diff --name-only … -- control-plane/db/migrations` (empty) | 2026-09-23 |
| Allowlist contents | `control-plane/api/src/model-runner.ts:470`, read | 2026-09-23 |
| `hermesSpec` has no `env` | `model-runner.ts:387`, read | 2026-09-23 |
| `codexIsolationProblem` still on `hermeticEnv` | `model-runner.ts:694`, read | 2026-09-23 |
| VM relay environment | `control-plane/deployment/compose.vm.yml:192-250`, read | 2026-09-23 |
| Mac runner/effort settings | `~/kinerary-deploy/provisioning.env:129-134`, read | 2026-09-23 |
| `read_image` unconfigured; task inheritance | `model-runner.ts:1342-1365` + `document-vision.ts:38,212`, read | 2026-09-23 |
| Attachments path has a spawn test with no env assertion | `test/document-vision.test.ts:161-205`, read | 2026-09-23 |
| 54/54 in 2.9 s; 15/15 in 1.0 s; preflight exit 0 | run by me, this worktree | 2026-09-23 |
| 1376/1368 full api suite | PR #144 body — **on the PR branch, not this reconciliation** | read 2026-09-23 |
| Live fleet, stalled interviews, model-call baseline | `fleet-mcp.mjs` read-only against stack `prod` | 2026-09-23 |
| Sprint lock OPEN, baseline LOCKED at `97582b6` | `scripts/project-state.py show` | 2026-09-23 |
| VM `printenv`, `model_task_settings` overrides | **NOT CHECKED** — SSH blocked by this session's sandbox | — |
| Provisioning ON for a real organizer; CT200 untracked; `kinerary-cp-release` storage guard; japan fixture collision | standing memory, **not re-verified today** | carried, flagged |
