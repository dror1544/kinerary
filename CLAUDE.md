# CLAUDE.md

This file provides guidance to Claude Code when working with code in this
repository. `AGENTS.md` points other agents (Codex, etc.) back here — this is
the one place the rules live, not two files kept in sync by hand.

## Hard Rules — Always Enforced

> These override any default behavior. No exceptions.

1. **Never `git commit` without explicit user approval.** Finish the change,
   summarize what's ready, then wait for "commit", "go ahead", or equivalent.
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

## What this repo is

A config-driven, multi-trip family/friend-group travel site — one shared
site/server, many `trips/<slug>/trip.config.json` directories. Full
architecture, feature inventory, and DB schema: `FRAMEWORK.md`. Quick-start
and hosting options: `README.md`. Don't duplicate either here — if something
here starts drifting from those, fix it there and link, not copy.

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
  case-by-case as harmless — don't reintroduce that pattern.
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
provisioner), the chat bindings and slug (`retired-<slug>-<yyyymmdd>`, which
frees the name), the deploy directory, and the profile. **Order matters in one
place**: the allowlist entry goes, and the interviewer restarts, *before* the
profile is deleted — the interviewer runs a cron ticker per allowlisted profile,
and on 2026-09-11 that ticker recreated a deleted profile's directory, which is
enough to make the next trip of that name install without a companion.

It refuses a trip past `ready_private` (real people have used it) and a profile
another trip's open binding still names. There is no `--force`.

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

### The interview has no agent — and silently grows one back

The interview is a **deterministic router calling bounded LLM functions**, not
an agent (`docs/interview-without-an-agent.md`). Per session that is
`intake_sessions.interpret_path`, set at creation from `INTERPRET_PATH_DEFAULT`.

These live in `~/kinerary-deploy/provisioning.env` and must reach the **relay
process**, which is where the interview's model calls are made:

```
INTERPRET_PATH_DEFAULT=1
INTERPRET_RUNNER=claude   INTERPRET_MODEL=claude-sonnet-5
EXTRACT_RUNNER=claude     EXTRACT_MODEL=claude-sonnet-5
```

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
runbook: `docs/control-plane-vm-deployment.md`. While the Mac stack is live it
runs on `@Tripinterviewer_bot`, never `@Kinerary_bot`, with provisioning off and
`PROVISIONER_VMID_MAP={}`. On the VM restart the relay with
`control-plane/deployment/vm-relay-restart.sh`, not `scripts/relay-restart.sh`
(that one restarts the Mac's), and point `scripts/e2e-full-cycle.py` at it with
`KINERARY_COMPOSE_PROJECT` / `KINERARY_RELAY_CONTAINER` / `KINERARY_RELAY_RESTART`
— it refuses `--auto` on a non-Mac stack without them.

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
- **`.claude/settings.json` hooks** — Claude Code, early enough to steer rather
  than refuse. `git commit` and deploy verbs additionally become a *prompt*
  every time, because rules 1 and 2 are about intent and no script can check
  intent. Command classification lives in `scripts/claude-hooks/match-command.py`,
  which strips heredocs and quotes first — matching the bare words "git" and
  "commit" refuses any command that merely *writes documentation about* them.

```bash
scripts/preflight-checks.sh --staged   # what the commit hook runs
scripts/preflight-checks.sh --all      # audit the whole tree
```

Blocking: binaries (rule 3), writes to `trip/` (rule 4), a broken create-trip
symlink, a date-shifted trip, and repo↔Hermes-profile drift. Reviewed
exceptions live in `.preflight-allow` — an entry there is a recorded decision
with a reason, not a silent exemption.

`.agents/hermes-sync.tsv` maps repo content that also lives in a profile.
`install-hermes-skill.sh` cannot express every pairing (it requires a
`SKILL.md` and only manages `skills/travel/`), so profile SOULs are listed
there instead. Profile skills with **no** repo copy are warned about, not
blocked — that is a capture backlog, not a reason nobody can commit.

## Agents and run tooling

Subagents in `.claude/agents/` — none can commit or deploy:

| Agent | For |
|---|---|
| `verifier` | Works out which suites a change touches, runs them, reports real output. Has no Write/Edit on purpose. |
| `pr-steward` | Branch/PR sweep and doc drift. Deletes only provably-merged branches, only on confirmation. |
| `sprint-scribe` | Marks plan items `— BUILT (date)` and moves ledger rows. Surfaces unowned gaps as decisions. |
| `run-capture` | Raw live-run notes → triaged ledger rows routed to the owning sprint. |
| `boundary-reviewer` | The three invariants under "Security-sensitive paths", with live request/response evidence. |

`sprint-scribe` and `run-capture` must never record human approval, and must
never guess which sprint owns an item — see the standing instruction at the top
of `docs/signup-test-execution-capture (Manual).md`.

`.agents/skills/live-run/` drives the 🤖 steps of `docs/setup-test-plan.md` and
stops at every 🧍, resumable by step. It never deploys and never tears down.

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
