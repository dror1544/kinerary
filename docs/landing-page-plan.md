# Kinerary landing SPA and control-plane integration

Status: implemented for test-environment acceptance
Updated: 2026-08-25

## Product and identity decisions

The public landing page and organizer personal space are a standalone React/
TypeScript SPA in `web/`. The existing per-trip application in `site/` remains
the runtime UI and data owner; it is not merged into React.

- Google OIDC is the only organizer web identity in the first release.
- A first verified Google login creates a provider-neutral user immediately.
- Telegram is only the shared-bot planning interview and Hermes channel. A web
  profile returns `410 TELEGRAM_WEB_AUTH_RETIRED` from historical Telegram
  organizer-auth routes.
- One account may own multiple trips. The dashboard is organizer-only; a
  participant redeemed from an invitation receives runtime access only.
- Provisioning requires a separately configured operations administrator. A
  requester cannot approve their own plan.
- Trip sites open at `/trips/:id/app` in an iframe from one configurable,
  isolated runtime origin. Per-trip provider hostnames are never accepted from
  browser input or returned by public APIs.

## Implemented route model

Public routes are `/`, `/sign-in`, and `/join`. Authenticated organizer routes
are `/trips`, `/trips/new`, `/trips/:id`, `/trips/:id/setup`, and the embedded
`/trips/:id/app`. `/ops/provisioning` additionally requires the independently
configured provisioning-admin Google subject digest.

The landing route, product routes, and not-found route are lazy bundles. Nginx
serves Vite's fingerprinted assets immutably, serves `index.html` without a
long-lived cache, falls back to it for history routes, and proxies `/v1` to the
control-plane API on the same organizer origin.

## End-to-end control flow

1. The organizer signs in with OIDC authorization code + PKCE, state, and
   nonce. The API issues rotating opaque `Secure`, `HttpOnly`, `SameSite=Lax`
   sessions plus a double-submit CSRF token for mutations.
2. The organizer creates a draft containing destination, approximate dates,
   and trip type. Anonymous starter fields remain in `sessionStorage` only.
3. The API issues a short-lived, single-use shared-bot deep link. The private
   bot exchange binds the verified chat to that trip's interview session and
   does not create a Telegram login identity. Draft fields prefill intake.
4. Confirmation creates the immutable normalized intake. The organizer then
   requests an immutable plan in the operations-review queue.
5. An operations admin reviews release, digest, and bounded resource intent.
   Approval queues exactly that digest; rejection returns a bounded reason.
6. The worker provisions the existing runtime and publishes an opaque route
   reference. The private URL remains in the job result and is resolvable only
   by the runtime gateway through the internal API.
7. The SPA creates a 90-second, user/trip-bound launch grant and delivers it to
   the iframe with source- and origin-checked `postMessage`. The token never
   appears in a URL. The gateway consumes it once, exchanges it for a normal
   runtime JWT, and keeps that JWT in an authenticated encrypted HttpOnly
   cookie before proxying assets, APIs, SSE, uploads, and downloads below
   `/t/:tripId/`.
8. An organizer can create hashed, expiring, revocable, single-use invitation
   links. The raw token is returned once in `/join#token=...`. Google redemption
   reuses the verified account; password redemption creates a limited browser
   session. Both map one runtime participant and grant runtime access without
   dashboard access.

## Privacy and telemetry boundaries

The dashboard never receives interview transcripts, enrollment/session bearer
tokens, provider hostnames, filesystem paths, secrets, or raw worker errors.
The runtime requires authentication for trip-specific reads; only explicitly
token-authorized guest/enrollment workflows remain public.

Product telemetry is limited in the schema to: landing CTA, Google auth outcome
category, draft created, interview launched/confirmed, provisioning requested/
approved/completed, runtime launched, and invitation redeemed. Funnel rows have
no free-form properties, URLs, request metadata, transcript data, or secrets.

## Rollout boundary

The code is ready for an HTTPS test deployment, but this branch does not deploy
or cut over production. Existing trip hostnames remain the operator fallback
until SSE, large uploads/downloads, Google participant linking, password joins,
and mobile iframe behavior pass test-domain acceptance. New onboarding must
present only the personal-space route after cutover.

Deferred: organizer email/password accounts, billing, rename/archive/delete,
full operational history, memories/community/commerce, and rewriting the legacy
runtime in React.
