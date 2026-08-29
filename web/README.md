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

Authentication controls are intentionally interface-only in this slice. They
do not create sessions or call the existing per-trip authentication endpoints.
Public organizer authentication will be wired to new control-plane endpoints.

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
