"""ShellDeployAdapter and ProvisionerWorker, placement `vm-container` (spec x-trip-vm-container-placement.md, PR4).

A trip whose recorded placement is vm-container is built with no deploy.sh, no vmid and no pct: `ensure` ->
the trip's `trip/` written into its own directory on the document store -> `deploy` -> `check`, through the real
DockerSiteAdapter client against FakeTripHost (a transport that records every request). An LXC trip's path is
the existing suites' business and is untouched.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import tempfile
import unittest
import unittest.mock
from typing import Any

import psycopg
import yaml
from psycopg.rows import dict_row

from control_plane_worker.compute import LxcProvisionAdapter
from control_plane_worker.provisioner import ProvisionerWorker, ShellDeployAdapter
from control_plane_worker.trip_container import DockerSiteAdapter, ReleaseNotVerified, TripContainerError

from tests.support.fake_trip_host import FakeTripHost
from tests.support.test_database import test_database_url

DB_URL = test_database_url()
BRIDGE = "http://bridge.test:4310"
TRIP_ID = "trip_0123456789abcdef0123456789abcdef"
DIGEST = "ab" * 32
RELEASE = "sha256:" + DIGEST
CONFIG = {
    "meta": {"title": "Alsace", "deploymentNonce": "nonce-123"},
    "participants": [
        {"username": "dana", "name": "Dana", "name_en": "Dana", "color": "#112233", "family": "a", "age": 41},
        {"username": "noam", "name": "Noam", "color": "#445566"},
    ],
}


class _Forbidden:
    def __init__(self, what: str) -> None:
        self.what = what

    def __call__(self, *args, **kwargs):
        raise AssertionError(f"a vm-container trip must make no {self.what} call")


class ContainerDeployCase(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="deploy-root-")
        self.nfs = tempfile.mkdtemp(prefix="nfs-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.nfs, ignore_errors=True)
        self.host = FakeTripHost(self.nfs, images={DIGEST}, bridge_url=BRIDGE)
        for target in ("SubprocessSshTransport", "HttpJsonTransport", "ProxmoxLxcAdapter", "NpmProxyHostAdapter",
                       "CloudflareTunnelDnsAdapter"):
            patcher = unittest.mock.patch(f"control_plane_worker.compute.{target}", _Forbidden(target))
            patcher.start()
            self.addCleanup(patcher.stop)
        # deploy.sh and every other subprocess: none may run
        patcher = unittest.mock.patch("control_plane_worker.provisioner.subprocess.run", _Forbidden("deploy.sh / pct"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.compute = LxcProvisionAdapter(
            deploy_root=self.root, node="", template="", storage="", bridge="", ip_pool=[],
            hostname_domain="trips.example.invalid", tunnel_id="", npm_url="", npm_api_token="",
            cloudflare_zone_id="", cloudflare_api_token="", routing="wildcard", placement="vm-container",
            container_site=DockerSiteAdapter(self.host, bridge_url=BRIDGE),
            container_ip_pool=["10.250.0.10", "10.250.0.11"], nfs_local_base=self.nfs,
            provisioner_factory=_Forbidden("Proxmox"), sleep=lambda s: None,
        )
        self.adapter = ShellDeployAdapter(
            deploy_root=self.root, vmid_map={}, repo_root="/repo", compute=self.compute, trip_nfs_local_base=self.nfs,
        )

    def deploy(self, **overrides: Any) -> str:
        kwargs: dict = dict(first_provision=True, trip_id=TRIP_ID, release_digest=RELEASE, sidecars={
            "control-plane.identity.json": {"version": 1, "tripId": TRIP_ID},
            "bookings.json": [{"seed_key": "hotel"}],
        })
        kwargs.update(overrides)
        return self.adapter.deploy("alsace-2026", CONFIG, **kwargs)

    @property
    def trip(self) -> pathlib.Path:
        return pathlib.Path(self.nfs) / TRIP_ID


class VmContainerDeployTests(ContainerDeployCase):
    def test_a_new_trip_issues_exactly_ensure_then_the_config_then_deploy_then_check(self) -> None:
        url = self.deploy()
        self.assertEqual("https://alsace-2026.trips.example.invalid", url)
        self.assertEqual(["ensure", "deploy", "check", "read"], self.host.verbs())
        by_verb = dict(self.host.events)
        self.assertFalse(by_verb["ensure"])
        self.assertTrue(by_verb["deploy"])

    def test_the_config_and_every_sidecar_land_in_the_trips_own_directory(self) -> None:
        self.deploy()
        self.assertEqual(CONFIG, json.loads((self.trip / "trip" / "trip.config.json").read_text(encoding="utf-8")))
        self.assertEqual({"version": 1, "tripId": TRIP_ID},
                         json.loads((self.trip / "trip" / "control-plane.identity.json").read_text()))
        self.assertEqual([{"seed_key": "hotel"}], json.loads((self.trip / "trip" / "bookings.json").read_text()))

    def test_the_workers_own_copy_beside_topology_yaml_is_kept_as_for_an_lxc(self) -> None:
        self.deploy()
        local = pathlib.Path(self.root) / "trips" / "alsace-2026"
        self.assertEqual(CONFIG, json.loads((local / "trip.config.json").read_text(encoding="utf-8")))
        raw = yaml.safe_load((local / "topology.yaml").read_text(encoding="utf-8"))
        self.assertEqual("vm-container", raw["placement"])

    def test_a_non_ascii_config_is_written_as_utf8_like_the_lxc_path(self) -> None:
        self.adapter.deploy("alsace-2026", {"meta": {"title": "אלזס"}, "participants": []}, trip_id=TRIP_ID,
                            release_digest=RELEASE)
        raw = (self.trip / "trip" / "trip.config.json").read_bytes().decode("utf-8")
        self.assertIn("אלזס", raw)

    def test_documents_go_to_the_trips_documents_directory_and_nowhere_else(self) -> None:
        from control_plane_worker.document_handoff import TripDocumentFile
        store = pathlib.Path(self.nfs) / ".kinerary-document-store"
        store.mkdir()
        body = b"Hotel Artemide - confirmation HTL-99117"
        digest = hashlib.sha256(body).hexdigest()
        source = store / f"{digest}.txt"
        source.write_bytes(body)
        document = TripDocumentFile(
            document_id="doc_" + "a" * 32, file_name=f"{digest}.txt", source_path=str(source),
            content_digest=f"sha256:{digest}", filename="Artemide.txt", mime="text/plain",
        )
        self.deploy(documents=[document])
        published = self.trip / "documents" / document.file_name
        self.assertEqual(os.stat(published).st_ino, os.stat(source).st_ino, "one physical copy")
        self.assertFalse((pathlib.Path(self.root) / "trips" / "alsace-2026" / "documents").exists(),
                         "no fallback copy beside the config: a container mounts its own directory only")

    def test_a_second_provision_reuses_the_address_and_leaves_the_password_alone(self) -> None:
        self.deploy()
        first = self.compute.site_login_password("alsace-2026")
        self.deploy(first_provision=False)
        self.assertEqual(first, self.adapter.site_login_password("alsace-2026"))
        self.assertEqual({"10.250.0.10"}, {r["ip"] for r in self.host.requests if "ip" in r})

    def test_a_release_with_no_digest_is_refused_before_anything_changes(self) -> None:
        for digest in (None, "sha256:placeholder"):
            with self.subTest(digest=digest), self.assertRaises(ReleaseNotVerified):
                self.deploy(release_digest=digest)
        self.assertEqual([], self.host.requests)
        self.assertFalse((pathlib.Path(self.root) / "trips" / "alsace-2026" / "topology.yaml").exists())

    def test_a_missing_image_fails_naming_the_command_and_leaves_no_config_behind(self) -> None:
        self.host.images.clear()
        with self.assertRaisesRegex(TripContainerError, "kinerary-cp-release trip-image"):
            self.deploy()
        self.assertEqual(["ensure"], [r["verb"] for r in self.host.requests][:1])
        self.assertFalse((self.trip / "trip" / "trip.config.json").exists(), "nothing written before ensure succeeded")

    def test_the_placement_is_the_recorded_one_not_the_workers_setting(self) -> None:
        # an LXC-recorded topology on a vm-container worker goes the LXC way: create_container, never the host
        lxc = pathlib.Path(self.root) / "trips" / "old-trip" / "topology.yaml"
        lxc.parent.mkdir(parents=True)
        from tests.test_compute import _lxc_topology
        self.compute._write_topology(lxc, _lxc_topology("wildcard"), "old-trip", "205")
        with unittest.mock.patch.object(self.compute, "create_container", return_value="205") as create, \
                unittest.mock.patch("control_plane_worker.provisioner.subprocess.run",
                                    return_value=unittest.mock.Mock(returncode=0, stdout="", stderr="")), \
                unittest.mock.patch.object(ShellDeployAdapter, "_private_url", return_value="https://old.example"):
            self.adapter.deploy("old-trip", CONFIG, trip_id=TRIP_ID, release_digest=RELEASE)
        create.assert_called_once()
        self.assertEqual([], self.host.requests)

    def test_a_vmid_map_trip_is_never_a_container(self) -> None:
        adapter = ShellDeployAdapter(
            deploy_root=self.root, vmid_map={"alsace-2026": "201"}, repo_root="/repo", compute=self.compute,
            trip_nfs_local_base=self.nfs,
        )
        with unittest.mock.patch("control_plane_worker.provisioner.subprocess.run",
                                 return_value=unittest.mock.Mock(returncode=0, stdout="", stderr="")), \
                unittest.mock.patch.object(ShellDeployAdapter, "_private_url", return_value="https://x.example"):
            adapter.deploy("alsace-2026", CONFIG, trip_id=TRIP_ID, release_digest=RELEASE)
        self.assertEqual([], self.host.requests)


class VmContainerVerificationReadsTests(ContainerDeployCase):
    """The gate's three GETs, for a container the worker is deliberately not on a network with."""

    def setUp(self) -> None:
        super().setUp()
        self.deploy()
        self.origin = "http://10.250.0.10:8080"

    def get(self, path: str) -> tuple[int, Any]:
        status, body = self.adapter.http_get(self.origin + path)
        try:
            return status, json.loads(body)
        except ValueError:
            return status, body

    def test_health_is_the_hosts_check_of_the_container(self) -> None:
        before = len([r for r in self.host.requests if r["verb"] == "check"])
        status, body = self.get("/api/health")
        self.assertEqual(200, status)
        self.assertIs(True, body["ok"])
        self.assertEqual(before + 1, len([r for r in self.host.requests if r["verb"] == "check"]))

    def test_an_unhealthy_container_is_a_503_and_not_a_pass(self) -> None:
        self.host.unhealthy_checks = 1
        status, body = self.get("/api/health")
        self.assertEqual(503, status)
        self.assertIs(False, body["ok"])

    def test_the_roster_is_the_four_public_fields_of_the_config_in_the_trips_store(self) -> None:
        status, body = self.get("/api/config/roster")
        self.assertEqual(200, status)
        self.assertEqual([{"username": "dana", "name": "Dana", "name_en": "Dana", "color": "#112233"},
                          {"username": "noam", "name": "Noam", "name_en": None, "color": "#445566"}],
                         body["participants"])
        self.assertNotIn("family", json.dumps(body))
        self.assertIn("not fetched from the site", body["source"])

    def test_the_nonce_is_the_one_in_the_store_copy(self) -> None:
        status, body = self.get("/api/config/deployment-identity")
        self.assertEqual((200, "nonce-123"), (status, body["deploymentNonce"]))

    def test_it_reads_the_file_now_not_what_was_deployed_a_while_ago(self) -> None:
        self.compute.container_store("alsace-2026").write_trip_files(
            {"trip.config.json": json.dumps({"meta": {"deploymentNonce": "other"}, "participants": []}).encode()})
        self.assertEqual("other", self.get("/api/config/deployment-identity")[1]["deploymentNonce"])

    def test_a_missing_config_is_a_404_and_any_other_path_too(self) -> None:
        (self.trip / "trip" / "trip.config.json").unlink()
        self.assertEqual(404, self.get("/api/config/roster")[0])
        self.assertEqual(404, self.get("/api/anything-else")[0])

    def test_any_other_origin_is_a_real_get(self) -> None:
        with unittest.mock.patch("control_plane_worker.provisioner.verification.default_http_get",
                                 return_value=(200, "real")) as real:
            self.assertEqual((200, "real"), self.adapter.http_get("https://lxc-trip.example/api/health"))
        real.assert_called_once()


@unittest.skipIf(not DB_URL, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class VmContainerJobTests(unittest.TestCase):
    """A whole provision job: claim -> transform -> deploy as a container -> verification gate -> ready_private."""

    @classmethod
    def setUpClass(cls) -> None:
        from tests.test_provisioner import run_test_migrations
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        from tests.test_provisioner import COMPANION_INTAKE, setup_fixture
        self.root = tempfile.mkdtemp(prefix="deploy-root-")
        self.nfs = tempfile.mkdtemp(prefix="nfs-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.nfs, ignore_errors=True)
        self.fix = setup_fixture(self.conn, intake=COMPANION_INTAKE, desired_extra={
            "release_verified": True, "release_source_revision": "a" * 40, "release_artifact_digest": RELEASE,
            "first_provision": True,
        })
        self.host = FakeTripHost(self.nfs, images={DIGEST}, bridge_url=BRIDGE)
        for target in ("SubprocessSshTransport", "HttpJsonTransport", "ProxmoxLxcAdapter", "NpmProxyHostAdapter",
                       "CloudflareTunnelDnsAdapter"):
            patcher = unittest.mock.patch(f"control_plane_worker.compute.{target}", _Forbidden(target))
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = unittest.mock.patch("control_plane_worker.provisioner.subprocess.run", _Forbidden("deploy.sh / pct"))
        patcher.start()
        self.addCleanup(patcher.stop)
        compute = LxcProvisionAdapter(
            deploy_root=self.root, node="", template="", storage="", bridge="", ip_pool=[],
            hostname_domain="trips.example.invalid", tunnel_id="", npm_url="", npm_api_token="",
            cloudflare_zone_id="", cloudflare_api_token="", routing="wildcard", placement="vm-container",
            container_site=DockerSiteAdapter(self.host, bridge_url=BRIDGE),
            container_ip_pool=["10.250.0.10"], nfs_local_base=self.nfs,
            provisioner_factory=_Forbidden("Proxmox"), sleep=lambda s: None,
        )
        self.deploy = ShellDeployAdapter(
            deploy_root=self.root, vmid_map={}, repo_root="/repo", compute=compute, trip_nfs_local_base=self.nfs,
        )
        self.worker = ProvisionerWorker(
            db_url=DB_URL, deploy=self.deploy, worker_id="test-container",
            materialize=lambda revision, digest: tempfile.mkdtemp(prefix="fake-release-"),
            verification_retry_attempts=1, verification_retry_delay_s=0,
        )

    def tearDown(self) -> None:
        from tests.test_provisioner import teardown_fixture
        teardown_fixture(self.conn, self.fix)

    def test_the_job_succeeds_through_the_gate_with_no_proxmox_npm_dns_or_deploy_sh(self) -> None:
        self.assertTrue(self.worker.run_once())
        row = self.conn.execute("SELECT state, safe_error_code FROM control_plane.jobs WHERE id = %s",
                                (self.fix["job_id"],)).fetchone()
        self.assertEqual(("succeeded", None), (row["state"], row["safe_error_code"]))
        self.assertEqual("ready_private", self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],)).fetchone()["lifecycle_state"])
        self.assertEqual(["ensure", "deploy", "check"], [v for v in self.host.verbs() if v != "read"][:3])

    def test_the_trips_route_is_its_container_address_and_the_gate_recorded_its_evidence(self) -> None:
        self.worker.run_once()
        route = self.conn.execute(
            "SELECT upstream_url, public_host FROM control_plane.runtime_routes WHERE trip_id = %s",
            (self.fix["trip_id"],)).fetchone()
        self.assertEqual("http://10.250.0.10:8080", route["upstream_url"])
        self.assertTrue(route["public_host"].endswith(".trips.example.invalid"))
        evidence = {r["check_name"]: r["outcome"] for r in self.conn.execute(
            "SELECT check_name, outcome FROM control_plane.verification_evidence WHERE trip_id = %s",
            (self.fix["trip_id"],)).fetchall()}
        for name in ("runtime_health", "rendered_data", "release_compatibility"):
            self.assertEqual("passed", evidence.get(name), name)

    def test_the_release_digest_reaches_the_host_as_the_image(self) -> None:
        self.worker.run_once()
        ensure = next(r for r in self.host.requests if r["verb"] == "ensure")
        self.assertEqual(DIGEST, ensure["image"])
        self.assertEqual(self.fix["trip_id"], ensure["trip_id"])

    def test_an_unhealthy_site_fails_the_job_it_is_not_marked_ready(self) -> None:
        self.host.unhealthy_checks = 10_000
        self.conn.execute("UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s", (self.fix["job_id"],))
        self.conn.commit()
        self.worker.run_once()
        row = self.conn.execute("SELECT state FROM control_plane.jobs WHERE id = %s", (self.fix["job_id"],)).fetchone()
        self.assertEqual("failed", row["state"])
        self.assertNotEqual("ready_private", self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],)).fetchone()["lifecycle_state"])

    def test_a_missing_image_fails_the_job_with_its_own_code(self) -> None:
        self.host.images.clear()
        self.conn.execute("UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s", (self.fix["job_id"],))
        self.conn.commit()
        self.worker.run_once()
        row = self.conn.execute("SELECT state, safe_error_code FROM control_plane.jobs WHERE id = %s",
                                (self.fix["job_id"],)).fetchone()
        self.assertEqual(("failed", "TRIP_IMAGE_MISSING"), (row["state"], row["safe_error_code"]))


if __name__ == "__main__":
    unittest.main()
