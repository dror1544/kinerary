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
        (self.home / ".hermes/profiles/italy2026").mkdir(parents=True)
        self.deploy = self.home / "kinerary-deploy"
        (self.deploy / "trips/italy-2026").mkdir(parents=True)
        (self.deploy / "trips/italy-2026/topology.yaml").write_text(TOPOLOGY)
        self.calls = self.home / "setup-mcp.calls"
        self._exe(self.deploy / "setup-mcp.sh",
                  f'#!/bin/sh\necho "REPO_ROOT=$REPO_ROOT $*" >> "{self.calls}"\nexit 0\n')

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def _exe(path: Path, body: str) -> None:
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def send(self, request: dict) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin"}
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
