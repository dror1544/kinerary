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
cd tests && npm test        # 405 tests / 81 suites as of 2026-09-04 — all pass
scripts/preflight-deploy.sh # every suite at once, plus the hard rules below
```
Run before claiming something works, not after. `preflight-deploy.sh` skips a
suite whose interpreter deps are missing rather than failing it, and says so —
a check that is permanently red is a check nobody reads. It proves the build is
deployable; it does **not** deploy. If you touch a
security-relevant path (anything above, or auth in general), show the actual
request/response proving the thing is hidden or scoped correctly — not a
description of the code.

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

## Working style

Write the test first where it's practical. Prefer fixing something at its
source (schema, shared helper) over a patch at the call site that'll drift.
