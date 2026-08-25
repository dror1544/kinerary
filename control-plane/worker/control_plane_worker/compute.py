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
"""
from __future__ import annotations

import ipaddress
import os
from pathlib import Path
from typing import Callable, Protocol, Sequence

import yaml

from provisioning.adapters import (
    CloudflareTunnelDnsAdapter,
    NpmProxyHostAdapter,
    ProxmoxLxcAdapter,
    SubprocessSshTransport,
)
from provisioning.engine import Provisioner
from provisioning.models import CloudflareSpec, LxcSpec, ProxySpec, Topology, load_topology
from provisioning.runtime import HttpJsonTransport


class ComputeAdapter(Protocol):
    """Creates (or reuses an already-created) compute instance for a trip.
    Returns its vmid as a string."""

    def create_container(self, slug: str) -> str: ...


class NullComputeAdapter:
    """No compute adapter configured — ShellDeployAdapter falls back to this
    when a slug has no static vmid_map entry and Phase G's automatic
    creation hasn't been turned on. Matches the pre-Phase-G behavior: a
    clear error rather than a silent no-op."""

    def create_container(self, slug: str) -> str:
        raise ValueError(
            f"no vmid configured for slug {slug!r}, and automatic container "
            "creation (--enable-compute) is not turned on"
        )


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
        tunnel_name: str,
        npm_url: str,
        npm_api_token: str,
        cloudflare_account_id: str,
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
        provisioner_factory: Callable[[], Provisioner] | None = None,
    ) -> None:
        self._deploy_root = deploy_root
        self._node = node
        self._template = template
        self._storage = storage
        self._bridge = bridge
        self._ip_pool = list(ip_pool)
        for candidate in self._ip_pool:
            ipaddress.ip_address(candidate)  # fail fast on a malformed pool entry
        self._hostname_domain = hostname_domain
        self._tunnel_name = tunnel_name
        self._npm_url = npm_url
        self._npm_api_token = npm_api_token
        self._cloudflare_account_id = cloudflare_account_id
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
        # Overridable so tests can inject a Provisioner built from fake
        # transports (matching tests/provisioning/test_adapters.py's own
        # FakeTransport) instead of the real HttpJsonTransport this
        # constructs by default — mirrors provisioning/__main__.py's own
        # build_provisioner(), which is likewise credential-driven and
        # exercised only via the adapter/engine layer's own fake-transport
        # tests, not directly.
        self._provisioner_factory = provisioner_factory or self._build_provisioner

    def create_container(self, slug: str) -> str:
        topology_path = self._topology_path(slug)
        topology = self._load_topology(topology_path)
        if topology is None:
            topology = self._build_topology(slug)
            self._write_topology(topology_path, topology, slug)

        provisioner = self._provisioner_factory()
        provisioner.apply(topology, execute=True)

        record = provisioner.proxmox.inspect(topology.lxc)
        if record is None or "vmid" not in record:
            raise RuntimeError(
                f"Proxmox reports no container named {topology.lxc.name!r} on "
                f"{self._node} after apply — cannot determine its vmid"
            )
        return str(record["vmid"])

    # ── topology construction ────────────────────────────────────────────

    def _topology_path(self, slug: str) -> Path:
        return Path(self._deploy_root) / "trips" / slug / "topology.yaml"

    def _load_topology(self, path: Path) -> Topology | None:
        if not path.exists():
            return None
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        return load_topology(raw)

    def _build_topology(self, slug: str) -> Topology:
        ipv4 = self._allocate_ip(slug)
        name = self._lxc_name(slug)
        hostname = f"{slug}.{self._hostname_domain}"
        return Topology(
            version=1,
            name=slug,
            lxc=LxcSpec(
                name=name, node=self._node, template=self._template, storage=self._storage,
                cores=self._cores, memory_mb=self._memory_mb, disk_gb=self._disk_gb,
                bridge=self._bridge, ipv4=f"{ipv4}/24",
                gateway=self._gateway, nameserver=self._nameserver,
                nfs_host_dir=f"{self._nfs_host_base}/{slug}",
                nfs_mount_path=f"{self._nfs_mount_base}/{slug}",
            ),
            proxy=ProxySpec(hostname=hostname, forward_host=name, forward_port=self._forward_port),
            cloudflare=CloudflareSpec(
                tunnel_name=self._tunnel_name, hostname=hostname,
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

    def _write_topology(self, path: Path, topology: Topology, slug: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "name": topology.name,
            "proxmox": {
                "node": topology.lxc.node,
                "lxc": {
                    "name": topology.lxc.name, "template": topology.lxc.template,
                    "storage": topology.lxc.storage, "cores": topology.lxc.cores,
                    "memory_mb": topology.lxc.memory_mb, "disk_gb": topology.lxc.disk_gb,
                    "bridge": topology.lxc.bridge, "ipv4": topology.lxc.ipv4,
                    "gateway": topology.lxc.gateway, "nameserver": topology.lxc.nameserver,
                    "nfs_host_dir": topology.lxc.nfs_host_dir, "nfs_mount_path": topology.lxc.nfs_mount_path,
                },
            },
            "npm": {
                "hostname": topology.proxy.hostname, "forward_host": topology.proxy.forward_host,
                "forward_port": topology.proxy.forward_port,
            },
            "cloudflare": {
                "tunnel_name": topology.cloudflare.tunnel_name, "hostname": topology.cloudflare.hostname,
                "service": topology.cloudflare.service,
            },
        }
        header = (
            f"# Auto-generated by control_plane_worker.compute.LxcProvisionAdapter for {slug}.\n"
            "# Written BEFORE apply() runs so a retried job reuses the same IP/hostname\n"
            "# instead of allocating a second one.\n"
        )
        path.write_text(header + yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")

    def _build_provisioner(self) -> Provisioner:
        npm_transport = HttpJsonTransport(self._npm_url, {"Authorization": f"Bearer {self._npm_api_token}"})
        cloudflare_transport = HttpJsonTransport("https://api.cloudflare.com", {
            "Authorization": f"Bearer {self._cloudflare_api_token}",
        })
        proxmox_ssh = SubprocessSshTransport(
            host=self._proxmox_host, user=self._proxmox_ssh_user, identity_file=self._proxmox_ssh_key,
        )
        rpi_ssh = SubprocessSshTransport(
            host=self._rpi_host, user=self._rpi_ssh_user, identity_file=self._rpi_ssh_key,
        )
        return Provisioner(
            ProxmoxLxcAdapter(proxmox_ssh),
            NpmProxyHostAdapter(npm_transport),
            CloudflareTunnelDnsAdapter(cloudflare_transport, self._cloudflare_account_id, self._cloudflare_zone_id, rpi_ssh),
        )
