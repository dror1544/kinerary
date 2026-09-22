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
            "PROXMOX_GATEWAY": "192.168.0.1", "PROXMOX_NAMESERVER": "192.168.0.41",
            "NFS_HOST_DIR": "/mnt/pve/truenas-nfs/app", "NFS_MOUNT_PATH": "/nfs/app",
            "PUBLIC_HOSTNAME": "site.example.invalid",
            "CLOUDFLARE_TUNNEL_ID": "edd0b94a-ecce-48b1-b3a5-33d15d0f5f8c",
            "CLOUDFLARE_TUNNEL_SERVICE": "http://app:8080",
        }
        with patch.dict("os.environ", environment, clear=True):
            topology = load_topology_file("provisioning/topology.example.yaml")

        self.assertEqual("fixture-onboarding", topology.name)
        self.assertEqual("app", topology.lxc.name)
        self.assertEqual("site.example.invalid", topology.proxy.hostname)
        # trip_slug is never a separate YAML key — every topology.yaml, old or
        # new, already carries the slug as its top-level `name`.
        self.assertEqual("fixture-onboarding", topology.lxc.trip_slug)

    def test_lxc_trip_slug_is_always_the_topologys_own_name(self) -> None:
        topology = load_topology({
            "version": 1, "name": "tokyo-2026",
            "proxmox": {
                "node": "pve",
                "lxc": {
                    "name": "trip-tokyo-2026", "template": "t", "storage": "s",
                    "cores": 2, "memory_mb": 1024, "disk_gb": 8, "bridge": "vmbr0",
                    "ipv4": "dhcp", "gateway": "192.168.0.1", "nameserver": "192.168.0.41",
                    "nfs_host_dir": "/mnt/pve/truenas-nfs/trip_9f2c11aa4d",
                    "nfs_mount_path": "/nfs/trip_9f2c11aa4d",
                },
            },
            "npm": {"hostname": "h", "forward_host": "1.2.3.4", "forward_port": 8080},
            "cloudflare": {"tunnel_id": "t", "hostname": "h", "service": "s"},
        })

        self.assertEqual("tokyo-2026", topology.lxc.trip_slug)


if __name__ == "__main__":
    unittest.main()
