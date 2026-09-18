"""scripts/companion-install-host.sh — the trip-mcp bridge request.

This script is the forced command for the worker's SSH key: a trust boundary.
The bridge request (2026-09-11) carries a slug and a profile name; everything
else — the site's address, the container, the port — must come from THIS
host's own topology.yaml, never from the request. These tests run the real
script in a sandboxed HOME with a stand-in setup-mcp.sh that records exactly
what it was handed.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "companion-install-host.sh"

TOPOLOGY = """\
version: 1
name: italy-2026
proxmox:
  node: proxmox
  vmid: '104'
  lxc:
    name: trip-italy-2026
    ipv4: 192.168.0.61/24
npm:
  hostname: italy-2026.ara-united.store
  forward_host: 192.168.0.61
  forward_port: 8080
"""


class BridgeRequest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / ".local/bin").mkdir(parents=True)
        self._exe(self.home / ".local/bin/hermes", "#!/bin/sh\nexit 0\n")
        # find_yaml_python looks for the Hermes venv first: point it at a python
        # that has PyYAML (this test's own interpreter).
        venv = self.home / ".hermes/hermes-agent/venv/bin"
        venv.mkdir(parents=True)
        (venv / "python3").symlink_to(sys.executable)
        (venv / "python").symlink_to(sys.executable)
        (self.home / ".hermes/profiles/italy2026").mkdir(parents=True)
        # After wiring, the script restarts the gateway and waits for the
        # gateway's OWN log to say it registered trip-mcp tools (c430f8e). A
        # stand-in for each way it starts one — launchctl on macOS, the
        # `hermes` s6 wrapper elsewhere — writes that line the way a real
        # gateway would. They come first on PATH, so a test run never loads a
        # real launchd job.
        registered = ('mkdir -p "$HOME/.hermes/profiles/italy2026/logs"; '
                      "echo \"INFO tools.mcp_tool: MCP server 'trip-mcp' (HTTP): registered 44 tool(s)\" "
                      '>> "$HOME/.hermes/profiles/italy2026/logs/agent.log"')
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self._exe(self.bin / "launchctl", f'#!/bin/sh\n[ "$1" = bootstrap ] && {{ {registered}; }}\nexit 0\n')
        self._exe(self.bin / "hermes", f'#!/bin/sh\ncase "$*" in *"gateway start"*) {registered};; esac\nexit 0\n')
        self.deploy = self.home / "kinerary-deploy"
        (self.deploy / "trips/italy-2026").mkdir(parents=True)
        (self.deploy / "trips/italy-2026/topology.yaml").write_text(TOPOLOGY)
        self.calls = self.home / "setup-mcp.calls"
        self._exe(self.deploy / "setup-mcp.sh",
                  f'#!/bin/sh\necho "REPO_ROOT=$REPO_ROOT $*" >> "{self.calls}"\nexit 0\n')
        # Before printing WIRED the script asks the bridge whether it can reach
        # the trip (/health). Nothing listens on :3104 in a sandbox, so a
        # stand-in curl answers for it — healthy by default, and each test that
        # cares rewrites it. Same shape as the launchctl/hermes stand-ins above.
        self.health = self.home / "health.json"
        self.health.write_text('{"ok":true,"site":"reachable"}')
        # /health is behind the MCP key, so the trip carries one the way a real
        # one does. The stand-in curl records how it was called — argv and
        # stdin kept apart, because which of the two the key travels in is the
        # difference between a secret and a line in `ps`.
        (self.deploy / "trips/italy-2026/mcp").mkdir(parents=True, exist_ok=True)
        (self.deploy / "trips/italy-2026/mcp/.env").write_text(
            "MCP_API_KEY=s3cret-mcp-key\nTRIP_API_KEY=s3cret-trip-key\n")
        self.curl_argv = self.home / "curl.argv"
        self.curl_stdin = self.home / "curl.stdin"
        self._exe(self.bin / "curl",
                  f'#!/bin/sh\necho "$*" >> "{self.curl_argv}"\ncat >> "{self.curl_stdin}"\ncat "{self.health}"\n')

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def _exe(path: Path, body: str) -> None:
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def send(self, request: dict) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin"}
        return subprocess.run(["bash", str(SCRIPT)], input=json.dumps(request), capture_output=True,
                              text=True, env=env, timeout=60)

    def request(self, **over) -> dict:
        return {"record_type": "trip_mcp_bridge_request", "schema_version": 1,
                "slug": "italy-2026", "profile": {"name": "italy2026"}, **over}

    def recorded(self) -> list[str]:
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def test_the_bridge_is_wired_from_this_hosts_own_topology(self) -> None:
        result = self.send(self.request())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines()[-1], "WIRED italy2026")
        self.assertEqual(self.recorded(), [
            f"REPO_ROOT={REPO} italy2026 http://192.168.0.61:8080 --vmid 104 "
            f"--trip-dir {self.deploy}/trips/italy-2026 --port 3104"
        ])

    def test_what_the_request_says_about_the_site_is_ignored(self) -> None:
        result = self.send(self.request(site_url="http://10.6.6.6:9999", vmid="999", port=4444))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("http://192.168.0.61:8080 --vmid 104", self.recorded()[0])
        self.assertNotIn("10.6.6.6", self.recorded()[0])

    def test_an_unsafe_slug_is_refused_before_anything_runs(self) -> None:
        for slug in ("../../etc", "italy-2026/../x", "ITALY", "italy 2026", ""):
            with self.subTest(slug=slug):
                self.assertEqual(self.send(self.request(slug=slug)).returncode, 2)
        self.assertEqual(self.recorded(), [])

    def test_a_profile_this_key_never_installed_is_not_wired(self) -> None:
        result = self.send(self.request(profile={"name": "someone-else"}))
        self.assertEqual(result.returncode, 2)
        self.assertIn("no companion profile", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_a_topology_that_describes_another_trip_is_refused(self) -> None:
        (self.deploy / "trips/italy-2026/topology.yaml").write_text(TOPOLOGY.replace("name: italy-2026", "name: japan-2026", 1))
        self.assertEqual(self.send(self.request()).returncode, 2)
        self.assertEqual(self.recorded(), [])

    def test_an_unknown_request_type_is_refused(self) -> None:
        self.assertEqual(self.send(self.request(record_type="run_anything")).returncode, 2)
        self.assertEqual(self.recorded(), [])


if __name__ == "__main__":
    unittest.main()

class BridgeReachesTheTrip(BridgeRequest):
    """A bridge that cannot reach its own trip is not a wired bridge.

    2026-09-18, staging: a freshly provisioned trip's bridge registered 50
    tools with the gateway and then failed every call with
    `connect EHOSTUNREACH` on the way to the trip's site. The companion told
    the organizer "I can't retrieve the trip plan right now" for as long as
    anyone asked. Every check that existed passed — the port was open, the
    tools were registered, provisioning reported success — because they all
    verified the hop between the agent and the bridge, and the broken hop was
    the one after it.
    """

    def test_a_bridge_that_cannot_reach_the_trip_is_not_reported_wired(self) -> None:
        self.health.write_text('{"ok":false,"site":"unreachable","code":"EHOSTUNREACH"}')
        result = self.send(self.request())
        self.assertNotEqual(result.returncode, 0, "provisioning must not call this a success")
        self.assertNotIn("WIRED", result.stdout, f"stdout was {result.stdout!r}")

    def test_the_failure_names_the_verdict_so_it_can_be_acted_on(self) -> None:
        self.health.write_text('{"ok":false,"site":"unreachable","code":"EHOSTUNREACH"}')
        result = self.send(self.request())
        self.assertIn("EHOSTUNREACH", result.stderr)
        self.assertIn("cannot reach", result.stderr)

    def test_a_silent_bridge_is_a_failure_too(self) -> None:
        # No answer at all is the shape a dead bridge takes, and "no output"
        # must never pass a check by default.
        self.health.write_text("")
        result = self.send(self.request())
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("WIRED", result.stdout)

    def test_a_reachable_bridge_still_wires(self) -> None:
        result = self.send(self.request())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines()[-1], "WIRED italy2026")

    def test_the_key_reaches_the_bridge_but_never_the_command_line(self) -> None:
        # `ps` is readable by every user on the box. A key in argv is a key
        # published to all of them for the life of the call.
        result = self.send(self.request())
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = self.curl_argv.read_text()
        stdin = self.curl_stdin.read_text()
        self.assertNotIn("s3cret-mcp-key", argv, f"the key must not be in argv: {argv!r}")
        self.assertIn("--config -", argv, "curl must be reading its options from stdin")
        self.assertIn("X-API-Key: s3cret-mcp-key", stdin, "and the key must actually be sent")

    def test_a_trip_with_no_key_is_a_failure_not_a_skipped_check(self) -> None:
        # The shape that turns a security fix into a silently absent check:
        # no key, so nothing to send, so nothing asked, so WIRED anyway.
        (self.deploy / "trips/italy-2026/mcp/.env").write_text("TRIP_API_KEY=only-this-one\n")
        result = self.send(self.request())
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("WIRED", result.stdout)
        self.assertIn("MCP_API_KEY", result.stderr)
