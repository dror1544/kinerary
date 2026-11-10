# One origin S2: runtime gateway direct mode, route registry URLs, one test trip

Status: draft (2026-10-19) · Issue: none yet (`x-`) · Track: T4 · Size: M · Tier: High
Security path: yes (the runtime gateway is the trust boundary in front of every trip; `/internal/runtime-routes`) · Migration: yes · Live-trip behaviour: no

> **Unscheduled, to be re-specced (2026-10-30):** the organizer web release (Sprint 7) put a portal and a runtime gateway on their own hosts, which changes this spec's starting point.

Umbrella: `x-one-origin-trips.md`. Depends on S1.

## Problem

`control-plane/runtime-gateway/server.js` is already a path proxy for
`/t/<trip_id>/`. Four things keep it from serving trips on one host.

1. **It admits only portal-launched sessions.**
   - With no `kit_runtime` cookie, `GET /t/<id>/` returns the iframe bootstrap
     page, and everything else returns 401 (`:201-207`).
   - It replaces `Authorization` with the cookie's token (`:147`).
   - A traveller who opens the link and signs in with the trip's own password
     therefore cannot use the site.
2. **The route source is the public subdomain.**
   - `/internal/runtime-routes/:tripId` takes the newest succeeded job's
     `private_url` as the upstream (`control-plane/api/src/portal.ts:808-828`).
   - It accepts the URL only if the hostname ends in a configured suffix (`:823`).
   - For a path-routed trip `private_url` *is* the gateway, so the gateway would
     proxy to itself. For a legacy trip, traffic goes out through the public edge
     and back.
3. **The route endpoint is mounted only with the portal.**
   `registerPortalRoutes` runs only when `profile.web` exists
   (`control-plane/api/src/server.ts:121-125`).
4. **It is not deployed.** No compose file runs it (`docs/activation-scope.md:78`).

## Behaviour

- **The gateway runs in the control-plane compose stack.** The operator points
  one host, `RUNTIME_ORIGIN`, at it (one DNS record, one tunnel rule, one proxy
  host, all in `kinerary-deploy`).
- **Direct mode.** A request to `/t/<trip_id>/…` with no valid `kit_runtime`
  cookie for that trip is proxied to the trip's upstream:
  - the browser's own `Authorization` header passes through;
  - cookies and `X-API-Key` are dropped;
  - `X-Forwarded-Prefix` is set and `X-Forwarded-For` is appended;
  - the gateway's response policy (below) is applied.
- **Launched mode.** It behaves as today, with two changes:
  - the bootstrap page moves to its own path, so `GET /t/<id>/` is the trip
    itself in both modes;
  - the cookie's token is injected only on requests that carry
    `X-Kinerary-Trip: <trip_id>` (from S1's `runtime-base.js`) or are top-level
    `GET` navigations.
- **Response policy, both modes.** Each response:
  - drops `Set-Cookie` and `Service-Worker-Allowed`;
  - rewrites relative `Location` under the prefix, and refuses an absolute
    `Location` that points into `RUNTIME_ORIGIN` outside this trip's prefix
    (502);
  - gets the enforced CSP from S1's contract, plus `nosniff` and
    `Referrer-Policy: same-origin`;
  - keeps the upstream's framing policy in direct mode; launched mode keeps
    today's `frame-ancestors <PORTAL_ORIGIN>` replacement.
- **Routes come from `runtime_routes.upstream_url`**, a LAN `http://` address the
  worker records. The allow-list is exact hosts or CIDRs, not hostname suffixes.
- **One test trip** (not a family's) is reachable at
  `RUNTIME_ORIGIN/t/<trip_id>/` on Mac staging and works end to end.

## Acceptance criteria

- **AC-1. Direct mode passes the trip's own session.** Given a ready route and no
  cookie:
  - `GET /t/<id>/` returns the trip's `index.html`, not the bootstrap page;
  - `POST /t/<id>/api/auth/login` with valid credentials returns a token;
  - `GET /t/<id>/api/config` with `Authorization: Bearer <that token>` returns 200
    upstream, and the upstream saw the same `Authorization` value and no `Cookie`
    header.
- **AC-2. Prefix stripping and headers.** The upstream receives path `/<rest>`
  with the query intact, `X-Forwarded-Prefix: /t/<id>`, and an
  `X-Forwarded-For` that ends with the gateway's peer address. A client-sent
  `X-Forwarded-Prefix` is overwritten.
- **AC-3. Internal and foreign paths refused.**
  - `/t/<id>/api/internal/*` returns 404 in both modes (kept from `:199`).
  - A path outside `/t/<trip_id>/` other than `/health` returns 404.
  - A trip id that fails `^trip_[A-Za-z0-9]{8,64}$` returns 404.
  - A trip with no ready route returns 404 `RUNTIME_NOT_READY`, never another
    trip's upstream.
- **AC-4. Response policy.** In a test where the upstream returns:
  - `Set-Cookie`: absent downstream;
  - `Service-Worker-Allowed: /`: absent downstream;
  - `Location: /x`: becomes `/t/<id>/x`;
  - `Location: <RUNTIME_ORIGIN>/t/<other>/x`: the gateway answers 502;
  - HTML: carries the enforced CSP, `nosniff` and `Referrer-Policy`.
  - Direct mode with an upstream `X-Frame-Options: DENY` keeps it. Launched mode
    replaces it with `frame-ancestors <PORTAL_ORIGIN>`.
- **AC-5. Launched-mode CSRF check.**
  - With a valid `kit_runtime` cookie for trip A, a `POST /t/A/api/...` without
    `X-Kinerary-Trip: A` is forwarded **without** the injected token, and the
    upstream answers 401.
  - With the header, the token is injected.
  - A top-level `GET` navigation injects it.
- **AC-6. Bootstrap path moved.**
  - `POST /v1/trips/:id/launch` returns `framePath: /t/<id>/__frame`.
  - `GET /t/<id>/__frame` returns the bootstrap page with today's CSP
    (`server.js:205`).
  - After a successful `__launch`, the page navigates to `/t/<id>/`.
  - The portal and Mini App tests that assert `framePath` are updated.
- **AC-7. Route registry.**
  - Migration `YYYYMMDDHHMMSS_runtime_route_urls.sql` adds nullable
    `public_url text` and `upstream_url text` to `control_plane.runtime_routes`.
  - `/internal/runtime-routes/:tripId` returns `upstreamOrigin` from
    `upstream_url` when it is set, and falls back to today's `private_url` lookup
    otherwise.
  - It rejects an upstream whose host is not in
    `web.runtime_upstream_allowed_hosts` (exact hostnames, IPs or CIDRs), or that
    carries credentials, a query or a fragment.
  - A row created before the migration behaves exactly as today.
- **AC-8. Route endpoint independent of the portal.**
  - `/internal/runtime-routes/:tripId` is mounted whenever a runtime exchange key
    and `runtime_origin` are configured, even when the portal's Google and
    session blocks are not.
  - With neither configured, it stays unmounted.
  - `config.ts:198-200`'s rule (runtime origin ≠ portal origin) still holds
    whenever both are set.
- **AC-9. Compose.**
  - `control-plane/deployment/compose.local.yml` and `compose.vm.yml` define a
    `runtime-gateway` service from `control-plane/runtime-gateway`.
  - It is bound to the address its env names (`BIND_HOST`), never `0.0.0.0` by
    default.
  - Its secrets come from files, the same way as the API's.
  - It starts and answers `/health`.
  - `docker compose config` with an unset `RUNTIME_ORIGIN` fails loudly.
- **AC-10. One test trip end to end on staging.** On a test trip given S1's
  `PUBLIC_BASE_URL` and a `runtime_routes` row with `upstream_url`, in a real
  browser at `RUNTIME_ORIGIN/t/<id>/`, each of these works:
  - password sign-in;
  - Modern and Classic views;
  - SSE live updates;
  - a photo upload and its file link;
  - a confirmation download;
  - the `/photo/:id` share page.

  The worker's `verification.py` checks (`/api/health`, roster,
  deployment-identity) pass against the path URL. Evidence: captured
  request/response pairs, filed with the PR.

## Contracts

- **Migration.** New file named `YYYYMMDDHHMMSS_runtime_route_urls.sql`
  (`docs/migrations.md`). It starts:

  ```sql
  -- rollback: compatible — adds two nullable columns; older code ignores them
  ALTER TABLE control_plane.runtime_routes
    ADD COLUMN IF NOT EXISTS public_url text,
    ADD COLUMN IF NOT EXISTS upstream_url text;
  ```

- **API config.**
  - `web.runtime_upstream_allowed_hosts: string[]` replaces the suffix check. The
    old `runtime_upstream_host_suffixes` stays accepted as a fallback for one
    sprint.
  - The route-registry endpoint gets its own dependency block (`server.ts`),
    split out of `PortalDependencies`.
- **Gateway env.** Existing: `RUNTIME_ORIGIN`, `PORTAL_ORIGIN`,
  `RUNTIME_EXCHANGE_KEY`, `RUNTIME_COOKIE_SECRET`, `CONTROL_PLANE_INTERNAL_ORIGIN`
  (`server.js:7-11`). New: `RUNTIME_DIRECT_MODE=1`, so a deployment can keep the
  portal-only behaviour. Values live in `kinerary-deploy`.
- **Route response shape** (unchanged):
  `{ routeRef, upstreamOrigin, upstreamBasePath }`.
- **Files expected to change:**
  - `control-plane/runtime-gateway/server.js` and its tests;
  - `control-plane/api/src/portal.ts` (framePath, route lookup);
  - `control-plane/api/src/server.ts`, `control-plane/api/src/config.ts`;
  - `control-plane/db/migrations/<new>.sql`;
  - `control-plane/deployment/compose.local.yml`, `compose.vm.yml`,
    `vm.env.example`;
  - `web/` (framePath consumer, if any asserts the path).
- **Operator steps, outside this repo:** in `kinerary-deploy`, one DNS record and
  one tunnel ingress rule for `RUNTIME_ORIGIN`'s host, and one proxy host to the
  gateway. That proxy host must have streaming on (SSE) and a body limit that
  matches `nginx.conf`'s 500m. These are one-time steps, each an approved
  infrastructure change.

## Non-goals

- Provisioning new trips this way (S3). Migrating live trips (S4).
- The trip-mcp connector through the gateway. trip-mcp keeps refusing
  `X-Forwarded-Prefix` (`server/trip-mcp/index.js:85-88`). The gateway proxies
  `/t/<id>/mcp` and `/oauth/*` like any path and trip-mcp answers 404, which is
  the intended behaviour until its own spec.
- Serving front-end assets from the gateway.

## Security and boundary notes

- The gateway becomes the **only** public entry to path-routed trips. Three
  invariants carry over and gain tests:
  - nothing reaches `/api/internal/*` from a browser;
  - upstream cookies never reach the shared origin;
  - a route resolves only to an allow-listed upstream.
- Direct mode adds no credential of its own: it forwards the trip's own bearer
  token. Launched mode's injected token is now gated on a per-trip header.
- **Limit of AC-5, stated plainly:** the header stops plain cross-trip requests
  (forms, images, navigations into a POST). It does **not** stop script running
  on another trip's path, which can set any header. That is the umbrella's
  residual.
- **boundary-reviewer** reviews before merge, with real request/response evidence
  for AC-1, AC-3, AC-4 and AC-5 against the staging gateway.

## Test plan

Write the tests first:

- `control-plane/runtime-gateway/test/gateway.test.js`: new cases for AC-1 to AC-6.
  The fake upstream records the headers it receives.
- `control-plane/api/test/portal.test.ts`, `portal-db.test.ts`: AC-6 framePath,
  AC-7 lookup and allow-list, AC-8 mounting.
- `control-plane/api/test/server-boot.test.ts`: AC-8.
- A migration test in the DB suite (`CONTROL_PLANE_TEST_DATABASE_URL`, test
  database only).
- Suites: `npm test` in `control-plane/runtime-gateway` and `control-plane/api`,
  `scripts/preflight-deploy.sh`.
- Manual: AC-10 on Mac staging, driven by Dror as a live run. Never on the VM, and
  never on a family's trip.

## Rollout and regression

- No live trip has a route with `upstream_url` until S4, so none feels this.
- The migration is additive and `compatible`.
- Adding a service to `compose.vm.yml` reaches the VM only through a release
  (`kinerary-cp-release`, MVP VM upgrade gate).
- A regression plan is required (migration, a new public boundary).

## Open questions

- Should `RUNTIME_DIRECT_MODE` exist at all, or should direct mode always be on?
  The proposal is a flag, so the portal-only deployment shape stays expressible.
- Should `X-Forwarded-For` appending go with an explicit `TRUST_PROXY_HOPS` change
  on path-routed trips (`server/server.js:2205-2230`)? The operator confirms it
  with the live probe that comment describes.
