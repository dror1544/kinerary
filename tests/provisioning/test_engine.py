from __future__ import annotations

import unittest
from unittest.mock import Mock

from provisioning.engine import Provisioner
from provisioning.models import CloudflareSpec, LxcSpec, ProxySpec, Topology


TOPOLOGY = Topology(
    version=1,
    name="test-onboarding",
    lxc=LxcSpec("app", "node", "template", "storage", 2, 1024, 8, "bridge", "dhcp"),
    proxy=ProxySpec("site.example.invalid", "app", 8080),
    cloudflare=CloudflareSpec("tunnel", "site.example.invalid", "http://app:8080"),
)


class ProvisionerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.proxmox = Mock()
        self.npm = Mock()
        self.cloudflare = Mock()
        self.provisioner = Provisioner(self.proxmox, self.npm, self.cloudflare)

    def test_plan_is_empty_when_all_resources_already_match(self) -> None:
        self.proxmox.inspect.return_value = {"name": "app"}
        self.npm.inspect.return_value = {"hostname": "site.example.invalid"}
        self.cloudflare.inspect.return_value = {"tunnel_name": "tunnel", "hostname": "site.example.invalid"}

        plan = self.provisioner.plan(TOPOLOGY)

        self.assertEqual([], plan.changes)

    def test_apply_creates_missing_resources_and_records_reversible_snapshot(self) -> None:
        self.proxmox.inspect.return_value = None
        self.npm.inspect.return_value = None
        self.cloudflare.inspect.return_value = None

        snapshot = self.provisioner.apply(TOPOLOGY, execute=True)

        self.assertEqual(["proxmox_lxc", "npm_proxy_host", "cloudflare_tunnel_dns"], [c.resource for c in snapshot.changes])
        self.proxmox.create.assert_called_once_with(TOPOLOGY.lxc)
        self.npm.create.assert_called_once_with(TOPOLOGY.proxy)
        self.cloudflare.create.assert_called_once_with(TOPOLOGY.cloudflare)
        self.assertEqual(["delete", "delete", "delete"], [entry.operation for entry in snapshot.rollback])

    def test_apply_is_dry_run_unless_execute_is_explicit(self) -> None:
        self.proxmox.inspect.return_value = None
        self.npm.inspect.return_value = None
        self.cloudflare.inspect.return_value = None

        snapshot = self.provisioner.apply(TOPOLOGY, execute=False)

        self.assertFalse(snapshot.executed)
        self.proxmox.create.assert_not_called()
        self.npm.create.assert_not_called()
        self.cloudflare.create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
