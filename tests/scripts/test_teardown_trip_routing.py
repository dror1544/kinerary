"""scripts/teardown-trip.py with a trip that has no per-trip public records.

A wildcard-routed trip has a container and a route row, and nothing at NPM or
Cloudflare. Teardown must then do none of those steps (and need none of their
credentials), must still do every one of them for a topology that has the
sections, must clear the gateway route inside the retirement transaction without
disturbing its documented lock order, and must remove the shared bridge's route
file for the trip - that one file, and only if it is a regular file.

Nothing here touches Docker, Proxmox, Hermes or launchd.

    python3 -m unittest discover -s tests/scripts        (needs PyYAML)
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "teardown-trip.py"
spec = importlib.util.spec_from_file_location("teardown_trip_routing", SCRIPT)
teardown = importlib.util.module_from_spec(spec)
spec.loader.exec_module(teardown)

TRIP = {"id": "trip_abcdefgh12", "slug": "japan-2026", "orig": "japan-2026", "profile": "japan2026",
        "lifecycle_state": "ready_private", "open_bindings": 1, "live_group_tokens": 0}

HOST_TOPOLOGY = {
    "version": 1, "name": "japan-2026",
    "proxmox": {"node": "pve", "vmid": "205", "lxc": {
        "name": "trip-japan-2026", "template": "t", "storage": "s", "cores": 2, "memory_mb": 1024, "disk_gb": 8,
        "bridge": "vmbr0", "ipv4": "192.0.2.210/24", "gateway": "192.0.2.1", "nameserver": "192.0.2.2",
        "nfs_host_dir": "/mnt/pve/nfs/trip_9f2c11aa4d", "nfs_mount_path": "/nfs/trip_9f2c11aa4d"}},
    "npm": {"hostname": "japan-2026.example.invalid", "forward_host": "192.0.2.210", "forward_port": 8080},
    "cloudflare": {"tunnel_id": "t", "hostname": "japan-2026.example.invalid", "service": "http://127.0.0.1:8080"},
}


def wildcard_topology() -> dict:
    raw = yaml.safe_load(yaml.safe_dump(HOST_TOPOLOGY))
    del raw["npm"], raw["cloudflare"]
    raw["routing"] = "wildcard"
    raw["proxmox"]["lxc"]["forward_port"] = 8080
    raw["proxmox"]["lxc"]["public_hostname"] = "japan-2026.example.invalid"
    return raw


class _Infra:
    """What the provisioner's adapters were asked to do, and what exists."""

    def __init__(self, *, wildcard: bool, npm_state=None) -> None:
        self.log: list[str] = []
        self.lxc_alive = True
        self.kept_as: str | None = None
        outer = self

        class Proxmox:
            ssh = mock.Mock()

            def inspect(self, spec):
                if outer.kept_as is not None:  # --keep-container renamed it
                    return ({"vmid": "205", "name": spec.name, "status": "running"}
                            if spec.name == outer.kept_as else None)
                return {"vmid": "205", "name": spec.name} if outer.lxc_alive else None

            def delete(self, spec):
                outer.log.append("lxc.delete")
                outer.lxc_alive = False

        class Npm:
            def inspect(self, spec):
                return npm_state

            def delete(self, spec):
                outer.log.append("npm.delete")

        class Cloudflare:
            def _dns_records(self, spec):
                return []

            def _ingress_rule_present(self, spec):
                return False

            def delete(self, spec):
                outer.log.append("cloudflare.delete")

        # A wildcard trip is handed NO npm and NO cloudflare object at all: any
        # use of one is an AttributeError on None, not a silent no-op.
        self.prov = types.SimpleNamespace(
            proxmox=Proxmox(), npm=None if wildcard else Npm(), cloudflare=None if wildcard else Cloudflare())


def run_teardown(raw_topology, *, execute=True, keep=False, shared_dir=None, route_file=None, write_symlink=False,
                 npm_state=None):
    """main() with every side effect replaced. Returns what happened."""
    log: list[str] = []
    sql: list[str] = []
    infra = _Infra(wildcard="npm" not in raw_topology, npm_state=npm_state)
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "profiles").mkdir()
        trip_dir = tmp / "trips" / "japan-2026"
        trip_dir.mkdir(parents=True)
        (trip_dir / "topology.yaml").write_text(yaml.safe_dump(raw_topology, sort_keys=False))
        env = {}
        if shared_dir is not None:
            routes = tmp / "routes"
            routes.mkdir()
            env["KINERARY_SHARED_BRIDGE_ROUTES_DIR"] = str(routes)
            if route_file:
                (routes / "japan-2026.json").write_text('{"schema_version": 1}')
                (routes / "japan-2027.json").write_text('{"schema_version": 1}')
            if write_symlink:
                target = tmp / "elsewhere.json"
                target.write_text("{}")
                (routes / "japan-2026.json").symlink_to(target)

        def record(name, result=None):
            def inner(*_a, **_k):
                log.append(name)
                return result
            return inner

        patches = [
            mock.patch.object(teardown, "reexec_with_yaml", lambda: None),
            mock.patch.object(teardown, "resolve", lambda target: dict(TRIP)),
            mock.patch.object(teardown, "DEPLOY_ROOT", tmp),
            mock.patch.object(teardown, "PROFILES", tmp / "profiles"),
            mock.patch.object(teardown, "bridge", lambda d: None),
            mock.patch.object(teardown, "LAUNCH_AGENTS", tmp / "no-launch-agents"),
            mock.patch.object(teardown, "document_store", lambda t: None),
            mock.patch.object(teardown, "kept_originals", lambda s: 0),
            mock.patch.object(teardown, "interviewer_allows", lambda p: False),
            mock.patch.object(teardown, "gateway_installed", lambda p: False),
            mock.patch.object(teardown, "gateway_loaded", lambda p: False),
            mock.patch.object(teardown, "table_exists", lambda t: False),
            mock.patch.object(teardown, "build_provisioner", lambda topo=None: infra.prov),
            mock.patch.object(teardown, "backup", record("backup")),
            mock.patch.object(teardown, "pin_gateway_off", record("pin", "no-table")),
            mock.patch.object(teardown, "confirm_gateway_down", record("confirm-down", True)),
            mock.patch.object(teardown, "psql", lambda s: sql.append(s) or "0"),
            mock.patch.object(teardown, "site_answers", lambda host, port, seconds=90: True),
            mock.patch.object(teardown, "hermes", lambda: "hermes"),
            mock.patch.object(teardown.subprocess, "run", lambda *a, **k: mock.Mock(returncode=0, stdout="", stderr="")),
            mock.patch.object(teardown.time, "sleep", lambda s: None),
            mock.patch.object(sys, "argv", ["teardown", "--trip", "japan-2026"]
                              + (["--execute"] if execute else []) + (["--keep-container"] if keep else [])),
            mock.patch.dict(os.environ, env),
        ]
        if keep:
            def fake_keep(prov, topo, orig):
                log.append("keep")
                infra.kept_as = f"ref-{orig}"
                return {"vmid": "205", "name": f"ref-{orig}", "nfs_host_dir": "/x"}
            patches.append(mock.patch.object(teardown, "keep_container", fake_keep))
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            with contextlib.redirect_stdout(out):
                code = teardown.main()
        files = sorted(p.name for p in (tmp / "routes").iterdir()) if shared_dir is not None else []
    return types.SimpleNamespace(code=code, text=out.getvalue(), infra=infra.log, sql=sql, routes_left=files)


class WildcardTrip(unittest.TestCase):
    def test_the_plan_names_no_public_step_and_needs_no_adapter(self):
        result = run_teardown(wildcard_topology(), execute=False)
        self.assertEqual(0, result.code, result.text)
        self.assertIn("no public records (wildcard routing)", result.text)
        self.assertNotIn("Cloudflare", result.text)
        self.assertNotIn("NPM", result.text)
        self.assertEqual([], result.infra, "a dry run changes nothing")

    def test_it_removes_the_container_and_calls_neither_npm_nor_cloudflare(self):
        result = run_teardown(wildcard_topology())
        self.assertEqual(0, result.code, result.text)
        self.assertEqual(["lxc.delete"], result.infra)
        self.assertIn("all gone", result.text)

    def test_keep_container_plans_no_public_step_either(self):
        result = run_teardown(wildcard_topology(), keep=True)
        self.assertEqual(0, result.code, result.text)
        self.assertEqual([], result.infra)
        self.assertIn("http://192.0.2.210:8080/", result.text, "the kept site is reached at the container's own address")
        self.assertIn("public hostname gone=True", result.text)

    def test_the_infra_state_of_a_wildcard_topology_asks_nobody(self):
        sys.path[:0] = [str(teardown.REPO)]
        from provisioning.models import load_topology
        topo = load_topology(wildcard_topology())
        infra = _Infra(wildcard=True)
        state = teardown.infra_state(infra.prov, topo)
        self.assertEqual((None, [], False), (state["npm"], state["dns"], state["ingress"]))
        self.assertEqual(("192.0.2.210", 8080), teardown.site_address(topo))

    def test_it_still_refuses_a_topology_that_does_not_describe_this_trip(self):
        raw = wildcard_topology()
        raw["proxmox"]["lxc"]["public_hostname"] = "someone-else.example.invalid"
        result = run_teardown(raw)
        self.assertEqual(2, result.code)
        self.assertIn("does not describe japan-2026", result.text)
        self.assertEqual([], result.infra)


class HostTripIsTornDownAsToday(unittest.TestCase):
    """AC-R2.7 on the teardown side: a topology written before routing existed
    is torn down with every step it always had, in the order it always had."""

    def test_cloudflare_then_npm_then_the_container(self):
        result = run_teardown(HOST_TOPOLOGY)
        self.assertEqual(0, result.code, result.text)
        self.assertEqual(["cloudflare.delete", "npm.delete", "lxc.delete"], result.infra)

    def test_the_plan_still_says_cloudflare_npm_lxc(self):
        result = run_teardown(HOST_TOPOLOGY, execute=False)
        self.assertIn("Cloudflare + NPM + LXC for japan-2026", result.text)

    def test_keep_container_deletes_the_public_names_before_keeping_the_site(self):
        result = run_teardown(HOST_TOPOLOGY, keep=True)
        self.assertEqual(["cloudflare.delete", "npm.delete"], result.infra)
        self.assertIn("Cloudflare + NPM for japan-2026; KEEP the container", result.text)

    def test_a_section_that_is_present_is_torn_down_whatever_routing_says(self):
        # A label cannot hide a record that exists: presence decides.
        raw = yaml.safe_load(yaml.safe_dump(HOST_TOPOLOGY))
        raw["routing"] = "wildcard"
        raw["proxmox"]["lxc"]["forward_port"] = 8080
        result = run_teardown(raw)
        self.assertEqual(["cloudflare.delete", "npm.delete", "lxc.delete"], result.infra)

    def test_a_proxy_host_that_forwards_somewhere_else_is_still_refused(self):
        result = run_teardown(HOST_TOPOLOGY, npm_state={"forward_host": "198.51.100.9"})
        self.assertEqual(2, result.code)
        self.assertIn("someone else's host", result.text)
        self.assertEqual([], result.infra, "nothing was deleted")


class RouteIsClearedInTheRetirementTransaction(unittest.TestCase):
    def retire(self, slug):
        seen: list[str] = []
        with mock.patch.object(teardown, "psql", side_effect=lambda s: seen.append(s) or "0"):
            teardown.retire_in_db({"id": "trip_abcdefgh12", "slug": slug, "orig": "japan-2026"})
        return seen[-1]

    BRANCHES = ("japan-2026", "retired-japan-2026-20260101")

    def test_the_route_loses_its_host_and_upstream_and_is_suspended(self):
        for slug in self.BRANCHES:
            with self.subTest(slug=slug):
                tx = self.retire(slug)
                self.assertIn("SET public_host = NULL, upstream_url = NULL, state = 'suspended'", tx)
                self.assertIn("WHERE trip_id = 'trip_abcdefgh12'", tx)
                self.assertLess(tx.index("BEGIN"), tx.index("public_host = NULL"))
                self.assertLess(tx.index("public_host = NULL"), tx.index("COMMIT"))

    def test_it_runs_after_the_group_token_revoke_and_keeps_the_documented_lock_order(self):
        for slug in self.BRANCHES:
            with self.subTest(slug=slug):
                tx = self.retire(slug)
                order = ["BEGIN", "telegram_group_binding_tokens", "intake_sessions", "telegram_chat_bindings",
                         "public_host = NULL"]
                if slug == "japan-2026":
                    order.append("UPDATE control_plane.trips SET slug")
                order += ["pin = 'teardown' AND pin_trip_id", "COMMIT"]
                positions = [tx.index(marker) for marker in order]
                self.assertEqual(positions, sorted(positions), f"statement order is not {order}")
                self.assertEqual(len(set(positions)), len(positions))

    def test_an_older_database_only_suspends_the_route(self):
        tx = self.retire("japan-2026")
        self.assertIn("column_name = 'public_host'", tx)
        self.assertIn("ELSE\n    UPDATE control_plane.runtime_routes SET state = 'suspended'", tx)

    def test_the_whole_retirement_is_still_one_statement_batch_per_branch(self):
        for slug in self.BRANCHES:
            with self.subTest(slug=slug):
                seen: list[str] = []
                with mock.patch.object(teardown, "psql", side_effect=lambda s: seen.append(s) or "0"):
                    teardown.retire_in_db({"id": "trip_abcdefgh12", "slug": slug, "orig": "japan-2026"})
                transactions = [s for s in seen if "BEGIN" in s]
                self.assertEqual(1, len(transactions))

    def test_keep_container_clears_the_route_too(self):
        # AC-R2.8: the public name goes with the trip even though the site stays.
        result = run_teardown(HOST_TOPOLOGY, keep=True)
        transaction = [s for s in result.sql if "BEGIN" in s]
        self.assertEqual(1, len(transaction))
        self.assertIn("public_host = NULL", transaction[0])
        self.assertIn("state = 'suspended'", transaction[0])

    def test_a_full_teardown_clears_it_for_both_routing_modes(self):
        for raw in (HOST_TOPOLOGY, wildcard_topology()):
            with self.subTest(routing=raw.get("routing", "host")):
                result = run_teardown(raw)
                self.assertTrue(any("public_host = NULL" in s for s in result.sql))


class SharedBridgeRouteFile(unittest.TestCase):
    def test_a_regular_file_for_this_trip_is_removed_and_no_other(self):
        result = run_teardown(wildcard_topology(), shared_dir=True, route_file=True)
        self.assertEqual(0, result.code, result.text)
        self.assertEqual(["japan-2027.json"], result.routes_left, "only this trip's route file goes")
        self.assertIn("removed shared-bridge route japan-2026.json", result.text)

    def test_the_plan_names_it_and_a_dry_run_leaves_it(self):
        result = run_teardown(wildcard_topology(), execute=False, shared_dir=True, route_file=True)
        self.assertIn("delete the shared trip-mcp bridge's route file", result.text)
        self.assertEqual(["japan-2026.json", "japan-2027.json"], result.routes_left)

    def test_it_is_done_for_a_host_trip_and_with_keep_container_too(self):
        for kwargs in ({}, {"keep": True}):
            with self.subTest(**kwargs):
                result = run_teardown(HOST_TOPOLOGY, shared_dir=True, route_file=True, **kwargs)
                self.assertEqual(["japan-2027.json"], result.routes_left)

    def test_a_symlink_of_that_name_is_left_alone(self):
        result = run_teardown(wildcard_topology(), shared_dir=True, write_symlink=True)
        self.assertEqual(0, result.code, result.text)
        self.assertEqual(["japan-2026.json"], result.routes_left)
        self.assertNotIn("removed shared-bridge route", result.text)

    def test_nothing_is_done_when_the_variable_is_unset_or_no_file_exists(self):
        self.assertEqual([], run_teardown(wildcard_topology()).routes_left)
        result = run_teardown(wildcard_topology(), shared_dir=True)
        self.assertEqual([], result.routes_left)
        self.assertIn("bridge route (nothing to do)", result.text)

    def test_a_failure_to_remove_it_fails_the_teardown_loudly(self):
        with mock.patch.object(Path, "unlink", side_effect=PermissionError("denied")):
            result = run_teardown(wildcard_topology(), shared_dir=True, route_file=True)
        self.assertEqual(1, result.code)
        self.assertIn("could not remove shared-bridge route", result.text)

    def test_the_lookup_refuses_anything_that_is_not_a_slug(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ, {"KINERARY_SHARED_BRIDGE_ROUTES_DIR": root}):
            Path(root, "..x.json").write_text("{}")
            Path(root, "a.json").mkdir()
            for bad in ("../x", "..x", "a/b", "", "A"):
                with self.subTest(slug=bad):
                    self.assertIsNone(teardown.shared_bridge_route(bad))
            self.assertIsNone(teardown.shared_bridge_route("a"), "a directory is not a route")


class ReferenceTopologyForWildcard(unittest.TestCase):
    def test_a_kept_wildcard_site_moves_its_hostname_with_its_name(self):
        out = teardown.reference_topology(wildcard_topology(), "japan-2026")
        self.assertEqual("ref-japan-2026.example.invalid", out["proxmox"]["lxc"]["public_hostname"])
        self.assertEqual(8080, out["proxmox"]["lxc"]["forward_port"])
        self.assertNotIn("npm", out)


if __name__ == "__main__":
    unittest.main()
