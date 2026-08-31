"""Unit tests for compute.py. LxcProvisionAdapter is exercised through a
fake provisioner_factory (see its docstring) — no real HttpJsonTransport or
network call, matching how tests/provisioning/test_adapters.py exercises the
underlying engine/adapters with a FakeTransport instead of live Proxmox."""
from __future__ import annotations

import os
import tempfile
import unittest
import unittest.mock

from control_plane_worker.compute import LxcProvisionAdapter, NullComputeAdapter


class FakeProxmox:
    def __init__(self, vmid: str | None = "999", *, exists_before_apply: bool = True) -> None:
        self.vmid = vmid
        self.inspected: list = []
        self.reset_calls: list = []
        # A container left behind by a failed earlier attempt is visible to
        # inspect() from the start; a genuinely-new one only after apply().
        self._exists_before_apply = exists_before_apply
        self.applied = False

    def inspect(self, spec):
        self.inspected.append(spec)
        if self.vmid is None:
            return None
        if not self.applied and not self._exists_before_apply:
            return None
        return {"vmid": self.vmid, "name": spec.name}

    def reset_trip_data(self, spec):
        self.reset_calls.append(spec)


class FakeProvisioner:
    def __init__(self, vmid: str | None = "999", *, exists_before_apply: bool = True) -> None:
        self.proxmox = FakeProxmox(vmid, exists_before_apply=exists_before_apply)
        self.apply_calls: list = []

    def apply(self, topology, *, execute: bool) -> None:
        self.apply_calls.append((topology, execute))
        self.proxmox.applied = True


def _adapter(deploy_root: str, ip_pool=None, provisioner: FakeProvisioner | None = None) -> LxcProvisionAdapter:
    provisioner = provisioner or FakeProvisioner()
    return LxcProvisionAdapter(
        deploy_root=deploy_root,
        node="pve", template="local:vztmpl/debian.tar.zst", storage="local-lvm", bridge="vmbr0",
        ip_pool=ip_pool or ["192.168.0.210", "192.168.0.211"],
        hostname_domain="ara-united.store", tunnel_id="edd0b94a-ecce-48b1-b3a5-33d15d0f5f8c",
        npm_url="https://npm.example", npm_api_token="npm-token",
        cloudflare_zone_id="zone", cloudflare_api_token="cf-token",
        provisioner_factory=lambda: provisioner,
    )


class NullComputeAdapterTests(unittest.TestCase):
    def test_create_container_raises(self) -> None:
        with self.assertRaises(ValueError):
            NullComputeAdapter().create_container("tokyo-2026")


class LxcProvisionAdapterTests(unittest.TestCase):
    def test_rejects_a_malformed_ip_pool_entry_at_construction(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            with self.assertRaises(ValueError):
                _adapter(deploy_root, ip_pool=["not-an-ip"])

    def test_create_container_picks_the_first_free_pool_ip_and_returns_the_vmid(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid="205")
            adapter = _adapter(deploy_root, provisioner=provisioner)

            vmid = adapter.create_container("tokyo-2026")

            self.assertEqual(vmid, "205")
            self.assertEqual(1, len(provisioner.apply_calls))
            topology, execute = provisioner.apply_calls[0]
            self.assertTrue(execute)
            self.assertEqual("192.168.0.210/24", topology.lxc.ipv4)
            self.assertEqual("trip-tokyo-2026", topology.lxc.name)
            self.assertEqual("tokyo-2026.ara-united.store", topology.proxy.hostname)
            # NPM must forward to the container's IP, not its LXC name: nothing
            # resolves trip-* hostnames on this LAN (confirmed 2026-08-28 —
            # even the live trip-kinerary does not resolve from the RPi4 that
            # runs NPM), and every working NPM proxy host is IP-based. The
            # hostname form came from the hand-written topology.yaml files,
            # which their own headers admit were never actually applied.
            self.assertEqual("192.168.0.210", topology.proxy.forward_host)
            # NOT the trip's own LXC address — the real tunnel forwards every
            # trip's ingress rule to NPM's local listener on the RPi4 itself.
            self.assertEqual("http://127.0.0.1:8080", topology.cloudflare.service)
            self.assertEqual("192.168.0.1", topology.lxc.gateway)
            self.assertEqual("192.168.0.41", topology.lxc.nameserver)
            self.assertEqual("/mnt/pve/truenas-nfs/tokyo-2026", topology.lxc.nfs_host_dir)
            self.assertEqual("/nfs/tokyo-2026", topology.lxc.nfs_mount_path)

            topology_path = os.path.join(deploy_root, "trips", "tokyo-2026", "topology.yaml")
            self.assertTrue(os.path.exists(topology_path))

    def test_create_container_writes_the_assigned_vmid_back_to_topology_yaml(self) -> None:
        # mcp_bridge.ShellMcpBridgeAdapter has no static vmid_map entry for a
        # slug this adapter created, so it reads the vmid from here instead.
        with tempfile.TemporaryDirectory() as deploy_root:
            adapter = _adapter(deploy_root, provisioner=FakeProvisioner(vmid="205"))
            adapter.create_container("tokyo-2026")

            topology_path = os.path.join(deploy_root, "trips", "tokyo-2026", "topology.yaml")
            contents = open(topology_path, encoding="utf-8").read()
            self.assertIn("vmid: '205'", contents)

    def test_a_retry_reuses_the_already_written_topology_instead_of_reallocating(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid="205")
            adapter = _adapter(deploy_root, provisioner=provisioner)
            adapter.create_container("tokyo-2026")

            # A second call (simulating a retried job after e.g. NPM/Cloudflare
            # creation failed downstream) must reuse the SAME topology, not
            # allocate a different pool IP.
            second_provisioner = FakeProvisioner(vmid="205")
            second_adapter = _adapter(deploy_root, provisioner=second_provisioner)
            second_adapter.create_container("tokyo-2026")

            topology, _ = second_provisioner.apply_calls[0]
            self.assertEqual("192.168.0.210/24", topology.lxc.ipv4)

    def test_first_provision_arms_the_data_reset_for_the_real_provisioner(self) -> None:
        # _build_provisioner (the real factory, not the fake here) reads
        # self._reset_data to construct ProxmoxLxcAdapter(reset_data=...); the
        # actual wipe is covered in tests/provisioning/test_adapters.py.
        with tempfile.TemporaryDirectory() as deploy_root:
            adapter = _adapter(deploy_root, provisioner=FakeProvisioner(vmid="205"))

            adapter.create_container("tokyo-2026", first_provision=True)
            self.assertTrue(adapter._reset_data)

            adapter.create_container("tokyo-2026")
            self.assertFalse(adapter._reset_data)

    def test_first_provision_wipes_data_when_a_failed_attempt_left_the_container(self) -> None:
        # inspect() sees a container from the start (debris of a failed earlier
        # attempt): apply() plans no create(), so create_container runs the wipe.
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid="205", exists_before_apply=True)
            adapter = _adapter(deploy_root, provisioner=provisioner)

            adapter.create_container("tokyo-2026", first_provision=True)

            self.assertEqual(1, len(provisioner.proxmox.reset_calls))
            self.assertEqual(
                "/mnt/pve/truenas-nfs/tokyo-2026",
                provisioner.proxmox.reset_calls[0].nfs_host_dir,
            )

    def test_first_provision_leaves_the_wipe_to_create_when_the_container_is_absent(self) -> None:
        # inspect() is None until apply() runs: create() runs and does its own
        # reset, so create_container must not double-wipe here.
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid="205", exists_before_apply=False)
            adapter = _adapter(deploy_root, provisioner=provisioner)

            adapter.create_container("tokyo-2026", first_provision=True)

            self.assertEqual([], provisioner.proxmox.reset_calls)

    def test_a_re_provision_that_is_not_first_never_wipes_data(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid="205", exists_before_apply=True)
            adapter = _adapter(deploy_root, provisioner=provisioner)

            adapter.create_container("tokyo-2026", first_provision=False)

            self.assertEqual([], provisioner.proxmox.reset_calls)

    def test_a_second_trip_gets_the_next_free_pool_ip(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            _adapter(deploy_root, provisioner=FakeProvisioner()).create_container("tokyo-2026")

            second_provisioner = FakeProvisioner()
            second_adapter = _adapter(deploy_root, provisioner=second_provisioner)
            second_adapter.create_container("kyoto-2026")

            topology, _ = second_provisioner.apply_calls[0]
            self.assertEqual("192.168.0.211/24", topology.lxc.ipv4)

    def test_raises_when_the_pool_is_exhausted(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            adapter = _adapter(deploy_root, ip_pool=["192.168.0.210"])
            adapter.create_container("tokyo-2026")

            second_adapter = _adapter(deploy_root, ip_pool=["192.168.0.210"])
            with self.assertRaises(RuntimeError):
                second_adapter.create_container("kyoto-2026")

    def test_raises_when_proxmox_reports_no_container_after_apply(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid=None)
            adapter = _adapter(deploy_root, provisioner=provisioner)
            with self.assertRaises(RuntimeError):
                adapter.create_container("tokyo-2026")


class NpmTokenMintingTests(unittest.TestCase):
    def _adapter(self, **kw) -> LxcProvisionAdapter:
        base = dict(
            deploy_root="/tmp", node="pve", template="t", storage="s", bridge="vmbr0",
            ip_pool=["192.168.0.210"], hostname_domain="ara-united.store",
            tunnel_id="edd0b94a-ecce-48b1-b3a5-33d15d0f5f8c",
            npm_url="https://npm.example", npm_api_token="static-token",
            cloudflare_zone_id="zone", cloudflare_api_token="cf-token",
        )
        base.update(kw)
        return LxcProvisionAdapter(**base)

    def test_falls_back_to_the_static_token_without_identity_and_secret(self) -> None:
        adapter = self._adapter()
        self.assertEqual("static-token", adapter._mint_npm_token())

    def test_exchanges_identity_and_secret_for_a_fresh_token(self) -> None:
        calls: list = []

        class FakeTransport:
            def __init__(self, base_url, headers):
                calls.append(("init", base_url, headers))

            def request(self, method, path, *, payload=None, params=None):
                calls.append(("request", method, path, payload))
                return {"token": "minted-jwt", "expires": "2026-09-01T00:00:00Z"}

        adapter = self._adapter(npm_identity="admin@npm", npm_secret="hunter2")
        with unittest.mock.patch("control_plane_worker.compute.HttpJsonTransport", FakeTransport):
            token = adapter._mint_npm_token()

        self.assertEqual("minted-jwt", token)
        self.assertEqual(
            ("request", "POST", "/api/tokens", {"identity": "admin@npm", "secret": "hunter2"}),
            calls[-1],
        )

    def test_raises_when_the_token_endpoint_returns_no_token(self) -> None:
        class FakeTransport:
            def __init__(self, *a, **k): ...
            def request(self, *a, **k):
                return {"expires": "soon"}

        adapter = self._adapter(npm_identity="admin@npm", npm_secret="hunter2")
        with unittest.mock.patch("control_plane_worker.compute.HttpJsonTransport", FakeTransport):
            with self.assertRaises(RuntimeError):
                adapter._mint_npm_token()


if __name__ == "__main__":
    unittest.main()
