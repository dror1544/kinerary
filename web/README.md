# Kinerary web SPA

Dynamic public and organizer-facing web application for Kinerary.

## Current slice

- branded, responsive landing page;
- interactive organizer/family product view;
- interactive changed-plan scenario;
- client-side sign-in and sign-up routes;
- resumable pre-auth trip-intent flow;
- lifecycle-oriented My trips dashboard preview;
- lazy-loaded route bundles and deep-link fallback;
- route and interaction tests.

Authentication is wired, as of 2026-09-19. `signIn()` navigates to
`/v1/auth/google/start` and `passwordSignIn()` posts to `/v1/auth/password`;
both are served by `control-plane/api/src/portal.ts`, which also issues the
rotating session cookie and enforces CSRF on mutations. A verified Google login
creates the account.

What is still missing is organizer **email/password signup**: `/sign-up` and
`/forgot-password` redirect to `/sign-in`, and of the nine account endpoints in
`docs/web-control-plane-integration-plan.md` §4.3 only the Google pair, `/v1/me`
and `/v1/logout` exist. Provisioned trip sites are a separate story again — they
have no registration route at all.

## Local development

```bash
npm install
npm run dev
```

The development server uses `http://127.0.0.1:4175`.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The existing `site/` directory remains the isolated per-trip application. This
package does not replace it or reuse its trip-local user database.
