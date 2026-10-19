# One origin S1: trip runtime under a base path, with per-trip session isolation

Status: draft (2026-10-19) · Issue: none yet (`x-`) · Track: T4 · Size: M · Tier: High
Security path: yes (`authRequired` / `organizerOrAgentRequired` JWT verification, session storage, CSP) · Migration: no · Live-trip behaviour: no (inert until a trip's `PUBLIC_BASE_URL` carries a path)

Umbrella: `x-one-origin-trips.md` (decisions D1–D5 and the security model).

## Problem

The trip server and both front-ends assume they own an origin.

- **Session storage is origin-wide.**
  - Classic reads and writes the bare keys `trip-token`, `trip-user`,
    `trip-lang` and `avatar_<user>`. `getItem('trip-token')` alone appears 36
    times in `site/app.js`.
  - Modern does the same in `tokenStore` (`trip-web/src/api.ts:6-24`), which on
    purpose mirrors the token between `tripToken` and `trip-token` so that
    "Classic and Modern share an origin" (`:14-16`).
  - The gateway shim writes the bare `trip-token` marker (`site/runtime-base.js:13`)
    and on logout clears the bare keys (`:24`).
  - With two trips on one origin, each sign-in overwrites the other's.
- **Tokens are not bound to a trip.** Every JWT is signed as `{ username }`, valid
  for 30 days (`server/server.js:1526`, `:1541`, `:1619`). Verification checks
  only the signature and `validManagedPayload` (`:761-762`, `:958-960`;
  `server/control-plane-auth.js:64-73`). Isolation between trips rests entirely on
  each container's random `JWT_SECRET` (`provisioning/adapters.py:441`). If a trip
  runs on the built-in default (`server/server.js:67`), its tokens are valid on
  every other default-secret trip.
- **Server-built absolute URLs ignore any prefix.**
  - `/photo/:id` builds its Open Graph URLs from `PUBLIC_ORIGIN` or the request
    host (`server/server.js:2422`).
  - Classic builds its Facebook share link from `location.origin + shareUrl`
    (`site/app.js:2049`).
  - Modern builds its enrollment link correctly, from `runtimeUrl("/")`
    (`trip-web/src/App.tsx:2438`).
- **The Modern service worker is not trip-scoped in its cache.** Its cache is
  named `kinerary-modern-v3`, and `activate` deletes **every** other cache on the
  origin (`trip-web/public/modern-sw.js:1`, `:8-13`). On one origin, each trip's
  upgrade would wipe the other trips' shells.
- **There is no CSP on trip pages.** The only CSP is on uploaded or SVG content
  (`server/server.js:1511`, `:1849`). The variant loader in `site/index.html` is an
  inline `<script>`, and `site/app.js` builds three `onclick=` strings.

What already works and is kept:

- `runtime-base.js` derives the `/t/<id>` base and rewrites `fetch`, XHR,
  `EventSource` and `src`/`href`/`action` (`:3-4`, `:34-66`).
- `trip-web` builds with `base: "./"`, its manifest is relative
  (`server/site-icons.js:47`), and its service worker registers relatively
  (`trip-web/src/main.tsx:21`).

## Behaviour

- Path mode is on when the trip's `.env` has `PUBLIC_BASE_URL=https://<host>/t/<trip_id>`,
  a URL with a path. Otherwise everything behaves exactly as today.
- In path mode:
  - the site, the API, SSE, uploads, file links and share pages all work under
    `/t/<trip_id>/`;
  - every browser-stored value is namespaced to the trip;
  - tokens carry and require `aud = <trip_id>`;
  - a CSP header goes out, report-only.
- Signing into trip A and then trip B in the same browser leaves both signed in.
  Signing out of B leaves A signed in.
- On a legacy subdomain (no base path), storage keys stay the bare names, so a
  traveller who is already signed in stays signed in after the S1 redeploy.

## Acceptance criteria

- **AC-1. Path mode turns on only from config.**
  - Given `PUBLIC_BASE_URL` with path `/t/trip_abc12345`, the server logs path
    mode and its base at boot.
  - Given no `PUBLIC_BASE_URL`, or one with no path, it does not.
  - An `X-Forwarded-Prefix` request header never turns path mode on or changes
    the base.
- **AC-2. No default secret in path mode.** Given path mode and
  `JWT_SECRET` unset or equal to the built-in default, the server exits non-zero
  at boot with a message naming `JWT_SECRET`.
- **AC-3. Trip-bound tokens.**
  - Given path mode, a token issued by `/api/auth/login`, the Google login or the
    Telegram login carries `aud` equal to the configured trip id.
  - `authRequired` and `organizerOrAgentRequired` answer 401 `invalid_token` to a
    token signed with the right secret but with a missing or different `aud`.
  - Outside path mode, a token without `aud` is still accepted, so legacy sessions
    survive.
  - The trip id comes from `TRIP_ID`, or from `tripId` in
    `control-plane.identity.json` when that is present. If both are present and
    disagree, the server refuses to boot.
- **AC-4. Namespaced storage, both front-ends.**
  - Given the page is served under `/t/trip_A/`, every `localStorage` key the
    page writes starts with `kin:trip_A:`.
  - Given no base, the keys are the bare names used today, byte for byte.
  - A test fails if `site/app.js`, `site/trivia.html`, `site/index.html` or
    `trip-web/src/**` (tests excluded) calls `localStorage` or `sessionStorage`
    directly, rather than through `window.tripStorage` (classic) or `tripStorage`
    (Modern).
- **AC-5. Two trips, one browser.** In a jsdom test with two simulated bases:
  - sign into A, then B: both tokens are present under their own namespaces;
  - `tokenStore.clear()` / classic logout on B leaves every `kin:trip_A:` key in
    place;
  - `runtimeLogout` (`runtime-base.js:16-31`) removes only its own trip's keys.
- **AC-6. Prefixed absolute URLs.** In path mode:
  - the `/photo/:id` page's `og:image` and `og:url` start with `PUBLIC_BASE_URL`;
  - classic's Facebook share URL includes `/t/<trip_id>`;
  - the `href` that trivia sets in `site/app.js` resolves under the base (it does
    today, through the shim's childList rewrite; the test pins it).
- **AC-7. Service worker scoped to its trip.** In path mode the Modern worker's
  cache name includes the trip's base path, and `activate` deletes only caches
  carrying its own base prefix. A test with two trips' cache names shows that
  activating A leaves B's caches alone.
- **AC-8. CSP, report-only.**
  - In path mode every HTML response from the trip server carries
    `Content-Security-Policy-Report-Only` with the policy in Contracts.
  - `site/index.html` has no inline `<script>`, and `site/app.js` has no
    `onclick=` string.
  - Loading `/`, `/modern/` and `/classic.html` under the base in the test suite's
    headless check produces no CSP violation report.
- **AC-9. Upload-serving routes keep their sandbox.** A test per file-serving route
  (`/api/photos/file/:filename`, `/confirmations/*`, the document-download route
  near `server/server.js:2735-2743`, `/api/trip/logo`) asserts `nosniff`. For an
  active-content name it also asserts `CSP: sandbox` and a non-renderable
  `Content-Type`, both under the base path and without it.
- **AC-10. Unchanged without the flag.** The existing `tests/` suite passes with no
  `PUBLIC_BASE_URL`, and no existing assertion about storage keys or token shape
  changes.

## Contracts

- **New `.env` keys for the trip container** (written by provisioning in S3; by
  hand for S2's test trip):
  - `PUBLIC_BASE_URL`: `https://<RUNTIME_HOST>/t/<trip_id>`, no trailing slash.
    When it has no path it is equivalent to today's `PUBLIC_ORIGIN`.
    `PUBLIC_ORIGIN` keeps its current meaning for trip-mcp.
  - `TRIP_ID`: optional. Required in path mode when there is no identity sidecar.
- **JWT claims:** `{ username, aud: <trip_id> }` in path mode. Verification passes
  `{ audience: <trip_id>, algorithms: ['HS256'] }`. Managed-session tokens
  (`control-plane-auth.js`) get the same `aud`.
- **Front-end storage helper.**
  - `site/runtime-base.js` exports `window.tripStorage` with `{ get, set, remove,
    keys }` over `localStorage`, using prefix `kin:<trip_id>:` when the base is
    set and `''` otherwise.
  - `trip-web/src/storage.ts` wraps the same global, with a fallback when it is
    absent (dev server).
  - `tokenStore` keeps its `tripToken`/`trip-token` mirroring *inside* the
    namespace.
- **Gateway CSRF header:** `runtime-base.js` adds `X-Kinerary-Trip: <trip_id>` to
  same-trip requests when a base is set. S2's gateway checks it. The trip server
  ignores it.
- **CSP (report-only in S1, enforced by the gateway in S2):**
  `default-src 'self'; script-src 'self' <GIS host> <Telegram widget host>;
  style-src 'self' 'unsafe-inline' <GIS style host>; img-src 'self' data: blob:
  https:; connect-src 'self' <GIS host>; frame-src <GIS host> <Telegram host>;
  object-src 'none'; base-uri 'none'; form-action 'self'`.
  - The host list is a constant in `shared/` with a comment for each entry.
  - `style-src 'unsafe-inline'` is a known concession: both front-ends set inline
    styles. Removing it is not in scope.
- **Files expected to change:**
  - `server/server.js` (boot checks, `jwt.sign`/`jwt.verify` sites,
    `/photo/:id`, CSP header);
  - `server/control-plane-auth.js`;
  - `site/runtime-base.js`, `site/index.html` (+ a new `site/variant-loader.js`
    and its `CLASSIC_STATIC_FILES` entry, `server/server.js:39-54`), `site/app.js`
    (storage calls through `tripStorage`, the share URL, the `onclick`s);
  - `trip-web/public/runtime-base.js` (kept identical to `site/`),
    `trip-web/public/modern-sw.js`, `trip-web/src/api.ts`, a new
    `trip-web/src/storage.ts`, `trip-web/src/App.tsx` (the `tripLang` and
    `trip-user` calls), `trip-web/src/parity-ui.tsx`;
  - `shared/` (CSP host constant);
  - `tests/` and `trip-web/src/*.test.*`.

## Non-goals

- The gateway (S2), provisioning (S3), any live trip (S4).
- Moving tokens out of `localStorage` into cookies. On one origin that buys no
  isolation (see the umbrella), and it would add CSRF exposure to direct mode.
- Removing `style-src 'unsafe-inline'`, and Trusted Types.

## Security and boundary notes

- `authRequired` is the **"not an organizer check"** path (CLAUDE.md). This slice
  adds an audience check to it and to `organizerOrAgentRequired` without changing
  who either admits.
- The agent `X-API-Key` path is untouched.
- `sanitizeConfig()` is untouched. No trip-URL field is added to served config:
  the `url` fields in `shared/config-visibility.js` (`:91-92`, `:122`, `:146`)
  are venue links, and the base comes from the page's own location.
- **boundary-reviewer evidence required:**
  - a request with trip B's token (right secret but `aud=trip_B`, minted in the
    test harness) to trip A answers 401;
  - a request with a no-`aud` token in path mode answers 401;
  - the same request outside path mode answers 200;
  - real response headers for one upload route in each mode.

## Test plan

Write the tests first, from the ACs:

- `tests/base-path.test.js`: AC-1, AC-2, AC-3, AC-6, AC-8 server half, AC-10.
- `tests/upload-headers.test.js`: AC-9.
- `tests/storage-isolation.test.js` (jsdom, loads `site/runtime-base.js` and the
  storage paths in `site/app.js`): AC-4 classic half, AC-5 classic half.
- `trip-web/src/storage-isolation.test.ts`: AC-4 and AC-5, Modern half.
- `trip-web/src/modern-sw.test.ts`: AC-7.
- `tests/no-direct-storage.test.js`: the grep guard in AC-4.
- Suites: `cd tests && npm test`, `trip-web` `npm test` + `npm run build`
  (`site/modern` is rebuilt), and `scripts/preflight-deploy.sh` (default mode).
- Manual: none. S2 is the first real browser run.

## Rollout and regression

- No live trip feels this until it is redeployed **and** given a base path.
- Redeploying a live trip with S1 but no `PUBLIC_BASE_URL` keeps every session,
  because the bare keys are unchanged (AC-4, AC-10).
- A regression plan is required: this touches the auth path and
  `server/server.js`, a security path under the MVP rules.

## Open questions

- Inherits Q1 and Q4 from the umbrella.
- Should `TRIP_ID` be required in path mode even when the identity sidecar
  exists, so there is one source? The proposal is "sidecar wins, env is the
  fallback, disagreement refuses to boot".
