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
cd tests && npm test        # 111 tests as of this writing — all should pass before you start
```
Run before claiming something works, not after. If you touch a
security-relevant path (anything above, or auth in general), show the actual
request/response proving the thing is hidden or scoped correctly — not a
description of the code.

## Working style

Write the test first where it's practical. Prefer fixing something at its
source (schema, shared helper) over a patch at the call site that'll drift.
