"""scripts/trip-autostart.py — which container it changes, and to what.

No Proxmox: the ssh call is replaced. What is tested is what a mistake would
hide — reading the wrong container out of a topology, or changing a VMID that
now belongs to some other container.

    python3 -m unittest discover -s tests/scripts
"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "trip-autostart.py"
spec = importlib.util.spec_from_file_location("trip_autostart", SCRIPT)
autostart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(autostart)

# The shape compute.py's _write_topology writes, trimmed.
TOPOLOGY = """version: 1
name: japan-2026
proxmox:
  node: proxmox
  vmid: '101'
  lxc:
    name: trip-japan-2026
    template: local:vztmpl/debian-12.tar.zst
    ipv4: 192.168.0.95/24
npm:
  hostname: japan-2026.example.store
  forward_host: 192.168.0.95
"""

PCT_CONFIG = """arch: amd64
hostname: trip-japan-2026
onboot: 1
startup: order=3
mp0: /mnt/pve/truenas-nfs/japan-2026,mp=/nfs/japan-2026
"""


class Parsing(unittest.TestCase):
    def test_the_container_is_the_topologys_vmid_and_lxc_name(self):
        self.assertEqual(autostart.parse_topology(TOPOLOGY), ("101", "trip-japan-2026"))

    def test_the_trip_name_is_never_mistaken_for_the_container_name(self):
        # `name: japan-2026` sits above `lxc:`; only the name inside lxc counts.
        vmid, name = autostart.parse_topology(TOPOLOGY)
        self.assertNotEqual(name, "japan-2026")

    def test_a_topology_without_a_vmid_is_an_error_not_a_guess(self):
        with self.assertRaises(ValueError):
            autostart.parse_topology(TOPOLOGY.replace("  vmid: '101'\n", ""))

    def test_pct_config_reads_onboot_and_startup(self):
        config = autostart.parse_pct_config(PCT_CONFIG)
        self.assertEqual((config["onboot"], config["startup"]), ("1", "order=3"))

    def test_on_sets_the_boot_order_off_clears_onboot(self):
        self.assertEqual(autostart.set_command("101", on=True), "pct set 101 --onboot 1 --startup order=3")
        self.assertEqual(autostart.set_command("101", on=False), "pct set 101 --onboot 0")


class Main(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        (root / "trips" / "japan-2026").mkdir(parents=True)
        (root / "trips" / "japan-2026" / "topology.yaml").write_text(TOPOLOGY)
        for patcher in (mock.patch.object(autostart, "DEPLOY_ROOT", root),
                        mock.patch.object(autostart, "load_provisioning_env", lambda: None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        self.dir.cleanup()

    def test_a_vmid_now_holding_another_container_is_refused_and_left_alone(self):
        calls = []
        def proxmox(command):
            calls.append(command)
            return PCT_CONFIG.replace("hostname: trip-japan-2026", "hostname: trip-someone-else")
        with mock.patch.object(autostart, "proxmox", proxmox):
            self.assertEqual(autostart.main(["--trip", "japan-2026", "--off"]), 2)
        self.assertEqual(calls, ["pct config 101"], "nothing but the read ran")

    def test_off_changes_this_trips_container_and_checks_it_took(self):
        state = {"config": PCT_CONFIG}
        calls = []
        def proxmox(command):
            calls.append(command)
            if command.startswith("pct set"):
                state["config"] = PCT_CONFIG.replace("onboot: 1", "onboot: 0")
                return ""
            return state["config"]
        with mock.patch.object(autostart, "proxmox", proxmox):
            self.assertEqual(autostart.main(["--trip", "japan-2026", "--off"]), 0)
        self.assertIn("pct set 101 --onboot 0", calls)

    def test_input_that_is_not_a_slug_is_refused_before_any_call(self):
        with mock.patch.object(autostart, "proxmox", side_effect=AssertionError("called")):
            self.assertEqual(autostart.main(["--trip", "../etc"]), 2)
