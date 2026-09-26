---
name: trip-organizer-onboarding
description: Give a real trip organizer a production account and a Telegram interview link, from chat — one tool, one email in, a copy-paste greeting out. Use when the operator asks to onboard someone, invite an organizer, or "create a trip link" for an email address.
---

This wraps `scripts/create-trip-link.py` (via the `create-trip-link` wrapper in
`kinerary-deploy`, which supplies the real host, bot and credential store) in a
single MCP tool, `create_trip_link`. See `create_trip_link_command.md` in
project memory for why the underlying script is a stopgap — it invents and
stores a password for the organizer, and is meant to retire onto
`POST /internal/operator/invitations` once that lands on production.

## The shape

```
Hermes profile ──▶ onboard MCP (stdio, one tool) ──execFile──▶ create-trip-link ──ssh──▶ control-plane API
                          │                                          │
                          └── typed argv only, no shell string       └── real host/bot/store, never in this repo
```

## Why this is its own server, not folded into an existing one

A profile that also runs `trip-fleet-monitor`'s `fleet-mcp.mjs` (read-only by
construction) or `issue-mcp.mjs` (can only file an issue) keeps each write on
its own invariant. This one mints a real account and sends a real message to a
real person — a bigger consequence than either sibling — so it gets its own
process on the same principle: a profile can run with this server switched off
and lose nothing but the ability to onboard.

## Tool

| tool | does |
|---|---|
| `create_trip_link` | runs `create-trip-link <email> [--name] [--lang] [--new-link]`, returns the greeting (stdout) and operator notes (stderr) separately, labelled |

It cannot run `--adopt-password` — that flag migrates a pre-existing account
by reading a password from stdin, and is deliberately unreachable from a
model-driven path. `confirmed: true` is a required argument, and the tool
refuses without it; see the operating rules in the fleet monitor's SOUL
("Onboarding a new organizer") for when an agent may set it.

## Config

`onboarding-target.json` names the path to the `create-trip-link` wrapper.
Copy `onboarding-target.example.json` to `~/kinerary-deploy/onboarding-target.json`
and fill in `command`. Search order (first hit wins), same rule as
`fleet-stacks.json`: `$KINERARY_ONBOARD_CONFIG` (refuses if set but missing),
then `~/kinerary-deploy/onboarding-target.json`, then
`~/.hermes/onboarding-target.json`, then beside this file.

```bash
onboard-mcp.mjs --check                        # config + command resolve; mints nothing
onboard-mcp.mjs --dry-run '{"email":"a@b.com","name":"יואב","lang":"he"}'   # prints the argv; mints nothing
```

## Install

1. Copy this directory into the profile, same as any other skill:
   `scripts/install-hermes-skill.sh trip-organizer-onboarding trip-monitor`
2. Add it to the profile's `mcp_servers` in `config.yaml`:
   ```yaml
   mcp_servers:
     onboard:
       command: /path/to/node
       args:
         - <profile>/skills/travel/trip-organizer-onboarding/onboard-mcp.mjs
       enabled: true
   ```
3. Create `~/kinerary-deploy/onboarding-target.json` from the example above.
4. Restart the profile's gateway so it picks up the new server.
5. Run `--check` before trusting it with a real email.
