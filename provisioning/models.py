"""Validated, secret-free provisioning topology models."""
from __future__ import annotations

from dataclasses import dataclass
import ipaddress
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
    # provisioning). nfs_mount_path is where the container sees it (mp0). Both
    # are named by trip id, never by slug: a slug is the organizer's words,
    # deliberately reusable once teardown frees it, and an id cannot collide.
    nfs_host_dir: str
    nfs_mount_path: str
    # The human name, for the one place a slug still belongs: the container's
    # OWN filesystem (TRIP_DIR, the TRIP.txt marker) — not NFS, so it is not
    # this dataclass's other paths, and it is what a person actually reads.
    # Always the topology's own top-level `name`; never a second source of
    # truth to fall out of sync with it.
    trip_slug: str = ""
    # The https origin the trip is served on (no path), e.g. https://<host>.
    # Never a YAML key: it is computed from the topology's own public hostname
    # so it cannot drift from the proxy host. The site writes it to .env as
    # PUBLIC_ORIGIN, which is the OAuth issuer of its member MCP connector
    # (server/trip-mcp), together with TRIP_MCP_ENABLED=1. Empty (a hand-built
    # spec with no hostname) leaves the connector off: a guessed origin would
    # be an issuer no assistant could reach.
    public_origin: str = ""
    # The port the trip's site listens on inside the container. Written to the
    # topology in BOTH routing modes: in `host` mode the proxy host forwards to
    # it (and ProxySpec.forward_port repeats it), in `wildcard` mode there is no
    # proxy host and the runtime gateway's upstream is
    # http://<container address>:<forward_port>. Defaulted so a hand-built spec,
    # and a topology written before this field existed, still load.
    forward_port: int = 8080


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


#: How a trip's public hostname reaches its container.
#:   host      one NPM proxy host + one Cloudflare DNS record and tunnel ingress
#:             rule per trip (every trip built before routing was a choice).
#:   wildcard  none of those: a wildcard record, set up once by the operator,
#:             sends every trip hostname to the runtime gateway, which routes by
#:             Host from control_plane.runtime_routes.
ROUTING_HOST = "host"
ROUTING_WILDCARD = "wildcard"
ROUTINGS = (ROUTING_HOST, ROUTING_WILDCARD)


#: Where a trip's site runs.
#:   lxc            one privileged Proxmox LXC per trip (every trip built before
#:                  placement was a choice).
#:   vm-container   one Docker container on the control-plane host. Described by
#:                  a `container:` section instead of `proxmox:`; it needs the
#:                  runtime gateway (routing `wildcard`) and carries no proxy
#:                  host, DNS record or Proxmox call.
PLACEMENT_LXC = "lxc"
PLACEMENT_VM_CONTAINER = "vm-container"
PLACEMENTS = (PLACEMENT_LXC, PLACEMENT_VM_CONTAINER)


@dataclass(frozen=True)
class ContainerSpec:
    """A `vm-container` trip's site. Its key names are the LXC ones on purpose
    (`ipv4`, `forward_port`, `public_hostname`, `nfs_host_dir`, `nfs_mount_path`):
    the worker's line scanners read `ipv4:` and `nfs_host_dir:` out of a
    topology.yaml without parsing it, and must keep working on either placement."""

    name: str
    ipv4: str
    forward_port: int
    public_hostname: str
    nfs_host_dir: str
    nfs_mount_path: str
    # The tag the container runs, `trip-site:<release digest>`.
    image: str
    # As on LxcSpec: the topology's own top-level `name`, and an origin computed
    # from the hostname, never a YAML key of their own.
    trip_slug: str = ""
    public_origin: str = ""


@dataclass(frozen=True, init=False)
class Topology:
    """A trip's validated topology.

    `lxc` is the LXC placement's spec and ONLY that: on a `vm-container`
    topology it raises, naming the placement, instead of handing back an
    absent spec that the next attribute read would turn into an
    `AttributeError` on None - or, worse, a half-built container request.
    Every caller that reaches for `.lxc` is an LXC-only path and fails closed
    here; a path that must work for both placements reads `placement`,
    `container` and `public_host`. The constructor keeps its old keyword
    names (`lxc=`), so the callers that build an LXC topology are unchanged."""

    version: int
    name: str
    _lxc: LxcSpec | None
    # Absent (None) only in a `wildcard` topology: there is no proxy host and no
    # DNS record to plan, inspect or tear down. A `host` topology always has both.
    proxy: ProxySpec | None
    cloudflare: CloudflareSpec | None
    # Absent from every file written before routing was a choice, which means
    # `host` - not "unknown".
    routing: str
    # Absent from every file written before placement was a choice, which means
    # `lxc` - not "unknown".
    placement: str
    container: ContainerSpec | None

    def __init__(
        self,
        version: int,
        name: str,
        lxc: LxcSpec | None,
        proxy: ProxySpec | None,
        cloudflare: CloudflareSpec | None,
        routing: str = ROUTING_HOST,
        placement: str = PLACEMENT_LXC,
        container: ContainerSpec | None = None,
    ) -> None:
        if placement not in PLACEMENTS:
            raise ProvisioningError(f"placement must be one of {', '.join(PLACEMENTS)}")
        if placement == PLACEMENT_LXC:
            if lxc is None or container is not None:
                raise ProvisioningError("an lxc topology needs an lxc spec and no container spec")
        else:
            if container is None or lxc is not None or proxy is not None or cloudflare is not None:
                raise ProvisioningError(
                    "a vm-container topology needs a container spec and no lxc, proxy or cloudflare spec")
            if routing != ROUTING_WILDCARD:
                raise ProvisioningError("placement vm-container requires routing wildcard")
        for field_name, value in (
            ("version", version), ("name", name), ("_lxc", lxc), ("proxy", proxy), ("cloudflare", cloudflare),
            ("routing", routing), ("placement", placement), ("container", container),
        ):
            object.__setattr__(self, field_name, value)

    @property
    def lxc(self) -> LxcSpec:
        if self.placement != PLACEMENT_LXC or self._lxc is None:
            raise ProvisioningError(
                f"topology {self.name!r} has placement {self.placement}: it has no proxmox.lxc, "
                "and this operation is for LXC trips only")
        return self._lxc

    @property
    def public_host(self) -> str:
        """The trip's public hostname, taken from the topology's own origin."""
        origin = self.container.public_origin if self.placement == PLACEMENT_VM_CONTAINER else self.lxc.public_origin
        return origin[len("https://"):] if origin.startswith("https://") else ""


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


def _optional_mapping(data: Mapping[str, Any], key: str, context: str) -> Mapping[str, Any] | None:
    """A section that may be absent. Present-but-wrong is still an error: an
    empty or non-mapping `npm:` must not quietly read as "no proxy host"."""
    if key not in data:
        return None
    return _mapping(data, key, context)


def _load_vm_container_topology(raw: Mapping[str, Any], name: str, routing: str) -> Topology:
    """A `placement: vm-container` file: a `container:` section, no `proxmox:`.

    Refused rather than half-read: `proxmox`, `npm` or `cloudflare` present (a
    file of two placements has no single truth), and any `routing` but
    `wildcard` - an absent line would read as `host`, and a host-routed trip
    records no upstream address, so the gateway could not reach it."""
    for section in ("proxmox", "npm", "cloudflare"):
        if section in raw:
            raise ProvisioningError(f"topology.{section} is not allowed with placement vm-container")
    if routing != ROUTING_WILDCARD:
        raise ProvisioningError("placement vm-container requires routing: wildcard")
    container = _mapping(raw, "container", "topology")
    ipv4 = _nonempty_string(container, "ipv4", "container")
    try:
        ipaddress.IPv4Address(ipv4)
    except ValueError:
        raise ProvisioningError("container.ipv4 must be a plain IPv4 address") from None
    port = _positive_int(container, "forward_port", "container")
    if port > 65535:
        raise ProvisioningError("container.forward_port must be a port number")
    hostname = _nonempty_string(container, "public_hostname", "container")
    return Topology(
        version=1,
        name=name,
        lxc=None,
        proxy=None,
        cloudflare=None,
        routing=routing,
        placement=PLACEMENT_VM_CONTAINER,
        container=ContainerSpec(
            name=_nonempty_string(container, "name", "container"),
            ipv4=ipv4,
            forward_port=port,
            public_hostname=hostname,
            nfs_host_dir=_nonempty_string(container, "nfs_host_dir", "container"),
            nfs_mount_path=_nonempty_string(container, "nfs_mount_path", "container"),
            image=_nonempty_string(container, "image", "container"),
            trip_slug=name,
            public_origin=f"https://{hostname}",
        ),
    )


def load_topology(raw: Mapping[str, Any]) -> Topology:
    """Convert parsed YAML into a validated topology without accepting secrets."""
    if not isinstance(raw, Mapping):
        raise ProvisioningError("topology must be a mapping")
    if raw.get("version") != 1:
        raise ProvisioningError("version must be 1")
    name = _nonempty_string(raw, "name", "topology")
    # Absent means `host`. A value that is present and is not one of the two is
    # refused: guessing would plan (or tear down) the wrong set of resources.
    routing = raw["routing"] if "routing" in raw else ROUTING_HOST
    if routing not in ROUTINGS:
        raise ProvisioningError(f"routing must be one of {', '.join(ROUTINGS)}")
    # Absent means `lxc`; present and unknown is refused for the same reason.
    placement = raw["placement"] if "placement" in raw else PLACEMENT_LXC
    if placement not in PLACEMENTS:
        raise ProvisioningError(f"placement must be one of {', '.join(PLACEMENTS)}")
    if placement == PLACEMENT_VM_CONTAINER:
        return _load_vm_container_topology(raw, name, routing)
    # The placement picks the section, with no fallback to the other one: an
    # lxc file that also carries `container:` is half of a vm-container file.
    if "container" in raw:
        raise ProvisioningError("topology.container is only for placement vm-container")
    proxmox = _mapping(raw, "proxmox", "topology")
    lxc = _mapping(proxmox, "lxc", "proxmox")
    if routing == ROUTING_HOST:
        proxy = _mapping(raw, "npm", "topology")
        cloudflare = _mapping(raw, "cloudflare", "topology")
    else:
        proxy = _optional_mapping(raw, "npm", "topology")
        cloudflare = _optional_mapping(raw, "cloudflare", "topology")

    hostname = None
    if proxy is not None:
        hostname = _nonempty_string(proxy, "hostname", "npm")
    if "public_hostname" in lxc or hostname is None:
        own = _nonempty_string(lxc, "public_hostname", "proxmox.lxc")
        if hostname is not None and own != hostname:
            raise ProvisioningError("proxmox.lxc.public_hostname disagrees with npm.hostname")
        hostname = own
    # Older files carry the port only under npm; the site's own port is the same
    # number either way.
    if "forward_port" in lxc:
        forward_port = _positive_int(lxc, "forward_port", "proxmox.lxc")
    elif proxy is not None:
        forward_port = _positive_int(proxy, "forward_port", "npm")
    else:
        raise ProvisioningError("proxmox.lxc.forward_port is required")

    return Topology(
        version=1,
        name=name,
        routing=routing,
        placement=PLACEMENT_LXC,
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
            trip_slug=name,
            public_origin=f"https://{hostname}",
            forward_port=forward_port,
        ),
        proxy=None if proxy is None else ProxySpec(
            hostname=_nonempty_string(proxy, "hostname", "npm"),
            forward_host=_nonempty_string(proxy, "forward_host", "npm"),
            forward_port=_positive_int(proxy, "forward_port", "npm"),
        ),
        cloudflare=None if cloudflare is None else CloudflareSpec(
            tunnel_id=_nonempty_string(cloudflare, "tunnel_id", "cloudflare"),
            hostname=_nonempty_string(cloudflare, "hostname", "cloudflare"),
            service=_nonempty_string(cloudflare, "service", "cloudflare"),
        ),
    )
