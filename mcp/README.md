# Trip MCP server

Bridges an AI agent to your trip site's API — bookings, RSVPs, ratings,
photos, budget, lost & found, and the trivia game (including host controls
and the growable question bank). See the tool list at the top of
[`mcp.js`](mcp.js) for the exact tools and their arguments.

This is optional. The site works fully without it — it only matters if you
want an agent (not a human clicking around the site) to manage the trip.

## Two ways to connect — same server either way

| | Local always-on agent | Claude Cowork / remote connector |
|---|---|---|
| **What it is** | A Hermes/OpenClaw-style agent running on your own machine or LAN | Claude's hosted agent, connecting to your MCP server as a Custom Connector |
| **Reachability needed** | `http://127.0.0.1:3001/sse` (or your LAN IP) — local network is enough | A **publicly-reachable HTTPS URL** — Cowork's connectors are remote, not local-only |
| **How to expose it** | Nothing extra — same machine or LAN | Put this server behind a tunnel or reverse proxy you already run for the site itself (Cloudflare Tunnel, Tailscale Funnel, etc.), so `/sse` and `/messages` are reachable at `https://your-domain/sse` |

One running instance = one trip (it talks to one `API_BASE_URL`). Run a
separate instance per trip if you want an agent to help across more than one
trip at a time.

## Setup

### 1. Configure and start

```bash
cd mcp
MCP_API_KEY=<agent-to-mcp-key> TRIP_API_KEY=<mcp-to-server-key> API_BASE_URL=http://your-site-host:8080 bash setup-macos.sh
```

Or set these directly in `mcp/.env` (see `.env.example`) and `docker compose up -d --build`.

| Env var | Required | Purpose |
|---|---|---|
| `MCP_API_KEY` | Yes | Key an agent presents (`X-API-Key` header) to connect to *this* server's `/sse`. (`HERMES_API_KEY` still works as a fallback name for older setups.) |
| `TRIP_API_KEY` | Yes | Key this server presents to the trip site's own API — must match a key the site accepts. |
| `API_BASE_URL` | Yes | Where the trip site's Express server actually runs (`http://trip-server:3000` inside Docker Compose, or your LAN host otherwise). |
| `TRIP_PUBLIC_URL` | No | Fallback public URL for reaching the trip site's API, used only if `API_BASE_URL` (usually a Docker-internal host) isn't reachable from wherever this MCP server runs. |
| `HERMES_EXTRACT_PROFILE` | No | Only needed for the `/extract` endpoint (AI-powered booking-confirmation extraction from a PDF/URL) — see below. |
| `HERMES_BIN` | No | Path to the `hermes` CLI binary, if it's not on this server's `PATH`. Defaults to `hermes`. |
| `MCP_PORT` | No | Defaults to `3001`. |

### 2. Connect a local agent

Point it at `http://127.0.0.1:3001/sse` (or your LAN IP) with header
`X-API-Key: <MCP_API_KEY>`. Nothing else to configure.

### Add Booking's "Extract Details with AI" (`POST /extract`)

The trip site's own Add Booking form can upload a confirmation PDF or paste a
URL and have this server pull out the structured fields (`phase`, `type`,
`name`, dates, passengers, confirmation number, PIN, cost, notes). This is a
plain HTTP route, not an MCP tool — it runs a **local, one-shot call to a
real Hermes profile** (via the `hermes` CLI, not the messaging gateway or API
server), so it needs Hermes installed and set up on whatever host runs this
`mcp.js`.

**Use a dedicated profile — never your interviewer or trip-companion
profile.** Those have real tool access (terminal, files, memory, MCP
servers, browser). This route feeds them a stranger's uploaded document; a
crafted "confirmation PDF" containing hidden instructions is a live prompt-
injection vector, and a full-access agent is the wrong thing to expose to
it. Create a throwaway profile with every toolset disabled instead:

```bash
hermes profile create kinerary-extract --no-skills \
  --description "Single-turn document/URL data extraction for Add Booking. No tools, no memory."

hermes -p kinerary-extract tools disable \
  web browser terminal file code_execution vision image_gen bfl tts skills \
  todo memory session_search clarify delegation cronjob computer_use

hermes -p kinerary-extract config set model gpt-5.4-mini
hermes -p kinerary-extract config set model.provider openai-codex   # or whatever provider you already have pooled — see `hermes auth list`
```

Verify `hermes -p kinerary-extract tools list` shows everything disabled
before wiring it up. No API-server, gateway, or new port involved — this
server just shells out to `hermes -p kinerary-extract chat -q "<prompt>" -Q
--safe-mode --reasoning none` per request and reads stdout.

**Trip-aware, without a trip-specific agent.** One shared `kinerary-extract`
profile serves every trip — it doesn't need its own identity per trip to
catch trip-specific issues. Each request's prompt is built fresh from that
trip's own live data: phase date ranges, the participant roster
(`/api/config/roster`), and everything already booked (`/api/bookings`). The
model is asked to add a short `⚠️` line to `notes` for a real, visible
mismatch — a date outside the matched phase, a passenger nobody on the trip
matches — and never to invent doubts for their own sake. A duplicate
confirmation number is checked deterministically in code, not left to the
model's judgment. A response with no `name` at all (seen in practice on an
occasional cold-start call) is treated as a failed extraction, not a
false-success empty form.

To turn it on:

1. Set `HERMES_EXTRACT_PROFILE=kinerary-extract` here in `mcp/.env` (or
   whatever you named the profile above). No API key to generate — the
   profile uses whatever provider credential you already have pooled in
   Hermes (`hermes auth list`).
2. On the trip site itself, set `HERMES_URL` to this server's own reachable
   address (e.g. `http://192.168.1.50:3001`) — see the root `.env.example`.
   The site's existing `HERMES_API_KEY` is reused to authenticate that call;
   nothing new to generate or keep in sync.
3. Restart both the trip server and this server for the env changes to take
   effect.

`/extract`'s auth accepts either `MCP_API_KEY` (an agent calling it directly)
or `TRIP_API_KEY` (the site's own proxy, which only ever holds the key it
already shares with this server) — see `requireSiteOrAgentKey` in `mcp.js`.

### 3. Connect Claude Cowork

1. Get this server reachable over HTTPS first (see the table above — a
   tunnel or reverse proxy in front of `MCP_PORT`).
2. In Claude Cowork: **Settings → Connectors → Add custom connector**.
3. **URL**: `https://your-domain/sse`
4. **Header**: `X-API-Key: <MCP_API_KEY>`
5. Save — Cowork can now call every tool in `mcp.js` (get/add bookings,
   control trivia, add trivia questions, upload confirmations, etc.) as
   part of a conversation, from anywhere, without your computer needing to
   be on.

Multiple concurrent sessions (a local agent and a Cowork connector at the
same time, or several Cowork chats) are supported — each `/sse` connection
gets its own MCP server instance server-side.

## What this does *not* do

Creating a brand-new trip (scaffolding `trip.config.json` from an interview)
needs local filesystem + shell access, which a remote connector doesn't
have. This MCP server is for managing a trip that already exists.

Two things fill that gap, depending on who is doing the interview:

- **You, with a coding agent** — the `/create-trip` Claude Code skill (see the
  top-level [README.md](../README.md)).
- **An agent, over chat** — `provision.js`, a second and deliberately separate
  MCP server that can scaffold, verify and activate trips. It is privileged
  (it writes files and restarts containers), runs on its own port with its own
  key, and must never be exposed publicly the way this one can be. See
  [PROVISIONING.md](PROVISIONING.md), and
  [docs/hermes-interviewer-agent.md](../docs/hermes-interviewer-agent.md) for
  wiring it to a Telegram interviewer agent.
