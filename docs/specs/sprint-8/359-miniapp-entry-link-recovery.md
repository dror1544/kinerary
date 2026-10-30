# Telegram Mini App entry and interview-link recovery

Status: draft (2026-10-19) · Issue: PR #359, issue #358 · Track: T5 · Size: M · Tier: High
Security path: yes (portal session/CSRF; single-use enrollment tokens; Telegram launch data must grant nothing) · Migration: no · Live-trip behaviour: no (control-plane API + portal only)

> **Landed in Sprint 7** through PR #478 and released 2026-10-27; PR #359 closed as landed. Kept as the acceptance record.

> **What this spec is.** #359 is already built (branch
> `feat/sprint6-miniapp-recovery`, published head `89c2a52`, draft, targets
> `main`, stacked on #357). This spec is the **acceptance contract for landing it
> on `main` after #357**, not a redesign. Until #357 lands, the PR's displayed
> diff includes #357's work; this spec covers only the increment (16 paths over
> #357).

## Problem

1. **Lost interview link (#358).** An organizer who issues a single-use
   interview link and navigates away loses the browser's only copy (the token is
   never stored in plaintext). Asking for another returns
   `ACTIVE_ENROLLMENT_EXISTS`; there is no way out short of an operator reset.
2. **No Telegram entry.** Organizers and members live in Telegram, but reaching
   their trips meant leaving it for a browser. A Mini App entry is wanted that
   reuses the ordinary account and trip-password sessions — **without** Telegram
   identity becoming a credential (Telegram SSO is ruled out permanently).

Evidence: issue #358 body and brief; PR #359 body; `docs/telegram-mini-app.md`
(on the branch); `$KINERARY_NOTES_DIR/test-reports/2026-10-18-organizer-ui-miniapp-main-boundary.md`.

## Behaviour

- **Recovery.** On the trip setup page, when a link was issued but is unused,
  the owner sees that a link exists (never the token) and can explicitly replace
  it. Replacing revokes the old link in the same transaction and shows the new
  one once. If the interview has started, or the trip is no longer a draft,
  there is nothing to replace and the page says so honestly; the interview is
  never reset.
- **Mini App.** Opening the web app's `/mini-app` from Telegram shows "My trips"
  for a signed-in person, or the ordinary sign-in page with the Mini App path as
  its return. `?startapp=trip_<id>` (or `tgWebAppStartParam`) opens that trip's
  runtime if — and only if — the person's ordinary session already has access.
  Telegram's back button returns from a trip to the list. Outside Telegram the
  same pages work as a plain browser view.

## Acceptance criteria

**Recovery (control-plane API, `enrollment.ts` + `portal.ts`)**
- AC-1 `GET /v1/trips/:id/interview-link`: anonymous → `401`; signed-in
  non-owner → `404`; owner → `200` with `cache-control: private, no-store`,
  metadata (`enrollmentId`, expiry, `recoverable`) and **no token**.
  *(boundary report; staging probe 2026-10-19.)*
- AC-2 `POST /v1/trips/:id/interview-link/replace` with `{expectedEnrollmentId}`:
  missing/invalid CSRF → `403`; malformed id → `400 INVALID_REQUEST`;
  non-owner → `404 NOT_FOUND`; owner of an eligible draft with that unused
  enrollment → `201` with `{enrollmentId, deepLink, expiresAt}` and
  `cache-control: private, no-store`.
- AC-3 After a `201`, the old token fails verification (`REVOKED`), the new one
  verifies, and exactly one current link exists for the trip.
- AC-4 A second replace naming the now-revoked `expectedEnrollmentId` (stale
  tab, replay) → `409 ENROLLMENT_NOT_REPLACEABLE`; no third token is issued.
- AC-5 Once the replacement token is consumed and an interview has started, a
  replace → `409` (`INTERVIEW_ALREADY_STARTED` or `ENROLLMENT_NOT_REPLACEABLE`)
  and the active session's answers, facts and conversation are byte-for-byte
  unchanged. A trip past `draft` → `409 TRIP_NOT_DRAFT`.
- AC-6 Contention: replacement locks the enrollment row first (matching
  `consumeEnrollmentInTx`'s order), then trip/membership/user with `NOWAIT`; a
  lock conflict on the latter → `409 ENROLLMENT_BUSY`, never a `40P01` and
  never a hang beyond the enrollment-row wait. A concurrent consume + replace on
  the same enrollment ends with exactly one winner and a consistent state.
  *(enrollment tests, 220-test affected run.)*
- AC-7 Default issuance (`POST /v1/trips/:id/interview-link`) still refuses with
  `ACTIVE_ENROLLMENT_EXISTS` when an active enrollment exists — recovery is
  only ever the explicit replace call. No plaintext token is persisted, and no
  token appears in logs or error bodies.
- AC-8 The portal shows the explicit "replace link" action after
  `ACTIVE_ENROLLMENT_EXISTS`, states that the old link stops working, and never
  offers it on a started or non-draft trip. *(ProductApp tests; **owed: Dror's
  staging walk** — "lost unused link" and "active interview" rows.)*

**Mini App (`web/src/mini-app/*`, `App.tsx`)**
- AC-9 Selectors are untrusted routing hints: only `account` or
  `trip_[A-Za-z0-9]{8,64}` are accepted; duplicates, conflicts, URLs or invalid
  ids show "link unavailable" with a link to My trips. *(launch tests.)*
- AC-10 `initData`, `initDataUnsafe`, user and chat values are never read or
  sent. A forged Telegram user/chat hint with no session → `401
  AUTHENTICATION_REQUIRED`; with a session lacking membership, the launch is
  refused and no iframe renders. *(MiniApp tests; boundary report.)*
- AC-11 Changing trip selection clears the previous runtime frame; a delayed
  response for a previous trip never renders. *(MiniApp tests.)*
- AC-12 The Telegram SDK script loads only while the Mini App entry is mounted;
  missing or throwing SDK methods leave the page usable; theme colours accept
  only `#rrggbb`; safe-area insets are finite and clamped to 0–256 px.
- AC-13 Trip-password sign-in works with a Mini App return path (combined-tree
  check named in `docs/telegram-mini-app.md`).
- AC-14 **Owed — real Telegram acceptance** on the staging bot, on iOS and on
  desktop (Android if a device is available): private-chat launch from the menu
  button; group launch with an explicit `startapp=trip_<id>`; sign-in with an
  existing account; access for a real membership and refusal without one;
  runtime iframe loads under the deployment's cookie and framing policies;
  Telegram back returns to the list; close and reopen keeps the session.
  Recorded per device/client with the served revision.

**Merge-readiness**
- AC-15 After #357 is on `main`, #359 is re-merged/re-checked against the
  actual `main` (not the combined staged tree) and its CI is green on that merge
  ref; the 16-path increment is unchanged from the reviewed tree or re-reviewed.

## Contracts

- **New routes:** `GET /v1/trips/:id/interview-link`,
  `POST /v1/trips/:id/interview-link/replace` (body `{expectedEnrollmentId:
  "enrl_…"}`); response shapes as AC-1/AC-2; error codes
  `ENROLLMENT_NOT_REPLACEABLE`, `INTERVIEW_ALREADY_STARTED`, `TRIP_NOT_DRAFT`,
  `ENROLLMENT_BUSY`, `NOT_FOUND`.
- **New function:** `replaceEnrollment(db, userId, tripId, expectedEnrollmentId,
  {enrollmentTtlSeconds})` in `control-plane/api/src/enrollment.ts`.
- **Web:** `/mini-app`, `/mini-app/trips/:tripId`; `web/src/mini-app/{MiniApp.tsx,
  launch.ts, sdk.ts, mini-app.css}`.
- **Config:** none new. The bot's menu button and BotFather "Main Mini App"
  (needed for group/`startapp` launch) are deployment configuration, set per
  deployment — not code.
- **Docs:** `docs/telegram-mini-app.md`.

## Non-goals

Telegram SSO or any identity derived from Telegram; resolving a Telegram chat
to a trip; product-sent `web_app` buttons; account registration/recovery;
CA-02 grants; #255's full scope; restyling the trip runtime; document display
in Telegram's in-app browser (#417, its own spec).

## Security and boundary notes

- **Auth scoping:** every recovery route is owner-only through `membership()`
  plus a CSRF-checked mutation; a non-owner sees `404`, not `403`.
- **Single-use tokens:** revocation and reissue are one transaction; stale
  rotation is refused by `expectedEnrollmentId`. Lock order matches consumption
  (enrollment first), so recovery cannot deadlock against `startSession`.
  Recovery revocation **persists across a code rollback** — rolling back the
  code does not resurrect a revoked link.
- **Launch data grants nothing:** Telegram values are presentation and routing
  only; access is the existing session + `POST /v1/trips/:id/launch`.
- Boundary review: **done**, no findings, on combined tree `3572eee`
  (2026-10-18); product paths on `89c2a52` match it.

## Test plan

Suites: `control-plane/api` enrollment, portal, portal-db, password-login-work,
server-boot, interview, chat-router (real DB on a test database only — the
CLAUDE.md DB rule); `web/` vitest (MiniApp, launch, App, ProductApp) + typecheck
+ build. All exist on the branch. Manual, owed: AC-8 and AC-14.

## Owed before merge

| Gate | State on 2026-10-19 |
|---|---|
| #357 merged first | Pending. |
| CI green on the merge ref | Six product suites pass on `89c2a52` (run 39157865230). Must be redone against `main` after #357 lands. |
| Boundary review | Done, no findings. Re-run only if the increment changes. |
| Regression plan | Required (auth/enrollment). Covered by the 2026-10-18 plan; refresh after #357 lands if `main` moved in these paths. |
| Staging acceptance by Dror | **Owed** — recovery rows (AC-8) and Mini App rows (AC-14). Staging bot menu button already points at the staging `/mini-app`; group launch needs BotFather "Main Mini App" (Dror's step). |
| Owner approval | Merge to `main` is Dror's approval. |

## Rollout and regression

Control-plane API restart (all portal users) and the next frontend release. No
trip container is affected. A Mini App is visible to users only once a bot's
menu button / Main Mini App is configured — a separate, approved deployment
step per bot. Regression plan: needed (auth + token paths).

## Open questions

1. Production bot: does the Mini App go on the production bot in this sprint,
   or stay on the staging bot until T4 (one origin) settles the runtime URL?
2. AC-14 device matrix: iOS + desktop required, Android optional — agreed?
3. `ENROLLMENT_BUSY` has no total request deadline beyond the first
   enrollment-row wait (regression plan note). Accept, or add a
   `lock_timeout` follow-up?
