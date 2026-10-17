# Kinerary

*Kin + itinerary.* A private trip command center and family travel companion.
It keeps a group aligned before, during and after a trip — most of all when
plans change.

## What it is

Most trip tools help you build an itinerary. Kinerary helps the group follow it
when reality changes.

- **For the organizer** — the person holding the trip together gets a private
  control plane (sources, corrections, approvals) and keeps control of every
  change.
- **For everyone else** — a simple trip site, and a calm companion in the group
  chat that answers "what are we doing today?" or "what should I bring?" from
  the real plan.
- **Private by default** — the group sees clean answers only. Booking
  references, private notes and personal constraints stay with the organizer.

A trip is one config file, `trips/<slug>/trip.config.json`, rendered by a
shared site and server: itinerary, bookings, live weather, a budget tracker,
photo sharing and an optional trivia game, in Hebrew and English. Organizers
can create a trip through a Telegram interview (the control plane) or locally,
as below.

What it holds to: the organizer keeps control and the group gets simplicity;
reliability beats breadth; privacy by default; integrate with the tools people
already use instead of replacing them.

**Status:** an MVP, run on small family-and-friends trips. New organizers are
approved by hand: signup is approval-gated.

## Setup

Architecture and the full feature list are in [FRAMEWORK.md](FRAMEWORK.md).

### Requirements

- Docker with Compose v2 (`docker compose`) — builds and runs the site.
- Node.js 20 or newer — the trip scaffolding scripts and the tests (CI runs the
  tests on Node 20).
- Optional: [Claude Code](https://claude.com/product/claude-code) for the
  guided path below.

### 1. Create a trip

Either way produces `trips/<slug>/trip.config.json` (plus
`trivia_questions.json`), which is what the site reads.

**With an AI coding assistant (recommended).** Open this repo in Claude Code and
type `/create-trip`, or say *"help me create a trip to Italy for my family."*
It interviews you about the trip, who is coming, each destination and how much
depth you want, then scaffolds the config and checks it against the real server
and render code. See
[.claude/skills/create-trip/SKILL.md](.claude/skills/create-trip/SKILL.md) for
what it runs. Scaffolding needs local filesystem and shell access; once the trip
exists, day-to-day management can be handed to an agent that connects through
[mcp/README.md](mcp/README.md).

**With the CLI wizard.**

```bash
node scripts/new-trip.js
```

Already have a trip planned in Obsidian notes? Import it as a starting skeleton
with either route:

```bash
node scripts/obsidian-to-config.js /path/to/your/vault/trip-folder trips/<slug>
```

Hero images (`hero.photo`, `meta.homePhoto`, `meta.mapPhoto`) must come from a
royalty-free source. The built-in examples use [Unsplash](https://unsplash.com/license),
and the `/create-trip` skill only uses photo URLs it found and confirmed resolve.

### 2. Configure

```bash
cp .env.example .env
```

Compose reads `.env`, so it must exist. Set **`JWT_SECRET`** to a long random
value (for example `openssl rand -hex 32`). If it is unset the server falls back
to a built-in development secret, which is only acceptable for a throwaway
local preview.

For a local preview, also set `SEED_PASSWORD` to any value before the first boot
and log in as any participant (username from `trip.config.json`) with it. Leave
`SEED_PASSWORD` unset for a trip real people will use: each participant then gets
an independent random password, and password login stays unavailable for them
until they sign in another way and set their own (avatar menu → "Change
password").

### 3. Run it

```bash
TRIP_DIR_HOST=./trips/<slug> docker compose up -d --build
# → http://localhost:8081
```

`server/server.js` is API-only; the nginx container serves the site, so run both
through Compose rather than starting the server alone. State lives in
`server/data`. Stop with `docker compose down`. If `TRIP_DIR_HOST` is unset,
Compose falls back to `./trip`, a name this repo reserves — always set it.

To reach the site from outside your own network, put a tunnel or a reverse proxy
with TLS in front of it. It is two containers and a SQLite file, so any host that
runs Docker Compose will do.

### Optional integrations

All are off unless configured; every setting is documented in `.env.example`.

- **Google sign-in** adds "Continue with Google" for an already-seeded account.
  Create an OAuth client ID of type "Web application" in the
  [Google Cloud console](https://console.cloud.google.com/apis/credentials), add
  your site's exact URL under Authorized JavaScript origins, put the client ID in
  `.env` as `GOOGLE_CLIENT_ID`, then run
  `docker compose up -d --force-recreate trip-server` (a plain `restart` does not
  reload `.env`).
- **An agent for bookings and trip questions**, and the connector that lets
  members use their own Claude or ChatGPT: see [mcp/README.md](mcp/README.md).

### Tests

```bash
cd tests && npm install && npm test
```

## Going further

- **The full platform** — the Telegram interview, provisioning, per-trip
  companions and monitoring — is the control plane. How the interview works:
  [docs/interview-without-an-agent.md](docs/interview-without-an-agent.md).
  Running it: [docs/control-plane-vm-deployment.md](docs/control-plane-vm-deployment.md).
  Repository layout and migrations: [control-plane/README.md](control-plane/README.md).
- **Agent-side trip creation** needs a privileged server that must never be
  exposed publicly: [mcp/PROVISIONING.md](mcp/PROVISIONING.md).
- **Working on the project, including with agents**: [CLAUDE.md](CLAUDE.md).

## License

MIT — see [LICENSE](LICENSE).
