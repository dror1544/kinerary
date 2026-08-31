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
    # The LXC has a post-create bootstrap (nginx/Node/systemd unit/.env). A
    # container that exists but never finished bootstrapping is invisible to
    # the create/no-op logic, so the engine converges it in place.
    def needs_bootstrap(self, spec: LxcSpec) -> bool: ...
    def bootstrap(self, spec: LxcSpec) -> None: ...
    # First-provision data wipe, for when create() will not run because the
    # container already exists. The engine never calls this; the compute
    # wrapper drives it from the control plane's first_provision signal.
    def reset_trip_data(self, spec: LxcSpec) -> None: ...


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
        lxc_prior: dict[str, Any] | None = None
        for resource, adapter, spec in candidates:
            prior = adapter.inspect(spec)
            if resource == "proxmox_lxc":
                lxc_prior = prior
            if prior is None:
                desired = asdict(spec)
                changes.append(Change(resource, "create", desired))
                rollback.append(RollbackEntry(resource, "delete", desired, None))

        # The LXC container can exist yet be only half-bootstrapped (the
        # bootstrap script is `set -e` and has failed mid-run in practice). The
        # loop above planned no 'create' for it because inspect() sees the
        # container — so converge it in place. bootstrap() is idempotent, so
        # this is a no-op reversal.
        if lxc_prior is not None and self.proxmox.needs_bootstrap(topology.lxc):
            desired = asdict(topology.lxc)
            changes.append(Change("proxmox_lxc", "bootstrap", desired))
            rollback.append(RollbackEntry("proxmox_lxc", "noop", desired, lxc_prior))

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
            adapter = adapters[change.resource]
            spec = self._spec_for_change(topology, change.resource)
            if change.operation == "bootstrap":
                adapter.bootstrap(spec)
            else:
                adapter.create(spec)
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
