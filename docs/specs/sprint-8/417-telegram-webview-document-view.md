# Viewing a document inside Telegram's in-app browser

Status: draft, refreshed against 4510301 (2026-10-30) · Issue: #417 · Track: T5 · Size: M · Tier: High
Security path: yes (`server/server.js` document routes — a new credential in a URL; auth scoping) · Migration: no · Live-trip behaviour: yes (trips built or rebuilt after the release)

> **Sprint 8 (2026-10-30): stretch** — only if the in-scope items are done.

## Problem

Found in Dror's gate-3 manual test, 2026-10-18 (`main` @ `81cafd3`, raw note
`$KINERARY_NOTES_DIR/run-notes/2026-10-18-gate3-manual-test.md`, finding 4):
opening the trip site from a Telegram link, signing in, and tapping a
document's **view** action shows nothing inside Telegram's in-app browser. The
same tap works in Safari and in the installed PWA. Not a blocker by Dror's
call; T5 owns it.

### How "view" works today

Both trip clients use the same flow, because a plain `<a href>` cannot carry
the bearer token kept in `localStorage`:

- Modern: `AuthenticatedDocumentAction` in `trip-web/src/App.tsx:1220-1253`
  → `getAuthenticatedDocument()` (`trip-web/src/api.ts:362-368`, which since
  #478 fetches `runtimeUrl(path)`).
- Classic: `openAuthedBlob()` / `downloadAuthedBlob()` in `site/app.js:2796`
  and `:2812`.

1. `fetch(url, {Authorization: Bearer …})` against
   `GET /api/bookings/confirmation/:fn` (`server/server.js:2832`, `authRequired`,
   served by `protectedDocumentResponse`, `:2760`: `Content-Disposition: inline`
   with the #357 UTF-8 `filename*` at `:2790`, `Cache-Control: private,
   no-store`, `nosniff`).
2. `URL.createObjectURL(blob)` → a `blob:` URL.
3. If **not** standalone **and** `navigator.userActivation.isActive`:
   `window.open(blobUrl, "_blank", "noopener")`. Otherwise
   `location.assign(blobUrl)` in the same tab.
4. "Download" builds an `<a download>` on the `blob:` URL and clicks it.

### Most likely cause (to be confirmed in step 0 of the build)

The three observations line up with step 3's branch:

| Client | Branch taken | Result |
|---|---|---|
| Safari | activation still live → `window.open` → new tab | works |
| Installed PWA | standalone → `location.assign(blob:)` | works |
| Telegram in-app browser | not standalone, activation live (recent WebKit exposes `userActivation`) → `window.open` | **nothing** |

An embedded browser opens a new window only if its host app implements that
(on iOS, the WKWebView UI delegate's create-window call). When it does not, the
call is dropped silently — and with `noopener` the page cannot even tell, which
the code comments already note. A second candidate, not excluded: the host may
refuse top-level navigation to non-`http(s)` schemes such as `blob:`. And on
Android, a WebView does not render PDFs inline at all and cannot hand a `blob:`
URL to the system downloader.

Both candidates share one fix: **do not depend on popups or on `blob:` URLs
for viewing.**

### What changed on main since 03c0e1c: two ways to reach a trip site

The organizer web release (#478) added a second way to reach a trip site: the
**runtime gateway** (`control-plane/runtime-gateway/server.js`). The portal and
the #359 Mini App launch it with a **top-level** form POST
(`web/src/pages/ProductApp.tsx:312-318`), not an iframe. The gateway serves the
trip site under `/t/<trip_id>/…` on one shared origin and marks every response
`X-Frame-Options: DENY` / `frame-ancestors 'none'` (`:295-301`: "The trip site
is a top-level page now; nothing frames it"). The 2026-10-19 draft's "iframe
the portal and the Mini App embed" was wrong for main.

How the gateway changes this spec:

- **Auth is a cookie there, not a bearer in `localStorage`.** The gateway keeps
  the runtime JWT in an encrypted HttpOnly `SameSite=Strict` cookie and injects
  `Authorization: Bearer …` upstream on every proxied request (`:288`).
  `site/runtime-base.js` stores only a marker in `localStorage` (`:29-31`) and
  rewrites root-relative `fetch`/XHR/`EventSource`/`src`/`href` to the
  `/t/<id>` base (`window.runtimePath`, `:6-9`, `:50-62`). So on the gateway a
  plain same-tab navigation to `runtimePath('/api/bookings/confirmation/<fn>')`
  is already authenticated, with no signature.
- **A signature does not get through the gateway on its own.** The gateway
  checks the cookie before proxying; without one, a page navigation gets a 303
  to the portal and anything else gets `401 AUTHENTICATION_REQUIRED` (`:360-369`).
  So "Telegram's Open in Safari works on the signed link" holds only on a
  trip's **own hostname**, not on the gateway, where it lands on the portal's
  sign-in. The gateway does forward the query string (`:287`, not `:146` as the
  draft said), so a signed link used in-app works there too, and is merely
  redundant.
- **The Mini App is a Telegram WebView.** In it, the trip site runs top-level
  on the gateway origin, so a view tap meets the same `window.open` branch, and
  probably the same nothing. The Mini App SDK's `openLink`
  (`web/src/mini-app/sdk.ts:7`) hands a URL to the external browser, which has
  no gateway cookie.

Nothing on main fixes the view action itself: `window.open(blob:)` is still
the branch in both clients (`App.tsx:1242-1243`, `site/app.js` `openAuthedBlob`).
`server/file-token.js` is unchanged and still hard-codes the photo label (`:26`).

## Behaviour

Tapping **view** on a document in either trip client, in any of Telegram's
in-app browser, Safari, Chrome, or the installed PWA, shows the document — or,
where the host truly cannot display it, opens it in the system viewer — and
never does nothing silently. The page navigates in the same tab to a
short-lived, single-file, signed `https` link to that document on the same
origin, so it works wherever a normal link works. On a trip's own hostname,
Telegram's own "Open in Safari / browser" menu item works on it too (until it
expires); through the runtime gateway, an external browser has no gateway
cookie and lands on the portal's sign-in instead.
**Download** uses the same signed link with an attachment disposition.

## Acceptance criteria

- AC-0 (investigation, first) The cause is confirmed on a real iPhone in
  Telegram's in-app browser on the current `main` build, **both** on a trip's
  own hostname and through the runtime gateway (Mini App launch): with a remote Web
  Inspector, or by temporarily forcing each branch on a staging build, record
  which of `window.open` / `location.assign(blob:)` fails. The result is written
  into this spec (spec PR) before code. If neither is the cause, stop and
  re-spec.
- AC-1 Given a signed-in member and a document they can already `GET`, when they
  call `POST /api/bookings/confirmation/:fn/link`, then `200 {url}` where `url`
  is `/api/bookings/confirmation/<fn>?exp=<unix>&sig=<hex64>[&dl=1]`, valid for
  a short TTL (default 120 s). Anonymous → `401`. A name that is not a bare
  filename, or a file that does not resolve, → `404` with no signature minted
  (no probing).
- AC-2 `GET /api/bookings/confirmation/:fn` serves the file when the request is
  authenticated as today **or** carries a valid, unexpired signature for exactly
  that filename (same pattern as `photoFileAccess`). Expired, tampered, wrong
  filename, malformed `exp`/`sig`, or a **photo** signature → `401`, never the
  file. A document signature is not accepted by `/api/photos/file/:fn` either.
- AC-3 Signed responses carry the existing headers (`nosniff`,
  `private, no-store`, the UTF-8 `filename*` from #357) plus
  `Referrer-Policy: no-referrer`; `dl=1` switches the disposition to
  `attachment`, anything else is `inline`. Active-content extensions keep their
  `application/octet-stream` type.
- AC-4 Modern (`AuthenticatedDocumentAction`) and Classic (`openAuthedBlob`,
  `downloadAuthedBlob`) **view** never call `window.open` and never navigate to a
  `blob:` URL: they mint a link and `location.assign` it in the same tab,
  passed through `runtimeUrl()` / `window.runtimePath()` so that under the
  gateway it carries the `/t/<id>` base (the server returns a root-relative
  path and knows nothing of the base).
  **Download** mints with `dl=1` and assigns it. A failed mint shows a visible
  error (Modern's `form-error`; Classic gets one) — never a silent catch.
- AC-5 The same flow works under the runtime gateway (a top-level page on the
  gateway origin, launched from the portal or the Mini App): the mint
  `POST` and the signed `GET` both go through `/t/<id>/…`, the gateway forwards
  the query string (`control-plane/runtime-gateway/server.js:287`), and the
  document is served. A `runtime-gateway/test/gateway.test.js` case proves the
  query string reaches the upstream unchanged. Opened outside the gateway's
  cookie (an external browser), the link lands on the portal, not on the file:
  recorded in AC-6, not a failure.
- AC-6 **Device acceptance (owed, Dror + staging):** a PDF and an image
  confirmation, view and download, on: iPhone — Telegram in-app browser, Safari,
  installed PWA, and the #359 Mini App runtime; desktop Chrome/Safari; Android
  Telegram if a device is available. Each row records the served revision and
  "shows / system viewer / nothing". "Nothing" anywhere is a failure.
- AC-7 Pages that list documents (`/api/trip-documents`, bookings, journey) do
  not embed signed links; links exist only after a click, one file at a time.

## Contracts

- **New route (trip site):** `POST /api/bookings/confirmation/:fn/link`
  (`authRequired`) → `{url}`. Optional body `{download: true}` → `dl=1`.
- **Changed route:** `GET /api/bookings/confirmation/:fn` gains signature
  access (AC-2) and the `dl` parameter (AC-3).
- **Signing:** a second instance from `server/file-token.js` under its own label
  (`kinerary:document-file:v1`), key derived from `JWT_SECRET` like the photo
  key, TTL 120 s. Today the factory hard-codes `kinerary:photo-file:v1`
  (`:26`); it gains the label as a parameter (default unchanged), so photo and
  document keys can never cross; existing photo signatures keep verifying.
- **Clients:** `trip-web/src/App.tsx` (`AuthenticatedDocumentAction`),
  `trip-web/src/api.ts` (a `getDocumentLink()` call), `site/app.js`
  (`openAuthedBlob`, `downloadAuthedBlob`, the delegated click handler).
- **Runtime gateway:** no code change expected; one new test (AC-5).
- **No change:** `/confirmations/*` legacy routes, the catch-all document route,
  Apple Wallet `.pkpass` handling (see Non-goals).

## Non-goals

- Rendering PDFs in-page (pdf.js) — a larger change, only if AC-6 shows Android
  Telegram cannot open the signed link at all (open question 2).
- Detecting Telegram from the user agent — unreliable on iOS, and not needed
  once nothing depends on popups.
- Apple Wallet passes inside embedded browsers (host must support PassKit).
- Moving trip sites to cookie sessions. Under the runtime gateway this is
  already true (see "What changed on main"), and plain links work there without
  a signature. T4 (one origin, unscheduled and to be re-specced) may make it
  true everywhere; this fix must not block it, and T4 should revisit whether
  the signature is still needed.

## Security and boundary notes

- **Auth scoping:** minting is exactly as wide as reading — `authRequired`,
  the scope `GET /api/bookings/confirmation/:fn` already has. A signature never
  widens access: it is bound to one filename, expires in 120 s, and is minted
  only for a file the caller can already read.
- **A credential in a URL.** The signed link will appear in browser history, in
  Telegram's in-app browser, and in proxy access logs. It carries no session and
  no user identity, names one file, and expires in two minutes. That is
  deliberately narrower than the photo links (one hour) because confirmations
  carry passenger names and booking references. The session JWT never goes in a
  URL (the existing comment in `site/app.js` stands).
- **On the gateway's shared origin** the signed link is still bound to one
  file and one trip's signing key (each trip site derives its own from its own
  `JWT_SECRET`). A link copied from one trip's base into another's fails the
  signature check there. Include that pair in the boundary review.
- **Fail safe:** anything but a well-formed, unexpired, matching signature
  falls through to `authRequired`, and is refused there (the `file-token.js`
  stance, unchanged).
- `boundary-reviewer` reviews before merge, with real request/response for:
  anonymous mint, member mint, expired/tampered/cross-label signatures, path
  names (`..`, `%2f`, absolute).

## Test plan

Written first:
- `tests/` (trip-site suite): new `document-link.test.js` — AC-1 to AC-3,
  including cross-label refusal both ways and an expiry using an injected clock
  (as `gallery-hardening.test.js` does with `createFileTokens(...).sign(fn, past)`).
- `tests/booking-xss.test.js` (covers `openAuthedBlob` today): view and download
  never call `window.open` and never assign a `blob:` URL.
- `trip-web/src/DocumentActions.test.tsx`: replace the "view opens a window"
  expectation with "view assigns the minted link; `window.open` is never
  called"; download assigns the `dl=1` link; mint failure renders the error.
- `trip-web/src/UpcomingActivity.test.tsx`: same expectation where it touches
  `userActivation`.
- `control-plane/runtime-gateway/test/gateway.test.js`: a query string on a
  proxied `GET` reaches the upstream unchanged (AC-5).
- Manual: AC-0 and AC-6 on staging.

## Rollout and regression

Trip-site code: reaches a trip only when it is built or rebuilt from a release
containing it — existing live trips keep the current behaviour until redeployed
(each redeploy an approved step). No control-plane change. Regression plan:
needed (security path in `server/server.js`); small blast radius — document
view/download only.

## Open questions

1. Desktop behaviour: same-tab for view everywhere (simplest, proposed), or keep
   a new tab on desktop browsers only? A new tab needs a reliable "is desktop"
   test, which is what failed here.
2. If Android Telegram does nothing with an inline PDF link, is the fallback
   "attachment" (system download) acceptable, or is in-page rendering wanted?
3. TTL 120 s — enough for a slow mobile network with a 50 MB PDF? (The TTL only
   has to cover the start of the request, not the transfer.)
4. (New, 2026-10-30) Under the runtime gateway the cookie already
   authenticates a plain link. Should the client skip the mint there (two code
   paths, no signature on the shared origin), or always mint (one code path,
   the signature redundant on the gateway)? Proposed: always mint, for one
   path to test.
5. (New) Which access path matters for acceptance? Families on a live trip
   reach it by its own hostname. Organizers now arrive through the portal or
   Mini App, via the gateway. AC-6 lists both; confirm both are required.
