"""scripts/switch-trip-chat.py must not clear a trip's TRIP_MCP_BRIDGE_FAILED mark (#287).

The script's last statement used to set `reachability` / `unreachable_reason`
unconditionally whenever the target's profile directory exists — which turned a
trip that `verify` had marked "companion answers, bridge down" back into plain
`reachable`. Clearing that mark belongs to `--reconcile-companion`, which proves
the bridge works first; a chat switch proves nothing about the bridge.

psql is stubbed, so this checks the SQL the script emits, not what Postgres does
with it. No database, no docker, no host.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import re
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "switch-trip-chat.py"
spec = importlib.util.spec_from_file_location("switch_trip_chat_under_test", SCRIPT)
stc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stc)


class SwitchPreservesTheBridgeMark(unittest.TestCase):
    def run_switch(self, *, installed: bool) -> str:
        written: list[str] = []

        def fake_psql(sql: str) -> str:
            if sql.startswith("BEGIN;"):
                written.append(sql)
                return ""
            if "FROM control_plane.trips WHERE slug" in sql:
                return "trip_target1|japan-2026-2|ready_private|t"
            return ""  # the chat is not bound anywhere yet

        with mock.patch.object(stc, "psql", fake_psql), \
                mock.patch.object(stc.os.path, "isdir", lambda _p: installed), \
                contextlib.redirect_stdout(io.StringIO()):
            stc.switch("1001", "japan-2026-2", apply=True)
        self.assertEqual(len(written), 1, "one transaction")
        return written[0]

    def target_update(self, sql: str) -> str:
        updates = [s for s in sql.split("; ") if s.startswith("UPDATE control_plane.trips")]
        self.assertEqual(len(updates), 1)
        return updates[0]

    def test_an_existing_bridge_failed_mark_is_kept_when_the_profile_is_installed(self) -> None:
        update = self.target_update(self.run_switch(installed=True))
        # Both columns are conditional on the mark, so neither is overwritten with
        # the fresh 'reachable' / NULL.
        for column in ("reachability", "unreachable_reason"):
            self.assertRegex(
                update,
                rf"{column} = CASE WHEN unreachable_reason = 'TRIP_MCP_BRIDGE_FAILED' "
                rf"THEN {column} ELSE .+? END",
                f"{column} must keep TRIP_MCP_BRIDGE_FAILED")
        self.assertIn("ELSE 'reachable' END", update)
        self.assertIn("ELSE NULL END", update)

    def test_the_mark_is_also_kept_when_no_profile_is_installed(self) -> None:
        update = self.target_update(self.run_switch(installed=False))
        self.assertIn("ELSE 'unreachable' END", update)
        self.assertIn("ELSE 'COMPANION_INSTALL_FAILED' END", update)
        self.assertEqual(len(re.findall("TRIP_MCP_BRIDGE_FAILED", update)), 2)

    def test_only_the_target_trip_is_updated(self) -> None:
        update = self.target_update(self.run_switch(installed=True))
        self.assertTrue(update.endswith("WHERE id = 'trip_target1'"), update)


if __name__ == "__main__":
    unittest.main()
