"""Command line entrypoint: plan/apply/verify; apply is dry-run by default."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import yaml

from .adapters import CloudflareTunnelDnsAdapter, NpmProxyHostAdapter, ProxmoxLxcAdapter, SubprocessSshTransport
from .engine import Provisioner
from .models import ProvisioningError, Topology, load_topology
from .runtime import HttpJsonTransport


def load_topology_file(path: str) -> Topology:
    try:
        with Path(path).open(encoding="utf-8") as handle:
            raw = yaml.safe_load(handle)
    except (OSError, yaml.YAMLError) as exc:
        raise ProvisioningError(f"cannot read topology: {exc}") from exc
    return load_topology(raw)


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ProvisioningError(f"environment variable {name} is required")
    return value


def build_provisioner(topology: Topology) -> Provisioner:
    npm = HttpJsonTransport(_required_env("NPM_URL"), {
        "Authorization": "Bearer " + _required_env("NPM_API_TOKEN"),
    })
    cloudflare = HttpJsonTransport("https://api.cloudflare.com", {
        "Authorization": "Bearer " + _required_env("CLOUDFLARE_API_TOKEN"),
    })
    # Proxmox itself and the RPi4 that runs cloudflared — confirmed live
    # (2026-08-25) at these defaults; override via env if either box ever
    # changes. No Proxmox API token: pct create/list/destroy over the same
    # SSH key kinerary-deploy's scripts already use for pct exec/pct config.
    proxmox_ssh = SubprocessSshTransport(
        host=os.environ.get("PROXMOX_HOST", "192.168.0.40"),
        user=os.environ.get("PROXMOX_SSH_USER", "root"),
        identity_file=os.path.expanduser(os.environ.get("PROXMOX_SSH_KEY", "~/.ssh/id_ed25519_proxmox_hermes")),
    )
    rpi_ssh = SubprocessSshTransport(
        host=os.environ.get("RPI_HOST", "192.168.0.41"),
        user=os.environ.get("RPI_SSH_USER", "dror"),
        identity_file=os.path.expanduser(os.environ.get("RPI_SSH_KEY", "~/.ssh/id_ed25519_rpi4_hermes")),
    )
    return Provisioner(
        ProxmoxLxcAdapter(proxmox_ssh),
        NpmProxyHostAdapter(npm),
        CloudflareTunnelDnsAdapter(cloudflare, _required_env("CLOUDFLARE_ACCOUNT_ID"), _required_env("CLOUDFLARE_ZONE_ID"), rpi_ssh),
    )


def _write_snapshot(snapshot: dict[str, Any], path: str | None) -> None:
    rendered = json.dumps(snapshot, indent=2, sort_keys=True)
    if path:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered + "\n", encoding="utf-8")
        print(f"rollback snapshot written: {destination}")
    print(rendered)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "apply", "verify"))
    parser.add_argument("--topology", required=True, help="path to validated topology YAML")
    parser.add_argument("--execute", action="store_true", help="allow apply to make API writes")
    parser.add_argument("--snapshot", help="write the secret-free rollback journal to this JSON path")
    args = parser.parse_args(argv)
    if args.execute and args.command != "apply":
        parser.error("--execute is only valid with apply")
    try:
        topology = load_topology_file(args.topology)
        provisioner = build_provisioner(topology)
        if args.command == "verify":
            states = {
                "proxmox_lxc": provisioner.proxmox.inspect(topology.lxc) is not None,
                "npm_proxy_host": provisioner.npm.inspect(topology.proxy) is not None,
                "cloudflare_tunnel": provisioner.cloudflare.inspect(topology.cloudflare) is not None,
            }
            print(json.dumps({"topology": topology.name, "verified": states}, indent=2, sort_keys=True))
            return 0 if all(states.values()) else 2
        snapshot = provisioner.plan(topology) if args.command == "plan" else provisioner.apply(topology, execute=args.execute)
        if args.command == "apply" and not args.execute:
            print("DRY-RUN: no infrastructure changes were made. Re-run with apply --execute after review.")
        _write_snapshot(snapshot.to_dict(), args.snapshot)
        return 0
    except ProvisioningError as exc:
        parser.error(str(exc))
    except RuntimeError as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
