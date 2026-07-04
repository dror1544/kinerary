# Kinerary

*Kin + itinerary.* A private, collaborative trip website for families and
friend groups — itinerary, bookings, live weather, a budget tracker, photo
sharing, and an optional multiplayer trivia game. One JSON file per trip;
no code changes needed to plan your own.

See [FRAMEWORK.md](FRAMEWORK.md) for the full architecture and feature list.
This file is the quick-start.

---

## Quick start

There are two ways to create a trip. Both produce the same thing: a
`trips/<your-slug>/trip.config.json` the site reads from.

### Option A — with an AI coding assistant (recommended)

If you have [Claude Code](https://claude.com/product/claude-code) (or
another agent that can run this repo's Claude Code skills), open this
repo and either type `/create-trip` or just say something like *"help me
create a trip to Italy for my family."* It'll interview you — trip
basics, who's coming, each destination, and how much depth you want (a
lean logistics-only trip vs. the full trivia/RSVP/budget experience) —
then scaffold and self-verify the config against the real server and
render code before handing it back to you. See
[.claude/skills/create-trip/SKILL.md](.claude/skills/create-trip/SKILL.md)
for exactly how it works, including the actual commands it runs.

You don't need to know JSON, or even open a code editor, for this path —
the conversation *is* the interface. The assistant looks up map
coordinates, finds and verifies royalty-free hero photos, and fills in
sensible defaults for anything you skip.

This step — scaffolding a brand-new trip — needs local filesystem and shell
access, so it's a **Claude Code** (or another local coding agent) job. Once
the trip exists, day-to-day management (add a booking, answer "where are we
eating tonight", control the trivia game) can be handed to **Claude Cowork**
instead, including from your phone with your computer off — see
[mcp/README.md](mcp/README.md) for connecting it as a custom connector.

### Option B — manual CLI wizard

No AI assistant needed:
```bash
node scripts/new-trip.js
# Prompts for trip name, participants, families, phases (dates, accommodation, hero image)
# → trips/<slug>/trip.config.json + trips/<slug>/trivia_questions.json
```

Already have a trip planned in Obsidian notes? Import it as a starting
skeleton instead of starting blank (works with either option above):
```bash
node scripts/obsidian-to-config.js /path/to/your/vault/trip-folder trips/<slug>
```

### Preview it

`server/server.js` is API-only — it doesn't serve the site's HTML/CSS/JS
itself, so run it behind the nginx container (which does), not standalone:
```bash
TRIP_DIR_HOST=./trips/<slug> docker compose up -d --build
# → http://localhost:8081 (see docker-compose.override.yml for the port)
```

**Logging in:** every participant is seeded with the same default password,
**`1234`** — log in as any of them (username from `trip.config.json`) to look
around. Change it from the avatar screen (click your avatar in the side
menu → "🔑 Change password") before this trip is ever actually shared with
real people; the seeded password is meant to get you in the door once, not
to stay in place.

### Connecting Google Sign-In (optional)

Password login always works — this just adds "Continue with Google" as an
extra option, bound to an already-seeded account (never a way to self-register).

1. Go to the [Google Cloud Console credentials page](https://console.cloud.google.com/apis/credentials)
   and create an OAuth client ID, type **"Web application"**.
2. Under **Authorized JavaScript origins**, add the exact URL your site runs
   at (e.g. `http://localhost:8081` for local testing, or your real domain
   once deployed).
3. Copy the client ID (looks like `xxxx.apps.googleusercontent.com`) — this
   is a public identifier, not a secret, but it still belongs in `.env`, not
   committed to git.
4. Add to `.env`: `GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com`
5. Restart the server container so it picks up the new env var:
   `docker compose up -d --force-recreate trip-server`
   (a plain `restart` does *not* reload `.env` — it needs to recreate the container)

Without a Client ID, the Google button simply doesn't render — nothing else
changes. The `/create-trip` interview can walk you through this same setup
when scaffolding a new trip; see [FRAMEWORK.md](FRAMEWORK.md) for the full
technical details (schema, endpoints, security model).

---

## Hosting options

The app is two containers (nginx + Node/Express, see `docker-compose.yml`)
plus a SQLite file — there's no managed database to provision. Pick based
on how much you want to manage vs. how reachable it needs to be:

| Option | Effort | Reachable by | Notes |
|---|---|---|---|
| **Local only** | None | Just you, on your machine | `docker compose up -d`, `http://localhost:8080`. Good for trying it out; your family can't reach it. |
| **Home server / NAS / Raspberry Pi** | Low–medium | Your family, from anywhere | Same `docker compose up -d`, plus a tunnel (Cloudflare Tunnel, Tailscale Funnel) so you don't have to open firewall ports or manage a public IP. |
| **A small VPS** | Medium | Anyone with the URL | Any $5–6/mo box (Hetzner, DigitalOcean, Linode) running Docker Compose, with a domain and TLS in front (Caddy, or Cloudflare). Most reliable for a trip your whole family relies on. |
| **PaaS (Railway, Fly.io, Render, etc.)** | Low | Anyone with the URL | Least ops if you don't want to manage a server at all — worth checking each provider's current multi-container support before committing, since this hasn't been tested against a specific one here. |

Whichever you pick, set `TRIP_DIR_HOST` (or edit `docker-compose.yml`
directly) to point at your trip's folder — see `FRAMEWORK.md`'s
Infrastructure section for the exact Compose block.

If you want an AI agent (Claude Cowork, a local agent like Hermes/OpenClaw,
or your own) to help manage bookings and answer trip questions on your
behalf, it talks to the site through `mcp/` — see
[mcp/README.md](mcp/README.md) for local-agent vs. Cowork/remote-connector
setup, including the exact steps to add it as a Cowork custom connector.

---

## Photos

Hero images (`hero.photo`, `meta.homePhoto`, `meta.mapPhoto`) should come
from a royalty-free source — [Unsplash](https://unsplash.com/license) is
what the built-in examples use: free for commercial and non-commercial
use, no permission or attribution required. The `/create-trip` skill
enforces this — it never invents a photo URL from memory, only ones it
found via search and confirmed actually resolve (see
[INTERVIEW.md](.claude/skills/create-trip/INTERVIEW.md)'s hard rule on
this). If you source images yourself, keep them royalty-free too — this
project ships as open source and its example trips' images need to stay
freely redistributable.

---

## License

MIT — see [LICENSE](LICENSE).
