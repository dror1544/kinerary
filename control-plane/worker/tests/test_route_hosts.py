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

from control_plane_worker.provisioner import ProvisionerWorker, RouteHostError, TripRoute

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


OTHER_UPSTREAM = "http://192.0.2.99:8080"
LOGGER = "control_plane_worker.provisioner"


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class HostnameAlreadyHeldByAnotherTrip(unittest.TestCase):
    """The unique index on `public_host` (and the DNS-name CHECK) must not turn a finished provision into a
    failed one for a host-routed trip, and must not leave a retired or suspended trip holding a name that a live
    trip needs. Every case runs the real worker against a fresh trip, with a second trip's route row in place."""

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn)
        self.other_trip = f"trip_other{os.urandom(5).hex()}"

    def tearDown(self) -> None:
        self.conn.rollback()
        self.conn.execute("DELETE FROM control_plane.runtime_routes WHERE trip_id = %s", (self.other_trip,))
        self.conn.execute("DELETE FROM control_plane.trips WHERE id = %s", (self.other_trip,))
        self.conn.commit()
        teardown_fixture(self.conn, self.fix)

    def _seed_other(self, *, state: str = "ready", retired: bool = False, host: str = HOST_ROUTE.public_host) -> None:
        self.conn.rollback()
        self.conn.execute(
            "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES (%s, %s, 'ready_private')",
            (self.other_trip, f"{'retired-' if retired else ''}other-{self.other_trip[-8:]}"),
        )
        self.conn.execute(
            "INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state, public_host, upstream_url) "
            "VALUES (%s, %s, %s, %s, %s)",
            (self.other_trip, f"route_other{os.urandom(5).hex()}", state, host, OTHER_UPSTREAM),
        )
        self.conn.commit()

    def _row(self, trip_id: str) -> dict | None:
        self.conn.rollback()
        return self.conn.execute(
            "SELECT state, public_host, upstream_url FROM control_plane.runtime_routes WHERE trip_id = %s", (trip_id,),
        ).fetchone()

    def _trip_state(self) -> str:
        self.conn.rollback()
        return self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],)
        ).fetchone()["lifecycle_state"]

    def _job_state(self) -> str:
        self.conn.rollback()
        return self.conn.execute(
            "SELECT state FROM control_plane.jobs WHERE id = %s", (self.fix["job_id"],)
        ).fetchone()["state"]

    def _run(self, route: TripRoute) -> list[str]:
        with self.assertLogs(LOGGER, level=logging.INFO) as logs:
            ProvisionerWorker(db_url=DB_URL, deploy=RoutedDeploy(route), worker_id="test-routes").run_once()
        # `output` is the formatted record, traceback included: the place a database error's DETAIL (it quotes the
        # other row, upstream address and all) would show if an exception carried it into a `job_failed` line.
        return list(logs.output)

    def _assert_no_address(self, lines: list[str]) -> None:
        text = "\n".join(lines)
        for forbidden in (HOST_ROUTE.upstream_url, OTHER_UPSTREAM, "192.0.2.210", "192.0.2.99"):
            self.assertNotIn(forbidden, text)

    def _assert_finished_without_host(self, lines: list[str], reason: str) -> None:
        self.assertEqual("ready_private", self._trip_state(), "the rest of the transaction committed")
        self.assertEqual("succeeded", self._job_state())
        row = self._row(self.fix["trip_id"])
        self.assertEqual(("ready", None, None), (row["state"], row["public_host"], row["upstream_url"]))
        noted = [line for line in lines if "provisioner.route_hosts_not_recorded" in line]
        self.assertEqual(1, len(noted), lines)
        self.assertIn(f"reason={reason}", noted[0])
        self._assert_no_address(lines)

    # -- a row that is not in use gives the name up --------------------------------------------------------------

    def test_a_suspended_row_holding_the_name_is_cleared_and_the_write_goes_through(self) -> None:
        self._seed_other(state="suspended")
        lines = self._run(HOST_ROUTE)
        mine = self._row(self.fix["trip_id"])
        self.assertEqual(("ready", HOST_ROUTE.public_host, HOST_ROUTE.upstream_url),
                         (mine["state"], mine["public_host"], mine["upstream_url"]))
        theirs = self._row(self.other_trip)
        self.assertEqual(("suspended", None, None), (theirs["state"], theirs["public_host"], theirs["upstream_url"]))
        self.assertEqual("ready_private", self._trip_state())
        released = [line for line in lines if "provisioner.route_host_released" in line]
        self.assertEqual(1, len(released), lines)
        self.assertIn(self.fix["trip_id"], released[0])
        self.assertIn(self.other_trip, released[0], "both trip ids are in the line")
        self._assert_no_address(lines)
        self.assertNotIn(HOST_ROUTE.public_host, "\n".join(lines), "nor the hostname")

    def test_a_pending_row_is_cleared_too(self) -> None:
        self._seed_other(state="pending")
        self._run(HOST_ROUTE)
        self.assertIsNone(self._row(self.other_trip)["public_host"])
        self.assertEqual(HOST_ROUTE.public_host, self._row(self.fix["trip_id"])["public_host"])

    def test_a_retired_trips_ready_row_is_cleared_for_a_wildcard_trip_as_well(self) -> None:
        self._seed_other(state="ready", retired=True)
        lines = self._run(WILDCARD_ROUTE)
        self.assertIsNone(self._row(self.other_trip)["public_host"])
        self.assertIsNone(self._row(self.other_trip)["upstream_url"])
        self.assertEqual(HOST_ROUTE.public_host, self._row(self.fix["trip_id"])["public_host"])
        self.assertEqual("ready_private", self._trip_state())
        self.assertTrue(any("reason=trip_retired" in line for line in lines), lines)

    def test_a_clear_is_undone_when_the_job_fails_after_it(self) -> None:
        # the clear and the write are in the job's transaction: a failure later in it takes both back
        self._seed_other(state="suspended")
        original = ProvisionerWorker._register_runtime_route

        def boom(self, conn, cur, trip_id, route):
            original(self, conn, cur, trip_id, route)
            raise RuntimeError("simulated failure after the route write")

        with mock.patch.object(ProvisionerWorker, "_register_runtime_route", boom):
            self._run(HOST_ROUTE)
        self.assertNotEqual("ready_private", self._trip_state())
        self.assertIsNone(self._row(self.fix["trip_id"]))
        self.assertEqual(HOST_ROUTE.public_host, self._row(self.other_trip)["public_host"], "the clear rolled back")

    # -- a row that IS in use keeps it ----------------------------------------------------------------------------

    def test_a_ready_route_of_a_live_trip_is_never_cleared_and_a_host_trip_finishes_without_its_host(self) -> None:
        self._seed_other(state="ready")
        lines = self._run(HOST_ROUTE)
        self._assert_finished_without_host(lines, "public_host_in_use")
        theirs = self._row(self.other_trip)
        self.assertEqual(("ready", HOST_ROUTE.public_host, OTHER_UPSTREAM),
                         (theirs["state"], theirs["public_host"], theirs["upstream_url"]), "the other trip is untouched")
        self.assertTrue(any(self.other_trip in line for line in lines if "route_hosts_not_recorded" in line))

    def test_a_wildcard_trip_whose_name_a_live_trip_holds_fails_naming_that_trip(self) -> None:
        self._seed_other(state="ready")
        lines = self._run(WILDCARD_ROUTE)
        self.assertNotEqual("ready_private", self._trip_state())
        self.assertNotEqual("succeeded", self._job_state())
        self.assertIsNone(self._row(self.fix["trip_id"]), "no half-written route behind the failure")
        refused = [line for line in lines if line.startswith(f"WARNING:{LOGGER}:provisioner.route_host_refused")]
        self.assertEqual(1, len(refused), lines)
        self.assertIn(self.other_trip, refused[0])
        self.assertIn("reason=public_host_in_use", refused[0])
        self.assertEqual(HOST_ROUTE.public_host, self._row(self.other_trip)["public_host"])
        self._assert_no_address(lines)

    def test_the_wildcard_refusal_carries_a_code_a_job_can_keep_and_no_database_text(self) -> None:
        self._seed_other(state="ready")
        worker = ProvisionerWorker(db_url=DB_URL, deploy=RoutedDeploy(None), worker_id="test-routes")
        with psycopg.connect(DB_URL, row_factory=dict_row) as conn, self.assertRaises(RouteHostError) as caught:
            with conn.transaction(), conn.cursor() as cur:
                worker._register_runtime_route(conn, cur, self.fix["trip_id"], WILDCARD_ROUTE)
        self.assertEqual("ROUTE_PUBLIC_HOST_IN_USE", caught.exception.safe_error_code)
        self.assertRegex(caught.exception.safe_error_code, r"^[A-Z][A-Z0-9_]{2,63}$", "what jobs.safe_error_code accepts")
        self.assertIn(self.other_trip, str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(caught.exception.__suppress_context__, "raised `from None`: the database's own error is not chained")
        self.assertNotIn(OTHER_UPSTREAM, str(caught.exception))

    # -- a name the column refuses ------------------------------------------------------------------------------------

    def test_a_host_trip_with_a_name_the_column_refuses_finishes_without_its_host(self) -> None:
        lines = self._run(TripRoute("Not_A_Host.example.invalid", "http://192.0.2.210:8080", "host"))
        self._assert_finished_without_host(lines, "public_host_invalid")

    def test_a_wildcard_trip_with_a_name_the_column_refuses_fails_with_a_clear_reason(self) -> None:
        lines = self._run(TripRoute("Not_A_Host.example.invalid", "http://192.0.2.210:8080", "wildcard"))
        self.assertNotEqual("ready_private", self._trip_state())
        self.assertIsNone(self._row(self.fix["trip_id"]))
        refused = [line for line in lines if line.startswith(f"WARNING:{LOGGER}:provisioner.route_host_refused")]
        self.assertEqual(1, len(refused), lines)
        self.assertIn("reason=public_host_invalid", refused[0])
        self._assert_no_address(lines)


class OtherRefusalsAreNotSwallowed(unittest.TestCase):
    """Only the two hostname constraints are handled; any other refusal still fails the job."""

    def _worker(self) -> ProvisionerWorker:
        with mock.patch.object(ProvisionerWorker, "__init__", lambda self: None):
            return ProvisionerWorker()

    def test_a_unique_violation_that_is_not_the_hostname_index_propagates(self) -> None:
        class Cur(_Cursor):
            def execute(self, sql: str, params: Any = None) -> None:
                self.statements.append(" ".join(sql.split()))
                raise psycopg.errors.UniqueViolation("some other unique index")

        cur = Cur(fail_on=None)
        with self.assertRaises(psycopg.errors.UniqueViolation):
            self._worker()._register_runtime_route(_Conn(), cur, "trip_x", HOST_ROUTE)
        self.assertEqual(1, len(cur.statements), "no fallback row written behind it")

    def test_a_check_violation_that_is_not_the_hostname_check_propagates(self) -> None:
        class Cur(_Cursor):
            def execute(self, sql: str, params: Any = None) -> None:
                self.statements.append(" ".join(sql.split()))
                raise psycopg.errors.CheckViolation("some other check")

        with self.assertRaises(psycopg.errors.CheckViolation):
            self._worker()._register_runtime_route(_Conn(), Cur(fail_on=None), "trip_x", HOST_ROUTE)


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
