# Trip MCP server

Bridges an AI agent to your trip site's API — bookings, RSVPs, ratings,
photos, budget, lost & found, and the trivia game (including host controls
and the growable question bank). See the tool list at the top of
[`mcp.js`](mcp.js) for the exact tools and their arguments.

This is optional. The site works fully without it — it only matters if you
want an agent (not a human clicking around the site) to manage the trip.

> **Someone on the trip connecting their own Claude or ChatGPT does not use
> this server.** The trip site serves its own MCP endpoint for that, with a
> normal sign-in — see [Trip connector](#trip-connector-claude-chatgpt)
> below. This server is the companion agent's bridge, and it authenticates
> with the agent key.

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

For a person on the trip, use the [Trip connector](#trip-connector-claude-chatgpt)
instead. Claude's custom connectors take a URL and OAuth; they have no field for
an `X-API-Key` header, so this server can only be reached from one with the key
in the URL (`https://your-domain/sse?key=<MCP_API_KEY>`). That puts the agent
key — which can do everything the companion can — into proxy logs, and gives
the connection no identity of its own. It is a stopgap for an operator, not a
way to hand a trip to an organizer.

Multiple concurrent sessions (a local agent and a remote connector at the
same time) are supported — each `/sse` connection gets its own MCP server
instance server-side.

## Trip connector (Claude, ChatGPT)

The trip site itself serves an MCP endpoint at `<site>/mcp` for **everyone on
the trip**: an organizer's connection can read and change the trip, anyone
else's can only read it. Code: [`server/trip-mcp/`](../server/trip-mcp/).

The site's **More** tab has a "Connect your AI assistant" card:

- **Add to Claude** opens Claude's documented install link
  (`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=…&connectorUrl=…`),
  which pre-fills the "Add custom connector" dialog; the person confirms.
- **Add to ChatGPT** copies the address and opens ChatGPT, with the steps:
  on the web, Settings → Security and login → Developer mode, then **+** to
  create an app with the address, authentication OAuth. ChatGPT has no
  install link, and its phone app cannot create one.
- Then a page on the trip site opens; they sign in with their normal site login
  (password or Google) and approve.

The card also lists connected assistants with **Disconnect**: organizers see
everyone's, anyone else sees their own.

**Turning it on for a trip** — both in that trip's `.env`, then restart:

```
TRIP_MCP_ENABLED=1
PUBLIC_ORIGIN=https://<the trip's public hostname>
```

`PUBLIC_ORIGIN` is required rather than read off the request: behind the tunnel
and proxy the request says `http` and a LAN host. It must be the trip's direct
hostname. Anything arriving through the managed gateway (`/t/<trip>`, marked
by its `x-forwarded-prefix`) is refused: the gateway turns its cookie into an
`Authorization` header, which would let any script on the shared gateway origin
approve a connection. The endpoint also refuses to start on an unset or
built-in development `JWT_SECRET`. The trip's nginx must route
`/mcp`, `/oauth/` and `/.well-known/oauth-` to Express — the provisioning
template does from this change on; a container built before it needs those
three `location` blocks added (copy them from `provisioning/adapters.py`).

**How it is kept safe:**

- The site is its own OAuth 2.1 authorization server: discovery
  (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`),
  dynamic client registration, PKCE (S256 only), refresh-token rotation with
  reuse detection, revocation.
- Registration is open (every MCP client registers itself), so it is bounded
  by storage, not by caller: URIs of at most 2 KB, five per client, unused
  clients dropped after 15 minutes, and at the 200-client cap the oldest unused
  one is evicted rather than the newcomer refused. There is deliberately no
  per-address limit — behind the ingress every caller shares one address, so a
  limit that refuses would let one stranger lock every organizer out. A client may only name an **exact** known callback
  (`https://claude.ai/api/mcp/auth_callback`, the same on `claude.com`,
  `https://chatgpt.com/connector_platform_oauth_redirect`) or a loopback
  address for a local app (Claude Code, MCP Inspector). A refused callback is
  logged; if a provider moves its callback, add the new one to
  `TRIP_MCP_EXTRA_REDIRECT_URIS` (comma-separated exact URLs). An unknown
  client or callback gets an error page, never a redirect.
- The consent decision needs the site session as a Bearer header **and** this
  trip's own `Origin`. The consent page names the app by the host its codes go
  to; the name an app registers with is shown only as a claim.
- A replayed code ends the connection it produced; a refresh ends the access
  token it replaced; only the client a token belongs to can revoke it.
- Anyone on the trip can approve; nobody else can. What a connection may do is
  fixed when it is approved — `trip` (read and write) for an organizer,
  `trip:read` for anyone else, decided by the server from who approved, never
  from the scope the app asked for — and on each call it is the smaller of that
  and the person's current role: an organizer who is demoted drops to read
  only, a member who is promoted stays read only until they approve again, and
  someone removed from the trip loses the connection. A read-only connection is
  never offered a write tool or the organizer briefing.
- Other people reach the assistant as username, name and colour only: the
  connector strips Telegram ids, ages and emails from RSVP and comment rows,
  whatever the underlying route returns.
- Tokens are opaque and stored hashed. An MCP token is not a site session and a
  site session is not an MCP token.
- Tools call the site's own routes **as the organizer** (a two-minute session
  minted per call, over loopback), never with the agent key. Every route's own
  checks apply and every change is recorded under the organizer's name.
- The tool set is narrower than `mcp.js`: no companion-channel tools, no
  password resets, login links or Telegram bindings (`add_participant` drops
  the enrollment token; the organizer sends the link from the site), nothing
  that takes a server file path.
- Nothing is served from raw `trip.config.json`: the trip's name, phases and
  instructions come from `sanitizeConfig()` and only after sign-in. The consent
  page tells the organizer that what the assistant reads, travellers' needs
  included, goes to that assistant's provider.
- The agent key cannot see or disconnect an organizer's assistant.

**What the assistant is told.** The connection carries instructions built from
the trip (its name, phases and organizers, and how to work: read the briefing
first, change the active plan rather than bookings, ask before deleting, never
write organizer-only notes onto the site). The first tool it is told to call,
`get_trip_briefing`, returns the organizer's standing instructions and the
participants' needs with their visibility, the same briefing the companion
reads.

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
