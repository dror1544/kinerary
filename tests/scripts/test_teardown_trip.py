"""scripts/teardown-trip.py — the parts that can go wrong quietly.

Nothing here touches Docker, Proxmox, Hermes or launchd: psql and subprocess
are replaced. What is tested is the logic a mistake in which would not show up
as a failure — an allowlist edit that widens the interviewer instead of
narrowing it, a retired slug whose old resources are no longer found, a trip
real people used being accepted as a target.

    python3 -m unittest discover -s tests/scripts        (needs PyYAML)
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "teardown-trip.py"
spec = importlib.util.spec_from_file_location("teardown_trip", SCRIPT)
teardown = importlib.util.module_from_spec(spec)
spec.loader.exec_module(teardown)


CONFIG = """model:
  default: claude-sonnet-5
gateway:
  multiplex_profiles: true
  multiplex_profile_allowlist:
    - japan2026
    - italy2026
  profile_routes: []
platforms:
  telegram:
    home_channel:
      chat_id: '391627336'
"""


class NarrowAllowlist(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "config.yaml"
        patcher = mock.patch.object(teardown, "INTERVIEWER_CONFIG", self.path)
        patcher.start()
        self.addCleanup(patcher.stop)
        run = mock.patch.object(teardown.subprocess, "run")
        self.run = run.start()
        self.addCleanup(run.stop)

    def tearDown(self):
        self.dir.cleanup()

    def test_removes_one_entry_and_leaves_every_other_line_alone(self):
        self.path.write_text(CONFIG)
        teardown.narrow_allowlist("japan2026")
        after = self.path.read_text()
        self.assertEqual(yaml.safe_load(after)["gateway"]["multiplex_profile_allowlist"], ["italy2026"])
        self.assertEqual(after, CONFIG.replace("    - japan2026\n", ""))

    def test_the_last_entry_leaves_an_empty_list_never_a_missing_key(self):
        # A MISSING key means serve-all in Hermes (gateway/config.py); [] means
        # the default profile only. Deleting the key would widen the gateway.
        self.path.write_text(CONFIG.replace("    - italy2026\n", ""))
        teardown.narrow_allowlist("japan2026")
        gateway = yaml.safe_load(self.path.read_text())["gateway"]
        self.assertIn("multiplex_profile_allowlist", gateway)
        self.assertEqual(gateway["multiplex_profile_allowlist"], [])

    def test_an_inline_list_is_handled_too(self):
        self.path.write_text(CONFIG.replace(
            "  multiplex_profile_allowlist:\n    - japan2026\n    - italy2026\n",
            "  multiplex_profile_allowlist: [japan2026, italy2026]\n"))
        teardown.narrow_allowlist("italy2026")
        self.assertEqual(yaml.safe_load(self.path.read_text())["gateway"]["multiplex_profile_allowlist"], ["japan2026"])

    def test_the_interviewer_is_restarted_so_its_ticker_for_the_profile_stops(self):
        self.path.write_text(CONFIG)
        teardown.narrow_allowlist("japan2026")
        argv = self.run.call_args.args[0]
        self.assertEqual(argv[1:], ["--profile", "trip-intake", "gateway", "restart"])


class OriginalSlug(unittest.TestCase):
    def test_a_retired_slug_still_names_its_old_resources(self):
        self.assertEqual(teardown.original_slug("retired-japan-2026-20260911"), "japan-2026")
        self.assertEqual(teardown.original_slug("retired-japan-2026-20260911-2"), "japan-2026")
        self.assertEqual(teardown.original_slug("italy-2026"), "italy-2026")


class Resolve(unittest.TestCase):
    def fake_psql(self, trip: dict, bound: str = "", shared: str = "0", open_: str = "0"):
        def psql(sql: str) -> str:
            if "row_to_json" in sql:
                return json.dumps(trip)
            if "SELECT hermes_profile" in sql:
                return bound
            if "trip_id <>" in sql:
                return shared
            return open_
        return mock.patch.object(teardown, "psql", side_effect=psql)

    def test_a_trip_real_people_used_is_refused(self):
        for state in ("activation_approved", "active", "completed", "sealed"):
            with self.fake_psql({"id": "trip_abcdefgh12", "slug": "japan-2026", "lifecycle_state": state}):
                with self.assertRaises(teardown.Refused):
                    teardown.resolve("japan-2026")

    def test_a_profile_another_trip_still_uses_is_refused(self):
        with self.fake_psql({"id": "trip_abcdefgh12", "slug": "japan-2026", "lifecycle_state": "ready_private"},
                            bound="japan2026", shared="1"):
            with self.assertRaises(teardown.Refused):
                teardown.resolve("japan-2026")

    def test_the_interviewer_is_never_a_companion_to_delete(self):
        with self.fake_psql({"id": "trip_abcdefgh12", "slug": "x-2026", "lifecycle_state": "draft"}, bound="trip-intake"):
            with self.assertRaises(teardown.Refused):
                teardown.resolve("x-2026")

    def test_a_test_trip_resolves_to_its_profile(self):
        with self.fake_psql({"id": "trip_abcdefgh12", "slug": "japan-2026", "lifecycle_state": "ready_private"}):
            trip = teardown.resolve("japan-2026")
        self.assertEqual((trip["orig"], trip["profile"]), ("japan-2026", "japan2026"))

    def test_input_that_is_neither_id_nor_slug_is_refused_before_any_query(self):
        with mock.patch.object(teardown, "psql") as psql:
            with self.assertRaises(teardown.Refused):
                teardown.resolve("x'; DROP TABLE trips; --")
            psql.assert_not_called()


if __name__ == "__main__":
    unittest.main()
