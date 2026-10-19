# One origin S4: migrate live trips one at a time; old subdomains redirect

Status: draft (2026-10-19) · Issue: none yet (`x-`) · Track: T4 · Size: M · Tier: High
Security path: yes (moves real travellers' sessions to the shared origin; trip-mcp connector continuity) · Migration: no (data writes through a tool, no schema) · Live-trip behaviour: yes

Umbrella: `x-one-origin-trips.md`. Depends on S1 and S2. S3 is not required.

## Problem

After S1 and S2, a path-routed trip works, but every existing trip still lives on
its own subdomain. Moving one touches several places.

- **The container needs config.** It needs S1's code and the `PUBLIC_BASE_URL` /
  `TRIP_ID` lines in its `.env`. The existing `.env` is never overwritten by
  bootstrap (`docs/runtime-session-exchange.md`, "Existing runtimes need … installed
  explicitly"), so these lines are added by an explicit step.
- **The route registry needs URLs.** The trip's `runtime_routes` row needs
  `public_url` and `upstream_url`.
- **Places that hold the old URL:**
  - the companion's rendered SOUL and sources
    (`profile-templates/familytrip-companion/templates/SOUL.md.tpl:130`,
    `templates/references/sources.md.tpl:4`);
  - the newest job result's `private_url`, which the relay intro and the outbox
    read (`control-plane/api/src/relay/dispatch.ts:569`, `:739`, `:996`;
    `control-plane/api/src/outbox-dispatcher.ts:67`, `:92`);
  - messages already sent in Telegram;
  - bookmarks and home-screen PWAs, whose manifest `start_url` is relative to the
    old origin (`server/site-icons.js:47`);
  - Google sign-in's registered JavaScript origins.
- **Sessions do not move.** They live in the old origin's `localStorage`, so every
  traveller signs in once more on the new path.
- **The MCP connector cannot move.** A trip with the member MCP connector has
  OAuth clients registered against its subdomain issuer (`server/trip-mcp/index.js:62-64`,
  `:117-118`). That issuer cannot move without breaking those connections, and
  trip-mcp refuses to run behind the gateway (`:85-88`).

## Behaviour

- **One trip, one approved step.** `scripts/migrate-trip-origin.py --trip <slug|trip_id>`
  prints a plan. `--execute` runs it, and the operator runs it only after Dror
  approves that trip. The steps, in order:
  1. back up the `.env` and the route row;
  2. confirm the container runs a release containing S1 (read
     `/api/config/deployment-identity`). If not, refuse and name the redeploy
     that is needed;
  3. append `PUBLIC_BASE_URL` and `TRIP_ID` to `.env` and restart the trip server
     through the trip's own `kinerary-deploy` deploy wrapper;
  4. write `public_url` and `upstream_url` to `runtime_routes`;
  5. probe `RUNTIME_ORIGIN/t/<id>/api/health` and the roster through the gateway
     (the verifier's checks);
  6. **only then** apply the subdomain redirect;
  7. re-render the companion profile with the new `canonical_site_url`;
  8. record a job result whose `private_url` is the path URL, so new intro and
     outbox messages use it;
  9. print a bilingual note for the organizer to forward: the new link, "sign in
     once more", and "re-add the home-screen icon".

  A failure at any step before 6 rolls back steps 3–4 from the backup and leaves
  the subdomain untouched.
- **Subdomain redirect during the deprecation window.** The old hostname keeps
  proxying to the container, with one rule: a top-level `GET`/`HEAD` navigation
  (`Sec-Fetch-Mode: navigate`, or no `Sec-Fetch-*` at all on a `GET` for an HTML
  path) gets `301` to `RUNTIME_ORIGIN/t/<trip_id><path>?<query>`.
  - **Excluded from the redirect** (still proxied): `/mcp`, `/oauth/*` (an OAuth
    authorize step *is* a navigation), `/.well-known/oauth-*`, `/api/*`,
    `/confirmations/*`, `/photo/*`.
  - So open tabs, existing MCP connectors and shared photo links keep working.
  - The rule is applied on the existing proxy host by the migration tool, as an
    advanced-config snippet. Its exact text is generated from the trip id and
    `RUNTIME_ORIGIN`, and shown in the plan output.
- **End of window.** When the window ends (umbrella Q6), a follow-up run of the
  tool (`--retire-subdomain`) removes the proxy host, DNS record and tunnel rule.
  It goes through the same adapters teardown uses, and only after checking that
  the trip has no active MCP grant on the old issuer, or that Dror said to drop
  it.
- **Order across the fleet.** The first trip is a test trip (umbrella Q7). After
  it, live trips are migrated only when no one is travelling on them, or with the
  organizer told beforehand. Never two in one step.

## Acceptance criteria

- **AC-1. Plan is read-only.** `migrate-trip-origin.py --trip X` without
  `--execute` makes no write. It prints every step, including the redirect
  snippet, the route values, and whether the container's release is new enough.
  It exits non-zero if the release lacks S1.
- **AC-2. Refusals.** The tool refuses, with its reason, for:
  - a trip with no ready route;
  - a trip already path-routed;
  - a container without S1;
  - a `RUNTIME_ORIGIN` that is unset or equal to the portal origin;
  - a trip whose companion re-render is blocked (no profile).

  There is no `--force`.
- **AC-3. Rollback before redirect.** With the health probe faked to fail at step
  5, the `.env` and the route row are restored byte for byte from the backup, no
  redirect is applied, and the tool exits non-zero.
- **AC-4. Redirect rule.** Against the generated snippet, run in an nginx test
  container in CI with no live infrastructure:
  - `GET /` with `Sec-Fetch-Mode: navigate` → 301 to `<RUNTIME_ORIGIN>/t/<id>/`;
  - `GET /classic.html?x=1` → 301 with the path and query preserved;
  - `GET /api/config` → proxied;
  - `POST /oauth/token` → proxied;
  - `GET /oauth/authorize?…` with `navigate` → proxied;
  - `GET /photo/abc?s=…` → proxied;
  - `GET /.well-known/oauth-authorization-server` → proxied.
- **AC-5. Links refreshed.** After `--execute`:
  - the re-rendered SOUL's canonical website is the path URL;
  - a new organizer intro, rendered from the newest job result, shows the path
    URL;
  - `/api/config/deployment-identity` through the gateway returns this trip's
    identity.
- **AC-6. First migration, on a test trip** (umbrella Q7), on staging, then once
  on the VM after Dror approves. The evidence for both:
  - a traveller signs in at the path URL;
  - an old-subdomain bookmark lands on the path URL;
  - an existing MCP connection (if the trip has one) still answers a tool call
    through the old hostname;
  - the companion answers with the new link.

  This AC, with S1 and S2, is the capacity-fallback exit.
- **AC-7. Retire subdomain.**
  - `--retire-subdomain` on a trip past its window removes exactly that trip's
    NPM host, DNS record and tunnel rule, through `NpmProxyHostAdapter` /
    `CloudflareTunnelDnsAdapter` (`provisioning/adapters.py:662-800`), which
    keep their verify-or-rollback.
  - It refuses while an active trip-mcp grant exists on the old issuer, unless
    `--drop-mcp-grants` is given, which needs Dror's say-so.

## Contracts

- **New script:** `scripts/migrate-trip-origin.py`. It is shaped like
  `scripts/teardown-trip.py`: plan by default, `--execute`, backups first. It
  reads deployment values from env (`RUNTIME_ORIGIN`, NPM and Cloudflare
  credentials from `provisioning.env`). No hosts appear in the repo.
- **Redirect snippet generator:** a pure function in the script, unit-tested,
  plus an nginx-container test for AC-4.
- **Job result:** a `trip_origin_migration` job row whose `result` carries
  `private_url` (the path URL), `previous_url`, `migrated_at`. Readers that take
  the newest succeeded job with `private_url` pick it up unchanged.
- **Files expected to change:**
  - new `scripts/migrate-trip-origin.py` and `tests/scripts/test_migrate_trip_origin.py`;
  - `scripts/teardown-trip.py` (shared helpers only, if any);
  - the operator runbook section in `docs/control-plane-vm-deployment.md`
    (doc-keeper).

## Non-goals

- Moving sessions across origins: a token handoff link from old to new origin.
  It is possible, but it is a credential sent in a URL. One sign-in per traveller
  is the cheaper, safer cost.
- Moving the MCP connector's issuer. Connectors stay on the old hostname until the
  window ends (umbrella Q5).
- Bulk migration.

## Security and boundary notes

- Moving a trip onto the shared origin puts its travellers inside the umbrella's
  residual blast radius. Each trip's migration is therefore a deliberate,
  approved step, not a fleet default.
- The redirect never moves an OAuth or API request, so no bearer token or
  authorization code is ever sent to a new location by a redirect.
- Alpha-tester data policy: the tool reads only the `.env`, the route row and
  health/identity endpoints. It never reads trip content.

## Test plan

Write the tests first:

- `tests/scripts/test_migrate_trip_origin.py`: AC-1, AC-2, AC-3, AC-5, AC-7, with
  fakes for SSH, the deploy wrapper, the DB, NPM and Cloudflare.
- The AC-4 nginx test, in CI.
- Manual: AC-6. Each run is a deploy-class step under hard rule 2, and Dror drives
  each live run.

## Rollout and regression

- Per trip, on approval: the test trip first, then live trips one at a time.
- Each migration needs a regression note for that trip, covering blast radius
  (the travellers who must sign in again), connector continuity, and the companion
  re-render.
- A regression plan is required.

## Open questions

- Umbrella Q6 (window length) and Q7 (first trip).
- Should the organizer's forwarded note go out from the companion automatically,
  or always be handed to the operator to send? The proposal is the operator.
