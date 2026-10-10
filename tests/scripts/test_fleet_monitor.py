""".agents/skills/trip-fleet-monitor — the fleet monitor's digest, watchdog and MCP.

Three properties a monitor has to have, each of which was missing once:

- A check that FAILED is not a healthy fleet. The digest used to swallow an
  alerts failure and print "Nothing needs attention".
- One stack's trip-class override stays on that stack. A development override
  used to classify production trips too, which could filter real alerts out.
- The watchdog's output is stable while nothing changes. Hermes hashes the
  exact bytes of a monitor script's output; an elapsed "idle 7h" re-ran the
  model every hour for the same stalled interview.

A fourth, added with the digest's layout: what arrives in Telegram must not be
boxed (code fences), quoted (a leading `>`) or italic where it meant bold
(`*Title*`), and Hermes's own "Cronjob Response" wrapper is switched off on the
monitor's profile by the bootstrap script. Measured 2026-09-28 against Hermes's
own converter; see `.agents/skills/trip-fleet-monitor/cron/kinerary_fleet_digest.sh`.

No database: the digest runs against a fake `node`, and the MCP against a fake
`psql` that records each SQL script it is handed and answers from fixtures.
"""
from __future__ import annotations

import json
import os
import re
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
BOOTSTRAP = ROOT / "scripts" / "bootstrap-fleet-monitor.sh"
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
[ -z "$FAKE_LOG" ] || echo "$*" >> "$FAKE_LOG"
case " $FAKE_FAIL " in *" $tool "*) echo "$tool: psql exited 2: connection refused" >&2; exit 1 ;; esac
case "$tool" in
  fleet_overview) echo "TRIPS BY CLASS AND STAGE" ;;
  statistics) echo "FUNNEL" ;;
  alerts) printf '%s' "$FAKE_ALERTS" ;;
esac
"""

    def run_digest(self, fail: str = "", alerts: str = "", log: Path | None = None) -> subprocess.CompletedProcess:
        tmp = Path(tempfile.mkdtemp())
        node = executable(tmp / "node", self.FAKE_NODE)
        env = {**os.environ, "KINERARY_NODE_BIN": str(node), "KINERARY_FLEET_MCP": "/fake/fleet-mcp.mjs",
               "FAKE_FAIL": fail, "FAKE_ALERTS": alerts, "FAKE_LOG": str(log or "")}
        return subprocess.run(["/bin/bash", str(DIGEST)], capture_output=True, text=True, env=env, timeout=30)

    def test_every_section_asks_for_the_compact_rendering(self):
        """Not the agent's text in a code fence: the digest form of each tool."""
        log = Path(tempfile.mkdtemp()) / "calls"
        proc = self.run_digest(log=log)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            sorted(log.read_text().splitlines()),
            sorted([
                "/fake/fleet-mcp.mjs --tool fleet_overview --format digest",
                "/fake/fleet-mcp.mjs --tool statistics --days 7 --format digest",
                "/fake/fleet-mcp.mjs --tool alerts --format digest",
            ]),
        )

    def test_the_digest_script_writes_no_fence_and_no_single_asterisk_title(self):
        proc = self.run_digest(alerts="**⚠️ Needs attention**\n• x — y")
        self.assertNotIn("```", proc.stdout)
        self.assertNotRegex(proc.stdout, r"(?m)^\*[^*]", "a single-asterisk title renders as italic")
        self.assertTrue(proc.stdout.startswith("**📋 Kinerary daily digest — "), proc.stdout[:60])

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
        if rows == "FAIL":
            sys.stderr.write('ERROR:  relation "control_plane.jobs" does not exist\\n')
            sys.exit(1)
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


#: Enough of production (2026-09-28) to fill every section. Ordered: the first
#: marker found in a statement answers it. "FAIL" makes that statement crash.
DIGEST_FIXTURES = {
    "to_regclass": [["t"]],
    "FROM control_plane.trips t GROUP BY 1,2": [
        ["live", "ready_private", "2"], ["prospect", "draft", "6"], ["prospect", "intake_confirmed", "2"],
        ["prospect", "intake_in_progress", "3"], ["retired", "draft", "9"], ["retired", "ready_private", "30"]],
    "SELECT j.job_type, j.state": [["provision", "cancelled", "1"], ["provision", "failed", "1"],
                                   ["provision", "succeeded", "34"]],
    "n.state = 'failed' GROUP BY 1,2,3": [["retired", "companion_ready", "failed", "16"]],
    "round(max(": [["prospect", "3", "395"]],
    "ORDER BY t.updated_at;": [["draft-sreq-aaaa", "prospect", "intake_confirmed", "16d"]],
    "interview_enrollments e\n": [["prospect", "opened", "4"]],
    "'trips created'": [["trips created", "3"], ["interview links issued", "5"], ["links opened", "4"],
                        ["interviews started", "3"], ["interviews confirmed", "1"], ["open right now", "8"]],
    "SELECT j.state, count(*)::text": [["succeeded", "1"]],
    "'build minutes": [["build minutes (median, to last heartbeat)", "2"], ["interview minutes (median)", "22"]],
    "WHERE t.created_at >": [["live", "1"], ["prospect", "2"]],
    "interview_interpretations\n": [["succeeded", "20"]],
    "intake_versions": [["draft-sreq-aaaa", "intake_confirmed", "2026-09-11 18:40 UTC"]],
}


@unittest.skipUnless(NODE, "node is not installed")
class DigestEndToEnd(unittest.TestCase):
    """The real script over the real MCP, over a stand-in `psql`.

    What Telegram receives is decided by the bytes this prints, so they are read
    here rather than inferred from the parts.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.psql = executable(self.tmp / "psql.py", FleetMcp.FAKE_PSQL)
        self.log = self.tmp / "sql.log"
        self.fixtures = self.tmp / "fixtures.json"
        self.config = self.tmp / "fleet-stacks.json"
        self.config.write_text(json.dumps({"default_stack": "prod", "stacks": {"prod": {
            "label": "the control plane", "production": True,
            "argv": [sys.executable, str(self.psql), str(self.log), "prod", str(self.fixtures)]}}}))

    def run_digest(self, fixtures: dict) -> subprocess.CompletedProcess:
        self.fixtures.write_text(json.dumps(fixtures))
        env = {**os.environ, "KINERARY_FLEET_CONFIG": str(self.config), "KINERARY_FLEET_MCP": str(FLEET),
               "KINERARY_NODE_BIN": NODE}
        env.pop("KINERARY_FLEET_STACK", None)
        return subprocess.run(["/bin/bash", str(DIGEST)], capture_output=True, text=True, env=env, timeout=90)

    def test_the_message_has_bold_titles_and_nothing_telegram_draws_as_a_box(self):
        proc = self.run_digest(DIGEST_FIXTURES)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = proc.stdout
        self.assertNotIn("```", out, "a code fence is drawn as a box")
        self.assertNotIn("|", out, "a pipe table needs a fence to keep its columns")
        for line in out.splitlines():
            self.assertFalse(line.startswith(">"), f"a leading '>' is a block quote: {line!r}")
        self.assertNotIn("*", re.sub(r"\*\*[^*\n]+\*\*", "", out), "a lone asterisk renders as italic")
        for title in ("**📋 Kinerary daily digest", "**Trips**", "**Provisioning**", "**Last 7 days**",
                      "**⚠️ Needs attention**"):
            self.assertIn(title, out)
        self.assertLess(len(out.encode("utf-16-le")) // 2, 3500, "would not arrive as one message")

    def test_each_section_s_numbers_survive_into_the_message(self):
        out = self.run_digest(DIGEST_FIXTURES).stdout
        for expected in (
            "the control plane\n\n**Trips**",
            "• live: 2 ready",
            "• prospect: 6 draft · 2 confirmed · 3 interviewing",
            "• retired: 39 (test runs, ignore)",
            "34 succeeded · 1 failed · 1 cancelled",
            "• retired: companion_ready ×16 (test runs, ignore)",
            "• prospect: 3 (longest idle 395h)",
            "**Unreachable**: none",
            "• draft-sreq-aaaa — prospect, confirmed, waiting 16d",
            "• trips created: 3 (live 1 · prospect 2",
            "3 started · 1 confirmed (33%)",
            "build success 100%",
            "build 2 min · interview 22 min",
            "• confirmed, never built: draft-sreq-aaaa — confirmed 2026-09-11 18:40 UTC",
        ):
            self.assertIn(expected, out)

    def test_a_section_that_cannot_be_read_says_so_and_the_others_still_run(self):
        proc = self.run_digest({**DIGEST_FIXTURES, "'trips created'": "FAIL"})
        self.assertNotEqual(proc.returncode, 0, "a broken section must fail the job so Hermes says so")
        self.assertIn("❌ Statistics could not be read:", proc.stdout)
        self.assertIn("does not exist", proc.stdout, "the reason is on the page")
        self.assertIn("**Trips**", proc.stdout, "the overview still ran")
        self.assertIn("**⚠️ Needs attention**", proc.stdout, "the alerts still ran")
        self.assertNotIn("**Last 7 days**", proc.stdout)

    def test_an_unreadable_alerts_check_is_never_reported_as_a_quiet_fleet(self):
        proc = self.run_digest({**DIGEST_FIXTURES, "intake_versions": "FAIL"})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("❌ **Fleet health could NOT be checked**", proc.stdout)
        self.assertNotIn("Nothing needs attention", proc.stdout)

    def test_a_quiet_fleet_says_so_only_because_the_check_ran(self):
        proc = self.run_digest({k: v for k, v in DIGEST_FIXTURES.items() if k != "intake_versions"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("✅ Nothing needs attention.", proc.stdout)


class BootstrapWrapResponse(unittest.TestCase):
    """The monitor's profile delivers its digest without Hermes's cron wrapper.

    `hermes cron` wraps every delivery in "Cronjob Response: <name> (job_id: …)
    … To stop or manage this job, send me a new message" unless
    `cron.wrap_response` is false. The behaviour of `hermes config get/set` the
    script leans on was read from the real CLI on a scratch HERMES_HOME on
    2026-09-28: `get` prints the effective value (`true` on a fresh profile,
    `false` once set), `set` writes the profile's config.yaml, and a profile
    that does not exist is an error. This stand-in reproduces exactly that.
    """

    FAKE_HERMES = """#!/bin/sh
echo "$*" >> "$FAKE_HERMES_STATE/calls"
[ "$1" = "--version" ] && { echo "fake hermes"; exit 0; }
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then mkdir -p "$HERMES_HOME/profiles/$3"; exit 0; fi
if [ "$1" = "--profile" ]; then
  profile="$2"; shift 2
  [ -d "$HERMES_HOME/profiles/$profile" ] || { echo "Error: Profile '$profile' does not exist." >&2; exit 1; }
  cfg="$FAKE_HERMES_STATE/cfg-$profile-$3"
  case "$1 $2" in
    "config get") if [ -f "$cfg" ]; then cat "$cfg"; else echo true; fi; exit 0 ;;
    "config set") [ -n "$FAKE_HERMES_IGNORE_SET" ] || echo "$4" > "$cfg"; echo "Set $3 = $4"; exit 0 ;;
    "mcp list") cat "$FAKE_HERMES_STATE/mcp" 2>/dev/null; exit 0 ;;
    "mcp add") echo "$3" >> "$FAKE_HERMES_STATE/mcp"; exit 0 ;;
  esac
fi
exit 0
"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.state = self.tmp / "state"
        self.state.mkdir()
        self.home = self.tmp / "hermes-home"
        (self.home / "profiles" / "trip-monitor").mkdir(parents=True)
        self.hermes = executable(self.tmp / "hermes", self.FAKE_HERMES)

    def bootstrap(self, *flags: str, ignore_set: bool = False) -> subprocess.CompletedProcess:
        env = {**os.environ, "HERMES_HOME": str(self.home), "HERMES_EXEC": str(self.hermes),
               "FAKE_HERMES_STATE": str(self.state), "FLEET_DB_URL": "postgres://nobody@127.0.0.1:1/none",
               "FAKE_HERMES_IGNORE_SET": "1" if ignore_set else ""}
        for name in ("MONITOR_DELIVER", "MONITOR_DELIVER_FILE", "MONITOR_ISSUE_TARGET", "MONITOR_OWNER"):
            env.pop(name, None)
        return subprocess.run(["/bin/bash", str(BOOTSTRAP), *flags], capture_output=True, text=True, env=env,
                              timeout=120)

    def calls(self) -> list[str]:
        path = self.state / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def sets(self) -> list[str]:
        return [c for c in self.calls() if " config set " in f" {c} "]

    def test_check_reports_the_wrapper_as_missing_and_changes_nothing(self):
        proc = self.bootstrap("--check")
        self.assertIn("MISSING: cron.wrap_response = false", proc.stdout + proc.stderr)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(self.sets(), [], "--check must not write")
        self.assertEqual(list(self.state.glob("cfg-*")), [], "--check changed the profile's config")

    def test_bootstrap_switches_the_wrapper_off_once(self):
        first = self.bootstrap()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.sets(), ["--profile trip-monitor config set cron.wrap_response false"])
        self.assertEqual((self.state / "cfg-trip-monitor-cron.wrap_response").read_text().strip(), "false")

    def test_a_second_run_finds_it_done_and_writes_nothing(self):
        self.bootstrap()
        second = self.bootstrap()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(len(self.sets()), 1, "the second run set it again")
        self.assertIn("cron.wrap_response is false", second.stdout)

    def test_check_after_bootstrap_no_longer_lists_it(self):
        self.bootstrap()
        proc = self.bootstrap("--check")
        self.assertNotIn("cron.wrap_response", proc.stderr, "still reported missing after it was set")

    def test_a_set_that_did_not_take_is_loud(self):
        proc = self.bootstrap(ignore_set=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("still not false", proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()
