"""TRIP_ROUTING and TRIP_MCP_BRIDGE: provisioning without per-trip public records.

`TRIP_ROUTING=wildcard` makes the worker create only a trip's container: no NPM
proxy host, no Cloudflare record, no tunnel rule. Default `host` is today's
behaviour, and these tests pin that too. Nothing here touches a network, Proxmox
or a database: transports are recorded, never opened.

    PYTHONPATH=.:../.. python3 -m unittest discover -s tests   (from control-plane/worker)
"""
from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import yaml

from control_plane_worker.__main__ import build_parser, main
from control_plane_worker.compute import LxcProvisionAdapter
from control_plane_worker.mcp_bridge import ShellMcpBridgeAdapter, mcp_port_for_vmid
from control_plane_worker.provisioner import ShellDeployAdapter, TripRoute, topology_public_hostname, topology_route
from provisioning.engine import Provisioner
from provisioning.models import ProvisioningError

# Documentation address ranges and a reserved TLD: nothing here names a deployment.
DOMAIN = "trips.example.invalid"
POOL = ["192.0.2.210", "192.0.2.211"]


def _adapter(deploy_root: str, *, routing: str = "host", provisioner=None, **overrides) -> LxcProvisionAdapter:
    host = routing == "host"
    kwargs = dict(
        deploy_root=deploy_root, node="pve", template="local:vztmpl/debian.tar.zst", storage="local-lvm",
        bridge="vmbr0", ip_pool=POOL, hostname_domain=DOMAIN,
        tunnel_id="00000000-0000-0000-0000-000000000000" if host else "",
        npm_url="https://npm.example.invalid" if host else "", npm_api_token="npm-token" if host else "",
        cloudflare_zone_id="zone" if host else "", cloudflare_api_token="cf-token" if host else "",
        routing=routing,
    )
    if provisioner is not None:
        kwargs["provisioner_factory"] = lambda: provisioner
    kwargs.update(overrides)
    return LxcProvisionAdapter(**kwargs)


class _Recorder:
    """Adapters that remember every call; the container exists once created."""

    def __init__(self) -> None:
        self.proxmox, self.npm, self.cloudflare = mock.Mock(), mock.Mock(), mock.Mock()
        self.created = False
        self.proxmox.inspect.side_effect = lambda spec: (
            {"vmid": "205", "name": spec.name} if self.created else None)
        self.proxmox.create.side_effect = lambda spec: setattr(self, "created", True)
        self.proxmox.needs_bootstrap.return_value = False
        self.proxmox.site_password.return_value = "aaaa-bbbb-cccc-dddd"
        self.npm.inspect.return_value = None
        self.cloudflare.inspect.return_value = None
        self.snapshots: list = []
        outer = self

        class Recording(Provisioner):
            def apply(self, topology, *, execute=False):
                snapshot = super().apply(topology, execute=execute)
                outer.snapshots.append(snapshot)
                return snapshot

        self.provisioner = Recording(self.proxmox, self.npm, self.cloudflare)


class WildcardProvisionTests(unittest.TestCase):
    def test_a_new_trip_plans_one_create_and_writes_a_topology_with_no_public_sections(self) -> None:
        # AC-R2.2
        with tempfile.TemporaryDirectory() as root:
            rec = _Recorder()
            _adapter(root, routing="wildcard", provisioner=rec.provisioner).create_container("tokyo-2026")

            self.assertEqual([("proxmox_lxc", "create")],
                             [(c.resource, c.operation) for c in rec.snapshots[0].changes])
            raw = yaml.safe_load((Path(root) / "trips/tokyo-2026/topology.yaml").read_text())
            self.assertEqual("wildcard", raw["routing"])
            self.assertNotIn("npm", raw)
            self.assertNotIn("cloudflare", raw)
            lxc = raw["proxmox"]["lxc"]
            self.assertEqual(8080, lxc["forward_port"])
            self.assertEqual(f"tokyo-2026.{DOMAIN}", lxc["public_hostname"])
            self.assertEqual("192.0.2.210/24", lxc["ipv4"])
            self.assertEqual("205", raw["proxmox"]["vmid"], "the vmid is still written back after apply")

    def test_neither_npm_nor_cloudflare_is_ever_called(self) -> None:
        # AC-R2.3, at the engine: recording adapters in all three slots
        with tempfile.TemporaryDirectory() as root:
            rec = _Recorder()
            _adapter(root, routing="wildcard", provisioner=rec.provisioner).create_container("tokyo-2026")
            self.assertEqual([], rec.npm.method_calls)
            self.assertEqual([], rec.cloudflare.method_calls)
            rec.proxmox.create.assert_called_once()

    def test_no_public_transport_is_built_or_used_by_the_real_factory(self) -> None:
        # AC-R2.3, at the transports: the worker's own factory, with HTTP and SSH
        # transports replaced by recorders. The NPM transport (and its token
        # exchange), the Cloudflare transport and the SSH transport to the
        # tunnel's host are never even constructed.
        http, ssh, lxc_adapter = [], [], mock.Mock()
        lxc_adapter.inspect.return_value = None
        lxc_adapter.needs_bootstrap.return_value = False

        def make_http(*args, **kwargs):
            http.append((args, kwargs))
            return mock.Mock()

        def make_ssh(**kwargs):
            ssh.append(kwargs["host"])
            return mock.Mock()

        with tempfile.TemporaryDirectory() as root, \
                mock.patch("control_plane_worker.compute.HttpJsonTransport", make_http), \
                mock.patch("control_plane_worker.compute.SubprocessSshTransport", make_ssh), \
                mock.patch("control_plane_worker.compute.ProxmoxLxcAdapter", return_value=lxc_adapter):
            adapter = _adapter(root, routing="wildcard", proxmox_host="proxmox.example.invalid",
                               rpi_host="tunnel-host.example.invalid")
            topology = adapter._build_topology("tokyo-2026")
            provisioner = adapter._build_provisioner(topology)
            provisioner.apply(topology, execute=True)

        self.assertEqual([], http, "no NPM or Cloudflare transport may be built")
        self.assertEqual(["proxmox.example.invalid"], ssh, "only Proxmox is reached; not the tunnel's host")
        self.assertIsNone(provisioner.npm)
        self.assertIsNone(provisioner.cloudflare)
        lxc_adapter.create.assert_called_once()

    def test_the_trip_keeps_its_hostname_so_its_origin_does_not_change(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            rec = _Recorder()
            adapter = _adapter(root, routing="wildcard", provisioner=rec.provisioner)
            topology = adapter._build_topology("tokyo-2026")
            self.assertEqual(f"https://tokyo-2026.{DOMAIN}", topology.lxc.public_origin)
            self.assertEqual("wildcard", topology.routing)
            self.assertIsNone(topology.proxy)
            self.assertIsNone(topology.cloudflare)

    def test_a_second_provision_reuses_the_written_topology(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            rec = _Recorder()
            adapter = _adapter(root, routing="wildcard", provisioner=rec.provisioner)
            adapter.create_container("tokyo-2026")
            before = (Path(root) / "trips/tokyo-2026/topology.yaml").read_text()
            adapter.create_container("tokyo-2026")
            self.assertEqual(before, (Path(root) / "trips/tokyo-2026/topology.yaml").read_text())
            self.assertEqual([], rec.snapshots[1].changes, "the container exists: nothing to do")

    def test_the_routing_value_is_validated_by_the_adapter_too(self) -> None:
        with self.assertRaises(ValueError):
            _adapter("/tmp", routing="path")


class HostProvisionIsUnchanged(unittest.TestCase):
    def test_a_new_host_trip_plans_all_three_and_keeps_its_two_sections(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            rec = _Recorder()
            _adapter(root, provisioner=rec.provisioner).create_container("tokyo-2026")

            self.assertEqual(["proxmox_lxc", "npm_proxy_host", "cloudflare_tunnel_dns"],
                             [c.resource for c in rec.snapshots[0].changes])
            raw = yaml.safe_load((Path(root) / "trips/tokyo-2026/topology.yaml").read_text())
            self.assertNotIn("routing", raw, "a host topology is written as it always was")
            self.assertEqual(f"tokyo-2026.{DOMAIN}", raw["npm"]["hostname"])
            self.assertEqual("192.0.2.210", raw["npm"]["forward_host"])
            self.assertEqual(8080, raw["npm"]["forward_port"])
            self.assertEqual("http://127.0.0.1:8080", raw["cloudflare"]["service"])
            self.assertEqual(8080, raw["proxmox"]["lxc"]["forward_port"], "written in both modes")
            self.assertNotIn("public_hostname", raw["proxmox"]["lxc"], "one copy of the hostname, in npm")

    def test_the_real_factory_still_builds_all_three_adapters(self) -> None:
        http = []
        with mock.patch("control_plane_worker.compute.HttpJsonTransport",
                        lambda *a, **k: http.append(a) or mock.Mock()), \
                mock.patch("control_plane_worker.compute.SubprocessSshTransport", lambda **k: mock.Mock()):
            provisioner = _adapter("/tmp")._build_provisioner()
        self.assertIsNotNone(provisioner.npm)
        self.assertIsNotNone(provisioner.cloudflare)
        self.assertEqual(2, len(http))

    def test_an_existing_host_topology_stays_host_on_a_wildcard_worker(self) -> None:
        # A trip built before the switch keeps what its own file says: it is
        # planned with its proxy host and DNS record, not silently stripped.
        with tempfile.TemporaryDirectory() as root:
            _adapter(root, provisioner=_Recorder().provisioner).create_container("tokyo-2026")
            rec = _Recorder()
            _adapter(root, routing="wildcard", provisioner=rec.provisioner).create_container("tokyo-2026")
            self.assertEqual(["proxmox_lxc", "npm_proxy_host", "cloudflare_tunnel_dns"],
                             [c.resource for c in rec.snapshots[0].changes])
            raw = yaml.safe_load((Path(root) / "trips/tokyo-2026/topology.yaml").read_text())
            self.assertNotIn("routing", raw)

    def test_a_wildcard_worker_without_credentials_refuses_a_host_topology_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            _adapter(root, provisioner=_Recorder().provisioner).create_container("tokyo-2026")
            adapter = _adapter(root, routing="wildcard")  # no factory: the real one
            topology = adapter._load_topology(adapter._topology_path("tokyo-2026"))
            with mock.patch("control_plane_worker.compute.SubprocessSshTransport", lambda **k: mock.Mock()):
                with self.assertRaisesRegex(RuntimeError, "NPM"):
                    adapter._build_provisioner(topology)

    def test_the_engine_refuses_a_section_it_has_no_adapter_for(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            adapter = _adapter(root)
            topology = adapter._build_topology("tokyo-2026")
            with self.assertRaises(ProvisioningError):
                Provisioner(mock.Mock()).plan(topology)


_REQUIRED_BASE = {
    "PROVISIONER_DEPLOY_ROOT": "/deploy-root", "PROVISIONER_VMID_MAP": "{}",
    "CONTROL_PLANE_DATABASE_URL_FILE": "/unused", "PROVISIONER_COMPUTE_ENABLED": "1",
    "PROVISIONER_LXC_IP_POOL": '["192.0.2.210"]', "PROXMOX_NODE": "pve",
    "PROXMOX_LXC_TEMPLATE": "t", "PROXMOX_STORAGE": "s", "PROXMOX_BRIDGE": "vmbr0",
    "PROVISIONER_LXC_HOSTNAME_DOMAIN": DOMAIN,
}
_HOST_ONLY = {
    "PROVISIONER_LXC_TUNNEL_ID": "00000000-0000-0000-0000-000000000000", "NPM_URL": "https://npm.example.invalid",
    "NPM_API_TOKEN": "t", "CLOUDFLARE_ZONE_ID": "zone", "CLOUDFLARE_API_TOKEN": "cf",
}


def _run_main(env: dict[str, str], argv: list[str] | None = None):
    """main(["provision"]) up to the poll loop, which is replaced. Returns
    (exit, stdout, adapter kwargs of the LxcProvisionAdapter, shell-bridge kwargs)."""
    adapter_kwargs: dict = {}
    bridge_kwargs: dict = {}

    def fake_adapter(**kwargs):
        adapter_kwargs.update(kwargs)
        return mock.Mock()

    def fake_bridge(**kwargs):
        bridge_kwargs.update(kwargs)
        return mock.Mock()

    out, err = io.StringIO(), io.StringIO()
    with tempfile.TemporaryDirectory() as tmp:
        secret = Path(tmp) / "db"
        secret.write_text("postgres://unused.invalid/none")
        merged = {**env, "CONTROL_PLANE_DATABASE_URL_FILE": str(secret)}
        with mock.patch.dict(os.environ, merged, clear=True), \
                mock.patch("control_plane_worker.compute.LxcProvisionAdapter", fake_adapter), \
                mock.patch("control_plane_worker.mcp_bridge.ShellMcpBridgeAdapter", fake_bridge), \
                mock.patch("control_plane_worker.__main__.poll_loop"), \
                mock.patch("signal.signal"), \
                redirect_stdout(out), redirect_stderr(err):
            try:
                code = main(["provision", *(argv or [])])
            except SystemExit as exc:
                code = exc.code
    return code, out.getvalue() + err.getvalue(), adapter_kwargs, bridge_kwargs


class StartupTests(unittest.TestCase):
    def test_routing_defaults_to_host_and_an_empty_variable_means_the_default(self) -> None:
        # AC-R2.1; compose passes `${TRIP_ROUTING:-}`, i.e. "" when unset.
        for env in ({}, {"TRIP_ROUTING": ""}):
            with self.subTest(env=env), mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual("host", build_parser().parse_args(["provision"]).trip_routing)

    def test_the_two_values_are_accepted(self) -> None:
        for value in ("host", "wildcard"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {"TRIP_ROUTING": value}, clear=True):
                self.assertEqual(value, build_parser().parse_args(["provision"]).trip_routing)

    def test_anything_else_refuses_to_start(self) -> None:
        for bad in ("path", "Wildcard", "WILDCARD", " wildcard", "wildcard ", "hosts", "1", "true"):
            with self.subTest(value=bad), mock.patch.dict(os.environ, {"TRIP_ROUTING": bad}, clear=True), \
                    redirect_stderr(io.StringIO()) as err:
                with self.assertRaises(SystemExit) as raised:
                    build_parser().parse_args(["provision"])
                self.assertEqual(2, raised.exception.code)
                self.assertIn("TRIP_ROUTING", err.getvalue())

    def test_a_bad_value_refuses_even_with_compute_off(self) -> None:
        code, text, _a, _b = _run_main({**_REQUIRED_BASE, "PROVISIONER_COMPUTE_ENABLED": "0", "TRIP_ROUTING": "oops"})
        self.assertEqual(2, code)
        self.assertIn("TRIP_ROUTING", text)

    def test_wildcard_starts_with_no_tunnel_npm_or_cloudflare_variables(self) -> None:
        # AC-R2.4
        code, text, kwargs, _b = _run_main({**_REQUIRED_BASE, "TRIP_ROUTING": "wildcard"})
        self.assertEqual(0, code, text)
        self.assertEqual("wildcard", kwargs["routing"])
        self.assertEqual(DOMAIN, kwargs["hostname_domain"])
        for name in ("tunnel_id", "npm_url", "cloudflare_zone_id", "cloudflare_api_token"):
            self.assertEqual("", kwargs[name], name)
        self.assertIn("trip routing: wildcard", text, "the mode is said at every start")

    def test_wildcard_still_requires_the_hostname_domain(self) -> None:
        env = {**_REQUIRED_BASE, "TRIP_ROUTING": "wildcard"}
        del env["PROVISIONER_LXC_HOSTNAME_DOMAIN"]
        code, text, _a, _b = _run_main(env)
        self.assertEqual(2, code)
        self.assertIn("PROVISIONER_LXC_HOSTNAME_DOMAIN", text)

    def test_wildcard_keeps_working_credentials_when_they_are_set(self) -> None:
        # So re-provisioning a host-routed trip on a wildcard worker still can.
        code, text, kwargs, _b = _run_main({**_REQUIRED_BASE, **_HOST_ONLY, "TRIP_ROUTING": "wildcard"})
        self.assertEqual(0, code, text)
        self.assertEqual("https://npm.example.invalid", kwargs["npm_url"])
        self.assertEqual("cf", kwargs["cloudflare_api_token"])

    def test_host_mode_requires_exactly_what_it_always_did(self) -> None:
        code, text, kwargs, _b = _run_main({**_REQUIRED_BASE, **_HOST_ONLY})
        self.assertEqual(0, code, text)
        self.assertEqual("host", kwargs["routing"])
        for missing in ("PROVISIONER_LXC_TUNNEL_ID", "NPM_URL", "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_API_TOKEN",
                        "NPM_API_TOKEN"):
            with self.subTest(missing=missing):
                env = {**_REQUIRED_BASE, **_HOST_ONLY}
                del env[missing]
                code, text, _a, _b = _run_main(env)
                self.assertEqual(2, code)
                self.assertIn(missing.split("_")[0], text)

    def test_an_unset_routing_is_host_so_the_old_required_set_applies(self) -> None:
        code, text, _a, _b = _run_main(dict(_REQUIRED_BASE))  # no HOST_ONLY, no TRIP_ROUTING
        self.assertEqual(2, code, "host mode without its variables must still refuse to start")


_SHARED_BRIDGE = {"TRIP_MCP_BRIDGE": "shared", "TRIP_MCP_SHARED_SITE_URL": "http://192.0.2.77:3999"}
# TRIP_PLACEMENT=vm-container, complete. No Proxmox variable, no LXC address pool: the container path needs none.
_CONTAINER_SETTINGS = {
    "TRIP_CONTAINER_SSH_HOST": "host.example.invalid", "TRIP_CONTAINER_SSH_USER": "tripctl",
    "TRIP_CONTAINER_SSH_KEY": "/keys/trip-container", "TRIP_CONTAINER_SSH_KNOWN_HOSTS": "/keys/known_hosts",
    "TRIP_CONTAINER_IP_POOL": '["10.250.0.10", "10.250.0.11"]', "TRIP_CONTAINER_BRIDGE_URL": "http://172.30.0.1:4311",
}
_VM_CONTAINER_ENV = {
    "PROVISIONER_DEPLOY_ROOT": "/deploy-root", "PROVISIONER_VMID_MAP": "{}",
    "CONTROL_PLANE_DATABASE_URL_FILE": "/unused", "PROVISIONER_COMPUTE_ENABLED": "1",
    "PROVISIONER_LXC_HOSTNAME_DOMAIN": DOMAIN, "TRIP_ROUTING": "wildcard", **_SHARED_BRIDGE,
    "TRIP_PLACEMENT": "vm-container", "PROVISIONER_TRIP_NFS_LOCAL_BASE": "/srv/kinerary-nfs", **_CONTAINER_SETTINGS,
}


class PlacementStartupTests(unittest.TestCase):
    """TRIP_PLACEMENT (spec x-trip-vm-container-placement.md, AC-2). A start that is refused says WHICH
    setting is wrong, so each test asserts the message and not only the exit code."""

    NOT_YET = "not available yet"

    def test_placement_defaults_to_lxc_and_an_empty_variable_means_the_default(self) -> None:
        for env in ({}, {"TRIP_PLACEMENT": ""}):
            with self.subTest(env=env), mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual("lxc", build_parser().parse_args(["provision"]).trip_placement)

    def test_the_two_values_and_the_flag_are_accepted(self) -> None:
        for value in ("lxc", "vm-container"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {"TRIP_PLACEMENT": value}, clear=True):
                self.assertEqual(value, build_parser().parse_args(["provision"]).trip_placement)
        with mock.patch.dict(os.environ, {}, clear=True):
            args = build_parser().parse_args(["provision", "--trip-placement", "vm-container"])
        self.assertEqual("vm-container", args.trip_placement)

    def test_an_unknown_value_refuses_to_start_naming_the_variable(self) -> None:
        for bad in ("docker", "VM-CONTAINER", "vm_container", " lxc", "lxc ", "1", "container"):
            with self.subTest(value=bad), mock.patch.dict(os.environ, {"TRIP_PLACEMENT": bad}, clear=True), \
                    redirect_stderr(io.StringIO()) as err:
                with self.assertRaises(SystemExit) as raised:
                    build_parser().parse_args(["provision"])
                self.assertEqual(2, raised.exception.code)
                self.assertIn("TRIP_PLACEMENT", err.getvalue())

    def test_an_unknown_value_refuses_even_with_compute_off(self) -> None:
        code, text, adapter, _b = _run_main(
            {**_REQUIRED_BASE, "PROVISIONER_COMPUTE_ENABLED": "0", "TRIP_PLACEMENT": "oops"})
        self.assertEqual(2, code)
        self.assertIn("TRIP_PLACEMENT", text)
        self.assertNotIn(self.NOT_YET, text)
        self.assertEqual({}, adapter)

    def test_unset_and_lxc_start_as_they_always_did_and_say_which_placement(self) -> None:
        for env in ({}, {"TRIP_PLACEMENT": ""}, {"TRIP_PLACEMENT": "lxc"}):
            with self.subTest(env=env):
                code, text, kwargs, _b = _run_main({**_REQUIRED_BASE, **_HOST_ONLY, **env})
                self.assertEqual(0, code, text)
                self.assertIn("trip placement: lxc", text, "the placement is said at every start")
                self.assertNotIn("placement", kwargs, "the adapter is not told: its construction is what it always was")

    def test_vm_container_with_the_wrong_routing_names_routing_and_not_the_bridge(self) -> None:
        code, text, adapter, _b = _run_main({**_REQUIRED_BASE, **_HOST_ONLY, **_SHARED_BRIDGE,
                                             "TRIP_PLACEMENT": "vm-container"})
        self.assertEqual(2, code)
        self.assertIn("TRIP_ROUTING=wildcard", text)
        self.assertNotIn("TRIP_MCP_BRIDGE", text)
        self.assertNotIn(self.NOT_YET, text)
        self.assertEqual({}, adapter)

    def test_vm_container_with_the_wrong_bridge_names_the_bridge_and_not_routing(self) -> None:
        code, text, adapter, _b = _run_main({**_REQUIRED_BASE, "TRIP_ROUTING": "wildcard",
                                             "TRIP_PLACEMENT": "vm-container"})
        self.assertEqual(2, code)
        self.assertIn("TRIP_MCP_BRIDGE=shared", text)
        self.assertNotIn("TRIP_ROUTING", text)
        self.assertNotIn(self.NOT_YET, text)
        self.assertEqual({}, adapter)

    def test_vm_container_with_neither_names_both_settings(self) -> None:
        code, text, _a, _b = _run_main({**_REQUIRED_BASE, **_HOST_ONLY, "TRIP_PLACEMENT": "vm-container"})
        self.assertEqual(2, code)
        self.assertIn("TRIP_ROUTING=wildcard", text)
        self.assertIn("TRIP_MCP_BRIDGE=shared", text)
        self.assertNotIn(self.NOT_YET, text)

    # -- the placement is built now (PR4): a complete configuration starts, an incomplete one names what is missing

    def test_a_complete_vm_container_configuration_starts_and_builds_the_container_path(self) -> None:
        with mock.patch("control_plane_worker.trip_container.DockerSiteAdapter.preflight") as preflight:
            code, text, kwargs, _b = _run_main(_VM_CONTAINER_ENV)
        self.assertEqual(0, code, text)
        self.assertNotIn(self.NOT_YET, text)
        preflight.assert_called_once_with()
        self.assertEqual("vm-container", kwargs["placement"])
        self.assertEqual("wildcard", kwargs["routing"])
        self.assertEqual(["10.250.0.10", "10.250.0.11"], kwargs["container_ip_pool"])
        self.assertEqual("/srv/kinerary-nfs", kwargs["nfs_local_base"])
        from control_plane_worker.trip_container import DockerSiteAdapter
        self.assertIsInstance(kwargs["container_site"], DockerSiteAdapter)
        self.assertIn("trip placement: vm-container", text)
        self.assertIn("trip container host: ssh -> tripctl@host.example.invalid", text)

    def test_the_hosts_key_and_pin_are_never_printed(self) -> None:
        with mock.patch("control_plane_worker.trip_container.DockerSiteAdapter.preflight"):
            _code, text, _a, _b = _run_main(_VM_CONTAINER_ENV)
        for secret_path in ("/keys/trip-container", "/keys/known_hosts"):
            self.assertNotIn(secret_path, text)

    def test_every_missing_container_setting_is_named_and_nothing_is_built(self) -> None:
        for name in _CONTAINER_SETTINGS:
            with self.subTest(missing=name):
                env = {k: v for k, v in _VM_CONTAINER_ENV.items() if k != name}
                code, text, adapter, _b = _run_main(env)
                self.assertEqual(2, code)
                self.assertIn(name, text)
                self.assertEqual({}, adapter)

    def test_the_other_requirements_of_the_container_path_are_named_together(self) -> None:
        env = {k: v for k, v in _VM_CONTAINER_ENV.items()
               if k not in ("PROVISIONER_COMPUTE_ENABLED", "PROVISIONER_TRIP_NFS_LOCAL_BASE")}
        env["PROVISIONER_COMPUTE_ENABLED"] = "0"
        code, text, adapter, _b = _run_main(env)
        self.assertEqual(2, code)
        self.assertIn("PROVISIONER_COMPUTE_ENABLED=1", text)
        self.assertIn("PROVISIONER_TRIP_NFS_LOCAL_BASE", text)
        self.assertEqual({}, adapter)

    def test_the_container_path_needs_no_proxmox_variable_and_no_lxc_address_pool(self) -> None:
        for name in ("PROXMOX_NODE", "PROXMOX_LXC_TEMPLATE", "PROXMOX_STORAGE", "PROXMOX_BRIDGE", "PROVISIONER_LXC_IP_POOL"):
            self.assertNotIn(name, _VM_CONTAINER_ENV)
        with mock.patch("control_plane_worker.trip_container.DockerSiteAdapter.preflight"):
            code, text, kwargs, _b = _run_main(_VM_CONTAINER_ENV)
        self.assertEqual(0, code, text)
        self.assertEqual([], kwargs["ip_pool"])
        self.assertEqual("", kwargs["node"])

    def test_the_lxc_variables_are_kept_when_they_are_set_so_an_lxc_trip_can_still_be_re_provisioned(self) -> None:
        with mock.patch("control_plane_worker.trip_container.DockerSiteAdapter.preflight"):
            code, text, kwargs, _b = _run_main({**_VM_CONTAINER_ENV, **_REQUIRED_BASE})
        self.assertEqual(0, code, text)
        self.assertEqual(["192.0.2.210"], kwargs["ip_pool"])
        self.assertEqual("pve", kwargs["node"])

    def test_an_lxc_worker_with_no_container_settings_is_built_exactly_as_before(self) -> None:
        code, text, kwargs, _b = _run_main({**_REQUIRED_BASE, **_HOST_ONLY})
        self.assertEqual(0, code, text)
        for name in ("placement", "container_site", "container_ip_pool", "nfs_local_base"):
            self.assertNotIn(name, kwargs, "the adapter is not told: its construction is what it always was")

    def test_a_complete_container_configuration_on_an_lxc_worker_only_re_provisions_and_asks_the_host_nothing(self) -> None:
        env = {**_REQUIRED_BASE, **_HOST_ONLY, **{k: v for k, v in _VM_CONTAINER_ENV.items() if k in _CONTAINER_SETTINGS},
               "PROVISIONER_TRIP_NFS_LOCAL_BASE": "/srv/kinerary-nfs"}
        with mock.patch("control_plane_worker.trip_container.DockerSiteAdapter.preflight") as preflight:
            code, text, kwargs, _b = _run_main(env)
        self.assertEqual(0, code, text)
        preflight.assert_not_called()
        self.assertEqual("lxc", kwargs["placement"])
        self.assertIsNotNone(kwargs["container_site"])

    def test_an_incomplete_container_configuration_on_an_lxc_worker_refuses_naming_the_rest(self) -> None:
        env = {**_REQUIRED_BASE, **_HOST_ONLY, "TRIP_CONTAINER_SSH_HOST": "host.example.invalid"}
        code, text, adapter, _b = _run_main(env)
        self.assertEqual(2, code)
        self.assertIn("TRIP_CONTAINER_* is set but incomplete", text)
        self.assertIn("TRIP_CONTAINER_SSH_KEY", text)
        self.assertNotIn("TRIP_CONTAINER_SSH_HOST,", text)
        self.assertEqual({}, adapter)

    def test_a_bad_bridge_url_names_its_own_variable(self) -> None:
        code, text, _a, _b = _run_main({**_VM_CONTAINER_ENV, "TRIP_CONTAINER_BRIDGE_URL": "http://bridge.example.invalid/x"})
        self.assertEqual(2, code)
        self.assertIn("TRIP_CONTAINER_BRIDGE_URL", text)
        self.assertNotIn("TRIP_MCP_SHARED_SITE_URL must be", text)

    def test_a_bad_address_pool_refuses_at_start(self) -> None:
        for bad in ("[]", '["10.250.0.10", "10.250.0.10"]', '["nope"]', "not json"):
            with self.subTest(pool=bad), mock.patch("control_plane_worker.trip_container.DockerSiteAdapter.preflight"):
                code, text, adapter, _b = _run_main({**_VM_CONTAINER_ENV, "TRIP_CONTAINER_IP_POOL": bad})
                self.assertEqual(2, code, text)
                self.assertIn("TRIP_CONTAINER_IP_POOL", text)
                self.assertEqual({}, adapter)

    def test_a_host_that_does_not_answer_the_preflight_stops_the_worker_loudly(self) -> None:
        from control_plane_worker.trip_container import TripContainerRefused
        with mock.patch("control_plane_worker.trip_container.DockerSiteAdapter.preflight",
                        side_effect=TripContainerRefused("the trip-container host refused read: the host configuration "
                                                         "file is missing or is not a plain file")):
            code, text, adapter, _b = _run_main(_VM_CONTAINER_ENV)
        self.assertNotEqual(0, code)
        self.assertIn("host configuration file is missing", text)
        self.assertEqual({}, adapter)

    def test_the_same_valid_combination_starts_with_placement_lxc(self) -> None:
        env = {**_REQUIRED_BASE, "TRIP_ROUTING": "wildcard", **_SHARED_BRIDGE, "TRIP_PLACEMENT": "lxc"}
        code, text, _a, _b = _run_main(env)
        self.assertEqual(0, code, text)


class McpBridgeModeTests(unittest.TestCase):
    def test_default_is_per_trip_and_empty_means_default(self) -> None:
        for env in ({}, {"TRIP_MCP_BRIDGE": ""}):
            with self.subTest(env=env), mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual("per_trip", build_parser().parse_args(["provision"]).trip_mcp_bridge)

    def test_other_values_refuse_to_start(self) -> None:
        for bad in ("Shared", "per-trip", "perTrip", "one", " shared"):
            with self.subTest(value=bad), mock.patch.dict(os.environ, {"TRIP_MCP_BRIDGE": bad}, clear=True), \
                    redirect_stderr(io.StringIO()) as err:
                with self.assertRaises(SystemExit):
                    build_parser().parse_args(["provision"])
                self.assertIn("TRIP_MCP_BRIDGE", err.getvalue())

    def test_the_mode_reaches_the_shell_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as templates:
            for value, expected in (("shared", True), ("per_trip", False), ("", False)):
                with self.subTest(value=value):
                    code, text, _a, bridge = _run_main({
                        **_REQUIRED_BASE, "PROVISIONER_COMPUTE_ENABLED": "0",
                        "PROVISIONER_COMPANION_TEMPLATES_DIR": templates, "TRIP_MCP_BRIDGE": value,
                        # Required with `shared` since the F3 fix, refused without it.
                        **({"TRIP_MCP_SHARED_SITE_URL": "http://192.0.2.77:3999"} if value == "shared" else {}),
                    })
                    self.assertEqual(0, code, text)
                    self.assertIs(expected, bridge["shared_bridge"])


class SharedBridgeWorkerHalfTests(unittest.TestCase):
    """AC-B2.6, the worker half: a vmid with no derivable port no longer stops
    the request - only when the worker is told the host is shared."""

    TOPOLOGY = (
        "proxmox:\n  vmid: '{vmid}'\n  lxc:\n    ipv4: 192.0.2.50/24\n"
        "npm:\n  hostname: x.example.invalid\n  forward_port: 8080\n"
    )

    def _setup(self, vmid: str, *, shared: bool):
        with tempfile.TemporaryDirectory() as root:
            trip = Path(root, "trips", "tokyo-2026")
            trip.mkdir(parents=True)
            (trip / "topology.yaml").write_text(self.TOPOLOGY.format(vmid=vmid))
            adapter = ShellMcpBridgeAdapter(deploy_root=root, vmid_map={}, shared_bridge=shared)
            with mock.patch("control_plane_worker.mcp_bridge.subprocess.run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = run.return_value.stderr = ""
                return adapter.setup("tokyo-2026", "tokyo2026"), run

    def test_per_trip_still_skips_a_vmid_that_gives_no_sane_port(self) -> None:
        for vmid in ("5", "4000", "9999"):
            with self.subTest(vmid=vmid):
                self.assertIsNone(mcp_port_for_vmid(vmid))
                wired, run = self._setup(vmid, shared=False)
                self.assertFalse(wired)
                run.assert_not_called()

    def test_shared_makes_the_request_without_a_port(self) -> None:
        for vmid in ("5", "4000"):
            with self.subTest(vmid=vmid):
                wired, run = self._setup(vmid, shared=True)
                self.assertTrue(wired)
                argv = run.call_args.args[0]
                self.assertNotIn("--port", argv, "a port nothing derived must not be invented")
                self.assertIn("--vmid", argv)
                self.assertIn("http://192.0.2.50:8080", argv)

    def test_shared_keeps_the_port_when_there_is_one(self) -> None:
        wired, run = self._setup("210", shared=True)
        self.assertTrue(wired)
        argv = run.call_args.args[0]
        self.assertEqual(str(mcp_port_for_vmid("210")), argv[argv.index("--port") + 1])


LEGACY_TOPOLOGY = """\
version: 1
name: tokyo-2026
proxmox:
  node: pve
  vmid: '205'
  lxc:
    name: trip-tokyo-2026
    ipv4: 192.0.2.210/24
npm:
  hostname: tokyo-2026.example.invalid
  forward_host: 192.0.2.210
  forward_port: 8080
cloudflare:
  tunnel_id: tunnel
  hostname: tokyo-2026.example.invalid
  service: http://127.0.0.1:8080
"""


class PrivateUrlAndRouteTests(unittest.TestCase):
    """AC-R2.6: the private URL comes from the topology's own hostname, and an
    existing topology gives the value it always did."""

    def _deploy(self, text: str | None, slug: str = "tokyo-2026"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        trip = Path(tmp.name, "trips", slug)
        trip.mkdir(parents=True)
        if text is not None:
            (trip / "topology.yaml").write_text(text)
        return ShellDeployAdapter(deploy_root=tmp.name, vmid_map={}), str(trip)

    def test_an_existing_topology_gives_the_url_it_always_did(self) -> None:
        deploy, trip = self._deploy(LEGACY_TOPOLOGY)
        self.assertEqual("https://tokyo-2026.example.invalid", deploy._private_url(trip))

    def test_a_wildcard_topology_has_no_npm_section_and_still_gives_one(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            rec = _Recorder()
            _adapter(root, routing="wildcard", provisioner=rec.provisioner).create_container("tokyo-2026")
            deploy = ShellDeployAdapter(deploy_root=root, vmid_map={})
            self.assertEqual(f"https://tokyo-2026.{DOMAIN}", deploy._private_url(os.path.join(root, "trips/tokyo-2026")))

    def test_a_topology_with_a_placeholder_hostname_is_still_refused(self) -> None:
        deploy, trip = self._deploy(LEGACY_TOPOLOGY.replace("tokyo-2026.example.invalid", "${PUBLIC_HOSTNAME}"))
        with self.assertRaises(ValueError):
            deploy._private_url(trip)

    def test_no_topology_is_still_an_error(self) -> None:
        deploy, trip = self._deploy(None)
        with self.assertRaises(ValueError):
            deploy._private_url(trip)

    def test_route_for_reads_host_and_upstream_from_a_host_topology(self) -> None:
        deploy, _trip = self._deploy(LEGACY_TOPOLOGY)
        self.assertEqual(TripRoute("tokyo-2026.example.invalid", "http://192.0.2.210:8080", "host"),
                         deploy.route_for("tokyo-2026"))

    def test_route_for_reads_a_wildcard_topology(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            _adapter(root, routing="wildcard", provisioner=_Recorder().provisioner).create_container("tokyo-2026")
            route = ShellDeployAdapter(deploy_root=root, vmid_map={}).route_for("tokyo-2026")
        self.assertEqual(TripRoute(f"tokyo-2026.{DOMAIN}", "http://192.0.2.210:8080", "wildcard"), route)

    def test_a_topology_without_a_usable_address_gives_none_for_a_host_trip(self) -> None:
        for what, text in (
            ("dhcp", LEGACY_TOPOLOGY.replace("192.0.2.210/24", "dhcp")),
            ("non-ASCII digits", LEGACY_TOPOLOGY.replace("192.0.2.210/24", "192.0.2.２１０/24")),
            ("port zero", LEGACY_TOPOLOGY.replace("forward_port: 8080", "forward_port: 0")),
            ("port too big", LEGACY_TOPOLOGY.replace("forward_port: 8080", "forward_port: 70000")),
            ("port as text", LEGACY_TOPOLOGY.replace("forward_port: 8080", "forward_port: '８０８０'")),
            ("no port", LEGACY_TOPOLOGY.replace("  forward_port: 8080\n", "")),
            ("placeholder host", LEGACY_TOPOLOGY.replace("tokyo-2026.example.invalid", "${H}")),
        ):
            with self.subTest(what):
                deploy, _trip = self._deploy(text)
                self.assertIsNone(deploy.route_for("tokyo-2026"))

    def test_a_wildcard_trip_with_no_usable_route_fails_loudly(self) -> None:
        # Nothing else makes its hostname reach the container: a job that quietly
        # finished would leave a trip whose name answers 404.
        with tempfile.TemporaryDirectory() as root:
            _adapter(root, routing="wildcard", provisioner=_Recorder().provisioner).create_container("tokyo-2026")
            path = Path(root, "trips/tokyo-2026/topology.yaml")
            path.write_text(path.read_text().replace("192.0.2.210/24", "dhcp"))
            with self.assertRaisesRegex(ValueError, "wildcard-routed"):
                ShellDeployAdapter(deploy_root=root, vmid_map={}).route_for("tokyo-2026")

    def test_no_topology_is_no_route(self) -> None:
        deploy, _trip = self._deploy(None)
        self.assertIsNone(deploy.route_for("tokyo-2026"))

    def test_the_hostname_is_recorded_lower_case(self) -> None:
        raw = yaml.safe_load(LEGACY_TOPOLOGY.replace("tokyo-2026.example.invalid", "Tokyo-2026.Example.Invalid"))
        self.assertEqual("tokyo-2026.example.invalid", topology_route(raw).public_host)


VM_CONTAINER_TOPOLOGY = """\
version: 1
name: tokyo-2026
placement: vm-container
routing: wildcard
container:
  name: trip-tokyo-2026
  ipv4: 198.51.100.10
  forward_port: 8080
  public_hostname: tokyo-2026.example.invalid
  nfs_host_dir: /srv/trips/trip_9f2c11aa4d
  nfs_mount_path: /trip
  image: trip-site:sha256-0123456789ab
"""


class VmContainerRouteTests(unittest.TestCase):
    """PR1 of the vm-container placement: the readers that feed the gateway understand `container:`."""

    def _deploy(self, text: str):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        trip = Path(tmp.name, "trips", "tokyo-2026")
        trip.mkdir(parents=True)
        (trip / "topology.yaml").write_text(text)
        return ShellDeployAdapter(deploy_root=tmp.name, vmid_map={}), str(trip)

    def test_the_route_comes_from_the_container_section_and_is_wildcard(self) -> None:
        deploy, _trip = self._deploy(VM_CONTAINER_TOPOLOGY)
        self.assertEqual(TripRoute("tokyo-2026.example.invalid", "http://198.51.100.10:8080", "wildcard"),
                         deploy.route_for("tokyo-2026"))

    def test_the_private_url_comes_from_the_container_section(self) -> None:
        deploy, trip = self._deploy(VM_CONTAINER_TOPOLOGY)
        self.assertEqual("https://tokyo-2026.example.invalid", deploy._private_url(trip))

    def test_a_vm_container_trip_that_gives_no_route_fails_loudly_whatever_its_routing_line(self) -> None:
        for what, text in (
            ("no address", VM_CONTAINER_TOPOLOGY.replace("  ipv4: 198.51.100.10\n", "")),
            ("no port", VM_CONTAINER_TOPOLOGY.replace("  forward_port: 8080\n", "")),
            ("host routing", VM_CONTAINER_TOPOLOGY.replace("routing: wildcard", "routing: host")),
            ("no routing line", VM_CONTAINER_TOPOLOGY.replace("routing: wildcard\n", "")),
        ):
            with self.subTest(what):
                deploy, _trip = self._deploy(text)
                self.assertIsNone(topology_route(yaml.safe_load(text)))
                with self.assertRaisesRegex(ValueError, "wildcard-routed"):
                    deploy.route_for("tokyo-2026")

    def test_a_section_of_the_other_placement_is_never_a_fallback(self) -> None:
        # An LXC file that grew a container section, and a vm-container file that kept an npm one,
        # each read only the section its placement names.
        lxc_with_container = LEGACY_TOPOLOGY + "container:\n  ipv4: 198.51.100.10\n  forward_port: 9999\n" \
            "  public_hostname: other.example.invalid\n"
        self.assertEqual("http://192.0.2.210:8080", topology_route(yaml.safe_load(lxc_with_container)).upstream_url)
        vm_with_npm = VM_CONTAINER_TOPOLOGY.replace("  public_hostname: tokyo-2026.example.invalid\n", "") \
            + "npm:\n  hostname: tokyo-2026.example.invalid\n  forward_port: 8080\n"
        self.assertIsNone(topology_route(yaml.safe_load(vm_with_npm)))

    def test_an_unknown_placement_describes_no_route(self) -> None:
        for value in ("docker", "VM-CONTAINER", ""):
            with self.subTest(value=value):
                raw = yaml.safe_load(VM_CONTAINER_TOPOLOGY)
                raw["placement"] = value
                self.assertIsNone(topology_route(raw))
                self.assertIsNone(topology_public_hostname(raw))
        raw = yaml.safe_load(LEGACY_TOPOLOGY)
        raw["placement"] = "docker"
        self.assertIsNone(topology_route(raw), "an LXC file with an unknown placement is not guessed at either")

    def test_an_lxc_topology_with_an_explicit_lxc_placement_routes_as_before(self) -> None:
        raw = yaml.safe_load(LEGACY_TOPOLOGY)
        raw["placement"] = "lxc"
        self.assertEqual(TripRoute("tokyo-2026.example.invalid", "http://192.0.2.210:8080", "host"), topology_route(raw))


if __name__ == "__main__":
    unittest.main()
