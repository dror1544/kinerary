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
"""
from __future__ import annotations

import argparse
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
    vmid, name = parse_topology(topology.read_text())
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
