"""Per-trip exchange keys: what a new trip's site is born with, and what its route says.

docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, K2 (AC-K2.4, AC-K2.5, AC-K2.6).

    CONTROL_PLANE_TRIP_KEY_MASTER set   a new trip's .env gets derive(master, trip_id); route trip_key = 'derived'
    unset (the default)                 today's shared key; route trip_key = 'shared' (the column default)

    PYTHONPATH=.:../.. python3 -m unittest discover -s tests   (from control-plane/worker)

Nothing here touches a network or Proxmox: transports are recorded, never opened.
"""
from __future__ import annotations

import json
import logging
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import psycopg
import psycopg.errors
from psycopg.rows import dict_row

from control_plane_worker.compute import LxcProvisionAdapter, NullComputeAdapter, derive_trip_key
from control_plane_worker.provisioner import ProvisionerWorker, ShellDeployAdapter, TripRoute

from tests.support.test_database import test_database_url
from tests.test_provisioner import FakeDeployAdapter, run_test_migrations, setup_fixture, teardown_fixture
from tests.test_route_hosts import HOST_ROUTE, _Conn, _Cursor

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "runtime-gateway" / "test" / "fixtures" / "trip-key-vectors.json")
    .read_text(encoding="utf-8")
)
MASTER = "test-master-do-not-use-0001"
SHARED = "shared-key-do-not-use"
TRIP_ID = "trip_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DB_URL = test_database_url()


class DerivationParity(unittest.TestCase):
    def test_every_published_vector_is_reproduced(self) -> None:
        # AC-K2.6: the gateway's test reads the same file.
        self.assertEqual("kinerary-trip-exchange:v1:", VECTORS["label"])
        self.assertGreaterEqual(len(VECTORS["vectors"]), 3)
        for vector in VECTORS["vectors"]:
            with self.subTest(trip=vector["tripId"], master=vector["master"]):
                self.assertEqual(vector["key"], derive_trip_key(vector["master"], vector["tripId"]))

    def test_a_key_is_for_one_trip_and_one_master(self) -> None:
        self.assertNotEqual(derive_trip_key(MASTER, TRIP_ID), derive_trip_key(MASTER, TRIP_ID[:-1] + "b"))
        self.assertNotEqual(derive_trip_key(MASTER, TRIP_ID), derive_trip_key(MASTER + "x", TRIP_ID))

    def test_an_empty_master_or_trip_is_refused_not_derived(self) -> None:
        for master, trip in (("", TRIP_ID), (MASTER, "")):
            with self.assertRaises(ValueError):
                derive_trip_key(master, trip)


def _adapter(root: str, **overrides: Any) -> LxcProvisionAdapter:
    kwargs: dict[str, Any] = dict(
        deploy_root=root, node="pve", template="local:vztmpl/debian.tar.zst", storage="local-lvm", bridge="vmbr0",
        ip_pool=["192.0.2.210", "192.0.2.211"], hostname_domain="trips.example.invalid",
        # wildcard routing: nothing public to create, so the NPM and Cloudflare adapters stay out of the way.
        tunnel_id="", npm_url="", npm_api_token="", cloudflare_zone_id="", cloudflare_api_token="",
        routing="wildcard", control_plane_exchange_key=SHARED,
    )
    kwargs.update(overrides)
    return LxcProvisionAdapter(**kwargs)


class _Container:
    """Stands in for ProxmoxLxcAdapter: records how it was built, and answers what the container 'holds'."""

    instances: list["_Container"] = []
    held_kind: str | None = None  # what every container built from now on says its .env holds

    def __init__(self, ssh: Any, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.created = False
        self.asked: list[dict[str, str]] = []
        _Container.instances.append(self)

    def inspect(self, spec: Any) -> dict[str, str] | None:
        return {"vmid": "205", "name": spec.name} if self.created else None

    def create(self, spec: Any) -> None:
        self.created = True

    def needs_bootstrap(self, spec: Any) -> bool:
        return False

    def site_password(self, spec: Any) -> str:
        return "aaaa-bbbb-cccc-dddd"

    def reset_trip_data(self, spec: Any) -> None:
        pass

    def exchange_key_kind(self, spec: Any, candidates: dict[str, str]) -> str | None:
        self.asked.append(dict(candidates))
        return _Container.held_kind


class WhatANewSiteIsBornWith(unittest.TestCase):
    def setUp(self) -> None:
        _Container.instances = []
        _Container.held_kind = None
        patches = [
            mock.patch("control_plane_worker.compute.HttpJsonTransport", lambda *a, **k: mock.Mock()),
            mock.patch("control_plane_worker.compute.SubprocessSshTransport", lambda **k: mock.Mock()),
            mock.patch("control_plane_worker.compute.ProxmoxLxcAdapter", _Container),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def _create(self, adapter: LxcProvisionAdapter, slug: str = "tokyo-2026", trip_id: str | None = TRIP_ID) -> _Container:
        adapter.create_container(slug, first_provision=True, trip_id=trip_id)
        return _Container.instances[-1]

    def test_with_the_master_set_the_site_gets_this_trips_derived_key(self) -> None:
        # AC-K2.4
        with tempfile.TemporaryDirectory() as root:
            container = self._create(_adapter(root, trip_key_master=MASTER))
        self.assertEqual(derive_trip_key(MASTER, TRIP_ID), container.kwargs["control_plane_exchange_key"])
        self.assertNotEqual(SHARED, container.kwargs["control_plane_exchange_key"])
        self.assertNotIn(MASTER, json.dumps(container.kwargs), "the master itself never reaches the site's adapter")

    def test_two_trips_get_two_keys(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            adapter = _adapter(root, trip_key_master=MASTER)
            first = self._create(adapter, "tokyo-2026", TRIP_ID)
            second = self._create(adapter, "kyoto-2026", TRIP_ID[:-1] + "b")
        self.assertNotEqual(first.kwargs["control_plane_exchange_key"], second.kwargs["control_plane_exchange_key"])

    def test_with_the_master_unset_the_site_gets_todays_shared_key_and_nothing_is_read_back(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            adapter = _adapter(root)
            container = self._create(adapter)
            self.assertEqual(SHARED, container.kwargs["control_plane_exchange_key"])
            self.assertEqual([], container.asked, "off means no extra read of the container")
            self.assertIsNone(adapter.site_trip_key("tokyo-2026"), "and the route is left as it is")

    def test_with_the_master_set_the_route_is_told_what_the_container_holds(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            adapter = _adapter(root, trip_key_master=MASTER)
            adapter.create_container("tokyo-2026", first_provision=True, trip_id=TRIP_ID)
            container = _Container.instances[-1]
            self.assertEqual([{"derived": derive_trip_key(MASTER, TRIP_ID), "shared": SHARED}], container.asked)
            self.assertIsNone(adapter.site_trip_key("tokyo-2026"), "the container held neither: say nothing")
            for held in ("derived", "shared"):
                _Container.held_kind = held
                adapter.create_container("tokyo-2026", trip_id=TRIP_ID)
                self.assertEqual(held, adapter.site_trip_key("tokyo-2026"))
            # an answer that is not a kind the column accepts is "could not say"
            _Container.held_kind = "legacy"
            adapter.create_container("tokyo-2026", trip_id=TRIP_ID)
            self.assertIsNone(adapter.site_trip_key("tokyo-2026"))

    def test_the_master_set_without_a_trip_id_fails_instead_of_falling_back_to_the_shared_key(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            adapter = _adapter(root, trip_key_master=MASTER)
            with self.assertRaises(RuntimeError) as caught:
                adapter.create_container("tokyo-2026", first_provision=True, trip_id=None)
        self.assertEqual([], _Container.instances, "nothing was built")
        self.assertNotIn(MASTER, str(caught.exception))
        self.assertNotIn(SHARED, str(caught.exception))

    def test_a_master_that_is_not_one_line_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                _adapter(root, trip_key_master="a\nb")

    def test_teardown_builds_without_a_topology_and_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            _adapter(root, trip_key_master=MASTER)._build_provisioner()
        self.assertEqual(SHARED, _Container.instances[-1].kwargs["control_plane_exchange_key"])

    def test_the_master_and_keys_are_not_logged(self) -> None:
        records: list[str] = []

        class Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record.getMessage() + repr(record.__dict__))

        root_logger = logging.getLogger()
        handler = Capture(logging.DEBUG)
        previous = root_logger.level
        root_logger.addHandler(handler)
        root_logger.setLevel(logging.DEBUG)
        try:
            with tempfile.TemporaryDirectory() as root:
                adapter = _adapter(root, trip_key_master=MASTER)
                adapter.create_container("tokyo-2026", first_provision=True, trip_id=TRIP_ID)
                topology_text = (Path(root) / "trips" / "tokyo-2026" / "topology.yaml").read_text(encoding="utf-8")
        finally:
            root_logger.removeHandler(handler)
            root_logger.setLevel(previous)
        blob = "\n".join(records) + topology_text
        for secret in (MASTER, SHARED, derive_trip_key(MASTER, TRIP_ID)):
            self.assertNotIn(secret, blob)


class TheDeployAdapterPassesTheKindOn(unittest.TestCase):
    def test_a_compute_adapter_that_knows_is_asked_and_one_that_does_not_says_nothing(self) -> None:
        compute = mock.Mock()
        compute.site_trip_key.return_value = "derived"
        self.assertEqual("derived", ShellDeployAdapter(deploy_root="/nonexistent", vmid_map={}, compute=compute).site_trip_key("t"))
        self.assertIsNone(ShellDeployAdapter(deploy_root="/nonexistent", vmid_map={}, compute=NullComputeAdapter()).site_trip_key("t"))
        # a compute adapter written before this existed
        self.assertIsNone(ShellDeployAdapter(deploy_root="/nonexistent", vmid_map={}, compute=object()).site_trip_key("t"))

    def test_a_hand_built_trip_in_the_vmid_map_has_no_kind_to_report(self) -> None:
        compute = mock.Mock()
        compute.site_trip_key.return_value = "derived"
        deploy = ShellDeployAdapter(deploy_root="/nonexistent", vmid_map={"kinerary": "201"}, compute=compute)
        self.assertIsNone(deploy.site_trip_key("kinerary"))
        compute.site_trip_key.assert_not_called()


class _KindDeploy(FakeDeployAdapter):
    """A fake deploy adapter that has a route and reports a kind of key, as ShellDeployAdapter does."""

    def __init__(self, kind: str | None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._kind = kind

    def route_for(self, slug: str) -> TripRoute | None:
        return HOST_ROUTE

    def site_trip_key(self, slug: str) -> str | None:
        return self._kind


class _NoKindDeploy(FakeDeployAdapter):
    """An adapter from before this change: no site_trip_key at all."""


@unittest.skipIf(not DB_URL, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class TheRouteSaysWhichKeyTheSiteHolds(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn)

    def tearDown(self) -> None:
        teardown_fixture(self.conn, self.fix)

    def _seed_route(self, trip_key: str) -> None:
        self.conn.rollback()
        self.conn.execute(
            "INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state, trip_key) VALUES (%s, 'route_beforeprov01', 'suspended', %s)",
            (self.fix["trip_id"], trip_key),
        )
        self.conn.commit()

    def _run(self, deploy: FakeDeployAdapter) -> None:
        ProvisionerWorker(db_url=DB_URL, deploy=deploy, worker_id="test-trip-keys").run_once()

    def _row(self) -> dict | None:
        self.conn.rollback()
        return self.conn.execute(
            "SELECT trip_key, state, route_ref FROM control_plane.runtime_routes WHERE trip_id = %s", (self.fix["trip_id"],)
        ).fetchone()

    def _state(self) -> str:
        self.conn.rollback()
        return self.conn.execute("SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],)).fetchone()["lifecycle_state"]

    def test_a_new_trip_built_with_a_derived_key_is_recorded_derived_and_ready_together(self) -> None:
        # AC-K2.4
        self._run(_KindDeploy("derived"))
        self.assertEqual({"trip_key": "derived", "state": "ready"}, {k: self._row()[k] for k in ("trip_key", "state")})
        self.assertEqual("ready_private", self._state())

    def test_the_kind_and_the_ready_state_are_one_transaction(self) -> None:
        original = ProvisionerWorker._record_trip_key

        def boom(self, conn, cur, trip_id, trip_key):
            original(self, conn, cur, trip_id, trip_key)
            raise RuntimeError("simulated failure after the key kind is written")

        with mock.patch.object(ProvisionerWorker, "_record_trip_key", boom):
            self._run(_KindDeploy("derived"))
        self.assertNotEqual("ready_private", self._state())
        self.assertIsNone(self._row(), "no half-recorded route survives a failed finish")

    def test_a_new_trip_with_the_master_unset_is_shared(self) -> None:
        # AC-K2.4: nothing says anything, and the column default is the answer.
        self._run(_KindDeploy(None))
        self.assertEqual("shared", self._row()["trip_key"])
        self.assertEqual("ready_private", self._state())

    def test_a_deploy_adapter_from_before_this_change_leaves_a_new_trip_shared(self) -> None:
        self._run(_NoKindDeploy())
        self.assertEqual("shared", self._row()["trip_key"])

    def test_a_re_provision_that_did_not_look_keeps_the_kind_the_route_has(self) -> None:
        # AC-K2.5: master unset (or the container unreadable) says nothing; a derived trip stays derived.
        self._seed_route("derived")
        self._run(_KindDeploy(None))
        row = self._row()
        self.assertEqual(("derived", "ready", "route_beforeprov01"), (row["trip_key"], row["state"], row["route_ref"]))

    def test_a_re_provision_whose_container_still_holds_a_derived_key_keeps_it(self) -> None:
        # bootstrap never rewrites an existing .env, so the key was not rewritten
        self._seed_route("derived")
        self._run(_KindDeploy("derived"))
        self.assertEqual("derived", self._row()["trip_key"])

    def test_a_shared_trip_re_provisioned_while_the_master_is_set_stays_shared(self) -> None:
        # The deployment gained a master; this trip's .env still holds the shared key.
        self._seed_route("shared")
        self._run(_KindDeploy("shared"))
        self.assertEqual("shared", self._row()["trip_key"])

    def test_a_container_that_was_re_keyed_by_hand_is_recorded_as_what_it_holds(self) -> None:
        # An operator wrote the derived key into a shared trip's .env; the next provision says so on the route.
        self._seed_route("shared")
        self._run(_KindDeploy("derived"))
        self.assertEqual("derived", self._row()["trip_key"])


class SchemaWithoutTheColumn(unittest.TestCase):
    """A worker can be newer than its schema. 'shared' is what a missing column means anyway;
    'derived' is the one thing that tells the gateway which key to send, so it fails the job."""

    def _worker(self) -> ProvisionerWorker:
        with mock.patch.object(ProvisionerWorker, "__init__", lambda self: None):
            return ProvisionerWorker()

    def _undefined_column(self) -> _Cursor:
        cur = _Cursor(fail_on="trip_key")
        return cur

    def test_derived_fails_loudly(self) -> None:
        cur = self._undefined_column()
        with self.assertRaises(psycopg.errors.UndefinedColumn):
            self._worker()._record_trip_key(_Conn(), cur, "trip_x", "derived")

    def test_shared_is_a_warning_and_the_job_goes_on(self) -> None:
        cur = self._undefined_column()
        with self.assertLogs("control_plane_worker.provisioner", level=logging.WARNING) as logs:
            self._worker()._record_trip_key(_Conn(), cur, "trip_x", "shared")
        self.assertIn("trip_key_not_recorded", logs.output[0])

    def test_nothing_known_writes_nothing(self) -> None:
        cur = _Cursor(fail_on=None)
        self._worker()._record_trip_key(_Conn(), cur, "trip_x", None)
        self.assertEqual([], cur.statements)


if __name__ == "__main__":
    unittest.main()
