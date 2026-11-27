"""Shared fixtures for the lifecycle-script tests of `placement: vm-container`
(docs/specs/sprint-9/x-trip-vm-container-placement.md, build step 5).

Not a test module (no `test_` prefix, so discovery skips it). It gives the teardown, rollout, autostart, route and
release tests the same three things: a vm-container topology, the worker's `FakeTripHost` (a stand-in for the host's
forced command at the level of its request/answer contract, kept honest by test_trip_container_worker_contract.py), and
the scripts' client (`scripts/trip_container_client.py`) wired to it, so what a script sends is what the real
client would put on ssh.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

TRIP_ID = "trip_0123456789abcdef0123456789abcdef"
DIGEST_A = "ab" * 32
DIGEST_B = "cd" * 32
BRIDGE_URL = "http://bridge.test:4310"
CLIENT_ENV = {
    "TRIP_CONTAINER_SSH_HOST": "cp.example.test", "TRIP_CONTAINER_SSH_USER": "tripctl",
    "TRIP_CONTAINER_SSH_KEY_HOST": "/keys/id", "TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST": "/keys/known_hosts",
    "TRIP_CONTAINER_BRIDGE_URL": BRIDGE_URL,
}


def _load(path: Path, name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


client = _load(ROOT / "scripts" / "trip_container_client.py", "trip_container_client")
fake_host_module = _load(ROOT / "control-plane" / "worker" / "tests" / "support" / "fake_trip_host.py", "fake_trip_host_for_scripts")
FakeTripHost = fake_host_module.FakeTripHost


def container_topology(slug: str = "japan-2026", *, trip_id: str = TRIP_ID, image: str = DIGEST_A, ip: str = "10.250.0.10",
                       hostname: str = "") -> dict:
    return {
        "version": 1, "name": slug, "placement": "vm-container", "routing": "wildcard",
        "container": {
            "name": f"trip-{slug}", "ipv4": ip, "forward_port": 8080,
            "public_hostname": hostname or f"{slug}.example.invalid",
            "nfs_host_dir": f"/srv/nfs/{trip_id}", "nfs_mount_path": "/trip-store", "image": f"trip-site:{image}",
        },
    }


def container_topology_text(**kwargs) -> str:
    """The file as the worker writes it (yaml.safe_dump of plain scalars), without needing PyYAML here."""
    t = container_topology(**kwargs)
    c = t["container"]
    return (f"version: 1\nname: {t['name']}\nplacement: vm-container\nrouting: wildcard\ncontainer:\n"
            f"  name: {c['name']}\n  ipv4: {c['ipv4']}\n  forward_port: {c['forward_port']}\n"
            f"  public_hostname: {c['public_hostname']}\n  nfs_host_dir: {c['nfs_host_dir']}\n"
            f"  nfs_mount_path: {c['nfs_mount_path']}\n  image: {c['image']}\n")


def host_with_trip(store_root: Path, slug: str = "japan-2026", *, trip_id: str = TRIP_ID, running: bool = True,
                   images=(DIGEST_A, DIGEST_B), image: str = DIGEST_A, config: "dict | None" = None):
    """A FakeTripHost that already runs the trip: its store directory exists (TRIP.txt, .env, trip/), and the container is
    up on `image`."""
    host = FakeTripHost(store_root, images=set(images), bridge_url=BRIDGE_URL)
    adapter = client.adapter(CLIENT_ENV, transport=host)
    adapter.ensure(trip_id, slug, ip="10.250.0.10", image=image, seed_password="seedpassword1")
    if config is not None:
        (Path(store_root) / trip_id / "trip" / "trip.config.json").write_text(json.dumps(config))
    host.containers[slug]["running"] = running
    host.events.clear()
    host.requests.clear()
    return host, adapter
