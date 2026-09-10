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

## Hero reliability follow-up — 2026-09-09

Modern previously put the chosen URL directly into a CSS background. Uploaded
heroes live behind `authRequired`, so direct browser requests lacked the bearer
token; gateway-relative CSS URLs also bypassed `runtimePath`. The `||` chain
selected the first nonempty URL without checking whether it loaded, and the
transition removed the old image after 900 ms regardless of replacement readiness.

`trip-web/src/hero-photo.ts` now authenticates same-origin image requests, uses
the runtime prefix, validates image MIME and decoding, and only then swaps the
visible photo. External image requests never receive the trip bearer token.
Failed candidates fall through to other configured photos; failed/slow changes
retain the last decoded photo. Retries are bounded and restart on reconnect;
obsolete loads cannot replace the current selection. Decoded-image memory is
bounded and private object URLs are released on unmount, not stored persistently.

The SPA regression suite now includes nonempty hero fixtures, authenticated
loading, gateway routing, invalid responses, timeouts, fallback ordering, and
stale-load races. `tests/hero-http.test.js` checks the actual protected upload/read
contract. Verification completed on 2026-09-09 after the temporary test-server
restriction cleared: 36 SPA tests, TypeScript, and the isolated HTTP test pass.
The HTTP test sees 401 without authentication and matching PNG bytes with it.
Chrome rendered a real configured Japan photograph after uploading a temporary
copy into the fixture trip's protected media storage, and loaded it again after
refresh. An intentionally corrupt replacement then left the same decoded image
visible (same blob URL); screenshots confirmed the photograph remained on screen.
The browser check used the direct local runtime; gateway path mapping is covered
by the loader regression test. No deployment or live-trip photo replacement was
performed.

Third-party image URLs remain an external dependency. To remove that source of
outages, selected originals must be copied into durable trip-owned media storage
(with source/credit retained), then checked during deployment. The loader fixes
do not claim that an external provider will keep serving a URL indefinitely.

## 3D map and parent integration — 2026-09-10

Merged `integration/sprint-5-plus` into `feat/modern-spa-next` at `27a38bd`
without conflicts, including the companion-scope template update.

The map now offers explicit 2D/3D switching. The opt-in 3D view loads
OpenFreeMap building extrusions; satellite imagery remains build-configured.
MapLibre's worker is emitted through Vite's worker pipeline so the production
bundle can load it. Trip markers and camera positioning no longer wait for a
third-party style or tiles, and a stalled 3D load offers a return to 2D.
Mode changes retain the selected stop and release the previous map and markers.
Camera animations respect the browser's reduced-motion preference.

Validation on the merged tree:

- 39 Modern SPA tests pass, including worker setup, markers before style load,
  selected-stop preservation, 3D readiness, timeout recovery, and cleanup.
- TypeScript and the production build pass.
- Repository preflight passes: trip-site tests, API build/unit subset, Python
  worker/provisioning, and organizer web tests/typecheck/build.
- Full API suite against the dedicated `cptest` database on port 5434:
  743 passed, 0 failed, 6 skipped.
- All 5 runtime-gateway tests pass, including SSE streaming, cookie isolation,
  and upstream cleanup.
- Chrome rendered 3D buildings from the production bundle against a disposable
  fixture runtime and switched back to 2D; no browser map errors were recorded.
- A real `add_budget_item` MCP call appeared in two open Modern Chrome tabs
  without reload. With an unsaved editor draft in the first tab,
  `delete_budget_item` removed the second tab's row while retaining the first
  tab's draft. Cancelling the editor applied the pending deletion.

**Gateway acceptance remains blocked, not passed.** A real POST to
`/api/internal/control-plane/session` on the fixture trip server returns
HTTP 404 (`Cannot POST /api/internal/control-plane/session`). The gateway
requires this endpoint for launch, while its isolated test supplies a stub.
This is the existing activation B3 gap in `docs/activation-scope.md`, not a
regression introduced by the map. The two-browser MCP check above used the
direct runtime, so it does not establish the full managed gateway login path,
the two-second gateway target, or deployed acceptance. No live deployment or
PR approval is recorded by this verification.


## Runtime session bridge — 2026-09-10

The B3 gap observed above is implemented in the working tree. The runtime now
binds control-plane identities to existing local accounts using a private
trip/owner manifest and a dedicated exchange key. Member invitations preserve
Classic passwords and cannot claim organizer accounts. Both interfaces share
the same identity, permissions, gateway cookie, and logout helper.

Real HTTP integration results against disposable runtime data:

- Missing, incorrect, traveler, and companion credentials cannot exchange a
  session (401). A correctly mapped owner receives a token (200).
- Wrong trip, identity, username, or role fails (403); conflicting invitation
  bindings fail (409); members cannot read the organizer brief (403).
- Gateway proxy access to internal routes fails (404). Removed participants'
  existing managed JWTs fail (401), and new exchanges fail (403).
- Two real gateway SSE streams receive an MCP write within the two-second
  test timeout; reconnect retrieves current state.

Chrome also verified the built portal → Modern → Classic path without a second
login, Classic and Modern logout returning to My trips, and a real MCP budget
write appearing in two Modern tabs through the gateway without reload. Only the
control-plane grant/route APIs were fixture responses; these checks do not
establish live-stack deployment acceptance.

Validation: runtime integration 8/8; gateway 5/5; portal DB 6/6; worker 76/76;
provisioning 34/34; organizer web 10/10; Modern 39/39; shared logout 3/3.
Repository preflight passed; final framing/logout refinements passed their
affected tests and production builds. DB tests used only `cptest` on port 5434.
Configuration and migration requirements are in
[runtime-session-exchange.md](runtime-session-exchange.md). No deployment or
PR approval was performed.

## PR #44 review fixes — 2026-09-11

Addressed the three findings on review 5172086172:

- Enrichment now creates a revision changing only the matching item's generated
  fields. Item types, durations, confirmation state, other items, and day context
  survive; the full Classic compatibility projection is no longer used here.
- Title edits reset the enrichment queue and discard only companion values that
  still match recorded generated output. Authored translations and links remain.
  The editor preserves its existing translation instead of submitting null on
  every save. Generation checks reject results from an older in-flight title.
  Existing values created before output tracking are conservatively retained:
  their authorship cannot be recovered from the old database schema.
- Booking creation retains the persisted ID and successful attachment uploads.
  Retrying a failed attachment reuses that ID, applies any intervening form edits,
  and skips completed uploads. The error explains that the booking already exists.

The three new HTTP regressions failed against the reviewed implementation and
pass with these changes. They use a disposable real trip server and stub model
service, including a delayed response across a title edit. Two UI regressions
cover failed confirmation upload, failed wallet upload after successful PDF
upload, edited fields on retry, and starting the next booking.

Validation: 168/168 related server tests (server, living journey, enrichment,
schedule review, trip events, and protected hero HTTP), 41/41 Modern SPA tests,
TypeScript, production build, and `git diff --check` pass. The HTTP suites retain
401 responses for unauthenticated/foreign-trip event reads and 403 responses
for family-member organizer-only writes. Production assets were regenerated.
The review fixes are isolated from the separate login/runtime-activation work.
The deployment target authorized for these fixes is the local Modern preview
at localhost:8081; live trip deployments remain outside this change.
