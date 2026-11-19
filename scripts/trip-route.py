#!/usr/bin/env python3
"""Show, set or clear where the runtime gateway sends a trip's own hostname.

The gateway routes `https://<slug>.<trip domain>` by Host, from the trip's row in
`control_plane.runtime_routes` (`public_host`, `upstream_url`). The worker writes
both when it provisions a trip. This is the way to give that row to a trip that
was provisioned before the columns existed, so ONE test trip can be moved behind
the gateway before any live trip is - and to take it back.

    scripts/trip-route.py --trip <slug|trip_id>                    # show
    scripts/trip-route.py --trip <slug|trip_id> --set              # the plan
    scripts/trip-route.py --trip <slug|trip_id> --set --execute    # do it
    scripts/trip-route.py --trip <slug|trip_id> --clear --execute  # the hostname stops routing

`--set` takes the hostname and the site's address from the trip's own
`topology.yaml` under the deploy root, never from the command line: what the
gateway will proxy to is whatever that file says the container is. It refuses a
topology that does not give a usable address and port, and checks both against an
ASCII-only pattern first (the same patterns as `read_trip_wiring` in
companion-install-host.sh, for the same reason: `isdigit()` and `int()` accept
non-ASCII digits, and these values end up in SQL and in a URL a gateway fetches).

Nothing changes without --execute. Moving a trip that people use is a deploy
(CLAUDE.md hard rule 2): the plan prints the trip's lifecycle state, and the
approval is yours to have before --execute. A trip at `ready_private` or later,
or in a state this script does not know, is treated as in use (the same
allow-list as the feature-switch command, control-plane/api/src/feature-switches.ts):
--execute on it also needs --live, which says "I have approval to change a trip
in use". Every routed trip has finished provisioning, so in practice that is
every trip; the flag is there so the in-use case is never reached by accident.

This changes the route row and nothing else - not DNS, not the proxy host, not
the tunnel. Whether the hostname reaches the gateway at all is the operator's
wildcard record.

Where the deploy root is not the default (a root-only directory on a server, say),
name it:

    sudo KINERARY_DEPLOY_ROOT=<deploy root> python3 scripts/trip-route.py --trip <slug>
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
DEPLOY_ROOT = Path(os.environ.get("KINERARY_DEPLOY_ROOT") or HOME / "kinerary-deploy")
PG = f"{os.environ.get('KINERARY_COMPOSE_PROJECT', 'kinerary-control-plane-local')}-postgres-1"

TRIP_ID = re.compile(r"^trip_[A-Za-z0-9]{8,64}$")
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
# The patterns companion-install-host.sh's read_trip_wiring uses. [0-9] and [a-z]
# are ASCII only in a Python str pattern; fullmatch because `$` allows a trailing
# newline.
OCTET = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
IPV4 = re.compile(rf"{OCTET}(\.{OCTET}){{3}}(/[0-9]{{1,2}})?")
PORT = re.compile(r"[0-9]{1,5}")
# What runtime_routes.public_host accepts: a lower-case DNS name.
HOSTNAME = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+")

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


class Refused(Exception):
    """The request, or the trip's topology, cannot be vouched for."""


def reexec_with_yaml() -> None:
    """The topology is YAML; macOS's python3 has no PyYAML, the Hermes venv does."""
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
    sys.exit("trip-route: no python with PyYAML found (set KINERARY_PYTHON)")


def psql(sql: str) -> str:
    out = subprocess.run(
        ["docker", "exec", "-i", PG, "psql", "-U", "kinerary_control_plane", "-d", "kinerary_control_plane",
         "-v", "ON_ERROR_STOP=1", "-At"],
        input=sql, capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()[:300]}")
    return out.stdout.strip()


def have_host_columns() -> bool:
    return psql(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'control_plane' "
        "AND table_name = 'runtime_routes' AND column_name IN ('public_host', 'upstream_url')") == "2"


def resolve(target: str) -> dict:
    if TRIP_ID.match(target):
        where = f"t.id = '{target}'"
    elif SLUG.match(target):
        where = f"t.slug = '{target}'"
    else:
        raise Refused(f"{target!r} is neither a trip id nor a slug")
    raw = psql(
        "SELECT row_to_json(r) FROM (SELECT t.id, t.slug, t.lifecycle_state, "
        "(SELECT count(*) FROM control_plane.runtime_routes x WHERE x.trip_id = t.id) AS has_route "
        f"FROM control_plane.trips t WHERE {where}) r")
    if not raw:
        raise Refused(f"no trip {target!r} in the control plane")
    trip = json.loads(raw)
    trip["route"] = None
    if int(trip.pop("has_route")):
        raw = psql(
            "SELECT row_to_json(r) FROM (SELECT state, public_host, upstream_url "
            f"FROM control_plane.runtime_routes WHERE trip_id = '{trip['id']}') r")
        trip["route"] = json.loads(raw)
    return trip


def topology_route(slug: str, deploy_root: Path | None = None) -> tuple[str, str]:
    """(public_host, upstream_url) for this trip from its topology.yaml, or Refused.

    The address and port are checked against ASCII-only patterns before anything
    is built from them, and the topology must describe THIS trip (the same name
    check the companion host makes) - a file for another trip would route this
    hostname to somebody else's container."""
    import yaml

    path = (deploy_root or DEPLOY_ROOT) / "trips" / slug / "topology.yaml"
    if not path.is_file():
        raise Refused(f"no topology for {slug}: {path} does not exist")
    try:
        topo = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        raise Refused(f"{path} cannot be read as YAML") from None
    if not isinstance(topo, dict):
        raise Refused(f"{path} is not a topology")
    proxmox = topo.get("proxmox") if isinstance(topo.get("proxmox"), dict) else {}
    lxc = proxmox.get("lxc") if isinstance(proxmox.get("lxc"), dict) else {}
    npm = topo.get("npm") if isinstance(topo.get("npm"), dict) else {}
    if topo.get("name") != slug or lxc.get("name") != f"trip-{slug}"[:63]:
        raise Refused(f"{path} does not describe {slug}")

    hostname = str(lxc.get("public_hostname") or npm.get("hostname") or "")
    if not HOSTNAME.fullmatch(hostname):
        raise Refused(f"{slug}'s topology gives no usable public hostname (a lower-case DNS name)")
    ipv4 = str(lxc.get("ipv4") or "")
    # By presence, not truthiness: a forward_port of 0 under lxc is a wrong
    # value to refuse, not an absent one to quietly replace with npm's.
    port_value = lxc["forward_port"] if "forward_port" in lxc else npm.get("forward_port")
    port = "" if port_value is None else str(port_value)
    if not IPV4.fullmatch(ipv4) or not PORT.fullmatch(port) or not 1 <= int(port) <= 65535:
        raise Refused(f"{slug}'s topology lacks a usable container address and forward_port "
                      f"(an IPv4 address - not dhcp, not a name - and a port from 1 to 65535)")
    return hostname, f"http://{ipv4.split('/')[0]}:{int(port)}"


#: The lifecycle states strictly before `ready_private`: the only ones --execute may change without --live. An
#: allow-list, so a state added tomorrow needs --live until it is decided here (feature-switches.ts keeps the same
#: list; tests/scripts/test_trip_route.py pins the two together).
SAFE_WITHOUT_LIVE_TRIP_STATES = (
    "pending_signup_approval", "draft", "intake_in_progress", "intake_confirmed",
    "planned", "provisioning_approved", "provisioning",
)


def trip_needs_live(state: object) -> bool:
    return not (isinstance(state, str) and state in SAFE_WITHOUT_LIVE_TRIP_STATES)


def host_holder(host: str, trip_id: str) -> str | None:
    """Another trip that already holds this public_host, if any (it is unique)."""
    if not HOSTNAME.fullmatch(host):
        return None
    return psql(
        "SELECT t.slug FROM control_plane.runtime_routes r JOIN control_plane.trips t ON t.id = r.trip_id "
        f"WHERE r.public_host = '{host}' AND r.trip_id <> '{trip_id}'") or None


def describe(route: dict | None) -> str:
    if route is None:
        return "no runtime route row"
    return (f"state={route['state']}  public_host={route.get('public_host') or '-'}  "
            f"upstream_url={route.get('upstream_url') or '-'}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trip", required=True, help="trip id (trip_...) or slug")
    what = ap.add_mutually_exclusive_group()
    what.add_argument("--set", action="store_true", help="record the hostname and address from the trip's topology.yaml")
    what.add_argument("--clear", action="store_true", help="remove the hostname and upstream from the route")
    ap.add_argument("--execute", action="store_true", help="actually change the route (default: print the plan)")
    ap.add_argument("--live", action="store_true",
                    help="the trip is in use (ready_private or later) and you have approval to change it")
    args = ap.parse_args(argv)
    if args.execute and not (args.set or args.clear):
        ap.error("--execute needs --set or --clear")
    reexec_with_yaml()

    try:
        trip = resolve(args.trip)
        route = trip["route"]
        mode = "EXECUTE" if args.execute else ("dry run" if (args.set or args.clear) else "show")
        print(f"\n{trip['id']}  {trip['slug']}  ({trip['lifecycle_state']})  [{mode}]\n")
        columns = have_host_columns()
        say = lambda mark, msg: print(f"  {mark} {msg}")  # noqa: E731
        if not columns:
            say(f"{YELLOW}!{RESET}", "this database has no public_host/upstream_url columns "
                "(migration runtime_route_hosts is not applied)")
        say(f"{DIM}·{RESET}", f"route now:  {describe(route)}")

        wanted = None
        try:
            wanted = topology_route(trip["slug"])
            say(f"{DIM}·{RESET}", f"topology:   public_host={wanted[0]}  upstream_url={wanted[1]}")
            if route and columns:
                same = (route.get("public_host"), route.get("upstream_url")) == wanted
                say(f"{DIM}·{RESET}", "the route " + ("matches the topology" if same else "differs from the topology"))
        except Refused as exc:
            if args.set:
                raise
            say(f"{DIM}·{RESET}", f"topology:   {exc}")

        if not (args.set or args.clear):
            return 0
        if not columns:
            raise Refused("apply migration runtime_route_hosts first: there is nowhere to write the route")
        if route is None:
            raise Refused(f"{trip['slug']} has no runtime route row (it has not finished provisioning)")
        if trip["slug"].startswith("retired-"):
            raise Refused(f"{trip['slug']} is a retired trip")

        if args.set:
            host, upstream = wanted
            holder = host_holder(host, trip["id"])
            if holder:
                raise Refused(f"{host} is already the route of {holder}")
            if route["state"] != "ready":
                say(f"{YELLOW}!{RESET}", f"the route's state is {route['state']!r}; the gateway routes only 'ready' "
                    "(this does not change it)")
            sql = ("UPDATE control_plane.runtime_routes SET "
                   f"public_host = '{host}', upstream_url = '{upstream}', updated_at = now() "
                   f"WHERE trip_id = '{trip['id']}'")
            todo = f"set public_host={host}  upstream_url={upstream}"
        else:
            sql = ("UPDATE control_plane.runtime_routes SET public_host = NULL, upstream_url = NULL, "
                   f"updated_at = now() WHERE trip_id = '{trip['id']}'")
            todo = "clear public_host and upstream_url (the gateway then answers the name as one that never existed)"
        say(f"{YELLOW}→{RESET}", todo)
        live = trip_needs_live(trip["lifecycle_state"])
        if live:
            say(f"{YELLOW}!{RESET}", f"{trip['slug']} is {trip['lifecycle_state']}: a trip in use - this is a deploy, "
                "and --execute needs --live")
        if not args.execute:
            print(f"\n{DIM}dry run — re-run with --execute{' --live' if live else ''} to do this{RESET}")
            return 0
        if live and not args.live:
            raise Refused(f"{trip['slug']} is {trip['lifecycle_state']}, a trip in use: re-run with --live once "
                          "you have approval to change it (CLAUDE.md hard rule 2)")
        psql(sql)
        after = resolve(trip["id"])["route"]
        ok = (after is not None and
              ((after.get("public_host"), after.get("upstream_url")) == wanted if args.set
               else after.get("public_host") is None and after.get("upstream_url") is None))
        say(f"{GREEN}✓{RESET}" if ok else f"{RED}✗{RESET}", f"route now:  {describe(after)}")
        return 0 if ok else 1
    except Refused as exc:
        print(f"{RED}refused{RESET}: {exc}")
        return 2
    except RuntimeError as exc:
        print(f"{RED}failed{RESET}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
