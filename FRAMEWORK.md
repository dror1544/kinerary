# Kinerary — Framework Guide

*Kin + itinerary.* A production-grade collaborative web app for multi-family group travel. Originally built for a large multi-family, multi-week trip — generalized so any family or friend group can replicate it for their own trip.

---

## The Concept

Most families plan trips in a WhatsApp group. This replaces that chaos with a private, beautifully designed website that every family member can use — to check the itinerary, vote on activities, upload memories, play trivia, split the budget, and see live weather at each destination.

**Who it's for:** A trip organizer who can set up Docker and edit JSON. Participants need only a phone or browser — no installs, no accounts to create (organizer seeds all users).

**Scale:** Designed for 2–30 people across 1–6 trip phases, with 11 DB tables and 24 features under the hood — scales down just as well to a 2-person trip (see `trips/japan-2025/`) as up to a large multi-family group.

---

## Feature Inventory

| # | Feature | What it does |
|---|---|---|
| 1 | **Auth / Login** | JWT login with avatar selection; 30-day tokens; bcrypt passwords |
| 2 | **Bilingual (he/en RTL)** | Full Hebrew ↔ English toggle; auto-detects browser locale; all text bilingual |
| 3 | **Hero banner** | Dynamic hero image + headline per tab; animated tab transitions |
| 4 | **Trip clock** | Counts down to departure; mid-trip flips to the active phase + trip day, clicking through to that phase |
| 5 | **Interactive map** | Leaflet.js map with all destinations, route line, bilingual popups |
| 6 | **Live weather** | 7-day forecast per destination via Open Meteo API (free, no auth) |
| 7 | **Points of Interest** | Expandable venue cards with Maps/Waze/ticket links, per phase |
| 8 | **Task management** | Pre-trip checklist with deadline badges; server-backed completion state |
| 9 | **Venue ratings** | 5-star ratings per attraction with per-user chips |
| 10 | **Venue comments** | Comment threads on any attraction |
| 11 | **RSVP activities** | Sign up yes/no/maybe for optional activities; live response chips. Cards come from `phases[].rsvp_activities[]` — hand-authored, or derived for a control-plane-provisioned trip from its unconfirmed attractions (see "What to fill in after scaffolding") |
| 12 | **Photo gallery** | Drag-drop upload with progress; per-phase galleries |
| 13 | **Immich sync** | Optional: auto-sync photos to self-hosted Immich; share links per phase |
| 14 | **Photo reactions** | 5 emoji reactions on photos with toggle & counts |
| 15 | **Photo comments** | Thread comments on any uploaded photo |
| 16 | **Packing lists** | Per-phase checklists with localStorage persistence. A general list (`packing_general`, else a built-in 4-item fallback) plus each phase's `packing[]` — hand-authored, or derived per phase for a control-plane-provisioned trip (see "What to fill in after scaffolding") |
| 17 | **Budget tracker** | Multi-phase expense breakdown; estimate vs. actual; per-person totals |
| 18 | **Trivia game** | Real-time multiplayer family trivia via SSE; admin control; leaderboard |
| 19 | **Booking confirmations** | All reservations with copy-to-clipboard conf codes; inline PDF viewer |
| 20 | **Lost & found** | Guest-accessible report form + admin resolution tracker |
| 21 | **Avatar upload** | CropperJS-powered avatar edit; multiple variants per user |
| 22 | **Side menu** | Responsive off-canvas navigation (burger menu) |
| 23 | **PWA** | Installable on iPhone/Android home screen |
| 24 | **Config-driven** | All trip data in `trip.config.json`; served via `/api/config`; no code changes needed for a new trip |
| 25 | **Country info** | Emergency numbers, currency, calling code per destination country — auto-fetched live via `scripts/country-info.js`, not hardcoded |
| 26 | **Agent integration (MCP)** | Standalone MCP server (`mcp/`) giving an agent read/write access to a trip's bookings, photos, tasks, ratings, and comments — local agent or remote connector (e.g. Claude Cowork); see [Agent Integration (MCP)](#agent-integration-mcp) |

---

## Architecture

```
Browser
  ↓ HTTP (port 8080)
nginx (Alpine Docker)
  ↓ /api/*        ↓ /*
Node.js Server   Static Files
(Express, :3000) (site/, bind-mount)
  ↓                ↓
SQLite (WAL)    index.html / app.js
  ↓                ↓
Immich API      translations.js
(optional)      trip.config.json (via /api/config)
```

### File Layout

```
site/
  index.html          — SPA shell: login overlay, tab nav, section containers
  app.js              — All client logic: render fns, event handlers, API calls
  translations.js     — Bilingual string table T.he / T.en
  manifest.json       — PWA manifest
server/
  server.js           — Express routes, SQLite schema, SSE, Immich, auth middleware
  trivia_questions.json — Question bank (40 Q&A per trip)
  data/trip.db        — SQLite database (not in git)
trip/
  trip.config.json    — Single source of truth (see below)
scripts/
  new-trip.js         — Interactive CLI to scaffold a new trip config
  obsidian-to-config.js — Obsidian markdown vault → skeleton config
docker-compose.yml    — nginx + node services; TRIP_DIR env for config path
nginx.conf            — Reverse proxy, SSE buffering, file upload limits
```

---

## Config-Driven Architecture

Everything trip-specific lives in **`trip/trip.config.json`**. The framework code never stores trip data.

```json
{
  "meta": {
    "title": "Trip Name",
    "brand": "RIVERA",
    "logo": "https://cdn.example.com/rivera-trip-mark.png",
    "logoAlt": "Rivera family trip",
    "defaultLang": "he",
    "departure": "2027-03-10T06:00:00+03:00",
    "returnDate": "2027-03-24",
    "totalDays": 15,
    "homeCurrency": "ILS"
  },
  "participants": [
    { "username": "alex", "name": "אלכס", "name_en": "Alex",
      "age": 52, "family": "rivera", "color": "#3B82F6", "pin": "1234" }
  ],
  "families": [
    { "id": "rivera", "letter": "A", "name": { "he": "משפחת ריברה", "en": "Rivera Family" },
      "members": ["alex", "sam", "noa"] }
  ],
  "phases": [{
    "id": "ny", "tabLabel": "NEW YORK",
    "dates": { "start": "2027-03-11", "end": "2027-03-14" },
    "hero": { "photo": "https://unsplash.com/...", "label": { "he": "ניו יורק", "en": "New York" } },
    "accommodation": { "name": "Example Hotel", "confirmation": "ABC-123456", "weatherKey": "nyc" },
    "mapStop": { "lat": 40.7128, "lng": -74.006 },
    "venues": [{ "id": "ny-tms", "name": "Times Square", "url": "..." }],
    "rsvp_activities": [{ "id": "ny-show", "title": { "he": "...", "en": "Broadway show" }, "date": "2027-03-12" }],
    "packing": [[{ "he": "ביגוד", "en": "Clothing" }, { "he": "מעיל חם", "en": "Warm jacket" }]]
  }],
  "map": { "center": [38, -98], "zoom": 4, "stops": [] },
  "tasks": [],
  "bookings": { "flights": [], "hotels": [] },
  "budget": { "party_size": 7, "phases": [], "seed_items": [] },
  "trivia": { "total_questions": 40, "participants": ["alex", ...] }
}
```

**What moves to config vs. what stays in code:**

| Trip-specific (→ config) | Framework (stays in code) |
|---|---|
| Participants, families, PINs | Auth/JWT logic |
| Phase dates, heroes, accommodation | Render functions |
| Map stops, weather keys | SQLite schema |
| Venues, POIs, RSVP activities | API route handlers |
| Budget seed items | i18n machinery |
| Trivia participants, question count | SSE trivia engine |

---

## Bilingual / RTL Pattern

### Adding a new UI string

**1. Add to `site/translations.js`:**
```javascript
// T.he
my_feature_title: 'כותרת הפיצ\'ר',
my_feature_empty: 'אין פריטים',

// T.en
my_feature_title: 'Feature Title',
my_feature_empty: 'Nothing here yet',
```

**2. Use in JavaScript:**
```javascript
element.textContent = T[currentLang].my_feature_title;
```

**3. Use in HTML (auto-updates on language switch):**
```html
<span data-i18n="my_feature_title"></span>
```

**4. For bilingual data from config** (names, labels, descriptions):
```javascript
// Config objects use { he: '...', en: '...' } shape
const label = obj.name?.[currentLang] || obj.name?.he || obj.name;
```

---

## Adding a New Feature (Step-by-Step)

### 1. DB Table
In `server/server.js`, inside the `db.exec()` block at startup:
```sql
CREATE TABLE IF NOT EXISTS my_feature (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  content TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 2. Server Route
```javascript
app.get('/api/my-feature', authRequired, (req, res) => {
  res.json(db.prepare('SELECT * FROM my_feature').all());
});

app.post('/api/my-feature', authRequired, (req, res) => {
  const { content } = req.body;
  const info = db.prepare('INSERT INTO my_feature (username, content) VALUES (?, ?)').run(req.user.username, content);
  res.json({ id: info.lastInsertRowid });
});
```

### 3. JS Render Function (site/app.js)
```javascript
async function renderMyFeature() {
  const el = document.getElementById('my-feature-container');
  const token = localStorage.getItem('trip-token');
  const data = await fetch('/api/my-feature', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  el.innerHTML = data.length
    ? data.map(d => `<div class="card">${d.content}</div>`).join('')
    : `<p class="empty">${T[currentLang].my_feature_empty}</p>`;
}
```

### 4. HTML Render Target (site/index.html)
```html
<section id="my-feature">
  <h2 data-i18n="my_feature_title"></h2>
  <div id="my-feature-container"></div>
</section>
```

### 5. i18n Strings
Add keys to both `T.he` and `T.en` in `translations.js` (see above).

### 6. Wire into Tab Navigation
In `app.js`, find `switchTab()` and add your tab case.

---

## Onboarding a New Trip

**Option A — Interactive CLI wizard:**
```bash
node scripts/new-trip.js
# Prompts for: trip name, participants, families, phases (dates, accommodation, hero image)
# Outputs: trips/<slug>/trip.config.json + trips/<slug>/trivia_questions.json
```

**Option B — From Obsidian notes:**
```bash
node scripts/obsidian-to-config.js /path/to/obsidian/vault/trip-folder
# Parses numbered markdown files (00_–08_)
# Produces ~70% complete trip.config.json with FILL_IN markers
```

**Option C — Claude Code skill (`/create-trip`):** an agent-led interview
that adapts to how much depth you want — lean logistics-only, or the full
gamified family experience (trivia, RSVP voting, budget tracking) — then
generates and self-verifies the config against the real server and render
code. See `.claude/skills/create-trip/SKILL.md`.

**Then deploy:**
```bash
# Local development
TRIP_DIR=./trips/my-trip node server/server.js

# Docker (production)
# Set TRIP_DIR in docker-compose.yml and map the trip directory as a volume:
# volumes:
#   - ./trips/my-trip:/trip:ro
# environment:
#   TRIP_DIR: /trip
docker compose up -d --build
```

**What to fill in after scaffolding:**
- `phases[].days[]` — day-by-day itinerary (optional, for itinerary display)
- `phases[].venues[]` — points of interest with Maps/Waze URLs
- `phases[].packing[]` — `[[{he,en} category, {he,en} item], ...]`. Optional by hand; a
  control-plane-provisioned trip gets it derived (`transformer._derive_phase_packing`, #162):
  a small fixed table picked by season bucket. Deterministic — no weather call, no model.
  **It abstains unless the place and the season are both known** (#167, owner's rule
  2026-09-25: "if not sure, better not to say anything than be unreasonable"). The gate is
  `packing_climate.decide()`: only a phase that names a **city** in its table can get a list —
  a country, region, island or territory never does, and nothing is inherited from the trip's
  destination (the destination is used only to reject a contradicting phase and to confirm a
  namesake such as Perth or Naples). The city must have a real winter and summer (no
  tropical, arid, Mediterranean, monsoon, mild-winter or subpolar climate), and **every month
  the phase covers** must fall in one season and clear that season's temperature test with a
  0.5 °C margin; a phase that spans a season boundary, or names two places that disagree,
  abstains. Abstaining means the `packing` key is absent, both sites fall back to the trip's
  general list, and the transformer logs `transformer.packing_abstained` with a machine-readable
  reason (`packing_climate.REASONS`; the worker's log format currently drops that `extra=`, so
  the log shows that a phase abstained but not why — tracked in #201). The climate table (Köppen type and monthly means per
  city) is recalled from published tables, not read from a dataset — source-checking its
  borderline months is open in #201. Summer lists for non-temperate cities in their good
  months, and a geocoder-latitude fallback (#188), are not built. The trip-level
  `packing_general` is separate and keeps its own frontend fallback.
- `phases[].rsvp_activities[]` — `{id, title, desc?, date?}` vote cards. Optional by hand; a
  control-plane-provisioned trip gets them derived (`transformer.derive_rsvp_activities`,
  #169) from its **unconfirmed** attraction-typed `travel_anchors` — a confirmed attraction is
  already happening, so it is a Bookings row only. The id is a stable hash of what the anchor
  is, because it is the vote's primary key in `rsvps`. Key absent, not `[]`, when a phase has none.
  What was cut, and why: [`docs/sprint6-tracks.md`](docs/sprint6-tracks.md) Track 1a items 3–4.
- `budget.seed_items[]` — initial budget estimates
- `tasks[]` — pre-trip task list with deadlines
- `bookings` — confirmed reservations with confirmation codes
- `trivia_questions.json` — `[{ id, he, en, persons, category, duration, answers: [{he, en, correct}] }]`.
  Don't hand-write 40 of these: `python3 scripts/trivia_agent.py trips/<slug> --generate 15` drafts,
  translates, and quality-checks them straight from `trip.config.json` — no Obsidian vault needed.
  Already have trip notes in Obsidian? `python3 scripts/sync_trivia.py <notes.md> trips/<slug>` instead.
- `avatars/<Username>.png` — **optional.** No photo yet → the site draws a colored circle with the
  person's initial automatically (from their `color` in the config), both on the login screen and
  in trivia. Add a real photo anytime via the site's own upload/crop flow.
- `travel_info.countries` — emergency numbers, currency, calling code per destination country.
  Don't hand-write these either: `node scripts/country-info.js "Japan"` fetches them live (free,
  no API key). `travel_info.health`/`money`/`communication` fill automatically for a
  control-plane-provisioned trip (`enrichment._enrich_destination_info`, sprint 6.1,
  deterministic where an API answers, model-sourced and cached cross-trip at the gaps) —
  this manual quickstart path still has no equivalent, so for a hand-scaffolded trip they
  remain freeform bilingual lists you fill in yourself. `hospitals`/`age_notes` are excluded
  by decision on both paths (no reliable deterministic source) and stay empty. All are
  optional (the Info tab hides each block when its list is empty). See "Country Info" below
  for the full shape.

---

## Country Info

The Info tab's emergency/currency/calling-code cards read from
`trip.config.json`'s `travel_info.countries`, keyed by country name:

```json
"travel_info": {
  "countries": {
    "Japan": {
      "capital": "Tokyo",
      "flag": "🇯🇵",
      "currency": { "code": "JPY", "name": "Japanese yen", "symbol": "¥" },
      "callingCode": "+81",
      "emergency": { "police": "110", "ambulance": "119", "fire": "119", "general": null, "unified112": false }
    }
  },
  "health": [{ "he": "...", "en": "..." }],
  "hospitals": [{ "area": { "he": "...", "en": "..." }, "name": "..." }],
  "money": [{ "he": "...", "en": "..." }],
  "communication": [{ "he": "...", "en": "..." }],
  "age_notes": [{ "who": { "he": "...", "en": "..." }, "note": { "he": "...", "en": "..." } }]
}
```

Populate `countries` with `scripts/country-info.js` (one lookup per
**distinct** country visited, not per phase):
```bash
node scripts/country-info.js "Japan"          # human-readable
node scripts/country-info.js "Japan" --json   # paste into travel_info.countries.Japan
```
Live sources, no API key: [countries.dev](https://countries.dev) (currency,
calling code, capital) and [emergencynumberapi.com](https://emergencynumberapi.com)
(police/ambulance/fire — or a single `general` number for countries like the
US/UK that use one number for everything). Both are free community-run
services with their own "no accuracy guarantee" disclaimers — treat this as
a verified starting point, not a substitute for checking before departure.
There's no automated source for electrical plug type/voltage or which side
of the road people drive on; add those manually if you want them.

The other five `travel_info` fields (`health`, `hospitals`, `money`,
`communication`, `age_notes`) are freeform bilingual lists — genuinely
trip-specific content (altitude warnings, which hospital is near which
hotel) that can't be sourced from an API. All optional: the Info tab hides
each block entirely when its list is empty, rather than showing an empty
heading.

Each country card also shows a live exchange rate — `1 USD ≈ 150.2 JPY`,
and `1 <homeCurrency> ≈ ... JPY` too if `meta.homeCurrency` is set — sourced
from `GET /api/currency-rates` (`server/server.js`), which fetches every
destination currency from `travel_info.countries` plus `homeCurrency`
against [frankfurter.dev](https://frankfurter.dev) (free, keyless,
ECB-backed) and caches the result server-side for 24h. One shared fetch a
day regardless of how many family members open the Info tab, not one per
visitor. No `homeCurrency` set → the USD side still shows, just not the
home-currency comparison. `homeCurrency: "USD"` is treated the same as
unset (no duplicate USD-vs-USD line) — the dollar is the implicit default
home currency either way.

---

## Agent Integration (MCP)

`mcp/` is a standalone MCP server that gives an agent read/write access to
one trip's bookings, photos, tasks, ratings, and comments over HTTP+SSE —
it's config-driven (start with the `get_config` tool to discover that
trip's actual phase/venue/participant ids; nothing is hardcoded). One
instance talks to one trip via `API_BASE_URL`.

The site also serves its **own** MCP endpoint, for a trip member's own Claude
or ChatGPT rather than the companion (`server/trip-mcp/`, off unless
`TRIP_MCP_ENABLED` and `PUBLIC_ORIGIN` are set): read and write for an
organizer, read only for everyone else. It is its own OAuth 2.1 authorization
server: the person adds `<site>/mcp` (the More tab has an "Add to Claude"
install link), signs in with their site login, and approves. Tools call the
site's routes as that person, not as the agent. Details: `mcp/README.md`,
"Trip connector".

### Original plan vs active plan — the vocabulary

A trip carries "what happens on a day" more than once. Use these names for
them; the code, tool descriptions and agent handoff all do.

| | **Original plan** | **Active plan** | Bookings |
|---|---|---|---|
| Where | `trip.config.json` → `phases[].days`, plus its saved copy (`/api/itinerary/original`) | `phase_plan_items` + `phase_plan_days` | `bookings` table |
| What | the schedule as authored, then whatever plan was last saved back | the live schedule: imported once at first boot, plus AI enrichment and the organizer's own edits | reservations: supplier, confirmation, cost, passengers |
| Written by | trip setup; `POST /api/phase-plan/export-to-config` (plan tools → *Save plan as restore point*) | `add/update/delete_plan_item`, `swap_plan_days`, `set_plan_day_label` | `add_booking`, `update_booking` |
| Shown | organizer only, as *Compare with saved plan*; *Restore saved plan* brings it back | **what everyone sees** | booking cards |

**Every itinerary change edits the active plan.** A new route for today,
moving or swapping two days, fixing tomorrow — all of it. The original plan is
a read-only reference; nothing edits it in response to a change request.
`update_booking` will happily accept an itinerary edit, return 200, and change
nothing the family sees. That mismatch is why `swap_plan_days` exists as one
atomic operation rather than a batch of per-item date edits.

The site imports `phases[].days` into the active plan **once**, on first boot
(`importPlanOnce()` in `server/living-journey.js`), so the active plan is the
only plan anything reads — the site, `get_phase_plan`, and exports alike.
Editing `trip.config.json` afterwards changes nothing the family sees. To keep a
copy, save the live plan back (`export-to-config`); that save is also what
`POST /api/itinerary/restore-original` restores.

Two ways to use it, same server either way:
- **A local always-on agent** (Hermes, OpenClaw, your own) on your own
  machine/LAN — point it at `http://127.0.0.1:3001/sse` with an
  `X-API-Key` header. See `mcp/setup-macos.sh`.
- **Claude Cowork, or any remote custom connector** — Cowork's Connectors
  are *remote* MCP servers (they work the same across claude.ai, Desktop,
  Cowork, and mobile), so this needs to sit behind a public HTTPS URL —
  reuse whatever tunnel/reverse proxy already fronts the site itself, then
  add it as a custom connector with the same `X-API-Key` header.

---

## Infrastructure Details

### Docker Compose
- **nginx** (`:8080`) — reverse proxy, static file server
- **node** (`:3000` internal) — Express API server
- Volumes: `site/` read-only into nginx; `trip/` read-only at `$TRIP_DIR`; `server/data/` for SQLite

### nginx — Critical Settings
```nginx
# SSE routes must bypass buffering
location /api/trivia/events {
    proxy_buffering off;
    proxy_cache off;
}

# File uploads
client_max_body_size 500m;

# PDF inline display
add_header Content-Disposition inline;
```

### Immich (optional photo sync)
Set in `.env`:
```
IMMICH_URL=http://your-immich-host:2283
IMMICH_API_KEY=your-api-key
```
Without these, photos still work — stored locally in `server/data/uploads/`.

### Google Sign-In (optional, additive)
Set in `.env`:
```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```
Get one from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
(OAuth client ID, type "Web application"). This is a public identifier, not a
secret — it's meant to be embedded in client-side JS.

Without it, the site is password-only — the Google button simply doesn't
render. With it, Google Sign-In is an *additional* login method bound to an
already-predefined user, never a way to self-register: a participant logs in
once with their seeded password, links their Google account from the avatar
screen (`PUT /api/auth/google-link`), and can use either method from then on.
`POST /api/auth/google-login` 404s with `not_linked` if the Google account
hasn't been connected to any username yet — the response is meant to prompt
"log in with your password first, then connect Google."

### Security Model
- JWT tokens (30-day expiry); `authRequired` middleware on all private routes
- Guest endpoints (no login): the lost & found form (`POST /api/lost-found` — no rate limit, #207), the
  public trivia TV view and its SSE stream, `GET /api/trip/logo`, `GET /api/config/roster`, and the
  `/photo/:id?s=` share page (below). Everything else in the gallery and social surface needs a login
  (#191, #194).
- **Gallery and social routes need a login, and one member sees only a projection of another** (#191,
  #194, PR #211). `/api/photos`, `/api/ratings`, `/api/reactions[/:id]`, `/api/comments/venue|photo[...]`,
  `/api/rsvps/:id`, `/api/tasks/done` and `/api/album-share/:phase` sit behind `authRequired` — so a
  member's JWT, the agent key or a gateway-injected session, **not** an organizer check. Anything that
  attaches another member to a record goes through `publicUser()` (`server/public-user.js`), an
  **allow-list** of `username`, `name`, `name_en`, `color`, `avatar_file`; a `users` column nobody names
  there (Telegram id, Google email/sub, age, family) is never attached, whatever is added to the table
  later. `getUser()` (the whole row minus the password hash) is for a caller's own record
  (`/api/auth/me`) only. By design `/api/config` still gives every signed-in member `age` and `family`,
  because the config allow-list names them (#172); that is a separate decision from `publicUser`.
  The anonymous trivia stream's `players` are built without `family`.
- **Photo files and share links are HMAC capabilities, not sessions** (`server/file-token.js`). Both keys
  are derived from `JWT_SECRET` under separate labels (`kinerary:photo-file:v1`, `kinerary:photo-share:v1`),
  so neither signature can be replayed as the other or as anything else keyed by that secret; no new
  secret exists.
  - *File link* — the authenticated `/api/photos` listing (and the upload response) hands out
    `/api/photos/file/<name>?exp=&sig=` per photo, valid one hour, because an `<img>` cannot send a
    bearer token. A missing, malformed, expired or wrong link **falls back to `authRequired`** rather than
    being served or hard-refused itself, so a gallery left open past the hour keeps working behind the
    gateway, which injects the session on every request; with no other credential it is a 401.
  - *Share link* — `/photo/<id>?s=<hmac of the id>` (Facebook's crawler has no login) does **not expire**
    and works for anyone holding it; unknown id, no signature, and a bad one all answer the same 404. Only
    the authenticated listing hands one out. Owner decision, 2026-09-25: the link is open to everyone in
    the group. The page's own image URL is a freshly signed one-hour file link, and its metadata is
    HTML-escaped.
  - **Rotating `JWT_SECRET` revokes every outstanding file and share link and logs every member out.** It does **not** revoke trip-connector (MCP) connections: their tokens are random and stored hashed, not signed with it. An organizer disconnects them from the site's connections list.
- **Uploads and served files cannot run script.** `/api/photos/upload` accepts only
  `jpg/jpeg/png/gif/webp/heic/heif` with an `image/*` type (SVG and HTML are refused, 400
  `unsupported_file_type`) and stores it under a server-built name (timestamp, random, allow-listed
  extension) — never a fragment of the uploader's filename. The file route serves only a bare filename
  that still resolves inside the uploads directory after symlinks, with `nosniff`, `Content-Security-Policy:
  sandbox`, and `application/octet-stream` for any active-content extension (older stored files may
  carry those names). `/api/trip/logo` stays public (the login page draws it) but serves only an image
  extension (`png jpg jpeg gif svg webp`) whose real path is inside the trip directory, with `nosniff`
  and, for SVG, `sandbox`.
- Admin: `meta.admin` in `trip.config.json` (falls back to the first participant if unset); controls trivia start/reveal/reset
- Passwords: bcrypt-hashed; PIN codes for hotel check-in (served from config, never stored in DB)
- **Trip config is served through an allow-list** (#172): `/api/config`, `/api/config/versions/:version`,
  the public `/api/config/roster`, `/api/hermes/status`, the plan importers and the served itinerary all
  project `trip.config.json` through `shared/config-visibility.js` (engine: `shared/allow-list.js`).
  Being signed in is not a reason to see a field; being on the list is. A field the list does not
  name is **withheld silently, on purpose** — a deny-list serves every field added after it was
  written, which is how #172 leaked. The only signals are the server log at boot (the dropped
  *paths*, never values) and `GET /api/config/warnings`, which carries a **count only**, because a key
  name is itself authored config text. A new field a producer writes must be added to the list
  (`tests/config-allow-list.test.js` fails until it is); an organizer-only field belongs in
  `GET /api/agent/brief`. Redeploying an existing trip can hide fields it shows today — run
  `projectConfig` on its config and read the boot log first (#200).
- Google Sign-In (optional): ID tokens verified against Google's public keys via `google-auth-library`, no server-side secret; binds to `users.google_sub`, unique per username
- Trip connector (optional, `server/trip-mcp/`): OAuth 2.1 with PKCE, dynamic registration limited to the hosted assistants' callbacks and loopback; opaque, hashed, revocable tokens that are never site sessions (and site sessions are never MCP tokens); anyone on the trip, read-only unless an organizer approved, re-checked on every call

---

## Database Schema (13 tables)

| Table | Purpose |
|---|---|
| `users` | Family members: auth, avatar, family group |
| `ratings` | (venue, username) → stars |
| `photos` | Uploaded photos with Immich ID |
| `venue_comments` | Reviews per attraction |
| `rsvps` | (activity, username) → yes/no/maybe |
| `photo_reactions` | (photo_id, username, emoji) |
| `photo_comments` | Thread comments on photos |
| `task_done` | Task completion with timestamp |
| `lost_found` | Lost item reports with resolved flag |
| `budget_items` | Expenses with phase, category, estimate flag |
| `trivia_scores` | Game history with rank and score |
| `phase_plan_items` | The active plan: one row per activity, dated into a phase |
| `phase_plan_days` | The active plan's day headlines — one per (phase, date), shown above its items |

---

## Technology Choices & Why

| Choice | Why |
|---|---|
| **Vanilla JS** (no framework) | Zero build step; works offline; easy for any developer to read and extend |
| **better-sqlite3** (synchronous) | No async complexity; WAL mode for concurrent reads; single file database |
| **SSE** (not WebSocket) | Simpler server-side; no lib needed; survives nginx proxy easily |
| **Leaflet + OpenStreetMap** | Free, no API key, works offline once tiles cached |
| **Open Meteo** | Free weather API, no auth, 7-day forecast |
| **Immich** | Self-hosted, privacy-respecting, family photo library |
| **Docker Compose** | One command deploy; nginx handles SSL termination upstream |
| **Single config JSON** | One file to edit for a new trip; no database migrations; version-controllable |
