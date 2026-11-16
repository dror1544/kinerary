# Trips without per-trip infrastructure: wildcard host routing and one shared trip-mcp bridge

Status: draft (2026-11-16) · Issue: none yet (`x-`) · Track: delivery · Size: L · Tier: High
Security path: yes (the runtime gateway becomes the public entry to trip sites; the bridge holds every trip's agent key) · Migration: yes (R1) · Live-trip behaviour: no (both parts are off until a deployment sets their variables)

Direction approved by Dror in conversation, 2026-11-16: wildcard host instead
of path routing, and one shared bridge instead of one per trip. Built on a side
branch; the merge is a separate decision. The acceptance criteria below have
not been reviewed line by line.

This answers Q1 of `docs/specs/sprint-8/x-one-origin-trips.md` with its
"structural alternative": one wildcard record and a router that reads `Host`.
That spec's S1 (base path, session isolation) and S4 (path migration) are not
needed by this one. Its S2 and S3 contracts are reused where they fit.

## Problem

Provisioning a trip creates four things that exist only for that trip, and
teardown has to undo each of them:

- a Cloudflare DNS record and a tunnel ingress rule, written into the shared
  tunnel's config with a verify-or-rollback step, because a bad edit takes down
  every hostname (`provisioning/adapters.py`, `CloudflareAdapter`);
- an NPM proxy host (`NpmAdapter`);
- a `node mcp.js` process on its own port, `3000 + vmid`
  (`control_plane_worker/mcp_bridge.py`, `scripts/companion-install-host.sh`,
  and the deployment's `setup-mcp.sh`).

What that costs:

- A Cloudflare or NPM API failure fails a trip build or a teardown.
- The per-trip bridge is the source of a recurring class of faults: a bridge
  that did not survive a reboot, a bridge born from an SSH session with no
  macOS Local Network grant (CLAUDE.md, "A Mac-provisioned companion that
  cannot read its own trip"), a profile left with no `mcp_servers` entry, a
  port collision (`mcp_port_for_vmid`'s docstring).
- `scripts/teardown-trip.py` carries a step, and a refusal check, for each.

## Behaviour

Two independent parts. Each is off unless its variables are set, and with them
unset every path behaves as it does today.

**Part R: wildcard host routing.**

- The operator points one wildcard name, `*.<trip domain>`, at the runtime
  gateway, once. That is a deployment step and lives outside this repository.
- A trip keeps its own hostname, `https://<slug>.<trip domain>`. Browser
  isolation, `PUBLIC_ORIGIN`, the member MCP connector and every link already
  sent stay as they are.
- A new trip creates no DNS record, no tunnel rule and no proxy host. The
  worker records the trip's hostname and LAN address in `runtime_routes`, and
  the gateway routes by `Host` from that table.
- Tearing a trip down clears its route. The gateway then answers the hostname
  with the same 404 as a name that never existed.

**Part B: one shared trip-mcp bridge.**

- One `mcp.js` process serves every trip. It is started once by the operator
  and supervised by the platform (LaunchAgent, systemd or compose).
- Each companion profile holds one opaque token. The bridge resolves the token
  to a trip's address and agent key. No tool takes a trip id, and a token
  cannot be pointed at another trip.
- Wiring a trip's companion writes one route file and one profile entry. It
  starts no process and allocates no port. Teardown deletes the route file.

## Acceptance criteria

### R1: route registry and gateway host mode

- **AC-R1.1 Migration.** `YYYYMMDDHHMMSS_runtime_route_hosts.sql` adds nullable
  `public_host text` and `upstream_url text` to `control_plane.runtime_routes`,
  a unique index on `public_host` where it is not null, and a check that
  `public_host` is a lowercase DNS name. Header: `-- rollback: compatible —
  adds two nullable columns; older code ignores them`. A row created before the
  migration behaves exactly as today.
- **AC-R1.2 Lookup by host.** `GET /internal/runtime-routes/by-host/:host`,
  behind the runtime exchange key, returns `{ tripId, routeRef, upstreamOrigin }`
  for a row with `state = 'ready'`, that `public_host`, and an `upstream_url`.
  Anything else is 404 `RUNTIME_NOT_READY` with the same body for "no such
  host", "not ready" and "no upstream".
- **AC-R1.3 Upstream allow-list.** The endpoint answers 503
  `RUNTIME_ROUTE_INVALID` for an upstream that is not `http:`/`https:`, carries
  credentials, a path other than `/`, a query or a fragment, or whose host is
  not in `web.runtime_upstream_allowed_hosts` (exact hostnames, IPs or CIDRs).
  An empty or absent list allows nothing. The existing
  `/internal/runtime-routes/:tripId` endpoint is unchanged.
- **AC-R1.4 Host mode is opt-in.** With `TRIP_HOST_SUFFIX` unset the gateway's
  behaviour is unchanged and its existing tests pass unmodified.
- **AC-R1.5 Which requests are host-mode.** With `TRIP_HOST_SUFFIX=<suffix>`, a
  request whose `Host` (lowercased, port removed) is exactly one label under
  the suffix, and is not `RUNTIME_ORIGIN`'s host, is routed by host. A deeper
  name, the bare suffix, and a name that is not a valid DNS label are 404
  without a lookup. Every other host keeps today's `/t/<trip_id>/` handling.
- **AC-R1.6 Transparent proxy.** A host-mode request reaches the upstream with
  its method, path, query, body, `Cookie`, `Authorization` and `Host`
  unchanged, plus `X-Forwarded-Host`, `X-Forwarded-Proto` and an
  `X-Forwarded-For` that ends with the peer address. A client-sent
  `X-Forwarded-Prefix` is removed. The response's status, headers (including
  `Set-Cookie`) and body are passed through unchanged. A `text/event-stream`
  response streams, and closing the browser side closes the upstream.
- **AC-R1.7 Internal paths refused.** `/api/internal/*` on a trip host is 404
  and never reaches the upstream.
- **AC-R1.8 Unknown hosts are uniform.** A host with no ready route gets one
  small 404 page, identical for every such host, with `cache-control: no-store`.
  A miss is cached for at most 5 seconds and a hit for at most 30.
- **AC-R1.9 Failure is closed.** A control plane that cannot be asked, or an
  upstream that cannot be reached, is 502/503. No request is ever proxied to an
  upstream other than the one the registry returned for that exact host.
- **AC-R1.10 Uploads.** A request body larger than the gateway's JSON limits
  (a photo upload) is streamed through in host mode, not buffered or refused.

### R2: provisioning without per-trip records

- **AC-R2.1 Mode.** Worker env `TRIP_ROUTING=host` (default; today's behaviour,
  unchanged) or `wildcard`. Any other value refuses to start.
- **AC-R2.2 Plan.** In `wildcard` mode `Provisioner.plan` for a new trip
  contains exactly one `create`, for `proxmox_lxc`. `topology.yaml` records
  `routing: wildcard`, has no `npm:` or `cloudflare:` section, and carries the
  forward port under `lxc`.
- **AC-R2.3 No public-infrastructure calls.** In a wildcard provision with
  recording fakes, the NPM, Cloudflare and tunnel-host transports receive zero
  calls.
- **AC-R2.4 Worker env.** In `wildcard` mode the worker starts with the tunnel
  id, NPM and Cloudflare variables unset. It still requires
  `PROVISIONER_LXC_HOSTNAME_DOMAIN`. In `host` mode today's required set is
  unchanged.
- **AC-R2.5 Route recorded.** On provision success, in the transaction that
  marks the trip `ready_private`, the `runtime_routes` row gets `public_host =
  <slug>.<domain>` and `upstream_url = http://<lan address>:<forward port>`, in
  both modes. Re-provisioning rewrites both.
- **AC-R2.6 URL derivation.** `private_url` is derived from the topology's own
  hostname in both modes and no longer requires an `npm:` section. Existing
  topologies give the same value as today.
- **AC-R2.7 Existing topologies still load.** Every `topology.yaml` written
  before this change parses as `routing: host`, plans as today, and is torn
  down as today.
- **AC-R2.8 Teardown.** `scripts/teardown-trip.py`:
  - plans no NPM, DNS or tunnel step for a topology that has no such section,
    and plans them exactly as today for one that does;
  - clears `public_host` and `upstream_url` and sets the route `suspended`,
    inside `retire_in_db`'s transaction and after `REVOKE_GROUP_TOKENS` (the
    lock order in that function's comment is kept);
  - removes the trip's shared-bridge route file when
    `KINERARY_SHARED_BRIDGE_ROUTES_DIR` is set and the file exists (Part B);
  - `--keep-container` clears the route as well, since the public name goes.
- **AC-R2.9 Registering an existing trip.** `scripts/trip-route.py --trip
  <slug|trip_id>` shows the trip's route; `--set` writes `public_host` and
  `upstream_url` from its `topology.yaml`; `--clear` removes them. It prints
  the plan and changes nothing without `--execute`. This is how one test trip
  is moved behind the gateway before any live trip is.

### B1: shared mode in `mcp/mcp.js`

- **AC-B1.1 Opt-in.** With `MCP_ROUTES_DIR` unset, `mcp.js` behaves exactly as
  today and its existing tests pass unmodified. With it set, the process is in
  shared mode, `MCP_API_KEY` is not required, and `API_BASE_URL`,
  `TRIP_PUBLIC_URL` and `TRIP_API_KEY` are ignored.
- **AC-B1.2 Route files.** A route is one file, `<MCP_ROUTES_DIR>/<slug>.json`:

  ```json
  { "schema_version": 1, "trip": "<slug>", "api_base_url": "http://<host>:<port>",
    "public_url": "https://<host>", "trip_api_key": "<key>", "token_sha256": "<64 hex>" }
  ```

  `public_url` is optional. A file is ignored, with one log line that names the
  file and the reason and never its contents, when it is a symlink, is readable
  by group or others, is not valid JSON, has an unknown `schema_version`, a
  `trip` that does not match its file name, an `api_base_url` that is not a
  plain `http(s)` origin, or a `token_sha256` that is not 64 lowercase hex
  characters. Two files with the same `token_sha256` are both ignored.
- **AC-B1.3 The token picks the trip.** A request's `X-API-Key` is hashed and
  compared in constant time. A token that matches a route gets that route's
  trip and no other; an unknown token is 401. Two sessions with different
  tokens, open at the same time, each read their own trip's data (proved with
  two fake trip sites that record the key they were called with).
- **AC-B1.4 No way to name another trip.** No tool, header or query parameter
  selects a trip. A session stays bound to the route it opened with: a
  `POST /messages` for it always runs against that trip.
- **AC-B1.5 Revocation.** Deleting a route file, or replacing its
  `token_sha256`, takes effect within 2 seconds without a restart: a new
  connection with the old token is 401, and an open session of that route is
  closed. Adding a file takes effect within 2 seconds.
- **AC-B1.6 Health.** `GET /health` with a trip's token answers for that trip
  with today's body shapes (`{ok:true}` / 503 with a `code`). Without a valid
  token it is 401. `GET /ready` with no key answers `{ ok: true }` and nothing
  else, so a supervisor can tell the process is up without holding a token.
- **AC-B1.7 One slow trip does not stall the rest.** In shared mode a call to a
  trip site has a default timeout (`MCP_TRIP_TIMEOUT_MS`), and document
  extraction runs at most `MCP_EXTRACT_CONCURRENCY` at a time (default 2), with
  the rest queued.
- **AC-B1.8 Bind address.** In shared mode the default bind is `127.0.0.1`
  (`MCP_BIND_HOST` overrides). Single-trip mode keeps `0.0.0.0`.
- **AC-B1.9 Nothing about a trip leaks into another trip's output or the log.**
  Log lines name a trip by its slug only; never an address, a key or a token.

### B2: wiring a companion to the shared bridge

- **AC-B2.1 Host opt-in.** `scripts/companion-install-host.sh` is in shared
  mode when this host's environment sets both
  `KINERARY_SHARED_BRIDGE_ROUTES_DIR` and `KINERARY_SHARED_BRIDGE_URL`. Neither
  comes from the request. With either unset, every request kind behaves as
  today.
- **AC-B2.2 Wiring.** In shared mode a `trip_mcp_bridge_request`:
  - reads the site's LAN address and port from the trip's `topology.yaml`
    (`lxc.forward_port`, falling back to `npm.forward_port`), with the same
    ASCII validation as today; it derives no bridge port and calls no
    `setup-mcp.sh`;
  - gets the trip's agent key from `$DEPLOY_ROOT/trip-agent-key.sh <slug>`
    (a deployment hook; stdout is the key, validated as one line of
    `[A-Za-z0-9._~+/=-]{16,256}`), or, when that hook is absent, from the
    `TRIP_API_KEY` then `MCP_API_KEY` line of an existing
    `trips/<slug>/mcp/.env`. With neither it fails and says which is missing;
  - keeps the profile's token if its `.env` already has `TRIP_MCP_TOKEN`,
    otherwise generates 32 random bytes, hex;
  - writes the route file atomically, mode 0600, and the profile's
    `mcp_servers.trip-mcp` entry (`transport: sse`, `url:
    <KINERARY_SHARED_BRIDGE_URL>/sse`, header `X-API-Key: ${TRIP_MCP_TOKEN}`);
  - restarts the gateway, waits for it to register trip-mcp's tools, then asks
    the shared bridge's `/health` with the trip's token and fails the step when
    it cannot reach the trip, exactly as today;
  - prints `WIRED <profile> <commit>` and writes the provenance record under
    the same conditions as today.
  No key or token is ever printed, logged or placed on a command line.
- **AC-B2.3 Idempotent.** Running the request twice leaves one route file, one
  profile entry and the same token.
- **AC-B2.4 Probe.** In shared mode `trip_mcp_bridge_probe` asks the shared
  bridge's `/health` with the trip's token and prints exactly `HEALTH ok` or
  `HEALTH fail <code>`. A missing route file is `HEALTH fail NO_ROUTE`; a
  missing token is `HEALTH fail NO_KEY`. It stays read-only.
- **AC-B2.5 Gateway start.** In shared mode `revive_bridge_before_start` starts
  and restarts nothing. A shared bridge that does not answer `/ready` is a
  `failed` start with a reason that says the shared bridge is down.
- **AC-B2.6 The worker is unchanged.** The worker sends the same request kinds
  with the same fields. `mcp_port_for_vmid` is no longer a precondition for a
  host in shared mode; where the worker itself refuses a trip for having no
  bridge port, that refusal is lifted only when the worker is told the host is
  shared (`TRIP_MCP_BRIDGE=shared`, default `per_trip`).

## Contracts

- **Migration**: `control-plane/db/migrations/<stamp>_runtime_route_hosts.sql`.
- **API config**: `web.runtime_upstream_allowed_hosts: string[]`.
- **Gateway env**: `TRIP_HOST_SUFFIX` (new). Existing variables unchanged.
- **Worker env**: `TRIP_ROUTING=host|wildcard`, `TRIP_MCP_BRIDGE=per_trip|shared`.
- **Bridge env**: `MCP_ROUTES_DIR`, `MCP_BIND_HOST`, `MCP_TRIP_TIMEOUT_MS`,
  `MCP_EXTRACT_CONCURRENCY`.
- **Host env**: `KINERARY_SHARED_BRIDGE_ROUTES_DIR`, `KINERARY_SHARED_BRIDGE_URL`.
- **`provisioning/models.py`**: `Topology.proxy` and `Topology.cloudflare`
  become optional; `routing` defaults to `host` when absent; `LxcSpec` gains
  `forward_port`.
- **Operator steps, outside this repo** (each an approved infrastructure
  change): the wildcard DNS record and tunnel rule pointing at the gateway,
  with streaming on and a body limit matching the trip nginx's; the gateway and
  the shared bridge under a supervisor; `trip-agent-key.sh`; the variables
  above.

Files expected to change:

| Slice | Paths |
|---|---|
| R1 | `control-plane/runtime-gateway/**`, `control-plane/api/src/portal.ts`, `config.ts`, `server.ts`, `control-plane/api/test/**` for those, `control-plane/db/migrations/<new>.sql`, `docs/runtime-session-exchange.md` |
| R2 | `provisioning/**`, `tests/provisioning/**`, `control-plane/worker/control_plane_worker/{compute,__main__,provisioner,mcp_bridge}.py`, `control-plane/worker/tests/**`, `scripts/teardown-trip.py`, `scripts/trip-route.py`, `tests/scripts/**` |
| B1 | `mcp/**`, `tests/mcp-*.test.js`, `tests/package.json` |
| B2 | `scripts/companion-install-host.sh` and its tests |

## Non-goals

- Moving any live trip. A live trip is moved by an operator with
  `trip-route.py`, one at a time, each an approved step (hard rule 2), and only
  after the wildcard record exists. Its old DNS record, tunnel rule and proxy
  host are removed by a later, separate step.
- Removing the per-trip code paths. `TRIP_ROUTING=host` and the per-trip bridge
  stay for existing trips and for a deployment that wants them.
- Path routing, a single origin for Telegram Login, or one Google JavaScript
  origin. A wildcard host does not give those; each new trip's origin still has
  to be registered with the Google OAuth client by hand, as today.
- Storing trip agent keys in the control-plane database.
- A second instance of the gateway or the bridge for availability.

## Security and boundary notes

- **The gateway is the public entry to every wildcard-routed trip.** Three
  invariants, each with a test: a host resolves only to the upstream the
  registry holds for that exact name; `upstream_url` is accepted only from the
  allow-list and is never returned to a browser; `/api/internal/*` is never
  reachable from outside.
- **Host mode adds no credential and removes none.** Each trip is its own
  origin, so cookies and tokens pass through untouched; the gateway's session
  cookie and launch flow are not involved.
- **The shared bridge holds every trip's agent key**, where each per-trip
  bridge held one. Mitigations: route files are 0600 and refused otherwise;
  the bridge stores only the hash of each token; it binds loopback by default;
  it is never the process that serves `provision.js` (hard rule 5).
- **A wildcard record sends unknown names to us.** The 404 is uniform so the
  gateway is not an oracle for which slugs exist.
- **One process is one point of failure**, for the sites and for the
  companions. Both need a supervisor and a health check; that is an operator
  step, and the fleet monitor should watch `/health` and `/ready`.
- `boundary-reviewer` reviews R1 and B1 before any merge, with live
  request/response evidence for AC-R1.2, R1.3, R1.6, R1.7, R1.8 and AC-B1.3,
  B1.4, B1.5.

## Test plan

Tests are written first.

- `control-plane/runtime-gateway/test/gateway.test.js`: AC-R1.4 to R1.10, with
  a fake control plane and a fake upstream that records what it received.
- `control-plane/api/test/`: AC-R1.2, R1.3, and the migration list.
- `tests/provisioning/`, `control-plane/worker/tests/`: AC-R2.1 to R2.7.
- `tests/scripts/test_teardown_trip.py` and a new test for `trip-route.py`:
  AC-R2.8, R2.9.
- `tests/mcp-shared-bridge.test.js` (new): AC-B1.1 to B1.9, with two fake trip
  sites.
- A test for `companion-install-host.sh` in shared mode, in the style of the
  existing tests for that script: AC-B2.1 to B2.5.
- Manual, on staging, by Dror: one test trip behind the gateway by wildcard
  name (sign-in, Modern and Classic, live updates, a photo upload, a
  confirmation download, the member MCP connector), and one companion reading
  its trip through the shared bridge.

## Rollout and regression

- Merging changes nothing: every part is off by default.
- Order on a deployment: the migration; the gateway with `TRIP_HOST_SUFFIX`
  and one test trip registered by `trip-route.py`; then `TRIP_ROUTING=wildcard`
  for new trips. Separately: the shared bridge with one test trip's companion;
  then the host variables for new trips.
- A regression plan is required before any merge to `main` (a migration, a new
  public boundary, provisioning behaviour).

## Open questions

- Should the wildcard suffix be the trips' existing domain, so today's
  hostnames keep working once their per-trip records are removed, or a new
  one? The code does not care; the certificate does (one label deep only).
- Should the route endpoint be mounted without the portal's configuration, as
  `x-one-origin-s2` AC-8 proposed? Not done here.
