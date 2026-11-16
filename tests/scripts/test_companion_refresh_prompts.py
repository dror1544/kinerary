"""scripts/companion-refresh-prompts.sh — clear a companion's saved prompts, restart its gateway, and say whether it
came back with its tools (#568 slice R2, AC-15 and AC-16).

  AC-15  a turn in flight is WAITED for, for a bounded time, and when the time is up the script gives up with nothing
         cleared and the gateway untouched — it never restarts under a reply
  AC-16  with the bridge's source named, every tool it declares must be on a registration line the gateway wrote to ITS OWN
         log after the restart; a missing one is a failure that names it, and a line from before the restart is not evidence
         (`--dry-run` changes nothing)

Nothing real is touched. HOME is a temp directory holding a profile with a real SQLite `state.db`; `uname` says which
platform's branch runs; `launchctl` (macOS) and `docker` (the VM's container) are stand-ins that record what they were
asked and, like a gateway, write a registration line to the profile's log when they start it.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "companion-refresh-prompts.sh"
REAL_BRIDGE = REPO / "mcp" / "mcp.js"
PROFILE = "tripcompanion"

# A bridge's source in the shapes the real one uses: a call on one line, a call wrapped onto its own line, a tool named
# in a comment and in prose that must not count.
BRIDGE = """\
const mcp = guardTools(new McpServer({ name: 'trip-mcp' }));
// mcp.tool('commented_out', 'never registered', {}, handler)
mcp.tool('get_config', 'Get the trip config', {}, async () => ok({}));
mcp.tool(
  'get_today',
  'Today', {}, async () => ok({}));
mcp.registerTool("set_things", {}, async () => ok({}));
const note = "call mcp_tool_not_a_registration in prose";
"""
TOOLS = ["get_config", "get_today", "set_things"]


def registration(server: str, tools: list[str], count: int | None = None) -> str:
    """The line Hermes logs when a gateway registers a server's tools (captured format: test_hermes_log_formats.py)."""
    prefix = "mcp__" + server.replace("-", "_") + "__"
    return (f"2026-11-16 10:00:00,001 INFO [20261116_100000_abcd1234] tools.mcp_tool: MCP server '{server}' (HTTP): "
            f"registered {len(tools) if count is None else count} tool(s): " + ", ".join(prefix + t for t in tools))


def exe(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class Refresh(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.bin = self.root / "bin"
        self.fake = self.root / "fake"
        for d in (self.home, self.bin, self.fake):
            d.mkdir()
        self.profile_dir = self.home / ".hermes" / "profiles" / PROFILE
        (self.profile_dir / "logs").mkdir(parents=True)
        self.log = self.profile_dir / "logs" / "agent.log"
        self.log.write_text("old line one\nold line two\n")
        self.db = self.profile_dir / "state.db"
        self.make_db(self.db)
        self.calls = self.fake / "calls"
        self.registration = self.fake / "registration"      # what a gateway writes to its log when it comes up
        self.registration.write_text("")
        # The host python of the Mac branch is Hermes's venv python.
        venv = self.home / ".hermes" / "hermes-agent" / "venv" / "bin"
        venv.mkdir(parents=True)
        (venv / "python").symlink_to(sys.executable)
        (self.bin / "python3").symlink_to(sys.executable)
        self.bridge = self.root / "mcp.js"
        self.bridge.write_text(BRIDGE)
        self.mac()

    # -- the platform stand-ins

    def probe_lock(self) -> str:
        """Shell text: ask the profile's database for its write lock without waiting, and record what was said."""
        return (f'"{self.bin}/python3" -c "import sqlite3,sys\n'
                "db = sqlite3.connect(sys.argv[1], timeout=0)\n"
                "try:\n    db.execute('BEGIN IMMEDIATE'); print('FREE')\n"
                f"except sqlite3.OperationalError:\n    print('LOCKED')\" \"{self.db}\" >> \"{self.fake}/locks\"\n")

    def mac(self) -> None:
        exe(self.bin / "uname", "#!/bin/sh\necho Darwin\n")
        exe(self.bin / "launchctl",
            f'#!/bin/sh\necho "launchctl $*" >> "{self.calls}"\n'
            + self.probe_lock() +
            f'[ -f "{self.fake}/slow-restart" ] && sleep 4\n'
            f'[ -f "{self.fake}/fail-restart" ] && exit 1\n'
            f'cat "{self.registration}" >> "{self.log}"\nexit 0\n')

    def linux(self) -> None:
        """`docker exec hermes ...`: the container's /opt/data is a directory of the sandbox, and a command run
        'inside' it is run here with paths mapped."""
        data = self.root / "opt-data"
        (data / "profiles").mkdir(parents=True, exist_ok=True)
        if not (data / "profiles" / PROFILE).exists():
            (data / "profiles" / PROFILE).symlink_to(self.profile_dir)
        exe(self.bin / "uname", "#!/bin/sh\necho Linux\n")
        exe(self.bin / "docker", f'''#!{sys.executable}
import os, subprocess, sys
args = sys.argv[1:]
assert args[0] == "exec", args
args = args[1:]
if args and args[0] == "-i":
    args = args[1:]
container, cmd = args[0], args[1:]
def mapped(a):
    return a.replace("/opt/data", {str(data)!r})
with open({str(self.calls)!r}, "a") as f:
    f.write("docker exec " + " ".join(cmd[:2]) + "\\n")
if cmd[0] == "hermes":
    with open({str(self.calls)!r}, "a") as f:
        f.write("hermes " + " ".join(cmd[1:]) + "\\n")
    import sqlite3
    try:
        sqlite3.connect({str(self.db)!r}, timeout=0).execute("BEGIN IMMEDIATE")
        verdict = "FREE"
    except sqlite3.OperationalError:
        verdict = "LOCKED"
    open({str(self.fake / "locks")!r}, "a").write(verdict + "\\n")
    if "start" in cmd:
        if os.path.exists({str(self.fake / "fail-restart")!r}):
            sys.exit(1)
        open({str(self.log)!r}, "a").write(open({str(self.registration)!r}).read())
    sys.exit(0)
sys.exit(subprocess.run([mapped(a) for a in cmd], stdin=sys.stdin).returncode)
''')

    # -- the profile's database

    @staticmethod
    def make_db(path: Path) -> None:
        db = sqlite3.connect(path)
        db.executescript("""
            CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, system_prompt TEXT, system_prompt_hash TEXT, ended_at REAL);
            CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, body TEXT);
            CREATE TABLE session_turn_leases (session_id TEXT, expires_at TEXT);
            CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);
            INSERT INTO system_prompts VALUES ('h1', 'old soul one'), ('h2', 'old soul two'), ('h3', 'an ended conversation');
            INSERT INTO sessions VALUES ('open-group', 'family group', 'old soul one', 'h1', NULL),
                                        ('open-dm', 'organizer dm', 'old soul two', 'h2', NULL),
                                        ('ended', 'last month', 'an ended conversation', 'h3', 1.0);
            INSERT INTO messages(session_id, content) VALUES ('open-group', 'where is dinner?'), ('open-dm', 'remember the allergy'),
                                                              ('ended', 'goodbye');
        """)
        db.commit()
        db.close()

    def lease(self, seconds_from_now: float) -> None:
        db = sqlite3.connect(self.db)
        db.execute("INSERT INTO session_turn_leases VALUES ('open-group', ?)", (str(time.time() + seconds_from_now),))
        db.commit()
        db.close()

    def rows(self) -> dict:
        db = sqlite3.connect(self.db)
        try:
            return {"sessions": db.execute("SELECT * FROM sessions ORDER BY id").fetchall(),
                    "prompts": db.execute("SELECT * FROM system_prompts ORDER BY hash").fetchall(),
                    "messages": db.execute("SELECT * FROM messages ORDER BY id").fetchall()}
        finally:
            db.close()

    # -- running it

    def run_script(self, *args: str, poll: str = "1", timeout: int = 90, env_extra: dict | None = None) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin", "TMPDIR": str(self.root),
               "KINERARY_REFRESH_POLL_SECONDS": poll, **(env_extra or {})}
        return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=timeout)

    def restarted(self) -> bool:
        return self.calls.exists() and bool(self.calls.read_text().strip())

    def gateway_says(self, *lines: str) -> None:
        self.registration.write_text("\n".join(lines) + "\n")

    # -- what it did before this change, still does

    def test_it_clears_open_conversations_prompts_restarts_the_gateway_and_keeps_history(self) -> None:
        before = self.rows()
        result = self.run_script(PROFILE)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(f"REFRESHED {PROFILE} prompts=2 tools=skipped", result.stdout.strip())
        after = self.rows()
        self.assertEqual(before["messages"], after["messages"], "history is untouched")
        self.assertEqual([("ended", "last month", "an ended conversation", "h3", 1.0)],
                         [r for r in after["sessions"] if r[0] == "ended"], "an ended conversation is left as it was")
        self.assertEqual([None, None], [r[2] for r in after["sessions"] if r[0].startswith("open")])
        self.assertEqual([("h3", "an ended conversation")], after["prompts"], "saved prompts nothing refers to any more are dropped")
        self.assertIn(f"kickstart -k gui/{os.getuid()}/ai.hermes.gateway-{PROFILE}", self.calls.read_text())

    def test_the_names_that_become_paths_are_checked(self) -> None:
        for args in (("../x",), ("a b",), ("",), ("--bogus", PROFILE), (PROFILE, "second"), ("--wait", "soon", PROFILE),
                     ("--wait", "99999", PROFILE), ("--server", "a b", PROFILE)):
            with self.subTest(args):
                result = self.run_script(*args)
                self.assertEqual(2, result.returncode, result.stderr)
                self.assertFalse(self.restarted())

    # -- review round 1: a turn cannot start between the check and the restart

    def locks(self) -> list:
        p = self.fake / "locks"
        return p.read_text().split() if p.exists() else []

    def test_the_database_stays_write_locked_until_the_gateway_has_been_restarted(self) -> None:
        # The check for turns in flight and the restart used to be separated by a COMMIT: a turn that began in that gap was
        # cut by the restart. The lock is held across it, so a starting turn cannot take its lease until the restart is done.
        result = self.run_script(PROFILE)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(["LOCKED"], self.locks(), "at the moment of the restart nobody else could write")
        db = sqlite3.connect(self.db, timeout=0)
        db.execute("BEGIN IMMEDIATE")           # and afterwards it is free again
        db.rollback()
        db.close()
        self.assertEqual([None, None], [r[2] for r in self.rows()["sessions"] if r[0].startswith("open")])

    def test_the_lock_is_held_across_the_restart_on_the_container_platform_too(self) -> None:
        self.linux()
        result = self.run_script(PROFILE)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(["LOCKED", "LOCKED"], self.locks(), "both the stop and the start ran under the lock")

    def test_a_restart_that_outlasts_the_hold_cannot_hold_the_lock_for_ever(self) -> None:
        # A gateway that needs the database to stop would wait on this lock: the hold is bounded, then the lock is let go.
        (self.fake / "slow-restart").write_text("")
        started = time.time()
        result = self.run_script(PROFILE, env_extra={"KINERARY_REFRESH_HOLD_SECONDS": "1"}, timeout=60)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertLess(time.time() - started, 40)
        db = sqlite3.connect(self.db, timeout=0)
        db.execute("BEGIN IMMEDIATE")
        db.rollback()
        db.close()

    def test_a_failed_restart_still_lets_the_lock_go(self) -> None:
        (self.fake / "fail-restart").write_text("")
        result = self.run_script(PROFILE)
        self.assertEqual(2, result.returncode)
        db = sqlite3.connect(self.db, timeout=0)
        db.execute("BEGIN IMMEDIATE")
        db.rollback()
        db.close()

    def test_a_restart_that_fails_after_the_clear_says_what_was_done(self) -> None:
        (self.fake / "fail-restart").write_text("")
        result = self.run_script(PROFILE)
        self.assertEqual(2, result.returncode)
        self.assertIn("cleared 2 prompt(s) but could not restart", result.stderr)

    # -- AC-15: a turn in flight is waited for, boundedly, and never cut

    def test_a_turn_in_flight_for_longer_than_the_wait_is_not_cut_and_nothing_is_cleared(self) -> None:
        self.lease(600)
        before = self.rows()
        started = time.time()
        result = self.run_script("--wait", "3", PROFILE)
        elapsed = time.time() - started
        self.assertEqual(3, result.returncode, result.stderr)
        self.assertIn("still in flight after waiting 3s", result.stderr)
        self.assertGreaterEqual(elapsed, 3, "it waited the time it was given")
        self.assertLess(elapsed, 30, "and no longer: the wait is bounded")
        self.assertEqual(before, self.rows(), "nothing was cleared")
        self.assertFalse(self.restarted(), "the gateway was not restarted under the turn")

    def test_a_turn_that_ends_during_the_wait_lets_the_refresh_through(self) -> None:
        self.lease(2.5)
        started = time.time()
        result = self.run_script("--wait", "40", PROFILE)
        elapsed = time.time() - started
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertGreaterEqual(elapsed, 1.5, "it waited for the lease to lapse rather than refusing at once")
        self.assertEqual([None, None], [r[2] for r in self.rows()["sessions"] if r[0].startswith("open")])
        self.assertTrue(self.restarted())

    def test_with_no_wait_given_the_default_is_bounded_and_not_zero(self) -> None:
        # The default must exist and be finite: read it off the script rather than waiting two minutes.
        text = SCRIPT.read_text()
        self.assertRegex(text, r'WAIT="\$\{KINERARY_REFRESH_WAIT_SECONDS:-[1-9][0-9]*\}"')
        self.assertIn("capped at 3600", text)

    def test_wait_zero_refuses_at_once_as_before(self) -> None:
        self.lease(600)
        started = time.time()
        result = self.run_script("--wait", "0", PROFILE)
        self.assertEqual(3, result.returncode)
        self.assertLess(time.time() - started, 10)
        self.assertFalse(self.restarted())

    def test_the_same_on_the_container_platform(self) -> None:
        self.linux()
        self.lease(600)
        before = self.rows()
        result = self.run_script("--wait", "2", PROFILE)
        self.assertEqual(3, result.returncode, result.stderr)
        self.assertEqual(before, self.rows())
        self.assertNotIn("gateway", self.calls.read_text() if self.calls.exists() else "")

    # -- --dry-run

    def test_dry_run_reports_and_changes_nothing(self) -> None:
        self.lease(600)
        before = (self.rows(), self.log.read_text(), self.db.read_bytes())
        result = self.run_script("--dry-run", PROFILE)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(f"DRYRUN {PROFILE} turns_in_flight=1 prompts=2", result.stdout.strip())
        self.assertEqual(before, (self.rows(), self.log.read_text(), self.db.read_bytes()))
        self.assertFalse(self.restarted())

    def test_dry_run_with_a_quiet_profile_says_zero_in_flight(self) -> None:
        result = self.run_script("--dry-run", PROFILE)
        self.assertEqual(f"DRYRUN {PROFILE} turns_in_flight=0 prompts=2", result.stdout.strip())

    def test_dry_run_of_a_profile_whose_database_cannot_be_opened_says_so_and_changes_nothing(self) -> None:
        self.db.unlink()
        result = self.run_script("--dry-run", PROFILE)
        self.assertEqual(4, result.returncode)
        self.assertIn("cannot open", result.stderr)
        self.assertFalse(self.restarted())

    def test_dry_run_still_reads_the_bridge_source_so_a_bad_one_is_found_before_anything_is_touched(self) -> None:
        self.bridge.write_text("// nothing declared here\n")
        result = self.run_script("--dry-run", "--expect-tools-from", str(self.bridge), PROFILE)
        self.assertEqual(6, result.returncode)

    # -- AC-16: the gateway's own log says every declared tool is registered

    def test_every_declared_tool_registered_after_the_restart_is_confirmed_from_the_gateways_own_log(self) -> None:
        self.gateway_says(registration("trip-mcp", TOOLS))
        result = self.run_script("--expect-tools-from", str(self.bridge), "--registration-wait", "20", PROFILE)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(f"REFRESHED {PROFILE} prompts=2 tools=3", result.stdout.strip(),
                         "three declared: the call on one line, the wrapped call, and registerTool; the commented-out one is not")

    def test_a_tool_the_gateway_did_not_register_fails_the_refresh_and_is_named(self) -> None:
        self.gateway_says(registration("trip-mcp", ["get_config", "set_things"], count=2))
        started = time.time()
        result = self.run_script("--expect-tools-from", str(self.bridge), "--registration-wait", "3", PROFILE)
        self.assertEqual(5, result.returncode, result.stdout)
        self.assertIn("get_today", result.stderr)
        self.assertNotIn("get_config", result.stderr.split("within")[1], "only what is missing is named")
        self.assertLess(time.time() - started, 40, "the wait for registration is bounded too")
        self.assertNotIn("REFRESHED", result.stdout)

    def test_a_registration_from_before_the_restart_is_not_evidence(self) -> None:
        # The gateway that was just restarted may have registered everything an hour ago; what counts is what it
        # registered since. This one says nothing after the restart.
        with self.log.open("a") as fh:
            fh.write(registration("trip-mcp", TOOLS) + "\n")
        result = self.run_script("--expect-tools-from", str(self.bridge), "--registration-wait", "2", PROFILE)
        self.assertEqual(5, result.returncode)
        self.assertIn("no registration line", result.stderr)

    def test_another_servers_registration_is_not_this_servers(self) -> None:
        self.gateway_says(registration("interview", TOOLS), registration("trip-control", TOOLS))
        result = self.run_script("--expect-tools-from", str(self.bridge), "--registration-wait", "2", PROFILE)
        self.assertEqual(5, result.returncode)

    def test_a_longer_tool_name_does_not_stand_in_for_a_shorter_one(self) -> None:
        self.gateway_says(registration("trip-mcp", ["get_config", "get_today_extra", "set_things"]))
        result = self.run_script("--expect-tools-from", str(self.bridge), "--registration-wait", "2", PROFILE)
        self.assertEqual(5, result.returncode)
        self.assertIn("get_today", result.stderr)

    def test_the_server_is_named_by_the_caller(self) -> None:
        self.gateway_says(registration("other-bridge", TOOLS))
        ok = self.run_script("--expect-tools-from", str(self.bridge), "--server", "other-bridge", "--registration-wait", "20", PROFILE)
        self.assertEqual(0, ok.returncode, ok.stderr)

    def test_a_bridge_source_that_cannot_be_read_stops_the_run_before_anything_is_touched(self) -> None:
        before = self.rows()
        for label, path in (("absent", self.root / "nope.js"), ("declares nothing", self.bridge)):
            if label == "declares nothing":
                self.bridge.write_text("const x = 1;\n")
            with self.subTest(label):
                result = self.run_script("--expect-tools-from", str(path), PROFILE)
                self.assertEqual(6, result.returncode, result.stderr)
                self.assertEqual(before, self.rows(), "the prompts are still there")
                self.assertFalse(self.restarted())

    def test_the_tools_the_real_bridge_declares_are_all_found(self) -> None:
        declared = re.findall(r"^mcp\.tool\(\s*'([A-Za-z0-9_]+)'", REAL_BRIDGE.read_text(), re.M)
        self.assertGreater(len(declared), 40, "the real bridge declares dozens of tools; the fixture check is not vacuous")
        self.gateway_says(registration("trip-mcp", declared))
        result = self.run_script("--expect-tools-from", str(REAL_BRIDGE), "--registration-wait", "20", PROFILE)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertRegex(result.stdout.strip(), rf"tools=\d+$")
        self.assertGreaterEqual(int(result.stdout.strip().rsplit("=", 1)[1]), len(set(declared)))
        # and a gateway that lost any one of them is caught
        for victim in (declared[0], declared[-1]):
            self.setUp()
            self.gateway_says(registration("trip-mcp", [t for t in declared if t != victim]))
            missed = self.run_script("--expect-tools-from", str(REAL_BRIDGE), "--registration-wait", "2", PROFILE)
            self.assertEqual(5, missed.returncode, victim)
            self.assertIn(victim, missed.stderr)

    def test_the_tool_wait_works_on_the_container_platform_too(self) -> None:
        self.linux()
        self.gateway_says(registration("trip-mcp", TOOLS))
        result = self.run_script("--expect-tools-from", str(self.bridge), "--registration-wait", "20", PROFILE)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(f"REFRESHED {PROFILE} prompts=2 tools=3", result.stdout.strip())
        self.assertIn("hermes -p tripcompanion gateway start", self.calls.read_text())
        self.gateway_says(registration("trip-mcp", ["get_config"]))
        missed = self.run_script("--expect-tools-from", str(self.bridge), "--registration-wait", "2", PROFILE)
        self.assertEqual(5, missed.returncode)


if __name__ == "__main__":
    unittest.main()
