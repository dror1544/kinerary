# Organizer account sign-in and original confirmation PDFs

Status: draft (2026-10-19) · Issue: PR #357 (no separate issue) · Track: T5 · Size: L · Tier: High
Security path: yes (`server/server.js` config warnings and document routes; portal session/CSRF; trip-MCP tool visibility) · Migration: no · Live-trip behaviour: yes (new or redeployed trips only)

> **Landed in Sprint 7** through PR #478 and released 2026-10-27; PR #357 closed as landed. Kept as the acceptance record.

> **What this spec is.** #357 is already built (branch `carry/ca01-to-sprint6`,
> published head `9808def`, draft, targets `main`). This spec is the
> **acceptance contract for landing it on `main`**, not a redesign. A behaviour
> found to differ from it during acceptance is a spec PR first, then a code
> change on the branch, per `docs/specs/README.md`.

## Problem

An organizer who already has a canonical email/password account (every email
account holds a credential from birth — `password-identity.ts`) has no web way
to sign in, see their trips, start a trip and follow its real interview link:
the portal assumed Google sign-in, and with no Google client configured it had
no working entry at all. Separately, an organizer's assistant (ChatGPT/Claude
through trip-MCP) could describe a booking but could not hand back the
**original** confirmation PDF the booking was built from, and the trip site's
document downloads mangled non-ASCII filenames.

Evidence: PR #357 body; `$KINERARY_NOTES_DIR/regression-plans/2026-10-18-organizer-ui-miniapp-main.md`;
`$KINERARY_NOTES_DIR/test-reports/2026-10-18-organizer-ui-main-integration-review.md`
(integrator verdict "not ready for main yet", 2026-10-18 — superseded in part by
the published merge, see "Owed before merge").

## Behaviour

- An organizer opens the portal, signs in with email and password, sees the
  trips they own, creates a draft trip, and gets a working single-use interview
  link for it. Reloading and signing in again shows the same trips, no
  duplicates. Signing out ends the session.
- Google sign-in is optional: with no Google client configured, the portal
  says so (`/v1/auth/capabilities` → `{"google":false,"emailPassword":true}`)
  and email/password still works; the Google routes answer
  `503 GOOGLE_SIGN_IN_UNAVAILABLE` instead of crashing boot.
- An organizer can upload a confirmation file to a booking; a member cannot.
- An organizer's connected assistant can call `get_booking_confirmation`
  (trip-MCP) for a booking and receive the **exact original PDF bytes** (≤ 5 MiB)
  with byte count and SHA-256, or a fixed message pointing to the trip site
  when the file is larger or not a PDF. A member's assistant does not see the
  tool.
- Trip-site document downloads carry a UTF-8 filename (`filename*=`) beside an
  ASCII fallback.
- `GET /api/config/warnings` names a participant by index, never by username
  or any raw config value.

## Acceptance criteria

Each criterion names its evidence source. "Owed" ones are the gate.

**Account sign-in (portal, control-plane API)**
- AC-1 Given an active account with a password credential, when
  `POST /v1/auth/email-password` carries the right email/password from the
  portal origin, then a web session is created (session + CSRF cookies) and the
  response names a validated `appPath`; with a wrong password, an unknown
  email, an over-long field or a missing body the answer is `401
  INVALID_CREDENTIALS`, identical in shape for all four. *(focused portal tests;
  staging probe 2026-10-19: wrong password 401.)*
- AC-2 Given a request whose `Origin` is not the configured `web.public_origin`,
  when it posts credentials, then `403 ORIGIN_INVALID` and no session.
  *(staging probe: foreign Origin 403.)*
- AC-3 A login never creates an account or a credential; a disabled account
  (`users.status <> 'active'`) gets `401`. *(portal-db test.)*
- AC-4 More than 10 attempts per minute for one email, or 100 per minute per
  socket peer, get `429 SIGN_IN_RATE_LIMITED` with `retry-after: 60`; the
  limiter holds at most 1024 keys. *(portal unit test.)*
- AC-5 With no Google secret refs in the profile, the API boots, `/v1/auth/capabilities`
  reports `google:false`, and `/v1/auth/google/{start,callback}` return `503`.
  With both refs set it reports `google:true`; one ref without the other fails
  profile validation. *(server-boot tests.)*
- AC-6 Every mutating portal route refuses a missing or wrong CSRF token with
  `403`; another organizer's trip is `404` on read, interview-link issue/read,
  provisioning request, launch and site-invite. *(staging probe 28/28,
  2026-10-19.)*
- AC-7 Given an owner's trip, when they create it, reload and sign in again,
  then the same trip id is listed once and its state is unchanged; logout makes
  the old session `401`. *(staging probe; **owed: Dror's walk**.)*

**Original PDFs (trip site + trip-MCP)**
- AC-8 `POST /api/bookings/:id/confirmation` is organizer/agent only (member →
  `403 organizer_only`), refuses a booking that does not exist before writing
  any file, stores under a randomized filename, and a replaced file leaves no
  orphan after a race. *(tests/server.test.js, trip-documents.test.js.)*
- AC-9 `get_booking_confirmation` is registered only on the write (organizer)
  MCP surface; a member's OAuth tool list omits it and a direct invocation is
  refused with a structured error. *(boundary report 2026-10-18.)*
- AC-10 For a linked PDF ≤ 5 MiB, the tool returns a `resource` whose base64
  decodes to bytes whose SHA-256 equals the stored file's, plus the same
  `byte_count`/`sha256` in text; the binary is never passed through the text
  sanitizer. Over 5 MiB (by `Content-Length` or by actual count) or non-PDF →
  fixed message naming the trip site, no bytes. Any thrown error reaches the
  client through main's `toolError` sanitizer (Unicode tag characters
  stripped). *(confirmation-readback tests; boundary report: 41-byte fixture,
  SHA-256 `c3f36c2e…6e88` over real OAuth/MCP HTTP.)*
- AC-11 **Owed.** In the real ChatGPT client **and** the real Claude client,
  connected to a staging trip as its organizer, asking for a booking's
  confirmation returns the original file: the same SHA-256 as the stored
  synthetic fixture, recorded per client. A client that cannot accept a binary
  resource gets the booking-specific trip-site link instead, and that link
  opens the file after sign-in. Same fixture bytes across both clients.
- AC-12 Downloads from `/api/bookings/confirmation/:fn` carry
  `Content-Disposition: <inline|attachment>; filename="<ascii>"; filename*=UTF-8''<encoded>`
  and round-trip a Hebrew filename exactly. *(trip-documents test.)*

**Config warnings (blanket invariant)**
- AC-13 `GET /api/config/warnings` returns `{scope:'participant', participantIndex,
  severity, issue}` with severity normalized; no username, name or other raw
  `trip.config.json` value appears for any participant warning, and planted
  secret markers in config never appear in config, config-version, Hermes-status
  or itinerary responses. *(boundary report: three invariants, no findings.)*

**Merge-readiness**
- AC-14 The merge into `main` preserves every main-side protection the
  integrator's same-intent consult named (stop editing / `effectiveConfig()`,
  `deploymentNonce` privacy, `knownBookingPhase` validation, expired-approval
  recovery, Telegram username resolver, `visibleTags`/`toolError` sanitizing,
  dynamic test ports, newer suites in `tests/package.json`). Checked by
  reading the resolved diff against current `main`, not by a clean
  `merge-tree` alone.

## Contracts

- **Routes (control-plane API, mounted only when the profile has a `web` block):**
  `GET /v1/auth/capabilities`; `POST /v1/auth/email-password`
  (`{email, password, returnTo?}` → `{appPath}`); Google routes now optional.
  Existing `/v1/me`, `/v1/logout`, `/v1/trips*` unchanged in shape.
- **Profile:** `web.public_origin`, `web.runtime_origin` (must differ; `https://`
  in production), optional `web.google_client_id_secret_ref` +
  `web.google_client_secret_ref` (both or neither). Values live in the
  deployment's profile, never here.
- **Trip site:** `POST /api/bookings/:id/confirmation` (organizerOrAgentRequired);
  download headers as AC-12; config-warning shape as AC-13.
- **Trip-MCP:** tool `get_booking_confirmation({booking_id})` on the organizer
  surface; 5 MiB cap (`MAX_BYTES` in `server/trip-mcp/confirmation-readback.js`);
  organizer upload page `server/trip-mcp/confirmation-upload-page.js`.
- **Files:** the 28 paths in the PR (API `config.ts`, `password-identity.ts`,
  `portal.ts`, `server.ts`; `server/server.js`; `server/trip-mcp/*`; `web/src/*`;
  tests). No migration.

## Non-goals

Account registration and password recovery (the SPA redirects those routes to
sign-in); CA-02 account-wide assistant grants; interview, worker or relay
changes; the Mini App and link recovery (#359); fixing document display inside
Telegram's in-app browser (#417 — an acceptance observation here, not a claim).

## Security and boundary notes

- **sanitizeConfig / config warnings:** the warnings change *removes* the
  username from participant warnings and keeps the allow-list. No field is added
  to `shared/config-visibility.js`.
- **Auth scoping:** upload and the PDF tool are organizer-only
  (`organizerOrAgentRequired`, write MCP surface); `authRequired` is not used as
  an organizer check anywhere new.
- **Sessions:** login is origin-checked; mutations are CSRF-checked; a login
  never mints an identity (`resolveOrCreateEmailAccount` stays the only path).
- Boundary review: **done** on product-tested tree `7ba8d7f` (no findings,
  2026-10-18). Product paths on `9808def` are identical to it (published
  checkpoint). A fresh review is owed only if product paths change again.

## Test plan

Suites: `control-plane/api` (portal, portal-db, password-login-work,
server-boot), `tests/` trip-site suite (server, trip-documents,
confirmation-readback, trip-mcp, mcp-tag-output), `tests/connected-assistants`
fixtures, `web/` vitest + typecheck + build. All exist on the branch.

Manual, owed: AC-7 and AC-11 (Dror, staging); see the staging run note
`$KINERARY_NOTES_DIR/run-notes/2026-10-18-claude-staging-candidate-404ea2b.md`,
whose "Dror's acceptance run" section is still empty.

## Owed before merge

| Gate | State on 2026-10-19 |
|---|---|
| CI green on the merge ref | Six product suites **pass** on `9808def` (run 39157857319); `Assess deployment risk` **skipped** (draft; credentials missing, #323). `main` has since moved to `03c0e1c` (+#386 tests, +#421 doc); `git merge-tree` is clean. Re-run CI on the current merge ref before the merge decision, and read `main`'s last runs (CLAUDE.md "a green PR on a red base is not evidence"). |
| Full local API run | Not one clean run: 2682/2690 pass, 2 environment cancellations (Node ABI / missing `npm ci`) passed alone, 6 optional skips. Accepted as a known limit, or a clean run is owed — Dror's call (open question 1). |
| Boundary review | Done, no findings (above). |
| Regression plan | Required (auth path). The 2026-10-18 plan exists; it lacks a read-only fleet inventory and previous-revision list — owed before any deploy, not before the merge. |
| Staging acceptance by Dror | **Owed** — AC-7 and the account/trip rows of the staging test table. Staging is reported ready (28/28 probes, 2026-10-19). |
| ChatGPT/Claude original-PDF test | **Owed** — AC-11. |
| Integration order | #357 merges first; #359 is then re-checked against the actual `main`. |
| Owner approval | Merge to `main` is Dror's approval (CLAUDE.md MVP item 3 does not cover `main`). |

## Rollout and regression

- Control-plane API: takes effect on the next approved API restart **only where
  the profile carries a `web` block**; without one, the portal routes stay
  unmounted (`/v1/me` 404) — that is configuration, not a defect. Whether the
  production profile gets a `web` block is a separate, approved step.
- Portal (`web/`): next frontend release. Note: `web/nginx.conf` on `main`
  does not load (unquoted `{8,}` regex, found while preparing staging) — the
  web image will not start until that one-line fix lands; it needs its own
  issue.
- Trip site / trip-MCP: reaches only trips built or rebuilt from a release that
  contains it. An API restart does not change running trip containers.
- Regression plan: needed (auth + security paths) — see above.

## Open questions

1. Is the full API run's "2 environment cancellations recovered alone + 6
   optional skips" acceptable for the merge, or is one clean full run owed?
2. `admitLogin` keys the 100/min limit on `request.ip` with `trustProxy` off.
   Behind the ingress proxy every request has the proxy's address, so that limit
   is effectively global across all organizers (the 10/min per-email limit is
   unaffected). Accept for the MVP, or a follow-up issue?
3. Does the production control-plane profile get a `web` block in the same
   release, or does the portal stay staging-only for now?
4. Who files the `web/nginx.conf` regex issue, and does it land before #357?
