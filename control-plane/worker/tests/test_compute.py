"""Unit tests for compute.py. LxcProvisionAdapter is exercised through a
fake provisioner_factory (see its docstring) — no real HttpJsonTransport or
network call, matching how tests/provisioning/test_adapters.py exercises the
underlying engine/adapters with a FakeTransport instead of live Proxmox."""
from __future__ import annotations

import os
import pathlib
import tempfile
import unittest
import unittest.mock

import yaml

from control_plane_worker.compute import LxcProvisionAdapter, NullComputeAdapter
from control_plane_worker.provisioner import ShellDeployAdapter
from provisioning.models import load_topology


class FakeProxmox:
    def __init__(
        self, vmid: str | None = "999", *, exists_before_apply: bool = True,
        password: str | None = "ab2c-d3ef-gh4j-km5n",
    ) -> None:
        self.vmid = vmid
        # What the container's own .env holds, as ProxmoxLxcAdapter.site_password
        # would read it back.
        self.password = password
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

    def site_password(self, spec):
        return self.password


class FakeProvisioner:
    def __init__(
        self, vmid: str | None = "999", *, exists_before_apply: bool = True,
        password: str | None = "ab2c-d3ef-gh4j-km5n",
    ) -> None:
        self.proxmox = FakeProxmox(vmid, exists_before_apply=exists_before_apply, password=password)
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
            self.assertEqual("tokyo-2026", topology.lxc.trip_slug)

            topology_path = os.path.join(deploy_root, "trips", "tokyo-2026", "topology.yaml")
            self.assertTrue(os.path.exists(topology_path))

    def test_a_new_trips_site_is_told_its_public_origin_so_the_member_connector_turns_on(self) -> None:
        # server/trip-mcp is off unless the site's .env carries PUBLIC_ORIGIN;
        # the bootstrap writes it from this field, and the OAuth issuer the
        # assistants see must equal the host the trip is actually served on.
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid="205")
            adapter = _adapter(deploy_root, provisioner=provisioner)

            adapter.create_container("tokyo-2026")

            topology, _ = provisioner.apply_calls[0]
            self.assertTrue(topology.proxy.hostname)
            self.assertEqual(f"https://{topology.proxy.hostname}", topology.lxc.public_origin)

    def test_a_new_trips_data_dir_and_its_mount_are_both_named_by_trip_id(self) -> None:
        # A slug is the organizer's words and is deliberately reusable: teardown
        # frees it, so the next family naming their trip the same way would land
        # on the previous family's data directory. A trip id cannot collide —
        # true of the host directory AND the container's own mount point, so
        # both are named by it. The slug survives only as LxcSpec.trip_slug,
        # for the one place that is not NFS: the container's own TRIP_DIR.
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid="205")
            adapter = _adapter(deploy_root, provisioner=provisioner)

            adapter.create_container("tokyo-2026", trip_id="trip_9f2c11aa4d")

            topology, _ = provisioner.apply_calls[0]
            self.assertEqual("/mnt/pve/truenas-nfs/trip_9f2c11aa4d", topology.lxc.nfs_host_dir)
            self.assertEqual("/nfs/trip_9f2c11aa4d", topology.lxc.nfs_mount_path)
            self.assertEqual("tokyo-2026", topology.lxc.trip_slug)

    def test_a_trip_that_already_has_a_topology_keeps_its_data_dir(self) -> None:
        # THE UPGRADE CASE. An existing site's data lives where its topology
        # says, and a redeploy must read that file rather than recompute a name
        # — recomputing is how a running family's site would be pointed at an
        # empty directory and come back with no participants, no photos and a
        # login nobody has.
        with tempfile.TemporaryDirectory() as deploy_root:
            first = FakeProvisioner(vmid="205")
            _adapter(deploy_root, provisioner=first).create_container("tokyo-2026")
            self.assertEqual(
                "/mnt/pve/truenas-nfs/tokyo-2026", first.apply_calls[0][0].lxc.nfs_host_dir,
            )

            # Same trip, provisioned again later — now with an id available.
            again = FakeProvisioner(vmid="205")
            _adapter(deploy_root, provisioner=again).create_container(
                "tokyo-2026", trip_id="trip_9f2c11aa4d",
            )

            self.assertEqual(
                "/mnt/pve/truenas-nfs/tokyo-2026",
                again.apply_calls[0][0].lxc.nfs_host_dir,
                "an existing trip keeps the directory its topology records",
            )

    def test_without_a_trip_id_the_data_dir_falls_back_to_the_slug(self) -> None:
        # Callers that have no id (the operator CLI, older call sites) still
        # provision; they just do not get the uniqueness.
        with tempfile.TemporaryDirectory() as deploy_root:
            provisioner = FakeProvisioner(vmid="205")
            _adapter(deploy_root, provisioner=provisioner).create_container("tokyo-2026")

            self.assertEqual(
                "/mnt/pve/truenas-nfs/tokyo-2026", provisioner.apply_calls[0][0].lxc.nfs_host_dir,
            )

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


class SitePasswordTests(unittest.TestCase):
    """The login password is per trip and lives on the trip's own container; this
    adapter only reports it. There is no deployment-wide value any more."""

    def test_reports_the_password_the_container_holds_after_apply(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            adapter = _adapter(deploy_root, provisioner=FakeProvisioner(password="k7mq-x3ra-pw9d-hn4t"))
            adapter.create_container("tokyo-2026")
            self.assertEqual("k7mq-x3ra-pw9d-hn4t", adapter.site_login_password("tokyo-2026"))

    def test_two_trips_report_their_own_passwords(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            adapter = _adapter(deploy_root)
            adapter._provisioner_factory = lambda: FakeProvisioner(password="aaaa-bbbb-cccc-dddd")
            adapter.create_container("tokyo-2026")
            adapter._provisioner_factory = lambda: FakeProvisioner(password="eeee-ffff-gggg-hhhh")
            adapter.create_container("kyoto-2026")

            self.assertEqual("aaaa-bbbb-cccc-dddd", adapter.site_login_password("tokyo-2026"))
            self.assertEqual("eeee-ffff-gggg-hhhh", adapter.site_login_password("kyoto-2026"))

    def test_a_site_with_no_password_in_its_env_reports_none_not_a_guess(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            adapter = _adapter(deploy_root, provisioner=FakeProvisioner(password=None))
            adapter.create_container("tokyo-2026")
            self.assertIsNone(adapter.site_login_password("tokyo-2026"))

    def test_a_trip_never_created_here_reports_none(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            self.assertIsNone(_adapter(deploy_root).site_login_password("never-seen"))

    def test_the_null_adapter_has_no_password_to_report(self) -> None:
        self.assertIsNone(NullComputeAdapter().site_login_password("tokyo-2026"))

    def test_a_deployment_wide_seed_password_can_no_longer_be_configured(self) -> None:
        with tempfile.TemporaryDirectory() as deploy_root:
            with self.assertRaises(TypeError):
                LxcProvisionAdapter(
                    deploy_root=deploy_root, node="pve", template="t", storage="s", bridge="b",
                    ip_pool=["192.168.0.210"], hostname_domain="x.example", tunnel_id="t",
                    npm_url="https://npm.example", npm_api_token="x",
                    cloudflare_zone_id="z", cloudflare_api_token="c",
                    seed_password="shared",  # type: ignore[call-arg]
                )

    def test_creating_a_container_logs_no_password(self) -> None:
        import logging

        class Capture(logging.Handler):
            def __init__(self) -> None:
                super().__init__(logging.DEBUG)
                self.seen: list[str] = []

            def emit(self, record: logging.LogRecord) -> None:
                self.seen.append(record.getMessage() + " " + repr(record.__dict__))

        capture = Capture()
        root = logging.getLogger()
        previous = root.level
        root.addHandler(capture)
        root.setLevel(logging.DEBUG)
        try:
            with tempfile.TemporaryDirectory() as deploy_root:
                adapter = _adapter(deploy_root, provisioner=FakeProvisioner(password="canary-0000-pass-word"))
                adapter.create_container("tokyo-2026")
                adapter.site_login_password("tokyo-2026")
                # and it is not written beside the topology the deploy repository tracks
                for dirpath, _dirs, files in os.walk(deploy_root):
                    for name in files:
                        with open(os.path.join(dirpath, name)) as handle:
                            self.assertNotIn("canary-0000", handle.read())
        finally:
            root.removeHandler(capture)
            root.setLevel(previous)
        self.assertEqual([], [line for line in capture.seen if "canary-0000" in line])


# ── placement (spec x-trip-vm-container-placement.md, PR1) ───────────────────

_HEADER = (
    "# Auto-generated by control_plane_worker.compute.LxcProvisionAdapter for demo.\n"
    "# Written BEFORE apply() runs so a retried job reuses the same IP/hostname\n"
    "# instead of allocating a second one.\n"
)
_LXC_LINES = """\
  lxc:
    name: trip-demo
    template: local:vztmpl/debian.tar.zst
    storage: local-lvm
    cores: 1
    memory_mb: 1024
    disk_gb: 8
    bridge: vmbr0
    ipv4: 192.0.2.210/24
    gateway: 192.0.2.1
    nameserver: 192.0.2.2
    nfs_host_dir: /mnt/nfs/trip_abc
    nfs_mount_path: /nfs/trip_abc
    forward_port: 8080
"""
_NPM_AND_CLOUDFLARE = """\
npm:
  hostname: demo.trips.example.invalid
  forward_host: 192.0.2.210
  forward_port: 8080
cloudflare:
  tunnel_id: 00000000-0000-0000-0000-000000000000
  hostname: demo.trips.example.invalid
  service: http://192.0.2.3:80
"""
# What the writer produced at f7e8c1a6, before placement existed. Literal text on purpose: a golden
# derived from the writer would move with it. AC-1: every LXC topology is byte-identical to this.
GOLDEN_LXC_TOPOLOGIES = {
    ("host", None): _HEADER + "version: 1\nname: demo\nproxmox:\n  node: pve\n" + _LXC_LINES + _NPM_AND_CLOUDFLARE,
    ("host", "205"): _HEADER + "version: 1\nname: demo\nproxmox:\n  node: pve\n  vmid: '205'\n"
                     + _LXC_LINES + _NPM_AND_CLOUDFLARE,
    ("wildcard", None): _HEADER + "version: 1\nname: demo\nrouting: wildcard\nproxmox:\n  node: pve\n"
                        + _LXC_LINES + "    public_hostname: demo.trips.example.invalid\n",
    ("wildcard", "205"): _HEADER + "version: 1\nname: demo\nrouting: wildcard\nproxmox:\n  node: pve\n  vmid: '205'\n"
                         + _LXC_LINES + "    public_hostname: demo.trips.example.invalid\n",
}


def _lxc_topology(routing: str):
    from provisioning.models import CloudflareSpec, LxcSpec, ProxySpec, Topology

    lxc = LxcSpec(
        name="trip-demo", node="pve", template="local:vztmpl/debian.tar.zst", storage="local-lvm",
        cores=1, memory_mb=1024, disk_gb=8, bridge="vmbr0", ipv4="192.0.2.210/24", gateway="192.0.2.1",
        nameserver="192.0.2.2", nfs_host_dir="/mnt/nfs/trip_abc", nfs_mount_path="/nfs/trip_abc",
        trip_slug="demo", public_origin="https://demo.trips.example.invalid", forward_port=8080,
    )
    if routing == "wildcard":
        return Topology(version=1, name="demo", lxc=lxc, proxy=None, cloudflare=None, routing="wildcard")
    return Topology(
        version=1, name="demo", lxc=lxc,
        proxy=ProxySpec("demo.trips.example.invalid", "192.0.2.210", 8080),
        cloudflare=CloudflareSpec("00000000-0000-0000-0000-000000000000", "demo.trips.example.invalid",
                                  "http://192.0.2.3:80"),
    )


class LxcTopologyWriteIsByteIdenticalTests(unittest.TestCase):
    """AC-1: no `placement:` line, and not one byte different, for any LXC topology."""

    def test_every_lxc_topology_is_written_exactly_as_before_placement_existed(self) -> None:
        for (routing, vmid), expected in GOLDEN_LXC_TOPOLOGIES.items():
            with self.subTest(routing=routing, vmid=vmid), tempfile.TemporaryDirectory() as root:
                adapter = _adapter(root)
                path = pathlib.Path(root) / "trips" / "demo" / "topology.yaml"
                adapter._write_topology(path, _lxc_topology(routing), "demo", vmid)
                written = path.read_text(encoding="utf-8")
                self.assertEqual(expected, written)
                self.assertNotIn("placement", written)
                self.assertNotIn("container:", written)

    def test_a_new_trip_built_by_the_adapter_records_no_placement(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            _adapter(root).create_container("tokyo-2026")
            written = (pathlib.Path(root) / "trips" / "tokyo-2026" / "topology.yaml").read_text(encoding="utf-8")
            self.assertNotIn("placement", written)


def _vm_container_topology():
    from provisioning.models import ContainerSpec, Topology

    return Topology(
        version=1, name="demo", lxc=None, proxy=None, cloudflare=None, routing="wildcard",
        placement="vm-container",
        container=ContainerSpec(
            name="trip-demo", ipv4="198.51.100.10", forward_port=8080,
            public_hostname="demo.trips.example.invalid", nfs_host_dir="/srv/trips/trip_abc",
            nfs_mount_path="/trip", image="trip-site:sha256-0123", trip_slug="demo",
            public_origin="https://demo.trips.example.invalid",
        ),
    )


class VmContainerTopologyWriteTests(unittest.TestCase):
    """The writer can say `vm-container` (nothing calls it that way yet: PR4) and what it
    writes reads back as the same topology, with no proxmox/npm/cloudflare section."""

    def _write(self, root: str) -> pathlib.Path:
        path = pathlib.Path(root) / "trips" / "demo" / "topology.yaml"
        _adapter(root)._write_topology(path, _vm_container_topology(), "demo")
        return path

    def test_it_writes_placement_and_a_container_section_and_nothing_proxmox(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            raw = yaml.safe_load(self._write(root).read_text(encoding="utf-8"))
        self.assertEqual("vm-container", raw["placement"])
        self.assertEqual("wildcard", raw["routing"])
        self.assertEqual({
            "name": "trip-demo", "ipv4": "198.51.100.10", "forward_port": 8080,
            "public_hostname": "demo.trips.example.invalid", "nfs_host_dir": "/srv/trips/trip_abc",
            "nfs_mount_path": "/trip", "image": "trip-site:sha256-0123",
        }, raw["container"])
        for absent in ("proxmox", "npm", "cloudflare"):
            self.assertNotIn(absent, raw)

    def test_what_it_writes_loads_back_as_the_same_topology(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            loaded = load_topology(yaml.safe_load(self._write(root).read_text(encoding="utf-8")))
        self.assertEqual(_vm_container_topology(), loaded)

    def test_the_two_line_scanners_read_a_vm_container_file(self) -> None:
        # The reason the container section reuses the LXC key names (spec, Contracts).
        with tempfile.TemporaryDirectory() as root:
            self._write(root)
            adapter = _adapter(root)
            self.assertEqual({"198.51.100.10"}, adapter._ips_already_claimed(exclude_slug="another-trip"))
            self.assertEqual(set(), adapter._ips_already_claimed(exclude_slug="demo"))
            deploy = ShellDeployAdapter.__new__(ShellDeployAdapter)
            deploy._deploy_root = root
            self.assertEqual("trip_abc", deploy._trip_nfs_dirname("demo"))


class VmContainerTopologyIsNotBuiltYetTests(unittest.TestCase):
    """A recorded placement always wins; a retry of a trip recorded as vm-container reaches nothing."""

    def test_create_container_refuses_before_any_adapter_acts(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            provisioner = FakeProvisioner()
            adapter = _adapter(root, provisioner=provisioner)
            path = pathlib.Path(root) / "trips" / "demo" / "topology.yaml"
            adapter._write_topology(path, _vm_container_topology(), "demo")
            before = path.read_text(encoding="utf-8")
            for first_provision in (False, True):
                with self.subTest(first_provision=first_provision), \
                        self.assertRaisesRegex(RuntimeError, "placement vm-container"):
                    adapter.create_container("demo", first_provision=first_provision)
            self.assertEqual([], provisioner.apply_calls)
            self.assertEqual([], provisioner.proxmox.inspected)
            self.assertEqual([], provisioner.proxmox.reset_calls)
            self.assertEqual(before, path.read_text(encoding="utf-8"), "the recorded topology is left alone")
