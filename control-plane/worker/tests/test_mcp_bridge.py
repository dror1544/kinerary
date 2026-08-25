"""Unit tests for mcp_bridge.py's adapters. No real subprocess/SSH — the
shell adapter's subprocess.run call is mocked, matching test_companion_profile
.py's RenderProfileAdapterTests pattern."""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

from control_plane_worker.mcp_bridge import (
    NullMcpBridgeAdapter,
    ShellMcpBridgeAdapter,
)

TOPOLOGY_YAML = """\
version: 1
name: tokyo-2026
proxmox:
  node: pve
  lxc:
    name: trip-tokyo-2026
    ipv4: 192.168.0.210/24
npm:
  hostname: tokyo-2026.example.com
  forward_host: trip-tokyo-2026
  forward_port: 8080
"""


class NullMcpBridgeAdapterTests(unittest.TestCase):
    def test_setup_always_returns_false(self) -> None:
        self.assertFalse(NullMcpBridgeAdapter().setup("tokyo-2026", "tokyo2026"))


class ShellMcpBridgeAdapterTests(unittest.TestCase):
    def _write_topology(self, deploy_root: str, slug: str) -> None:
        trip_dir = os.path.join(deploy_root, "trips", slug)
        os.makedirs(trip_dir, exist_ok=True)
        with open(os.path.join(trip_dir, "topology.yaml"), "w", encoding="utf-8") as fh:
            fh.write(TOPOLOGY_YAML)

    def test_setup_returns_false_without_a_vmid(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            self._write_topology(deploy_root, "tokyo-2026")
            adapter = ShellMcpBridgeAdapter(deploy_root=deploy_root, vmid_map={})
            self.assertFalse(adapter.setup("tokyo-2026", "tokyo2026"))

    def test_setup_returns_false_without_a_topology_file(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            adapter = ShellMcpBridgeAdapter(deploy_root=deploy_root, vmid_map={"tokyo-2026": "210"})
            self.assertFalse(adapter.setup("tokyo-2026", "tokyo2026"))

    def test_setup_invokes_setup_mcp_sh_with_the_derived_local_url(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            self._write_topology(deploy_root, "tokyo-2026")
            adapter = ShellMcpBridgeAdapter(deploy_root=deploy_root, vmid_map={"tokyo-2026": "210"})
            with patch("control_plane_worker.mcp_bridge.subprocess.run") as mock_run:
                mock_run.return_value.returncode = 0
                mock_run.return_value.stderr = ""
                mock_run.return_value.stdout = ""
                result = adapter.setup("tokyo-2026", "tokyo2026")
            self.assertTrue(result)
            args = mock_run.call_args.args[0]
            self.assertIn(os.path.join(deploy_root, "setup-mcp.sh"), args)
            self.assertIn("tokyo2026", args)
            self.assertIn("http://192.168.0.210:8080", args)
            self.assertIn("--vmid", args)
            self.assertIn("210", args)
            self.assertIn("--trip-dir", args)
            self.assertIn(os.path.join(deploy_root, "trips", "tokyo-2026"), args)

    def test_setup_raises_on_a_nonzero_exit(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            self._write_topology(deploy_root, "tokyo-2026")
            adapter = ShellMcpBridgeAdapter(deploy_root=deploy_root, vmid_map={"tokyo-2026": "210"})
            with patch("control_plane_worker.mcp_bridge.subprocess.run") as mock_run:
                mock_run.return_value.returncode = 1
                mock_run.return_value.stderr = "ERROR: something broke"
                mock_run.return_value.stdout = ""
                with self.assertRaises(RuntimeError):
                    adapter.setup("tokyo-2026", "tokyo2026")


if __name__ == "__main__":
    unittest.main()
