"""compute.py, placement `vm-container` (spec x-trip-vm-container-placement.md, PR4): AC-3.

A trip's site as one Docker container on the control-plane host. The adapter is driven through the real
DockerSiteAdapter client against FakeTripHost (a stand-in for the forced command's request/answer contract;
tests/scripts/test_trip_container_worker_contract.py runs the same client against the real script). Every
Proxmox, NPM and Cloudflare constructor is patched to fail the test, and no provisioner factory is given.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import tempfile
import unittest
import unittest.mock

import yaml

from control_plane_worker.compute import ContainerSite, LxcProvisionAdapter, derive_trip_key
from control_plane_worker.trip_container import (
    DockerSiteAdapter, ReleaseNotVerified, TripContainerError, TripStoreError,
)
from provisioning.models import load_topology

from tests.support.fake_trip_host import FakeTripHost
from tests.test_compute import _lxc_topology

BRIDGE = "http://bridge.test:4310"
TRIP_ID = "trip_0123456789abcdef0123456789abcdef"
OTHER_TRIP_ID = "trip_fedcba9876543210fedcba9876543210"
DIGEST = "ab" * 32
RELEASE = "sha256:" + DIGEST
NEWER = "cd" * 32


class _Forbidden:
    """What a vm-container trip must never construct or call: Proxmox over ssh, NPM or Cloudflare over HTTP."""

    def __init__(self, what: str) -> None:
        self.what = what

    def __call__(self, *args, **kwargs):
        raise AssertionError(f"a vm-container trip must make no {self.what} call")


class ContainerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="deploy-root-")
        self.nfs = tempfile.mkdtemp(prefix="nfs-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.nfs, ignore_errors=True)
        self.host = FakeTripHost(self.nfs, images={DIGEST}, bridge_url=BRIDGE)
        self.sleeps: list = []
        for target in ("SubprocessSshTransport", "HttpJsonTransport", "ProxmoxLxcAdapter", "NpmProxyHostAdapter",
                       "CloudflareTunnelDnsAdapter"):
            patcher = unittest.mock.patch(f"control_plane_worker.compute.{target}", _Forbidden(target))
            patcher.start()
            self.addCleanup(patcher.stop)

    def adapter(self, **overrides) -> LxcProvisionAdapter:
        kwargs = dict(
            deploy_root=self.root, node="", template="", storage="", bridge="", ip_pool=[],
            hostname_domain="trips.example.invalid", tunnel_id="", npm_url="", npm_api_token="",
            cloudflare_zone_id="", cloudflare_api_token="", routing="wildcard", placement="vm-container",
            container_site=DockerSiteAdapter(self.host, bridge_url=BRIDGE),
            container_ip_pool=["10.250.0.10", "10.250.0.11"], nfs_local_base=self.nfs,
            provisioner_factory=_Forbidden("Proxmox"), sleep=self.sleeps.append,
        )
        kwargs.update(overrides)
        return LxcProvisionAdapter(**kwargs)

    def topology_path(self, slug: str = "alsace-2026") -> pathlib.Path:
        return pathlib.Path(self.root) / "trips" / slug / "topology.yaml"

    def provision(self, adapter: LxcProvisionAdapter, slug: str = "alsace-2026", trip_id: str = TRIP_ID,
                  release: str = RELEASE, first_provision: bool = True) -> ContainerSite:
        site = adapter.prepare_container(slug, first_provision=first_provision, trip_id=trip_id, release_digest=release)
        site.store.write_trip_files({"trip.config.json": b'{"participants": []}'})
        adapter.activate_container(site)
        return site


class VmContainerProvisionTests(ContainerCase):
    def test_ensure_then_the_config_then_deploy_then_check_and_nothing_of_proxmox_npm_or_dns(self) -> None:
        self.provision(self.adapter())
        self.assertEqual(["ensure", "deploy", "check", "read"], self.host.verbs())
        by_verb = dict(self.host.events)
        self.assertFalse(by_verb["ensure"], "ensure runs BEFORE anything is written into trip/ (it hands the directory over)")
        self.assertTrue(by_verb["deploy"], "the container is recreated AFTER the config is in the store")

    def test_the_topology_records_a_container_and_no_proxmox(self) -> None:
        self.provision(self.adapter())
        raw = yaml.safe_load(self.topology_path().read_text(encoding="utf-8"))
        self.assertEqual("vm-container", raw["placement"])
        self.assertEqual("wildcard", raw["routing"])
        self.assertEqual({
            "name": "trip-alsace-2026", "ipv4": "10.250.0.10", "forward_port": 8080,
            "public_hostname": "alsace-2026.trips.example.invalid",
            "nfs_host_dir": f"{self.nfs}/{TRIP_ID}", "nfs_mount_path": "/trip-store", "image": f"trip-site:{DIGEST}",
        }, raw["container"])
        for absent in ("proxmox", "npm", "cloudflare"):
            self.assertNotIn(absent, raw)
        self.assertEqual("vm-container", load_topology(raw).placement)

    def test_the_request_carries_what_a_new_site_is_born_with(self) -> None:
        self.provision(self.adapter(control_plane_exchange_key="shared-exchange-key-0123456789"))
        ensure = self.host.requests[0]
        self.assertEqual(
            {"record_type", "verb", "trip_id", "slug", "ip", "image", "seed_password", "exchange_key", "hermes_url",
             "public_origin", "trip_mcp_enabled"}, set(ensure))
        self.assertEqual(DIGEST, ensure["image"])
        self.assertEqual("10.250.0.10", ensure["ip"])
        self.assertEqual(BRIDGE, ensure["hermes_url"])
        self.assertEqual("https://alsace-2026.trips.example.invalid", ensure["public_origin"])
        self.assertIs(True, ensure["trip_mcp_enabled"])
        self.assertEqual("shared-exchange-key-0123456789", ensure["exchange_key"])
        self.assertRegex(ensure["seed_password"], r"^[a-z0-9]{4}(-[a-z0-9]{4}){3}$")

    def test_no_exchange_key_configured_sends_none(self) -> None:
        self.provision(self.adapter())
        self.assertNotIn("exchange_key", self.host.requests[0])

    def test_the_site_password_is_what_the_site_holds_not_what_was_offered(self) -> None:
        adapter = self.adapter()
        self.provision(adapter)
        first = adapter.site_login_password("alsace-2026")
        self.assertEqual(self.host.requests[0]["seed_password"], first)
        # a re-provision offers a new candidate; the .env is never rewritten, so the one people use is reported
        self.provision(adapter, first_provision=False)
        offered = [r["seed_password"] for r in self.host.requests if r["verb"] == "ensure"]
        self.assertNotEqual(offered[0], offered[1])
        self.assertEqual(first, adapter.site_login_password("alsace-2026"))

    def test_the_topology_is_written_before_the_first_side_effect_and_a_retry_reuses_it(self) -> None:
        adapter = self.adapter()
        self.host.refuse_with["ensure"] = "something transient"
        with self.assertRaises(TripContainerError):
            adapter.prepare_container("alsace-2026", first_provision=True, trip_id=TRIP_ID, release_digest=RELEASE)
        self.assertTrue(self.topology_path().exists(), "committed before the host was asked")
        before = yaml.safe_load(self.topology_path().read_text(encoding="utf-8"))
        del self.host.refuse_with["ensure"]
        # another trip arrives meanwhile and takes the next address
        self.provision(adapter, slug="another-trip", trip_id=OTHER_TRIP_ID)
        self.provision(adapter)
        self.assertEqual("10.250.0.10", before["container"]["ipv4"])
        self.assertEqual("10.250.0.10", yaml.safe_load(self.topology_path().read_text())["container"]["ipv4"])
        self.assertEqual("10.250.0.11", yaml.safe_load(self.topology_path("another-trip").read_text())["container"]["ipv4"])

    def test_addresses_come_from_the_container_pool_and_skip_every_trips_claimed_address(self) -> None:
        lxc = pathlib.Path(self.root) / "trips" / "lxc-trip" / "topology.yaml"
        lxc.parent.mkdir(parents=True)
        lxc.write_text("proxmox:\n  lxc:\n    ipv4: 10.250.0.10/24\n")
        self.provision(self.adapter())
        self.assertEqual("10.250.0.11", yaml.safe_load(self.topology_path().read_text())["container"]["ipv4"])

    def test_an_exhausted_pool_names_its_setting(self) -> None:
        adapter = self.adapter(container_ip_pool=["10.250.0.10"])
        self.provision(adapter)
        with self.assertRaisesRegex(RuntimeError, "TRIP_CONTAINER_IP_POOL"):
            adapter.prepare_container("another-trip", trip_id=OTHER_TRIP_ID, release_digest=RELEASE)

    def test_a_provision_with_no_verified_release_changes_nothing(self) -> None:
        adapter = self.adapter()
        for digest in (None, "", "sha256:" + "0" * 63, DIGEST):
            with self.subTest(digest=digest), self.assertRaises(ReleaseNotVerified):
                adapter.prepare_container("alsace-2026", trip_id=TRIP_ID, release_digest=digest)
        self.assertEqual([], self.host.requests)
        self.assertFalse(self.topology_path().exists())

    def test_a_trip_without_a_trip_id_is_refused_and_never_falls_back_to_the_slug(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "trip id"):
            self.adapter().prepare_container("alsace-2026", trip_id=None, release_digest=RELEASE)
        self.assertEqual([], self.host.requests)

    def test_a_missing_image_stops_the_provision_with_the_command_that_builds_it(self) -> None:
        self.host.images.clear()
        with self.assertRaisesRegex(TripContainerError, "kinerary-cp-release trip-image sha256:" + DIGEST):
            self.provision(self.adapter())

    def test_the_container_is_checked_until_healthy_and_a_site_that_never_is_a_failure(self) -> None:
        self.host.unhealthy_checks = 3
        self.provision(self.adapter())
        self.assertEqual(3, len(self.sleeps), "waited between the unhealthy answers, not after the healthy one")
        self.host.unhealthy_checks = 10_000
        with self.assertRaisesRegex(TripContainerError, "did not become healthy"):
            self.provision(self.adapter(health_attempts=4), slug="another-trip", trip_id=OTHER_TRIP_ID)

    def test_the_topology_follows_the_image_a_re_provision_deploys(self) -> None:
        adapter = self.adapter()
        self.provision(adapter)
        self.host.images.add(NEWER)
        self.provision(adapter, release="sha256:" + NEWER, first_provision=False)
        raw = yaml.safe_load(self.topology_path().read_text())
        self.assertEqual(f"trip-site:{NEWER}", raw["container"]["image"])
        self.assertEqual("10.250.0.10", raw["container"]["ipv4"], "the address is the trip's for good")
        deploys = [r for r in self.host.requests if r["verb"] == "deploy"]
        self.assertEqual([DIGEST, NEWER], [d["image"] for d in deploys])

    def test_a_site_with_no_password_in_its_env_reports_none_not_a_guess(self) -> None:
        adapter = self.adapter()
        self.provision(adapter)
        (pathlib.Path(self.nfs) / TRIP_ID / ".env").write_text("HERMES_API_KEY=x\n")
        self.provision(adapter, first_provision=False)
        self.assertIsNone(adapter.site_login_password("alsace-2026"))

    def test_logs_carry_no_password_and_no_key(self) -> None:
        with self.assertLogs("control_plane_worker.compute", level="DEBUG") as logs:
            adapter = self.adapter(control_plane_exchange_key="shared-exchange-key-0123456789")
            self.provision(adapter)
        text = "\n".join(logs.output)
        self.assertNotIn(adapter.site_login_password("alsace-2026"), text)
        self.assertNotIn("shared-exchange-key", text)


class VmContainerFirstProvisionTests(ContainerCase):
    def _leave_a_failed_attempt(self, adapter: LxcProvisionAdapter) -> pathlib.Path:
        self.provision(adapter, first_provision=False)
        trip = pathlib.Path(self.nfs) / TRIP_ID
        (trip / "server-data" / "trip.db").write_text("stale users table")
        (trip / "media" / "a.jpg").write_text("stale")
        self.host.events.clear()
        self.host.requests.clear()
        return trip

    def test_first_provision_stops_the_container_wipes_data_and_media_and_ensures_again(self) -> None:
        adapter = self.adapter()
        trip = self._leave_a_failed_attempt(adapter)
        self.provision(adapter, first_provision=True)
        self.assertEqual(["stop", "ensure", "deploy", "check", "read"], self.host.verbs())
        self.assertFalse((trip / "server-data" / "trip.db").exists())
        self.assertTrue((trip / "server-data").is_dir(), "ensure made the directory again")
        self.assertFalse((trip / "media" / "a.jpg").exists())

    def test_a_first_provision_of_a_brand_new_trip_stops_nothing(self) -> None:
        self.provision(self.adapter(), first_provision=True)
        self.assertNotIn("stop", self.host.verbs())

    def test_a_first_provision_whose_container_is_gone_is_not_an_error(self) -> None:
        adapter = self.adapter()
        trip = self._leave_a_failed_attempt(adapter)
        self.host.containers.clear()
        self.provision(adapter, first_provision=True)
        self.assertFalse((trip / "server-data" / "trip.db").exists())

    def test_a_re_provision_that_is_not_first_never_wipes_data(self) -> None:
        adapter = self.adapter()
        trip = self._leave_a_failed_attempt(adapter)
        self.provision(adapter, first_provision=False)
        self.assertNotIn("stop", self.host.verbs())
        self.assertTrue((trip / "server-data" / "trip.db").exists())
        self.assertTrue((trip / "media" / "a.jpg").exists())

    def test_the_wipe_keeps_the_env_the_trip_directory_and_the_documents(self) -> None:
        adapter = self.adapter()
        trip = self._leave_a_failed_attempt(adapter)
        (trip / "documents" / "d.pdf").write_text("pdf")
        self.provision(adapter, first_provision=True)
        for kept in (".env", "TRIP.txt", "documents/d.pdf"):
            self.assertTrue((trip / kept).exists(), kept)


class VmContainerKeyTests(ContainerCase):
    MASTER = "m" * 40
    SHARED = "shared-exchange-key-0123456789"

    def test_with_a_trip_key_master_a_new_site_is_born_with_its_derived_key_and_the_kind_is_read_back(self) -> None:
        adapter = self.adapter(trip_key_master=self.MASTER, control_plane_exchange_key=self.SHARED)
        self.provision(adapter)
        self.assertEqual(derive_trip_key(self.MASTER, TRIP_ID), self.host.requests[0]["exchange_key"])
        self.assertEqual("derived", adapter.site_trip_key("alsace-2026"))
        reads = [r for r in self.host.requests if r["verb"] == "read"]
        self.assertEqual({"derived", "shared"}, set(reads[0]["exchange_key_candidates"]))

    def test_a_re_provision_reports_the_key_the_site_already_holds(self) -> None:
        # born shared (no master yet), then the master is set and the trip re-provisioned: the .env is not rewritten
        self.provision(self.adapter(control_plane_exchange_key=self.SHARED))
        adapter = self.adapter(trip_key_master=self.MASTER, control_plane_exchange_key=self.SHARED)
        self.provision(adapter, first_provision=False)
        self.assertEqual("shared", adapter.site_trip_key("alsace-2026"))

    def test_with_no_master_no_kind_is_asked_and_none_is_reported(self) -> None:
        adapter = self.adapter(control_plane_exchange_key=self.SHARED)
        self.provision(adapter)
        self.assertIsNone(adapter.site_trip_key("alsace-2026"))
        for request in self.host.requests:
            self.assertNotIn("exchange_key_candidates", request)

    def test_a_master_with_no_trip_id_never_falls_back_to_the_shared_key(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "trip id"):
            self.adapter(trip_key_master=self.MASTER).prepare_container(
                "alsace-2026", trip_id=None, release_digest=RELEASE)


class VmContainerBridgeTests(ContainerCase):
    def test_the_site_to_bridge_check_is_a_read_of_the_host(self) -> None:
        adapter = self.adapter()
        self.provision(adapter)
        self.assertEqual((True, "health 200: the container reached the bridge"), adapter.verify_site_bridge("alsace-2026"))
        read = self.host.requests[-1]
        self.assertEqual(["site_to_bridge"], read["fields"])
        self.assertEqual(BRIDGE, read["bridge_url"])

    def test_a_failing_bridge_is_reported_with_the_hosts_evidence(self) -> None:
        adapter = self.adapter()
        self.provision(adapter)
        self.host.bridge_answer = {"ok": False, "evidence": "health 401: the bridge does not recognise this site's key"}
        self.assertEqual((False, "health 401: the bridge does not recognise this site's key"),
                         adapter.verify_site_bridge("alsace-2026"))

    def test_a_trip_with_no_topology_has_nothing_to_check(self) -> None:
        self.assertIsNone(self.adapter().verify_site_bridge("never-built"))

    def test_an_lxc_trips_check_is_untouched_by_a_container_worker(self) -> None:
        adapter = self.adapter()
        lxc = self.topology_path("old-trip")
        lxc.parent.mkdir(parents=True)
        adapter._write_topology(lxc, _lxc_topology("wildcard"), "old-trip", "205")
        self.assertIsNone(adapter.verify_site_bridge("old-trip"), "no TRIP_MCP_SHARED_SITE_URL: nothing to check, as before")
        self.assertEqual([], self.host.requests)


class PlacementDispatchTests(ContainerCase):
    def test_a_recorded_placement_always_wins(self) -> None:
        container_worker, lxc_worker = self.adapter(), self.adapter(placement="lxc")
        self.provision(container_worker)
        lxc = self.topology_path("old-trip")
        lxc.parent.mkdir(parents=True)
        container_worker._write_topology(lxc, _lxc_topology("wildcard"), "old-trip", "205")
        for worker in (container_worker, lxc_worker):
            self.assertEqual("vm-container", worker.placement_of("alsace-2026"))
            self.assertEqual("lxc", worker.placement_of("old-trip"))
        self.assertEqual("vm-container", container_worker.placement_of("brand-new"))
        self.assertEqual("lxc", lxc_worker.placement_of("brand-new"))

    def test_an_lxc_worker_still_re_provisions_the_containers_it_built(self) -> None:
        self.provision(self.adapter())
        lxc_worker = self.adapter(placement="lxc", container_ip_pool=[])
        site = lxc_worker.prepare_container("alsace-2026", trip_id=TRIP_ID, release_digest=RELEASE)
        self.assertEqual("10.250.0.10", site.ip)

    def test_an_lxc_worker_never_builds_a_new_container_trip(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "places new trips as lxc"):
            self.adapter(placement="lxc").prepare_container("brand-new", trip_id=TRIP_ID, release_digest=RELEASE)
        self.assertFalse(self.topology_path("brand-new").exists())

    def test_create_container_never_builds_a_new_trip_for_a_container_worker(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "prepare_container"):
            self.adapter().create_container("brand-new", trip_id=TRIP_ID)
        self.assertFalse(self.topology_path("brand-new").exists())

    def test_an_lxc_topology_is_not_a_container_to_prepare(self) -> None:
        lxc = self.topology_path("old-trip")
        lxc.parent.mkdir(parents=True)
        adapter = self.adapter()
        adapter._write_topology(lxc, _lxc_topology("wildcard"), "old-trip", "205")
        with self.assertRaisesRegex(RuntimeError, "records placement lxc"):
            adapter.prepare_container("old-trip", trip_id=TRIP_ID, release_digest=RELEASE)
        self.assertEqual([], self.host.requests)

    def test_a_directory_not_named_by_the_trip_id_is_refused(self) -> None:
        adapter = self.adapter()
        self.provision(adapter)
        with self.assertRaisesRegex(RuntimeError, "not named by its trip id"):
            adapter.prepare_container("alsace-2026", trip_id=OTHER_TRIP_ID, release_digest=RELEASE)

    def test_the_constructor_refuses_a_half_configured_container_worker(self) -> None:
        for override in ({"container_site": None}, {"container_ip_pool": []}, {"nfs_local_base": ""}):
            with self.subTest(override=override), self.assertRaisesRegex(ValueError, "vm-container needs"):
                self.adapter(**override)
        with self.assertRaisesRegex(ValueError, "requires routing wildcard"):
            self.adapter(routing="host", tunnel_id="t", npm_url="u", npm_api_token="x", cloudflare_zone_id="z",
                         cloudflare_api_token="c")
        with self.assertRaisesRegex(ValueError, "placement must be one of"):
            self.adapter(placement="docker")
        with self.assertRaises(ValueError):
            self.adapter(container_ip_pool=["10.250.0.10", "10.250.0.10"])

    def test_a_store_the_worker_cannot_see_fails_the_provision_loudly(self) -> None:
        elsewhere = self.nfs + "-elsewhere"
        os.makedirs(elsewhere)
        self.addCleanup(shutil.rmtree, elsewhere, ignore_errors=True)
        adapter = self.adapter(nfs_local_base=elsewhere)
        site = adapter.prepare_container("alsace-2026", trip_id=TRIP_ID, release_digest=RELEASE)
        with self.assertRaisesRegex(TripStoreError, "not on the document store the worker sees"):
            site.store.write_trip_files({"trip.config.json": b"{}"})


if __name__ == "__main__":
    unittest.main()
