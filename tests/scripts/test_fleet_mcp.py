""".agents/skills/trip-fleet-monitor/fleet-mcp.mjs — what the monitor may read.

The server is a fixed query catalogue, so what is pinned here is the catalogue:
the tools it offers, and the properties of the SQL it sends. Every statement is
captured from a stand-in `psql` (the `argv` escape hatch in fleet-stacks.json),
so none of this needs a database.

Three of these tests exist because the monitor once reported something untrue:

- a session closed for idleness keeps `state = 'interviewing'`, so filtering on
  state alone kept "INTERVIEW WAITING ON US" alive for conversations that had
  ended;
- `NOT IN ('succeeded','completed')` excluded a state that does not exist, so
  every queued or running build was listed as failed or stuck;
- a query that CRASHES must never render as "(none)", or a failed read looks
  exactly like a healthy fleet.

    python3 -m unittest discover -s tests/scripts
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / ".agents" / "skills" / "trip-fleet-monitor" / "fleet-mcp.mjs"
NODE = shutil.which("node")

#: A psql that answers nothing and records everything it was asked.
FAKE_PSQL = """#!/usr/bin/env python3
import os, sys
sql = sys.stdin.read()
with open(os.environ["FLEET_TEST_SQL_LOG"], "a") as log:
    log.write(sql + "\\n\\x00\\n")
if os.environ.get("FLEET_TEST_FAIL"):
    sys.stderr.write("ERROR:  relation \\"control_plane.trips\\" does not exist\\n")
    sys.exit(1)
rows = os.environ.get("FLEET_TEST_ROWS", "")
if rows:
    sys.stdout.write(rows)
"""

TOOLS = [
    ("fleet_overview", {}),
    ("list_trips", {}),
    ("trip_detail", {"trip": "japan-2026"}),
    ("failures", {}),
    ("stalled_interviews", {}),
    ("statistics", {}),
    ("alerts", {}),
    ("stacks", {}),
]


@unittest.skipUnless(NODE, "node is not installed")
class FleetMcp(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.log = self.tmp / "sql.log"
        fake = self.tmp / "fake-psql.py"
        fake.write_text(FAKE_PSQL)
        fake.chmod(0o755)
        config = self.tmp / "fleet-stacks.json"
        config.write_text(json.dumps({
            "default_stack": "prod",
            "stacks": {
                "prod": {"label": "a control plane", "production": True,
                         "argv": [shutil.which("python3") or "python3", str(fake)]},
            },
        }))
        self.config = config

    def call(self, messages: list[dict], env: dict | None = None) -> list[dict]:
        stdin = "".join(json.dumps(m) + "\n" for m in messages)
        proc = subprocess.run(
            [NODE, str(SERVER)],
            input=stdin, capture_output=True, text=True, timeout=60,
            env={**os.environ, "KINERARY_FLEET_CONFIG": str(self.config),
                 "FLEET_TEST_SQL_LOG": str(self.log), **(env or {})},
        )
        return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]

    def tool(self, name: str, arguments: dict | None = None, env: dict | None = None) -> tuple[str, bool]:
        responses = self.call(
            [{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": name, "arguments": arguments or {}}}], env)
        result = responses[0]["result"]
        return result["content"][0]["text"], bool(result.get("isError"))

    def statements(self) -> list[str]:
        """Every statement sent since setUp, comments stripped.

        The comments are stripped because these tests search for column names,
        and this file's comments discuss the very columns it must not read.
        """
        if not self.log.exists():
            return []
        raw = [s.strip() for s in self.log.read_text().split("\n\x00\n") if s.strip()]
        return [re.sub(r"--[^\n]*", "", statement) for statement in raw]

    def all_statements(self) -> list[str]:
        for name, arguments in TOOLS:
            self.tool(name, arguments)
        statements = self.statements()
        self.assertGreater(len(statements), 20, "the tools sent almost no SQL — did they run?")
        return statements

    # ------------------------------------------------------------ catalogue --
    def test_the_catalogue_is_fixed_and_no_tool_takes_sql(self):
        responses = self.call([{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
        tools = responses[0]["result"]["tools"]
        self.assertEqual(
            sorted(t["name"] for t in tools),
            sorted(name for name, _ in TOOLS),
        )
        for tool in tools:
            properties = tool["inputSchema"].get("properties", {})
            self.assertNotIn("sql", properties, f"{tool['name']} takes SQL")
            self.assertNotIn("query", properties, f"{tool['name']} takes a query")

    def test_a_trip_reference_is_the_only_free_text_that_reaches_sql(self):
        text, is_error = self.tool("trip_detail", {"trip": "japan'; DROP TABLE trips; --"})
        self.assertTrue(is_error)
        self.assertIn("trip id or slug", text)
        self.assertEqual(self.statements(), [], "a refused reference still ran a query")

    # -------------------------------------------------- what "live" means ----
    def test_every_live_interview_query_excludes_the_ones_already_closed(self):
        """`state` alone outlives the conversation: closure only sets expired_at."""
        for statement in self.all_statements():
            if "state = 'interviewing'" not in statement:
                continue
            self.assertIn(
                "expired_at IS NULL", statement,
                "a query treats a session closed for idleness as a live interview:\n" + statement,
            )

    def test_stuck_jobs_are_named_by_state_not_by_excluding_a_state_that_never_existed(self):
        self.tool("failures")
        joined = "\n".join(self.statements())
        self.assertNotIn("'completed'", joined)
        self.assertIn("j.state IN ('failed','cancelled')", joined)

    # ------------------------------------------------------- what it may read --
    def test_no_query_ever_selects_a_document_s_text(self):
        """Provenance is allowed; contents are not. char_length is the exception."""
        for statement in self.all_statements():
            for match in re.finditer(r"(?:\w+\.)?source_document->>'text'", statement):
                prefix = statement[: match.start()]
                self.assertTrue(
                    prefix.rstrip().endswith("char_length("),
                    "a query reads the text of an uploaded document:\n" + statement,
                )

    def test_no_query_reads_the_column_that_holds_the_site_password(self):
        """trips.companion_intro carries login_password in plain text."""
        for statement in self.all_statements():
            self.assertNotIn("companion_intro", statement)

    def test_the_site_url_comes_from_the_job_result(self):
        self.tool("trip_detail", {"trip": "japan-2026"})
        self.assertIn("result->>'private_url'", "\n".join(self.statements()))

    def test_people_are_never_selected_by_name(self):
        for statement in self.all_statements():
            for column in ("display_name", "participant_username", "telegram_user_id", "s.answers"):
                self.assertNotIn(column, statement, f"a query selects {column}:\n" + statement)

    # ------------------------------------------------------------- alerts ----
    def test_alerts_print_nothing_when_nothing_is_wrong(self):
        text, is_error = self.tool("alerts")
        self.assertFalse(is_error, text)
        self.assertEqual(text, "")

    def test_alerts_never_select_a_value_derived_from_now(self):
        """Hermes hashes these bytes: an elapsed time re-wakes the model hourly."""
        self.tool("alerts")
        for statement in self.statements():
            select_list = statement.split("FROM")[0]
            self.assertNotIn("now()", select_list, "alerts would print a moving value:\n" + statement)
            self.assertIn("ORDER BY", statement, "an alerts query has no stable row order:\n" + statement)

    # --------------------------------------------------------- failed reads --
    def test_a_failed_query_is_reported_as_a_failure_not_as_no_rows(self):
        text, is_error = self.tool("fleet_overview", env={"FLEET_TEST_FAIL": "1"})
        self.assertTrue(is_error)
        self.assertIn("Tool failed", text)
        self.assertNotIn("(none)", text)

    def test_the_cli_stays_silent_when_alerts_are_empty(self):
        proc = subprocess.run(
            [NODE, str(SERVER), "--tool", "alerts"],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, "KINERARY_FLEET_CONFIG": str(self.config),
                 "FLEET_TEST_SQL_LOG": str(self.log)},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "", "a watchdog would treat this as a change")


if __name__ == "__main__":
    unittest.main()
