""".agents/skills/trip-fleet-monitor — the fleet monitor's digest, watchdog and MCP.

Three properties a monitor has to have, each of which was missing once:

- A check that FAILED is not a healthy fleet. The digest used to swallow an
  alerts failure and print "Nothing needs attention".
- One stack's trip-class override stays on that stack. A development override
  used to classify production trips too, which could filter real alerts out.
- The watchdog's output is stable while nothing changes. Hermes hashes the
  exact bytes of a monitor script's output; an elapsed "idle 7h" re-ran the
  model every hour for the same stalled interview.

No database: the digest runs against a fake `node`, and the MCP against a fake
`psql` that records each SQL script it is handed and answers from fixtures.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / ".agents" / "skills" / "trip-fleet-monitor"
DIGEST = SKILL / "cron" / "kinerary_fleet_digest.sh"
FLEET = SKILL / "fleet-mcp.mjs"
NODE = shutil.which("node")
SEP = "\x1f"


def executable(path: Path, text: str) -> Path:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


class Digest(unittest.TestCase):
    """The daily digest never reports health it could not check."""

    FAKE_NODE = """#!/bin/sh
# argv: <fleet-mcp path> --tool <name> [...]
tool="$3"
case " $FAKE_FAIL " in *" $tool "*) echo "$tool: psql exited 2: connection refused" >&2; exit 1 ;; esac
case "$tool" in
  fleet_overview) echo "TRIPS BY CLASS AND STAGE" ;;
  statistics) echo "FUNNEL" ;;
  alerts) printf '%s' "$FAKE_ALERTS" ;;
esac
"""

    def run_digest(self, fail: str = "", alerts: str = "") -> subprocess.CompletedProcess:
        tmp = Path(tempfile.mkdtemp())
        node = executable(tmp / "node", self.FAKE_NODE)
        env = {**os.environ, "KINERARY_NODE_BIN": str(node), "KINERARY_FLEET_MCP": "/fake/fleet-mcp.mjs",
               "FAKE_FAIL": fail, "FAKE_ALERTS": alerts}
        return subprocess.run(["/bin/bash", str(DIGEST)], capture_output=True, text=True, env=env, timeout=30)

    def test_a_failed_alerts_check_is_not_a_healthy_fleet(self):
        proc = self.run_digest(fail="alerts")
        self.assertNotEqual(proc.returncode, 0, "the job must fail so Hermes reports the watchdog broke")
        self.assertNotIn("Nothing needs attention", proc.stdout)
        self.assertIn("could NOT be checked", proc.stdout)
        self.assertIn("connection refused", proc.stdout)

    def test_a_healthy_fleet_says_so(self):
        proc = self.run_digest()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("✅ Nothing needs attention.", proc.stdout)

    def test_problems_are_printed(self):
        proc = self.run_digest(alerts="⚠️ Kinerary fleet — prod\n\nUNREACHABLE\n  • trip-a — NO_ORGANIZER_CHAT")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("trip-a — NO_ORGANIZER_CHAT", proc.stdout)
        self.assertNotIn("Nothing needs attention", proc.stdout)

    def test_one_failed_section_does_not_hide_the_others(self):
        proc = self.run_digest(fail="fleet_overview")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("could not be read", proc.stdout)
        self.assertIn("FUNNEL", proc.stdout, "statistics still reported")
        self.assertIn("✅ Nothing needs attention.", proc.stdout, "alerts still checked, and they passed")


@unittest.skipUnless(NODE, "node is not installed")
class FleetMcp(unittest.TestCase):
    FAKE_PSQL = """#!/usr/bin/env python3
import json, sys
log_path, stack, fixtures_path = sys.argv[1], sys.argv[2], sys.argv[3]
sql = sys.stdin.read()
with open(log_path, "a") as log:
    log.write(json.dumps({"stack": stack, "sql": sql}) + "\\n")
fixtures = json.load(open(fixtures_path))
for marker, rows in fixtures.items():
    if marker in sql:
        for row in rows:
            print("\\x1f".join(row))
        break
"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.psql = executable(self.tmp / "psql.py", self.FAKE_PSQL)
        self.log = self.tmp / "sql.log"
        self.fixtures = self.tmp / "fixtures.json"
        self.fixtures.write_text("{}")

    def config(self, stacks: dict) -> Path:
        for name, stack in stacks.items():
            stack["argv"] = [sys.executable, str(self.psql), str(self.log), name, str(self.fixtures)]
        path = self.tmp / "fleet-stacks.json"
        path.write_text(json.dumps({"default_stack": next(iter(stacks)), "stacks": stacks}))
        return path

    def run_tool(self, config: Path, *args: str) -> subprocess.CompletedProcess:
        env = {**os.environ, "KINERARY_FLEET_CONFIG": str(config)}
        return subprocess.run([NODE, str(FLEET), *args], capture_output=True, text=True, env=env, timeout=60)

    def sql_for(self, stack: str) -> list[str]:
        return [json.loads(l)["sql"] for l in self.log.read_text().splitlines() if json.loads(l)["stack"] == stack]

    def test_a_class_override_applies_only_to_its_own_stack(self):
        override = "'scaffolding' /* dev-only-override */"
        config = self.config({
            "prod": {"label": "production", "production": True},
            "dev": {"label": "development", "trip_class_sql": override},
        })
        for tool in ("alerts", "fleet_overview", "statistics", "failures"):
            proc = self.run_tool(config, "--tool", tool, "--stack", "prod")
            self.assertEqual(proc.returncode, 0, proc.stderr)
        prod_sql = "\n".join(self.sql_for("prod"))
        self.assertIn("retired-%", prod_sql, "production uses the default classification")
        self.assertNotIn("dev-only-override", prod_sql, "a development override must never classify production trips")

        proc = self.run_tool(config, "--tool", "alerts", "--stack", "dev")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("dev-only-override", "\n".join(self.sql_for("dev")))

    def test_alerts_output_is_stable_while_nothing_changes(self):
        self.fixtures.write_text(json.dumps({
            "awaiting = 'machine'": [["trip-b", "collect", "2026-09-15 10:00 UTC"]],
            "NOT EXISTS (SELECT 1 FROM control_plane.jobs": [["trip-a", "intake_confirmed", "2026-09-11 08:30 UTC"]],
        }))
        config = self.config({"prod": {"label": "production", "production": True}})
        first = self.run_tool(config, "--tool", "alerts")
        second = self.run_tool(config, "--tool", "alerts")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, second.stdout)
        self.assertIn("since 2026-09-15 10:00 UTC", first.stdout)
        self.assertIn("confirmed 2026-09-11 08:30 UTC", first.stdout)

        # What makes it stable at the source: no elapsed time is computed for
        # output, and every row set comes back in a fixed order. Hermes compares
        # the exact bytes.
        for sql in self.sql_for("prod"):
            select_list = sql.split("FROM", 1)[0]
            self.assertNotIn("now()", select_list, f"elapsed time in alerts output:\n{sql}")
            # A SELECT with no FROM returns exactly one row — alerts probes for
            # companion_bug_reports that way, so a stack behind migration 0054
            # degrades instead of breaking. Row order is not a property one row
            # can have, let alone lose; everything that reads a table needs it.
            if "FROM" not in sql:
                continue
            self.assertIn("ORDER BY", sql, f"unordered alerts query:\n{sql}")

    def test_healthy_alerts_print_nothing(self):
        config = self.config({"prod": {"label": "production", "production": True}})
        proc = self.run_tool(config, "--tool", "alerts")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
