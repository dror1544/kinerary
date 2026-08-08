from __future__ import annotations

import unittest
from unittest.mock import patch

from provisioning.__main__ import load_topology_file
from provisioning.models import ProvisioningError, load_topology


class TopologyValidationTests(unittest.TestCase):
    def test_load_topology_rejects_missing_required_sections(self) -> None:
        with self.assertRaisesRegex(ProvisioningError, "proxmox"):
            load_topology({"version": 1, "name": "demo"})

    def test_yaml_environment_references_are_resolved_without_secrets_in_yaml(self) -> None:
        environment = {
            "ONBOARDING_NAME": "fixture-onboarding", "PROXMOX_NODE": "node",
            "LXC_NAME": "app", "PROXMOX_LXC_TEMPLATE": "template",
            "PROXMOX_STORAGE": "storage", "PROXMOX_BRIDGE": "bridge",
            "PUBLIC_HOSTNAME": "site.example.invalid", "CLOUDFLARE_TUNNEL_NAME": "tunnel",
            "CLOUDFLARE_TUNNEL_SERVICE": "http://app:8080",
        }
        with patch.dict("os.environ", environment, clear=True):
            topology = load_topology_file("provisioning/topology.example.yaml")

        self.assertEqual("fixture-onboarding", topology.name)
        self.assertEqual("app", topology.lxc.name)
        self.assertEqual("site.example.invalid", topology.proxy.hostname)


if __name__ == "__main__":
    unittest.main()
