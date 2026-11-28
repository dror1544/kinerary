"""The lifecycle scripts' way to a `placement: vm-container` trip (docs/specs/sprint-9/x-trip-vm-container-placement.md).

teardown-trip.py, trip-rollout.py, trip-autostart.py, trip-route.py, e2e-full-cycle.py and the release tool all run
ON the control-plane host. A vm-container trip has no Proxmox container to `pct` into: its site is a Docker
container the host's forced command (scripts/trip-container-host.sh) drives, and its files are a directory on the
document store. This module is the one place the scripts reach either, so they cannot drift in how.

It does NOT write a second SSH client. The worker's own `DockerSiteAdapter` and `ssh_transport`
(control_plane_worker/trip_container.py) are used as they are; the only difference is the address: the scripts run on
the host, so ssh connects to loopback (`TRIP_CONTAINER_SSH_CONNECT`, default 127.0.0.1) and checks the host key against
the pin written for the host's own name (`HostKeyAlias=<TRIP_CONTAINER_SSH_HOST>`). Nothing is loosened.

Everything about WHERE comes from the environment (hard rule 6), the values vm.env already carries:

  TRIP_CONTAINER_SSH_HOST             the name the pin is written for (the worker reaches the host by it)
  TRIP_CONTAINER_SSH_USER             the forced-command user
  TRIP_CONTAINER_SSH_KEY_HOST         the worker's private key, as a path on THIS host
  TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST the pinned known_hosts file, as a path on THIS host
  TRIP_CONTAINER_BRIDGE_URL           the shared bridge as a container reaches it (the host pins the same value)
  KINERARY_NFS_ROOT                   the document store as THIS host mounts it (only for the store's own files)

A variable that is unset is a refusal that names it: there is no default host, key or pin, and the pin is never
skipped (an empty known_hosts would make ssh accept a new host key).
"""
from __future__ import annotations

import importlib
import os
import re
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional

REPO = Path(__file__).resolve().parents[1]

PLACEMENT_LXC, PLACEMENT_VM_CONTAINER = "lxc", "vm-container"

#: The variables the client needs; every one is refused by name when unset.
CLIENT_ENV = (
    ("TRIP_CONTAINER_SSH_HOST", "the host name the worker's ssh pin is written for"),
    ("TRIP_CONTAINER_SSH_USER", "the trip-container forced-command user"),
    ("TRIP_CONTAINER_SSH_KEY_HOST", "the worker's trip-container private key, as a path on this host"),
    ("TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST", "the pinned known_hosts file, as a path on this host"),
    ("TRIP_CONTAINER_BRIDGE_URL", "the shared bridge as a trip container reaches it"),
)
DEFAULT_CONNECT = "127.0.0.1"

TRIP_ID = re.compile(r"trip_[0-9a-f]{8,64}")
SLUG = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
IMAGE_TAG = re.compile(r"trip-site:([0-9a-f]{64})")
OCTET = r"(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])"
IPV4 = re.compile(rf"(?:{OCTET}\.){{3}}{OCTET}")
PORT = re.compile(r"[0-9]{1,5}")


class ClientConfigError(Exception):
    """This host is not set up to reach the trip-container host, or a trip's record is not what it must be."""


# ── the environment ─────────────────────────────────────────────────────────

def load_env_defaults(deploy_root: Path, environ: "dict[str, str] | None" = None) -> None:
    """vm.env over provisioning.env, as the worker's compose sees them: `setdefault`, so a variable already in the
    process (the caller's, a test's) wins and the first file read wins over the second."""
    target = os.environ if environ is None else environ
    for name in ("vm.env", "provisioning.env"):
        env_file = Path(deploy_root) / name
        if not env_file.is_file():
            continue
        for line in env_file.read_text().splitlines():
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                target.setdefault(m.group(1), m.group(2).strip().strip('"').strip("'"))


def missing_client_env(environ: Mapping[str, str]) -> "list[tuple[str, str]]":
    return [(name, why) for name, why in CLIENT_ENV if not (environ.get(name) or "").strip()]


def require_client_env(environ: Mapping[str, str]) -> None:
    missing = missing_client_env(environ)
    if missing:
        lines = "\n".join(f"  {name}  - {why}" for name, why in missing)
        raise ClientConfigError(
            "this host is not set up to reach the trip-container host; unset:\n" + lines
            + "\n(vm.env carries them; the scripts read it from the deployment root.)")


# ── the worker's client, loaded without its package's __init__ ──────────────

def worker_module(repo: Path = REPO):
    """control_plane_worker.trip_container, standard library only. The package's `__init__` imports the whole worker,
    which a script on the host neither needs nor can always import, so the package is stood up empty and only its
    two stdlib modules are read. Idempotent."""
    name = "kinerary_cp_worker"
    if name not in sys.modules:
        package = types.ModuleType(name)
        package.__path__ = [str(Path(repo) / "control-plane" / "worker" / "control_plane_worker")]  # type: ignore[attr-defined]
        sys.modules[name] = package
    return importlib.import_module(f"{name}.trip_container")


def adapter(environ: Mapping[str, str], *, transport: Any = None, repo: Path = REPO):
    """The worker's `DockerSiteAdapter`, over ssh to this host's own forced command (or over `transport`, which is
    how a test stands in for the host)."""
    require_client_env(environ)
    module = worker_module(repo)
    if transport is None:
        transport = module.ssh_transport(
            environ["TRIP_CONTAINER_SSH_HOST"], environ["TRIP_CONTAINER_SSH_USER"],
            os.path.expanduser(environ["TRIP_CONTAINER_SSH_KEY_HOST"]), environ["TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST"],
            connect_host=(environ.get("TRIP_CONTAINER_SSH_CONNECT") or DEFAULT_CONNECT).strip(),
        )
    return module.DockerSiteAdapter(transport, bridge_url=environ["TRIP_CONTAINER_BRIDGE_URL"])


def store(environ: Mapping[str, str], trip_id: str, *, repo: Path = REPO):
    """The trip's directory on the document store as THIS host mounts it: `<KINERARY_NFS_ROOT>/<trip id>`. Opened
    the worker's way (every component O_NOFOLLOW, TRIP.txt must name this trip)."""
    root = (environ.get("KINERARY_NFS_ROOT") or "").strip()
    if not root:
        raise ClientConfigError("KINERARY_NFS_ROOT is not set: the trip's files are on the document store, and this "
                                "host has to be told where it mounts it (vm.env carries it)")
    if not TRIP_ID.fullmatch(trip_id or ""):
        raise ClientConfigError("the trip id is not a trip id")
    return worker_module(repo).TripStore(root, trip_id, trip_id)


# ── a vm-container topology, from whichever parser the script has ───────────

def parse_topology_text(text: str) -> "dict[str, Any]":
    """The nested mapping the worker writes (yaml.safe_dump of plain scalars), read without PyYAML: the release tool and
    the rollout run under whatever python the host has."""
    root: "dict[str, Any]" = {}
    stack: "list[tuple[int, dict[str, Any]]]" = [(-1, root)]
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = re.match(r"^(\s*)([A-Za-z0-9_.-]+):\s*(.*?)\s*$", raw)
        if not m:
            continue
        indent, key, value = len(m.group(1)), m.group(2), m.group(3)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1][1]
        if value == "":
            child: "dict[str, Any]" = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = value.strip("'\"")
    return root


def placement_of(topology: Mapping[str, Any]) -> str:
    """A topology's recorded placement; absent means lxc, as everywhere else."""
    value = topology.get("placement") if isinstance(topology, Mapping) else None
    return str(value) if value else PLACEMENT_LXC


def placement_of_text(text: str) -> str:
    """The same, from the raw file: the top-level `placement:` line (nothing nested is written at column 0)."""
    for line in text.splitlines():
        if line.startswith("placement:"):
            return line.split(":", 1)[1].strip().strip("'\"") or PLACEMENT_LXC
    return PLACEMENT_LXC


@dataclass(frozen=True)
class ContainerInfo:
    slug: str
    name: str
    ipv4: str
    forward_port: int
    trip_id: str
    public_hostname: str
    image: Optional[str]            # the 64 hex digits the topology says the container runs, or None

    @property
    def image_tag(self) -> Optional[str]:
        return f"trip-site:{self.image}" if self.image else None


def container_info(topology: Mapping[str, Any], slug: str) -> ContainerInfo:
    """Validate a vm-container topology's `container:` section for THIS slug. Each value is checked against an
    ASCII-only pattern before anything is built from it (the same reason read_trip_wiring does)."""
    if not isinstance(topology, Mapping) or placement_of(topology) != PLACEMENT_VM_CONTAINER:
        raise ClientConfigError(f"{slug}'s topology is not a vm-container one")
    section = topology.get("container")
    if not isinstance(section, Mapping):
        raise ClientConfigError(f"{slug}'s topology has placement vm-container and no container section")
    if topology.get("name") != slug or section.get("name") != f"trip-{slug}":
        raise ClientConfigError(f"the topology does not describe {slug}")
    ipv4 = str(section.get("ipv4") or "")
    port = str(section.get("forward_port") or "")
    if not IPV4.fullmatch(ipv4) or not PORT.fullmatch(port) or not 1 <= int(port) <= 65535:
        raise ClientConfigError(f"{slug}'s topology lacks a usable container address and forward_port")
    trip_id = str(section.get("nfs_host_dir") or "").rstrip("/").rsplit("/", 1)[-1]
    if not TRIP_ID.fullmatch(trip_id):
        raise ClientConfigError(f"{slug}'s topology names no trip-id directory (container.nfs_host_dir)")
    image = IMAGE_TAG.fullmatch(str(section.get("image") or ""))
    return ContainerInfo(slug=slug, name=f"trip-{slug}", ipv4=ipv4, forward_port=int(port), trip_id=trip_id,
                         public_hostname=str(section.get("public_hostname") or ""),
                         image=image.group(1) if image else None)
