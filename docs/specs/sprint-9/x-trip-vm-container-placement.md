# Trip sites as containers on the control-plane host (`placement: vm-container`)

Status: approved (2026-11-27, by Dror: design decisions 1–7 in the notes folder's
`specs/2026-11-26-trip-hosting-hybrid.md`; implementation detail below drafted by the lead the same day)
· Issue: — · Track: infra · Size: L · Tier: High
Security path: yes (a new forced-command boundary that can run containers; trip secrets on the document store)
· Migration: no · Live-trip behaviour: no (off until the deployment sets `TRIP_PLACEMENT`; existing trips keep their
recorded placement)

## Problem

Every trip site is a privileged Proxmox LXC (`provisioning/adapters.py:319-382`) with a static LAN address from
`PROVISIONER_LXC_IP_POOL` (`compute.py:463-495`), 1 GB of reserved memory and 8 GB of disk, to run one nginx and one
`node server.js` that use about 100 MB. The pool caps the number of trips, each trip is a host on the home network, and
the trip's code, config and `.env` live on the LXC's root filesystem.

Since November 2026 everything that made a per-trip host necessary has a shared replacement: host routing in the
runtime gateway (`TRIP_HOST_SUFFIX`, `TRIP_ROUTING=wildcard`), one shared trip-mcp bridge (`TRIP_MCP_BRIDGE=shared`),
SQLite on the document store (`DATA_DIR=<nfs>/server-data`), and sealed release trees.

## Behaviour

- A trip has a **placement**, `lxc` or `vm-container`, recorded in its `topology.yaml` (`placement:`; absent means
  `lxc`). A trip's recorded placement always wins.
- The worker's `TRIP_PLACEMENT` (set by the operator in the deployment's env file) is the placement of **new** trips
  only. Unset means `lxc`. An unknown value refuses startup.
- `vm-container` requires `TRIP_ROUTING=wildcard` and `TRIP_MCP_BRIDGE=shared`; the worker refuses to start with
  `TRIP_PLACEMENT=vm-container` and any other combination.
- A `vm-container` trip runs as one Docker container on the control-plane host, on a dedicated Docker network, at a
  static IPv4 recorded in its topology. It needs no LAN address, no NPM host, no DNS record and no Proxmox call.
- Its state lives in its own directory on the document store: `server-data/` (SQLite), `trip/` (the config the site
  rewrites, its sidecars), `documents/`, `media/`, and `.env` (mode 0600). The container carries only code.
- The worker never holds the Docker socket. It sends one JSON request per action over SSH to a forced command on the
  host (`scripts/trip-container-host.sh`), under its own key and its own host user (not the companion one).
- Teardown, rollout, autostart, route registration, the bridge check and the end-to-end harness all dispatch on
  placement. A `vm-container` teardown removes the container and keeps the document-store directory, as an LXC teardown
  keeps NFS.

## Decisions taken in this spec (lead, 2026-11-27)

- **Container user:** a fixed non-root uid (`TRIP_CONTAINER_UID`, default 10001). `ensure` chowns the trip's
  directory to it. Measured on the document store on 2026-11-27: root writes, uid 10001 rewrites, root reads it back
  (the export does not squash root).
- **Read-backs** (seed password, exchange-key kind, site-to-bridge) are a `read` verb on the host script that returns
  named fields only, never the whole `.env`. The seven verbs are `ensure`, `deploy`, `start`, `stop`, `remove`,
  `check` and `read`. Autostart is `ensure`'s restart policy, plus `stop` to hold a trip down.
- **Image identity:** `trip-site:<release digest>`, content-addressed from the sealed release tree, built on the host
  by `ensure`/`deploy` when absent. `kinerary-cp-release` never prunes a tag that a trip's current or previous release
  names.
- **Network:** the host script creates the network if it is absent, from `TRIP_CONTAINER_NETWORK` and
  `TRIP_CONTAINER_SUBNET` (deployment env; refused when unset or overlapping a compose network). The runtime gateway
  joins it as an external network. The worker does **not** join it: the worker verifies a site through the `check` verb.
- **Trip-to-trip reachability:** containers on the network can reach one another, as LXCs on the LAN can today. Each
  site already authenticates every non-public route; this is recorded, not engineered around.
- **Boot order:** the entrypoint refuses to start unless the per-trip marker `TRIP.txt` and `.env` are present in the
  mounted directory. A host that boots before the document store mounts, or mounts it late, serves no empty site, and
  `restart: unless-stopped` retries until the mount is there.
- **The daemon is never given a path on the document store** (found in review, 2026-11-27, by the lead on the VM's
  own daemon): `docker inspect` reports a bind source as given, and the daemon re-resolves it on every start, restart
  policy and reboot included. A path the worker can rename or re-point would redirect a restart to anywhere. So the
  host script walks to the trip's directory without following a link (every component `O_NOFOLLOW`, `TRIP.txt`
  naming the request's trip id and slug), and bind-mounts **that open descriptor**
  (`mount --no-canonicalize --bind /proc/self/fd/N`) onto an empty root-owned directory
  `<TRIP_CONTAINER_MOUNT_ROOT>/<trip_id>`; `docker run` is given that path. A bind binds the directory itself, so a
  later rename or swap of the store entry does not move it. `ensure`, `deploy`, `start` and `check` redo the walk and
  refuse, without remounting, when the mount point is already bound to a different directory. The container's mounts
  are read back after every run and every start. `remove` removes the container, unmounts the bind and removes the
  empty mount point; the store directory stays.
- **Boot:** binds do not survive a reboot, and docker's restart policy may start a container before they exist. The
  mount point is then empty, the image's entrypoint refuses (AC-6) and the policy retries.
  `trip-container-host.sh --boot`, run by a root systemd unit ordered after the document store mounts (documented in
  the script's header; the deployment installs it), re-establishes the bind of every trip whose container carries
  our labels, reports the ones that fail and exits non-zero if any did. `--boot` is the one argument the script
  takes: ssh cannot pass it and sudo is refused for it.
- **Host configuration is a root-owned file, not the environment:** `/etc/kinerary/trip-container-host.conf` (owner
  root, not group/other writable, in a directory the same is true of; `KEY=value` lines). The script runs as root
  through `sudo -n` from a forced command, with `env_reset`; it runs docker, mount and umount by absolute path with a
  scrubbed environment and checks that those binaries are root-owned and not writable by others. The container uid is
  never the ssh user's. One mutating request runs at a time (a host-wide flock; `check` counts, because it may
  re-establish the bind) and every request has a deadline; a deadline that fires half-way removes what was just made
  and restores the previous container.
- **The script never builds an image.** `trip-site:<64 hex>` is built by the release tooling (`vm-release`); a
  request naming an image the host lacks is refused.
- **Writes to the document store:** the worker writes `trip/` through `PROVISIONER_TRIP_NFS_LOCAL_BASE`, as it already
  writes `documents/`. `deploy` sends a release reference, never files.

## Acceptance criteria

- AC-1 Given no `placement:` in a topology, when any reader loads it, then it is `lxc`, and every LXC topology the
  worker writes is byte-identical to today's.
- AC-2 Given `TRIP_PLACEMENT=vm-container` with `TRIP_ROUTING` not `wildcard` or `TRIP_MCP_BRIDGE` not `shared`, when
  the worker starts, then it exits non-zero naming the missing setting. An unknown `TRIP_PLACEMENT` likewise.
- AC-3 Given a new trip under `vm-container`, when it is provisioned, then its topology records `placement:
  vm-container`, a `container:` section (name, ipv4, port, nfs dir, image) and no `proxmox:` section, and no `pct`,
  NPM or DNS call is made.
- AC-4 Given the host script, when it receives a request that is not one of the seven verbs, or names a slug or
  trip id that fails validation, or a container whose `kinerary.trip_id` label differs from the request, then it
  refuses, changes nothing and exits non-zero. `docker run` is always issued with no `--privileged`, `--cap-drop ALL`,
  `no-new-privileges`, a memory limit, the fixed uid, `--restart unless-stopped`, the trip network and its `--ip`.
- AC-4b Given any request, when the daemon is asked to run or start a trip container, then its only mount is a
  read-write bind of the trip's root-owned mount point at `/trip-store`, which is bound to the directory the host
  script walked to without following a link; a store entry renamed or replaced afterwards does not change what the
  container sees, and a later `ensure`, `deploy`, `start` or `check` refuses instead of remounting. (Asserted by
  `tests/scripts/test_trip_container_host_root.py`, which runs as root against a real kernel `mount --bind`; the CI
  job `trip-container-host-root` is written to run it. Observed 2026-11-27 by hand, once, in a throwaway privileged
  Alpine container with util-linux 2.42.3 on Docker Desktop's kernel and a fake docker: 12 of 12 passed. Not yet
  observed on the VM's own kernel and util-linux, with NFS as the store, or with the real daemon.)
- AC-5 Given `ensure` for a new trip, then `.env` is created 0600, owned by the container uid, with secrets generated
  on the host or read from stdin, never from argv; given an existing `.env`, it is never rewritten.
- AC-6 Given the trip directory has no `TRIP.txt` or no `.env`, when the container starts, then the entrypoint exits
  non-zero and nothing listens.
- AC-7 Given a `vm-container` trip, when the runtime gateway routes its host, then the site answers through the
  gateway, and the shared bridge admits the site's address (the trip subnet is on its allow-list).
- AC-8 Given a `vm-container` trip, when `teardown-trip.py --execute` runs, then the container is removed, the
  document-store directory is kept, and the bridge route and gateway route are removed as for an LXC trip.
- AC-9 Given a `vm-container` trip, when `trip-rollout.py` rolls it to a release, then the container is recreated on
  that release's image, the previous image is recorded as the way back, and a switch change merges into `trip/` on the
  document store.
- AC-10 Given the VM end-to-end run (`vm-e2e.sh --scenario gatecity --auto --teardown`) with `TRIP_PLACEMENT=vm-container`,
  then all checks pass, including site-to-bridge and the companion reading the trip.
- AC-11 Given the host reboots, with the document store mounting after Docker starts, then every `vm-container` trip
  is serving again with no person acting.
- AC-12 Given a `kinerary-cp-release upgrade` and `rollback` with `vm-container` trips up, then `verify` lists each of
  them and they still serve afterwards.

## Contracts

- `topology.yaml`: top-level `placement:`; a `container:` section that reuses the LXC key names (`name`, `ipv4`,
  `forward_port`, `public_hostname`, `nfs_host_dir`, `nfs_mount_path`) plus `image`, so the line scanners
  (`_ips_already_claimed`, `_trip_nfs_dirname`) keep working.
- Worker env: `TRIP_PLACEMENT`, `TRIP_CONTAINER_SSH_HOST`, `TRIP_CONTAINER_SSH_KEY`,
  `TRIP_CONTAINER_SSH_KNOWN_HOSTS`, `TRIP_CONTAINER_IP_POOL` (addresses inside `TRIP_CONTAINER_SUBNET`).
- Host configuration (the forced command reads it from its root-owned file, never the environment):
  `TRIP_CONTAINER_NETWORK`, `TRIP_CONTAINER_SUBNET`, `TRIP_CONTAINER_UID` (default 10001), `TRIP_CONTAINER_MEMORY`,
  `KINERARY_NFS_ROOT`, `TRIP_CONTAINER_MOUNT_ROOT` (root-owned, 0755 or tighter, refused when its filesystem is NFS; other network
  filesystems are not detected; one empty mount point per trip), and optionally `TRIP_CONTAINER_DOCKER` (one of two fixed paths), `TRIP_CONTAINER_LOCK_FILE`
  (default under `/run`), `TRIP_CONTAINER_TIMEOUT` (default 120 s), and `TRIP_CONTAINER_BRIDGE_URL` (the one shared-bridge
  origin; a request's `hermes_url` and `bridge_url` must equal it, because a site sends its host-generated bridge key
  to whatever its `.env` names). There is no release-tree setting: the script
  never builds.
- Host script request: `{"record_type":"trip_container_request","verb":…,"trip_id":…,"slug":…,…}`; answer:
  one JSON line, `{"ok":true|false,…}`.
- Files expected to change: `provisioning/models.py`, `provisioning/engine.py`, `provisioning/adapters.py` (nginx
  config moves to a shared file), `control-plane/worker/control_plane_worker/{__main__,compute,provisioner,mcp_bridge}.py`,
  `control-plane/deployment/{compose.vm.yml,vm-release.py,trip-site.Dockerfile,trip-site-entrypoint.sh}`,
  `scripts/{trip-container-host.sh,teardown-trip.py,trip-rollout.py,trip-autostart.py,trip-route.py,companion-install-host.sh,e2e-full-cycle.py}`.

## Build order

0. **Wildcard routing on the VM**, on its own: fix the rollout port read for a trip with no `npm` section, set
   `TRIP_ROUTING=wildcard`, and pass the VM e2e on `lxc` + wildcard before any container run.
1. **PR1, model, inert:** placement parsing and writing, `TRIP_PLACEMENT` and the combination refusals;
   `vm-container` is refused as "not available yet". AC-1, AC-2.
2. **PR2, image:** `trip-site.Dockerfile`, entrypoint, shared nginx config, build/prune in `vm-release.py`. AC-6.
3. **PR3, host script** and its forced-command install. AC-4, AC-4b, AC-5. Boundary review with live evidence. The
   boot unit that runs `--boot` is deployment's, not this PR's.
4. **PR4, worker adapters** plus the e2e harness's placement awareness; lifts the PR1 refusal. AC-3, AC-7, AC-10.
5. **PR5, lifecycle dispatch:** teardown, rollout, autostart, route, companion install. AC-8, AC-9, AC-11, AC-12.
6. Then `scripts/trip-migrate-placement.py` (plan/execute, `--live`), its own spec.

## Non-goals

k3s or any orchestrator; a registry or CI-built trip images (later); moving SQLite off the document store; changing
how LXC trips work; migrating an existing trip (step 6).

## Security and boundary notes

- The host user behind the forced command can start containers, which is root-equivalent on the host. Its key is
  used for nothing else, the script accepts only the seven verbs with validated fields, and every `docker` argument is
  built by the script, never taken from the request.
- The document store is untrusted: the worker writes all of it and the export does not squash root. Nothing the
  daemon is given is a path the worker can change (the bind-mount design above); the deployment must also keep the
  store root's top level from being replaceable by the worker (PR4 narrows the worker's mount).
- Secrets never travel on argv or in logs; `read` returns only the fields it names.
- `sanitizeConfig()` and the site's auth are unchanged: the site is the same code in a different box.

## Test plan

Tests first, per PR: `tests/provisioning/test_validation.py`, `test_routing.py`;
`control-plane/worker/tests/{test_routing,test_route_hosts,test_compute,test_main_cli,test_provisioner,test_shared_bridge_site,test_trip_keys}.py`;
`tests/dockerfile-coverage.test.js`; `tests/scripts/test_vm_release.py`; new `tests/scripts/test_trip_container_host.py`
(fake `docker` on PATH); `tests/scripts/{test_teardown_trip,test_trip_rollout,test_trip_autostart,test_companion_install_host_shared}.py`;
`test_shell_scripts_parse.py`. Live: the VM e2e (AC-10), a reboot drill (AC-11), an upgrade/rollback drill (AC-12).

## Rollout and regression

No live trip changes placement in this spec. The default flips when AC-10 to AC-12 pass (Dror, 2026-11-27: "if it
works and makes sense, move", with no waiting window). Regression plan needed for PR3 and PR4 (new boundary; provisioning
behaviour).

## Open questions

None for Dror; the design decisions are recorded in the notes folder.
