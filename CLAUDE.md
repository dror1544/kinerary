# CLAUDE.md

This file provides guidance to Claude Code when working with code in this
repository. `AGENTS.md` points other agents (Codex, etc.) back here — this is
the one place the rules live, not two files kept in sync by hand.

## Hard Rules — Always Enforced

> These override any default behavior. No exceptions.

1. **Never `git commit` without explicit user approval.** Finish the change,
   summarize what's ready, then wait for "commit", "go ahead", or equivalent.
   (Two MVP-phase exceptions: docs-only commits, and commits on a feature
   branch — the approval then comes at the merge. See "MVP phase" below.)
2. **Never deploy a live trip site without explicit approval** — pushing code
   to a running container, `docker compose up -d --force-recreate`, restarting
   `trip-server`, etc. Ask "ready to deploy?" after committing; a commit
   instruction does not imply a deploy instruction.
3. **Never commit binary files (PDFs, images, audio) into git.** They belong
   outside the repo — NFS, iCloud, wherever the deployment already syncs media
   from — not in the tree.
4. **Never write to `trip/` (singular).** That name is reserved for whatever
   `TRIP_DIR`/`TRIP_DIR_HOST` defaults to when unset. New trips always go in
   `trips/<slug>/` (plural) — see `.agents/skills/create-trip/SKILL.md`.
5. **Never expose `mcp/provision.js` beyond the LAN.** It writes to the
   filesystem and restarts containers; `mcp/mcp.js` is the one meant to be
   public. See `mcp/PROVISIONING.md`'s "the one rule" before touching either
   server's network config.
6. **Never name *this* deployment in this repo.** Ask, as you type it:
   **would a second Kinerary, on somebody else's hardware, have to edit this
   file?** If yes it is deployment — a host, an IP, a container name, a VMID,
   an SSH key, an `/opt` path, a chat id — and it belongs in `kinerary-deploy`,
   reached through an env var or a config file read at runtime. See
   "Two repositories" below for the shape and the escape hatch.

## MVP phase — lighter rules (owner's decision, 2026-09-25; item 3 and the last paragraph, 2026-09-26)

For as long as the product is an MVP running family-and-friends trips, three
kinds of friction are removed. They remove a prompt, not a protection: the
approval for code moves to the merge, and every hard rule above still holds
for deploys, binaries and this deployment's names.

Two branches carry names in this document. The **leading branch** is
`integration/sprint-N` — where sprint work lands. The **production branch** is
`main` — what a release is cut from. Nothing below exempts either of them.

1. **Docs-only work needs no per-commit approval.** A commit whose every staged
   path is documentation (`docs/**/*.md`, `CHANGELOG.md`, `FRAMEWORK.md`,
   `README.md`), and the push of commits that are only that, on an
   `integration/sprint-*` or `docs/*` branch, from the lead session, is not
   prompted. `scripts/claude-hooks/pretooluse-bash.sh` implements it and
   vouches only for one plain `git commit` (message from `-F <file>` or
   `-m '<text>'`) or one plain `git push` to the branch's own upstream — never
   `git add … && git commit`, `-a`, `--amend`, `--no-verify`, another directory,
   a force, or a merge commit. `CLAUDE.md`, `AGENTS.md`, `.claude/`,
   `.githooks/`, `.github/` and `scripts/` are policy, not documentation, and
   always ask. Merges, deploys, and commits or pushes outside items 1 and 3
   still ask (rules 1 and 2). A subagent is still refused for all of them.
2. **Read-only production probes need no per-probe approval.** Health checks,
   versions, trip dates, dropped-config paths and similar reads against the
   control-plane VM and the live trips. A probe may read a trip's key inside the
   command to authenticate; it never prints, logs or writes the key, never puts
   it on a command line (feed it to `curl --config -` on stdin, as
   `companion-install-host.sh` does), and reports only the verdict. Anything
   that writes, restarts, deploys or changes a config still needs approval, and
   reading what travellers wrote is not a probe: the alpha-tester data policy
   applies. The harness's own permission classifier is separate from this rule
   and can still ask; a Bash permission rule in the *user's* settings, not in
   this repo, is how to quiet it.
3. **Feature-branch work needs no per-commit or per-push approval; the merge
   into the leading branch is the approval (owner's decision, 2026-09-26).**
   Before this, one change cost three prompts — commit, push, merge — and PRs
   merged 24–45 minutes after they opened (#192, #196, #197, #211, #215), so
   the time went on the prompts, not on review. A commit on a `fix/`, `feat/`, `carry/`
   or `chore/` branch from the lead session, and the push of that branch to its
   own name on origin, are not prompted: nothing reaches anyone until the branch
   is merged. `pretooluse-bash.sh` vouches only for one plain `git commit`
   (message from `-F <file>` or `-m '<text>'`) or one plain
   `git push [-u] origin <that branch>`, in this repository's own worktrees
   (`cd <dir> &&` or `git -C <dir>` is read; another repository is not vouched
   for) — never for a staged policy path (`CLAUDE.md`, `AGENTS.md`, `.claude/`,
   `.githooks/`, `.github/`, `scripts/`, `.preflight-allow`), `-a`, `--amend`,
   `--no-verify`, a force, another branch, or `main`. The mechanical checks run
   first, from that worktree's own copy of `scripts/preflight-checks.sh`,
   against that worktree's index. **The merge into `integration/sprint-*` is the
   one prompt**, and its text carries the PR's base branch and its check
   results (`gh pr view`, best effort — an unreadable GitHub says so and still
   asks). A merge onto `main`, a deploy, and every commit, push or merge by a
   subagent are unchanged.

What stays a gate: the integrator, boundary review for security paths, a
regression plan (sprint mode) before each release, and every merge to `main`
and deploy. What is narrower since 2026-09-26, by the owner's decision:

- the per-PR regression plan is for PRs that add a migration, touch auth or a
  boundary path, or change relay behaviour; a site-only, test-only, tooling or
  docs PR is recorded as "assessment: not needed (why)". The deploy prompt only
  reads back a plan for the exact HEAD being deployed, which a per-PR plan is
  not;
- green CI on the PR's merge ref stands in for the integrator's local
  merged-tree verifier when the merge is clean, no file is touched by both
  sides and no security path is involved (`model-runner.ts`, `server/server.js`,
  `shared/`, anything spawning a process with an environment). On any overlap
  or security path the full path applies: a clean merge is not evidence there;
- the documentation and branch sweeps run once a day and at sprint end, not
  after every merge;
- a PR gets at most two review rounds. A finding after the second that is not a
  correctness or security defect becomes a follow-up issue, named in the PR's
  carry-forward; a third round is the owner's call.

Rules 2–6 are untouched.

## What this repo is

A config-driven, multi-trip family/friend-group travel site — one shared
site/server, many `trips/<slug>/trip.config.json` directories. Full
architecture, feature inventory, and DB schema: `FRAMEWORK.md`. Quick-start
and hosting options: `README.md`. Don't duplicate either here — if something
here starts drifting from those, fix it there and link, not copy.

## Two repositories — `kinerary` is the product, `kinerary-deploy` is where it runs

**`kinerary` says what and how. `kinerary-deploy` says where.** That is the
whole rule, and hard rule 6 is the test for it.

**The reason is portability, not secrecy.** It is tempting to think the split
exists because this repo has been public — which would make it negotiable the
moment it goes private. It is not. The product has to be deployable on k3s, on
a different Proxmox, on hardware nobody here owns; anything that assumes *this*
house is a thing the second deployment has to find and undo. Secrecy is a
side-effect of the split, never its justification.

**What it looks like in practice** — the mechanism is generic and refuses to
guess; a thin private wrapper supplies the values:

| | |
|---|---|
| `scripts/bootstrap-fleet-monitor.sh` | knows no host, container, uid or path; **refuses** if they are unset |
| `kinerary-deploy/bootstrap-monitor.sh` | knows this VM, and is the only half that had to be private |

`deploy.sh`, `bring-up.sh` and `setup-mcp.sh` are the same split, one level
down. `bring-up.sh` says it in its own header: *"Deliberately NOT part of the
kinerary git repo … this is operator/deployment concern for real
infrastructure, and it names real hosts and checkouts."*

**A default that names this house is the failure mode**, not a convenience.
`compute.py` still defaults `proxmox_host` to `192.168.0.40`, `rpi_host` to a
machine that was decommissioned when ingress moved to CT120, and
`proxmox_ssh_key` to a key name from this laptop. All three are overridden by
`provisioning.env` here, so nothing is broken *here* — which is exactly why
nobody notices. The second deployment that forgets one env var does not get an
error; it quietly points at somebody else's home lab.

**The escape hatch is a recorded decision, not a habit.** Pre-existing
offenders are enumerated in `.preflight-allow`, each with its reason. That list
is the migration backlog — entries come off it, they do not accumulate.

## Skill mirror — read before touching `.claude/skills/` or `.agents/skills/`

`.agents/skills/create-trip/` is the **real directory**. `.claude/skills/create-trip`
is a symlink to it. `mcp/provision.js` shells out to
`.agents/skills/create-trip/driver.mjs` by path, with `.claude/` only as a
fallback — so `.agents/` has to stay the one with real content. If you ever
find both sides holding real files again, that means the symlink got deleted
somewhere upstream; recreate it, don't hand-merge two copies:
```bash
rm -rf .claude/skills/create-trip
ln -s ../../.agents/skills/create-trip .claude/skills/create-trip
```

### Hermes skills: capture before you deploy

`~/.hermes` is not version controlled, so a skill edited only in a profile has
no history. But the profile is where the agent actually works, so it is where
insight shows up first — a scoring note that proved wrong, a metric worth
adding, a takeaway other agents should reuse. Traffic goes both ways:

```bash
scripts/install-hermes-skill.sh <skill> <profile> --capture  # profile -> repo, then commit
scripts/install-hermes-skill.sh <skill> <profile>            # repo -> profile
scripts/install-hermes-skill.sh <skill> <profile> --check    # report drift, exit 1
```

Deploy **refuses** when the profile has diverged, so capture-then-deploy is
enforced rather than remembered; `--force` discards local changes and is only
for when you have confirmed there is nothing there worth keeping. Every deploy
refreshes a notice in the profile stating this.

Anything durable belongs in `.agents/skills/`, not only in a profile. If you
find content in a profile that is not in the repo, capture it — that is how
`trip-assistant-experience-evaluation` nearly lost its scoring notes.

## Two MCP servers — different trust levels

| | `mcp/mcp.js` | `mcp/provision.js` |
|---|---|---|
| Manages | data inside a trip that already exists | trips themselves |
| Can do | photos, bookings, trivia, comments, RSVPs | write files, run the scaffolder, restart the site |
| Exposure | fine to publish (Cowork connects to this) | **never** — LAN-only |

Details: `mcp/README.md`, `mcp/PROVISIONING.md`.

## Security-sensitive paths — don't "fix" these with a one-off exemption

- `sanitizeConfig()` (`server/server.js`) and `GET /api/config/warnings` carry
  a **blanket** invariant: no raw `trip.config.json` value is ever served,
  full stop. Several real leaks came from judging individual fields
  case-by-case as harmless — don't reintroduce that pattern. Since #172
  (2026-09-25) `sanitizeConfig()` is an **allow-list**
  (`shared/config-visibility.js`): a field it does not name is withheld,
  silently and on purpose, and its path is logged at boot. A field missing on a
  site is therefore a list entry to decide, never a reason to go back to
  removing known-bad fields. On 2026-09-22 (#156) a data-derived `origin` field
  carrying `hermes:<profile>` — an internal identifier, not trip data — reached
  the same route by the same "no renderer reads it" shortcut, because the old
  sanitizer was a deny-list and passed anything it was never told to remove;
  fixed with an allow-list at the producer before any deployment had a search
  profile configured to make it live.
- `shared/needs-schema.js` / `shared/agent-schema.js` visibility rules fail
  **safe** by design: anything unrecognized resolves to the most restrictive
  option. An unknown value falling through to "public" is the bug class this
  exists to prevent.
- `authRequired` accepts either a family member's JWT or the agent API key —
  it is **not** an organizer check. Use `organizerOrAgentRequired` where
  organizer-only scoping is actually needed.

## Testing

```bash
cd tests && npm test                           # the trip-site suite alone
scripts/preflight-deploy.sh                    # every suite, with its real deps — deploys nothing
scripts/preflight-deploy.sh --deploy           # + deploy THIS checkout, verify it, walk one trip (you do the interview)
scripts/preflight-deploy.sh --deploy --cleanup # + tear down the trip this run created
#   --scenario japan|multi|manual|all|none     # which trip; none = deploy + automated checks only
#   --auto                                     # an automated organizer plays the person (needed for `all`)
scripts/preflight-deploy.sh --deploy --auto --scenario all --cleanup   # everything, hands off, nothing left behind
```

`--auto` replaces exactly one thing: a person on Telegram. The relay is pointed
at a local Bot API stand-in (`control-plane/api/tools/fake-telegram.ts`, via
`TELEGRAM_API_ROOT`, which only accepts https or loopback because it receives the
bot token), and `tools/auto-organizer.ts` sends `/start`, uploads the
scenario's documents, types and taps through it — reading its own session over a
**read-only** connection to know which question is on screen. Everything else is
production code doing production work. The relay goes back to real Telegram in
a `finally`, so a failed run cannot leave @Kinerary_bot answering a stand-in;
while a run is going, real messages to the bot wait at Telegram. Restart the
relay only with `scripts/relay-restart.sh` — it sources `provisioning.env`
itself and reads `INTERPRET_*` back off the running process.
Run before claiming something works, not after. The default mode runs what CI
runs and what CI does not (trip-web, runtime-gateway, `tests/scripts`), and it
**provides** dependencies rather than skipping without them: a Python 3.12 venv
with the worker's requirements (cached in `~/.cache/kinerary-preflight`), `npm
ci` where a package has none. It used to report the worker and provisioning
suites as "skipped" on a Mac whose `python3` lacks PyYAML — a clean preflight
that had not run 340 tests.

Every mode cleans up after itself on every exit, Ctrl-C included: its private
test database is dropped, a test Postgres it started is stopped, the tracked
`site/modern` is restored if the trip-web build changed it, and the temp dir
goes (kept, and named, when the run failed).

`--deploy` **is** a deploy — hard rule 2 applies, and the hook prompts on this
script whatever its flags. It refuses uncommitted tracked changes (a deploy has
to be a commit you can name) and a provisioning job that is mid-build.
`--cleanup` removes only the trip whose id this run's signup returned, through
`scripts/teardown-trip.py` — see below. If you touch a
security-relevant path (anything above, or auth in general), show the actual
request/response proving the thing is hidden or scoped correctly — not a
description of the code.

### Tearing down a test trip

```bash
scripts/teardown-trip.py --trip <slug|trip_id>            # the plan — read-only
scripts/teardown-trip.py --trip <slug|trip_id> --execute  # do it
```

The inverse of provisioning: backs everything up first, then the interviewer's
allowlist entry, the companion's gateway and trip-mcp bridge, the Cloudflare
record and ingress rule, the NPM host and the LXC (through the worker's own
provisioner), the chat bindings, any still-live group-binding tokens (issue
#175), and slug (`retired-<slug>-<yyyymmdd>`, which frees the name), the
deploy directory, and the profile. **Order matters in one
place**: the allowlist entry goes, and the interviewer restarts, *before* the
profile is deleted — the interviewer runs a cron ticker per allowlisted profile,
and on 2026-09-11 that ticker recreated a deleted profile's directory, which is
enough to make the next trip of that name install without a companion.

**Order matters a second time, inside `retire_in_db`'s own transaction**:
revoking any still-live group-binding token runs *before* closing chat
bindings and renaming the slug, not after — reversed, it deadlocks against a
concurrent `redeemGroupBindingToken` call (a real `40P01`, reproduced against
Postgres, issue #175). See `REVOKE_GROUP_TOKENS`'s comment in
`scripts/teardown-trip.py` for the lock order.

It refuses a trip past `ready_private` (real people have used it) and a profile
another trip's open binding still names. There is no `--force`.

`--keep-container` tears the trip down but keeps its site running on the LAN as a
reference: public hostname removed, container renamed `ref-<slug>`, its NFS data
moved to `ref-<slug>`, deploy dir kept as `trips/ref-<slug>`. The renames are not
cosmetic — a new trip that takes the freed slug would otherwise adopt the kept
container by name, wipe its data on first provision, and reuse its IP.

### Trip containers start on boot

Every trip container is created with `--onboot 1 --startup order=3`, after TrueNAS
(order 1, which serves their NFS mount) and the control-plane VM (order 2). Turn it
off for one trip with `scripts/trip-autostart.py --trip <slug> --off`
(`--on` restores it; no flag shows it).

### The control-plane DB suites destroy the database they are given

```bash
CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest" \
  npm test --prefix control-plane/api
```

That URL is not a preference. Every DB-backed suite in `control-plane/api`
opens with `DROP SCHEMA IF EXISTS control_plane CASCADE`, so whatever database
it is handed is the database it wipes. On 2026-09-06 it was handed
`.local-secrets/control_plane_database_url_host` — the dev stack's own
database, reached through the host port instead of the compose network — and
the running control plane lost every trip, binding and intake version. The
tests passed. Nothing warned. The stack was found broken afterwards, by its own
readiness probe returning 42P01.

`test/support/test-database.ts` now refuses any database whose name does not
say it is for tests, and names the right URL in the refusal. Unset still means
"skip the DB suites" — the unit subset with no database is a normal state. A
suite that is *set* to something unsafe fails loudly rather than skipping,
because a skip would hide the misconfiguration for the next person.

Nothing outside that file needs to know the rule, which is the point: it was
already written down in `docs/sprint5-trip-bot-router-design.md` and being
written down was not enough.

**`--test-timeout` bounds a HANG, not a file.** It was set to 60s in #23 to
catch a test awaiting something that never settles, when "nothing legitimate
approaches the bound (slowest observed: ~1.2s)". `node:test` applies the same
value to the per-FILE subtest, and these files are no longer 1.2s:
`interview-transcript` is 81s locally and CI runners are slower again. Three
files were cancelled on CI at 60s — `# fail 0`, `# cancelled 3`, every test in
them passing. It is 300000 now, which still fails a hung test, just not a
passing suite. Raise it rather than trim a suite to fit; if a file genuinely
approaches five minutes, split the file.

### The interview has no agent — and silently grows one back

The interview is a **deterministic router calling bounded LLM functions**, not
an agent (`docs/interview-without-an-agent.md`). Per session that is
`intake_sessions.interpret_path`, set at creation from `INTERPRET_PATH_DEFAULT`.

These live in `~/kinerary-deploy/provisioning.env` and must reach the **relay
process**, which is where the interview's model calls are made:

```
INTERPRET_PATH_DEFAULT=1
INTERPRET_RUNNER=claude   INTERPRET_MODEL=claude-sonnet-5   INTERPRET_EFFORT=medium
EXTRACT_RUNNER=claude     EXTRACT_MODEL=claude-sonnet-5     EXTRACT_EFFORT=medium
ITINERARY_EXTRACT_TIMEOUT_MS=120000
```

Documents are read with `EXTRACT_RUNNER=claude` — what runs on the Mac and the
VM today (decided 2026-09-25: use what is running). A per-task Codex binding
(`EXTRACT_INTAKE_*` / `EXTRACT_ITINERARY_*`, `gpt-5.6-luna`) was benchmarked on
2026-09-13 (`docs/document-intake-operations.md`) but is not configured
anywhere (#202); switching to it is a deliberate change, not a repair.

**The harness behind those numbers reached this branch four days after the
numbers did.** `tools/extract-eval.ts` — the benchmark script
`docs/document-intake-operations.md` cites for the 2026-09-13 run — was part of
Slice B's `tools/` files that a step-list handoff omitted, and it was restored
only in `b4754ed` (2026-09-22,
`docs/test-reports/sprint-6-integration-handoff-2026-09-22.md`). Between those
dates the per-task Codex numbers were on the branch with no way to regenerate
or re-check the evidence behind them.

**Set the effort.** Unset, a nested `claude -p` takes its effort from the
settings in the relay's HOME — on the Mac, a personal `effortLevel: xhigh`, at
which a 4-page PDF's day-by-day plan took 143s against a 60s limit and never
arrived (2026-09-16). Set, the call also ignores personal settings, hooks and
connectors. Since #192, `extract_intake`, `extract_itinerary` and the vision
task inherit `EXTRACT_EFFORT` like their runner and model (before, they looked
up only their own name and ran under the personal settings), and an unset
effort on a claude binding logs `model_runner.claude_effort_unset` at relay
start. The VM takes `medium` from `CLAUDE_CONFIG_DIR` instead (`effortLevel:
medium`, read 2026-09-25) and is unaffected; leaving it implicit there is
deliberate for now, so those warnings appear on every VM boot.

**Unset is not an error, it is a downgrade.** With no flag, new sessions are
created on the agent path — which is a supported path, so nothing warns. With
no runner, `interpret`/`extract` return `NOT_CONFIGURED` and the router simply
does less. Both failures are invisible from the conversation and both were paid
for on 2026-09-09: a stack rebuilt from a shell without the flag put the Hermes
agent back into a live interview, which produced English narration mid-Hebrew
and a turn that opened and never closed.

Two reasons that hurts more than it looks:

- **Hermes cannot reach Claude on this host.** Its profiles ask for
  `provider: anthropic`, get "no Anthropic credentials found" every time, and
  fall down their chain to `openai-codex`, which is metered. Editing a profile's
  model to a `claude-*` id does not fix it. The `claude` CLI *is* authenticated
  here, which is why `*_RUNNER=claude` is the configured path — it needs no key.
  Every model child, Hermes included, now runs with an allow-listed environment
  (#192): the relay's own keys are not forwarded, so a Hermes provider key
  belongs in `~/.hermes/.env`, and proxy variables are not passed either. See
  `docs/document-intake-operations.md`.
- **The two paths write different shapes.** Agentless emits
  `phases[].planned: ["Tokyo Skytree"]`; the agent emits
  `phases[].venues: [{name, time}]`. `transformer.py` handles both now, but a
  shape appearing where you did not expect it is a reliable signal of which
  path actually ran. One exception: agentless may instead leave `planned`
  empty and file a ticketed attraction as a dated `travel_anchors` entry
  (`{type, name, date, confirmation}`) — it chose that on one run in three
  on 2026-09-11. That is the same path, not the agent; both reach the site.

When an interview misbehaves, read `interpret_path` off the session first:

```bash
docker exec kinerary-control-plane-local-postgres-1 psql -U kinerary_control_plane \
  -d kinerary_control_plane -c "SELECT id, interpret_path, language FROM control_plane.intake_sessions ORDER BY created_at DESC LIMIT 3;"
# and: rows in interview_agent_turns mean the agent was in the loop at all.
# An open turn with closed_at NULL means it took the turn and failed silently.
```

### The containers mount a checkout, so the directory decides the branch

`compose.local.yml` bind-mounts `control-plane/api/dist` and the worker package
from the **host**, and `WORKER_REPO_ROOT_HOST` defaults to `/Users/elul/kinerary`.
So `docker compose up` from the wrong directory runs the wrong branch with no
error at all, and `interview-stack-deploy/deploy.sh` does not set that variable
itself. Bring the stack up from the checkout you mean, and pass it explicitly:

```bash
cd <the worktree you mean>
(cd control-plane/api && npm run build)     # the API mount is dist/, not src/
set -a && . ~/kinerary-deploy/provisioning.env && set +a
WORKER_REPO_ROOT_HOST=$PWD BUILDX_CONFIG=~/.docker/buildx-local \
  docker compose -f control-plane/deployment/compose.local.yml up -d --build --wait
KINERARY_REPO=$PWD ~/kinerary-deploy/bring-up.sh   # sidecar from the same tree
```

Verify by reading the running containers rather than trusting the directory —
`scripts/new-trip-run.py`'s preflight does exactly this and refuses to mint an
interview link when a marker is missing.

### The control plane on the Proxmox VM

VM 110 `kinerary-cp` runs the whole stack under Compose, Hermes included —
runbook: `docs/control-plane-vm-deployment.md`. Since 2026-09-13 the VM's relay
owns `@Kinerary_bot` and the Mac's relay runs on `@Tripinterviewer_bot` — swapped,
never shared, because Telegram gives each update to one `getUpdates` loop. The VM
keeps provisioning off outside a test run and `PROVISIONER_VMID_MAP={}`. The
fleet monitor is bootstrapped there by `kinerary-deploy/bootstrap-monitor.sh`,
a thin wrapper over this repo's generic
`scripts/bootstrap-fleet-monitor.sh` — idempotent, part of bringing the VM up,
and it never starts the gateway on its own (one `getUpdates` loop per bot
token, so the Mac's must stop first). On the
VM restart the relay with `control-plane/deployment/vm-relay-restart.sh`, not
`scripts/relay-restart.sh` (that one restarts the Mac's), and point
`scripts/e2e-full-cycle.py` at it with
`KINERARY_COMPOSE_PROJECT` / `KINERARY_RELAY_CONTAINER` / `KINERARY_RELAY_RESTART`
— it refuses `--auto` on a non-Mac stack without them.

Change the VM's version **only** with `sudo kinerary-cp-release upgrade|rollback`
(always `--dry-run` first) — never by hand-editing `KINERARY_REV`. It snapshots
the VM from the Proxmox host (never vzdump, never NFS), dumps the database, and
records the way back; the `trip-monitor` agent can request the same through a
gate only Dror's one-time code approves. Runbook: "Upgrades and rollback" in
`docs/control-plane-vm-deployment.md`.

**Migrations: `docs/migrations.md`, and preflight check B7 enforces it.** Two
rules bite hardest. A new migration is named `YYYYMMDDHHMMSS_description.sql`,
never a hand-allocated number — `0054` existed three ways at once on
2026-09-19, after the repo had already renumbered twice to escape the same
thing. And it must start with `-- rollback: compatible|breaking — <why>`,
because absent is not neutral: `vm-release.py` reads a missing header as
`breaking` and a rollback then *discards the database* instead of keeping it.
Legacy `00xx_` names are grandfathered permanently — the version is the whole
filename, so renaming an applied migration makes production run it again.

### A Mac-provisioned companion that cannot read its own trip

**Staging only — this cannot happen on the production VM.** The Mac is staging;
real trips run on VM 110, and Linux has no equivalent of the gate below.

Symptom: the companion answers normally, in character, and says it cannot
retrieve the trip ("אני לא מצליח לשלוף כרגע את תוכנית הטיול"). Everything that
is usually checked looks healthy — the bridge is listening, `hermes mcp test`
passes, the gateway registered its tools — because all of those verify the hop
between the AGENT and the bridge. The broken hop is the next one:

```
get_config -> connect EHOSTUNREACH 192.168.0.60:8080 - Local (192.168.0.121:53190)
```

Cause: macOS grants **Local Network** access per responsible process. The worker
wires a new trip's bridge over SSH (`companion-install-host.sh` → `setup-mcp.sh`
→ `node mcp.js`), and a process born from an `sshd` session has no such grant.
Loopback is not gated, so the bridge serves MCP perfectly while every call
through it to the trip's LAN address fails. A bridge started by hand from
Terminal inherits the grant and works — which is why older trips were fine and
each newly provisioned one was not.

Fix, from **your own Terminal** (the launching context is the whole point):

```bash
cd ~/kinerary-deploy && ./setup-mcp.sh --restart-only --trip-dir ./trips/<slug>
```

Provisioning now refuses to call such a bridge wired: `companion-install-host.sh`
asks `GET /health` on the bridge — "can you reach your trip", not "are you
listening" — and fails the step when it cannot. That check is platform-neutral
and also catches a VM bridge that did not survive a reboot.

If unattended Mac companion testing is ever needed, move the bridges to a
LaunchAgent (`launchctl bootstrap gui/$UID`) so they inherit the logged-in
user's grant instead of the SSH session's.

### Restarting a live interview for a test run

Testing the Trip Bot router end to end means starting the interview over
repeatedly — four steps across three data stores, in an order that matters.

```bash
export KINERARY_TEST_LOGIN_EMAIL=... KINERARY_TEST_LOGIN_PASSWORD=...
export KINERARY_BOT_TOKEN_FILE=control-plane/deployment/.local-secrets/telegram_creds
scripts/fresh-interview.py --trip <slug|trip_id>          # prompts
scripts/fresh-interview.py --trip <slug|trip_id> --yes    # doesn't
```

It clears the interview session and agent turns, **clears the chat's Hermes
gateway conversation** (skip that and the interviewer resumes an inherited
conversation — that is how the first live run narrated a different family's
trip), resets the trip to `draft`, revokes the previous link, and prints a new
`t.me` deep link.

It **refuses** on a trip with a confirmed intake version, or one past
`intake_in_progress`. Both mean real answers or a live site sit behind it, and
an intake version is immutable by design. There is no `--force`.

Credentials are the organizer's own signup login and are deliberately not
stored in the repo.

### Testing anything that depends on today's date

The trip clock, phase highlighting and "day N of M" all answer "where is this
trip right now?", so they only show their real states when today falls inside
the trip. `scripts/shift-trip-dates.py` moves a trip to where the clock is,
rather than faking the clock:

```bash
python3 scripts/shift-trip-dates.py --slug japan-2025 --days -28   # mid-trip
python3 scripts/shift-trip-dates.py --slug japan-2025 --days -60   # finished
python3 scripts/shift-trip-dates.py --slug japan-2025 --restore    # undo, exactly
python3 scripts/shift-trip-dates.py --slug japan-2025 --status     # am I shifted?
```

**`trips/japan-2025/trip.config.json` is tracked by git**, so a forgotten
restore commits fake dates. Always `--restore` before committing; `--status`
exits non-zero while a trip is shifted. The script refuses outright to shift a
trip that is running right now — that would move a live trip under the people
on it.

## The hard rules are enforced, not just written

Every rule in "Hard Rules" above is now checked by
`scripts/preflight-checks.sh`, which has two callers so no commit path escapes:

- **`.githooks/pre-commit`** — every commit, whoever makes it (Codex, Hermes,
  a plain `git commit`). Enable once per clone: `git config core.hooksPath .githooks`.
- **`.githooks/pre-merge-commit`** — the same checks on the path that skips
  them. `git merge` does **not** run `pre-commit`; git fires this instead. Until
  2026-09-19 only the former existed, so every blocking rule had a hole shaped
  like an integration branch — work is written on a feature branch and arrives
  by merge, and a merge can also carry content committed nowhere else: conflict
  resolution.
- **`.claude/settings.json` hooks** — Claude Code, early enough to steer rather
  than refuse. `git commit` and deploy verbs additionally become a *prompt*
  every time (bar the MVP-phase exemptions above: docs-only work and
  feature-branch commits and pushes), because rules 1 and 2 are about intent
  and no script can check intent. Command classification lives in `scripts/claude-hooks/match-command.py`,
  which strips heredocs and quotes first — matching the bare words "git" and
  "commit" refuses any command that merely *writes documentation about* them.
  Since 2026-09-20 the same prompt covers the routes that create commits
  without the word: `git merge`, `cherry-pick`, `revert`, `rebase`, `am` and
  `gh pr merge` (all classified `none` until then — an integrator agent could
  have landed work on the integration branch unprompted), and `git push`. A
  tool call carrying an `agent_type` — any subagent — is **refused** rather
  than asked, for all of these and for deploy verbs: no agent can commit or
  deploy, so it hands back the change, the verifier report and a proposed
  commit message, and the lead session runs the command after the person
  approves. `merge-tree`, `merge-base`, `--abort` and `gh pr view` stay silent.

```bash
scripts/preflight-checks.sh --staged   # what the commit hook runs
scripts/preflight-checks.sh --all      # audit the whole tree
```

Blocking: binaries (rule 3), writes to `trip/` (rule 4), **code that names this
deployment (rule 6)**, a broken create-trip symlink, a date-shifted trip,
repo↔Hermes-profile drift, a `.project/sprint.json` that disagrees with the
tree (B8), and a Codex agent mirror that differs from its source (B9). Reviewed exceptions live in `.preflight-allow` — an
entry there is a recorded decision with a reason, not a silent exemption.

Rule 6's check is scoped to **code, not prose, and not tests**: a runbook that
names the VM it is a runbook *for* is doing its job, and a fixture using
`192.168.1.10` to prove the canonical guardrail rejects private addresses needs
that literal. Blocking those would make the check mostly exceptions, and a
check that is mostly exceptions teaches people to add one.

Its allow-list carries two kinds of entry and the difference is the point:
**PERMANENT** (the rule genuinely cannot apply — the detector has to contain
the literals it searches for) and **BACKLOG** (the rule applies and the file
has not caught up). The backlog only shrinks. Today it holds the
`control-plane/deployment/` VM scripts — the five `vm-*.sh`, plus
`vm-release.py`, `vm-restore-snapshot.sh` and `build-hermes-image.sh`, which
arrived on main (#84) while this rule was being written here and so are the
first code it never saw — all of which want the same split
`bootstrap-monitor.sh` already got, and the provisioner defaults that point at
this house.

`.agents/hermes-sync.tsv` maps repo content that also lives in a profile.
`install-hermes-skill.sh` cannot express every pairing (it requires a
`SKILL.md` and only manages `skills/travel/`), so profile SOULs are listed
there instead. Profile skills with **no** repo copy are warned about, not
blocked — that is a capture backlog, not a reason nobody can commit.

## Sprint and baseline state — `.project/sprint.json`

Which sprint is active and what its locked scope is, which commit its baseline
is, and whether the sprint or the baseline is **locked** — one machine-readable
file, printed to every session at start (`sessionstart.sh`) and checked on
every commit (preflight B8). Until 2026-09-20 both locks lived in a memory file
and in Dror's head, and a fresh session could not tell whether
`integration/sprint-6` was ready to leave or whether the baseline it was about
to build on was still moving. `.project/README.md` has the full contract.

```bash
scripts/project-state.py show            # the state, for a person
scripts/project-state.py show --json     # the state, for an agent
scripts/project-state.py check           # consistent with the tree? exit 1 says why
```

- **Sprint lock `locked`**: the integration branch is not to be assessed,
  deployed or merged to `main`. **Baseline lock `open`**: the baseline is still
  being prepared and the agent team (`docs/agent-team-plan.md`) does not
  start; `locked`: it is the commit sprint work builds on.
- **Change it only through the script.** The Write hook refuses a hand edit,
  because a hand edit carries no who, when or why:
  ```bash
  scripts/project-state.py lock baseline --by "Dror" --reason "baseline fixes landed and verified"
  scripts/project-state.py unlock sprint --by "Dror" --reason "ready to assess and merge"
  ```
- **What needs an override:** moving the baseline commit while the baseline is
  locked, or changing the sprint while the sprint is locked. Both refuse
  without `--override`, and an override is recorded in `history`. The change is
  then a commit — hard rule 1 makes it a human approval, and the commit prompt
  names every lock, baseline and override change in it.

## Agents and run tooling

Subagents in `.claude/agents/` — none can commit or deploy:

| Agent | For |
|---|---|
| `verifier` | Works out which suites a change touches, runs them, reports real output. Has no Write/Edit on purpose. |
| `pr-steward` | Branch/PR sweep. Deletes only provably-merged branches, only on confirmation. Doc drift moved to `doc-keeper` (2026-09-20). |
| `sprint-scribe` | Marks plan items `— BUILT (date)` and moves ledger rows. Surfaces unowned gaps as decisions. |
| `run-capture` | Raw live-run notes → triaged ledger rows routed to the owning sprint. |
| `boundary-reviewer` | The three invariants under "Security-sensitive paths", with live request/response evidence. |
| `regression-planner` | Costed regression plan for a change set: blast radius on live trips, migration and compatibility breaks, what to batch onto one run and what must be tested alone. Plans; never runs the deploy. |
| `developer` | One briefed task in its own worktree: test first, suites run, `verifier` report attached, handed back ready to commit. Never commits. |
| `integrator` | One merge decision at a time for the integration branch: merge-tree, same-intent check, resolution on a throwaway branch, verifier, carry-forward. Never merges. |
| `doc-keeper` | Every decision gets a home before the commit; drift swept after merges. Proposes CLAUDE.md diffs, never applies them. |
| `consult` | One judgment call for a Sonnet role, answered from the evidence with its reasoning. Read-only: no Bash, no Write, because the first consult with a full tool surface wrote a probe into the live-served worktree and staged it (#135). |

The last three are the agent team of `docs/agent-team-plan.md` (2026-09-20),
which also says which model each role runs and why: Opus for judgment calls,
Sonnet for everyday work, declared per file. Its queue is GitHub issues:
`sprint-N`, `track:N`, `size:S|M|L`, `blocked`, `agent:ready`,
`agent:in-progress`, and a milestone per sprint.

**Roles load once per session, from the checkout it starts in.** A role
absent from that checkout is not spawnable, and a role that changes on disk
afterwards keeps running its old text silently — the dry run's session had
loaded a `pr-steward` that still owned the doc sweep and still had Edit. Start
a team session from a checkout of the integration branch after the roles it
needs are committed there, and restart it after any role changes; the
session-start line prints `roles as of <commit>` so the transcript says which
version loaded. And an `isolation: worktree` spawn branches from wherever
`worktree.baseRef` says — the default `fresh` is `origin/main`, which is where
every dry-run spawn landed; `.claude/settings.json` sets `head` so a spawn
starts on the session's branch. A developer's first act is still to move its
fresh worktree onto the brief's base commit and prove it, and a failed check
blocks rather than becoming a note.

`.codex/agents/*.toml` are **generated** from these files by
`scripts/sync-codex-agents.py`, and preflight B9 blocks a commit while any
mirror differs from its source or is staged without it. Codex works the same
issue queue as Claude does (`docs/agent-team-plan.md`), so the two sides have
to describe the same role — never edit a `.toml` by hand.

`sprint-scribe` and `run-capture` must never record human approval, and must
never guess which sprint owns an item — see the standing instruction at the top
of `docs/signup-test-execution-capture (Manual).md`.

`regression-planner` also runs itself, in CI:
`.github/workflows/regression-assessment.yml` posts an assessment when a PR or
an issue is opened. The agent file is the single source of truth for what the
assessment says — change the analysis there, not in the workflow.

Three things about that workflow are load-bearing, all because **this repo is
public** and anyone can open an issue:

- **Claude never gets a GitHub token.** `gh` collects the PR/issue context into
  `.assessment-context/` in a step *before* the model runs, and a later step —
  with no model in it — posts the comment. An injection in an issue body has
  nothing to post with. The tool allowlist is what makes "no network" true, so
  widening it to a bare `Bash` undoes the containment.
- **`pull_request`, never `pull_request_target`.** A fork PR gets no secrets
  and the job skips. Switching that one word runs untrusted code with a key.
- **An issue is assessed automatically only for OWNER/MEMBER/COLLABORATOR.**
  For anyone else a maintainer applies the `regression-assessment` label, which
  is the opt-in and also the way to re-run one by hand.

**CI has no production access, on purpose** — no SSH key, no database, no
deploy host. So the agent's live-fleet step is not performed there, and the
comment says so rather than implying the fleet came back clean. That half is
still owed locally, and three other entry points exist to collect it:

- **`/regression-plan [branch | PR | "sprint N"]`** — the local run, which reads
  the live fleet and says which trips must be *redeployed* for a fix to reach
  anyone. Plans land in `docs/test-reports/regression-plan-<date>-<topic>.md`.
- **The deploy prompt.** `pretooluse-bash.sh` greps that directory for the
  current commit and says, inside the hard-rule-2 prompt, whether this exact
  HEAD was ever assessed — or whether the only plan is for an earlier commit on
  the branch. It does not block; the deploy is the one moment someone is
  already being asked to look.
- **Promoting a release to `available`** now classifies as a deploy
  (`match-command.py`), because that is the pool `generatePlan()` selects from:
  from then on every trip built or rebuilt runs that tree. `candidate ->
  verified` reaches nobody and stays silent.

`.agents/skills/live-run/` drives the 🤖 steps of `docs/setup-test-plan.md` and
stops at every 🧍, resumable by step. It never deploys and never tears down.

`.agents/skills/trip-fleet-monitor/` is the Hermes monitor that watches the
fleet through a **read-only** MCP (`fleet-mcp.mjs`). Since 2026-09-18 it can
also file an issue — through `issue-mcp.mjs`, a **second server**, because the
first one's stated invariant is that even a bug in it cannot write. The second
one creates issues and does nothing else: no comments, no closing, no pull
requests, and it **never falls back to the `gh` CLI's login**, which on this Mac
can push to everything. Its token is a fine-grained PAT scoped to one repo with
Issues: Read and write, named in `issue-target.json` (real values in
`kinerary-deploy`, never here).

Two things that file gets right and are easy to undo by accident:

- **Every call needs a `fingerprint`.** The monitor runs on a cron, so a stuck
  job is stuck on every tick; an open issue already carrying the fingerprint
  means nothing is filed. Remove that and the tracker fills in an afternoon.
- **`kind` distinguishes a person's report from the monitor's own
  observation**, and a traveller's words go in `quote`, rendered blockquoted
  under a banner saying they are untrusted input. `issue-mcp.mjs --render '…'`
  shows exactly what would be filed, without filing it.

### A companion reports; the monitor decides

A trip companion can file a bug report — `report_bug` on `companion-mcp.ts`,
into `companion_bug_reports` (migration 0054). It reaches the monitor through
`alerts` and `bug_reports` on the fleet MCP, and the monitor decides what is
real, tells the operator, and files the ones that are.

**The companion deliberately cannot file the issue itself.** Its context is full
of text travellers typed, which is where an injection arrives; a token that
writes to the tracker must not sit one crafted message away from a stranger. One
agent holds that token and applies judgement — that separation is the feature.

Three things in this path that look incidental and are not:

- **No tool takes a trip id.** The trip comes from the caller's gateway identity
  through its own open chat bindings, exactly as `set_assistant_names` does.
- **There is no state column on the report**, so the monitor stays read-only
  against the control plane. The open issue is the triage record, keyed by
  fingerprint `companion-report:<report id>`. The migration explains it; read
  that before adding `triaged_at`.
- **Free text is folded to one line inside SQL.** psql delimits rows with
  newlines, so a multi-line quote otherwise becomes extra rows — a forgery
  primitive, not a rendering bug: a traveller could type a line that reads as a
  report against another trip. Found 2026-09-18. Any future fleet-MCP query that
  selects a free-text column must fold it the same way (`foldSql`).

`.agents/skills/organizer-invites/` hands somebody an interview link without
their password: `POST /internal/operator/invitations` creates the trip and
issues the same single-use link their own request would have, and prints a
message to forward in English or Hebrew. The routes are **unmounted unless
`CONTROL_PLANE_OPERATOR_KEY` is set**, and a monitoring agent reaches them only
through a forced-command SSH user (`cpinvite`) that accepts two verbs. It
refuses an address that is mid-interview or mid-build, and there is no password
reset anywhere in the control plane — for organizers, no such route exists.

An invitation bypasses the organizer's **login**, never their **identity**.
`resolveOrCreateEmailAccount` (`password-identity.ts`) is the single answer to
"which user is this address?", and every path goes through it: an operator's
invitation, `POST /v1/signup`, and a Google sign-in whose address Google has
verified. One address is one `user_id`. Do not add a path that mints a user for
an email on its own; that is the bug migration 20260922060001 had to go back and merge.

**Every email account holds a credential from birth.** Signup writes the
password the person chose; an invitation and a Google sign-in write one built
from random bytes nobody keeps (`ensureUnknownPasswordCredential`, which never
overwrites an existing one). An invited organizer is therefore a structurally
normal account whose owner has no password *yet* — they use Telegram or Google
until password recovery ships with the landing page, and that flow will just
replace the hash. The invariant is what stops an account being claimed by
whoever signs up with its address first, so a credential-less account can only
be an older row: signup refuses to adopt one that carries another identity,
because asserting an address is a weaker claim than the auth already on it.

`.agents/skills/interview-stack-deploy/` restarts the four services the Trip
Bot interview needs (control-plane API, interview MCP sidecar, trip-intake
gateway, relay) with the checks a 2026-09-05 live run found missing: it reads
the interview-agent key from `provisioning.env` itself rather than trusting
the calling shell, confirms the key landed **inside** the API container rather
than assuming a restart worked, and — the one that actually matters — extracts
the expected `*_for_chat` tool names straight from `interview-mcp.ts` and
greps the **gateway's own** post-restart log line for each one, so "the agent
can speak" is read off the gateway rather than inferred from an upstream
process being alive. It refuses to restart the relay under a live conversation
(`awaiting = 'machine'`, updated recently) unless told to anyway.

## Working style

Write the test first where it's practical. Prefer fixing something at its
source (schema, shared helper) over a patch at the call site that'll drift.
