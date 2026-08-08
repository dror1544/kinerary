"""Side-effect gated reconciliation and rollback journal generation."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from .models import CloudflareSpec, LxcSpec, ProxySpec, Topology


class ProxmoxAdapter(Protocol):
    def inspect(self, spec: LxcSpec) -> dict[str, Any] | None: ...
    def create(self, spec: LxcSpec) -> None: ...
    def delete(self, spec: LxcSpec) -> None: ...


class NpmAdapter(Protocol):
    def inspect(self, spec: ProxySpec) -> dict[str, Any] | None: ...
    def create(self, spec: ProxySpec) -> None: ...
    def delete(self, spec: ProxySpec) -> None: ...


class CloudflareAdapter(Protocol):
    def inspect(self, spec: CloudflareSpec) -> dict[str, Any] | None: ...
    def create(self, spec: CloudflareSpec) -> None: ...
    def delete(self, spec: CloudflareSpec) -> None: ...


@dataclass(frozen=True)
class Change:
    resource: str
    operation: str
    desired: dict[str, Any]


@dataclass(frozen=True)
class RollbackEntry:
    resource: str
    operation: str
    desired: dict[str, Any]
    prior_state: dict[str, Any] | None


@dataclass(frozen=True)
class RollbackSnapshot:
    topology_name: str
    created_at: str
    executed: bool
    changes: list[Change]
    rollback: list[RollbackEntry]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Provisioner:
    """Plans reconciliation; it does not change infrastructure without execute=True.

    Adapter ``inspect`` must return a state only when the uniquely named resource
    exists. A present resource is intentionally a no-op: this prevents implicit
    destructive replacement. Configuration changes require an explicit migration
    in an adapter rather than being silently applied by onboarding.
    """

    def __init__(self, proxmox: ProxmoxAdapter, npm: NpmAdapter, cloudflare: CloudflareAdapter) -> None:
        self.proxmox = proxmox
        self.npm = npm
        self.cloudflare = cloudflare

    def plan(self, topology: Topology) -> RollbackSnapshot:
        candidates = [
            ("proxmox_lxc", self.proxmox, topology.lxc),
            ("npm_proxy_host", self.npm, topology.proxy),
            ("cloudflare_tunnel_dns", self.cloudflare, topology.cloudflare),
        ]
        changes: list[Change] = []
        rollback: list[RollbackEntry] = []
        for resource, adapter, spec in candidates:
            prior = adapter.inspect(spec)
            if prior is None:
                desired = asdict(spec)
                changes.append(Change(resource, "create", desired))
                rollback.append(RollbackEntry(resource, "delete", desired, None))
        return RollbackSnapshot(
            topology_name=topology.name,
            created_at=datetime.now(timezone.utc).isoformat(),
            executed=False,
            changes=changes,
            rollback=rollback,
        )

    def apply(self, topology: Topology, *, execute: bool = False) -> RollbackSnapshot:
        planned = self.plan(topology)
        if not execute:
            return planned
        adapters = {
            "proxmox_lxc": self.proxmox,
            "npm_proxy_host": self.npm,
            "cloudflare_tunnel_dns": self.cloudflare,
        }
        for change in planned.changes:
            adapters[change.resource].create(self._spec_for_change(topology, change.resource))
        return RollbackSnapshot(
            topology_name=planned.topology_name,
            created_at=planned.created_at,
            executed=True,
            changes=planned.changes,
            rollback=planned.rollback,
        )

    @staticmethod
    def _spec_for_change(topology: Topology, resource: str) -> LxcSpec | ProxySpec | CloudflareSpec:
        return {
            "proxmox_lxc": topology.lxc,
            "npm_proxy_host": topology.proxy,
            "cloudflare_tunnel_dns": topology.cloudflare,
        }[resource]
