# Testing runbook

Moved out of `CLAUDE.md` on 2026-11-22, text unchanged apart from the two
places marked *(updated 2026-11-22)*. `CLAUDE.md` keeps the rules an agent must
follow and the commands; this file holds the procedures, the incidents behind
them and the diagnosis steps. Where the two disagree, `CLAUDE.md` wins.

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
script whatever its flags, unless the owner's standing approval is set (it is on
the routine list; see "Standing deploy approval"). It refuses uncommitted tracked changes (a deploy has
to be a commit you can name) and a provisioning job that is mid-build.
`--cleanup` removes only the trip whose id this run's signup returned, through
`scripts/teardown-trip.py` — see below. If you touch a
security-relevant path (anything above, or auth in general), show the actual
request/response proving the thing is hidden or scoped correctly — not a
description of the code.

## Tearing down a test trip

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

## Trip containers start on boot

Every trip container is created with `--onboot 1 --startup order=3`, after TrueNAS
(order 1, which serves their NFS mount) and the control-plane VM (order 2). Turn it
off for one trip with `scripts/trip-autostart.py --trip <slug> --off`
(`--on` restores it; no flag shows it).

## The control-plane DB suites destroy the database they are given

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

**A green local run is not a green CI run.** The Mac has `codex` and `claude`
on its PATH; the GitHub runner has neither. On 2026-09-25 #192 made the `/model`
handler refuse an unverifiable Codex, and a test that had always leaned on the
Mac's own `codex` began failing on the runner only. The Control plane workflow
sat red on the leading branch for about 18 hours while #204, #211, #215 and #218
merged on green local suites (#223, fixed by #224). Before a merge decision read
`gh pr checks <n>` and the base branch's last few runs (`gh run list --branch
main --workflow "Control plane" --limit 5` *(updated 2026-11-22: the leading
branch is `main`)*), not the local
result alone: a red base is a finding, not a backdrop, and a green PR on a red
base is not evidence. A test that needs a tool gets a fake of its own
(`CODEX_BIN` and `control-plane/api/test/support/child-env-harness.ts`), and a
`PATH` without the tool — a temp dir holding only a symlink to `node`, plus
`/usr/bin:/bin` — is the cheap way to reproduce CI locally.

## The interview has no agent — and silently grows one back

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

## The containers mount a checkout, so the directory decides the branch

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

## The control plane on the Proxmox VM

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

## A Mac-provisioned companion that cannot read its own trip

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

**Reminder for every staging test run (Dror, 2026-11-12): after a trip is
built on the Mac, its companion is NOT wired until a person wires it from
Terminal.** Until the LaunchAgent move above lands, a staging test that reaches
"the companion uses its trip tools" stops there. On 2026-11-12 the test trip
came out of provisioning with no `mcp_servers` in its profile's `config.yaml` at
all (the health check refused the step, as designed), so the companion
apologised that its tools were unavailable. `--restart-only` does not help in
that state; the full wiring does, followed by a gateway restart:

```bash
cd ~/kinerary-deploy && REPO_ROOT=<staging checkout> ./setup-mcp.sh <profile> \
  http://<trip LAN ip>:8080 https://<public host> --trip-dir ./trips/<slug> \
  --vmid <vmid> --port <bridge port> \
  && launchctl kickstart -k gui/$UID/ai.hermes.gateway-<profile>
```

The values are in `trips/<slug>/topology.yaml`; the profile is
`trips.hermes_profile`. Two more things a Mac staging run needs that nothing
starts for it: the companion-control MCP (`dist/companion-mcp.js` on `:4313`,
the companion's `trip-control` connection — a container on the VM, absent from
`bring-up.sh` on the Mac), and the relay and interview sidecar after the
nightly redeploys staging. A lead session preparing a staging test checks all
three and tells the tester before the run starts, not when the companion fails.
The automatic fix is #541; when it lands, remove this paragraph.

## Restarting a live interview for a test run

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

## Testing anything that depends on today's date

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
