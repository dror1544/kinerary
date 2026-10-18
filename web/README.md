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

Authentication uses the control-plane portal. Existing organizers can sign in
with their email and account password through `/v1/auth/email-password`.
`/v1/auth/capabilities` reports which providers are configured; Google sign-in
is offered only when its client ID and secret are both configured. Trip members
can still use the separate `/v1/auth/password` trip-username login. These routes
issue the real session cookie, and mutations require its CSRF token.

The account UI lists membership-scoped trips, creates draft trips, presents a
clickable private Telegram interview link, and shows provisioning plans for
review. Creating a draft does not provision a site. An interview link is held
only while its page remains mounted: open it before reloading, since an unused
active enrollment cannot currently be reissued. Recovery needs a separate flow.

Organizer email/password signup and password recovery remain unavailable in
this SPA: `/sign-up` and `/forgot-password` redirect to `/sign-in`. Existing
email sign-in does not create accounts or replace credentials. Provisioned trip
sites retain their separate member login and invitation flows.

## Local development

```bash
npm install
npm run dev
```

The development server uses `http://127.0.0.1:4175`; preview uses port 4176.
Both proxy `/v1` to `KINERARY_API_ORIGIN` (default `http://127.0.0.1:4310`).
Run the real control-plane API separately. Its architecture profile must enable
`web` and set `web.public_origin` to the browser origin, because sign-in and
mutations validate Origin. Set the two Google secret references together when
using Google; omit both for existing organizer email/password review. A static
production host must route `/v1` to the API itself; Vite's proxy is for local
review. Do not change a stack serving another active test just to review this UI.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The existing `site/` directory remains the isolated per-trip application. This
package does not replace it or reuse its trip-local user database.
