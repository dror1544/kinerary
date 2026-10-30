"""The two Hermes log lines this repo reads as evidence, against the captured format (#380, AC-4b).

Two consumers parse Hermes' own log lines, and each copied the format by hand:

  * the release verify regex, `INTERVIEW_REGISTERED_RE` in
    `control-plane/deployment/vm-release.py`: "the gateway registered the
    interview MCP server's tools" (`MCP server '%s' (%s): registered %d tool(s): %s`);
  * the fleet monitor's tool-usage counter, `toolUsageScript` in
    `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`: "a tool ran"
    (`tool %s completed (%.2fs, %d chars)`).

A Hermes release that rewords either line breaks the consumer with nothing
failing - the release gate would read "no registration" as a broken gateway, the
monitor would report "no tool calls". `control-plane/api/test/fixtures/hermes-mirror.json`
holds the two formats as captured from Hermes' SOURCE
(`scripts/capture-hermes-mirror.py`); these tests render a line from each and
run the REAL consumer over it. Recapturing a Hermes whose format changed fails
here, naming the consumer.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURE = ROOT / "control-plane" / "api" / "test" / "fixtures" / "hermes-mirror.json"
VM_RELEASE = ROOT / "control-plane" / "deployment" / "vm-release.py"

sys.path.insert(0, str(HERE))
import test_fleet_mcp as fleet  # noqa: E402  (the harness that runs fleet-mcp.mjs for real)

FORMATS = json.loads(FIXTURE.read_text(encoding="utf-8"))["log_formats"]


def load_vm_release():
    """vm-release.py with its state directories pointed at a temp dir, under a name of its own."""
    tmp = tempfile.mkdtemp(prefix="hermes-log-formats-")
    env = {key: str(Path(tmp) / sub) for key, sub in (
        ("KINERARY_CP_STATE_DIR", "state"), ("KINERARY_CP_BACKUP_DIR", "backups"), ("KINERARY_CP_LOG_DIR", "log"))}
    with mock.patch.dict(os.environ, env):
        spec = importlib.util.spec_from_file_location("vm_release_log_formats", VM_RELEASE)
        module = importlib.util.module_from_spec(spec)
        sys.modules["vm_release_log_formats"] = module
        spec.loader.exec_module(module)
    return module, tmp


def hermes_log_line(day: str, logger: str, message: str, session: str = "20261030_100000_abcd1234") -> str:
    """The prefix Hermes' file handler puts on a line: timestamp, level, run id, logger name."""
    return f"{day} 10:00:00,001 INFO [{session}] {logger}: {message}"


class ReleaseVerifyRegex(unittest.TestCase):
    """AC-4b, half one: the release verify regex reads the captured registration format."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.vr, cls.tmp = load_vm_release()

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_a_registration_line_rendered_from_the_captured_format_matches(self):
        message = FORMATS["mcp_registered"] % ("interview", "stdio", 2, "ask_question_for_chat, show_summary_for_chat")
        line = hermes_log_line("2026-10-30", "tools.mcp_tool_discovery", message)
        self.assertTrue(
            self.vr.INTERVIEW_REGISTERED_RE.search(line),
            f"vm-release.py INTERVIEW_REGISTERED_RE no longer matches Hermes' registration line "
            f"{FORMATS['mcp_registered']!r}: `kinerary-cp-release verify` would read a healthy gateway as one that "
            f"never registered the interview tools. Rendered: {line!r}")

    def test_interview_registrations_counts_it_in_a_real_log_file(self):
        message = FORMATS["mcp_registered"] % ("interview", "stdio", 2, "a, b")
        other = FORMATS["mcp_registered"] % ("trip-mcp", "sse", 5, "a, b, c, d, e")
        log = Path(self.tmp) / "agent.log"
        log.write_text("\n".join([
            hermes_log_line("2026-10-30", "tools.mcp_tool_discovery", other),
            hermes_log_line("2026-10-30", "tools.mcp_tool_discovery", message),
            hermes_log_line("2026-10-30", "tools.mcp_tool_discovery", message),
        ]) + "\n", encoding="utf-8")
        self.assertEqual(self.vr.count_interview_registrations(log), 2,
                         "only the interview server's registrations count, and both of them do")

    def test_another_server_is_not_the_interview_server(self):
        message = FORMATS["mcp_registered"] % ("trip-mcp", "sse", 5, "a, b")
        self.assertFalse(self.vr.INTERVIEW_REGISTERED_RE.search(hermes_log_line("2026-10-30", "x", message)))


@unittest.skipUnless(fleet.NODE, "node is required to run fleet-mcp.mjs")
class FleetMonitorToolUsage(unittest.TestCase):
    """AC-4b, half two: the fleet monitor's tool-usage parser counts the captured completion format."""

    def setUp(self) -> None:
        # The existing harness, unchanged: a fleet-mcp.mjs over a real temp `hermes_logs_dir`.
        self.case = fleet.FleetMcp("test_tool_usage_counts_verbatim_production_lines")
        self.case.setUp()
        self.addCleanup(shutil.rmtree, self.case.tmp, ignore_errors=True)

    def usage_for(self, lines: list[str]) -> str:
        self.case.write_hermes_log("japan-2026", "agent.log", lines)
        self.case.configure_hermes_logs_dir(self.case.tmp / "hermes-logs")
        return self.case.tool_usage_text()

    def test_a_completion_line_rendered_from_the_captured_format_is_counted(self):
        today = date.today().isoformat()
        message = FORMATS["tool_completed"] % ("mcp__trip_mcp__get_today", 0.07, 594)
        text = self.usage_for([hermes_log_line(today, "agent.tool_executor", message)])
        self.assertIn(
            "mcp__trip_mcp__get_today: 1", text,
            f"fleet-mcp.mjs's tool-usage parser no longer counts Hermes' completion line "
            f"{FORMATS['tool_completed']!r}: the monitor would report 'no tool calls' for a companion that is "
            f"using its tools. Output: {text!r}")

    def test_the_captured_format_is_what_follows_the_parsers_marker(self):
        """The awk program anchors on `agent.tool_executor: tool ` and then needs `<name> completed`."""
        marker = "agent.tool_executor: tool "
        text = (ROOT / ".agents" / "skills" / "trip-fleet-monitor" / "fleet-mcp.mjs").read_text(encoding="utf-8")
        self.assertIn(f'const TOOL_LOG_MARKER = "{marker}"', text,
                      "TOOL_LOG_MARKER moved: update this test and the capture anchor together")
        self.assertTrue(FORMATS["tool_completed"].startswith("tool %s completed ("), FORMATS["tool_completed"])


if __name__ == "__main__":
    unittest.main()
