from __future__ import annotations

import json
from pathlib import Path
import ssl
from tempfile import TemporaryDirectory
import unittest

from control_plane_worker.__main__ import safe_failure_message
from control_plane_worker.cleanup import (
    UnsafeCleanupError,
    load_test_resource_name_prefix,
    select_test_resources,
)
from control_plane_worker.inventory import ProxmoxHttpTransport, ProxmoxInventory


class FakeTransport:
    def __init__(self) -> None:
        self.paths: list[str] = []

    def get(self, path: str) -> dict[str, object]:
        self.paths.append(path)
        return {"data": [{"vmid": 101, "name": "kinerary-test-a", "status": "stopped", "ignored_secret": "nope"}]}


class SafetyToolTests(unittest.TestCase):
    def test_inventory_uses_only_get_and_returns_allowlisted_fields(self) -> None:
        transport = FakeTransport()
        result = ProxmoxInventory(transport, "test-node").inspect()
        self.assertEqual([
            "/api2/json/nodes/test-node/lxc",
            "/api2/json/nodes/test-node/storage",
        ], transport.paths)
        self.assertNotIn("ignored_secret", str(result))

    def test_transport_pins_https_and_keeps_verification_on(self) -> None:
        # PROXMOX_URL is operator-supplied, so urlopen must never be reachable
        # by a local handler or an unencrypted scheme.
        for unsafe in ("file:///etc/passwd", "http://proxmox.example", "ftp://proxmox.example", "/api2/json"):
            with self.assertRaises(ValueError):
                ProxmoxHttpTransport(unsafe, "PVEAPIToken=id=secret")
        transport = ProxmoxHttpTransport("https://proxmox.example/", "PVEAPIToken=id=secret")
        self.assertEqual("https://proxmox.example", transport.base_url)
        self.assertTrue(transport.context.check_hostname)
        self.assertEqual(ssl.CERT_REQUIRED, transport.context.verify_mode)

    def test_driver_failures_are_reported_without_the_connection_string(self) -> None:
        class FakeDriverError(Exception):
            sqlstate = "08006"

        leaky = "connection to postgresql://kinerary:SUPERSECRET@10.0.0.5:5432/db failed"
        classified = safe_failure_message(FakeDriverError(leaky))
        self.assertNotIn("SUPERSECRET", classified)
        self.assertIn("FakeDriverError", classified)
        self.assertIn("08006", classified)

        unclassified = safe_failure_message(RuntimeError(leaky))
        self.assertNotIn("SUPERSECRET", unclassified)
        self.assertIn("RuntimeError", unclassified)

    def test_cleanup_selects_only_the_exact_labelled_test_run(self) -> None:
        resources = [
            {"name": "kinerary-test-a", "environment": "test", "test_run_id": "tr_abcdefgh"},
            {"name": "kinerary-test-b", "environment": "test", "test_run_id": "tr_other1234"},
            {"name": "production", "environment": "production"},
        ]
        self.assertEqual([resources[0]], select_test_resources(resources, "tr_abcdefgh", "kinerary-test-"))

    def test_cleanup_refuses_mislabelled_production_or_out_of_range_resources(self) -> None:
        with self.assertRaises(UnsafeCleanupError):
            select_test_resources([
                {"name": "production", "environment": "production", "test_run_id": "tr_abcdefgh"}
            ], "tr_abcdefgh", "kinerary-test-")
        with self.assertRaises(UnsafeCleanupError):
            select_test_resources([
                {"name": "unlabelled-name", "environment": "test", "test_run_id": "tr_abcdefgh"}
            ], "tr_abcdefgh", "kinerary-test-")

    def test_cleanup_name_allocation_comes_from_the_architecture_profile(self) -> None:
        with TemporaryDirectory() as directory:
            profile = Path(directory) / "architecture.json"
            profile.write_text(json.dumps({
                "test_resources": {
                    "enabled": True,
                    "label_key": "kinerary.test_run_id",
                    "allowed_name_prefix": "kinerary-test-review-",
                }
            }), encoding="utf-8")
            self.assertEqual(
                "kinerary-test-review-",
                load_test_resource_name_prefix(str(profile)),
            )
            profile.write_text(json.dumps({"test_resources": {"enabled": False}}), encoding="utf-8")
            with self.assertRaises(UnsafeCleanupError):
                load_test_resource_name_prefix(str(profile))
            profile.write_text("[]", encoding="utf-8")
            with self.assertRaises(UnsafeCleanupError):
                load_test_resource_name_prefix(str(profile))


if __name__ == "__main__":
    unittest.main()
