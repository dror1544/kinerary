"""Validated, secret-free provisioning topology models."""
from __future__ import annotations

from dataclasses import dataclass
import os
import re
from typing import Any, Mapping


class ProvisioningError(ValueError):
    """Raised when a topology is unsafe or incomplete."""


@dataclass(frozen=True)
class LxcSpec:
    name: str
    node: str
    template: str
    storage: str
    cores: int
    memory_mb: int
    disk_gb: int
    bridge: str
    ipv4: str
    gateway: str
    nameserver: str
    # Trip media (avatars/photos) storage: nfs_host_dir already lives on the
    # NFS mount Proxmox itself has (confirmed live: /mnt/pve/truenas-nfs/...,
    # a subdirectory there is all a new trip needs — no separate TrueNAS-side
    # provisioning). nfs_mount_path is where the container sees it (mp0).
    nfs_host_dir: str
    nfs_mount_path: str


@dataclass(frozen=True)
class ProxySpec:
    hostname: str
    forward_host: str
    forward_port: int


@dataclass(frozen=True)
class CloudflareSpec:
    # A static value, not looked up via Cloudflare's account-scoped tunnel
    # API — the tunnel is pre-existing, shared, and locally-managed (reads
    # /etc/cloudflared/config.yml on the RPi4); this adapter never creates
    # or deletes the tunnel object itself, only DNS records and ingress
    # rules for it, so there's nothing to resolve at runtime.
    tunnel_id: str
    hostname: str
    service: str


@dataclass(frozen=True)
class Topology:
    version: int
    name: str
    lxc: LxcSpec
    proxy: ProxySpec
    cloudflare: CloudflareSpec


_ENV_REFERENCE = re.compile(r"^\$\{([A-Z][A-Z0-9_]*)\}$")


def _value(data: Mapping[str, Any], key: str, context: str) -> Any:
    if key not in data or data[key] in (None, ""):
        raise ProvisioningError(f"{context}.{key} is required")
    value = data[key]
    if isinstance(value, str):
        match = _ENV_REFERENCE.fullmatch(value)
        if match:
            env_value = os.environ.get(match.group(1))
            if not env_value:
                raise ProvisioningError(f"environment variable {match.group(1)} for {context}.{key} is required")
            return env_value
    return value


def _mapping(data: Mapping[str, Any], key: str, context: str) -> Mapping[str, Any]:
    value = _value(data, key, context)
    if not isinstance(value, Mapping):
        raise ProvisioningError(f"{context}.{key} must be a mapping")
    return value


def _positive_int(data: Mapping[str, Any], key: str, context: str) -> int:
    value = _value(data, key, context)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ProvisioningError(f"{context}.{key} must be a positive integer")
    return value


def _nonempty_string(data: Mapping[str, Any], key: str, context: str) -> str:
    value = _value(data, key, context)
    if not isinstance(value, str) or not value.strip():
        raise ProvisioningError(f"{context}.{key} must be a non-empty string")
    return value


def load_topology(raw: Mapping[str, Any]) -> Topology:
    """Convert parsed YAML into a validated topology without accepting secrets."""
    if not isinstance(raw, Mapping):
        raise ProvisioningError("topology must be a mapping")
    if raw.get("version") != 1:
        raise ProvisioningError("version must be 1")
    name = _nonempty_string(raw, "name", "topology")
    proxmox = _mapping(raw, "proxmox", "topology")
    lxc = _mapping(proxmox, "lxc", "proxmox")
    proxy = _mapping(raw, "npm", "topology")
    cloudflare = _mapping(raw, "cloudflare", "topology")
    return Topology(
        version=1,
        name=name,
        lxc=LxcSpec(
            name=_nonempty_string(lxc, "name", "proxmox.lxc"),
            node=_nonempty_string(proxmox, "node", "proxmox"),
            template=_nonempty_string(lxc, "template", "proxmox.lxc"),
            storage=_nonempty_string(lxc, "storage", "proxmox.lxc"),
            cores=_positive_int(lxc, "cores", "proxmox.lxc"),
            memory_mb=_positive_int(lxc, "memory_mb", "proxmox.lxc"),
            disk_gb=_positive_int(lxc, "disk_gb", "proxmox.lxc"),
            bridge=_nonempty_string(lxc, "bridge", "proxmox.lxc"),
            ipv4=_nonempty_string(lxc, "ipv4", "proxmox.lxc"),
            gateway=_nonempty_string(lxc, "gateway", "proxmox.lxc"),
            nameserver=_nonempty_string(lxc, "nameserver", "proxmox.lxc"),
            nfs_host_dir=_nonempty_string(lxc, "nfs_host_dir", "proxmox.lxc"),
            nfs_mount_path=_nonempty_string(lxc, "nfs_mount_path", "proxmox.lxc"),
        ),
        proxy=ProxySpec(
            hostname=_nonempty_string(proxy, "hostname", "npm"),
            forward_host=_nonempty_string(proxy, "forward_host", "npm"),
            forward_port=_positive_int(proxy, "forward_port", "npm"),
        ),
        cloudflare=CloudflareSpec(
            tunnel_id=_nonempty_string(cloudflare, "tunnel_id", "cloudflare"),
            hostname=_nonempty_string(cloudflare, "hostname", "cloudflare"),
            service=_nonempty_string(cloudflare, "service", "cloudflare"),
        ),
    )
