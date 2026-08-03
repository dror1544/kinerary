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
| `ANTHROPIC_API_KEY` | No | Only needed for the `/extract` endpoint (AI-powered booking-confirmation extraction from a PDF/URL). |
| `MCP_PORT` | No | Defaults to `3001`. |

### 2. Connect a local agent

Point it at `http://127.0.0.1:3001/sse` (or your LAN IP) with header
`X-API-Key: <MCP_API_KEY>`. Nothing else to configure.

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
