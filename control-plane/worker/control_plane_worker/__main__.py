"""Private operator CLI: read-only inventory and dry-run test cleanup."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re

from .cleanup import UnsafeCleanupError, load_test_resource_name_prefix, select_test_resources
from .inventory import ProxmoxHttpTransport, ProxmoxInventory


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"environment variable {name} is required")
    return value


def safe_failure_message(exc: BaseException) -> str:
    """Describe an unexpected failure without echoing driver text.

    Database drivers embed the connection string, password included, in both
    ``str(exc)`` and the traceback, so neither may reach stderr. The exception
    class and SQLSTATE are enough to act on and cannot carry a credential.
    """
    sqlstate = getattr(exc, "sqlstate", None)
    if isinstance(sqlstate, str) and re.fullmatch(r"[0-9A-Z]{5}", sqlstate):
        return f"{type(exc).__name__} (sqlstate {sqlstate})"
    return f"{type(exc).__name__}: operation failed, details suppressed"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory = subparsers.add_parser("inventory", help="read Proxmox inventory without allocating resources")
    inventory.add_argument("--node", required=True)
    cleanup = subparsers.add_parser("cleanup", help="select labelled test resources; Sprint 0 is dry-run only")
    cleanup.add_argument("--inventory", required=True)
    cleanup.add_argument("--test-run-id", required=True)
    cleanup.add_argument(
        "--architecture-profile",
        default=os.environ.get("CONTROL_PLANE_ARCHITECTURE_PROFILE"),
    )
    cleanup.add_argument("--dry-run", action="store_true", required=True)
    worker = subparsers.add_parser("run", help="observe the private PostgreSQL queue")
    worker.add_argument("--database-url-file", default=os.environ.get("CONTROL_PLANE_DATABASE_URL_FILE"))
    worker.add_argument("--poll-seconds", type=float, default=10.0)
    provision = subparsers.add_parser("provision", help="run the provisioner worker loop")
    provision.add_argument("--database-url-file", default=os.environ.get("CONTROL_PLANE_DATABASE_URL_FILE"))
    provision.add_argument("--deploy-root", default=os.environ.get("PROVISIONER_DEPLOY_ROOT"),
                           help="path to kinerary-deploy directory (PROVISIONER_DEPLOY_ROOT)")
    provision.add_argument("--repo-root", default=os.environ.get("REPO_ROOT"),
                           help="path to kinerary repo (REPO_ROOT / PROVISIONER_REPO_ROOT)")
    provision.add_argument("--vmid-map", default=os.environ.get("PROVISIONER_VMID_MAP"),
                           help='JSON dict of slug→vmid e.g. {"japan-2025":"201"} (PROVISIONER_VMID_MAP)')
    provision.add_argument("--poll-seconds", type=float, default=10.0)
    check = subparsers.add_parser("check-database", help="verify the private worker database connection")
    check.add_argument("--database-url-file", default=os.environ.get("CONTROL_PLANE_DATABASE_URL_FILE"))
    args = parser.parse_args(argv)
    try:
        if args.command in {"run", "check-database", "provision"} and not args.database_url_file:
            raise ValueError("--database-url-file or CONTROL_PLANE_DATABASE_URL_FILE is required")
        if args.command == "provision":
            if not args.deploy_root:
                raise ValueError("--deploy-root or PROVISIONER_DEPLOY_ROOT is required")
            if not args.vmid_map:
                raise ValueError("--vmid-map or PROVISIONER_VMID_MAP is required")
            vmid_map = json.loads(args.vmid_map)
            if not isinstance(vmid_map, dict):
                raise ValueError("--vmid-map must be a JSON object of slug→vmid")
            from .provisioner import ProvisionerWorker, ShellDeployAdapter
            from .runtime import read_secret_file
            db_url = read_secret_file(args.database_url_file)
            deploy_adapter = ShellDeployAdapter(
                deploy_root=args.deploy_root,
                vmid_map=vmid_map,
                repo_root=args.repo_root,
            )
            worker_obj = ProvisionerWorker(db_url=db_url, deploy=deploy_adapter)
            import signal, time as _time
            stopping = False
            def _stop(_sig: int, _frame: object) -> None:
                nonlocal stopping
                stopping = True
            signal.signal(signal.SIGTERM, _stop)
            signal.signal(signal.SIGINT, _stop)
            while not stopping:
                try:
                    found = worker_obj.run_once()
                    if not found:
                        end = _time.monotonic() + args.poll_seconds
                        while not stopping and _time.monotonic() < end:
                            _time.sleep(min(0.25, max(0, end - _time.monotonic())))
                except Exception as exc:
                    print(json.dumps({"event": "provisioner.error", "error": safe_failure_message(exc)}), flush=True)
            return 0
        if args.command == "run":
            from .runtime import run
            return run(args.database_url_file, args.poll_seconds)
        if args.command == "check-database":
            from .runtime import database_status, read_secret_file
            print(json.dumps(database_status(read_secret_file(args.database_url_file)), sort_keys=True))
            return 0
        if args.command == "inventory":
            authorization = "PVEAPIToken=" + _required_env("PROXMOX_TOKEN_ID") + "=" + _required_env("PROXMOX_TOKEN_SECRET")
            transport = ProxmoxHttpTransport(
                _required_env("PROXMOX_URL"), authorization, os.environ.get("PROXMOX_CA_BUNDLE")
            )
            print(json.dumps(ProxmoxInventory(transport, args.node).inspect(), indent=2, sort_keys=True))
            return 0
        if not args.architecture_profile:
            raise ValueError("--architecture-profile or CONTROL_PLANE_ARCHITECTURE_PROFILE is required")
        resources = json.loads(Path(args.inventory).read_text(encoding="utf-8"))
        allowed_name_prefix = load_test_resource_name_prefix(args.architecture_profile)
        selected = select_test_resources(resources, args.test_run_id, allowed_name_prefix)
        print(json.dumps({"dry_run": True, "test_run_id": args.test_run_id, "selected": selected}, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, UnsafeCleanupError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    except Exception as exc:  # psycopg and any other driver land here
        parser.error(safe_failure_message(exc))


if __name__ == "__main__":
    raise SystemExit(main())
