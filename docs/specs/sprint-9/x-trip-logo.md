# Trip logo: one picture for the header and the installed app

Status: approved (2026-11-24, by Dror: all four recommendations) → in build · Issue: none yet · Track: video look · Size: M · Tier: Normal
Security path: yes (a new upload that a public, pre-login route serves; organizer-only writes) · Migration: no
(trip SQLite gains columns; no control-plane migration) · Live-trip behaviour: no until the switch is on for a trip

Companion spec: `x-trip-group-photo.md` (the bot sets the Telegram group photo from this logo). That one is a
separate PR because it changes control-plane behaviour, so it is risk-class. This one is not.

## Problem

An organizer cannot give a trip its own logo after the trip is built. The display half already exists, but
nothing a person can reach writes it, and the two readers disagree:

- **The PWA icons and `/api/trip/logo`** read `meta.logo` as a file inside the trip directory
  (`server/site-icons.js`, `server/server.js` `GET /api/trip/logo`).
- **The header** reads `meta.logo` as a URL or `/path` and ignores a bare filename (`trip-web/src/App.tsx`
  `tripLogoUrl`). The scaffolder writes `logo: 'Logo.png'` into every trip
  (`.agents/skills/create-trip/driver.mjs`). So a trip with a real `Logo.png` shows it as the home-screen
  icon and the Kinerary mark in the header.
- **The only writer** is `set_trip_logo` in `mcp/provision.js`. It is LAN-only (hard rule 5) and edits
  `trip.config.json`, which the provisioner rewrites on every rebuild. It also needs a site restart.
- **The companion's skill** (`.agents/skills/trip-site-operations/SKILL.md`, "image / hero replacement")
  says no write path exists, which is true today.
- **Companions on the VM have no image tool.** The `image_gen` toolset resolves to no tool there (the
  2026-09-28 tool inventory), so "make us a logo" has nothing to run.

## Behaviour

An organizer sets the trip's logo in any of four ways. Each one lands in the same place and shows up
everywhere within a minute: the header, the login page, the browser tab and the icon of a newly installed app.

1. **On the website.** Organizer settings has a "Trip logo" row next to "The trip's picture", with a preview,
   "Choose image" and "Use the Kinerary logo". Only organizers see it.
2. **Through the companion.** The organizer sends the companion an image and says "make this the trip logo".
   The companion checks that the sender is an organizer, uploads it, reads it back, and replies with what the
   site now shows. If a member asks, the companion says only an organizer can change it.
3. **Through Claude or ChatGPT (the trip connector).** These clients cannot hand image bytes to a tool, so the
   connector returns a link to an upload page on the trip site, like the booking-confirmation link. The page
   says the upload is pending until it has verified the saved logo.
4. **Made by the companion, when it can.** If the companion's runtime has an image-generation tool, it makes
   a draft, shows it, and uploads it only after the organizer says yes. If it has no such tool (every VM
   companion today, see D3), it says so plainly. It then suggests making one in ChatGPT or Claude and sending
   it over. It never pretends.

A removed logo falls back to `meta.logo` (if that file exists), then to the Kinerary mark.

Organizers only, on every path. Members see the logo and cannot change it.

## Acceptance criteria

- AC-1 Given switch `trip_logo` is on and an organizer's JWT, when they `POST /api/ui-settings/logo` with a PNG,
  JPEG, WebP or GIF up to 8 MB, then the response is 200 and `GET /api/ui-settings` returns
  `logo.url = /api/trip/logo?v=<hash>`, where the hash is of the stored file.
- AC-2 Given the same request with a member's JWT, then 403, and nothing is stored.
- AC-3 Given an SVG, a PDF, a file named `.png` whose bytes are not an image, or an image over 40 MP, then
  400 `invalid_image`, and nothing is stored or changed. Over 8 MB gives 413.
- AC-4 Given an accepted upload, then the stored file is a PNG re-encoded by `sharp`: EXIF orientation
  applied, metadata stripped, fitted inside 1024×1024. The client's bytes are never served as sent.
- AC-5 Given an uploaded logo, when anyone (no session) requests `/api/trip/logo`,
  `/api/trip/icon/{32,180,192,512}.png` or the manifest, then all of them serve the uploaded logo. The
  manifest's icon URLs carry `?v=<hash>`.
- AC-6 Given an uploaded logo, when a signed-in member opens the trip site, then the header and the login
  page show it, not the Kinerary mark.
- AC-7 Given no uploaded logo and a trip-directory `meta.logo` file that passes today's checks, then the
  header shows that file too, not the Kinerary mark (the existing disagreement is fixed). Given neither, both
  show the Kinerary mark.
- AC-8 Given an organizer, when they `DELETE /api/ui-settings/logo`, then AC-7's fallback applies and the old
  file is deleted from `MEDIA_DIR`.
- AC-9 Given switch `trip_logo` is off, then the upload and delete routes answer 409 `feature_off`, the
  organizer row is not rendered, and the connector and companion tools say the feature is not on for this
  trip. Display of an already-stored logo does not depend on the switch.
- AC-10 Given the companion MCP (`mcp/mcp.js`), when `upload_trip_logo { filePath }` names a readable image on
  the MCP host, then AC-1 holds through the agent key. `clear_trip_logo` does AC-8.
- AC-11 Given the trip connector (`server/trip-mcp/tools.js`) with organizer (`read_write`) access, when
  `get_trip_logo_upload_link` is called, then it returns `{ status: 'pending_upload', url }`. The page at that
  URL refuses a member's session and verifies the saved logo by reading `GET /api/ui-settings` before it says
  "done". With read-only access, the tool is not listed.
- AC-12 Given any change to the logo, then a `ui` trip event fires and open pages refresh the header without a
  reload.
- AC-13 Given the companion skill, when a member (not an organizer) asks to change the logo, then the
  companion refuses and names who can. When an organizer asks for a generated logo and no image tool is
  present, the companion says it cannot make one and offers the alternative. It never calls
  `upload_trip_logo` with an image the organizer has not approved.
- AC-14 Given a trip title, when the manifest is requested, then `name` is the trip title and `short_name` its
  first 12 characters (trimmed); with no title, both stay "Kinerary" (D2).

## Contracts

**Storage (trip SQLite, `server/living-journey.js`).** Same `ALTER TABLE … ADD COLUMN` + `try/catch` pattern
as `trip_settings.nav_app`:

```
ALTER TABLE trip_ui_settings ADD COLUMN logo_media_file TEXT;   -- 'logo-<sha256[0..16]>.png' in MEDIA_DIR
ALTER TABLE trip_ui_settings ADD COLUMN logo_hash TEXT;
ALTER TABLE trip_ui_settings ADD COLUMN logo_updated_by TEXT;
ALTER TABLE trip_ui_settings ADD COLUMN logo_updated_at TEXT;
```

The logo lives in SQLite because the provisioner rewrites `trip.config.json` on every rebuild.

**One resolver**, `effectiveLogo()`, returns `{ file, hash, source: 'upload'|'config'|'none' }`. Order:
upload (in `MEDIA_DIR`), then `meta.logo` (in `TRIP_DIR`, today's realpath containment and extension
allow-list unchanged), then none. `GET /api/trip/logo`, `site-icons.js` and `uiSettings()` all call it. The
containment check is per source: an upload must resolve inside `MEDIA_DIR`, a config file inside `TRIP_DIR`.

**Routes (`server/server.js`, next to the hero upload).**

| Route | Auth | Notes |
|---|---|---|
| `POST /api/ui-settings/logo` | `organizerOrAgentRequired` | multipart field `logo`; switch-gated; AC-1–4 |
| `DELETE /api/ui-settings/logo` | `organizerOrAgentRequired` | switch-gated; AC-8 |
| `GET /api/ui-settings` | unchanged (`authRequired`) | adds `logo: { url, source, updated_at }` |
| `GET /api/trip/logo` | public, unchanged | adds the upload source; `Cache-Control: public, max-age=300`; `?v=` ignored |
| `GET /api/trip/icon/:size.png`, `manifest.webmanifest` | public, unchanged | read `effectiveLogo()`; icon URLs get `?v=` |

The login page draws before any session, so it gets the logo from `/api/trip/logo` directly and falls back to
the brand mark on 404. `sanitizeConfig()` and `shared/config-visibility.js` do not change. No new config
field is served.

**Feature switch** (`shared/feature-switches.js`): `trip_logo`, surfaces `site`, `companion`,
`memberVisible: true`. The site's organizer row reads `features.trip_logo`.

**Site UI** (`trip-web/src/App.tsx`): `TripLogoControl` beside `HeroPictureControl`, with English and Hebrew
copy. The header (`hero-logo`) and the login logo read `ui.logo.url`.

**Companion MCP** (`mcp/mcp.js`): `upload_trip_logo { filePath }` and `clear_trip_logo {}`, shaped like
`set_participant_avatar`. The name differs on purpose from `provision.js`'s `set_trip_logo`, which is the
scaffold-time writer and is left as is.

**Trip connector** (`server/trip-mcp/tools.js`, plus a page beside `confirmation-upload-page.js`):
`get_trip_logo_upload_link {}` and `clear_trip_logo {}`, both WRITE. The upload page is served at
`/mcp/upload-logo` under the same CSP/nonce rules as `/mcp/upload-confirmation/:id`.

**Companion skill** (`.agents/skills/trip-site-operations/SKILL.md` and its imagery reference): a "Trip logo"
workflow. It covers the organizer check, upload, read back and report; a generated logo only with an image tool,
shown as a draft, uploaded on a yes; and the plain answer when there is no tool. Run
`scripts/install-hermes-skill.sh --check` before the deploy (hard rule: capture before you deploy).

**Files expected to change:** `server/server.js`, `server/living-journey.js`, `server/site-icons.js`,
`server/trip-mcp/tools.js`, a new `server/trip-mcp/logo-upload-page.js`, `mcp/mcp.js`,
`shared/feature-switches.js`, `trip-web/src/App.tsx`, `trip-web/src/api.ts`, the built `site/modern/`,
`.agents/skills/trip-site-operations/**`, and tests under `tests/` and `trip-web/`.

## Non-goals

- **Fetching a logo from a URL** the organizer or a model gives. That is a server-side fetch of an arbitrary
  address (SSRF) for a little convenience. The upload link covers Claude and ChatGPT.
- **SVG uploads.** The public route would serve organizer-supplied script-capable content. An existing
  `meta.logo` SVG keeps working as today (CSP `sandbox`).
- **Changing the Kinerary product logo** anywhere outside the trip site (portal, landing page, emails).
- **Enabling image generation on companions** (see D3). This spec only makes the skill use such a tool when
  it is there.
- **Refreshing an icon already installed on a phone.** A new install gets the new icon. iOS never updates an
  installed home-screen icon. Android Chrome updates it on its own schedule. The release note says so.

## Security and boundary notes

- **The serving route is public and pre-login on purpose** (the login page and the trivia TV draw it). What
  makes that safe is that the bytes are always our own re-encoded PNG (AC-4), not the upload. `nosniff` stays.
- **The agent key can write the logo**, as it can the hero. The site cannot tell which human asked. The
  organizer check lives in the companion skill (AC-13), as for every other `/api/agent`-class write.
- **Boundary review:** live request/response for AC-2, AC-3 (an SVG and a polyglot named `.png`), AC-5 (no
  session) and AC-11 (member session on the upload page).

## Test plan

Server tests (`tests/`), written first from AC-1–5, AC-7–10 and AC-12: a fixture trip, the multer limits, a
polyglot file, the 40 MP bound, the switch off and on, and fallback order. Connector tests for AC-11 next to
the confirmation-link tests. A `trip-web` vitest for the header source (AC-6, AC-7). A companion eval prompt
pair for AC-13 (member asks, organizer asks with no image tool). The `verifier` reports AC by AC.

## Rollout and regression

Not risk-class (no migration in the control plane, no auth semantics changed, no relay behaviour), so green CI
and the last green nightly are the evidence. Ships with `trip_logo` off. It goes on for a staging trip, then
for the Alsace trip (a switch on a trip at `ready_private` or later counts as a deploy, under standing
approval), then as the default for future trips.

## Decisions (Dror, 2026-11-24 — every recommendation agreed)

- **D1 · Group photo — on request.** Was: automatic or on request? The spec in `x-trip-group-photo.md` assumes *on request*: the
  companion and the website offer "also make it the group photo" after a logo change. Recommended, because it
  replaces a photo the family chose and the bot cannot put the old one back.
- **D2 · App name — the trip title (AC-14).** Re-decided by Dror on 2026-11-25, after the boundary review
  corrected the first premise. The title was *not* public before sign-in: the login page shows first names and
  the logo, not the title. The manifest therefore makes the trip title readable to anyone with the site's
  address, and Dror accepted that knowingly. The title comes from the allow-listed public projection
  (`publicConfig(...).meta.title`), never the raw config.
- **D3 · Generating a logo — (a), no provider now.** No VM companion can generate an image today. (a) Ship without it: the companion
  says it cannot, and the skill uses a tool if one ever appears. (b) Turn on Hermes image generation with a
  provider key in `kinerary-deploy`. That adds a new provider, a cost, and images a model drew that children
  see. (c) A site-side "generate a logo" function on an existing model provider. Recommended (a) now, with (b)
  or (c) as its own spec if you want it.
- **D4 · Claude/ChatGPT path — the upload link.** Is an upload link (open it, pick the file) acceptable as "upload via the
  connector"? It is the only path that works in both clients today. Recommended yes.
