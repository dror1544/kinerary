"""Private operator CLI: read-only inventory and dry-run test cleanup."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .cleanup import UnsafeCleanupError, select_test_resources
from .inventory import ProxmoxHttpTransport, ProxmoxInventory


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"environment variable {name} is required")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory = subparsers.add_parser("inventory", help="read Proxmox inventory without allocating resources")
    inventory.add_argument("--node", required=True)
    cleanup = subparsers.add_parser("cleanup", help="select labelled test resources; Sprint 0 is dry-run only")
    cleanup.add_argument("--inventory", required=True)
    cleanup.add_argument("--test-run-id", required=True)
    cleanup.add_argument("--dry-run", action="store_true", required=True)
    worker = subparsers.add_parser("run", help="observe the private PostgreSQL queue")
    worker.add_argument("--database-url-file", default=os.environ.get("CONTROL_PLANE_DATABASE_URL_FILE"))
    worker.add_argument("--poll-seconds", type=float, default=10.0)
    check = subparsers.add_parser("check-database", help="verify the private worker database connection")
    check.add_argument("--database-url-file", default=os.environ.get("CONTROL_PLANE_DATABASE_URL_FILE"))
    args = parser.parse_args(argv)
    try:
        if args.command in {"run", "check-database"} and not args.database_url_file:
            raise ValueError("--database-url-file or CONTROL_PLANE_DATABASE_URL_FILE is required")
        if args.command == "run":
            from .runtime import run
            return run(args.database_url_file, args.poll_seconds)
        if args.command == "check-database":
            from .runtime import database_status, read_secret_file
            print(json.dumps(database_status(read_secret_file(args.database_url_file)), sort_keys=True))
            return 0
        if args.command == "inventory":
            authorization = "PVEAPIToken=" + _required_env("PROXMOX_TOKEN_ID") + "=" + _required_env("PROXMOX_TOKEN_SECRET")
            transport = ProxmoxHttpTransport(_required_env("PROXMOX_URL"), authorization)
            print(json.dumps(ProxmoxInventory(transport, args.node).inspect(), indent=2, sort_keys=True))
            return 0
        resources = json.loads(Path(args.inventory).read_text(encoding="utf-8"))
        selected = select_test_resources(resources, args.test_run_id)
        print(json.dumps({"dry_run": True, "test_run_id": args.test_run_id, "selected": selected}, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, UnsafeCleanupError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
