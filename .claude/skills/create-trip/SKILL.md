---
name: create-trip
description: Interview the user about a trip they're planning and scaffold a new trip for this framework — writes trips/<slug>/trip.config.json + trivia_questions.json, then boots the real server and renders the real site code against it to prove it works. Use when asked to create/add/scaffold/onboard a new trip, set up a trip site for a family/couple/group, or import an existing trip plan (Obsidian notes) into the framework.
---

This repo hosts *many* trips (`trips/<slug>/`, see `trips/japan-2025/` for
a real example) behind one shared site/server
(`FRAMEWORK.md`; `README.md` for the human quick-start and hosting options;
`LICENSE` — MIT). This skill drives the interview and the scaffolding — it
does not hand-write JSON. The question script is
[INTERVIEW.md](INTERVIEW.md); the code that turns answers into a working
trip is [driver.mjs](driver.mjs). All paths below are relative to the repo
root, not to this skill directory.

If the person wants an AI agent (Claude Cowork, a local always-on agent, or
their own) to help manage the trip after it's created — answering questions,
adding bookings — point them at `mcp/`, not this skill; that's a separate,
already-generic MCP server, not something `/create-trip` sets up.

**Never write to `trip/`** (singular) — that's the directory the running
dev server currently has live (`docker-compose.yml`'s default
`TRIP_DIR_HOST`). New trips always go in `trips/<slug>/` (plural). Going
live with a new trip means repointing `TRIP_DIR`/`TRIP_DIR_HOST`, covered
below — never overwriting `trip/` directly.

## Prerequisites

None beyond what the repo already needs — Node (`node --version` — this
was built and verified against Node v25.9.0) and `server/node_modules`
already installed (`ls server/node_modules/express` — if missing, `npm
install --prefix server`). No new dependencies were added for this skill.

## Run (agent path)

1. **Interview.** Follow [INTERVIEW.md](INTERVIEW.md) — it's short, read it
   before starting. It asks for a style preset via `AskUserQuestion`
   (Lean / Balanced / Full gamification — "not everything is mandatory" is
   the whole point of that step), then collects trip basics conversationally.
2. **Assemble** the answers into one JSON file shaped like
   [answers.example.json](answers.example.json) (that file is a real,
   verified example — a 3-person, 2-phase Italy trip — not just a schema
   stub).
3. **Generate:**
   ```bash
   node .claude/skills/create-trip/driver.mjs generate /path/to/answers.json
   ```
   Validates first (missing title, no participants, a family pointing at an
   unknown username, duplicate phase ids, etc. all fail loudly *before*
   anything is written) and refuses to clobber an existing
   `trips/<slug>/` unless you pass `--force`.
4. **Verify — actually run it, don't just eyeball the JSON:**
   ```bash
   node .claude/skills/create-trip/driver.mjs verify <slug>
   ```
   This boots the real `server/server.js` against the new trip dir on a
   throwaway port + temp `DATA_DIR`, hits `/api/health` and `/api/config`
   over real HTTP, confirms PINs are stripped from the API response, then
   feeds the fetched config into the **real** `site/app.js` render
   functions via `happy-dom` (no browser — see Gotchas) and asserts the
   DOM comes out right: stat strip populated, one `.fam` card per family,
   one task row per task, every phase's hotel card actually shows the
   accommodation name. Exits 1 with a per-check ✔/✘ report on any failure.
   Sample output from a real run:
   ```
   Booting real server against trips/italy-2027/ ...
     ✔ server started
     ✔ GET /api/health returns ok
     ✔ GET /api/config returns meta.title — Italy 2027
     ✔ GET /api/config returns participants — 3 participants
     ✔ GET /api/config returns phases — 2 phases
     ✔ accommodation/participant PINs stripped from API response

   Rendering real site/app.js functions against the fetched config (happy-dom, no browser) ...
     ✔ renderStats() fills #stat-strip
     ✔ renderFamilies() renders one .fam per family — 1 rendered
     ✔ renderTasks() renders one row per task — 1 rendered
     ✔ renderPhaseHotelCard() shows accommodation name for every phase

   ✅  All 10 checks passed. trips/italy-2027/ renders correctly with real app code.
   ```
5. **Report back** with what was written and what's still optional:
   `trips/<slug>/Logo.png` (copy one in if they have a brand mark — the site
   falls back gracefully without it), real trivia content if they picked the
   Full style and skipped generating it during the interview (`python3
   scripts/trivia_agent.py trips/<slug> --generate 15`), and how to preview
   it (below). Avatars need no action — see INTERVIEW.md. If the user wants
   this trip live now, repoint the server rather than touching `trip/`.

## Run (human path)

Two manual alternatives to the interview, for someone without an agent:

```bash
node scripts/new-trip.js                              # readline wizard, same output shape
node scripts/obsidian-to-config.js <vault-dir> <outdir>  # import from Obsidian notes
```

To actually **look at** a scaffolded trip (there's no `chromium-cli` in
this environment, so this step is manual, not agent-driven) — this needs
the nginx container too, since `server/server.js` alone is API-only and
won't serve the site's HTML/CSS/JS:
```bash
TRIP_DIR_HOST=./trips/<slug> docker compose up -d --build
# then open http://localhost:8081 in a real browser (see docker-compose.override.yml for the port)
```
Log in as any participant (username from the trip's `trip.config.json`)
with the seeded default password **`1234`** — verified working end-to-end
while building this skill (booted a real isolated instance, confirmed
`/api/health`, the real HTML, and `/api/config`'s participant list).

`TRIP_DIR=./trips/<slug> node server/server.js` alone only gets you the raw
JSON API on whatever `PORT` you set — fine for `curl`-ing `/api/config`
directly, not for viewing the site.

## Test

```bash
node .claude/skills/create-trip/driver.mjs verify <slug>   # this skill's own driver
cd tests && ./run-tests.sh                                  # framework's full suite (71 tests as of this writing)
```

---

## Gotchas

- **No `chromium-cli` / Playwright in this environment.** The framework's
  own test suite solves the "did it actually render" question without a
  browser at all: `tests/helpers/dom.js` loads the real `site/app.js`
  render functions (the block between `/* RENDER_FUNS_BEGIN */` and
  `/* RENDER_FUNS_END */`) into `happy-dom` and executes them. `verify`
  reuses this instead of fighting to install a browser stack on what's
  the user's actual dev machine, not a disposable container.
- **`RENDER_TARGETS_HTML` in `tests/helpers/dom.js` is fixture-specific**
  (hardcodes `hotel-ny` / `hotel-colorado` divs). It only works for the
  test fixture's phase ids. `driver.mjs`'s `targetsHtmlFor()` builds the
  target `<div id="hotel-...">` markup dynamically from *your* trip's
  actual phase ids instead of reusing that constant.
- **`scripts/new-trip.js` had a real bug**, found and fixed while building
  this skill: it wrote `stats[].label`, but `renderStats()` reads
  `stats[].description` — every trip scaffolded through the old wizard had
  correct stat numbers but permanently blank captions underneath them.
  Fixed at the source; `driver.mjs` was written with the correct key from
  the start.
- **`renderAlerts()` checks object truthiness, not string content.** An
  `alerts: { booked: { he: '', en: '' } }` placeholder still renders an
  empty checkmark chip, because the object itself is truthy. `driver.mjs`
  omits the `alerts` key entirely unless real text was given — don't
  "helpfully" default it to empty bilingual objects.
- **`accommodation.name` can be a plain string or a `{he,en}` object** —
  `_bi()` passes plain strings through unchanged for both languages. Use
  the bilingual form (`driver.mjs` does) when you actually have a
  translated name; a plain string is fine when the name shouldn't be
  translated (most hotel names).
- **Node 25 rejects `__filename` next to a top-level `await` in a `.mjs`
  file** (`ERR_AMBIGUOUS_MODULE_SYNTAX`) — hit this immediately while
  writing `driver.mjs`. Use `fileURLToPath(import.meta.url)` instead.
- **`tests/helpers/server.js`'s `startTestServer()` hardcodes `TRIP_DIR`**
  to the test fixtures dir — it can't be pointed at an arbitrary trip, so
  `verify`'s server-boot logic is a small self-contained copy of that
  pattern (parameterized on `tripDir`/`port`), not an import of it. Only
  the DOM-rendering half (`createRenderContext`, genuinely
  config-agnostic) is imported directly from `tests/helpers/dom.js`.
- **Port 3098** is what `verify` boots on — the framework's own tests use
  3099 (`tests/helpers/server.js`); picked a neighboring-but-distinct port
  so both can run without colliding.
- **The home tab and map tab hero photos were not config-driven at all**
  until this session — `HERO.home.photo`/`HERO.mapview.photo` in
  `site/app.js` were hardcoded to fixed Unsplash URLs from the original
  single-trip site, and `applyBrandFromConfig()` only ever overrode
  `HERO.home`'s *text* fields, explicitly preserving the old `.photo` via
  `{ ...HERO.home, title, meta, _i18n }`. No trip config could ever change
  them. Fixed by wiring `meta.homePhoto`/`meta.mapPhoto` into both — see
  `applyBrandFromConfig()` in `site/app.js` and the "Trip-wide hero photos"
  step in [INTERVIEW.md](INTERVIEW.md). Both fields are optional and fall
  back to the original hardcoded defaults when a trip doesn't set them
  (verified against a real multi-phase trip config that doesn't set either).
- **`applyBrandFromConfig()` sits inside `RENDER_FUNS_BEGIN`/`END` textually
  but isn't sandbox-clean** — it references the module-level `HERO` object
  (declared *outside* the markers, so `createRenderContext()` never loads
  it) and calls `fetch()` for the logo check. `verify`'s homePhoto/mapPhoto
  check pulls `HERO` + the function in manually with a stubbed `fetch`,
  wrapped in a try/catch that degrades to a skip (not a failure) if
  app.js's shape ever changes enough that the extraction stops matching.
- **A phase can legitimately have no `accommodation.name` at all** — found
  via `verify` against a real trip config: a multi-stop phase (5 hotels
  across one phase) has an `accommodation` object with
  only a `note` ("5 hotels — see below"), deferring actual hotel details to
  a separate `hotels[]` array `renderPhaseHotelCard()` doesn't touch. Don't
  assume every phase has a name to check against — check only when the
  config actually claims to have one.
- **Never type a photo URL from memory, "confident" or not.** Caught twice
  in one session: a fabricated Unsplash id that flat-out 404'd, and a
  separate one that resolved fine (real HTTP 200, real JPEG) but was never
  actually confirmed to depict what it was picked for — resolving isn't the
  same as being the right photo. The only reliable process:
  `WebSearch` → a specific Unsplash photo page → `WebFetch` that page to
  get its real `images.unsplash.com/photo-<id>` URL and description →
  `curl -sI` the direct URL to confirm `200`/`image/jpeg`. All four photo
  URLs in [answers.example.json](answers.example.json) went through this;
  none were typed from memory.
- **`scripts/country-info.js`'s two free APIs each have a real quirk, both
  hit while building it.** `countries.dev/name/<query>` does substring
  matching with no relevance ranking — querying just "United States"
  returned "United States Minor Outlying Islands" *before* "United States
  of America" in the array, so a naive "first result" pick is wrong for
  exactly the country someone's most likely to ask about. Fixed by
  preferring an exact match, then the *shortest* name among prefix matches.
  Separately, `emergencynumberapi.com` puts single-unified-number countries
  (US 911, UK 999) under a `dispatch` field, not `police`/`ambulance`/`fire`
  (those come back as `[""]`, not null) — missed this at first and got
  `null` for the US's emergency number, which is exactly the kind of wrong
  answer this tool exists to prevent. Both are fixed and verified against
  7 real countries; there's still no automated source for plug type/voltage
  or driving side — not included.
- **The `server/trivia_questions.json` framework-level fallback (removed
  earlier this session) was silently carrying one real trip's *only*
  copy of its trivia questions** — that trip never had its own
  `trivia_questions.json`. Deleting the fallback file without checking
  first would have permanently lost 115 real questions; recovered them via
  `git show HEAD:server/trivia_questions.json` (the file was tracked and
  clean) and moved them to the correct per-trip location. Lesson: before
  deleting anything a fallback path reads from, check whether some real
  trip is actually depending on it having no local copy of its own.

## Troubleshooting

- **`trips/<slug>/ already exists and is non-empty`**: `generate` refuses
  to clobber silently. Pick a different trip title, or pass `--force` if
  overwriting is intended.
- **`Validation failed: family "..." references unknown participant "..."`**:
  a `families[].members` entry (explicit or auto-derived) doesn't match any
  `participants[].username` exactly — usernames are lowercase, no spaces;
  check for a typo or a participant that got dropped.
- **`Validation failed: meta.departure is required`**: `meta.departure` and
  every participant's `username`/`name`/`name_en`/numeric `age`/`family`
  are the only fields `generate` treats as hard-required — everything else
  degrades to a sane default. If validation fails, the message names the
  exact missing field.
- **`verify` hangs then prints "server did not print ready line within
  10s"**: usually means `server/node_modules` isn't installed —
  `npm install --prefix server`.
