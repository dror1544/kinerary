#!/usr/bin/env python3
"""Show or change whether a trip's site container starts when the Proxmox host boots.

Every trip container is created to start on boot, after TrueNAS and the control
plane (`--onboot 1 --startup order=3`, provisioning/adapters.py). Before
2026-09-13 none was: a host reboot brought back TrueNAS and the control plane
and left every family's site down until someone started it by hand. This is
the switch for the exception — a trip that should stay down after a reboot.

    scripts/trip-autostart.py --trip japan-2026          # show
    scripts/trip-autostart.py --trip japan-2026 --off    # stays down after a host reboot
    scripts/trip-autostart.py --trip japan-2026 --on     # starts on boot again, order 3

On the Proxmox VM the deploy root is root-only:

    sudo KINERARY_DEPLOY_ROOT=/opt/kinerary-deploy python3 scripts/trip-autostart.py --trip <slug> --off

The container is the vmid in the trip's topology.yaml, and it must still carry
the hostname that topology gives it. Anything else is refused: a VMID Proxmox
has since handed to another container is not this trip's to change.

A `placement: vm-container` trip is a Docker container on the control-plane host with the
restart policy `unless-stopped` (scripts/trip-container-host.sh): it comes back after a
reboot unless it was stopped. So here `--off` is the host's `stop` and `--on` its `start`,
with no `pct` and no Proxmox. The difference to an LXC is that `--off` stops the site NOW, not
only at the next boot (the output says so): that is what holds it down across a reboot.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
DEPLOY_ROOT = Path(os.environ.get("KINERARY_DEPLOY_ROOT") or HOME / "kinerary-deploy")
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
STARTUP = "order=3"


class Refused(Exception):
    """The request, or this host's setup for it, cannot be vouched for."""


def _client():
    """scripts/trip_container_client.py, loaded by path: this file may be run, or imported, from anywhere."""
    if "trip_container_client" not in sys.modules:
        spec = importlib.util.spec_from_file_location("trip_container_client", Path(__file__).with_name("trip_container_client.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules["trip_container_client"] = module
        spec.loader.exec_module(module)
    return sys.modules["trip_container_client"]


def container_adapter():
    """The worker's client of this host's trip-container forced command, or a refusal naming what is unset."""
    load_provisioning_env()
    try:
        return _client().adapter(os.environ)
    except _client().ClientConfigError as exc:
        raise Refused(str(exc)) from None


def load_provisioning_env() -> None:
    """vm.env over provisioning.env, as the worker's compose sees them."""
    for name in ("vm.env", "provisioning.env"):
        env_file = DEPLOY_ROOT / name
        if not env_file.is_file():
            continue
        for line in env_file.read_text().splitlines():
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                os.environ.setdefault(m.group(1), m.group(2).strip().strip('"').strip("'"))


def parse_topology(text: str) -> tuple[str, str]:
    """(vmid, container name) from a topology.yaml as compute.py writes it."""
    vmid = re.search(r"^\s*vmid:\s*['\"]?(\d+)['\"]?\s*$", text, re.M)
    lxc = re.search(r"^(\s*)lxc:\s*$", text, re.M)
    name = None
    if lxc:
        for line in text[lxc.end():].splitlines()[1:]:
            if line.strip() and len(line) - len(line.lstrip()) <= len(lxc.group(1)):
                break
            m = re.match(r"^\s*name:\s*['\"]?([A-Za-z0-9.-]+)['\"]?\s*$", line)
            if m:
                name = m.group(1)
                break
    if not vmid or not name:
        raise ValueError("topology has no proxmox.vmid or proxmox.lxc.name")
    return vmid.group(1), name


def parse_pct_config(text: str) -> dict[str, str]:
    config = {}
    for line in text.splitlines():
        if ":" in line and not line.startswith((" ", "[", "#")):
            key, value = line.split(":", 1)
            config[key.strip()] = value.strip()
    return config


def set_command(vmid: str, on: bool) -> str:
    q = shlex.quote(vmid)
    return f"pct set {q} --onboot 1 --startup {STARTUP}" if on else f"pct set {q} --onboot 0"


def proxmox(command: str) -> str:
    key = os.path.expanduser(os.environ.get("PROXMOX_SSH_KEY") or "~/.ssh/id_ed25519_proxmox_hermes")
    host = os.environ.get("PROXMOX_HOST", "192.168.0.40")
    user = os.environ.get("PROXMOX_SSH_USER", "root")
    out = subprocess.run(
        ["ssh", "-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", f"{user}@{host}", command],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"proxmox: {command!r} failed: {(out.stderr or out.stdout).strip()[:300]}")
    return out.stdout


def describe(config: dict[str, str]) -> str:
    onboot = config.get("onboot", "0") == "1"
    return f"starts on boot: {'yes' if onboot else 'no'}  (startup: {config.get('startup', '-')})"


def container_main(slug: str, text: str, on: bool, off: bool) -> int:
    """A vm-container trip: show, `start` (--on) or `stop` (--off), through the host's forced command."""
    client = _client()
    try:
        info = client.container_info(client.parse_topology_text(text), slug)
    except client.ClientConfigError as exc:
        print(f"refused: the topology does not describe {slug} ({exc})", file=sys.stderr)
        return 2
    try:
        container = container_adapter()
    except Refused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    errors = client.worker_module().TripContainerError

    def state() -> str:
        answer = container.check(info.trip_id, slug)
        if answer.get("running") is None:
            return f"{info.name}  the trip-container host has no container for it ({str(answer.get('reason') or '')[:100]})"
        return (f"{info.name}  running: {'yes' if answer.get('running') else 'no'}  "
                f"healthy: {'yes' if answer.get('healthy') else 'no'}  (restart policy unless-stopped: it comes back after a "
                "reboot unless it was stopped)")

    try:
        before = state()
        print(before)
        if "no container for it" in before:
            return 1
        if not (on or off):
            return 0
        if off:
            container.stop(info.trip_id, slug)
            print("  stopped now (an LXC's --off only changes the next boot); it stays down after a reboot until --on")
        else:
            container.start(info.trip_id, slug)
        after = state()
        print(after)
        return 0 if (f"running: {'yes' if on else 'no'}" in after) else 1
    except errors as exc:
        print(f"failed: {exc}", file=sys.stderr)
        return 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trip", required=True, help="the trip's slug — its directory under <deploy root>/trips")
    switch = ap.add_mutually_exclusive_group()
    switch.add_argument("--on", action="store_true", help="start on host boot (order 3)")
    switch.add_argument("--off", action="store_true", help="stay down after a host reboot")
    args = ap.parse_args(argv)

    if not SLUG.match(args.trip):
        print(f"refused: {args.trip!r} is not a slug", file=sys.stderr)
        return 2
    topology = DEPLOY_ROOT / "trips" / args.trip / "topology.yaml"
    if not topology.is_file():
        print(f"refused: no {topology}", file=sys.stderr)
        return 2
    text = topology.read_text()
    if _client().placement_of_text(text) == _client().PLACEMENT_VM_CONTAINER:
        return container_main(args.trip, text, args.on, args.off)
    vmid, name = parse_topology(text)
    load_provisioning_env()

    config = parse_pct_config(proxmox(f"pct config {shlex.quote(vmid)}"))
    if config.get("hostname") != name:
        print(f"refused: CT {vmid} is {config.get('hostname')!r}, not {name!r} — not this trip's container",
              file=sys.stderr)
        return 2
    print(f"CT {vmid} {name}  {describe(config)}")
    if not (args.on or args.off):
        return 0

    proxmox(set_command(vmid, on=args.on))
    config = parse_pct_config(proxmox(f"pct config {shlex.quote(vmid)}"))
    print(f"CT {vmid} {name}  now {describe(config)}")
    return 0 if (config.get("onboot", "0") == "1") == bool(args.on) else 1


if __name__ == "__main__":
    raise SystemExit(main())
