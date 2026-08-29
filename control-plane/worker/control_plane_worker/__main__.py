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
    provision.add_argument("--companion-templates-dir", default=os.environ.get("PROVISIONER_COMPANION_TEMPLATES_DIR"),
                           help="path to profile-templates/familytrip-companion — omit to skip companion-profile "
                                "creation entirely (PROVISIONER_COMPANION_TEMPLATES_DIR)")
    provision.add_argument("--enable-mcp-bridge", action="store_true",
                           default=os.environ.get("PROVISIONER_MCP_BRIDGE_ENABLED") == "1",
                           help="wire each new companion profile to its trip-mcp bridge via setup-mcp.sh — a real "
                                "SSH/Proxmox/hermes-CLI action, requires --companion-templates-dir "
                                "(PROVISIONER_MCP_BRIDGE_ENABLED=1)")
    provision.add_argument("--enable-compute", action="store_true",
                           default=os.environ.get("PROVISIONER_COMPUTE_ENABLED") == "1",
                           help="create a fresh LXC (+ NPM proxy host + Cloudflare tunnel DNS) for any slug missing "
                                "from --vmid-map — pct over SSH into Proxmox, real NPM/Cloudflare API calls — "
                                "requires PROXMOX_NODE/PROXMOX_LXC_TEMPLATE/PROXMOX_STORAGE/PROXMOX_BRIDGE, "
                                "NPM_URL/NPM_API_TOKEN, "
                                "CLOUDFLARE_ZONE_ID/CLOUDFLARE_API_TOKEN, and "
                                "PROVISIONER_LXC_IP_POOL/PROVISIONER_LXC_HOSTNAME_DOMAIN/PROVISIONER_LXC_TUNNEL_ID "
                                "(PROVISIONER_COMPUTE_ENABLED=1)")
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
            from .companion_profile import NullCompanionProfileAdapter, RenderProfileAdapter
            from .compute import LxcProvisionAdapter, NullComputeAdapter
            from .mcp_bridge import NullMcpBridgeAdapter, ShellMcpBridgeAdapter
            from .provisioner import ProvisionerWorker, ShellDeployAdapter
            from .runtime import read_secret_file
            db_url = read_secret_file(args.database_url_file)
            # Off by default: an unconfigured deployment keeps the pre-Phase-G
            # behavior exactly (a slug missing from --vmid-map fails loudly
            # instead of a real LXC/NPM/Cloudflare create happening).
            if args.enable_compute:
                ip_pool = json.loads(_required_env("PROVISIONER_LXC_IP_POOL"))
                if not isinstance(ip_pool, list) or not ip_pool:
                    raise ValueError("PROVISIONER_LXC_IP_POOL must be a non-empty JSON array of IPv4 addresses")
                compute_adapter = LxcProvisionAdapter(
                    deploy_root=args.deploy_root,
                    node=_required_env("PROXMOX_NODE"),
                    template=_required_env("PROXMOX_LXC_TEMPLATE"),
                    storage=_required_env("PROXMOX_STORAGE"),
                    bridge=_required_env("PROXMOX_BRIDGE"),
                    ip_pool=ip_pool,
                    hostname_domain=_required_env("PROVISIONER_LXC_HOSTNAME_DOMAIN"),
                    tunnel_id=_required_env("PROVISIONER_LXC_TUNNEL_ID"),
                    npm_url=_required_env("NPM_URL"),
                    npm_api_token=_required_env("NPM_API_TOKEN"),
                    cloudflare_zone_id=_required_env("CLOUDFLARE_ZONE_ID"),
                    cloudflare_api_token=_required_env("CLOUDFLARE_API_TOKEN"),
                    # Proxmox itself and the RPi4 that runs cloudflared —
                    # confirmed live (2026-08-25) at these defaults; override
                    # via env only if either box ever changes. No Proxmox API
                    # token: pct over the same SSH key kinerary-deploy's
                    # scripts already use for pct exec/pct config.
                    proxmox_host=os.environ.get("PROXMOX_HOST", "192.168.0.40"),
                    proxmox_ssh_user=os.environ.get("PROXMOX_SSH_USER", "root"),
                    proxmox_ssh_key=os.environ.get("PROXMOX_SSH_KEY", "~/.ssh/id_ed25519_proxmox_hermes"),
                    rpi_host=os.environ.get("RPI_HOST", "192.168.0.41"),
                    rpi_ssh_user=os.environ.get("RPI_SSH_USER", "dror"),
                    rpi_ssh_key=os.environ.get("RPI_SSH_KEY", "~/.ssh/id_ed25519_rpi4_hermes"),
                    cloudflare_ingress_service=os.environ.get(
                        "PROVISIONER_CLOUDFLARE_INGRESS_SERVICE", "http://127.0.0.1:8080"
                    ),
                    gateway=os.environ.get("PROXMOX_GATEWAY", "192.168.0.1"),
                    nameserver=os.environ.get("PROXMOX_NAMESERVER", "192.168.0.41"),
                    # Shared onboarding password for a new site's participants.
                    # Unset keeps server.js's safe default (independent random
                    # per-user passwords) — but note that with Telegram SSO
                    # ruled out and Google unconfigured, unset currently means
                    # the provisioned site has no login path at all. A real
                    # member/organizer signup flow is the actual fix; this is a
                    # stopgap so a provisioned trip is reachable.
                    seed_password=os.environ.get("PROVISIONER_SEED_PASSWORD", ""),
                    nfs_host_base=os.environ.get("PROVISIONER_NFS_HOST_BASE", "/mnt/pve/truenas-nfs"),
                    nfs_mount_base=os.environ.get("PROVISIONER_NFS_MOUNT_BASE", "/nfs"),
                )
            else:
                compute_adapter = NullComputeAdapter()
            deploy_adapter = ShellDeployAdapter(
                deploy_root=args.deploy_root,
                vmid_map=vmid_map,
                repo_root=args.repo_root,
                compute=compute_adapter,
            )
            # Both default OFF: an unconfigured deployment gets exactly the
            # old behavior (deploy the site, skip the companion profile).
            # --enable-mcp-bridge additionally requires a templates dir,
            # since wiring trip-mcp for a profile that was never created
            # makes no sense.
            if args.companion_templates_dir:
                companion_adapter = RenderProfileAdapter(templates_dir=args.companion_templates_dir)
                mcp_bridge_adapter = (
                    ShellMcpBridgeAdapter(deploy_root=args.deploy_root, vmid_map=vmid_map)
                    if args.enable_mcp_bridge else NullMcpBridgeAdapter()
                )
            else:
                companion_adapter = NullCompanionProfileAdapter()
                mcp_bridge_adapter = NullMcpBridgeAdapter()
            from .enrichment import enrich_config
            import re as _re

            def _consular_lookup(destination: str, home_country: str):
                """Read-only view of control_plane.country_reference, populated
                by interview-mcp's lookup_consular_contacts. A miss (or any DB
                error) returns None and enrich_config just skips the contacts."""
                dest = _re.sub(r"\s+", " ", destination).strip().lower()
                home = _re.sub(r"\s+", " ", home_country).strip().lower()
                try:
                    import psycopg
                    with psycopg.connect(db_url) as conn:
                        with conn.cursor() as cur:
                            cur.execute(
                                "SELECT contacts FROM control_plane.country_reference "
                                "WHERE destination_country = %s AND home_country = %s",
                                (dest, home),
                            )
                            row = cur.fetchone()
                    if row and isinstance(row[0], list):
                        return row[0]
                except Exception:
                    return None
                return None

            def _enrich(config, destination):
                return enrich_config(config, destination, consular_lookup=_consular_lookup)

            worker_obj = ProvisionerWorker(
                db_url=db_url, deploy=deploy_adapter,
                companion=companion_adapter, mcp_bridge=mcp_bridge_adapter,
                # Live destination enrichment (currency/emergency/coords/hero,
                # plus consular contacts from the cross-trip reference store).
                # Always on in a real run: it self-guards and degrades to "no
                # enrichment", never a failure.
                enrich=_enrich,
            )
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
