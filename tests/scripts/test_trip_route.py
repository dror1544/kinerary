"""scripts/trip-route.py — show, set or clear a trip's gateway route.

The database is a small in-memory stand-in behind `psql()`, so these tests can
say exactly which statements ran. What they prove: nothing is written without
--execute; what is written comes only from the trip's own topology.yaml and only
after it passed an ASCII-only check; a topology that cannot give a usable
address and port is refused before any SQL; and --clear takes exactly the two
columns away.

    python3 -m unittest discover -s tests/scripts        (needs PyYAML)
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "trip-route.py"
spec = importlib.util.spec_from_file_location("trip_route", SCRIPT)
trip_route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trip_route)

TRIP_ID = "trip_abcdefgh12"


def topology(**changes) -> dict:
    raw = {
        "version": 1, "name": "japan-2026",
        "proxmox": {"node": "pve", "vmid": "205", "lxc": {
            "name": "trip-japan-2026", "ipv4": "192.0.2.210/24", "forward_port": 8080}},
        "npm": {"hostname": "japan-2026.example.invalid", "forward_host": "192.0.2.210", "forward_port": 8080},
        "cloudflare": {"tunnel_id": "t", "hostname": "japan-2026.example.invalid", "service": "http://x"},
    }
    for path, value in changes.items():
        node = raw
        keys = path.split("__")
        for key in keys[:-1]:
            node = node[key]
        if value is None:
            node.pop(keys[-1], None)
        else:
            node[keys[-1]] = value
    return raw


class FakeDb:
    """Just enough of the control plane for this script's statements."""

    def __init__(self, *, slug="japan-2026", state="ready_private", route=True, columns=True,
                 route_state="ready", public_host=None, upstream_url=None, other_holder=None):
        self.trip = {"id": TRIP_ID, "slug": slug, "lifecycle_state": state}
        self.route = {"state": route_state, "public_host": public_host, "upstream_url": upstream_url} if route else None
        self.columns = columns
        self.other_holder = other_holder
        self.statements: list[str] = []

    @property
    def writes(self) -> list[str]:
        return [s for s in self.statements if s.lstrip().upper().startswith("UPDATE")]

    def psql(self, sql: str) -> str:
        self.statements.append(sql)
        if "information_schema.columns" in sql:
            return "2" if self.columns else "0"
        if "SELECT t.id, t.slug" in sql:
            row = dict(self.trip, has_route=1 if self.route else 0)
            return json.dumps(row)
        if "SELECT state, public_host, upstream_url" in sql:
            return json.dumps(self.route)
        if "JOIN control_plane.trips t" in sql:
            return self.other_holder or ""
        if sql.startswith("UPDATE control_plane.runtime_routes"):
            if "public_host = NULL" in sql:
                self.route.update(public_host=None, upstream_url=None)
            else:
                host = re.search(r"public_host = '([^']*)'", sql).group(1)
                up = re.search(r"upstream_url = '([^']*)'", sql).group(1)
                self.route.update(public_host=host, upstream_url=up)
            return "UPDATE 1"
        raise AssertionError(f"unexpected statement: {sql!r}")


def run(db: FakeDb, raw_topology, args: list[str], *, write_topology=True):
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp:
        if raw_topology is not None and write_topology:
            trip_dir = Path(tmp, "trips", db.trip["slug"])
            trip_dir.mkdir(parents=True)
            (trip_dir / "topology.yaml").write_text(yaml.safe_dump(raw_topology, sort_keys=False))
        with mock.patch.object(trip_route, "DEPLOY_ROOT", Path(tmp)), \
                mock.patch.object(trip_route, "psql", db.psql), \
                mock.patch.object(trip_route, "reexec_with_yaml", lambda: None), \
                contextlib.redirect_stdout(out):
            try:
                code = trip_route.main(["--trip", db.trip["slug"], *args])
            except SystemExit as exc:  # argparse
                code = exc.code
    return code, re.sub(r"\x1b\[[0-9;]*m", "", out.getvalue())


class Show(unittest.TestCase):
    def test_it_prints_the_route_and_what_the_topology_says_and_writes_nothing(self):
        db = FakeDb(public_host="japan-2026.example.invalid", upstream_url="http://192.0.2.210:8080")
        code, text = run(db, topology(), [])
        self.assertEqual(0, code, text)
        self.assertIn("state=ready  public_host=japan-2026.example.invalid  upstream_url=http://192.0.2.210:8080", text)
        self.assertIn("topology:   public_host=japan-2026.example.invalid  upstream_url=http://192.0.2.210:8080", text)
        self.assertIn("matches the topology", text)
        self.assertEqual([], db.writes)

    def test_a_route_that_differs_is_said_to(self):
        db = FakeDb(public_host="japan-2026.example.invalid", upstream_url="http://192.0.2.99:8080")
        _code, text = run(db, topology(), [])
        self.assertIn("differs from the topology", text)

    def test_it_shows_a_trip_with_no_topology_without_failing(self):
        code, text = run(FakeDb(), None, [])
        self.assertEqual(0, code, text)
        self.assertIn("no topology for japan-2026", text)

    def test_an_unmigrated_database_is_said_so(self):
        _code, text = run(FakeDb(columns=False), topology(), [])
        self.assertIn("migration runtime_route_hosts is not applied", text)

    def test_a_slug_or_id_that_is_neither_is_refused_before_any_sql(self):
        db = FakeDb()
        out = io.StringIO()
        with mock.patch.object(trip_route, "psql", db.psql), mock.patch.object(trip_route, "reexec_with_yaml", lambda: None), \
                contextlib.redirect_stdout(out):
            code = trip_route.main(["--trip", "x'; DROP TABLE trips; --"])
        self.assertEqual(2, code)
        self.assertEqual([], [s for s in db.statements if "x'" in s])


class Set(unittest.TestCase):
    def test_the_plan_changes_nothing(self):
        db = FakeDb()
        code, text = run(db, topology(), ["--set"])
        self.assertEqual(0, code, text)
        self.assertIn("dry run", text)
        self.assertIn("set public_host=japan-2026.example.invalid  upstream_url=http://192.0.2.210:8080", text)
        self.assertEqual([], db.writes)

    def test_execute_writes_exactly_the_two_columns_for_this_trip(self):
        db = FakeDb()
        code, text = run(db, topology(), ["--set", "--execute"])
        self.assertEqual(0, code, text)
        self.assertEqual(1, len(db.writes))
        self.assertIn(f"WHERE trip_id = '{TRIP_ID}'", db.writes[0])
        self.assertNotIn("state =", db.writes[0], "the route's state is not this script's to change")
        self.assertEqual(("japan-2026.example.invalid", "http://192.0.2.210:8080"),
                         (db.route["public_host"], db.route["upstream_url"]))

    def test_a_wildcard_topology_is_read_from_its_own_keys(self):
        raw = topology(npm=None, cloudflare=None)
        raw["routing"] = "wildcard"
        raw["proxmox"]["lxc"]["public_hostname"] = "japan-2026.example.invalid"
        db = FakeDb()
        code, _text = run(db, raw, ["--set", "--execute"])
        self.assertEqual(0, code)
        self.assertEqual("japan-2026.example.invalid", db.route["public_host"])

    def test_the_port_falls_back_to_the_proxy_hosts_for_an_old_topology(self):
        db = FakeDb()
        code, _ = run(db, topology(proxmox__lxc__forward_port=None), ["--set", "--execute"])
        self.assertEqual(0, code)
        self.assertEqual("http://192.0.2.210:8080", db.route["upstream_url"])

    def test_the_hostname_is_the_topologys_never_the_command_lines(self):
        db = FakeDb()
        code, _ = run(db, topology(), ["--set", "--execute", "--host", "evil.example"])
        self.assertEqual(2, code, "there is no such option")
        self.assertEqual([], db.writes)

    def test_a_topology_without_a_usable_address_or_port_is_refused_before_any_write(self):
        bad = {
            "dhcp": topology(proxmox__lxc__ipv4="dhcp"),
            "a name, not an address": topology(proxmox__lxc__ipv4="trip-japan-2026.lan"),
            "octet over 255": topology(proxmox__lxc__ipv4="192.0.2.256/24"),
            "non-ASCII digits in the address": topology(proxmox__lxc__ipv4="192.0.2.２１０/24"),
            "an address carrying a tab": topology(proxmox__lxc__ipv4="192.0.2.210\t/24"),
            "an address with a newline": topology(proxmox__lxc__ipv4="192.0.2.210\n"),
            "an address with a path": topology(proxmox__lxc__ipv4="192.0.2.210/24/../x"),
            "no address": topology(proxmox__lxc__ipv4=None),
            "port zero": topology(proxmox__lxc__forward_port=0),
            "port over 65535": topology(proxmox__lxc__forward_port=65536),
            "non-ASCII digits in the port": topology(proxmox__lxc__forward_port="８０８０"),
            "a port that is a word": topology(proxmox__lxc__forward_port="http"),
            "a negative port": topology(proxmox__lxc__forward_port=-1),
        }
        for what, raw in bad.items():
            with self.subTest(what):
                db = FakeDb()
                code, text = run(db, raw, ["--set", "--execute"])
                self.assertEqual(2, code, text)
                self.assertEqual([], db.writes)
                self.assertIn("refused", text)

    def test_a_port_that_is_missing_everywhere_is_refused(self):
        db = FakeDb()
        raw = topology(proxmox__lxc__forward_port=None, npm__forward_port=None)
        code, _ = run(db, raw, ["--set", "--execute"])
        self.assertEqual(2, code)
        self.assertEqual([], db.writes)

    def test_a_hostname_that_is_not_a_lower_case_dns_name_is_refused(self):
        for host in ("Japan-2026.Example.Invalid", "japan 2026.example", "japan-2026", "${HOST}", "a..b", "-a.example",
                     "japan-2026.example\n", "jäpan.example"):
            with self.subTest(host=host):
                db = FakeDb()
                code, _ = run(db, topology(npm__hostname=host), ["--set", "--execute"])
                self.assertEqual(2, code)
                self.assertEqual([], db.writes)

    def test_a_topology_for_another_trip_is_refused(self):
        for raw in (topology(name="italy-2026"), topology(proxmox__lxc__name="trip-italy-2026")):
            with self.subTest(name=raw["name"]):
                db = FakeDb()
                code, text = run(db, raw, ["--set", "--execute"])
                self.assertEqual(2, code)
                self.assertIn("does not describe japan-2026", text)
                self.assertEqual([], db.writes)

    def test_no_topology_is_refused(self):
        db = FakeDb()
        code, text = run(db, None, ["--set", "--execute"])
        self.assertEqual(2, code)
        self.assertEqual([], db.writes)
        self.assertIn("no topology", text)

    def test_a_hostname_another_trip_already_has_is_refused(self):
        db = FakeDb(other_holder="italy-2026")
        code, text = run(db, topology(), ["--set", "--execute"])
        self.assertEqual(2, code)
        self.assertIn("already the route of italy-2026", text)
        self.assertEqual([], db.writes)

    def test_a_database_without_the_columns_is_refused_not_failed_half_way(self):
        db = FakeDb(columns=False)
        code, text = run(db, topology(), ["--set", "--execute"])
        self.assertEqual(2, code)
        self.assertIn("apply migration runtime_route_hosts", text)
        self.assertEqual([], db.writes)

    def test_a_trip_with_no_route_row_or_a_retired_one_is_refused(self):
        for db in (FakeDb(route=False), FakeDb(slug="retired-japan-2026-20260101")):
            with self.subTest(slug=db.trip["slug"], route=db.route):
                code, _ = run(db, topology(name=db.trip["slug"], proxmox__lxc__name=f"trip-{db.trip['slug']}"),
                              ["--set", "--execute"])
                self.assertEqual(2, code)
                self.assertEqual([], db.writes)

    def test_a_route_that_is_not_ready_is_warned_about_and_left_in_its_state(self):
        db = FakeDb(route_state="suspended")
        code, text = run(db, topology(), ["--set", "--execute"])
        self.assertEqual(0, code)
        self.assertIn("the gateway routes only 'ready'", text)
        self.assertEqual("suspended", db.route["state"])

    def test_the_plan_names_the_lifecycle_state_of_the_trip_it_would_move(self):
        _code, text = run(FakeDb(state="ready_private"), topology(), ["--set"])
        self.assertIn("(ready_private)", text)


class Clear(unittest.TestCase):
    def test_the_plan_changes_nothing(self):
        db = FakeDb(public_host="japan-2026.example.invalid", upstream_url="http://192.0.2.210:8080")
        code, text = run(db, topology(), ["--clear"])
        self.assertEqual(0, code, text)
        self.assertEqual([], db.writes)
        self.assertIn("dry run", text)

    def test_execute_takes_both_columns_away_and_nothing_else(self):
        db = FakeDb(public_host="japan-2026.example.invalid", upstream_url="http://192.0.2.210:8080")
        code, _text = run(db, topology(), ["--clear", "--execute"])
        self.assertEqual(0, code)
        self.assertEqual((None, None, "ready"), (db.route["public_host"], db.route["upstream_url"], db.route["state"]))
        self.assertEqual(1, len(db.writes))

    def test_clear_needs_no_topology(self):
        db = FakeDb(public_host="japan-2026.example.invalid", upstream_url="http://192.0.2.210:8080")
        code, _ = run(db, None, ["--clear", "--execute"])
        self.assertEqual(0, code)
        self.assertIsNone(db.route["public_host"])


class Arguments(unittest.TestCase):
    def test_set_and_clear_are_exclusive(self):
        code, _ = run(FakeDb(), topology(), ["--set", "--clear"])
        self.assertEqual(2, code)

    def test_execute_alone_is_refused_rather_than_ignored(self):
        db = FakeDb()
        code, _ = run(db, topology(), ["--execute"])
        self.assertEqual(2, code)
        self.assertEqual([], db.writes)

    def test_the_script_is_executable_and_names_the_hard_rule(self):
        import os
        self.assertTrue(os.access(SCRIPT, os.X_OK))
        self.assertIn("hard rule 2", SCRIPT.read_text())


if __name__ == "__main__":
    unittest.main()
