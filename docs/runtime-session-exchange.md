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
  "runtimeUsername": null
}
```

The trip ID, global user ID, role, and optional local username must match the
persisted identity binding. A null username resolves an existing binding;
it never creates one. Success returns `{ "token": "<trip JWT>" }`, expiring
in 12 hours. The gateway seals it in a trip-path-scoped HttpOnly cookie and
supplies it upstream. Its claims include both the local username and the
managed trip/user identity.

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

## Classic, Modern, and logout

Both interfaces call the same authenticated endpoints and see the same
`/api/auth/me` user and organizer flag. The gateway sets CSP `frame-ancestors`
to the configured portal, replacing upstream `X-Frame-Options: DENY` while
preserving other upstream CSP directives. Direct runtime framing rules do not
change.

Both interfaces call the shared gateway logout helper when opened under
`/t/<trip>/`. `POST /t/<trip>/__logout` requires a custom same-origin request
header, expires only that trip's cookie, and returns the configured portal
URL. Framed pages notify only their configured portal; the portal accepts the
message only from its active iframe and returns to My trips. Failed logout
does not clear the UI's session state. Direct Classic logout also clears the
legacy Modern token aliases so switching interfaces cannot restore the old
local session. Portal account logout remains a separate action.

## Verification

`tests/control-plane-session.test.js` runs the real runtime, gateway and MCP
against disposable data. Only grant consumption and route lookup are fixture
control-plane responses. It covers owner/member permissions, key rejection,
trip and identity mismatch, invitation conflicts, unchanged Classic passwords,
both HTML shells, MCP updates through two gateway streams, reconnection,
logout, and participant removal. Portal database tests separately cover
single-use grant consumption and invitation retry identity consistency.

`tests/runtime-logout.test.js` covers shared browser logout and failure behavior;
the organizer web test verifies iframe origin/source checks. No deployment or
live-account migration is implied by these local checks.
