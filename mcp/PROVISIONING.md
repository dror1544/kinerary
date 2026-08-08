# Provisioning MCP server

`provision.js` is the second, privileged MCP server. It exists so an agent can
*create* a trip — the thing `mcp/README.md` says the regular server explicitly
cannot do.

Deployment-neutral. Substitute `<SITE_HOST>` (the machine running the trip site
and this server) and `<REPO_ROOT>` (the absolute path to the checkout on that
machine) throughout.

Keep the two straight, because the difference is a security boundary and not a
filing preference:

| | `mcp.js` | `provision.js` |
|---|---|---|
| Manages | data inside a trip that already exists | trips themselves |
| Can do | photos, bookings, trivia, comments, RSVPs | write files into the repo, run the scaffolder, restart the site |
| Port | `3001` | `3002` |
| Key | `MCP_API_KEY` | `PROVISION_API_KEY` (must differ) |
| Public exposure | fine — this is what Cowork connects to | **never** |

## The one rule

**Do not tunnel, reverse-proxy, port-forward or otherwise publish this
server.** It writes to your filesystem and restarts your containers. It binds
`127.0.0.1` by default; widening that to a LAN address is a deliberate act you
should only take because the agent lives on a different machine on the same
private network.

If the site host already runs a Cloudflare Tunnel or nginx for the trip site,
double-check that its config does not have a catch-all rule that would pick up
port 3002. The server prints a warning on startup if it is bound to `0.0.0.0`,
but it cannot see your proxy config.

## Setup

On the **site host** — the machine holding the repo and running
`docker compose`, not the machine running the agent.

### 1. Generate a key

```bash
openssl rand -hex 32
```

Minimum 32 characters, and it must be different from `MCP_API_KEY`. The server
refuses to start otherwise; both checks are there because reusing the data key
would hand filesystem access to anything that already had read access to your
bookings.

### 2. Configure

Add to the repo's `.env`:

```bash
PROVISION_API_KEY=<the key you just generated>
PROVISION_PORT=3002
# 127.0.0.1 if the agent runs on this same box.
# The host's LAN address if the agent is on another machine — never 0.0.0.0
# unless you have verified nothing is proxying this port.
PROVISION_BIND=<SITE_HOST>
REPO_ROOT=<REPO_ROOT>
# Optional but recommended: lets list_trips report which trip is live, and
# lets get_activation_plan tell the organizer what they're replacing.
ACTIVE_TRIP_DIR=./trips/<currently-live-slug>
```

### 3. Run it

```bash
cd mcp && npm install
node provision.js
```

Expected output:

```
[trip-provision] listening on <SITE_HOST>:3002  →  repo: <REPO_ROOT>
```

For an always-on setup, run it under whatever supervisor the box already uses
(systemd, launchd, pm2). It holds no state between calls except unspent
activation tokens, so restarting it at any time is safe.

### 4. Check it from the agent's machine

```bash
curl -s http://<SITE_HOST>:3002/healthz
# {"ok":true,"service":"trip-provision"}
```

`/healthz` is deliberately unauthenticated so you can prove reachability
without putting the key in your shell history. It reveals nothing but the
service name.

## Tools

| Tool | Writes? | What it does |
|---|---|---|
| `provision_health` | no | Repo root, scaffolder path, trip count. Call first to confirm you're talking to the right machine. |
| `list_trips` | no | Every scaffolded trip: title, participants, phases, trivia count, which one is live. |
| `validate_answers` | no | Pre-flight on a partial answers object mid-interview. Duplicate usernames, families pointing at unknown members, `agent.organizer` not being a participant. |
| `create_trip` | yes | Runs the canonical scaffolder. Writes `trips/<slug>/`. **Does not make the trip live.** |
| `verify_trip` | no | Boots the real server on a throwaway port and temp DB, renders the real site code against it. ~10s. Doesn't touch the running site. |
| `set_trip_logo` | yes | Installs a logo into a trip and points `meta.logo` at it. Path must be absolute and on the site host. |
| `get_activation_plan` | no | Explains what switching the live site would change; returns a one-time token. |
| `activate_trip` | yes | Repoints `TRIP_DIR_HOST` and restarts the container. Requires a fresh token. |

### Why activation is two-step

`activate_trip` causes an outage and switches what the whole family sees. A
single confused tool call should not be able to do that, so the token from
`get_activation_plan` is:

- **single-use** — spent on the first call, valid or not
- **bound to one slug** — a token for `italy-2027` is rejected for `japan-2025`
- **five minutes long** — it expires rather than sitting around

The token is a guard against an agent acting on its own, not a substitute for
asking. The Hermes system prompt requires an explicit yes from the organizer
before `activate_trip` is called at all.

## What it deliberately does not do

- **Delete trips.** Nothing here removes a trip directory. If a scaffold went
  wrong, `create_trip` with `force: true` overwrites it, and removing a trip
  for real is a human with `rm`.
- **Touch the database.** Accounts, photos, comments and trivia scores live in
  SQLite and are *not* per-trip. Switching trips does not switch data — worth
  saying out loud to anyone who expects activation to be a clean slate.
- **Set participant avatars.** `/api/auth/avatar/upload` now accepts an
  agent-supplied `username` override (gated on `req.user.isAgent`, so only
  the API-key path can use it — a participant's own JWT still can't set
  anyone else's), and `mcp/mcp.js` exposes it as `set_participant_avatar`.
  That's a deliberate split, not a limitation of the route: managing a
  trip's own participant data is `mcp.js`'s job (see `mcp/README.md`'s
  trust-level table), not this LAN-only provisioning server's — `provision.js`
  stays scoped to trips themselves, never their day-to-day content.

## Coupling worth knowing about

`create_trip` and `verify_trip` shell out to
`.agents/skills/create-trip/driver.mjs` (falling back to `.claude/`). That file
holds the only implementation of the answers→config contract, and duplicating
it here would drift the first time a field is added. The trade-off is that a
long-running service depends on a file in an agent-skill directory — if you
restructure those, `provision_health` will tell you immediately via
`driver_error`.
