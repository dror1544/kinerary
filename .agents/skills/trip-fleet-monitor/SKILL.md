---
name: trip-fleet-monitor
description: Watch a Kinerary fleet — what stage every trip is at, what failed, and how the funnel is doing — through a read-only MCP onto the control plane, with a daily digest and change-driven alerts on Telegram. Use when asked how trips are going, whether anything is stuck or broken, why a trip has no companion, for signup/interview/provisioning statistics, or to point a monitor at another deployment.
---

A monitoring agent for the trip control plane. It answers three questions:
**what stage is everything at**, **what is broken**, and **how are we doing**.

This is a pattern, not a one-off: the agent, the query catalog and the schedules
are fixed, while everything about *where* the deployment lives is configuration.

## The shape

```
Hermes profile ──▶ fleet MCP (stdio, read-only) ──▶ fleet-stacks.json ──▶ a control plane
      │                                                  ▲
      ├── SOUL.md            domain knowledge            │ hosts, containers,
      ├── cron: digest       (no model)                  │ keys, credentials
      └── cron: alerts       (model only on change)      │ live HERE and nowhere else
```

`fleet-mcp.mjs` is a zero-dependency stdio MCP server exposing a fixed query
catalog — eight tools, every SQL statement written in the file — so the agent
cannot phrase a query the file does not already contain. Every connection is
opened read-only via `PGOPTIONS`, so even a bug here cannot write.

It runs from the Hermes profile, not from a checkout: no `node_modules`, no
build step, nothing that breaks when a git worktree is deleted.

## Deployment is configuration

Nothing in the code knows a hostname, container, database user, SSH key or
binary path. Those live in `fleet-stacks.json`; see
[`fleet-stacks.example.json`](fleet-stacks.example.json) for the annotated
schema. Moving the control plane to another host, renaming a container or
adding a staging environment is an edit to that file.

| stack field | meaning |
|---|---|
| `label` | what the agent calls it in every answer |
| `production: true` | this one describes real travellers; never merge its numbers |
| `url` | psql connects directly (managed Postgres, published port) |
| `container` | the database is in a container on this machine |
| `ssh` | …and that machine is reached over SSH first (`target`, `key`, `sudo`, `port`, `options`) |
| `argv` | escape hatch: a literal command line, with `{sep}` and `{pgoptions}` |

Config is searched in this order, first hit wins:

1. `$KINERARY_FLEET_CONFIG` — and if it is **set but missing, the server
   refuses** instead of searching on. A typo there would otherwise make the
   monitor read a different deployment and announce it as production.
2. `<hermes profile>/fleet-stacks.json` — beside the skill, **not inside it**
3. `~/.config/kinerary/fleet-stacks.json`

The "beside, not inside" rule matters: `install-hermes-skill.sh` diffs the skill
directory, so a real deployment's config living inside it would read as drift
forever. Binaries are located on `PATH` with `FLEET_SSH_BIN`, `FLEET_DOCKER_BIN`
and `FLEET_PSQL_BIN` as overrides — necessary because Hermes launches stdio MCP
servers with a filtered environment in which `PATH` may be absent.

What deliberately stays in code is the part that is about Kinerary rather than
about where it runs: the lifecycle stages, the trip classes and the definition
of "broken". A deployment that renames slug prefixes can still override
`trip_class_sql` — **per stack**: an override on one stack never classifies
another's trips. It once did, and a development override that called every trip
scaffolding would have hidden production's alerts.

## Tools

| tool | answers |
|---|---|
| `fleet_overview` | everything at a glance — trips by class and stage, jobs, failed notifications, open interviews, what became of the interview links, unreachable trips, confirmed-but-never-built |
| `list_trips` | trips with stage, reachability, idle time (`filter`: live, active, all, unreachable, ready) |
| `trip_detail` | one trip end to end: its site URL, sessions with document provenance, every interview link and whether it was opened, how the interview's model calls went, jobs with error codes, notifications, Telegram bindings, linked people |
| `failures` | failed jobs, jobs in flight over an hour, failed notifications, unreachable trips in a window — each tagged with trip class |
| `stalled_interviews` | interviews **still open** and idle beyond a threshold, and what they wait on |
| `statistics` | funnel including how many links were opened, completion rate, model success rate inside the interview, build success rate, median interview and build durations |
| `alerts` | **only** what is actionable — and empty output when healthy, which is what makes a silent watchdog possible. Byte-stable while nothing changes: each incident says when it started (UTC), never how long ago, and rows are sorted |
| `stacks` | which stacks exist, which is production, where config came from, the schema version each has applied, live connectivity |

`tests/scripts/test_fleet_mcp.py` runs the whole catalogue against a stand-in
psql and asserts the properties that are easy to lose in an edit: no tool takes
SQL, no query reads a document's text or the column holding the site password,
alerts select nothing derived from `now()`, and every live-interview query
excludes the sessions that have already closed.

Every tool also runs from a shell, which is how the schedules avoid paying for a
model: `fleet-mcp.mjs --tool alerts [--stack <name>]`. Same handler the agent
calls, so a digest and the agent's own answer cannot drift apart.

## Install

```bash
hermes profile create <profile> --no-skills
scripts/install-hermes-skill.sh trip-fleet-monitor <profile>

# 1. describe the deployment
cp .agents/skills/trip-fleet-monitor/fleet-stacks.example.json \
   ~/.hermes/profiles/<profile>/fleet-stacks.json && $EDITOR $_

# 2. register the MCP
hermes --profile <profile> mcp add fleet --command "$(command -v node)" \
  --args ~/.hermes/profiles/<profile>/skills/travel/trip-fleet-monitor/fleet-mcp.mjs
hermes --profile <profile> mcp test fleet     # lists the eight tools

# 3. schedules (scripts MUST live in the profile's scripts dir)
mkdir -p ~/.hermes/profiles/<profile>/scripts
cp .agents/skills/trip-fleet-monitor/cron/*.sh ~/.hermes/profiles/<profile>/scripts/
hermes --profile <profile> cron create '0 9 * * *' --name fleet-digest \
  --script kinerary_fleet_digest.sh --no-agent --deliver telegram:<chat_id>
hermes --profile <profile> cron create 'every 30m' "<what to say when it changes>" \
  --name fleet-alerts --monitor-script kinerary_fleet_alerts.sh --deliver telegram:<chat_id>
```

The profile's `SOUL.md` is paired to this directory in `.agents/hermes-sync.tsv`,
so preflight blocks a commit while the two differ.

## Four traps, each of which fails silently

- **Cron scripts resolve against the PROFILE's scripts directory** —
  `~/.hermes/profiles/<profile>/scripts/`, not the global `~/.hermes/scripts/`.
  A job created against the global path is accepted without complaint and fails
  at run time with `Script not found`, which for a 09:00 digest means finding
  out the next morning, from silence.
- **The profile `.env` needs two lines, not one.** `TELEGRAM_BOT_TOKEN` lets the
  bot send; `TELEGRAM_ALLOWED_USERS=<chat_id>` lets a human be *heard*. Without
  the second, the gateway comes up connected, polling and with tools registered
  — and silently denies every incoming message as an unknown sender. It says so
  once, as a warning in `logs/errors.log`. Outgoing reports work regardless, so
  it only surfaces the first time someone asks the bot a question.
- **One poller per bot token.** Telegram gives each update to exactly one
  `getUpdates` loop, so a gateway must never be started on a token another
  process owns — the interview relays' bots above all, where a second poller
  swallows a real organizer's messages mid-interview. Prefer a bot nobody polls.
- **`'30m'` is not a schedule, it is a delay.** Hermes reads it as "once in 30
  minutes"; recurrence needs `'every 30m'`. The one-shot version looks identical
  in `cron list` until it never fires again.

## Why classification is the core of it

A control plane that has been tested against is mostly test history:
`retired-*` teardowns and `draft-sreq-*` signups that were never built far
outnumber real trips, and nearly every failed notification belongs to a retired
trip. A monitor that counts rows without classifying them reports a fleet on
fire, forever. The class lives in one SQL expression that every tool shares.

`prospect` is deliberately **not** noise. Those are real people, and the stage
separates the harmless from the broken: `draft` is someone who has not started,
but `intake_confirmed` with no build job means a person answered every question
and nothing built their trip — a state that can sit unnoticed for days.
Naming that class carelessly is not cosmetic: the first version called it
`unnamed_draft`, "signups that never reached an interview", which would have
taught the agent to ignore the one state most worth reporting.

## A failed query must never look like an empty one

This is the most dangerous property of the whole design, and it was wrong in the
first version. **psql exits 0 after a failing statement** unless
`ON_ERROR_STOP` is set; stdout is simply empty. `runSql` checked only the exit
code, so a query that crashed rendered as "(none)".

The first real report the monitor sent about a live customer trip said it had
**no Telegram bindings at all** — neither the organizer's chat nor the family
group. In fact both were open; the query had died on a type error. The same
error had silently disabled the `alerts` check for "built without an organizer
chat" from the day it was written, so the check that exists to catch that
failure could never have fired.

Now every connection runs with `-v ON_ERROR_STOP=1`, and `runSql` additionally
rejects anything with `ERROR:` on stderr — for a stack that supplies its own
`argv`. A broken query reports `Tool failed`; "(none)" only ever means the query
ran and found nothing. After changing any query, run every tool against every
stack: a query that used to fail quietly now fails the tool.

The same rule holds one level up. The daily digest once ran `alerts` with
`|| true` and printed "Nothing needs attention" when the check had failed. Now a
section that cannot be read says so, the rest of the digest still runs, and the
script exits non-zero — which Hermes delivers as a failed watchdog with the
digest attached. Empty alerts mean healthy only when the check succeeded.

## Watchdog output must not change unless the fleet did

Hermes runs `kinerary_fleet_alerts.sh` as a monitor script and compares a hash
of its exact output bytes: unchanged output suppresses the model run, any change
wakes it. So `alerts` never prints a value computed from `now()` — an elapsed
"idle 7h" re-ran the model every hour for one unchanged stalled interview, and
"waiting 5d" every day for a stuck trip — and every alerts query has an
`ORDER BY`. Durations belong in `stalled_interviews` and `trip_detail`, which
nothing hashes.

## What the tools never return

Traveller and organizer **names**, and raw Telegram **chat ids**. The SOUL
forbids repeating names, but a rule in a prompt is not a boundary: that same
first report named the organizer, because `trip_detail` handed the name over.
People are now reported as roles and counts. What the tool never returns, the
agent cannot leak.

## What the monitor can see of a trip's life, and what it deliberately cannot

The database records a trip's **lifecycle** in detail and its **use** barely at
all, and the difference decides which questions this tool can answer:

- **The site's address** is not a column on `trips`. It is in `jobs.result` on
  the build that succeeded, which is also where the portal reads it. The same
  URL sits in `trips.companion_intro` — beside the site's shared login password
  in plain text, which is why nothing here reads that column.
- **An uploaded document** shows up as provenance only: one per session (a later
  upload overwrites the earlier one, and a batch keeps only the first filename),
  reported as extension, size and time. A filename can carry a family's name, so
  only the extension is returned, never the name and never the text. Files that
  could not be read leave no row at all — only a log line.
- **Interview links** say which of two silences a `draft` trip is in: a link
  nobody opened, or no link at all.
- **Model failures inside the interview** are visible only in
  `interview_interpretations.failure_reason`. The organizer never sees an error
  — the router quietly asks its own question instead — so a run of these is
  invisible in the conversation and in every other table.
- **What anyone does on the built site** is not here. Plan edits, logins and
  companion chat all live in each trip's own database and in Hermes, and none of
  it is reported back. "The site is up" is the last thing this monitor knows.

## Schema facts that produced wrong answers

- **Chat ids are TEXT** — `telegram_chat_bindings.chat_id`,
  `messaging_bindings.chat_ref`, `telegram_interview_bindings.chat_id`,
  `interview_agent_turns.chat_id`. `chat_id < 0` is a type error; a group is
  `chat_id LIKE '-%'`.
- **A closed interview still says `state = 'interviewing'`.** Closing a
  conversation for idleness sets `expired_at` and touches nothing else
  (migration 0049), so state alone reports conversations that ended days ago as
  live. On production this filled `stalled_interviews` with six finished
  sessions — one of them a real prospect's — and it is exactly the kind of row
  `alerts` would have repeated forever. Every query about a live interview
  therefore carries `expired_at IS NULL`, the same definition `resolveChatRoute`
  uses.
- **`completed` is not a job state.** The seven are queued, leased, running,
  waiting, succeeded, failed, cancelled. `failures` excluded 'completed', which
  excluded nothing, so every queued or running build was listed as failed or
  stuck. It now names failed and cancelled outright, plus anything in flight for
  more than an hour.
- **Nothing writes `job_steps`.** An empty "unfinished job steps" is the absence
  of a record, not a clean build, and the section says so.
- **A confirmed session keeps `phase = recap` and `awaiting = machine`
  forever.** Every confirmed session reads that way. It is what
  a finished interview looks like; the monitor once reported it as "a summary
  the system has owed the organizer for 16 hours". `awaiting` means something
  only while `state = 'interviewing'`.
- **`jobs.updated_at` is not the completion time.** It marks the claim, landing
  2–8 seconds after `created_at`, while `last_heartbeat_at` sits minutes later.
  Measuring build duration from `updated_at` reports every build as 0 minutes.
  `job_steps` may be empty, so it is no help either.
- **`funnel_events` may be empty**, so funnel statistics come from the
  timestamps on trips, sessions and jobs.
