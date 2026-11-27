"""The worker's client and the host's forced command, face to face.

control-plane/worker/tests/support/fake_trip_host.py stands in for scripts/trip-container-host.sh in the
worker's own tests. A stand-in can drift from what it stands in for, so this runs the REAL script (with
test_trip_container_host.py's fake docker and fake mount: nothing here talks to a real daemon) behind the same
transport seam, and drives the worker's real DockerSiteAdapter, TripStore and LxcProvisionAdapter container
path through it. If the script's contract changes, or the client sends a field the script would refuse, this is
the test that goes red; and a request the worker makes is shown to be one the script accepts, answers and acts on.

Run as an ordinary user: the script ignores its test overrides as root (the same rule as its own suite).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WORKER = REPO / "control-plane" / "worker"
for entry in (str(WORKER), str(REPO)):
    if entry not in sys.path:
        sys.path.insert(0, entry)


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


host_tests = _load("trip_container_host_tests", REPO / "tests" / "scripts" / "test_trip_container_host.py")

from control_plane_worker.compute import LxcProvisionAdapter  # noqa: E402
from control_plane_worker.provisioner import ShellDeployAdapter  # noqa: E402
from control_plane_worker.trip_container import (  # noqa: E402
    DockerSiteAdapter, TripContainerError, TripImageMissing, TripStore,
)

BRIDGE = "http://bridge.internal:4310"      # what test_trip_container_host.py configures as the host's own
RELEASE = "sha256:" + host_tests.DIGEST


class RealScriptCase(host_tests.HostCase):
    def change_state(self, **fields) -> None:
        """The fake docker keeps its containers in a file the script's runs write to: edit THAT, not the copy the
        test made at setUp (saving it back would erase every container made since)."""
        self.state = self.load_state()
        for key, value in fields.items():
            self.state[key] = value
        self.save_state()

    def setUp(self) -> None:
        super().setUp()
        self.answers: list = []
        self.client = DockerSiteAdapter(self.transport, bridge_url=BRIDGE)

    def transport(self, payload: bytes):
        code, out, _err, _answer = self.run_host(payload)
        self.answers.append((code, out))
        return code, out.encode()


class ClientAgainstTheScriptTests(RealScriptCase):
    def ensure(self, **over):
        fields = dict(ip=host_tests.IP, image=host_tests.DIGEST, seed_password=host_tests.SECRET_PASSWORD,
                      exchange_key=host_tests.SECRET_KEY, public_origin="https://alsace-2026.trips.example.invalid",
                      trip_mcp_enabled=True)
        fields.update(over)
        return self.client.ensure(host_tests.TRIP_ID, host_tests.SLUG, **fields)

    def test_every_field_the_client_sends_is_one_the_script_accepts_and_acts_on(self) -> None:
        answer = self.ensure()
        self.assertTrue(answer["ok"], answer)
        self.assertEqual("created", answer["container"])
        self.assertEqual("created", answer["env"])
        self.assertIn("bind", answer)
        env = (self.trip_dir / ".env").read_text()
        self.assertIn(f"SEED_PASSWORD={host_tests.SECRET_PASSWORD}", env)
        self.assertIn(f"CONTROL_PLANE_EXCHANGE_KEY={host_tests.SECRET_KEY}", env)
        self.assertIn(f"HERMES_URL={BRIDGE}", env)
        self.assertIn("TRIP_MCP_ENABLED=1", env)
        self.assertTrue((self.trip_dir / "trip").is_dir())

    def test_the_whole_cycle_through_the_script(self) -> None:
        self.ensure()
        store = TripStore(str(self.nfs), host_tests.TRIP_ID, host_tests.TRIP_ID)
        store.write_trip_files({"trip.config.json": b'{"participants": []}'})
        self.assertEqual(b'{"participants": []}', (self.trip_dir / "trip" / "trip.config.json").read_bytes())
        self.change_state(images=self.load_state()["images"] + ["trip-site:" + "cd" * 32])
        deployed = self.client.deploy(host_tests.TRIP_ID, host_tests.SLUG, ip=host_tests.IP, image="cd" * 32)
        self.assertEqual(f"trip-site:{host_tests.DIGEST}", deployed["previous_image"])
        self.assertTrue(self.client.check(host_tests.TRIP_ID, host_tests.SLUG)["healthy"])
        read = self.client.read(host_tests.TRIP_ID, host_tests.SLUG, ["seed_password", "exchange_key_kind", "site_to_bridge"],
                                exchange_key_candidates={"derived": "x" * 20, "shared": host_tests.SECRET_KEY})
        self.assertEqual(host_tests.SECRET_PASSWORD, read["seed_password"])
        self.assertEqual("shared", read["exchange_key_kind"])
        self.assertTrue(read["site_to_bridge"]["ok"], read["site_to_bridge"])
        self.assertTrue(self.client.stop(host_tests.TRIP_ID, host_tests.SLUG)["ok"])
        self.assertTrue(self.client.start(host_tests.TRIP_ID, host_tests.SLUG)["ok"])
        self.assertTrue(self.client.remove(host_tests.TRIP_ID, host_tests.SLUG)["removed"])
        self.assertTrue(self.trip_dir.is_dir(), "remove keeps the trip's directory on the store")

    def test_an_unhealthy_site_is_an_answer_not_an_error(self) -> None:
        self.ensure()
        self.change_state(health_code="500")
        answer = self.client.check(host_tests.TRIP_ID, host_tests.SLUG)
        self.assertEqual((True, False, 500), (answer["running"], answer["healthy"], answer["status"]))

    def test_a_missing_image_is_the_clients_image_missing_error_naming_the_build_command(self) -> None:
        self.change_state(images=[])
        with self.assertRaises(TripImageMissing) as caught:
            self.ensure()
        self.assertIn("kinerary-cp-release trip-image sha256:" + host_tests.DIGEST, str(caught.exception))

    def test_stop_of_a_missing_container_is_what_the_client_expects_it_to_look_like(self) -> None:
        self.assertTrue(self.client.stop(host_tests.TRIP_ID, host_tests.SLUG, missing_ok=True)["ok"])
        with self.assertRaisesRegex(TripContainerError, "no such container"):
            self.client.stop(host_tests.TRIP_ID, host_tests.SLUG)

    def test_a_bridge_url_other_than_the_hosts_is_refused_by_the_host(self) -> None:
        other = DockerSiteAdapter(self.transport, bridge_url="http://elsewhere.internal:4310")
        with self.assertRaisesRegex(TripContainerError, "bridge origin this host is configured for"):
            other.ensure(host_tests.TRIP_ID, host_tests.SLUG, ip=host_tests.IP, image=host_tests.DIGEST,
                         seed_password=host_tests.SECRET_PASSWORD)
        self.assertEqual([], self.mutating_calls())

    def test_the_startup_probe_is_the_refusal_the_script_gives_for_a_trip_that_cannot_exist(self) -> None:
        self.client.preflight()
        code, out = self.answers[-1]
        self.assertEqual(2, code)
        self.assertIn("no store yet", out)

    def test_the_startup_probe_fails_loudly_against_a_host_that_is_not_set_up(self) -> None:
        self.conf["TRIP_CONTAINER_NETWORK"] = "bad network name!"
        with self.assertRaises(TripContainerError):
            self.client.preflight()

    def test_no_secret_is_on_a_docker_command_line_or_in_the_hosts_answers(self) -> None:
        self.ensure()
        self.client.read(host_tests.TRIP_ID, host_tests.SLUG, ["site_to_bridge"])
        for call in self.calls():
            for secret in (host_tests.SECRET_PASSWORD, host_tests.SECRET_KEY):
                self.assertNotIn(secret, " ".join(call))
        ensure_answer = self.answers[0][1]
        self.assertNotIn(host_tests.SECRET_PASSWORD, ensure_answer)
        self.assertNotIn(host_tests.SECRET_KEY, ensure_answer)


class ComputePathAgainstTheScriptTests(RealScriptCase):
    """A provision as the worker makes it, with the real script on the other side of the same seam."""

    def setUp(self) -> None:
        super().setUp()
        import tempfile
        self.root = tempfile.mkdtemp(prefix="deploy-root-")
        self.addCleanup(__import__("shutil").rmtree, self.root, ignore_errors=True)
        self.compute = LxcProvisionAdapter(
            deploy_root=self.root, node="", template="", storage="", bridge="", ip_pool=[],
            hostname_domain="trips.example.invalid", tunnel_id="", npm_url="", npm_api_token="",
            cloudflare_zone_id="", cloudflare_api_token="", routing="wildcard", placement="vm-container",
            container_site=self.client, container_ip_pool=[host_tests.IP], nfs_local_base=str(self.nfs),
            health_attempts=1, sleep=lambda s: None,
        )
        self.adapter = ShellDeployAdapter(deploy_root=self.root, vmid_map={}, repo_root="/repo", compute=self.compute,
                                          trip_nfs_local_base=str(self.nfs))

    def test_a_provision_is_ensure_then_the_config_then_deploy_then_check_and_the_site_password_is_read_back(self) -> None:
        url = self.adapter.deploy(host_tests.SLUG, {"meta": {"title": "Alsace"}, "participants": []},
                                  first_provision=True, trip_id=host_tests.TRIP_ID, release_digest=RELEASE)
        self.assertEqual("https://alsace-2026.trips.example.invalid", url)
        verbs = [c[0] for c in self.calls() if c[0] in ("run", "rename", "exec", "start", "stop", "rm")]
        self.assertEqual("run", verbs[0], "ensure ran the container before anything was written")
        self.assertEqual(json.loads((self.trip_dir / "trip" / "trip.config.json").read_text())["meta"]["title"], "Alsace")
        password = self.compute.site_login_password(host_tests.SLUG)
        self.assertRegex(password, r"^[a-z0-9]{4}(-[a-z0-9]{4}){3}$")
        self.assertIn(f"SEED_PASSWORD={password}", (self.trip_dir / ".env").read_text())
        self.assertEqual(oct(0o600), oct((self.trip_dir / ".env").stat().st_mode & 0o777))

    def test_a_re_provision_recreates_the_container_and_keeps_the_password(self) -> None:
        kwargs = dict(trip_id=host_tests.TRIP_ID, release_digest=RELEASE)
        self.adapter.deploy(host_tests.SLUG, {"participants": []}, first_provision=True, **kwargs)
        first = self.compute.site_login_password(host_tests.SLUG)
        self.adapter.deploy(host_tests.SLUG, {"participants": [{"username": "a"}]}, first_provision=False, **kwargs)
        self.assertEqual(first, self.compute.site_login_password(host_tests.SLUG))
        config = json.loads((self.trip_dir / "trip" / "trip.config.json").read_text())
        self.assertEqual([{"username": "a"}], config["participants"])

    def test_a_site_that_never_answers_health_fails_the_provision(self) -> None:
        self.change_state(health_code="500")
        with self.assertRaisesRegex(TripContainerError, "did not become healthy"):
            self.adapter.deploy(host_tests.SLUG, {"participants": []}, first_provision=True,
                                trip_id=host_tests.TRIP_ID, release_digest=RELEASE)


if __name__ == "__main__":
    unittest.main()
