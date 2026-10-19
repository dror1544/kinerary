# Viewing a document inside Telegram's in-app browser

Status: draft (2026-10-19) · Issue: #417 · Track: T5 · Size: M · Tier: High
Security path: yes (`server/server.js` document routes — a new credential in a URL; auth scoping) · Migration: no · Live-trip behaviour: yes (trips built or rebuilt after the release)

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

- Modern: `AuthenticatedDocumentAction` in `trip-web/src/App.tsx` (~line 1218)
  → `getAuthenticatedDocument()` (`trip-web/src/api.ts:360`).
- Classic: `openAuthedBlob()` / `downloadAuthedBlob()` in `site/app.js` (~line 2760).

1. `fetch(url, {Authorization: Bearer …})` against
   `GET /api/bookings/confirmation/:fn` (`server/server.js:2783`, `authRequired`,
   `Content-Disposition: inline`, `Cache-Control: private, no-store`, `nosniff`).
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

## Behaviour

Tapping **view** on a document in either trip client, in any of Telegram's
in-app browser, Safari, Chrome, or the installed PWA, shows the document — or,
where the host truly cannot display it, opens it in the system viewer — and
never does nothing silently. The page navigates in the same tab to a
short-lived, single-file, signed `https` link to that document on the same
origin, so it works wherever a normal link works, and Telegram's own
"Open in Safari / browser" menu item works on it too (until it expires).
**Download** uses the same signed link with an attachment disposition.

## Acceptance criteria

- AC-0 (investigation, first) The cause is confirmed on a real iPhone in
  Telegram's in-app browser on the current `main` build: with a remote Web
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
  `blob:` URL: they mint a link and `location.assign` it in the same tab.
  **Download** mints with `dl=1` and assigns it. A failed mint shows a visible
  error (Modern's `form-error`; Classic gets one) — never a silent catch.
- AC-5 The same flow works under the runtime gateway (the iframe the portal and
  the Mini App embed): the gateway forwards the query string (it does today,
  `control-plane/runtime-gateway/server.js:146`) and the signed `GET` succeeds
  there; behaviour inside the Mini App iframe is recorded in AC-6.
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
  key, TTL 120 s. The factory takes the label as a parameter, so photo and
  document keys can never cross; existing photo signatures keep verifying.
- **Clients:** `trip-web/src/App.tsx` (`AuthenticatedDocumentAction`),
  `trip-web/src/api.ts` (a `getDocumentLink()` call), `site/app.js`
  (`openAuthedBlob`, `downloadAuthedBlob`, the delegated click handler).
- **No change:** `/confirmations/*` legacy routes, the catch-all document route,
  Apple Wallet `.pkpass` handling (see Non-goals).

## Non-goals

- Rendering PDFs in-page (pdf.js) — a larger change, only if AC-6 shows Android
  Telegram cannot open the signed link at all (open question 2).
- Detecting Telegram from the user agent — unreliable on iOS, and not needed
  once nothing depends on popups.
- Apple Wallet passes inside embedded browsers (host must support PassKit).
- Moving trip sites to cookie sessions — T4 (one origin) may make plain links
  work without a signature; this fix must not block it, and T4 should revisit it.

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
