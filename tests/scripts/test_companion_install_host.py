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
import re
import shutil
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
    def assertWired(self, result, profile: str) -> None:  # noqa: N802 - unittest style
        """The `WIRED` line is a CONTRACT, not a log line: the worker parses it.

        Since 2026-09-20 it carries the commit the install ran from, because
        the forced command in authorized_keys decides which checkout builds
        every companion and nothing anywhere recorded which one that was
        (#127). The worker accepts both the old and new shapes so an older host
        still reports success; this asserts the new one without pinning the
        commit, which changes with every build.
        """
        line = result.stdout.strip().splitlines()[-1]
        parts = line.split()
        self.assertEqual(parts[:2], ["WIRED", profile], f"line was {line!r}")
        self.assertEqual(len(parts), 3, f"no provenance on the WIRED line: {line!r}")
        self.assertTrue(parts[2].strip(), "provenance is present but empty")

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
        self.assertWired(result, "italy2026")
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
        self.assertWired(result, "italy2026")

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


class BridgeProbe(BridgeRequest):
    """`trip_mcp_bridge_probe` (issue #119): ask an already-wired bridge, again,
    whether it can reach its trip — and change NOTHING.

    Provisioning asks /health once, at install. A bridge whose key is replaced
    afterwards, or whose host loses its route to the trip, then fails every
    call for good while the companion answers politely that it cannot read the
    plan. The provisioner worker sends this request on its idle poll loop; the
    answer is exactly one line the worker parses, and the key the check needs
    never leaves this host.

    Inherits the sandbox (and so re-runs the sibling kind's tests against it,
    which is cheap insurance that adding a kind did not loosen the other).
    """

    def probe(self, **over) -> dict:
        return {"record_type": "trip_mcp_bridge_probe", "schema_version": 1,
                "slug": "italy-2026", "profile": {"name": "italy2026"}, **over}

    def assertOneLine(self, result, expected: str) -> None:  # noqa: N802 - unittest style
        self.assertEqual(result.returncode, 0, result.stderr)
        # EXACTLY one line: the worker reads it as a verdict, and a second
        # line is where a forged one would ride.
        self.assertEqual(result.stdout, expected + "\n", f"stdout was {result.stdout!r}")

    def test_a_healthy_bridge_answers_health_ok(self) -> None:
        self.assertOneLine(self.send(self.probe()), "HEALTH ok")

    def test_a_probe_restarts_nothing_and_wires_nothing(self) -> None:
        # Alert only. A probe that re-ran setup-mcp.sh or bounced the gateway
        # would be an unattended restart of a live trip's companion.
        self.send(self.probe())
        self.assertEqual(self.recorded(), [], "setup-mcp.sh must not run on a probe")
        self.assertFalse((self.home / ".hermes/profiles/italy2026/logs/agent.log").exists(),
                         "the gateway must not be (re)started on a probe")
        self.assertFalse((self.deploy / "trips/italy-2026/companion-provenance.json").exists())

    def test_a_key_mismatch_is_reported_by_its_code(self) -> None:
        self.health.write_text('{"ok":false,"site":"refused","code":"HTTP_401"}')
        self.assertOneLine(self.send(self.probe()), "HEALTH fail HTTP_401")

    def test_an_unreachable_trip_is_reported_by_its_code(self) -> None:
        self.health.write_text('{"ok":false,"site":"unreachable","code":"EHOSTUNREACH"}')
        self.assertOneLine(self.send(self.probe()), "HEALTH fail EHOSTUNREACH")

    def test_a_dead_bridge_is_a_failure_named_none(self) -> None:
        self.health.write_text("")
        self.assertOneLine(self.send(self.probe()), "HEALTH fail none")

    def test_a_bridge_rejecting_its_own_key_is_distinguished(self) -> None:
        # mcp/.env and the running bridge disagree: the bridge's own requireKey
        # refuses before it ever asks the trip.
        self.health.write_text('{"error":"unauthorized"}')
        self.assertOneLine(self.send(self.probe()), "HEALTH fail BRIDGE_401")

    def test_a_bridge_older_than_health_is_named_not_called_broken(self) -> None:
        # A bridge started from a checkout before /health existed (#127 found
        # the forced command pointing at one) answers Express's 404. It may be
        # working; the worker must be able to tell that from a failure.
        self.health.write_text("<!DOCTYPE html>\n<html><body><pre>Cannot GET /health</pre></body></html>")
        self.assertOneLine(self.send(self.probe()), "HEALTH fail NO_HEALTH_ROUTE")

    def test_a_trip_with_no_key_fails_rather_than_passing_unasked(self) -> None:
        (self.deploy / "trips/italy-2026/mcp/.env").write_text("TRIP_API_KEY=only-this-one\n")
        self.assertOneLine(self.send(self.probe()), "HEALTH fail NO_KEY")

    def test_whatever_the_bridge_says_cannot_forge_a_second_line_or_a_code(self) -> None:
        # The bridge's body is data from another process. Only a bounded
        # [A-Za-z0-9_] code crosses back; anything else is UNRECOGNIZED.
        for body in ('{"ok":false,"code":"X\\nHEALTH ok"}',
                     '{"ok":false,"code":"a b; rm -rf /"}',
                     '{"ok":false,"code":"' + "A" * 41 + '"}',
                     'HEALTH ok\n{"ok":false}',
                     '<html>502</html>'):
            with self.subTest(body=body):
                self.health.write_text(body)
                self.assertOneLine(self.send(self.probe()), "HEALTH fail UNRECOGNIZED")

    def test_the_key_never_leaves_the_host_or_reaches_argv(self) -> None:
        self.health.write_text('{"ok":false,"site":"refused","code":"HTTP_401"}')
        result = self.send(self.probe())
        for stream in (result.stdout, result.stderr):
            self.assertNotIn("s3cret-mcp-key", stream)
            self.assertNotIn("s3cret-trip-key", stream)
        argv = self.curl_argv.read_text()
        self.assertNotIn("s3cret-mcp-key", argv, f"the key must not be in argv: {argv!r}")
        self.assertIn("X-API-Key: s3cret-mcp-key", self.curl_stdin.read_text(),
                      "the key is read here, beside the trip, and sent on stdin")

    def test_the_port_comes_from_this_hosts_topology_not_the_request(self) -> None:
        self.send(self.probe(port=4444, site_url="http://10.6.6.6:9999", vmid="999"))
        stdin = self.curl_stdin.read_text()
        self.assertIn("http://127.0.0.1:3104/health", stdin)
        self.assertNotIn("4444", stdin)
        self.assertNotIn("10.6.6.6", stdin)

    def test_a_malformed_slug_or_profile_is_refused_before_anything_runs(self) -> None:
        cases = [{"slug": s} for s in ("../../etc", "italy-2026/../x", "ITALY", "italy 2026", "", "a" * 81)]
        cases += [{"profile": {"name": p}} for p in ("../x", "Italy2026", "italy 2026", "-x", "", "a" * 64)]
        cases += [{"profile": "italy2026"}, {"slug": ["italy-2026"]}]
        for over in cases:
            with self.subTest(**{k: repr(v) for k, v in over.items()}):
                result = self.send(self.probe(**over))
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertNotIn("HEALTH", result.stdout)
        self.assertFalse(self.curl_argv.exists(), "nothing may be probed for a refused request")

    def test_a_profile_this_key_never_installed_is_not_probed(self) -> None:
        result = self.send(self.probe(profile={"name": "someone-else"}))
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("HEALTH", result.stdout)
        self.assertFalse(self.curl_argv.exists())

    def test_a_topology_that_describes_another_trip_is_not_probed(self) -> None:
        (self.deploy / "trips/italy-2026/topology.yaml").write_text(
            TOPOLOGY.replace("name: italy-2026", "name: japan-2026", 1))
        result = self.send(self.probe())
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.curl_argv.exists())

    def test_a_crafted_topology_cannot_change_where_the_key_is_sent(self) -> None:
        """F6 (security review): the port the key is sent to is derived from
        topology.yaml, and the fields travel tab-separated. A tab in the
        address used to shift the fields, so the trip's own site port became
        the "MCP port" — the key sent to whatever listens there. Every value
        is now checked against an ASCII pattern before anything is sent."""
        hostile = {
            "ip with a tab": ('    ipv4: 192.168.0.61/24', '    ipv4: "192.168.0.61\\t8080"'),
            "ip with a newline": ('    ipv4: 192.168.0.61/24', '    ipv4: "192.168.0.61\\nurl = x"'),
            "ip with a port": ('    ipv4: 192.168.0.61/24', '    ipv4: "1.2.3.4:80"'),
            "ip octet out of range": ('    ipv4: 192.168.0.61/24', '    ipv4: 192.168.0.300'),
            "vmid in non-ASCII digits": ("  vmid: '104'", "  vmid: '١٠٤'"),
            "vmid in full-width digits": ("  vmid: '104'", "  vmid: '１０４'"),
            "vmid with a newline": ("  vmid: '104'", '  vmid: "104\\n"'),
            "vmid with a tab": ("  vmid: '104'", '  vmid: "104\\t9"'),
            "vmid of five digits": ("  vmid: '104'", "  vmid: '10400'"),
            "vmid with a space": ("  vmid: '104'", "  vmid: ' 104'"),
            "forward port of six digits": ("  forward_port: 8080", "  forward_port: 808080"),
            "forward port with a tab": ("  forward_port: 8080", '  forward_port: "8080\\t3104"'),
            "forward port out of range": ("  forward_port: 8080", "  forward_port: 99999"),
        }
        for label, (good, bad) in hostile.items():
            self.assertIn(good, TOPOLOGY, label)
            for kind in ("trip_mcp_bridge_probe", "trip_mcp_bridge_request"):
                with self.subTest(label=label, kind=kind):
                    (self.deploy / "trips/italy-2026/topology.yaml").write_text(
                        TOPOLOGY.replace(good, bad), encoding="utf-8")
                    for f in (self.curl_argv, self.curl_stdin, self.calls):
                        if f.exists():
                            f.unlink()
                    result = self.send(self.probe(record_type=kind))
                    self.assertEqual(result.returncode, 2, f"{label}: {result.stdout!r} {result.stderr!r}")
                    self.assertNotIn("HEALTH", result.stdout)
                    self.assertIn("companion-install-host:", result.stderr)
                    self.assertFalse(self.curl_stdin.exists(), f"{label}: the key was sent somewhere")
                    self.assertNotIn("s3cret-mcp-key", result.stdout + result.stderr)
                    self.assertEqual(self.recorded(), [], "setup-mcp.sh must not run either")

    def test_a_near_miss_request_type_is_refused(self) -> None:
        for kind in ("trip_mcp_bridge_probe ", "TRIP_MCP_BRIDGE_PROBE", "trip_mcp_bridge_probes"):
            with self.subTest(kind=kind):
                self.assertEqual(self.send(self.probe(record_type=kind)).returncode, 2)
        self.assertFalse(self.curl_argv.exists())


class EnrollRelay(unittest.TestCase):
    """companion-write-confinement (2026-09-29): enroll_relay() now writes
    HERMES_WRITE_SAFE_ROOT beside the relay identity it already writes
    (GATEWAY_RELAY_URL/ID/SECRET, COMPANION_CONTROL_TOKEN). This exercises the
    plain "profile already exists" path (ALREADY_PRESENT) — merge_overlay and
    start_gateway both no-op harmlessly there (no overlay file, no Hermes venv
    python), so this is the narrowest real run that reaches enroll_relay
    through the actual script rather than through a hand-extracted copy of it.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / ".local/bin").mkdir(parents=True)
        self._exe(self.home / ".local/bin/hermes", "#!/bin/sh\nexit 0\n")
        self.profile_dir = self.home / ".hermes/profiles/testprofile"
        self.profile_dir.mkdir(parents=True)

        # The architecture profile enroll_relay reads relay url + secret ref
        # from — real values, on this host's own kinerary-deploy files never
        # apply here, so this test supplies its own.
        self.secret_file = self.home / "relay.secret"
        self.secret_file.write_text("s3cret-relay-key")
        self.arch_profile = self.home / "architecture.relay-host.json"
        self.arch_profile.write_text(json.dumps({
            "relay": {
                "bind_host": "127.0.0.1",
                "port": 4321,
                "gateway_secret_refs": [f"file://{self.secret_file}"],
            }
        }))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def _exe(path: Path, body: str) -> None:
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def send(self) -> subprocess.CompletedProcess:
        env = {
            "HOME": str(self.home),
            "PATH": f"{self.home}/.local/bin:/usr/bin:/bin",
            "KINERARY_ARCHITECTURE_PROFILE": str(self.arch_profile),
        }
        request = {"profile": {"name": "testprofile"}}
        return subprocess.run(["bash", str(SCRIPT)], input=json.dumps(request), capture_output=True,
                              text=True, env=env, timeout=60)

    def env_lines(self) -> dict[str, str]:
        text = (self.profile_dir / ".env").read_text()
        out = {}
        for line in text.splitlines():
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            out[k] = v
        return out

    def test_the_sandbox_root_is_written_and_created(self) -> None:
        result = self.send()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ALREADY_PRESENT testprofile")

        expected_sandbox = str(self.profile_dir / "write-sandbox")
        env = self.env_lines()
        self.assertEqual(env.get("HERMES_WRITE_SAFE_ROOT"), expected_sandbox)
        self.assertTrue((self.profile_dir / "write-sandbox").is_dir(),
                        "the directory named in .env must actually exist")

        # Unrelated existing behaviour must still work: the relay identity
        # this function already wrote before this change.
        self.assertEqual(env.get("GATEWAY_RELAY_URL"), "http://127.0.0.1:4321")
        self.assertEqual(env.get("GATEWAY_RELAY_ID"), "testprofile")
        self.assertEqual(env.get("GATEWAY_RELAY_SECRET"), "s3cret-relay-key")
        self.assertIn("COMPANION_CONTROL_TOKEN", env)

    def test_a_retry_does_not_duplicate_the_line(self) -> None:
        self.assertEqual(self.send().returncode, 0)
        result = self.send()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.profile_dir / ".env").read_text()
        self.assertEqual(text.count("HERMES_WRITE_SAFE_ROOT="), 1)

    def test_no_architecture_profile_leaves_no_sandbox_line(self) -> None:
        # enroll_relay's existing early-return path (no ARCH_PROFILE — the
        # profile is left UNENROLLED). HERMES_WRITE_SAFE_ROOT rides on the
        # same write as the relay identity, so it is absent too rather than
        # half-written.
        env = {"HOME": str(self.home), "PATH": f"{self.home}/.local/bin:/usr/bin:/bin",
               "KINERARY_ARCHITECTURE_PROFILE": str(self.home / "does-not-exist.json")}
        request = {"profile": {"name": "testprofile"}}
        result = subprocess.run(["bash", str(SCRIPT)], input=json.dumps(request), capture_output=True,
                                text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("left UNENROLLED", result.stderr)
        self.assertFalse((self.profile_dir / ".env").exists())
        self.assertFalse((self.profile_dir / "write-sandbox").exists())


class RerenderRequest(unittest.TestCase):
    """`companion_profile_rerender` (#568 slice R2, AC-14): an existing companion follows its trip to a newer release.

    The request carries a handoff and a mode; the render code and templates come from the RELEASE'S tree, handed over
    through the environment by the rollout and never by the request. These tests run the real script in a sandboxed
    HOME with a stand-in `hermes`, a real release-shaped tree, and a gateway the script must not touch.
    """

    NAME = "sampletrip2027"
    RELEASE = {"id": "rls_abc12345", "commit": "c" * 40}

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "gateway.calls"
        # `hermes profile create` makes the directory; anything about a gateway is recorded, and must never happen.
        BridgeRequest._exe(self.bin / "hermes",
                           '#!/bin/sh\n'
                           f'case "$*" in *gateway*) echo "hermes $*" >> "{self.calls}";; esac\n'
                           '[ "$1 $2" = "profile create" ] && mkdir -p "$HOME/.hermes/profiles/$3"\nexit 0\n')
        BridgeRequest._exe(self.bin / "launchctl", f'#!/bin/sh\necho "launchctl $*" >> "{self.calls}"\nexit 0\n')
        # PyYAML for the overlay merge: this interpreter has it.
        (self.bin / "python3").symlink_to(sys.executable)
        self.profile = self.home / ".hermes" / "profiles" / self.NAME
        self.handoff = json.loads((REPO / "profile-templates/familytrip-companion/example.handoff.json").read_text())
        self.handoff["profile"]["name"] = self.NAME
        self.tree = self.make_release_tree("release one")
        self.install_with_the_scripts_own_checkout()

    # -- fixtures

    def make_release_tree(self, mark: str, name: str = "tree") -> Path:
        """What a release materializes: profile-templates/familytrip-companion, with `mark` in the SOUL template."""
        tree = self.root / name
        shutil.copytree(REPO / "profile-templates/familytrip-companion",
                        tree / "profile-templates/familytrip-companion",
                        ignore=shutil.ignore_patterns("tests", "eval", "__pycache__"))
        soul = tree / "profile-templates/familytrip-companion/templates/SOUL.md.tpl"
        soul.write_text(soul.read_text() + f"\nRELEASE-MARK: {mark}\n")
        return tree

    def env(self, tree="unset") -> dict:
        tree = self.tree if tree == "unset" else tree
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin",
               "KINERARY_ARCHITECTURE_PROFILE": str(self.home / "none.json")}
        if tree is not None:
            env["KINERARY_RELEASE_TREE"] = str(tree)
        return env

    def run_request(self, request: dict, tree="unset") -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(SCRIPT)], input=json.dumps(request), capture_output=True, text=True,
                              env=self.env(tree), timeout=120)

    def install_with_the_scripts_own_checkout(self) -> None:
        """The ordinary install path: INSTALLED, marked as this system's, and its render recorded."""
        result = self.run_request(self.handoff, tree=None)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(f"INSTALLED {self.NAME}", result.stdout.strip())
        for rel, body in {"state.db": b"SQLite format 3\x00 history", "memories/MEMORY.md": b"remembered\n",
                          ".env": b"GATEWAY_RELAY_SECRET=untouchable\n", "logs/agent.log": b"line\n"}.items():
            (self.profile / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.profile / rel).write_bytes(body)
        (self.profile / "config.yaml").write_text("model:\n  default: the-profiles-own-choice\n")
        if self.calls.exists():
            self.calls.unlink()

    def rerender(self, mode: str = "apply", allow: bool = False, tree="unset", **over):
        request = {"record_type": "companion_profile_rerender", "schema_version": 1, "profile": {"name": self.NAME},
                   "handoff": self.handoff, "mode": mode, "allow_edited": allow, "release": dict(self.RELEASE), **over}
        return self.run_request(request, tree)

    def snapshot(self) -> dict:
        return {str(p.relative_to(self.profile)): (p.read_bytes() if p.is_file() and not p.is_symlink() else os.readlink(p))
                for p in sorted(self.profile.rglob("*")) if p.is_file() or p.is_symlink()}

    def untouched(self) -> dict:
        keep = ("state.db", "memories/MEMORY.md", ".env", "logs/agent.log", "kinerary-managed")
        return {k: (self.profile / k).read_bytes() for k in keep}

    def verdict(self, result) -> str:
        return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""

    # -- the request is refused unless it can be trusted

    def test_without_a_release_tree_in_the_environment_it_is_refused_and_the_scripts_own_checkout_is_not_used_instead(self) -> None:
        before = self.snapshot()
        result = self.rerender(tree=None)
        self.assertEqual(2, result.returncode)
        self.assertIn("KINERARY_RELEASE_TREE", result.stderr)
        self.assertEqual(before, self.snapshot())

    def test_a_tree_that_is_not_a_release_tree_is_refused(self) -> None:
        link = self.root / "link"
        link.symlink_to(self.tree)
        empty = self.root / "empty"
        empty.mkdir()
        for label, tree in (("relative", "tree"), ("absent", self.root / "absent"), ("a symlink", link), ("no render script", empty)):
            with self.subTest(label):
                before = self.snapshot()
                result = self.rerender(tree=tree)
                self.assertEqual(2, result.returncode, result.stdout)
                self.assertEqual(before, self.snapshot())

    def test_a_request_cannot_name_the_tree(self) -> None:
        # The envelope has no field for it, and a field smuggled in is ignored: the tree is the environment's.
        hostile = self.make_release_tree("HOSTILE", "hostile")
        result = self.rerender(tree=self.tree, release_tree=str(hostile), tree_path=str(hostile), render=str(hostile))
        self.assertEqual(f"RERENDER {self.NAME} applied", self.verdict(result), result.stderr)
        self.assertIn("RELEASE-MARK: release one", (self.profile / "SOUL.md").read_text())
        self.assertNotIn("HOSTILE", (self.profile / "SOUL.md").read_text())

    def test_a_malformed_request_is_refused_before_anything_runs(self) -> None:
        before = self.snapshot()
        cases = {
            "unknown mode": dict(mode="force"),
            "allow that is a word": dict(allow_edited="yes"),
            "allow that is a number": dict(allow_edited=1),
            "no release": dict(release=None),
            "a release id with a space": dict(release={"id": "a b", "commit": "c" * 40}),
            "a short commit": dict(release={"id": "rls_ok", "commit": "abc123"}),
            "a commit with a newline": dict(release={"id": "rls_ok", "commit": "c" * 39 + "\n"}),
            "a handoff for another profile": dict(handoff={**self.handoff, "profile": {**self.handoff["profile"], "name": "someoneelse"}}),
            "no handoff": dict(handoff=None),
            "a handoff of another kind": dict(handoff={**self.handoff, "record_type": "trip_mcp_bridge_request"}),
            "an unsafe profile name": dict(profile={"name": "../x"}),
        }
        for label, over in cases.items():
            with self.subTest(label):
                result = self.rerender(**over)
                self.assertEqual(2, result.returncode, f"{label}: {result.stdout!r} {result.stderr!r}")
                self.assertEqual(before, self.snapshot())

    def test_a_profile_this_system_did_not_install_is_refused(self) -> None:
        (self.profile / "kinerary-managed").unlink()
        before = self.snapshot()
        result = self.rerender()
        self.assertEqual(2, result.returncode)
        self.assertIn("provenance marker", result.stderr)
        self.assertEqual(before, self.snapshot())

    def test_a_profile_on_the_deny_list_is_refused_even_with_a_marker(self) -> None:
        names = [ln.strip() for ln in (REPO / "scripts/protected-profiles.txt").read_text().splitlines()
                 if ln.strip() and not ln.startswith("#") and re.fullmatch(r"[a-z][a-z0-9]{2,31}", ln.strip())]
        self.assertTrue(names, "no protected profile with a name a handoff may carry")
        protected = self.home / ".hermes" / "profiles" / names[0]
        protected.mkdir(parents=True)
        (protected / "kinerary-managed").write_text("kinerary-managed\n")
        (protected / "SOUL.md").write_text("somebody's own bot")
        handoff = {**self.handoff, "profile": {**self.handoff["profile"], "name": names[0]}}
        result = self.rerender(profile={"name": names[0]}, handoff=handoff)
        self.assertEqual(2, result.returncode)
        self.assertIn("not a profile this system manages", result.stderr)
        self.assertEqual("somebody's own bot", (protected / "SOUL.md").read_text())

    def test_a_profile_directory_that_is_a_symlink_is_refused_and_its_target_untouched(self) -> None:
        target = self.root / "somewhere-else"
        shutil.move(str(self.profile), str(target))
        self.profile.symlink_to(target)
        before = {p.name: p.read_bytes() for p in target.iterdir() if p.is_file()}
        result = self.rerender()
        self.assertEqual(2, result.returncode)
        self.assertEqual(before, {p.name: p.read_bytes() for p in target.iterdir() if p.is_file()})

    def test_no_such_profile_is_refused_not_created(self) -> None:
        other = {**self.handoff, "profile": {**self.handoff["profile"], "name": "notinstalled"}}
        result = self.rerender(profile={"name": "notinstalled"}, handoff=other)
        self.assertEqual(2, result.returncode)
        self.assertFalse((self.home / ".hermes/profiles/notinstalled").exists())

    # -- AC-14: what a re-render does

    def test_a_fresh_install_records_what_it_rendered_so_the_first_rerender_can_tell_an_edit(self) -> None:
        self.assertTrue((self.profile / ".kinerary-render.json").is_file())
        result = self.rerender(mode="check")
        self.assertEqual(f"RERENDER {self.NAME} clean", self.verdict(result), result.stderr)

    def test_check_writes_nothing_and_starts_nothing(self) -> None:
        tree2 = self.make_release_tree("release two", "tree2")
        for edit in (lambda: None, lambda: (self.profile / "SOUL.md").write_text("edited"),
                     lambda: (self.profile / ".kinerary-render.json").unlink()):
            edit()
            before = self.snapshot()
            result = self.rerender(mode="check", tree=tree2)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(before, self.snapshot())
        self.assertFalse(self.calls.exists(), "a re-render never touches a gateway")

    def test_apply_leaves_the_profiles_soul_and_skills_equal_to_a_fresh_render_of_the_release(self) -> None:
        tree = self.make_release_tree("release two", "tree2")
        kept = self.untouched()
        result = self.rerender(tree=tree)
        self.assertEqual(f"RERENDER {self.NAME} applied", self.verdict(result), result.stderr)
        inp = self.root / "in.json"
        inp.write_text(json.dumps(self.handoff))
        subprocess.run([sys.executable, str(tree / "profile-templates/familytrip-companion/render_profile.py"),
                        "--input", str(inp), "--output", str(self.root / "fresh")], check=True, capture_output=True)
        fresh = self.root / "fresh"
        files = [p for p in sorted(fresh.rglob("*")) if p.is_file()]
        self.assertTrue(any(p.name == "SOUL.md" for p in files) and any("skills" in p.parts for p in files))
        for p in files:
            self.assertEqual(p.read_bytes(), (self.profile / p.relative_to(fresh)).read_bytes(), str(p.relative_to(fresh)))
        self.assertIn("RELEASE-MARK: release two", (self.profile / "SOUL.md").read_text())
        self.assertEqual(kept, self.untouched(), "history, memory, relay identity, logs and the marker: untouched")
        self.assertFalse(self.calls.exists(), "no gateway was started, stopped or restarted: that is the refresh's job")
        manifest = json.loads((self.profile / ".kinerary-render.json").read_text())
        self.assertEqual({"id": self.RELEASE["id"], "commit": self.RELEASE["commit"]}, manifest["release"])

    def test_the_overlay_is_merged_the_way_an_install_merges_it_and_the_profiles_own_choice_wins(self) -> None:
        tree = self.make_release_tree("release two", "tree2")
        overlay = tree / "profile-templates/familytrip-companion/templates/config.overlay.yaml.tpl"
        overlay.write_text(overlay.read_text() + "\nrelease_two_setting: true\n")
        result = self.rerender(tree=tree)
        self.assertEqual(f"RERENDER {self.NAME} applied", self.verdict(result), result.stderr)
        text = (self.profile / "config.yaml").read_text()
        self.assertIn("the-profiles-own-choice", text, "the profile's own setting still wins")
        self.assertIn("release_two_setting", text, "a gap the new overlay fills is filled")

    def test_a_second_apply_of_the_same_release_changes_nothing(self) -> None:
        tree2 = self.make_release_tree("release two", "tree2")
        self.assertEqual(f"RERENDER {self.NAME} applied", self.verdict(self.rerender(tree=tree2)))
        before = self.snapshot()
        result = self.rerender(tree=tree2)
        self.assertEqual(f"RERENDER {self.NAME} unchanged", self.verdict(result), result.stderr)
        self.assertEqual(before, self.snapshot())

    def test_an_edit_in_place_is_reported_and_nothing_is_overwritten(self) -> None:
        soul = self.profile / "SOUL.md"
        soul.write_text(soul.read_text() + "\nThe organizer's own rule.\n")
        before = self.snapshot()
        result = self.rerender(tree=self.make_release_tree("release two", "tree2"))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(f"RERENDER {self.NAME} edited", self.verdict(result))
        self.assertIn("SOUL.md", result.stderr)
        self.assertEqual(before, self.snapshot())
        self.assertFalse((self.home / ".hermes/profile-backups").exists())

    def test_a_profile_installed_before_the_record_existed_is_refused_as_unknown_provenance(self) -> None:
        (self.profile / ".kinerary-render.json").unlink()
        before = self.snapshot()
        result = self.rerender(tree=self.make_release_tree("release two", "tree2"))
        self.assertEqual(f"RERENDER {self.NAME} unknown_provenance", self.verdict(result), result.stderr)
        self.assertEqual(before, self.snapshot())

    def test_when_the_plan_says_so_an_edited_profile_is_overwritten_after_its_edits_are_copied_aside(self) -> None:
        soul = self.profile / "SOUL.md"
        edited = soul.read_text() + "\nThe organizer's own rule.\n"
        soul.write_text(edited)
        result = self.rerender(allow=True, tree=self.make_release_tree("release two", "tree2"))
        self.assertEqual(f"RERENDER {self.NAME} applied", self.verdict(result), result.stderr)
        self.assertNotIn("organizer's own rule", soul.read_text())
        saved = list((self.home / ".hermes/profile-backups" / self.NAME).glob("*/SOUL.md"))
        self.assertEqual(1, len(saved))
        self.assertEqual(edited, saved[0].read_text())
        self.assertIn("copied to", result.stderr)

    def test_a_file_the_new_release_no_longer_renders_is_deleted_only_after_it_is_copied_aside(self) -> None:
        tree = self.make_release_tree("release two", "tree2")
        gone = tree / "profile-templates/familytrip-companion/templates/skills/planning/trip-daily-planning/SKILL.md"
        kept = (self.profile / "skills/planning/trip-daily-planning/SKILL.md").read_text()
        gone.unlink()
        result = self.rerender(tree=tree)
        self.assertEqual(f"RERENDER {self.NAME} applied", self.verdict(result), result.stderr)
        self.assertFalse((self.profile / "skills/planning/trip-daily-planning/SKILL.md").exists())
        saved = list((self.home / ".hermes/profile-backups" / self.NAME).glob("*/skills/planning/trip-daily-planning/SKILL.md"))
        self.assertEqual([kept], [p.read_text() for p in saved])

    def test_only_the_newest_three_backups_of_a_profile_are_kept(self) -> None:
        for n in range(5):
            (self.profile / "SOUL.md").write_text(f"edited {n}")
            result = self.rerender(allow=True, tree=self.make_release_tree(f"release {n}", f"treeb{n}"))
            self.assertEqual(f"RERENDER {self.NAME} applied", self.verdict(result), result.stderr)
        self.assertEqual(3, len(list((self.home / ".hermes/profile-backups" / self.NAME).iterdir())))

    def test_allow_does_nothing_in_check_mode(self) -> None:
        (self.profile / "SOUL.md").write_text("edited")
        result = self.rerender(mode="check", allow=True)
        self.assertEqual(f"RERENDER {self.NAME} edited", self.verdict(result))
        self.assertEqual("edited", (self.profile / "SOUL.md").read_text())
        self.assertFalse((self.home / ".hermes/profile-backups").exists())

    def test_the_organizer_private_handoff_is_never_printed(self) -> None:
        self.handoff["interview"]["organizer_private"]["goals"] = ["ZEBRA-PRIVATE-MARKER"]
        tree2 = self.make_release_tree("release two", "tree2")
        for mode in ("check", "apply"):
            result = self.rerender(mode=mode, tree=tree2)
            self.assertNotIn("ZEBRA-PRIVATE-MARKER", result.stdout + result.stderr)

    def test_a_release_whose_render_script_cannot_re_render_in_place_fails_loudly(self) -> None:
        tree = self.make_release_tree("old render", "old")
        (tree / "profile-templates/familytrip-companion/render_profile.py").write_text(
            "import sys\nprint('ERROR: usage', file=sys.stderr)\nraise SystemExit(2)\n")
        before = self.snapshot()
        result = self.rerender(tree=tree)
        self.assertEqual(2, result.returncode)
        self.assertNotIn("RERENDER", result.stdout)
        self.assertEqual(before, self.snapshot())

    def test_an_older_release_that_refuses_the_handoffs_shape_fails_with_the_cause_named_and_no_traceback(self) -> None:
        # Review round 1: a rollback renders the OLD release's templates from the handoff the host builds now. An old
        # renderer refuses a top-level key it does not know; that must read as what it is.
        tree = self.make_release_tree("older", "older")
        render = tree / "profile-templates/familytrip-companion/render_profile.py"
        text = render.read_text()
        render.write_text(text.replace("if set(d)-req:", "if set(d)-req or True:", 1)
                          .replace("bad(f'unknown top-level keys: {sorted(set(d)-req)}')",
                                   "bad('unknown top-level keys: [\\'a_key_this_release_does_not_know\\']')", 1))
        before = self.snapshot()
        result = self.rerender(tree=tree)
        self.assertEqual(2, result.returncode, result.stdout)
        self.assertIn("render_profile.py refused this trip's handoff", result.stderr)
        self.assertIn("unknown top-level keys", result.stderr)
        self.assertIn("roll the companion forward", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(before, self.snapshot())

    def test_a_render_script_that_answers_in_words_the_host_does_not_know_is_not_believed(self) -> None:
        tree = self.make_release_tree("odd", "odd")
        (tree / "profile-templates/familytrip-companion/render_profile.py").write_text(
            "import json\nprint(json.dumps({'status': 'applied\\nRERENDER x applied'}))\n")
        result = self.rerender(tree=tree)
        self.assertEqual(2, result.returncode)
        self.assertNotIn("RERENDER", result.stdout)
