# Per-gateway relay keys and per-trip exchange keys

Status: draft (2026-11-16) · Issue: #597 · Track: security · Size: M · Tier: High
Security path: yes (relay gateway authentication, the companion control MCP, the trip site's control-plane routes, the runtime gateway) · Migration: yes (K2) · Live-trip behaviour: no (both parts are off until a deployment sets their mode)

Assigned by Dror, 2026-11-16, scheduled after the Alsace trip; started early
for staging on the same day ("if it is ready sooner it goes to staging before
the VM"). The acceptance criteria have not been reviewed line by line.

## Problem

Two credentials are shared more widely than the thing each one protects.

- **The relay's gateway secret.** The relay accepts a gateway whose token is
  `HMAC(secret, "<gateway id>:<exp>")` (`control-plane/api/src/relay/protocol.ts`,
  `verifyUpgradeToken`). Every gateway profile is given that same secret
  (`scripts/companion-install-host.sh`, `enroll_relay`), so a credential held
  for one gateway id is valid for every id. The companion control MCP
  (`companion-mcp.ts`) checks the same token.
- **The control-plane exchange key.** One key authenticates the runtime gateway
  to the control plane's internal routes, the API to the gateway's internal
  routes, and the gateway to every trip site's
  `/api/internal/control-plane/*` routes (`server/control-plane-auth.js`). Every
  trip site holds it in its `.env` (`provisioning/adapters.py`).

The requirement in both cases: a credential held by one gateway, or by one trip
site, is accepted only for that gateway or that trip, and the key that can
produce the others never leaves the components that need it.

## Behaviour

**K1: per-gateway relay keys.**

- A gateway's key is `derive(master, gateway_id)`, where
  `derive(m, id) = hex(HMAC-SHA256(m, "kinerary-relay-gateway:v1:" + id))`.
  The gateway signs its token with that key exactly as it signs today, so the
  Hermes side does not change.
- The **derivation master** is a secret no gateway profile has ever held:
  `relay.gateway_key_master_refs` (a rotation list), separate from
  `relay.gateway_secret_refs`, which keeps meaning "the shared-mode secrets".
  Turning on per-gateway keys is a rotation, like K2: a NEW secret is added
  first.
- The relay verifies a token by deriving the key for the id the token names.
  A key derived for one id cannot sign for another.
- `relay.gateway_key_mode` in the architecture profile: `shared` (default,
  today's behaviour: a token signed with a `gateway_secret_refs` secret),
  `both` (accept that, or a key derived from `gateway_key_master_refs`, for the
  changeover) or `derived` (only a key derived from `gateway_key_master_refs`;
  `gateway_secret_refs` is not consulted, so the old shared secret opens
  nothing). The relay and the companion control MCP read the same setting.
- Enrolling a gateway writes the key derived from the derivation master when
  the mode is `both` or `derived`, and the shared secret otherwise.
- `scripts/relay-rekey.py` rewrites the relay key of existing profiles on a
  host, so a deployment can move from `shared` through `both` to `derived`.

**K2: per-trip exchange keys, one key per direction.**

- Three keys, where today there is one:
  - the **control-plane key** authenticates the runtime gateway and the API to
    each other (today's `RUNTIME_EXCHANGE_KEY`, unchanged);
  - the **trip key master** never leaves the gateway and the worker. A trip
    site holds `derive(trip master, trip_id)`, with label
    `"kinerary-trip-exchange:v1:"`;
  - the **legacy trip key** is the old shared value, kept only to reach trips
    that have not been re-keyed.
- The trip site does not change: it already compares the key it is sent with
  the one in its `.env`.
- Each route records which kind of key its trip holds
  (`runtime_routes.trip_key`: `shared` or `derived`). The gateway sends the
  derived key to a `derived` trip and the legacy key to a `shared` one. It
  never tries one key and then the other.
- Turning per-trip keys on **is a rotation of the control-plane key**, not an
  option on top of it: the current value becomes the legacy key, and a new
  value goes to the API and the gateway together. Once it has, the legacy key
  opens only trips that still hold it (never the control plane, never the
  gateway's own `/internal/t/*` routes), and each re-keyed trip leaves that
  set. Left un-rotated the legacy key would still be the control-plane key, and
  every legacy trip would hold a credential the control plane and the gateway
  accept. The services therefore refuse to start in that state (AC-K2.8, K2.9).

## Acceptance criteria

### K1

- **AC-K1.1 Derivation.** `deriveGatewayKey(master, id)` in `protocol.ts`
  matches published test vectors, and the shell and Python minters produce the
  same value for the same inputs (one shared vector file, read by the
  TypeScript and Python tests).
- **AC-K1.2 Modes.** For a token for id A, with S the shared secrets
  (`gateway_secret_refs`) and M the derivation masters
  (`gateway_key_master_refs`; AC-K1.7):
  - in `shared` mode it verifies only when signed with a secret in S;
  - in `derived` mode it verifies only when signed with `derive(m, A)` for m in
    M;
  - in `both` mode it verifies with either.
  In every mode a token signed with `derive(m, B)` and naming A is refused.
  Rotation (several secrets, several masters) works in every mode. The
  comparison stays constant-time across all candidates.
- **AC-K1.3 One setting, two checkers.** The relay connector (WebSocket upgrade
  and media plane) and `companion-mcp.ts` take the mode from the same
  architecture-profile field. An unknown value fails config load. Absent means
  `shared`.
- **AC-K1.4 Enrolment.** `enroll_relay` writes `GATEWAY_RELAY_SECRET =
  derive(m, profile)` (m = `gateway_key_master_refs[0]`, AC-K1.8) and mints
  `COMPANION_CONTROL_TOKEN` with that key when the architecture profile's mode
  is `both` or `derived`; it writes today's values otherwise. Neither the
  derivation master nor the shared secret appears in the profile's `.env` in
  those modes. No key is printed or put on a command line.
- **AC-K1.5 Re-key.** `scripts/relay-rekey.py --profile <name>[,<name>…] |
  --all-enrolled`:
  - prints a plan (profile, gateway id, `shared → derived` or `already
    derived`), and changes nothing without `--execute`;
  - with `--execute`, rewrites only `GATEWAY_RELAY_SECRET` and
    `COMPANION_CONTROL_TOKEN` (when present), using each profile's own
    `GATEWAY_RELAY_ID`, keeping the file's other lines and its 0600 mode;
  - refuses a profile with no `GATEWAY_RELAY_ID`, a symlinked profile or
    `.env`, and a master it cannot read;
  - restarts nothing, and lists the gateways that need a restart to pick up
    the new key;
  - never prints a key.
- **AC-K1.6 Interviewer and multiplex.** The re-key script works for any
  enrolled profile, the interviewer included. The docs that tell an operator to
  set `GATEWAY_RELAY_SECRET` say what value to set in each mode.
- **AC-K1.7 The derivation master is one no profile has held** (owner review of
  #599, F1). `relay.gateway_key_master_refs` is required (at least one
  reference) when `gateway_key_mode` is `both` or `derived`; config load fails
  without it, and fails when a reference in it is also in
  `gateway_secret_refs`.
  - `shared` verifies against `gateway_secret_refs` only. `both` verifies
    against `gateway_secret_refs` or a key derived from
    `gateway_key_master_refs`. `derived` verifies only against a key derived
    from `gateway_key_master_refs` and does not consult `gateway_secret_refs`.
    A key derived from a shared secret verifies in no mode.
  - The relay (both ways of building its runtime, and the connector itself) and
    `companion-mcp.ts` refuse to start in `both` or `derived` when any resolved
    derivation master equals any resolved shared secret. The error names the
    two fields and never a value.
  - `vm-release.py`'s pre-switch configuration check reports the same
    condition (and a missing `gateway_key_master_refs`) for the references it
    can read, so it is a refused plan instead of a failed start.
  - Tested live-shaped: with a profile holding the old shared secret, after the
    re-key and `derived`, a key derived from that secret is refused for every
    gateway id on the WebSocket upgrade, on the media plane and by
    `companion-mcp`, and a key derived from the new master for its own id is
    accepted on all three.
- **AC-K1.8 Enrolment and re-key derive from the derivation master.**
  `enroll_relay` and `scripts/relay-rekey.py` derive from
  `gateway_key_master_refs[0]` (a `file://` reference, like today), and refuse
  when it is missing, unreadable, or equal to a shared secret in
  `gateway_secret_refs`; the refusal names fields, never a value. `enroll_relay`
  writes nothing and says `UNENROLLED`; `relay-rekey.py` writes nothing at all.
  No key on a command line, 0600 atomic writes, no key printed, and the script
  still parses under macOS `/bin/bash` 3.2. The re-key plan reports a profile
  holding a shared secret as `shared -> derived`.
- **AC-K1.9 Derived keys and token signatures are separate domains.** In every
  mode `verifyUpgradeToken` refuses a token whose id begins with the derivation
  label (`kinerary-relay-gateway:`), whoever signed it. In `both` and `derived`
  a derived key is considered only for an id containing no `:`;
  `deriveGatewayKey` throws for one, and `enroll_relay` and `relay-rekey.py`
  refuse such an id. In `shared` a token for an id with colons still verifies
  (the conformance vector `gw:with:colons` is unchanged). Real gateway ids are
  profile names (`^[a-z0-9][a-z0-9-]{1,62}$`), which contain no `:`. The shared
  vector file lists the refused ids (`refused_ids`) for all three minters.

### K2

- **AC-K2.1 Migration.** `<stamp>_runtime_route_trip_key.sql` adds
  `trip_key text NOT NULL DEFAULT 'shared' CHECK (trip_key IN ('shared','derived'))`
  to `control_plane.runtime_routes`. Header: `-- rollback: compatible — adds a
  column with a default; older code ignores it`.
- **AC-K2.2 Route lookup.** Both `/internal/runtime-routes/:tripId` and
  `/by-host/:host` return `tripKey`. It is never returned to a browser.
- **AC-K2.3 Gateway.** With `RUNTIME_TRIP_KEY_MASTER` unset the gateway sends
  `RUNTIME_EXCHANGE_KEY` to trips, as today. With it set:
  - a `derived` trip is sent `derive(trip master, trip_id)`;
  - a `shared` trip is sent `RUNTIME_LEGACY_TRIP_KEY`, and when that is unset
    the request fails with 503 and is not sent with any other key;
  - the control-plane calls and the check on the gateway's own `/internal/t/*`
    routes keep using `RUNTIME_EXCHANGE_KEY`;
  - a test proves trip A's derived key is refused by a fake trip B.
- **AC-K2.4 Worker.** With `CONTROL_PLANE_TRIP_KEY_MASTER` set, a new trip's
  `.env` gets `CONTROL_PLANE_EXCHANGE_KEY = derive(trip master, trip_id)`, and
  its route is written with `trip_key = 'derived'` in the transaction that
  marks it `ready_private`. Unset, the trip gets today's key and `trip_key =
  'shared'`. The key is never logged and never on a command line.
- **AC-K2.5 Re-provision.** Re-provisioning a trip keeps its `trip_key` unless
  it rewrote the trip's key.
- **AC-K2.6 Derivation parity.** The gateway (JS) and the worker (Python)
  derive the same value for a published vector.
- **AC-K2.7 Compose.** The new variables pass through `compose.local.yml` and
  `compose.vm.yml` and `vm-release.py`'s env lists, unset by default.
- **AC-K2.8 Rotation is enforced at the gateway** (owner review of #599, F2). With
  `RUNTIME_TRIP_KEY_MASTER` set, the gateway refuses to start when any two of
  `RUNTIME_EXCHANGE_KEY`, `RUNTIME_TRIP_KEY_MASTER` and `RUNTIME_LEGACY_TRIP_KEY`
  (when set) are equal. The error names the variables in the pair, and no value
  appears in it. With the master unset nothing is compared. Tested by starting
  the real gateway as a child process with each equal pair, and with three
  different values.
- **AC-K2.9 Rotation is enforced at the worker.** `provision` refuses to start
  when `CONTROL_PLANE_TRIP_KEY_MASTER` is set and equals
  `CONTROL_PLANE_EXCHANGE_KEY`, whether or not compute is enabled. The error
  names both variables and no value. Different values, or no master, start as
  before.
- **AC-K2.10 The rollout says rotate, in order.** `docs/runtime-session-exchange.md`
  ("Rolling it out") and this spec's Rollout section make rotation a required,
  ordered step (current key to the legacy variable; a new exchange key to the API
  and gateway together; a new master to the gateway and worker), say what the
  legacy key still opens afterwards (only trips not yet re-keyed) and that the
  API-to-gateway and gateway-to-control-plane calls never accept it.
  `docs/control-plane-vm-deployment.md`, `vm.env.example`, `compose.vm.yml` and the
  gateway's `.env.example` describe the key the same way (it is no longer "one key
  shared by every trip site" once per-trip keys are on).

- **AC-K2.11 The control plane never calls a trip site.** The group-line poller
  (`control-plane/api/src/plan-change-poller.ts`) reads a trip's plan through the
  gateway: `GET <runtimeOrigin>/internal/t/<trip id>/plan-changes[?since=]`, with
  `RUNTIME_EXCHANGE_KEY`, `redirect: manual`, and the poller's own timeout and size
  cap. The control-plane key is sent to `runtimeOrigin` and to no trip site; the
  API builds no trip-site URL (it asks `runtimeUpstreamFor` only whether the trip
  has a ready, valid route, and never uses the origin). The gateway route checks its
  caller like the participant routes (401 with no request to any trip), forwards
  only a well-formed `since`, sends the key the route's `tripKey` names (AC-K2.3: a
  `shared` trip with no legacy key is 503 and nothing is sent; with the master unset,
  `RUNTIME_EXCHANGE_KEY`), does not follow a redirect (502), caps the answer at
  512 KiB (502) and passes JSON through. Tested by
  `runtime-gateway/test/plan-changes.test.js` (key per `tripKey`, 401 and 503 with
  zero upstream requests, `since` only, redirect, oversize), `plan-change-poller-db.test.ts`
  (the key goes to `runtimeOrigin` only; a gateway that refuses or is away is a
  logged code), `plan-change-boundary.test.ts` (source shape) and
  `runtime-wildcard-e2e.test.ts` (real API, real gateway, fake site: the site
  receives `derive(master, trip id)` and never `RUNTIME_EXCHANGE_KEY`).
  Operationally the group line now needs the gateway up; a poll then fails
  `SITE_UNREACHABLE` and is retried next minute.

## Non-goals

- Re-keying a live trip. A trip moves from `shared` to `derived` by writing
  its new key into its `.env`, restarting its server and setting its route's
  `trip_key`. That is a deploy, done per trip with approval. Making it a
  rollout step is a follow-up.
- Changing the trip site's own code.
- Generating the new values. Choosing and distributing them is an operator step;
  what the code does is refuse to start without them being different (AC-K2.8,
  K2.9). (Until the owner's review of #599 this item read "Rotating the
  control-plane key, which is an operator step", and the documented rollout made
  rotation optional.)

## Security and boundary notes

- `derive` is HMAC-SHA256 with a fixed, versioned label, so a key for one
  purpose is never valid for the other.
- `both` modes are transitional. A deployment is not hardened until the relay
  is `derived` and no route is `shared`.
- The derivation master must be one no gateway profile has held (AC-K1.7).
  Deriving per-gateway keys from the shared secret would leave every profile
  able to compute every other gateway's key.
- Derived keys and token signatures are kept in separate domains (AC-K1.9).
- `boundary-reviewer` reviews both parts before any merge, with evidence for
  AC-K1.2, K1.4 and K2.3.

## Test plan

Tests first. `control-plane/api/test/relay-protocol.test.ts`,
`relay-connector.test.ts`, `companion-mcp.test.ts`; the install-script tests;
a new test for `relay-rekey.py`; `control-plane/runtime-gateway/test/`; the
worker tests; the migration test. Manual on staging, by Dror: one companion
re-keyed under `both`, then the relay in `derived`; one new test trip built
with a derived key and opened from the portal.

## Rollout

Staging first: K1, in this order, each step required: (1) a NEW derivation
master goes into `relay.gateway_key_master_refs` (it must not be a secret any
gateway profile holds: the services refuse to start if it is; the mode is still
`shared`, so nothing changes); (2) `shared → both`, restart the relay and the
companion control MCP; (3) `scripts/relay-rekey.py --all-enrolled` (plan, then
`--execute`) and restart each gateway it lists; (4) `derived`, restart the relay
and the companion control MCP. What the old shared secret opens: in `shared` and
`both`, a gateway connection; in `derived`, nothing. K2, in
this order, each step required: (1) the migration; (2) the current
`RUNTIME_EXCHANGE_KEY` becomes `RUNTIME_LEGACY_TRIP_KEY` on the gateway, a NEW
`RUNTIME_EXCHANGE_KEY` goes to the API and the gateway together, a NEW master goes
to the gateway and the worker; (3) restart them (a start-up refusal means a step
was skipped); (4) check that a legacy trip still launches, that a new test trip is
built with a derived key and launches, and that the old value is 401 at the control
plane; (5) re-key trips one at a time; (6) when no route is `shared`, unset the
legacy key. The VM after the Alsace trip, in the same order.
