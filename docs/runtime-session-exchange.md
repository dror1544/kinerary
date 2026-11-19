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
key is privileged. The key is never sent to a browser or companion. (A deployment
can give each trip site a key of its own instead: "Per-trip keys" below. Once it does,
a trip site no longer holds this key at all, and this key must be a different value from
the trip key master and the legacy trip key.)

The private `$TRIP_DIR/control-plane.identity.json` file binds the runtime to
its control-plane trip and owner. `CONTROL_PLANE_IDENTITY_FILE` can override
that path. Example (illustrative identifiers only):

```json
{
  "version": 1,
  "tripId": "trip_example1234",
  "owner": { "userId": "user_example1234", "username": "alice" },
  "portalOrigin": "https://portal.example"
}
```

`portalOrigin` is optional: the portal's own origin, the control plane's
`web.public_origin`. The runtime builds an organizer's dashboard address from it
(`<portalOrigin>/trips/<tripId>/setup`) when they did **not** arrive through the
gateway, for instance a direct login on the trip's own hostname or the installed
app. It must be a plain origin, checked on the raw text: `https://<ASCII DNS name>[:port]`
or `http://<loopback>[:port]`, with at most one trailing slash. No credentials, path,
query or fragment; no backslash, `%`-escape, whitespace, Unicode, trailing dot or
leading-zero port; the name's last label is not all digits. Anything else is treated
as not set, and the runtime logs `control_plane.portal_origin_invalid` once at start.
The worker (`normalize_portal_origin`) and the runtime (`safePortalOrigin`) apply the
same rule and are both tested against `tests/fixtures/portal-origin-cases.json`.
The origin is read from configuration only, never from a request.
`GET /api/auth/me`, which now carries that per-person address, answers
`Cache-Control: no-store`.

The owner must already be an active local participant and configured
organizer. No ambiguous name matching or “first participant is the owner”
fallback is allowed. Missing or invalid configuration disables portal login;
direct login remains available.

The worker generates this sidecar from the active owner membership and the
transformer's uniquely resolved organizer. An unresolved organizer produces
`owner: null`, which fails closed at the runtime. First-time LXC bootstrap
writes the exchange key to its mode-600 `.env` when configured on the worker.
It never stores the key in topology YAML or public trip config.

`portalOrigin` comes from the worker's `CONTROL_PLANE_PORTAL_ORIGIN`, which a
deployment sets to the same value as the API's `web.public_origin` (both compose
files pass it through; no hostname lives in code). Unlike the exchange key, it is
in the sidecar, and the worker rewrites the sidecar on **every** provision, so a
trip built before this existed gets it at its next redeploy, not only when its
container is rebuilt. The worker says so at start when the variable is unset
(`provisioner.portal_origin_unset`, INFO) or is not a plain origin
(`provisioner.portal_origin_invalid`, WARNING; the value is not echoed). A trip not yet
redeployed keeps the old behaviour: the link appears only for a gateway launch.

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

`GET /api/auth/me` adds `dashboard_url` **only** for an organizer (an active
participant who is a configured organizer *now*), by whichever way they reached
the trip. Through the gateway the Bearer token is verified again (signature,
binding, active participant, current local organizer role) and the URL is read
from that verified claim. Any other way in (a direct login on the trip's own
hostname, the installed app) gets the address configured by the sidecar's
`portalOrigin` and this trip's id. Where both exist and differ, the configured
one is served: configuration knows the portal's origin and a claim is not trusted
for it. `authRequired` is unchanged and carries no claim. Members, a demoted
organizer, the agent key and a trip with no configured `portalOrigin` get no such
field (a direct login on such a trip gets none), and `sanitizeConfig` /
`/api/config` are untouched. Trip UIs show an "Organizer
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
`dashboard_url`). When that portal session is a **Telegram-scoped** one (minted by
a Mini App sign-in, `web_sessions.telegram_link_id` set; `portal-scope.ts`), the
check also asks whether the trip is **still in that session's scope**, re-derived
from the live link rows by the same `scopeDecision` the portal applies to the
launch itself. A trip that has left the scope (the link that put it there was
unlinked, or it never was in scope) answers `401 SESSION_REVOKED`, exactly as a
revoked session does, so the open trip page ends within the cache window below. A
full (password / Google) session is not scoped and is unaffected; a scope that
cannot be read counts as empty. Asserted by `RUNTIME CHECK` in
`control-plane/api/test/portal-scope-db.test.ts` and, for the gateway ending the
session on that answer, by `a trip that leaves a scoped session's scope` in
`control-plane/runtime-gateway/test/gateway.test.js`. A positive answer is cached for at most 30 s per
launching session (`RUNTIME_SESSION_CHECK_TTL_MS` lowers it, for tests), a
negative one never, and an unreachable control plane means refusal. Signing out
of the portal on one device therefore ends the trip session opened from that
device within 30 s and leaves the one opened from another device working;
removal from the trip or disabling the account ends them all. A grant minted
before the column existed carries no session (`NULL`) and keeps the earlier rule
(any live portal session of the person) until it expires, 90 s, so a rollback of
the portal is compatible. The column is deliberately not a foreign key: a
deleted session must answer "no", not be rewritten to `NULL`. A live-update
(`text/event-stream`) response is asked about again while it is open, every half
cache window (15 s with the defaults), and is ended on the first "no": a stream
held open would otherwise carry the trip's data to a signed-out device for as long
as the 12-hour cookie (`endStreamWhenSessionEnds`; before 2026-10-20 it ended only
at its next reconnect). The browser then reconnects with its backoff and the new
connection is refused like any other request. A page that is already drawn stays
drawn until its next request (its minute-by-minute refresh, or any click), which
answers 401 and shows the sign-in; that is the window to expect when checking a
sign-out by eye, together with the up-to-30-second cached answer.

**Silent drops are logged.** An owner or organizer whose dashboard link does not
make it into the session shows no "Organizer dashboard" entry and no error. The
gateway logs `runtime_gateway.dashboard_url_dropped: trip=… role=… reason=absent|
not_this_portals_setup_page|unparseable expected_origin=… [received_origin=…]` when
it drops one, and the trip logs `control_plane.session_without_dashboard_url:
role=… reason=not_sent|rejected` when it mints an owner/organizer session without
one. Neither prints the URL, a grant or a token. Both lines appear once per launch.

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

## Host mode: a trip by its own hostname

Spec: `docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md` (R1). Everything
in this section is **off** unless the gateway has `TRIP_HOST_SUFFIX` set; unset,
the gateway behaves exactly as described above and none of this code runs.

With `TRIP_HOST_SUFFIX=<suffix>` a request whose `Host` (lower-cased, port
removed) is exactly one DNS label under the suffix, and is not `RUNTIME_ORIGIN`'s
own host, is routed **by host**. The bare suffix, a deeper name and a name that
is not a valid label are answered 404 with no lookup. Every other host keeps the
`/t/<trip_id>/` handling above. A deployment points one wildcard name at the
gateway; no per-trip record is needed.

**Registry.** The gateway asks the control plane
`GET /internal/runtime-routes/by-host/<host>` (exchange key in `x-api-key`, the
same as the lookups above). It reads `control_plane.runtime_routes`
(`public_host`, `upstream_url`, added by `20261116120000_runtime_route_hosts.sql`;
both are nullable, and a row without them behaves exactly as before) and answers
`{ tripId, routeRef, upstreamOrigin }` for a row in state `ready` with that host
and an upstream. Every other case is `404 RUNTIME_NOT_READY` with one body (no
such host, not ready, no upstream, not a name). The upstream must be `http:` or
`https:`, with no credentials, path, query or fragment, and its host must be in
`web.runtime_upstream_allowed_hosts` in the API's profile: exact hostnames, IPv4
addresses and IPv4 CIDR blocks (no IPv6; a prefix shorter than /8 is refused at
load). An empty or absent list allows nothing, and then the answer is
`503 RUNTIME_ROUTE_INVALID`. The gateway checks the answer
again and proxies only to the origin returned for that exact host.

**The by-trip-ID lookup answers where the gateway SENDS a trip's calls** (the launch's session
exchange, participant provisioning, the participant check), not where a browser goes. A wildcard
trip's `private_url` is its public name, and in host mode `/api/internal/*` on a public name is 404
by design, so `GET /internal/runtime-routes/<trip_id>` answers with the route's registered LAN
`upstream_url` when the API has a non-empty `web.runtime_upstream_allowed_hosts` and the route
has an `upstream_url`: `upstreamOrigin` is that origin, validated exactly like the by-host answer,
and `upstreamBasePath` is empty. An `upstream_url` that fails that validation is
`503 RUNTIME_ROUTE_INVALID`; it is never replaced by the public URL. With no list, or no
`upstream_url` (every row written before the host columns existed), the answer is the one it
always was, from the job's `private_url` and `runtime_upstream_host_suffixes`. `private_url` itself,
and every link a browser is sent, are unchanged. Covered by
`control-plane/api/test/runtime-wildcard-e2e.test.ts` (the real API and the real gateway, with only
the trip site faked: a portal launch and participant provisioning both reach the site's internal
routes on the LAN) and `runtime-route-hosts.test.ts`.

**Transparent proxy.** Each trip hostname is its own origin, so the gateway adds
and removes no credential: method, path, query, body, `Cookie`, `Authorization`
and `Host` reach the trip unchanged, and the status, headers (`Set-Cookie`
included) and body come back unchanged. The gateway adds `X-Forwarded-Host`,
`X-Forwarded-Proto` (the scheme of `RUNTIME_ORIGIN`; a client's own value is
never believed) and an `X-Forwarded-For` that ends with the peer address, and
removes a client-sent `X-Forwarded-Prefix` and the hop-by-hop headers. Bodies
are streamed in both directions and never buffered, so a photo upload larger
than the gateway's JSON limits goes straight through; a `text/event-stream`
response streams, and closing the browser side closes the upstream. The trip
site does not use WebSocket upgrades (nothing in `server/` or `site/` does), so
none are proxied. `/api/internal/*` on a trip host is 404 in any spelling
(case, percent-encoding, `//`, dot segments) and is refused before the lookup.

**Failure and caching.** A name with no ready route gets one small 404 page,
identical for every such name, `cache-control: no-store`. A miss is cached for
5 seconds and a hit for 30 (so tearing a trip down is seen within 30 seconds).
A control plane that cannot be asked is 503, an answer that fails the checks
above or an upstream that cannot be reached is 502, and failures are not cached.
Per-connection timeouts: `RUNTIME_UPSTREAM_TIMEOUT_MS` bounds the control-plane
call and the connection to the upstream; `TRIP_HOST_RESPONSE_TIMEOUT_MS`
(default 120000) bounds the wait for the upstream's first byte *after* the
request has been fully sent.

Gateway environment: `TRIP_HOST_SUFFIX` (a lower-case DNS name such as
`trips.example.org`; a malformed value stops the gateway at start) and the
optional `TRIP_HOST_RESPONSE_TIMEOUT_MS`. Covered by
`control-plane/runtime-gateway/test/host-mode.test.js` and
`host-mode-off.test.js`, and, on the control-plane side, by
`control-plane/api/test/runtime-route-hosts.test.ts`.

## Per-trip keys: one key for each trip site

Spec: `docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md` (K2). Everything
in this section is **off** unless the gateway has `RUNTIME_TRIP_KEY_MASTER` set
(and, for a new trip's key, the worker has `CONTROL_PLANE_TRIP_KEY_MASTER`);
unset, one key does everything, as described under Configuration.

Three keys, where there was one:

- the **control-plane key** (`RUNTIME_EXCHANGE_KEY`, unchanged) authenticates the
  gateway to the control plane and the control plane to the gateway's own
  `/internal/t/*` routes. A trip site is never sent it once per-trip keys are on;
- the **trip key master** (`RUNTIME_TRIP_KEY_MASTER` on the gateway,
  `CONTROL_PLANE_TRIP_KEY_MASTER` on the worker, one value) never leaves those two. A trip site
  holds `derive(master, trip_id) = hex(HMAC-SHA256(master, "kinerary-trip-exchange:v1:" + trip_id))`
  in its `.env` as `CONTROL_PLANE_EXCHANGE_KEY`, so what one trip holds opens no other;
- the **legacy trip key** (`RUNTIME_LEGACY_TRIP_KEY`) is the old shared value, kept only to
  reach trips that have not been re-keyed.

The trip site's own code does not change: it compares the key it is sent with its
`.env` value, as before. What changes is which key the gateway sends. Each route
records the kind its trip holds, `runtime_routes.trip_key` (`shared`, the default, or
`derived`; migration `20261116140000_runtime_route_trip_key.sql`), and both route
lookups return it as `tripKey` (a kind, never a key; only behind the exchange key).
With the master set, for the four calls the gateway makes to a trip (the launch's
`session`, `participants`, `participants/<name>` and the group line's `plan-changes`):

| route's `tripKey` | sent to the trip |
|---|---|
| `derived` | `derive(master, trip_id)`, for the trip id the route was looked up for |
| `shared` | `RUNTIME_LEGACY_TRIP_KEY`; if it is unset, **503 and nothing is sent** |
| anything else, or absent (an older control plane) | **503 and nothing is sent** |

**`plan-changes` (the group line's read).** The control plane never calls a trip site: the group-line
poller (`plan-change-poller.ts`) asks the gateway, `GET /internal/t/<trip id>/plan-changes[?since=<revision id>]`
with `RUNTIME_EXCHANGE_KEY`, checked like the participant routes (wrong or absent: 401, and nothing is sent to
any trip). The gateway looks the trip's route up, picks the key by the table above as for every other call,
and reads `GET <upstream>/api/internal/control-plane/plan-changes` with that key and `X-Control-Plane-Trip-Id`.
Only `since` is carried over, and only if it fits the site's own shape (`[A-Za-z0-9_-]{1,100}`, once; anything
else is 400 with no request; a trip id of the wrong shape is 404). A redirect from the site is never followed and is a 502; so is a body over 512 KiB
or a 2xx that is not JSON; other statuses pass through with the site's JSON body. With per-trip keys off the site
is read with `RUNTIME_EXCHANGE_KEY`, as before. The group line therefore depends on the gateway being up: when it
is not, a poll fails with `plan_change_poll.failed` and `safe_error_code: SITE_UNREACHABLE` (a gateway that
answers 503/502 shows as `SITE_HTTP_503`/`SITE_HTTP_502`), the trip's cursor does not move and the next
minute's poll sends the net difference. Pinned by `runtime-gateway/test/plan-changes.test.js` and
`control-plane/api/test/runtime-wildcard-e2e.test.ts` ("AC-K2.11").

One key per request, chosen before it is sent. A trip that answers 401 to its key is
not tried with another: a retry would hand the legacy key to whichever trip asked for
it. The refusal is logged without a key (`runtime_gateway.trip_key_unavailable`), and a
legacy key set with no master is logged at start (`runtime_gateway.trip_keys_off`).
A route is cached for 30 seconds, so a trip whose `trip_key` was just changed may
answer 401 for that long.

**The worker.** With `CONTROL_PLANE_TRIP_KEY_MASTER` set, a new trip's `.env` is born with
its derived key and the worker, after the deploy, asks the container which key it holds
(`ProxmoxLxcAdapter.exchange_key_kind`: compared in constant time, only the kind comes
back) and records that kind on the route in the transaction that marks the trip
`ready_private`. Asking the container, not the worker's settings, is what makes a
re-provision right: bootstrap writes `.env` only when there is none, so a re-provisioned
trip keeps the key it has, and its route keeps (or is corrected to) the kind it holds. A container
that holds neither candidate leaves the route as it is. Unset, nothing is read or derived and
a new trip gets the shared key and the column's default. Without the migration, a `shared` kind is
a warning (it is what a missing column means) and a `derived` one fails the job.
The key is never logged, never on a command line, and listed for redaction with the other
secrets of the bootstrap script.

**The three secrets must be three different values, and the services enforce it.** With
`RUNTIME_TRIP_KEY_MASTER` set, the gateway **refuses to start** when any two of
`RUNTIME_EXCHANGE_KEY`, `RUNTIME_TRIP_KEY_MASTER` and `RUNTIME_LEGACY_TRIP_KEY` (when set) are
equal, and the worker refuses to start when `CONTROL_PLANE_TRIP_KEY_MASTER` equals
`CONTROL_PLANE_EXCHANGE_KEY`. The message names the variables (for example
`runtime_gateway.trip_keys_not_distinct: RUNTIME_EXCHANGE_KEY and RUNTIME_LEGACY_TRIP_KEY hold the
same value; ...`) and never a value. Copying the current exchange key into
`RUNTIME_LEGACY_TRIP_KEY` and stopping there is therefore not a way to turn per-trip keys on: it
would leave every trip not yet re-keyed holding a credential that the control plane and the
gateway's own `/internal/t/*` routes also accept, which is the exposure per-trip keys exist to end.

**Rolling it out is a rotation** (per deployment, in this order; every step is required):

1. Deploy the migration.
2. Rotate the control-plane key. Make three new values, each independent of the others and of
   `RUNTIME_COOKIE_SECRET`:
   - the **current** `RUNTIME_EXCHANGE_KEY` becomes `RUNTIME_LEGACY_TRIP_KEY` (on the gateway only);
   - a **new** `RUNTIME_EXCHANGE_KEY` is given to the API and the gateway **together** (and, on the VM,
     reaches the worker through the same name). Until both have restarted on it, their calls to each
     other answer 401, so restart the two in one step;
   - a new `RUNTIME_TRIP_KEY_MASTER` is given to the gateway and the worker (the worker reads it as
     `CONTROL_PLANE_TRIP_KEY_MASTER`).
3. Restart the gateway and the worker. A start-up refusal above means a step was skipped.
4. Check, before any trip is moved: a trip that has not been re-keyed still launches from the portal
   (it is sent the legacy key), a new test trip is built with a derived key and launches, and the old
   value is refused by the control plane: `POST /internal/runtime-sessions/check` with the old value in
   `x-api-key` answers 401.
5. Move trips to a derived key one at a time: write the trip's derived key into its `.env`, restart its
   server and set its route's `trip_key = 'derived'` (a deploy, per trip, with approval).
6. When no route is `shared`, unset `RUNTIME_LEGACY_TRIP_KEY` and restart the gateway. The old value
   then opens nothing anywhere.

**What the legacy key still opens, once the rotation is done.** Only a trip site that has not yet been
re-keyed: each such site's `.env` still holds the old value, so the old value still passes that site's
own check on `/api/internal/control-plane/*`, and nothing else does. The control plane, the API's calls to
the gateway and the gateway's own `/internal/t/*` routes all compare against the NEW
`RUNTIME_EXCHANGE_KEY` and never accept the legacy key; the gateway never sends it to the control
plane, and it sends it to a trip only when that trip's route says `shared`. Each trip that is re-keyed
leaves that set, and the set is empty at step 6. Until then a holder of the old value (it was shared
by every site, so every site's operator and anyone who ever read one site's `.env`) can still call the
internal routes of the not-yet-re-keyed sites; rotation closes the control plane and the gateway to
it, not those sites, which is why step 5 is not optional in the long run.

(After the rotation the worker's own `CONTROL_PLANE_EXCHANGE_KEY` is the new key, so the "shared"
candidate `exchange_key_kind` compares against no longer matches a not-yet-re-keyed site, which holds
the old value. That leaves such a trip's route as it is, `shared`, which is right.)

Derivation parity between the gateway and the worker is pinned by
`control-plane/runtime-gateway/test/fixtures/trip-key-vectors.json`, read by
`runtime-gateway/test/trip-keys.test.js` and `control-plane/worker/tests/test_trip_keys.py`. The
refusals are pinned by `trip-keys.test.js` ("AC-K2.8") and
`control-plane/worker/tests/test_shared_bridge_site.py` ("AC-K2.9").

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
non-executable behind the gateway, `dashboard_url` for organizers (through the gateway or by direct
login) and never for members or the agent key, and the form-POST launch. Portal
database tests separately cover single-use grant consumption, the session
check, and invitation retry identity consistency. `tests/control-plane-dashboard-url.test.js`
covers a non-owner organizer, a demoted one, the configured address for a direct
login (present, absent when unset, absent and logged when malformed) and the
precedence between the claim and the configuration; the worker's sidecar and
`normalize_portal_origin` are in `control-plane/worker/tests/test_provisioner.py`.

`tests/runtime-logout.test.js` covers shared browser logout, failure behavior and
the per-trip storage scoping; `control-plane/runtime-gateway/test/gateway.test.js`
covers the Origin/content-type rules, replay, the portal redirect, the
liveness check, the re-check of an open stream and the dropped-dashboard log line; `web/src/pages/runtime-launcher.test.tsx` covers the form POST,
the back/forward guard and a source guard that no iframe or message hand-off
remains. No deployment or live-account migration is implied by these local checks.
