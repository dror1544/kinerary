"""The route a provisioned trip leaves for the runtime gateway.

On success the worker writes the trip's hostname and LAN address into its
`control_plane.runtime_routes` row, in the transaction that marks it
`ready_private`, in BOTH routing modes. Those two columns come from migration
`20261116120000_runtime_route_hosts.sql`.
"""
from __future__ import annotations

import logging
import os
import unittest
from typing import Any
from unittest import mock

import psycopg
import psycopg.errors
from psycopg.rows import dict_row

from control_plane_worker.provisioner import ProvisionerWorker, TripRoute

from tests.support.test_database import test_database_url
from tests.test_provisioner import (
    FakeDeployAdapter,
    run_test_migrations,
    setup_fixture,
    teardown_fixture,
)

DB_URL = test_database_url()
SKIP = not DB_URL

HOST_ROUTE = TripRoute("tokyo-2026.example.invalid", "http://192.0.2.210:8080", "host")
WILDCARD_ROUTE = TripRoute("tokyo-2026.example.invalid", "http://192.0.2.210:8080", "wildcard")


class RoutedDeploy(FakeDeployAdapter):
    """The fake deploy adapter, with the one extra method the real
    ShellDeployAdapter has: where this trip's site is."""

    def __init__(self, route: TripRoute | Exception | None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._route = route
        self.fetched: list[str] = []

    def route_for(self, slug: str) -> TripRoute | None:
        if isinstance(self._route, Exception):
            raise self._route
        return self._route

    def http_get(self, url: str) -> tuple[int, str]:
        self.fetched.append(url)
        return super().http_get(url)


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class RouteRecordedOnSuccess(unittest.TestCase):
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

    def _run(self, route: TripRoute | Exception | None, **kwargs: Any) -> RoutedDeploy:
        deploy = RoutedDeploy(route, **kwargs)
        ProvisionerWorker(db_url=DB_URL, deploy=deploy, worker_id="test-routes").run_once()
        return deploy

    def _route_row(self) -> dict | None:
        self.conn.rollback()
        return self.conn.execute(
            "SELECT route_ref, state, public_host, upstream_url FROM control_plane.runtime_routes WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchone()

    def _trip_state(self) -> str:
        self.conn.rollback()
        return self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],)
        ).fetchone()["lifecycle_state"]

    def test_a_host_routed_trip_records_its_hostname_and_upstream(self) -> None:
        # AC-R2.5: both modes
        self._run(HOST_ROUTE)
        row = self._route_row()
        self.assertEqual("ready", row["state"])
        self.assertEqual("tokyo-2026.example.invalid", row["public_host"])
        self.assertEqual("http://192.0.2.210:8080", row["upstream_url"])
        self.assertEqual("ready_private", self._trip_state())

    def test_a_wildcard_routed_trip_records_the_same_two_values(self) -> None:
        self._run(WILDCARD_ROUTE)
        row = self._route_row()
        self.assertEqual(("ready", "tokyo-2026.example.invalid", "http://192.0.2.210:8080"),
                         (row["state"], row["public_host"], row["upstream_url"]))

    def test_the_route_and_the_ready_state_are_one_transaction(self) -> None:
        # Both columns and ready_private land together, or neither does: a
        # failing write of the route must not leave a ready trip.
        original = ProvisionerWorker._register_runtime_route

        def boom(self, conn, cur, trip_id, route):
            original(self, conn, cur, trip_id, route)
            raise RuntimeError("simulated failure after the route write")

        with mock.patch.object(ProvisionerWorker, "_register_runtime_route", boom):
            self._run(HOST_ROUTE)
        self.assertNotEqual("ready_private", self._trip_state())
        self.assertIsNone(self._route_row(), "the route of a trip that did not become ready must not exist")

    def test_re_provisioning_rewrites_both_and_keeps_the_route_ref(self) -> None:
        self._run(HOST_ROUTE)
        first = self._route_row()
        worker = ProvisionerWorker(db_url=DB_URL, deploy=RoutedDeploy(None), worker_id="test-routes")
        moved = TripRoute("tokyo-2026.example.invalid", "http://192.0.2.77:8080", "host")
        self.conn.rollback()
        with psycopg.connect(DB_URL, row_factory=dict_row) as conn, conn.transaction(), conn.cursor() as cur:
            worker._register_runtime_route(conn, cur, self.fix["trip_id"], moved)
        again = self._route_row()
        self.assertEqual(first["route_ref"], again["route_ref"])
        self.assertEqual("http://192.0.2.77:8080", again["upstream_url"])
        self.assertEqual("ready", again["state"])

    def test_a_suspended_route_is_made_ready_again_by_a_re_provision(self) -> None:
        self._run(HOST_ROUTE)
        self.conn.rollback()
        self.conn.execute("UPDATE control_plane.runtime_routes SET state = 'suspended', public_host = NULL, "
                          "upstream_url = NULL WHERE trip_id = %s", (self.fix["trip_id"],))
        self.conn.commit()
        worker = ProvisionerWorker(db_url=DB_URL, deploy=RoutedDeploy(None), worker_id="test-routes")
        with psycopg.connect(DB_URL, row_factory=dict_row) as conn, conn.transaction(), conn.cursor() as cur:
            worker._register_runtime_route(conn, cur, self.fix["trip_id"], HOST_ROUTE)
        row = self._route_row()
        self.assertEqual(("ready", "tokyo-2026.example.invalid"), (row["state"], row["public_host"]))

    def test_a_deploy_adapter_with_no_route_leaves_the_route_row_as_it_always_was(self) -> None:
        # the plain FakeDeployAdapter has no route_for at all
        deploy = FakeDeployAdapter()
        ProvisionerWorker(db_url=DB_URL, deploy=deploy, worker_id="test-routes").run_once()
        row = self._route_row()
        self.assertEqual("ready", row["state"])
        self.assertIsNone(row["public_host"])
        self.assertIsNone(row["upstream_url"])

    def test_a_host_trip_is_still_verified_at_its_public_url(self) -> None:
        deploy = self._run(HOST_ROUTE)
        self.assertTrue(deploy.fetched)
        self.assertTrue(all(url.startswith(f"https://{self._slug()}.test.example") for url in deploy.fetched),
                        deploy.fetched)

    def test_a_wildcard_trip_is_verified_at_its_own_address_not_through_the_gateway(self) -> None:
        # Its hostname cannot route until the row this very transaction writes
        # says so, so probing the public name first could only ever fail.
        deploy = self._run(WILDCARD_ROUTE)
        self.assertTrue(deploy.fetched)
        self.assertTrue(all(url.startswith("http://192.0.2.210:8080/") for url in deploy.fetched), deploy.fetched)
        self.assertEqual("ready_private", self._trip_state())

    def test_a_wildcard_trip_whose_route_cannot_be_derived_fails_the_job(self) -> None:
        deploy = self._run(ValueError("wildcard-routed but gives no usable route"))
        self.assertNotEqual("ready_private", self._trip_state())
        self.assertIsNone(self._route_row())
        self.assertEqual([], deploy.fetched)

    def _slug(self) -> str:
        self.conn.rollback()
        return self.conn.execute("SELECT slug FROM control_plane.trips WHERE id = %s",
                                 (self.fix["trip_id"],)).fetchone()["slug"]


class _Cursor:
    def __init__(self, fail_on: str | None) -> None:
        self.statements: list[str] = []
        self._fail_on = fail_on

    def execute(self, sql: str, params: Any = None) -> None:
        self.statements.append(" ".join(sql.split()))
        if self._fail_on and self._fail_on in sql:
            raise psycopg.errors.UndefinedColumn("column \"public_host\" does not exist")


class _Conn:
    def transaction(self):
        return mock.MagicMock()


class SchemaWithoutTheColumns(unittest.TestCase):
    """A worker can be newer than its schema. That must not turn a finished
    host-routed deploy into a failed one - and must not hide that a wildcard
    trip, whose only way in is these columns, was not routed."""

    def _worker(self) -> ProvisionerWorker:
        with mock.patch.object(ProvisionerWorker, "__init__", lambda self: None):
            return ProvisionerWorker()

    def test_a_host_trip_falls_back_to_the_old_row_and_says_so(self) -> None:
        cur = _Cursor(fail_on="public_host")
        with self.assertLogs("control_plane_worker.provisioner", level=logging.WARNING) as logs:
            self._worker()._register_runtime_route(_Conn(), cur, "trip_x", HOST_ROUTE)
        self.assertEqual(2, len(cur.statements))
        self.assertNotIn("public_host", cur.statements[1])
        self.assertIn("INSERT INTO control_plane.runtime_routes", cur.statements[1])
        self.assertIn("route_hosts_not_recorded", logs.output[0])

    def test_a_wildcard_trip_fails_instead_of_finishing_unrouted(self) -> None:
        cur = _Cursor(fail_on="public_host")
        with self.assertRaises(psycopg.errors.UndefinedColumn):
            self._worker()._register_runtime_route(_Conn(), cur, "trip_x", WILDCARD_ROUTE)
        self.assertEqual(1, len(cur.statements), "no old-style row written behind the failure")

    def test_no_route_at_all_is_the_old_statement_alone(self) -> None:
        cur = _Cursor(fail_on=None)
        self._worker()._register_runtime_route(_Conn(), cur, "trip_x", None)
        self.assertEqual(1, len(cur.statements))
        self.assertNotIn("public_host", cur.statements[0])


if __name__ == "__main__":
    unittest.main()
