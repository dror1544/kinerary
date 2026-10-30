# One origin for trips (umbrella)

Status: draft (2026-10-19) · Issue: none yet (`x-`) · Track: T4 · Size: L · Tier: High
Security path: yes (session isolation between trips, the `authRequired` JWT path, the runtime gateway, trip-mcp OAuth) · Migration: yes (S2) · Live-trip behaviour: yes (S4)

> **Unscheduled, to be re-specced (2026-10-30):** the organizer web release (Sprint 7) put a portal and a runtime gateway on their own hosts, which changes this spec's starting point.

This file holds the decisions, the target shape, the security model and the
slice plan. Each slice has its own spec with its own acceptance criteria, so
each brief can point at one of them:

| Slice | Spec | Size | What changes |
|---|---|---|---|
| S1 | `x-one-origin-s1-base-path-and-session-isolation.md` | M | Trip server and both front-ends run correctly under `/t/<trip_id>/`. Session storage is namespaced per trip, tokens are bound to their trip, CSP goes on report-only. Behind a flag, so nothing live changes. |
| S2 | `x-one-origin-s2-gateway-direct-mode.md` | M | Runtime gateway gets a direct mode for ordinary visitors. Route registry gets public and upstream URLs (migration). Gateway goes into compose. One host, one test trip on staging. |
| S3 | `x-one-origin-s3-provisioning-path-default.md` | M | New trips are path-routed by default. No per-trip DNS record, tunnel rule or proxy host. Teardown still removes the old ones. |
| S4 | `x-one-origin-s4-live-trip-migration.md` | M | Live trips move one at a time. The old subdomain 301s navigations to the new path for a deprecation window. Links held by companions and messages are refreshed. |

**Capacity fallback** (sprint plan, `docs/onboarding-mvp-sprint-plan.md:1838-1839`):
"spec, proxy and one trip migrated" means **S1 + S2 + S4 run once, on one
test trip** that is not a family's live trip. S3, and S4 for live trips, move to
Sprint 8. S1 and S2 do not change anything for live trips, so cutting there is
safe.

## Problem

Every provisioned trip gets its own public hostname. Provisioning builds three
records from `PROVISIONER_LXC_HOSTNAME_DOMAIN` (`control-plane/worker/control_plane_worker/compute.py:269`,
`:291-300`; required at `control-plane/worker/control_plane_worker/__main__.py:279-280`):

- a Cloudflare DNS record **and** an ingress rule. The rule goes into the shared
  tunnel's locally managed config, over SSH, with a verify-or-rollback step
  because a bad edit takes down every hostname on the tunnel
  (`provisioning/adapters.py:684-800`);
- an NPM proxy host (`provisioning/adapters.py:662-681`);
- the container's `PUBLIC_ORIGIN` (`provisioning/models.py:41-48`, `:146`;
  `provisioning/adapters.py:282-302`). That origin is also the OAuth issuer of
  the trip's member MCP connector.

`private_url` (`https://<slug>.<domain>`) is written into the job result and
read back off `topology.yaml` (`control-plane/worker/control_plane_worker/provisioner.py:561-573`).
It then serves as four different things:

- the URL travellers are sent (`control-plane/api/src/relay/dispatch.ts:569`,
  `:739`, `:996`; `control-plane/api/src/outbox-dispatcher.ts:67`, `:92`);
- the companion's canonical site URL (`provisioner.py:1973` →
  `profile-templates/familytrip-companion/templates/SOUL.md.tpl:130`);
- the verifier's probe target (`control-plane/worker/control_plane_worker/verification.py:204-211`);
- the runtime gateway's upstream (`control-plane/api/src/portal.ts:808-828`).

What that costs:

- Every provision and every teardown touches shared public infrastructure.
  `scripts/teardown-trip.py:402`, `:415` and `:650-687` exist mostly to undo it
  safely.
- Telegram Login and a Telegram Mini App need **one** domain. The SSO route was
  archived for exactly this reason (`docs/archived/telegram-sso.md:1`; the
  per-bot domain registration step is at `:26-29`).
- Google sign-in needs each JavaScript origin registered with the OAuth client
  one by one (`GOOGLE_CLIENT_ID`, `server/server.js:102`), so every new
  subdomain is one more manual registration.

### Why it was deferred, and what has changed since

Path routing was proposed and then dropped twice, for one stated reason:

> Browser isolation is per origin, not per path: the trip site keeps its JWT in
> `localStorage` (`trip-token`/`trip-user`/`trip-lang`), so two trips under one
> origin would clobber each other's sessions and share permissions and XSS
> blast radius. Path routing (`/trips/<slug>`) is deferred until a unified
> account exists and the `trip-web` front-end (already built with a relative
> base) replaces `site/app.js`.
> — `docs/future/k3s-home-deployment-sprint-plan.md:79-88` (decision 3; non-goal at `:63-64`)

The architecture page says the same: `docs/future/k3s-home-deployment-architecture.html:47`
(§4) and `:137` (§13). Its "required application work" note (`:62`) counts
about 100 absolute paths in `site/app.js` that would need rewriting.

Three things in the tree have changed since that was written:

1. **A path-routed runtime gateway already exists, but it is not deployed.**
   `control-plane/runtime-gateway/server.js` serves `/t/<trip_id>/…`
   (`:181-184`). It looks the upstream up in the control plane's
   `runtime_routes` (`:75-81`, `portal.ts:807-828`), strips the prefix and sends
   `X-Forwarded-Prefix` (`:146-147`), and rewrites `Location` (`:162`). It
   drops the browser's cookies and `X-API-Key` (`:148-149`) and every upstream
   `Set-Cookie` (`:153`). It keeps its own session in an encrypted HttpOnly
   cookie with `Path=/t/<trip_id>/` (`:110`). It only admits portal-launched
   sessions: with no cookie you get a bootstrap page or a 401 (`:201-207`).
   `docs/activation-scope.md:78` (B4) records that it is not deployed and not
   in compose. That is still true: no `compose.*.yml` references it.
2. **The classic site already has a base-path shim.** `site/runtime-base.js`
   reads the `/t/<id>` base from `location` (`:3-4`). It wraps `fetch`, XHR and
   `EventSource` (`:34-46`) and rewrites `src`/`href`/`action` as nodes are
   added (`:49-66`). Both `site/index.html:7` and `trip-web/index.html` load it,
   and `trip-web` routes every API call through it (`trip-web/src/api.ts:4`,
   `:59`). `trip-web` builds with `base: "./"` (`trip-web/vite.config.ts`), and
   the web manifest is relative (`server/site-icons.js:47`). So the "≈100
   absolute paths" are already handled at runtime, not by rewriting them.
3. **The portal and the Mini App already assume this shape.**
   `POST /v1/trips/:id/launch` returns `framePath: /t/<trip_id>/` on the
   configured `runtime_origin` (`portal.ts:773-787`). The API refuses a
   `runtime_origin` equal to the portal's origin (`control-plane/api/src/config.ts:198-200`).
   The open Mini App branch (`feat/sprint6-miniapp-recovery`, PR #359) frames
   that same path and accepts only `trip_[A-Za-z0-9]{8,64}` selectors
   (`web/src/mini-app/launch.ts` on that branch). Its `docs/telegram-mini-app.md`
   leaves "the existing runtime iframe works under the deployment's cookie and
   framing policies" to real-Telegram acceptance.

What has **not** changed is the browser fact behind the deferral. Paths on one
origin are not isolated from each other. The design below accepts that openly
and limits the damage. It does not claim to remove it.

## Decisions (proposed; Dror approves)

**D1. Target URL: `https://<RUNTIME_HOST>/t/<trip_id>/`.**

- `/t/` is what the gateway, `runtime-base.js`, the portal and the Mini App
  already use. Switching to `/trips/` means touching all four for no gain.
- The key is the **trip id**, not the slug. Teardown frees a slug for reuse
  (`retired-<slug>-<date>`, `compute.py:245-254` explains the same reasoning for
  NFS paths). A `/t/<slug>/` link sitting in an old Telegram message, a QR code
  or a bookmark would then open the *next* family's trip. Ids are never reused.
- A readable alias `/t/<slug>` → 302 → `/t/<trip_id>/` is an optional extra and
  an open question (Q2). It carries the same reuse risk, so it would be allowed
  only while the slug's trip is live.

**D2. One host, one config value.** The trips' host is the origin already named
`runtime_origin`. It is `profile.web.runtime_origin` in the API
(`config.ts:82-84`) and `RUNTIME_ORIGIN` in the gateway (`server.js:11`). The
worker gets the same `RUNTIME_ORIGIN` env var (S3).

- The value lives in `kinerary-deploy`, never in this repo (hard rule 6).
- It must differ from the portal origin. `config.ts:198-200` already enforces
  that, and S2 keeps it. Organizer accounts must never share an origin with trip
  content.

**D3. The proxy is the runtime gateway, and it strips the prefix.** The one host
gets one DNS record, one tunnel rule and one proxy host, all pointing at the
gateway. That is a one-time operator step in `kinerary-deploy`. The gateway
maps `/t/<trip_id>/<rest>` to `<upstream>/<rest>` and sends `X-Forwarded-Prefix: /t/<trip_id>`.

Why strip the prefix rather than keep it:

- The trip container's nginx (`nginx.conf`) and roughly 70 Express routes all
  match root paths. Stripping means none of them change.
- One image can serve a trip on its legacy subdomain and on its path at the same
  time. S4's deprecation window depends on that.
- The gateway already does it, and is already tested for it.

Keeping the prefix would mean either mounting the whole server under a router
that knows its trip id at build time, or rewriting `nginx.conf` per trip.

The trip learns its public base from **configuration**, `PUBLIC_BASE_URL` in its
`.env`, never from the header. The container can be reached directly on the LAN,
and a header-derived base would be whatever the caller sent.

Why not per-trip NPM "custom locations": every new trip would still edit the
proxy, and the provisioning cost this track exists to remove would stay.

**D4. Both front-ends stay; classic is not retired by this track.**
`runtime-base.js` already makes classic path-aware. Retiring it is a product
call (Q4), and S1 does not depend on the answer. If Dror retires it, S1 shrinks
to `trip-web` alone and the `/classic.html` links point to Modern.

**D5. The deferral's condition is met with mitigations, not a unified account.**
Per-trip storage namespaces, trip-bound tokens and a gateway-enforced policy
stop trips *clobbering* each other and stop one trip's token working on another.
They do **not** stop script that runs in one trip from reaching another trip's
session in the same browser (see the security model below). Dror is asked to
accept that residual explicitly (Q1) before S1 is briefed.

## Target shape

```
browser ──https──▶ <RUNTIME_HOST>  (one DNS record, one tunnel rule, one proxy host — operator, once)
                        │
                        ▼
                runtime gateway (compose; control-plane/runtime-gateway)
                  /t/<trip_id>/…   → route = runtime_routes[trip_id] (state 'ready')
                  strip prefix, X-Forwarded-Prefix, enforce response policy
                        │  http, LAN
                        ▼
                trip container nginx :forward_port  (unchanged; PUBLIC_BASE_URL in .env)
```

The gateway keeps two session modes on the same path:

- **Direct mode** (new, S2). The traveller opens the link and signs in with the
  trip's own password, Google or (later) Telegram. The trip's JWT travels as
  `Authorization: Bearer`, and the gateway passes it through untouched.
- **Launched mode** (existing). The portal or Mini App frames the trip with a
  90-second launch grant. The gateway seals the trip JWT in its HttpOnly
  `kit_runtime` cookie and injects it upstream.

## Security model: what is isolated, and what is not

This is a security path. **boundary-reviewer** reviews S1 and S2 before each is
merged, with live request/response evidence (CLAUDE.md, "Security-sensitive
paths").

**Isolated after S1 + S2**

| Threat | Today on subdomains | One origin, mitigated |
|---|---|---|
| Two trips overwrite each other's `trip-token` / `trip-user` / `trip-lang` (`site/app.js`: 36 `getItem('trip-token')`; `trip-web/src/api.ts:6-24`) | separate origins | every key goes through one helper that prefixes `kin:<trip_id>:`; a test fails on any direct `localStorage.` call (S1) |
| Trip A's token accepted by trip B | per-trip `JWT_SECRET` (`provisioning/adapters.py:441`) | still per-trip, **plus** an `aud` claim set to the trip id and checked in `authRequired` and `organizerOrAgentRequired` (`server/server.js:747-767`, `:950-966`); in path mode the server refuses to boot on the default secret (`server.js:67`) (S1) |
| A trip's upstream sets a cookie for every trip (`Path=/`) | separate origins | the gateway strips upstream `Set-Cookie` (`runtime-gateway/server.js:153`, kept and tested) |
| A trip registers a service worker over `/` and intercepts every trip | separate origins | the gateway strips `Service-Worker-Allowed`, so a worker's scope cannot leave `/t/<trip_id>/`; the Modern worker's cache name is namespaced and `activate` deletes only its own caches (`trip-web/public/modern-sw.js:1`, `:8-13` delete **all** other caches today) (S1/S2) |
| A trip's response claims the root or another trip's path | n/a | the gateway serves nothing upstream outside `/t/<trip_id>/`, rewrites only relative `Location`, and refuses an absolute `Location` to `RUNTIME_ORIGIN` outside the trip's own prefix (S2) |
| A trip is framed by an arbitrary site | trip nginx `X-Frame-Options: DENY` | direct mode keeps upstream framing policy; only launched mode replaces it with `frame-ancestors <PORTAL_ORIGIN>` (`server.js:154-160`) (S2) |
| Uploaded active content runs on the shared origin | `CSP: sandbox`, `nosniff`, octet-stream for active types (`server/server.js:1830-1854`, `:1509-1511`) | unchanged; it matters more now, and S1 adds a test for each file-serving route |

**Not isolated: the residual, stated plainly**

On one origin, **any script that runs on any trip's path can act as the
traveller on every other trip that browser has a session for**. It can:

- read every namespaced key in `localStorage`. The namespace prevents
  collisions, not reads;
- `fetch('/t/<other>/api/…')`. In launched mode the gateway attaches the
  `kit_runtime` cookie for that path and injects that trip's token. `Path` is not
  a security boundary, and `SameSite` does nothing between same-origin paths;
- open `/t/<other>/` in a hidden iframe and script it, since it is the same
  origin;
- pass the trip-mcp consent step's "second lock" (`server/trip-mcp/index.js:228-238`
  checks `Origin === origin`), because every trip now has the same Origin.

That script can come from three places:

- an XSS bug in either front-end (`site/app.js` has 82 `innerHTML` writes);
- a trip container running an older or vulnerable release. Containers are
  deployed one by one, so **the weakest trip release sets the security of all
  trips on the host**;
- a compromised trip container, which serves its own static JS.

On subdomains, each of those stays inside one trip.

How much this matters: the exposure is limited to the trips **one browser** has
signed into. For most travellers that is one trip. Organizers and family members
who travel together often are the people who hold several.

**Mitigations included in this track**

1. A strict CSP set **by the gateway**, so a container cannot loosen it:
   `script-src 'self'` plus the named Google/Telegram widget hosts, no
   `unsafe-inline`, `object-src 'none'`, `base-uri 'none'`, `connect-src 'self'`
   plus named hosts.
   - It ships report-only in S1 and is enforced in S2 once the reports are clean.
   - That needs the inline loader script in `site/index.html` moved to a file and
     the three `onclick=` strings in `site/app.js` replaced.
2. Path mode refuses to boot on the default JWT secret, and tokens carry `aud`
   (S1). A stolen token stays useless outside its own trip.
3. Launched mode adds a **per-trip CSRF check**. The gateway injects a cookie's
   token only when the request carries `X-Kinerary-Trip: <trip_id>`, and only
   the trip's own page sets that header (`runtime-base.js` adds it). This stops
   a *plain* cross-trip request, for example a form or an `<img>`. It does not
   stop script, which can set any header. S2 states that in its own notes.
4. Gateway-served pages ship `X-Content-Type-Options: nosniff`, the
   `Referrer-Policy: same-origin` header, and no `Service-Worker-Allowed`.
5. Gateway access logs record `trip_id`, the mode and the status, never tokens or
   query strings. A cross-trip request pattern can then be seen.

**Mitigations considered and not proposed here**

- *Gateway serves one pinned front-end build for all trips*, rather than each
  container serving its own static files. This closes the "weakest release" hole
  for static assets, but couples every trip to one front-end version against
  APIs of varying age. That is its own spec, not Track 4.
- *Trusted Types*: worth adding after CSP is enforced; not scoped.
- **The structural alternative:** one wildcard record `*.<trip-domain>` plus a
  gateway that routes by `Host`. This is the k3s plan's decision 3, applied to
  compose. It removes every per-trip DNS record, tunnel rule and proxy host, which
  is S3's whole operational benefit, and it **keeps browser isolation per trip**.
  What it does not give is one domain for Telegram Login and the Mini App, or
  one Google JavaScript origin. The Mini App, though, frames the runtime from
  the portal origin either way. This is Q1, put to Dror before S1 is briefed.
  It is not a reason for this spec to quietly change the requested direction.

## Behaviour (track level, when S1–S4 are done)

- A new trip is reachable at `https://<RUNTIME_HOST>/t/<trip_id>/`. Its organizer
  receives that link, and its companion is rendered with it.
- Provisioning a trip creates no DNS record, no tunnel ingress rule and no proxy
  host. Tearing one down removes any it has.
- A migrated live trip's old subdomain sends visitors to the new path for the
  deprecation window, keeps its MCP connector working, and is then removed.
- Signing into trip A and then trip B in one browser leaves both signed in.
  Signing out of one leaves the other signed in.

## Non-goals

- **Telegram Login / Mini App enablement.** This track unlocks it; it does not
  ship it. The follow-on is listed below.
- **The trip-mcp member connector on a path-routed trip.** Today trip-mcp
  refuses any request with `X-Forwarded-Prefix` (`server/trip-mcp/index.js:12-16`,
  `:85-88`) and requires an origin with no path (`:36`). Under path routing:
  - new path-routed trips start with the connector **off**;
  - migrated trips keep it on their legacy subdomain for the deprecation window
    (S4);
  - a path-issuer connector (`/.well-known/oauth-authorization-server/t/<trip_id>`
    under RFC 8414 path insertion) and a consent step that no longer leans on
    Origin need their own spec (Q5).
- The k3s migration. If Dror approves this track, decision 3 in
  `docs/future/k3s-home-deployment-sprint-plan.md` needs a matching update. The
  doc-keeper proposes that edit after approval; this spec does not make it.
- A unified account across trips.

## Follow-on unlocked: Telegram SSO and the Mini App

- Register `<RUNTIME_HOST>` once as the bot's Login Widget domain. The archived
  runbook's per-bot step (`docs/archived/telegram-sso.md:26-29`) then covers
  every trip, and `POST /api/auth/telegram-login` (still in `server/server.js`)
  becomes usable on provisioned trips.
- The Mini App (PR #359) frames `RUNTIME_ORIGIN/t/<trip_id>/`. After S2 that
  origin exists, so real-Telegram acceptance of the framed runtime can run.
- Google: one JavaScript origin for every trip.

Each is a separate item for Sprint 8 or later, with its own spec.

## Rollout and regression

- S1 and S2 change nothing for any live trip. S1 is inert unless
  `PUBLIC_BASE_URL` has a path. S2 adds a new service and a new host, and no
  live trip has a route there yet.
- S3 changes new trips only.
- S4 is the live-trip change, one trip at a time, each one an approved step
  (hard rule 2).
- A regression plan is needed for S1 (the auth path and `server/server.js`), S2
  (migration, gateway) and S4 (live-trip behaviour), per the MVP rules in
  CLAUDE.md. S3 needs one because it changes provisioning.

## Open questions for Dror (before approval)

- **Q1. Shared-origin residual or wildcard host?** Accept the residual above (path
  routing, as requested), or take the wildcard-host alternative, which keeps
  isolation and still drops per-trip DNS and proxy work but gives no single
  domain for Telegram Login?
- **Q2. Which hostname is `<RUNTIME_HOST>`?** It must not be the portal's origin.
  Also: do we want a `/t/<slug>` alias (302 to the id, only while that slug's
  trip is live)?
- **Q3. `/t/` or `/trips/`?** The recommendation is `/t/`, because it is what the
  existing code uses.
- **Q4. Is the classic site retired for path-routed trips?** The recommendation
  is to keep it via the shim for now.
- **Q5. MCP connector:** off for new path-routed trips until a follow-up spec, or
  is that a regression you will not accept? The connector rollout is narrow today.
- **Q6. Deprecation window for old subdomains:** the proposal is the later of 60
  days after migration and 14 days after the trip ends.
- **Q7. Which trip is S4's first, test-only migration?** It must not be a
  family's live trip.
