# One origin S3: new trips are path-routed; no per-trip DNS, tunnel or proxy records

Status: draft (2026-10-19) · Issue: none yet (`x-`) · Track: T4 · Size: M · Tier: High
Security path: no (provisioning and infrastructure adapters; no auth change) · Migration: no (uses S2's columns) · Live-trip behaviour: yes (new trips only)

> **Unscheduled, to be re-specced (2026-10-30):** the organizer web release (Sprint 7) put a portal and a runtime gateway on their own hosts, which changes this spec's starting point.

Umbrella: `x-one-origin-trips.md`. Depends on S1 and S2.

## Problem

Every provision builds a hostname and three public resources from it.

- **Hostname and container origin.** `compute.py` sets `hostname =
  f"{slug}.{PROVISIONER_LXC_HOSTNAME_DOMAIN}"` and `public_origin` from it
  (`control-plane/worker/control_plane_worker/compute.py:269`, `:283`).
- **Proxy and tunnel specs.** It also builds `ProxySpec` and `CloudflareSpec`
  (`:291-300`).
- **The plan always includes all three.** `Provisioner.plan` puts
  `proxmox_lxc`, `npm_proxy_host` and `cloudflare_tunnel_dns` in every plan
  (`provisioning/engine.py:79-90`).
- **The worker refuses to start without them.** It requires
  `PROVISIONER_LXC_HOSTNAME_DOMAIN`, `PROVISIONER_LXC_TUNNEL_ID`, NPM auth and
  Cloudflare credentials (`control-plane/worker/control_plane_worker/__main__.py:262-290`).
- **The trip URL is read back off the proxy hostname.** `ShellDeployAdapter._private_url`
  parses `npm.hostname` out of `topology.yaml`
  (`control-plane/worker/control_plane_worker/provisioner.py:561-573`).
- **The route registry gets no URL.** The `runtime_routes` row is written with no
  URL (`provisioner.py:1714-1727`).

## Behaviour

- **`TRIP_ROUTING=path`** (worker env; default `host` until Dror flips it). A new
  trip gets:
  - a container and LAN address as today;
  - **no** NPM proxy host, Cloudflare DNS record or tunnel ingress rule;
  - a `.env` with `PUBLIC_BASE_URL=<RUNTIME_ORIGIN>/t/<trip_id>` and
    `TRIP_ID=<trip_id>`;
  - no `TRIP_MCP_ENABLED` (umbrella, non-goal);
  - a `runtime_routes` row with `public_url = <RUNTIME_ORIGIN>/t/<trip_id>/` and
    `upstream_url = http://<lan address>:<forward_port>`.
- **The job result's `private_url` is the public path URL.** Every reader
  (relay intro, outbox notification, companion `canonical_site_url`, the
  verifier) therefore sends and probes the path URL with no change of its own.
  The gateway reads `upstream_url` and never `private_url` for these trips (S2,
  AC-7).
- **`TRIP_ROUTING=host`**: behaviour is unchanged, byte for byte.
- **Teardown** removes any NPM, DNS and tunnel record a topology names, as today,
  and skips each section the topology does not have. It sets the trip's
  `runtime_routes.state` to `'retired'`, so the gateway answers 404 at once.
- **Retargeting and `--keep-container`** (`scripts/teardown-trip.py`) work for both
  kinds of topology.

## Acceptance criteria

- **AC-1. Path-mode plan.** Given `TRIP_ROUTING=path`, `Provisioner.plan` for a new
  trip contains exactly one `create`, for `proxmox_lxc`, and no `npm_proxy_host` or
  `cloudflare_tunnel_dns` change. `topology.yaml` has no `npm:` or `cloudflare:`
  section and records `routing: path`.
- **AC-2. No public-infrastructure calls.** In a path-mode provision test with
  recording fakes, the NPM and Cloudflare transports and the tunnel-host SSH
  transport receive zero calls.
- **AC-3. Worker env.**
  - Given `TRIP_ROUTING=path`, the worker starts with `PROVISIONER_LXC_HOSTNAME_DOMAIN`,
    `PROVISIONER_LXC_TUNNEL_ID`, NPM and Cloudflare variables unset.
  - It refuses to start without `RUNTIME_ORIGIN`, or with one that is not an
    `https://` origin with no path (loopback `http` allowed for tests).
  - Given `TRIP_ROUTING=host`, today's required set is unchanged.
- **AC-4. Container `.env`.** The bootstrap writes `PUBLIC_BASE_URL` and `TRIP_ID`
  matching the trip, and writes no `TRIP_MCP_ENABLED` or `PUBLIC_ORIGIN` line. The
  existing validation pattern (`provisioning/adapters.py:282-302`) is extended to
  accept exactly `https://<host>/t/trip_[A-Za-z0-9]{8,64}`.
- **AC-5. URLs recorded.** On provision success:
  - the job result has `private_url = <RUNTIME_ORIGIN>/t/<trip_id>/`;
  - `runtime_routes` has matching `public_url` and an `upstream_url` built from
    the topology's LAN address and forward port, in the same transaction that
    marks the trip `ready_private` (`provisioner.py:1703-1727`).
- **AC-6. URL derivation does not read the proxy hostname.** `_private_url` reads
  the routing mode from `topology.yaml`. In path mode it returns the path URL from
  `RUNTIME_ORIGIN` and the trip id. In host mode it keeps today's `npm.hostname`
  parse. A topology with neither raises, as today.
- **AC-7. Verification through the gateway.** The worker's runtime-health, roster
  and deployment-identity checks (`verification.py:204-211` and the roster check)
  pass against the path URL in an integration test that uses a fake gateway.
- **AC-8. Teardown of both kinds.**
  - `scripts/teardown-trip.py --trip <path-routed trip>` plans no NPM, DNS or
    tunnel step and retires the route row.
  - On a host-routed topology it plans them exactly as today.
  - Its refusal checks (`:650-687`) are skipped only for sections that are
    absent, never for a present section that disagrees.
- **AC-9. Companion and intro carry the path URL.** For a path-routed trip:
  - the rendered SOUL's "Canonical website" line
    (`profile-templates/familytrip-companion/templates/SOUL.md.tpl:130`) is the
    path URL;
  - so is the organizer intro (`control-plane/api/src/companion-intro.ts`, fed
    by `relay/dispatch.ts:569`);
  - `render_profile.py:48`'s `http(s)` check accepts it unchanged.
- **AC-10. Full cycle.** `scripts/preflight-deploy.sh --deploy --auto --scenario
  multi --cleanup` on Mac staging, with `TRIP_ROUTING=path`, provisions,
  verifies, opens the site at the path URL and tears down with no NPM, DNS or
  tunnel record created at any point. Evidence: the run log, plus the operator's
  read-only listing of NPM hosts and DNS records before and after.

## Contracts

- **Worker env:**
  - `TRIP_ROUTING=host|path`;
  - `RUNTIME_ORIGIN`: the same value as the API's `web.runtime_origin` and the
    gateway's `RUNTIME_ORIGIN`. One value, set in `kinerary-deploy`'s
    `provisioning.env`.
- **`provisioning/models.py`.** `Topology.proxy` and `Topology.cloudflare` become
  `Optional`. A new `routing: Literal['host','path']` field defaults to `host` when
  absent, so every existing `topology.yaml` parses as host. `LxcSpec` gains
  `public_base_url` beside `public_origin`.
- **`provisioning/engine.py`.** `plan`/`apply` skip a `None` spec.
  `_spec_for_change` never sees one.
- **`compute.py`.** In path mode the topology builder does not read
  `hostname_domain` or `tunnel_id`. The `npm.forward_port` concept moves to an
  `lxc.forward_port` that both modes write; host mode keeps writing `npm:` too.
- **Files expected to change:**
  - `provisioning/models.py`, `provisioning/engine.py`, `provisioning/adapters.py`
    (`.env` lines);
  - `control-plane/worker/control_plane_worker/compute.py`, `__main__.py`,
    `provisioner.py`;
  - `scripts/teardown-trip.py`;
  - `tests/provisioning/*`, `control-plane/worker/tests/*`,
    `tests/scripts/test_teardown*`.

## Non-goals

- Changing any already-provisioned trip (S4).
- Removing the host-mode code path. It stays for legacy trips and for any second
  deployment that wants host routing.
- The trip-mcp connector for path-routed trips (umbrella Q5).

## Security and boundary notes

- `upstream_url` is the private address the gateway trusts. It is written only by
  the worker, from the topology it allocated, and accepted by the API only from the
  allow-list (S2, AC-7). It is never shown to a browser: the route response returns
  it only to the exchange-key-authenticated gateway.
- Hard rule 6: no host, domain, IP pool or tunnel id appears in the repo. All of
  them stay in env vars.

## Test plan

Write the tests first:

- `tests/provisioning/test_engine.py`: AC-1, AC-2.
- `tests/provisioning/test_adapters.py`: AC-4.
- `control-plane/worker/tests/test_compute.py`: AC-1 topology shape, AC-3.
- `control-plane/worker/tests/test_provisioner.py`: AC-5, AC-6, AC-7.
- `tests/scripts/test_teardown_trip.py` (or the existing teardown test): AC-8.
- `profile-templates/familytrip-companion/tests/test_template.py` and
  `control-plane/api/test/companion-intro*.test.ts`: AC-9.
- Suites: worker, provisioning, `tests/scripts`, `control-plane/api`,
  `scripts/preflight-deploy.sh`.
- Manual: AC-10 (a deploy, so hard rule 2 applies).

## Rollout and regression

- Default `host`, so merging changes nothing.
- Dror flips `TRIP_ROUTING=path` per environment: Mac staging first, the VM in
  the release that carries S1 and S2.
- A regression plan is required, since provisioning behaviour changes for every
  new trip once flipped.

## Open questions

- Flip the VM default in this sprint's release, or run one sprint with staging
  only?
- Should a path-routed trip also get a human-readable `/t/<slug>` alias (umbrella
  Q2)? If so, the alias table is `runtime_routes` plus the trip's slug, and it
  must stop resolving when the trip is retired.
