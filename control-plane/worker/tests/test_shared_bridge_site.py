"""The worker half of two findings from the owner's review of #599.

F2 (AC-K2.9): per-trip keys on, with the trip key master EQUAL to the control-plane key, refuses to start.
F3 (AC-B2.7, AC-B2.8): with the shared bridge, `TRIP_MCP_SHARED_SITE_URL` is how a trip CONTAINER reaches it;
a new trip's site is born with `HERMES_URL` set to it, and after the trip is wired the worker proves from inside
the container that the bridge answers there and knows the site's key.

No network, Proxmox or SSH is touched: transports are recorded. The database-backed class needs
CONTROL_PLANE_TEST_DATABASE_URL, like test_verification.py.

    PYTHONPATH=.:../.. python3 -m unittest discover -s tests   (from control-plane/worker)
"""
from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock

import psycopg
from psycopg.rows import dict_row

from control_plane_worker import verification
from control_plane_worker.__main__ import _shared_site_url, build_parser
from control_plane_worker.compute import LxcProvisionAdapter, NullComputeAdapter
from control_plane_worker.provisioner import ProvisionerWorker, ShellDeployAdapter
from tests.support.test_database import test_database_url
from tests.test_provisioner import (
    COMPANION_INTAKE,
    FakeCompanionProfileAdapter,
    FakeDeployAdapter,
    FakeMcpBridgeAdapter,
    rnd,
    run_test_migrations,
    setup_fixture,
    sha256,
    teardown_fixture,
)
from tests.test_routing import _HOST_ONLY, _REQUIRED_BASE, _adapter, _run_main, _Recorder

DB_URL = test_database_url()
SKIP = not DB_URL
SHARED_URL = "http://192.0.2.77:3999"
SECRET = "canary-key-value-0123456789"


class TripKeyMasterMustDifferFromTheControlPlaneKey(unittest.TestCase):
    """AC-K2.9. Names the variables, never a value."""

    def _run(self, **env: str):
        return _run_main({**_REQUIRED_BASE, **_HOST_ONLY, **env})

    def test_equal_values_refuse_to_start_and_say_which_variables_but_not_the_value(self) -> None:
        code, text, _a, _b = self._run(CONTROL_PLANE_TRIP_KEY_MASTER=SECRET, CONTROL_PLANE_EXCHANGE_KEY=SECRET)
        print(f"refusal output (exit {code}): {text.strip().splitlines()[-1]}")
        self.assertEqual(2, code)
        self.assertIn("CONTROL_PLANE_TRIP_KEY_MASTER", text)
        self.assertIn("CONTROL_PLANE_EXCHANGE_KEY", text)
        self.assertNotIn(SECRET, text)

    def test_it_refuses_even_when_compute_is_off(self) -> None:
        code, text, _a, _b = _run_main({**_REQUIRED_BASE, "PROVISIONER_COMPUTE_ENABLED": "0",
                                        "CONTROL_PLANE_TRIP_KEY_MASTER": SECRET, "CONTROL_PLANE_EXCHANGE_KEY": SECRET})
        self.assertEqual(2, code)
        self.assertNotIn(SECRET, text)

    def test_different_values_start_and_reach_the_adapter(self) -> None:
        code, text, kwargs, _b = self._run(CONTROL_PLANE_TRIP_KEY_MASTER="master-value-a", CONTROL_PLANE_EXCHANGE_KEY="exchange-value-b")
        self.assertEqual(0, code, text)
        self.assertEqual("master-value-a", kwargs["trip_key_master"])
        self.assertEqual("exchange-value-b", kwargs["control_plane_exchange_key"])

    def test_per_trip_keys_off_is_today_whatever_the_exchange_key_is(self) -> None:
        for env in ({"CONTROL_PLANE_EXCHANGE_KEY": SECRET}, {"CONTROL_PLANE_TRIP_KEY_MASTER": "", "CONTROL_PLANE_EXCHANGE_KEY": ""}, {}):
            with self.subTest(env=sorted(env)):
                code, text, _a, _b = self._run(**env)
                self.assertEqual(0, code, text)


class SharedSiteUrlSetting(unittest.TestCase):
    """AC-B2.7: required with TRIP_MCP_BRIDGE=shared, refused without it, validated either way."""

    def test_shared_without_the_url_refuses_to_start_naming_the_variable(self) -> None:
        for url in (None, ""):
            with self.subTest(url=url):
                env = {**_REQUIRED_BASE, **_HOST_ONLY, "TRIP_MCP_BRIDGE": "shared"}
                if url is not None:
                    env["TRIP_MCP_SHARED_SITE_URL"] = url
                code, text, _a, _b = _run_main(env)
                self.assertEqual(2, code)
                self.assertIn("TRIP_MCP_SHARED_SITE_URL is required", text)

    def test_the_url_without_shared_refuses_to_start_so_it_cannot_be_half_set(self) -> None:
        for bridge in (None, "", "per_trip"):
            with self.subTest(bridge=bridge):
                env = {**_REQUIRED_BASE, **_HOST_ONLY, "TRIP_MCP_SHARED_SITE_URL": SHARED_URL}
                if bridge is not None:
                    env["TRIP_MCP_BRIDGE"] = bridge
                code, text, _a, _b = _run_main(env)
                self.assertEqual(2, code)
                self.assertIn("TRIP_MCP_SHARED_SITE_URL is set but TRIP_MCP_BRIDGE is not shared", text)

    def test_both_set_starts_and_the_adapter_is_given_the_address(self) -> None:
        code, text, kwargs, _b = _run_main({**_REQUIRED_BASE, **_HOST_ONLY, "TRIP_MCP_BRIDGE": "shared", "TRIP_MCP_SHARED_SITE_URL": SHARED_URL})
        self.assertEqual(0, code, text)
        self.assertEqual(SHARED_URL, kwargs["shared_bridge_site_url"])
        self.assertNotIn("192.0.2.77", text, "the address is not echoed at start")

    def test_per_trip_hands_the_adapter_nothing(self) -> None:
        code, text, kwargs, _b = _run_main({**_REQUIRED_BASE, **_HOST_ONLY})
        self.assertEqual(0, code, text)
        self.assertEqual("", kwargs["shared_bridge_site_url"])

    def test_only_a_plain_http_origin_is_accepted(self) -> None:
        for good in ("http://192.0.2.77:3999", "https://bridge.example.test", "http://bridge:3999", "http://a.b.example.test:8080"):
            with self.subTest(good=good):
                self.assertEqual(good, _shared_site_url(good))
        for bad in ("bridge.example.test:3999", "http://", "http://h:0", "http://h:65536", "http://h:99999", "http://h/path",
                    "http://h/", "http://u:p@h:1", "http://h:1?x=1", "http://h:1#f", "ftp://h:1", "http://h :1", "http://h:1\n",
                    "http://h;id", "http://$(id):1", "HTTP://h:1 ", "http://-h:1", "http://h-:1"):
            with self.subTest(bad=bad), self.assertRaises(Exception):
                _shared_site_url(bad)

    def test_a_malformed_value_refuses_at_parse_time_naming_the_variable(self) -> None:
        with mock.patch.dict(os.environ, {"TRIP_MCP_BRIDGE": "shared", "TRIP_MCP_SHARED_SITE_URL": "http://h/x"}, clear=True), \
                redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(SystemExit):
                build_parser().parse_args(["provision"])
        self.assertIn("TRIP_MCP_SHARED_SITE_URL", err.getvalue())


class ComputeAdapterSeam(unittest.TestCase):
    def test_the_address_reaches_the_container_adapter_the_real_factory_builds(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            adapter = _adapter(root, routing="wildcard", shared_bridge_site_url=SHARED_URL)
            built: dict = {}

            def fake_proxmox(ssh, **kwargs):
                built.update(kwargs)
                return mock.Mock()

            with mock.patch("control_plane_worker.compute.ProxmoxLxcAdapter", fake_proxmox), \
                    mock.patch("control_plane_worker.compute.SubprocessSshTransport", lambda **k: mock.Mock()):
                adapter._build_provisioner(adapter._build_topology("tokyo-2026"), exchange_key="k")
        self.assertEqual(SHARED_URL, built["hermes_url"])

    def test_unset_it_is_empty_so_nothing_is_written(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            adapter = _adapter(root, routing="wildcard")
            built: dict = {}
            with mock.patch("control_plane_worker.compute.ProxmoxLxcAdapter", lambda ssh, **kw: built.update(kw) or mock.Mock()), \
                    mock.patch("control_plane_worker.compute.SubprocessSshTransport", lambda **k: mock.Mock()):
                adapter._build_provisioner(adapter._build_topology("tokyo-2026"))
        self.assertEqual("", built["hermes_url"])

    def test_verify_site_bridge_asks_the_container_adapter_with_the_trips_own_spec_and_the_address(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            rec = _Recorder()
            rec.proxmox.check_site_to_bridge.return_value = (True, "health 200")
            adapter = _adapter(root, routing="wildcard", provisioner=rec.provisioner, shared_bridge_site_url=SHARED_URL)
            adapter.create_container("tokyo-2026")
            self.assertEqual((True, "health 200"), adapter.verify_site_bridge("tokyo-2026"))
            spec, url = rec.proxmox.check_site_to_bridge.call_args.args
            self.assertEqual(SHARED_URL, url)
            self.assertEqual("trip-tokyo-2026", spec.name)

    def test_with_no_shared_bridge_or_no_topology_there_is_nothing_to_check(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            rec = _Recorder()
            adapter = _adapter(root, routing="wildcard", provisioner=rec.provisioner)
            adapter.create_container("tokyo-2026")
            self.assertIsNone(adapter.verify_site_bridge("tokyo-2026"))
            rec.proxmox.check_site_to_bridge.assert_not_called()
            shared = _adapter(root, routing="wildcard", provisioner=rec.provisioner, shared_bridge_site_url=SHARED_URL)
            self.assertIsNone(shared.verify_site_bridge("no-such-trip"))
        self.assertIsNone(NullComputeAdapter().verify_site_bridge("x"))

    def test_the_deploy_adapter_passes_it_on_but_never_for_a_hand_built_vmid_map_trip(self) -> None:
        compute = mock.Mock()
        compute.verify_site_bridge.return_value = (False, "health 401")
        deploy = ShellDeployAdapter(deploy_root="/unused", vmid_map={"legacy": "201"}, repo_root=None, compute=compute)
        self.assertEqual((False, "health 401"), deploy.verify_site_bridge("auto-trip"))
        self.assertIsNone(deploy.verify_site_bridge("legacy"))
        compute.verify_site_bridge.assert_called_once_with("auto-trip")


class SiteToBridgeCheckResult(unittest.TestCase):
    def test_pass_fail_and_not_applicable(self) -> None:
        self.assertEqual(("site_to_bridge", "passed", "ok"), tuple(verification.check_site_to_bridge(lambda: (True, "ok"))))
        self.assertEqual(("site_to_bridge", "failed", "no"), tuple(verification.check_site_to_bridge(lambda: (False, "no"))))
        self.assertIsNone(verification.check_site_to_bridge(lambda: None))

    def test_a_check_that_could_not_run_is_a_failure_not_a_skip(self) -> None:
        def boom():
            raise RuntimeError("could not run the site-to-bridge check in container 201")

        result = verification.check_site_to_bridge(boom)
        self.assertEqual("failed", result.outcome)
        self.assertIn("could not run", result.evidence)

    def test_it_is_not_one_of_the_six_every_provision_records(self) -> None:
        self.assertNotIn(verification.SITE_TO_BRIDGE, verification.CHECK_NAMES)
        self.assertNotIn(verification.SITE_TO_BRIDGE, verification.HARD_GATE_CHECKS)


class _SharedDeploy(FakeDeployAdapter):
    """A deploy adapter that has a shared bridge and answers the in-container check."""

    def __init__(self, answer, **kw) -> None:
        super().__init__(**kw)
        self.answer = answer
        self.asked: list[str] = []

    def verify_site_bridge(self, slug: str):
        self.asked.append(slug)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class _UnwiredBridge(FakeMcpBridgeAdapter):
    def setup(self, slug: str, profile_name: str) -> bool:
        super().setup(slug, profile_name)
        return False


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class SiteToBridgeInTheProvisionFlow(unittest.TestCase):
    """AC-B2.8: recorded after the companion step has wired the trip, as a named verification row."""

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def tearDown(self) -> None:
        self.conn.rollback()
        with self.conn.transaction():
            self.conn.execute("DELETE FROM control_plane.trip_person_links WHERE trip_id = %s", (self.fix["trip_id"],))
            self.conn.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (self.fix["trip_id"],))
            self.conn.execute("DELETE FROM control_plane.user_identities WHERE id = %s", (self.identity_id,))
        teardown_fixture(self.conn, self.fix)

    def _provision(self, deploy, bridge=None):
        self.fix = setup_fixture(self.conn, intake=COMPANION_INTAKE)
        self.identity_id = f"idnt_{rnd()}"
        chat_id = "8" + str(__import__("secrets").randbelow(10**9)).zfill(9)
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.user_identities
                     (id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at)
                   VALUES (%s, %s, 'telegram', %s, %s, now())""",
                (self.identity_id, self.fix["user_id"], sha256(chat_id), chat_id),
            )
        ProvisionerWorker(
            db_url=DB_URL, deploy=deploy, worker_id="test-site-bridge",
            companion=FakeCompanionProfileAdapter(), mcp_bridge=bridge or FakeMcpBridgeAdapter(),
        ).run_once()
        rows = self.conn.execute(
            "SELECT check_name, outcome FROM control_plane.verification_evidence WHERE trip_id = %s", (self.fix["trip_id"],),
        ).fetchall()
        return {r["check_name"]: r["outcome"] for r in rows}

    def test_a_site_the_bridge_knows_is_recorded_passed_after_the_bridge_was_wired(self) -> None:
        deploy = _SharedDeploy((True, "health 200"))
        outcomes = self._provision(deploy)
        self.assertEqual("passed", outcomes[verification.SITE_TO_BRIDGE])
        self.assertEqual(1, len(deploy.asked))

    def test_a_site_that_cannot_use_the_bridge_is_recorded_failed_and_logged_loudly_but_the_trip_stays_ready(self) -> None:
        deploy = _SharedDeploy((False, "health 401: the bridge does not recognise this site's key"))
        with self.assertLogs("control_plane_worker", level="ERROR") as logs:
            outcomes = self._provision(deploy)
        self.assertEqual("failed", outcomes[verification.SITE_TO_BRIDGE])
        self.assertTrue(any("site_bridge_check_failed" in line and "booking extraction" in line for line in logs.output), logs.output)
        state = self.conn.execute("SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],)).fetchone()
        self.assertEqual("ready_private", state["lifecycle_state"], "the companion step runs after that commit, by design")

    def test_a_check_that_cannot_run_is_recorded_failed_not_dropped(self) -> None:
        outcomes = self._provision(_SharedDeploy(RuntimeError("could not run the site-to-bridge check in container 201")))
        self.assertEqual("failed", outcomes[verification.SITE_TO_BRIDGE])

    def test_no_shared_bridge_records_nothing_new(self) -> None:
        deploy = _SharedDeploy(None)
        outcomes = self._provision(deploy)
        self.assertNotIn(verification.SITE_TO_BRIDGE, outcomes)
        self.assertEqual(set(verification.CHECK_NAMES), set(outcomes))

    def test_a_deploy_adapter_that_has_never_heard_of_it_changes_nothing(self) -> None:
        outcomes = self._provision(FakeDeployAdapter())
        self.assertEqual(set(verification.CHECK_NAMES), set(outcomes))

    def test_the_check_is_not_made_when_the_bridge_was_not_wired(self) -> None:
        deploy = _SharedDeploy((True, "health 200"))
        outcomes = self._provision(deploy, bridge=_UnwiredBridge())
        self.assertEqual([], deploy.asked, "no route exists to be recognised by")
        self.assertNotIn(verification.SITE_TO_BRIDGE, outcomes)


if __name__ == "__main__":
    unittest.main()
