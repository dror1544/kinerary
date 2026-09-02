# Modern Trip SPA code review session

Date: 2026-08-29

## Scope reviewed

- New Modern participant SPA under `trip-web/`, built to `site/modern/`.
- Classic/Modern loader and Classic rollback path.
- Shared Kinerary brand assets and tokens.
- SQL-backed living itinerary model and compatibility adapters.
- Today/Journey/Moments/More beta surfaces.
- Control-plane landing SPA integration brought in from `feat/landing-spa`.

## Pre-commit findings fixed

1. Modern did not load `runtime-base.js`, which could break API calls and links behind gateway-prefixed routes such as `/t/<trip>/modern/`.
   - Fix: ship `runtime-base.js` with the Modern build and load it before the SPA bundle.

2. Modern looked only for `tripToken`/`token`, but the gateway session marker is `trip-token`.
   - Fix: accept `trip-token` as an authenticated runtime marker and clear all known token keys on logout.

3. Classic fallback links used `../classic.html`, which was fragile in local preview and gateway routing.
   - Fix: added a Classic URL helper that uses runtime prefixing and points local Vite preview to the API server that serves `classic.html`.

## Validation

- `trip-web` unit tests: passed, including Classic fallback URL and gateway token marker coverage.
- `trip-web` production build: passed.
- Earlier full runtime suite for this staged feature: 379 passed, 0 failed.
- Staged diff whitespace check: clean after generated bundle whitespace cleanup.
- Secret scan: clean.
- `japan-2025` date-shift status: clean.

## Known follow-up risks

- Modern is not yet feature-parity with Classic. Classic must remain available until parity acceptance.
- Some design issues are intentionally still open for organizer interview: Today emphasis, Journey phase semantics, More/fallback visibility, and Moments behavior during an active trip.
- Bot settings are future scope because organizer-editable bot personality requires Hermes-agent changes; the current UI should only display the configured bot name and open Telegram.

## Commit recommendation

Commit is reasonable after the Classic fallback fix because the feature is staged, tested, and still protected by Classic rollback. The next phase should start with stabilizing structure/design and the Classic switch, then rebuild bookings/tickets/maps.

## Stabilization follow-up — 2026-08-29

### Scope reviewed

- Classic shell availability at `/classic.html`.
- Mobile Modern chrome: bottom tabs remain the primary navigation, with a top hamburger for direct module access and session controls.
- Desktop/tablet Modern chrome: top-level shortcuts expose Bookings, Map, Budget, and Photos.
- Organizer-only Classic fallback visibility from the Modern UI.
- Default language selection from stored preference first, then device/browser language.

### Findings fixed

1. `/classic.html` returned `Cannot GET /classic.html` because the server did not expose the Classic shell as a static route.
   - Fix: added a narrow allowlist of Classic shell/assets instead of serving all of `site/`.

2. Mobile session controls competed for space with the trip header, and RTL caused logout/language overlap.
   - Fix: moved language switching and logout into the hamburger menu.

3. Classic fallback was too visible for ordinary participants.
   - Fix: the Modern UI now shows Classic fallback only to organizers.

4. Bookings, maps, budget, and photos were too buried for desktop/tablet use.
   - Fix: added direct desktop/tablet shortcuts while keeping mobile bottom tabs.

### Validation

- `node --test --test-timeout=60000 --test-reporter=spec server.test.js`: 133 passed, 0 failed.
- `trip-web` unit tests: 3 passed, 0 failed.
- `trip-web` production build: passed.

### Next review focus

The next phase should build the Bookings/Tickets/Map layer as first-class Modern screens, while keeping related tickets, confirmations, Google Maps/Waze links, and extractable booking details one tap away from Today and Journey cards.

## PR #28 code review — 2026-09-02

Branch `feat/trip-site-spa` → base `docs/trip-fleet-control-plane-plan`. Review
covered the Modern React SPA (`trip-web/`), the SQL living-journey layer
(`server/living-journey.js`), the control-plane portal
(`control-plane/api/src/portal.ts`), the runtime gateway, migrations, and the
classic/modern split of `site/`.

### Findings (15, posted as inline comments on PR #28)

Security / data-leak: draft bookings leaking through `/api/today`,
`/api/itinerary/active`, `/api/confirmations/summary`, `/api/operations/flights`
(only `/api/bookings` was filtered); service worker caching authenticated
per-user API responses by URL; `redeem method:"google"` accepting the session
cookie with no CSRF token.

Correctness / breaks-on-existing-systems: new schema appended to already-applied
migration `0020_web_portal.sql` (never runs on live DBs); `/v1/me` rotating and
revoking the session with no overlap window (forced logout on concurrent
requests); `server.js` static allowlist serving no `/` and nothing under
`/modern/**` (modern trip unreachable through the gateway).

Correctness / data-loss: `updateLegacyFromActive` rebuilding `phase_plan_*` from
scratch on every Modern edit (destroyed Classic correction/enrichment history);
`syncFromLegacy` no-op digest guard comparing mismatched object shapes (every
legacy write forked a new immutable revision); `recomputeQualityIssues`
reverting `ignored` issues to `open`.

Input handling: `site_invites` unhandled unique-violation → 500; `parseCookies`
`decodeURIComponent` throwing on a malformed `%` → 500; PATCH itinerary item
coercing `""` → NULL on NOT NULL columns; gateway returning 503 for an auth
failure; falsy-zero skipping a map stop on the equator/prime meridian;
`booking_id:""` stored as `0`.

### Fixes — all landed on `feat/trip-site-spa`

- `a6405fa` "Address trip SPA review findings" — the bulk: booking-read filters,
  `0027_web_portal_addenda.sql` forward migration (0020 reverted), `/v1/me`
  rotation removed, `/` + `/modern` static routes, invite 409, cookie/parse
  guards, PATCH validation, quality-issue `ignored` preserved, `Number.isFinite`
  lat/lng, `booking_id` empty-string guard, service-worker no longer caching
  `/api/*` (cache bumped `v1`→`v2`). Also shipped regression tests for the
  draft-leak (`tests/booking-extract-proxy.test.js`), the invite-409 and
  google-redeem-CSRF (`control-plane/api/test/portal-db.test.ts`), and the
  ignored-issue path.
- `ebafa98` "Distinguish launch rejection from gateway failure" — gateway maps a
  4xx control-plane rejection to 401, not 503.
- `6a56ce4` "Pin Modern→Classic itinerary reconcile in regression tests" — the
  `updateLegacyFromActive` rewrite (round 2) switched from delete-all+reinsert to
  a keyed upsert plus a `DELETE ... WHERE <key> NOT IN (...)` reconcile, using
  dedicated `itinerary_item_uid` / `itinerary_day_key` columns (partial unique
  indexes) kept separate from `config_ref`. This commit adds three tests to
  `tests/booking-extract-proxy.test.js`: a Modern item projects into the Classic
  plan, a deleted Modern item does not resurrect, repeated edits do not
  duplicate. Verified the no-resurrection test fails when the item reconcile
  delete is disabled.

### Still open / to confirm

- **`/v1/me` behavior change** (`a6405fa`): sessions no longer get a sliding
  lifetime — hard expiry at `session_ttl_seconds` (default 604800 = 7 days) from
  creation. Confirm fixed-lifetime sessions are intended; otherwise add a
  refresh endpoint or a grace-window rotation.
- **`updateLegacyFromActive` adoption edge**: a config day with no `date`
  promoted via the Classic endpoint gets `config_ref = 'phase|d0|3'`, which the
  adoption regex `/^[^|]+\|\d{4}-\d{2}-\d{2}\|\d+$/` rejects → that one row would
  not be adopted and could duplicate on first Modern edit. Narrow; relax the
  match to "any non-null `config_ref` equal to `source_ref`" if it matters.
- **No regression test** for `syncFromLegacy`'s no-op guard (#11) — the digest
  projection is now shape-matched but nothing pins it. The service-worker fix
  (#8) is also only covered by reading the file, not a test.
- **Control-plane suite not run locally.** `control-plane/api/test/{migrations,
  portal-db}.test.ts` need `CONTROL_PLANE_TEST_DATABASE_URL` (Postgres). The
  migration-list assertions were updated in `a6405fa` for `0027_*` — run that
  suite against a DB before merge.

### Validation (2026-09-02)

- `cd tests && npm test` → **412 passed, 0 failed** (includes the 3 new
  reconcile tests).
- `control-plane/api`: `npm run build` (tsc) clean; `npm run test:unit` 19/19;
  DB-backed tests skip without Postgres.
- Worktree gotcha: `server/node_modules/better-sqlite3` in this worktree carries
  a stale native ABI (NODE_MODULE_VERSION 115 vs 127) and needs
  `cd server && npm rebuild better-sqlite3` before the suite will boot — it can
  revert between runs; rebuild if the test server "exited with code 1 before
  becoming ready".

### Branch / worktree state for the next session

- `6a56ce4` is committed on local `feat/trip-site-spa` but **not pushed**
  (`origin/feat/trip-site-spa` is at `1226233`). Push when ready.
- The `trip-site-spa` worktree is normally on `integration/sprint-5-plus`; it was
  borrowed to make this commit and switched back. `git checkout feat/trip-site-spa`
  there (it is checked out in no other worktree) to continue.
- A pre-existing staged change to
  `control-plane/worker/control_plane_worker/provisioner.py` was left untouched
  and out of every commit above.
