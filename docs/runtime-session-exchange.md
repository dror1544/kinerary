# Portal → trip session exchange

The runtime session bridge lets a portal member open the same local trip
identity in Classic or Modern. It does not create a second participant, copy
portal passwords or Google credentials, or change local passwords. Existing
direct password/Telegram/Google sign-in continues to use its existing JWTs.

## Configuration

A managed runtime needs `CONTROL_PLANE_EXCHANGE_KEY`, matching the gateway's
`RUNTIME_EXCHANGE_KEY` and the API's configured `runtimeExchangeKey`. It must
be distinct from the runtime's `JWT_SECRET` and `HERMES_API_KEY`. The gateway
and control plane are trusted identity services; possession of this exchange
key is privileged. The key is never sent to a browser or companion.

The private `$TRIP_DIR/control-plane.identity.json` file binds the runtime to
its control-plane trip and owner. `CONTROL_PLANE_IDENTITY_FILE` can override
that path. Example (illustrative identifiers only):

```json
{
  "version": 1,
  "tripId": "trip_example1234",
  "owner": { "userId": "user_example1234", "username": "alice" }
}
```

The owner must already be an active local participant and configured
organizer. No ambiguous name matching or “first participant is the owner”
fallback is allowed. Missing or invalid configuration disables portal login;
direct login remains available.

The worker generates this sidecar from the active owner membership and the
transformer's uniquely resolved organizer. An unresolved organizer produces
`owner: null`, which fails closed at the runtime. First-time LXC bootstrap
writes the exchange key to its mode-600 `.env` when configured on the worker.
It never stores the key in topology YAML or public trip config.

Existing runtimes need their private identity sidecar and exchange key installed
explicitly before deployment/restart. Their existing `.env` is not overwritten.
An owner reassignment is an explicit identity migration: conflicting stored
bindings fail closed rather than silently transferring an account.

## HTTP contract

All internal routes require the dedicated `X-API-Key`; traveler JWTs and the
companion's key cannot authenticate them. All responses use `Cache-Control:
no-store`. Browser proxy paths cannot reach `/api/internal/*`.

`POST /api/internal/control-plane/session` accepts:

```json
{
  "tripId": "trip_example1234",
  "userId": "user_example1234",
  "role": "owner",
  "runtimeUsername": null,
  "dashboardUrl": "https://portal.example/trips/trip_example1234/setup"
}
```

The trip ID, global user ID, role, and optional local username must match the
persisted identity binding. A null username resolves an existing binding;
it never creates one. Success returns `{ "token": "<trip JWT>" }`, expiring
in 12 hours. The gateway seals it in a per-trip HttpOnly cookie and supplies it
upstream. Its claims include both the local username and the managed trip/user
identity.

`dashboardUrl` is optional. The control plane builds it from the portal's
configured public origin (`web.public_origin` + `/trips/<tripId>/setup`; no
hostname lives in code). Two parties check it, each what it knows:

- the **gateway** knows the portal's origin: it passes the URL on only if it is
  exactly `PORTAL_ORIGIN + "/trips/<tripId>/setup"`, and otherwise leaves it out;
- the **runtime** checks shape only: it keeps the URL in the signed claim only for
  an `owner` or `organizer`, and only if it is `https://<origin>/trips/<this
  trip's id>/setup` (http only for a loopback host in development), with no
  credentials, query or fragment and at most 2048 characters. It cannot tell the
  portal's origin from another https host, which is why the gateway pins it.

Anything else is dropped, not an error.

`GET /api/auth/me` adds `dashboard_url` **only** to a managed owner/organizer
session. `authRequired` is unchanged and carries no claim; `/api/auth/me`
verifies the Bearer token again (signature, binding, active participant, current
local organizer role) and reads the URL from that verified claim. Members,
direct logins, the agent key and a demoted organizer get no such field, and
`sanitizeConfig` / `/api/config` are untouched. Trip UIs show an "Organizer
dashboard / לוח המארגן" menu entry only when it is present and an http(s)
URL without credentials, and never write it to `localStorage`.

`GET /api/internal/control-plane/participants/:username` requires the trip ID
in `X-Control-Plane-Trip-Id` and checks that an active participant exists.

`POST /api/internal/control-plane/participants` accepts `tripId`, `userId`,
`runtimeUsername`, and `inviteId` from the trusted invitation redemption path.
It binds an existing non-organizer participant as a member, idempotently by
invite and identity. Conflicting users/usernames/invites return 409; claiming
an organizer through a member invitation returns 403. The portal keeps
password and Google authentication; the runtime receives only identity fields.
Password invitations use a stable derived user ID so a failed database commit
can retry an already-recorded runtime binding. Co-organizer promotion and
owner reassignment are not performed through member invitations.

Managed JWTs are checked against the binding, active participant list, and
current local organizer permissions on each authenticated request. Removing a
local participant therefore invalidates their managed access. Portal-side
membership is rechecked when consuming each launch grant; an already-issued
session otherwise lasts up to 12 hours, as does the gateway cookie.

## Opening a trip: a top-level form POST, no frame

The portal no longer frames the trip. `Open trip` (dashboard) and the Mini App
call `POST /v1/trips/:id/launch` (CSRF-protected, needs `runtime_access`; a 90 s
single-use grant) and submit a hidden **top-level** form:

```
POST {runtimeOrigin}/t/{tripId}/__launch
Content-Type: application/x-www-form-urlencoded
Origin: {portal origin}          (sent by the browser)

token={grant}
```

The grant is in the body, never in a URL, a history entry or a log. The gateway:

1. requires `Origin` to equal `PORTAL_ORIGIN` exactly. Missing or the literal
   `null` is refused, so the portal must not send `Referrer-Policy: no-referrer`
   and the form carries no `rel`/`referrerpolicy`. The portal sets
   `strict-origin-when-cross-origin` (`web/nginx.conf`, `web/index.html`);
2. accepts only `application/x-www-form-urlencoded` (JSON is kept for a rollback
   to the previous portal build, under the same Origin rule); `text/plain` and
   multipart are refused, so a cross-site form cannot plant a session;
3. consumes the grant at the control plane (single use, trip- and audience-bound),
   asks the trip for the session (above) and replies **303 to `/t/<trip>/`**
   with the cookie. Every failure is the same small no-store HTML page linking
   back to the portal (403 wrong Origin, 400 malformed, 401 spent/foreign/failed
   grant, 503 unavailable); it never says whether a trip exists.

Cookie: `__Host-kit_rt_<tripId>` (plain `kit_rt_<tripId>` on an http runtime
origin), `Path=/`, no `Domain`, `HttpOnly`, `Secure`, **`SameSite=Strict`**, 12 h.
One cookie per trip, name-scoped, because the runtime origin is shared by every
trip: a `__Host-` cookie cannot be planted from a sibling subdomain. Strict means
the portal and the runtime origin **must be the same site** (a shared registrable
domain). From another site the browser stores the cookie after the launch POST but
does not send it on the 303, and every launch would loop back to the portal. So the
gateway **refuses to start** (a loud `runtime_gateway.cross_site_origins` error)
when `PORTAL_ORIGIN` and `RUNTIME_ORIGIN` are not the same site. "Same site" is the
registrable domain approximated by the last two hostname labels; when the shared
domain sits under a public suffix such as `co.uk`, name it in
`RUNTIME_PUBLIC_SUFFIXES` (comma separated) so three labels are compared; two
non-DNS hosts (`localhost`, an IP) are the same site only if the hostnames are
equal. `RUNTIME_SAME_SITE_OK=1` overrides a wrong guess and logs
`runtime_gateway.cross_site_origins_allowed` on every start. The portal's launcher
still stops after three launches of one trip in 20 seconds, as a last resort.

An unauthenticated top-level navigation under `/t/<trip>/` (Sec-Fetch-Mode
`navigate`, or `Accept: text/html` when Fetch Metadata is absent) is answered
**303 to `{PORTAL_ORIGIN}/trips/<tripId>/app`**: a fixed path, no route lookup, no
query or return path reflected, identical for existing and nonexistent trips. A
script's fetch keeps the 401 JSON. The old "wait for a postMessage" bootstrap page
and both message listeners are gone.

**Revocable sessions.** `POST /v1/trips/:id/launch` records the launching portal
session's ID (`web_sessions.id`, not its token digest) on the grant
(`runtime_launch_grants.session_id`); the consume response returns it and the
gateway seals it, with the portal user, in the per-trip cookie. On every request
the gateway asks `POST /internal/runtime-sessions/check` (exchange key, compared
in constant time) whether **that exact session** is still live (not revoked, not
expired, same person), and whether the person is still active and still has
`runtime_access` on the trip, **with the same role the session was opened with**
(the role is sealed in the cookie; a demotion or promotion at the control plane
answers 401, so the person opens the trip again and is issued a session for the
role they now hold, and `/api/auth/me` stops showing `is_organizer` and
`dashboard_url`). A positive answer is cached for at most 30 s per
launching session (`RUNTIME_SESSION_CHECK_TTL_MS` lowers it, for tests), a
negative one never, and an unreachable control plane means refusal. Signing out
of the portal on one device therefore ends the trip session opened from that
device within 30 s and leaves the one opened from another device working;
removal from the trip or disabling the account ends them all. A grant minted
before the column existed carries no session (`NULL`) and keeps the earlier rule
(any live portal session of the person) until it expires, 90 s, so a rollback of
the portal is compatible. The column is deliberately not a foreign key: a
deleted session must answer "no", not be rewritten to `NULL`. A stream already
open ends at its next reconnect.

Every call the gateway makes to the control plane or a trip carries a timeout
(5 s; `RUNTIME_UPSTREAM_TIMEOUT_MS`), so a hung service fails closed quickly: the
live check answers "no" and a launch shows the generic failure page.

**Shared runtime origin.** Every trip opened from the portal lives on one origin.
The trip UIs therefore scope `trip-token`, `tripToken`, `token` and `trip-user`
in `localStorage` with the trip's `/t/<trip>` base (`runtime-base.js`); the
dashboard link is never persisted; the proxied responses keep the trip's
`X-Content-Type-Options`, photo `Content-Security-Policy: sandbox` and
HTML/SVG/JS-as-`octet-stream` rules, and the gateway adds `frame-ancestors
'none'` (and `X-Frame-Options: DENY`) because nothing frames the trip any more.

## Classic, Modern, and logout

Both interfaces call the same authenticated endpoints and see the same
`/api/auth/me` user and organizer flag.

Both interfaces call the shared gateway logout helper when opened under
`/t/<trip>/`. `POST /t/<trip>/__logout` requires a custom same-origin request
header, expires only that trip's cookie, and returns the configured portal
URL; the page then navigates to it. Failed logout does not clear the UI's
session state. Direct Classic logout also clears the legacy Modern token
aliases so switching interfaces cannot restore the old local session. Portal
account logout remains a separate action.

## Verification

`tests/control-plane-session.test.js` runs the real runtime, gateway and MCP
against disposable data. Only grant consumption and route lookup are fixture
control-plane responses. It covers owner/member permissions, key rejection,
trip and identity mismatch, invitation conflicts, unchanged Classic passwords,
both HTML shells, MCP updates through two gateway streams, reconnection,
logout, portal sign-out ending the trip session, uploaded HTML/SVG staying
non-executable behind the gateway, `dashboard_url` for owners and never for
members, direct logins or the agent key, and the form-POST launch. Portal
database tests separately cover single-use grant consumption, the session
check, and invitation retry identity consistency. `tests/control-plane-dashboard-url.test.js`
covers a non-owner organizer and a demoted one.

`tests/runtime-logout.test.js` covers shared browser logout, failure behavior and
the per-trip storage scoping; `control-plane/runtime-gateway/test/gateway.test.js`
covers the Origin/content-type rules, replay, the portal redirect and the
liveness check; `web/src/pages/runtime-launcher.test.tsx` covers the form POST,
the back/forward guard and a source guard that no iframe or message hand-off
remains. No deployment or live-account migration is implied by these local checks.
