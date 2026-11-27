"""ComputeAdapter: creates a fresh LXC (+ NPM proxy host + Cloudflare tunnel
DNS) for a brand-new trip, reusing the existing provisioning/ package
(control-plane/worker's Docker image copies it in alongside
control_plane_worker — see the Dockerfile) rather than a second
implementation living in this package.

Building from an ostemplate rather than cloning CT202 was accepted as the
simpler, more robust choice — the user's own words: cloning was only ever a
suggestion for speed, "if not needed ... I am fine with [ostemplate]" — so
this adapter doesn't attempt to clone anything.

create_container() is a REAL infrastructure-creating action once actually
wired up with real credentials — it writes a real Proxmox LXC, a real NPM
proxy host, and a real Cloudflare tunnel/DNS record. NullComputeAdapter is
the safe default; nothing in this codebase constructs LxcProvisionAdapter
without deliberate configuration (see __main__.py's --enable-compute flag).

IP pool and Cloudflare tunnel model are confirmed (2026-08-25, see project
memory `phase_g_infra_decisions`/`cloudflare_tunnel_local_config_finding`):
one shared, locally-managed tunnel on the RPi4 serves every trip subdomain
plus several unrelated home-lab hosts — confirmed by reading the live
/etc/cloudflared/config.yml and cross-checking two independent Hermes
smart-home-expert reference docs written during the real Shiran deployment.
Every trip's Cloudflare ingress rule points at NPM's local listener
(http://127.0.0.1:8080 on the RPi4 itself), never at the trip's own LXC —
NPM is what does the per-Host-header routing to the actual container.

That is `routing: host`, the default. With TRIP_ROUTING=wildcard a NEW trip gets
only its container: the operator's wildcard record sends every trip hostname to
the runtime gateway, which routes by Host from control_plane.runtime_routes (the
worker records the hostname and LAN address there - provisioner.py), so there
is no proxy host, no DNS record and no tunnel rule to create, authenticate or
undo. A trip that already has a topology.yaml keeps whatever it says.
"""
from __future__ import annotations

import hmac
import ipaddress
import os
from pathlib import Path
from typing import Any, Callable, Protocol, Sequence

import yaml

from provisioning.adapters import (
    CloudflareTunnelDnsAdapter,
    NpmProxyHostAdapter,
    ProxmoxLxcAdapter,
    SubprocessSshTransport,
)
from provisioning.engine import Provisioner
from provisioning.models import (
    CloudflareSpec, LxcSpec, PLACEMENT_LXC, PLACEMENT_VM_CONTAINER, ProxySpec, ROUTING_HOST, ROUTING_WILDCARD, ROUTINGS, Topology,
    load_topology,
)
from provisioning.runtime import HttpJsonTransport


#: Label of a trip's own exchange key (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, K2). Versioned and
#: fixed, so a key made for this purpose is never valid for another.
TRIP_KEY_LABEL = "kinerary-trip-exchange:v1:"

#: What `runtime_routes.trip_key` can say about the key a trip's site holds.
TRIP_KEY_KINDS = ("shared", "derived")


def derive_trip_key(master: str, trip_id: str) -> str:
    """hex(HMAC-SHA256(master, "kinerary-trip-exchange:v1:" + trip_id)). The runtime gateway
    computes the same value (runtime-gateway/server.js deriveTripKey); both tests read
    runtime-gateway/test/fixtures/trip-key-vectors.json."""
    if not master or not trip_id:
        raise ValueError("a trip key needs both the trip key master and the trip id")
    return hmac.new(master.encode("utf-8"), (TRIP_KEY_LABEL + trip_id).encode("utf-8"), "sha256").hexdigest()


class ComputeAdapter(Protocol):
    """Creates (or reuses an already-created) compute instance for a trip.
    Returns its vmid as a string."""

    def create_container(
        self, slug: str, *, first_provision: bool = False, trip_id: str | None = None,
    ) -> str: ...

    def site_login_password(self, slug: str) -> str | None:
        """The login password the trip's site was built with, as that site's
        own .env holds it; None when there is none to report."""
        ...

    def site_trip_key(self, slug: str) -> str | None:
        """Which kind of exchange key the trip's site holds - "shared" or
        "derived" - as its own .env says; None when this adapter cannot say."""
        ...

    def verify_site_bridge(self, slug: str) -> "tuple[bool, str] | None":
        """From INSIDE the trip's container, ask the shared bridge whether it
        answers this trip's own site key: (ok, evidence), or None when this
        deployment has no shared bridge for the adapter to check."""
        ...


class NullComputeAdapter:
    """No compute adapter configured — ShellDeployAdapter falls back to this
    when a slug has no static vmid_map entry and Phase G's automatic
    creation hasn't been turned on. Matches the pre-Phase-G behavior: a
    clear error rather than a silent no-op."""

    def create_container(
        self, slug: str, *, first_provision: bool = False, trip_id: str | None = None,
    ) -> str:
        raise ValueError(
            f"no vmid configured for slug {slug!r}, and automatic container "
            "creation (--enable-compute) is not turned on"
        )

    def site_login_password(self, slug: str) -> str | None:
        return None

    def site_trip_key(self, slug: str) -> str | None:
        return None

    def verify_site_bridge(self, slug: str) -> "tuple[bool, str] | None":
        return None


class LxcProvisionAdapter:
    """Builds a topology for `slug`, applies it for real via
    provisioning.engine.Provisioner, and returns the vmid Proxmox assigned.

    Idempotent across retries: the chosen topology (in particular, which
    pool IP got allocated) is written to <deploy_root>/trips/<slug>/
    topology.yaml BEFORE apply() runs, and reused as-is on a later call for
    the same slug — the same "commit the choice before the side effect"
    shape provisioner.py's own slug promotion uses, so a retried job after a
    partial failure (e.g. LXC created, NPM proxy host creation then failed)
    reapplies the SAME topology rather than allocating a second IP or a
    second container. Provisioner.apply() is itself idempotent per-resource
    (inspect-before-create), so reapplying a topology whose LXC already
    exists just fills in whatever didn't finish yet.
    """

    def __init__(
        self,
        deploy_root: str,
        node: str,
        template: str,
        storage: str,
        bridge: str,
        ip_pool: Sequence[str],
        hostname_domain: str,
        tunnel_id: str,
        npm_url: str,
        npm_api_token: str,
        cloudflare_zone_id: str,
        cloudflare_api_token: str,
        proxmox_host: str = "192.168.0.40",
        proxmox_ssh_user: str = "root",
        proxmox_ssh_key: str = "~/.ssh/id_ed25519_proxmox_hermes",
        rpi_host: str = "192.168.0.41",
        rpi_ssh_user: str = "dror",
        rpi_ssh_key: str = "~/.ssh/id_ed25519_rpi4_hermes",
        cloudflare_ingress_service: str = "http://127.0.0.1:8080",
        gateway: str = "192.168.0.1",
        nameserver: str = "192.168.0.41",
        nfs_host_base: str = "/mnt/pve/truenas-nfs",
        nfs_mount_base: str = "/nfs",
        cores: int = 2,
        memory_mb: int = 1024,
        disk_gb: int = 8,
        forward_port: int = 8080,
        control_plane_exchange_key: str = "",
        trip_key_master: str = "",
        npm_identity: str = "",
        npm_secret: str = "",
        provisioner_factory: Callable[[], Provisioner] | None = None,
        routing: str = ROUTING_HOST,
        shared_bridge_site_url: str = "",
    ) -> None:
        # TRIP_ROUTING. `host`: every NEW trip gets an NPM proxy host, a
        # Cloudflare DNS record and a tunnel ingress rule (all the parameters
        # below are then required by the worker's startup, as before).
        # `wildcard`: a new trip gets its container and nothing public - the
        # operator's wildcard record sends <slug>.<hostname_domain> to the
        # runtime gateway, which routes by Host from runtime_routes - so
        # tunnel_id, NPM and Cloudflare may be empty. An existing trip keeps
        # whatever its own topology.yaml says. This constructor takes empty
        # strings either way, as teardown-trip.py's does; __main__ is what
        # refuses to start without a variable its mode needs.
        if routing not in ROUTINGS:
            raise ValueError(f"routing must be one of {', '.join(ROUTINGS)}")
        self._routing = routing
        self._deploy_root = deploy_root
        self._node = node
        self._template = template
        self._storage = storage
        self._bridge = bridge
        self._ip_pool = list(ip_pool)
        for candidate in self._ip_pool:
            ipaddress.ip_address(candidate)  # fail fast on a malformed pool entry
        self._hostname_domain = hostname_domain
        self._tunnel_id = tunnel_id
        self._npm_url = npm_url
        self._npm_api_token = npm_api_token
        self._npm_identity = npm_identity
        self._npm_secret = npm_secret
        self._cloudflare_zone_id = cloudflare_zone_id
        self._cloudflare_api_token = cloudflare_api_token
        self._proxmox_host = proxmox_host
        self._proxmox_ssh_user = proxmox_ssh_user
        self._proxmox_ssh_key = os.path.expanduser(proxmox_ssh_key)
        self._rpi_host = rpi_host
        self._rpi_ssh_user = rpi_ssh_user
        self._rpi_ssh_key = os.path.expanduser(rpi_ssh_key)
        self._cloudflare_ingress_service = cloudflare_ingress_service
        self._gateway = gateway
        self._nameserver = nameserver
        self._nfs_host_base = nfs_host_base
        self._nfs_mount_base = nfs_mount_base
        self._cores = cores
        self._memory_mb = memory_mb
        self._disk_gb = disk_gb
        self._forward_port = forward_port
        # slug -> the password the trip's container reports in its own .env,
        # read back by create_container after apply(). Held in this process
        # only (never written to topology.yaml or any file) and handed to the
        # worker once, to tell the organizer. There is no deployment-wide
        # password: each site generates its own at bootstrap.
        self._site_passwords: dict[str, str | None] = {}
        self._control_plane_exchange_key = control_plane_exchange_key
        # CONTROL_PLANE_TRIP_KEY_MASTER. Set: a NEW trip's site is born with
        # derive(master, trip_id) instead of the shared key above, and its route
        # says so. Unset (the default): every behaviour is what it was. The master
        # is never written to a site, a topology, a log or a command line.
        if "\n" in trip_key_master or "\r" in trip_key_master:
            raise ValueError("trip key master must be one line")
        self._trip_key_master = trip_key_master
        # TRIP_MCP_SHARED_SITE_URL, set only with TRIP_MCP_BRIDGE=shared: the shared bridge as a trip
        # CONTAINER reaches it. A new trip's .env is written with HERMES_URL=<this> (the site calls
        # `${HERMES_URL}/extract` and `/enrich`), and verify_site_bridge asks, from inside the container,
        # whether the bridge answers there. Unset (the default): nothing is written and nothing is checked.
        self._shared_bridge_site_url = shared_bridge_site_url
        # slug -> the kind of key the trip's site holds ("shared" / "derived"),
        # read back from the container after apply(); None when not asked or
        # unknowable. Held in this process only, like the site password.
        self._site_key_kinds: dict[str, str | None] = {}
        # Set per-call by create_container (the worker is single-threaded — one
        # job at a time via run_once), read by _build_provisioner when it
        # constructs the ProxmoxLxcAdapter.
        self._reset_data = False
        # Overridable so tests can inject a Provisioner built from fake
        # transports (matching tests/provisioning/test_adapters.py's own
        # FakeTransport) instead of the real HttpJsonTransport this
        # constructs by default — mirrors provisioning/__main__.py's own
        # build_provisioner(), which is likewise credential-driven and
        # exercised only via the adapter/engine layer's own fake-transport
        # tests, not directly.
        self._provisioner_factory = provisioner_factory

    def create_container(
        self, slug: str, *, first_provision: bool = False, trip_id: str | None = None,
    ) -> str:
        # The key a NEW site's .env is born with, and the keys this trip's site
        # may already hold (a re-provision finds its .env and leaves it alone,
        # so what it holds was fixed when it was first made). First, so a
        # missing trip id fails before anything is written.
        exchange_key, key_candidates = self._exchange_keys_for(trip_id)
        self._site_key_kinds.pop(slug, None)
        topology_path = self._topology_path(slug)
        topology = self._load_topology(topology_path)
        if topology is None:
            topology = self._build_topology(slug, trip_id)
            self._write_topology(topology_path, topology, slug)
        if topology.placement != PLACEMENT_LXC:
            # A recorded placement always wins, and this adapter only knows LXCs. Refuse before a
            # transport is built or an adapter is asked anything, so nothing can act on half a trip.
            raise RuntimeError(
                f"{slug}'s topology.yaml records placement {topology.placement}, which this worker "
                "cannot build or re-provision yet"
            )

        # Consumed by _build_provisioner below. On a first provision the
        # trip's NFS data dir must start clean — a container teardown leaves
        # it intact, so a failed earlier attempt can leave a stale SQLite
        # users table that server.js won't re-seed over.
        self._reset_data = first_provision
        # An injected factory (tests) builds the whole provisioner itself. The
        # real one is told the topology, so a trip with no proxy host or DNS
        # record never gets, or authenticates, a transport to NPM or Cloudflare.
        provisioner = (
            self._provisioner_factory() if self._provisioner_factory is not None
            else self._build_provisioner(topology, exchange_key=exchange_key)
        )

        # ProxmoxLxcAdapter.create() runs that wipe, but only when it runs —
        # i.e. when the LXC is absent. A first attempt that created the
        # container and then failed downstream (bootstrap, NPM, deploy) leaves
        # the LXC in place, so this apply() plans no create() and the stale
        # data dir would survive a "first" provision. Wipe it here in that case.
        if first_provision and provisioner.proxmox.inspect(topology.lxc) is not None:
            provisioner.proxmox.reset_trip_data(topology.lxc)

        provisioner.apply(topology, execute=True)

        record = provisioner.proxmox.inspect(topology.lxc)
        if record is None or "vmid" not in record:
            raise RuntimeError(
                f"Proxmox reports no container named {topology.lxc.name!r} on "
                f"{self._node} after apply — cannot determine its vmid"
            )
        vmid = str(record["vmid"])
        # What the site accepts, read from the container itself - on a first
        # provision the one it just generated, on a re-provision the one it
        # already had (bootstrap never rewrites an existing .env). An ssh
        # failure here raises on purpose: the job retries, rather than the
        # organizer being introduced to a site with no password to type.
        self._site_passwords[slug] = provisioner.proxmox.site_password(topology.lxc)
        # Which key the site really holds, asked of the container itself: the
        # route the gateway reads must name the key the site accepts, and a
        # re-provision (which never rewrites an existing .env) must not record
        # the key this worker WOULD have written. Asked only when per-trip keys
        # are on; off, nothing extra is read and the route is left as it is.
        self._site_key_kinds[slug] = (
            self._key_kind_of(provisioner.proxmox.exchange_key_kind(topology.lxc, key_candidates))
            if key_candidates else None
        )
        # Only known after apply(), so this rewrites the file _write_topology
        # already wrote pre-apply — same fields, plus vmid. mcp_bridge.py
        # reads it back for slugs that (unlike the two legacy trips) have no
        # entry in the operator-supplied --vmid-map.
        self._write_topology(topology_path, topology, slug, vmid=vmid)
        return vmid

    def site_login_password(self, slug: str) -> str | None:
        return self._site_passwords.get(slug)

    def site_trip_key(self, slug: str) -> str | None:
        return self._site_key_kinds.get(slug)

    def verify_site_bridge(self, slug: str) -> "tuple[bool, str] | None":
        """The trip site -> shared bridge direction, proved from inside the trip's container (the
        companion's own connection covers the other direction). None with no shared bridge configured,
        or for a trip this adapter has no topology for. An ssh failure raises, like site_password:
        "could not look" is not "looked and it is down".

        Needs the trip's bridge route to exist, so the worker calls it AFTER the companion step has
        wired the trip, never before."""
        if not self._shared_bridge_site_url:
            return None
        topology = self._load_topology(self._topology_path(slug))
        if topology is None:
            return None
        if self._provisioner_factory is not None:
            proxmox = self._provisioner_factory().proxmox
        else:
            proxmox = ProxmoxLxcAdapter(SubprocessSshTransport(
                host=self._proxmox_host, user=self._proxmox_ssh_user, identity_file=self._proxmox_ssh_key,
            ))
        return proxmox.check_site_to_bridge(topology.lxc, self._shared_bridge_site_url)

    @staticmethod
    def _key_kind_of(answer: object) -> str | None:
        # Anything but a kind the schema accepts is "could not say", never a value to write.
        return answer if isinstance(answer, str) and answer in TRIP_KEY_KINDS else None

    def _exchange_keys_for(self, trip_id: str | None) -> tuple[str, dict[str, str]]:
        """(the key a new site for this trip is born with, {kind: key} to ask the
        container which it holds). With no trip key master: today's shared key and
        no candidates - nothing is derived and nothing extra is read."""
        if not self._trip_key_master:
            return self._control_plane_exchange_key, {}
        if not trip_id:
            # Never fall back to the shared key: a site built with it while the
            # deployment believes per-trip keys are on is the silent downgrade.
            raise RuntimeError(
                "CONTROL_PLANE_TRIP_KEY_MASTER is set but no trip id was given: "
                "cannot derive this trip's exchange key"
            )
        derived = derive_trip_key(self._trip_key_master, trip_id)
        candidates = {"derived": derived}
        if self._control_plane_exchange_key:
            candidates["shared"] = self._control_plane_exchange_key
        return derived, candidates

    # ── topology construction ────────────────────────────────────────────

    def _topology_path(self, slug: str) -> Path:
        return Path(self._deploy_root) / "trips" / slug / "topology.yaml"

    def _load_topology(self, path: Path) -> Topology | None:
        if not path.exists():
            return None
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        return load_topology(raw)

    def _build_topology(self, slug: str, trip_id: str | None = None) -> Topology:
        """The trip's topology, built ONCE — afterwards the file is the truth.

        Both NFS paths — the host directory AND the container's mount point —
        are named by TRIP ID, not by slug. A slug comes from the organizer's
        answers and is deliberately reusable: teardown frees it
        (`retired-<slug>-<date>`), so the next family to name their trip the
        same way would otherwise land on the previous family's directory. That
        is only survivable today because teardown remembers to rename the
        directory and a first provision wipes it — two safeguards guarding a
        name collision that need not exist. Nothing about `pct config` reading
        an id instead of a slug is worse; `TRIP.txt` in the directory and the
        LXC's own hostname (`trip-<slug>`) are where a person still finds the
        human name.

        The slug survives in exactly one place: `LxcSpec.trip_slug`, which
        names the container's OWN filesystem path (TRIP_DIR) — not NFS, so
        not one of the paths above, and the one spot a person actually reads
        it. It is always this topology's own top-level `name`, never a second
        value that could drift from it.

        Existing trips are untouched: `create_container` only reaches here when
        the trip has no topology file yet, so every already-provisioned trip
        keeps whatever directory its topology records — a later upgrade or
        redeploy reads that file, never this function.
        """
        ipv4 = self._allocate_ip(slug)
        name = self._lxc_name(slug)
        hostname = f"{slug}.{self._hostname_domain}"
        wildcard = self._routing == ROUTING_WILDCARD
        return Topology(
            version=1,
            name=slug,
            routing=self._routing,
            lxc=LxcSpec(
                name=name, node=self._node, template=self._template, storage=self._storage,
                cores=self._cores, memory_mb=self._memory_mb, disk_gb=self._disk_gb,
                bridge=self._bridge, ipv4=f"{ipv4}/24",
                gateway=self._gateway, nameserver=self._nameserver,
                nfs_host_dir=f"{self._nfs_host_base}/{trip_id or slug}",
                nfs_mount_path=f"{self._nfs_mount_base}/{trip_id or slug}",
                trip_slug=slug,
                # The same host NPM and the tunnel serve the trip on, so the
                # member MCP connector's OAuth issuer is a name assistants reach.
                public_origin=f"https://{hostname}",
                forward_port=self._forward_port,
            ),
            # forward_host is the container's IP, deliberately not its LXC name.
            # No trip-* hostname resolves on this LAN — the containers hold
            # static addresses outside DHCP, so nothing registers them in DNS,
            # and NPM (on the RPi4) answers 502 for an unresolvable upstream.
            # Every working proxy host is IP-based; the name form was inherited
            # from topology.yaml files that were never actually applied.
            #
            # Wildcard routing has neither a proxy host nor a DNS record and
            # tunnel rule, so there is nothing for the engine to plan or for
            # teardown to undo. The gateway's upstream is the same address and
            # port, recorded on the trip's runtime_routes row instead.
            proxy=None if wildcard else ProxySpec(
                hostname=hostname, forward_host=ipv4, forward_port=self._forward_port),
            cloudflare=None if wildcard else CloudflareSpec(
                tunnel_id=self._tunnel_id, hostname=hostname,
                # NOT the trip's own LXC address — every trip's ingress rule
                # points at NPM's local listener on the RPi4 itself. NPM is
                # what does the per-Host-header routing to the actual LXC
                # (confirmed against the live /etc/cloudflared/config.yml,
                # where both existing trip subdomains route here).
                service=self._cloudflare_ingress_service,
            ),
        )

    @staticmethod
    def _lxc_name(slug: str) -> str:
        # Proxmox hostnames top out at 63 chars; defensive even though a
        # kebab-case slug with a trip- prefix is short in practice.
        return f"trip-{slug}"[:63]

    def _allocate_ip(self, slug: str) -> str:
        used = self._ips_already_claimed(exclude_slug=slug)
        for candidate in self._ip_pool:
            if candidate not in used:
                return candidate
        raise RuntimeError(
            f"no free IP in the configured pool ({len(self._ip_pool)} candidates, "
            f"{len(used)} already claimed) — add more to PROVISIONER_LXC_IP_POOL"
        )

    def _ips_already_claimed(self, exclude_slug: str) -> set[str]:
        """Scans every OTHER trip's topology.yaml under deploy_root for its
        already-chosen proxmox.lxc.ipv4 — a local, file-based check rather
        than a live Proxmox scan, since the LXC list endpoint doesn't return
        configured IPs without a second per-container config read. This only
        protects against colliding with an IP this same tooling already
        assigned; the pool itself must only ever contain addresses the
        operator has independently confirmed are safe on the real LAN."""
        trips_dir = Path(self._deploy_root) / "trips"
        claimed: set[str] = set()
        if not trips_dir.is_dir():
            return claimed
        for entry in trips_dir.iterdir():
            if entry.name == exclude_slug or not entry.is_dir():
                continue
            topology_file = entry / "topology.yaml"
            if not topology_file.exists():
                continue
            for line in topology_file.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped.startswith("ipv4:"):
                    claimed.add(stripped.split(":", 1)[1].strip().split("/")[0])
        return claimed

    def _write_topology(self, path: Path, topology: Topology, slug: str, vmid: str | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if topology.placement == PLACEMENT_VM_CONTAINER:
            payload = self._vm_container_payload(topology)
        else:
            payload = self._lxc_payload(topology, vmid)
        header = (
            f"# Auto-generated by control_plane_worker.compute.LxcProvisionAdapter for {slug}.\n"
            "# Written BEFORE apply() runs so a retried job reuses the same IP/hostname\n"
            "# instead of allocating a second one.\n"
        )
        path.write_text(header + yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")

    @staticmethod
    def _vm_container_payload(topology: Topology) -> dict[str, Any]:
        """`placement: vm-container`: a `container:` section reusing the LXC key names (the line
        scanners `_ips_already_claimed` and `_trip_nfs_dirname` read `ipv4:` and `nfs_host_dir:` out of
        any topology.yaml) and no proxmox, npm or cloudflare section."""
        container = topology.container
        return {
            "version": 1,
            "name": topology.name,
            "placement": topology.placement,
            "routing": topology.routing,
            "container": {
                "name": container.name, "ipv4": container.ipv4, "forward_port": container.forward_port,
                "public_hostname": container.public_hostname, "nfs_host_dir": container.nfs_host_dir,
                "nfs_mount_path": container.nfs_mount_path, "image": container.image,
            },
        }

    @staticmethod
    def _lxc_payload(topology: Topology, vmid: str | None) -> dict[str, Any]:
        return {
            "version": 1,
            "name": topology.name,
            # Written only when it is not the default: a host topology stays
            # byte-for-byte what it was (plus lxc.forward_port), and a file with
            # no `routing` line reads as `host`.
            **({"routing": topology.routing} if topology.routing != ROUTING_HOST else {}),
            "proxmox": {
                "node": topology.lxc.node,
                **({"vmid": vmid} if vmid else {}),
                "lxc": {
                    "name": topology.lxc.name, "template": topology.lxc.template,
                    "storage": topology.lxc.storage, "cores": topology.lxc.cores,
                    "memory_mb": topology.lxc.memory_mb, "disk_gb": topology.lxc.disk_gb,
                    "bridge": topology.lxc.bridge, "ipv4": topology.lxc.ipv4,
                    "gateway": topology.lxc.gateway, "nameserver": topology.lxc.nameserver,
                    "nfs_host_dir": topology.lxc.nfs_host_dir, "nfs_mount_path": topology.lxc.nfs_mount_path,
                    # Both modes: the port the site listens on in the container.
                    # With no npm: section (wildcard) this is the only place it
                    # is written, and the gateway's upstream is built from it.
                    "forward_port": topology.lxc.forward_port,
                    # With no npm: section this is where the trip's own public
                    # hostname lives. A topology that has one keeps it in
                    # npm.hostname - a second copy could only ever disagree.
                    **({"public_hostname": topology.public_host} if topology.proxy is None else {}),
                },
            },
            **({"npm": {
                "hostname": topology.proxy.hostname, "forward_host": topology.proxy.forward_host,
                "forward_port": topology.proxy.forward_port,
            }} if topology.proxy is not None else {}),
            **({"cloudflare": {
                "tunnel_id": topology.cloudflare.tunnel_id, "hostname": topology.cloudflare.hostname,
                "service": topology.cloudflare.service,
            }} if topology.cloudflare is not None else {}),
        }

    def _mint_npm_token(self) -> str:
        """A fresh NPM JWT for this provision run. NPM tokens expire in ~1 day,
        so a long-lived NPM_API_TOKEN baked into provisioning.env 401s the NPM
        step on any run after it lapsed (hit twice during Sprint 4.5). When
        NPM_IDENTITY / NPM_SECRET are configured, exchange them at job time;
        otherwise fall back to the static NPM_API_TOKEN.
        """
        if self._npm_identity and self._npm_secret:
            result = HttpJsonTransport(self._npm_url, {}).request(
                "POST", "/api/tokens",
                payload={"identity": self._npm_identity, "secret": self._npm_secret},
            )
            token = result.get("token") if isinstance(result, dict) else None
            if not token:
                raise RuntimeError("NPM /api/tokens returned no token")
            return token
        return self._npm_api_token

    def _npm_configured(self) -> bool:
        return bool(self._npm_url and (self._npm_api_token or (self._npm_identity and self._npm_secret)))

    def _cloudflare_configured(self) -> bool:
        return bool(self._cloudflare_zone_id and self._cloudflare_api_token)

    def _build_provisioner(
        self, topology: Topology | None = None, *, exchange_key: str | None = None,
    ) -> Provisioner:
        """The provisioner for one topology - or, with none given, for every
        resource this worker is configured to manage.

        A topology with no `npm:` section gets no NPM transport (and no token
        minted), and one with no `cloudflare:` section gets neither the
        Cloudflare transport nor the SSH transport to the tunnel's host: in
        wildcard routing nothing public is created, so nothing public is
        reached. A section the topology HAS but this worker has no credentials
        for fails here, loudly, rather than as a 401 half-way through a build.

        With no topology (teardown-trip.py's way in), `host` routing builds all
        of it, exactly as before; `wildcard` builds whichever half is configured.
        """
        if topology is not None:
            need_npm, need_cloudflare = topology.proxy is not None, topology.cloudflare is not None
        elif self._routing == ROUTING_HOST:
            need_npm = need_cloudflare = True
        else:
            need_npm, need_cloudflare = self._npm_configured(), self._cloudflare_configured()
        if topology is not None and self._routing != ROUTING_HOST:
            # In `host` routing an empty value is the operator's existing
            # problem and fails where it always did; only the wildcard worker,
            # which starts without these on purpose, needs the explicit check.
            if need_npm and not self._npm_configured():
                raise RuntimeError(
                    f"{topology.name} has an NPM proxy host but this worker has no NPM_URL / NPM credentials")
            if need_cloudflare and not self._cloudflare_configured():
                raise RuntimeError(
                    f"{topology.name} has a Cloudflare record but this worker has no Cloudflare credentials")

        npm_adapter = None
        if need_npm:
            npm_transport = HttpJsonTransport(self._npm_url, {"Authorization": f"Bearer {self._mint_npm_token()}"})
            npm_adapter = NpmProxyHostAdapter(npm_transport)
        cloudflare_adapter = None
        if need_cloudflare:
            cloudflare_transport = HttpJsonTransport("https://api.cloudflare.com", {
                "Authorization": f"Bearer {self._cloudflare_api_token}",
            })
            rpi_ssh = SubprocessSshTransport(
                host=self._rpi_host, user=self._rpi_ssh_user, identity_file=self._rpi_ssh_key,
            )
            cloudflare_adapter = CloudflareTunnelDnsAdapter(cloudflare_transport, self._cloudflare_zone_id, rpi_ssh)
        proxmox_ssh = SubprocessSshTransport(
            host=self._proxmox_host, user=self._proxmox_ssh_user, identity_file=self._proxmox_ssh_key,
        )
        return Provisioner(
            ProxmoxLxcAdapter(
                proxmox_ssh, reset_data=self._reset_data,
                # What a NEW site's .env gets: the trip's own key when per-trip
                # keys are on (create_container passes it), else the shared one.
                # teardown-trip.py builds with no topology and writes no .env.
                control_plane_exchange_key=(
                    self._control_plane_exchange_key if exchange_key is None else exchange_key
                ),
                # A NEW site's HERMES_URL when the bridge is shared ("" otherwise: nothing written).
                hermes_url=self._shared_bridge_site_url,
            ),
            npm_adapter,
            cloudflare_adapter,
        )
