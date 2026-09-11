#!/usr/bin/env python3
"""Tear a provisioned TEST trip all the way down — the inverse of provisioning.

Nothing did this before 2026-09-11. `e2e-full-cycle.py` called teardown "not
yet automated", so the first one was done by hand (italy-2026, japan-2026) and
found a step that quietly undoes itself. This is that run's order, as a command:

  1. backup     profile tarball, launchd plist, interviewer config, DB rows
  2. allowlist  drop the profile from the interviewer's multiplex allowlist and
                restart the interviewer — BEFORE the profile is deleted. The
                interviewer runs a cron ticker for every allowlisted profile,
                and on 2026-09-11 that ticker recreated profiles/japan2026/
                minutes after `hermes profile delete`. An empty directory is
                enough to break the next trip of that name:
                companion-install-host.sh only tests that the directory exists,
                reports ALREADY_PRESENT, and skips rendering the companion.
  3. gateway    hermes gateway uninstall (+ launchctl bootout if launchd lags)
  4. bridge     stop this trip's trip-mcp, by its pid file, after checking the
                pid really is the listener on this trip's port
  5. infra      Cloudflare DNS + ingress rule, NPM host, LXC — through the
                worker's own provisioner (LxcProvisionAdapter), outside-in, so
                auth and adapters are exactly provisioning's
  6. database   close chat bindings (closed_reason 'trip_destroyed'), then
                slug -> retired-<slug>-<yyyymmdd>, which frees the slug
  7. deploy dir move kinerary-deploy/trips/<slug> out of trips/ — the IP
                allocator claims every address it finds in there
  8. profile    hermes profile delete, then check it stays gone

    scripts/teardown-trip.py --trip italy-2026                      # the plan
    scripts/teardown-trip.py --trip trip_1e35d697ca... --execute    # do it

REFUSES a trip past ready_private (activation_approved, active, completed,
sealed) — real people have used those — and a profile that another trip's open
chat binding still points at. There is no --force. NFS data is left where it
is: the next first-provision of the same slug wipes it, and until then it is
the only copy of whatever the trip held.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HOME = Path.home()
DEPLOY_ROOT = HOME / "kinerary-deploy"
PROFILES = HOME / ".hermes/profiles"
INTERVIEWER_CONFIG = PROFILES / "trip-intake/config.yaml"
LAUNCH_AGENTS = HOME / "Library/LaunchAgents"
PG = "kinerary-control-plane-local-postgres-1"

TRIP_ID = re.compile(r"^trip_[A-Za-z0-9]{8,64}$")
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
# Past ready_private, a trip has been handed to real people. Tearing one of
# those down is a decision about a family's trip, not test housekeeping.
REFUSED_STATES = {"activation_approved", "active", "completed", "sealed"}
# Profiles that are not a trip's companion at all.
PROTECTED_PROFILES = {"trip-intake", "elulhome", "familytrip", "kinerary-extract", "kinerarytest", "default"}

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


class Refused(Exception):
    """The trip, or something about it, must not be torn down by this tool."""


def reexec_with_yaml() -> None:
    """The infra step imports the worker's provisioner, which needs PyYAML.
    macOS's python3 does not have it; the Hermes venv does."""
    try:
        import yaml  # noqa: F401
        return
    except ImportError:
        pass
    for candidate in (
        os.environ.get("KINERARY_PYTHON", ""),
        str(HOME / ".cache/kinerary-preflight/venv/bin/python"),
        str(HOME / ".hermes/hermes-agent/venv/bin/python"),
    ):
        if candidate and Path(candidate).is_file() and candidate != sys.executable:
            probe = subprocess.run([candidate, "-c", "import yaml"], capture_output=True)
            if probe.returncode == 0:
                os.execv(candidate, [candidate, *sys.argv])
    sys.exit("teardown-trip: no python with PyYAML found (set KINERARY_PYTHON)")


def say(mark: str, msg: str) -> None:
    print(f"  {mark} {msg}")


def psql(sql: str) -> str:
    out = subprocess.run(
        ["docker", "exec", "-i", PG, "psql", "-U", "kinerary_control_plane", "-d", "kinerary_control_plane",
         "-v", "ON_ERROR_STOP=1", "-At"],
        input=sql, capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()[:300]}")
    return out.stdout.strip()


def hermes() -> str:
    local = HOME / ".local/bin/hermes"
    return str(local) if local.exists() else "hermes"


def original_slug(slug: str) -> str:
    """A retired trip still names its old resources by its old slug."""
    if not slug.startswith("retired-"):
        return slug
    return re.sub(r"-\d{8}(-\d+)?$", "", slug[len("retired-"):])


def load_provisioning_env() -> None:
    """The same `set -a; . provisioning.env` the worker's compose up relies on."""
    env_file = DEPLOY_ROOT / "provisioning.env"
    for line in env_file.read_text().splitlines():
        m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip().strip('"').strip("'"))


# ── what is there ────────────────────────────────────────────────────────────

def resolve(target: str) -> dict:
    if TRIP_ID.match(target):
        where = f"id = '{target}'"
    elif SLUG.match(target):
        where = f"slug = '{target}'"
    else:
        raise Refused(f"{target!r} is neither a trip id nor a slug")
    raw = psql(f"SELECT row_to_json(t) FROM (SELECT id, slug, lifecycle_state FROM control_plane.trips WHERE {where}) t")
    if not raw:
        raise Refused(f"no trip {target!r} in the control plane")
    trip = json.loads(raw)
    if trip["lifecycle_state"] in REFUSED_STATES:
        raise Refused(f"{trip['slug']} is {trip['lifecycle_state']} — real people have used it; not a teardown target")

    trip["orig"] = original_slug(trip["slug"])
    bound = psql(
        f"SELECT hermes_profile FROM control_plane.telegram_chat_bindings WHERE trip_id = '{trip['id']}' "
        "AND hermes_profile IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    trip["profile"] = bound or "".join(ch for ch in trip["orig"] if ch.isalnum())
    # The same rule companion-install-host.sh applies: this name becomes a path
    # under ~/.hermes/profiles and goes into SQL below.
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", trip["profile"]):
        raise Refused(f"unsafe profile name {trip['profile']!r}")
    if trip["profile"] in PROTECTED_PROFILES:
        raise Refused(f"profile {trip['profile']!r} is not a trip companion")
    shared = psql(
        f"SELECT count(*) FROM control_plane.telegram_chat_bindings WHERE hermes_profile = '{trip['profile']}' "
        f"AND trip_id <> '{trip['id']}' AND closed_at IS NULL")
    if shared and int(shared) > 0:
        raise Refused(f"profile {trip['profile']!r} is still bound to another trip's open chat")
    trip["open_bindings"] = int(psql(
        f"SELECT count(*) FROM control_plane.telegram_chat_bindings WHERE trip_id = '{trip['id']}' AND closed_at IS NULL") or 0)
    return trip


def interviewer_allows(profile: str) -> bool:
    if not INTERVIEWER_CONFIG.is_file():
        return False
    import yaml
    cfg = yaml.safe_load(INTERVIEWER_CONFIG.read_text()) or {}
    allow = (cfg.get("gateway") or {}).get("multiplex_profile_allowlist")
    return isinstance(allow, list) and profile in allow


def gateway_loaded(profile: str) -> bool:
    out = subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout
    return f"ai.hermes.gateway-{profile}" in out


def bridge(trip_dir: Path) -> tuple[str, str] | None:
    pid_file, env_file = trip_dir / "mcp/trip-mcp.pid", trip_dir / "mcp/.env"
    if not pid_file.is_file():
        return None
    port = next((l.split("=", 1)[1].strip() for l in env_file.read_text().splitlines()
                 if l.startswith("MCP_PORT=")), "") if env_file.is_file() else ""
    return pid_file.read_text().strip(), port


def build_provisioner():
    sys.path[:0] = [str(REPO / "control-plane/worker"), str(REPO)]
    from control_plane_worker.compute import LxcProvisionAdapter
    load_provisioning_env()
    e = os.environ.get
    adapter = LxcProvisionAdapter(
        deploy_root=str(DEPLOY_ROOT),  # the HOST path; provisioning.env's is the container's
        node=e("PROXMOX_NODE", ""), template=e("PROXMOX_LXC_TEMPLATE", ""), storage=e("PROXMOX_STORAGE", ""),
        bridge=e("PROXMOX_BRIDGE", ""), ip_pool=json.loads(e("PROVISIONER_LXC_IP_POOL", '["192.168.0.60"]')),
        hostname_domain=e("PROVISIONER_LXC_HOSTNAME_DOMAIN", ""), tunnel_id=e("PROVISIONER_LXC_TUNNEL_ID", ""),
        npm_url=e("NPM_URL", ""), npm_api_token=e("NPM_API_TOKEN", ""),
        npm_identity=e("NPM_IDENTITY", ""), npm_secret=e("NPM_SECRET", ""),
        cloudflare_zone_id=e("CLOUDFLARE_ZONE_ID", ""), cloudflare_api_token=e("CLOUDFLARE_API_TOKEN", ""),
        proxmox_host=e("PROXMOX_HOST", "192.168.0.40"), proxmox_ssh_user=e("PROXMOX_SSH_USER", "root"),
        proxmox_ssh_key=os.path.expanduser("~/.ssh/id_ed25519_proxmox_hermes"),
        rpi_host=e("RPI_HOST", "192.168.0.41"), rpi_ssh_user=e("RPI_SSH_USER", "dror"),
        rpi_ssh_key=os.path.expanduser("~/.ssh/id_ed25519_rpi4_hermes"),
    )
    return adapter._build_provisioner()


def infra_state(prov, topo) -> dict:
    dns = [r for r in prov.cloudflare._dns_records(topo.cloudflare) if r.get("name") == topo.cloudflare.hostname]
    return {
        "lxc": prov.proxmox.inspect(topo.lxc),
        "npm": prov.npm.inspect(topo.proxy),
        "dns": dns,
        "ingress": prov.cloudflare._ingress_rule_present(topo.cloudflare),
    }


# ── the steps ────────────────────────────────────────────────────────────────

def narrow_allowlist(profile: str) -> None:
    """Remove one entry, keeping the key: a MISSING key means serve-all
    (gateway/config.py), `[]` means default only. Line-level, so the rest of a
    file Hermes itself also writes is left byte for byte."""
    import yaml
    text = INTERVIEWER_CONFIG.read_text()
    before = yaml.safe_load(text) or {}
    lines = text.splitlines(keepends=True)
    out, i = [], 0
    while i < len(lines):
        m = re.match(r"^(\s*)multiplex_profile_allowlist:\s*(.*)$", lines[i].rstrip("\n"))
        if not m:
            out.append(lines[i]); i += 1; continue
        indent, inline = m.group(1), m.group(2).strip()
        if inline:
            entries = [x for x in (yaml.safe_load(inline) or []) if x != profile]
            out.append(f"{indent}multiplex_profile_allowlist: {json.dumps(entries) if entries else '[]'}\n")
            i += 1; continue
        i += 1
        kept = []
        while i < len(lines) and re.match(rf"^{indent}\s+-\s", lines[i]):
            if lines[i].split("-", 1)[1].strip().strip("'\"") != profile:
                kept.append(lines[i])
            i += 1
        out.append(f"{indent}multiplex_profile_allowlist:\n" if kept else f"{indent}multiplex_profile_allowlist: []\n")
        out.extend(kept)
    new_text = "".join(out)
    after = yaml.safe_load(new_text) or {}
    # Prove only that one list changed before writing anything.
    expected = json.loads(json.dumps(before))
    allow = expected.setdefault("gateway", {}).get("multiplex_profile_allowlist") or []
    expected["gateway"]["multiplex_profile_allowlist"] = [x for x in allow if x != profile]
    if json.dumps(after, sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise RuntimeError("allowlist edit would change more than the one entry — left untouched")
    INTERVIEWER_CONFIG.write_text(new_text)
    subprocess.run([hermes(), "--profile", "trip-intake", "gateway", "restart"], capture_output=True, text=True)


def backup(trip: dict, trip_dir: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    os.chmod(dest, 0o700)
    home = PROFILES / trip["profile"]
    if home.is_dir():
        # Sockets cannot be archived and are runtime-only; skip them quietly.
        def regular(ti: tarfile.TarInfo) -> tarfile.TarInfo | None:
            return ti if (ti.isfile() or ti.isdir() or ti.issym()) else None
        with tarfile.open(dest / f"{trip['profile']}.tar.gz", "w:gz") as tar:
            tar.add(home, arcname=trip["profile"], filter=regular)
    plist = LAUNCH_AGENTS / f"ai.hermes.gateway-{trip['profile']}.plist"
    if plist.is_file():
        shutil.copy2(plist, dest / plist.name)
    if INTERVIEWER_CONFIG.is_file():
        shutil.copy2(INTERVIEWER_CONFIG, dest / "trip-intake-config.yaml")
    for table in ("trips", "telegram_chat_bindings"):
        key = "id" if table == "trips" else "trip_id"
        rows = psql(f"SELECT row_to_json(r) FROM control_plane.{table} r WHERE {key} = '{trip['id']}'")
        (dest / f"db-{table}.jsonl").write_text(rows + "\n" if rows else "")
    for f in dest.iterdir():
        os.chmod(f, 0o600)


def retire_in_db(trip: dict) -> str:
    if trip["slug"].startswith("retired-"):
        psql(f"UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'trip_destroyed' "
             f"WHERE trip_id = '{trip['id']}' AND closed_at IS NULL")
        return trip["slug"]
    base = f"retired-{trip['orig']}-{datetime.now():%Y%m%d}"
    new = base
    for n in range(2, 20):
        if psql(f"SELECT count(*) FROM control_plane.trips WHERE slug = '{new}'") == "0":
            break
        new = f"{base}-{n}"
    psql(f"""BEGIN;
UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'trip_destroyed'
 WHERE trip_id = '{trip['id']}' AND closed_at IS NULL;
UPDATE control_plane.trips SET slug = '{new}', updated_at = now()
 WHERE id = '{trip['id']}' AND slug = '{trip['slug']}';
COMMIT;""")
    return new


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trip", required=True, help="trip id (trip_...) or slug")
    ap.add_argument("--execute", action="store_true", help="actually tear down (default: print the plan)")
    ap.add_argument("--settle-seconds", type=int, default=70,
                    help="how long to watch for the profile directory coming back (one cron tick)")
    args = ap.parse_args()
    reexec_with_yaml()

    try:
        trip = resolve(args.trip)
    except Refused as exc:
        print(f"{RED}refused{RESET}: {exc}")
        return 2

    profile, orig = trip["profile"], trip["orig"]
    trip_dir = DEPLOY_ROOT / "trips" / orig
    topology_path = trip_dir / "topology.yaml"
    mode = "EXECUTE" if args.execute else "dry run"
    print(f"\n{trip['id']}  {trip['slug']}  ({trip['lifecycle_state']})  profile={profile}  [{mode}]\n")

    topo = prov = None
    topo_vmid = ""
    if topology_path.is_file():
        import yaml
        prov = build_provisioner()  # also puts the repo's packages on sys.path
        from provisioning.models import load_topology
        raw = yaml.safe_load(topology_path.read_text())
        topo = load_topology(raw)
        if topo.lxc.name != f"trip-{orig}" or not topo.proxy.hostname.startswith(f"{orig}."):
            print(f"{RED}refused{RESET}: {topology_path} does not describe {orig} ({topo.lxc.name}, {topo.proxy.hostname})")
            return 2
        topo_vmid = str((raw.get("proxmox") or {}).get("vmid") or "")

    b = bridge(trip_dir)
    plan = [
        ("allowlist", interviewer_allows(profile), f"drop {profile} from the interviewer's allowlist, restart it"),
        ("gateway", gateway_loaded(profile) or (LAUNCH_AGENTS / f"ai.hermes.gateway-{profile}.plist").exists(),
         f"uninstall ai.hermes.gateway-{profile}"),
        ("bridge", b is not None, f"stop trip-mcp pid {b[0]} on :{b[1]}" if b else "no bridge"),
        ("infra", topo is not None, f"Cloudflare + NPM + LXC for {orig}" if topo else "never provisioned"),
        ("database", trip["open_bindings"] > 0 or not trip["slug"].startswith("retired-"),
         f"close {trip['open_bindings']} binding(s), retire slug {trip['slug']}"),
        ("deploy dir", trip_dir.is_dir(), f"move {trip_dir} to retired-trips/"),
        ("profile", (PROFILES / profile).is_dir(), f"hermes profile delete {profile}"),
    ]
    state = infra_state(prov, topo) if topo else None
    for name, needed, what in plan:
        say(f"{YELLOW}→{RESET}" if needed else f"{DIM}·{RESET}", f"{name:<10} {what if needed else '(nothing to do)'}")
    if state:
        say(DIM + "·" + RESET, f"infra now: lxc={state['lxc']} npm={bool(state['npm'])} dns={len(state['dns'])} "
            f"ingress={state['ingress']}")
        if state["lxc"] and topo_vmid and str(state["lxc"].get("vmid")) != topo_vmid:
            print(f"{RED}refused{RESET}: live vmid {state['lxc'].get('vmid')} is not topology's {topo_vmid}")
            return 2
        if state["npm"] and state["npm"].get("forward_host") != topo.proxy.forward_host:
            print(f"{RED}refused{RESET}: NPM forwards {topo.proxy.hostname} to {state['npm'].get('forward_host')}, "
                  f"not {topo.proxy.forward_host} — someone else's host")
            return 2
    if not args.execute:
        print(f"\n{DIM}dry run — re-run with --execute to do this{RESET}")
        return 0

    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    dest = DEPLOY_ROOT / "profile-backups" / f"teardown-{orig}-{stamp}"
    print()
    backup(trip, trip_dir, dest)
    say(f"{GREEN}✓{RESET}", f"backup     {dest}")

    if interviewer_allows(profile):
        narrow_allowlist(profile)
        say(f"{GREEN}✓{RESET}", "allowlist  narrowed, interviewer restarted")

    if gateway_loaded(profile) or (LAUNCH_AGENTS / f"ai.hermes.gateway-{profile}.plist").exists():
        subprocess.run([hermes(), "-p", profile, "gateway", "uninstall"], capture_output=True, text=True)
        for _ in range(20):
            if not gateway_loaded(profile):
                break
            time.sleep(1)
        if gateway_loaded(profile):  # the uninstall's own bootout can lag
            subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/ai.hermes.gateway-{profile}"],
                           capture_output=True)
            time.sleep(3)
        say(f"{GREEN}✓{RESET}" if not gateway_loaded(profile) else f"{RED}✗{RESET}", "gateway    uninstalled")

    if b:
        pid, port = b
        listener = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                                  capture_output=True, text=True).stdout.split()
        cmd = subprocess.run(["ps", "-o", "command=", "-p", pid], capture_output=True, text=True).stdout
        if pid in listener and "mcp.js" in cmd:
            subprocess.run(["kill", pid])
            say(f"{GREEN}✓{RESET}", f"bridge     stopped pid {pid} (:{port})")
        else:
            say(f"{DIM}·{RESET}", f"bridge     pid {pid} is not the listener on :{port} — left alone")

    failed = False
    if topo:
        prov.cloudflare.delete(topo.cloudflare)
        prov.npm.delete(topo.proxy)
        prov.proxmox.delete(topo.lxc)
        after = infra_state(prov, topo)
        gone = not after["lxc"] and not after["npm"] and not after["dns"] and not after["ingress"]
        say(f"{GREEN}✓{RESET}" if gone else f"{RED}✗{RESET}", f"infra      {'all gone' if gone else after}")
        failed |= not gone

    new_slug = retire_in_db(trip)
    say(f"{GREEN}✓{RESET}", f"database   bindings closed, slug -> {new_slug}")

    if trip_dir.is_dir():
        retired = DEPLOY_ROOT / "retired-trips"
        retired.mkdir(exist_ok=True)
        trip_dir.rename(retired / f"{orig}-{stamp}")
        say(f"{GREEN}✓{RESET}", f"deploy dir {retired / f'{orig}-{stamp}'}")

    home = PROFILES / profile
    if home.is_dir():
        subprocess.run([hermes(), "profile", "delete", "-y", profile], capture_output=True, text=True)
        if args.settle_seconds > 0:
            print(f"    {DIM}watching {args.settle_seconds}s for the profile coming back…{RESET}")
            time.sleep(args.settle_seconds)
        if home.is_dir():
            failed = True
            say(f"{RED}✗{RESET}", f"profile    {home} CAME BACK — something still ticks it; nothing removed it again")
        else:
            say(f"{GREEN}✓{RESET}", "profile    deleted, and stayed gone")

    print(f"\n{RED}✗ something remains{RESET}" if failed else f"\n{GREEN}✓ {orig} torn down{RESET}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
