from __future__ import annotations

import unittest

from control_plane_worker.cleanup import UnsafeCleanupError, select_test_resources
from control_plane_worker.inventory import ProxmoxInventory


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

    def test_cleanup_selects_only_the_exact_labelled_test_run(self) -> None:
        resources = [
            {"name": "kinerary-test-a", "environment": "test", "test_run_id": "tr_abcdefgh"},
            {"name": "kinerary-test-b", "environment": "test", "test_run_id": "tr_other1234"},
            {"name": "production", "environment": "production"},
        ]
        self.assertEqual([resources[0]], select_test_resources(resources, "tr_abcdefgh"))

    def test_cleanup_refuses_mislabelled_production_or_out_of_range_resources(self) -> None:
        with self.assertRaises(UnsafeCleanupError):
            select_test_resources([
                {"name": "production", "environment": "production", "test_run_id": "tr_abcdefgh"}
            ], "tr_abcdefgh")
        with self.assertRaises(UnsafeCleanupError):
            select_test_resources([
                {"name": "unlabelled-name", "environment": "test", "test_run_id": "tr_abcdefgh"}
            ], "tr_abcdefgh")


if __name__ == "__main__":
    unittest.main()
