"""Runtime tests that need a live PostgreSQL.

Skipped unless CONTROL_PLANE_TEST_DATABASE_URL is set, in the same way as the
TypeScript migration tests.
"""
from __future__ import annotations

import os
import unittest

DATABASE_URL = os.environ.get("CONTROL_PLANE_TEST_DATABASE_URL")

try:
    import psycopg
except ImportError:  # pragma: no cover - psycopg is only needed for these tests
    psycopg = None


@unittest.skipUnless(DATABASE_URL and psycopg, "requires psycopg and CONTROL_PLANE_TEST_DATABASE_URL")
class RuntimeQueueObserverTests(unittest.TestCase):
    def setUp(self) -> None:
        from control_plane_worker.runtime import queue_status

        self.queue_status = queue_status
        self.connection = psycopg.connect(DATABASE_URL, autocommit=True)
        self.addCleanup(self.connection.close)

    def _server_backend_count(self) -> int:
        with self.connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*)::int FROM pg_stat_activity"
                " WHERE datname = current_database() AND application_name = %s",
                ("kinerary-observer-test",),
            )
            return cursor.fetchone()[0]

    def test_repeated_polls_reuse_one_connection(self) -> None:
        # The observer used to open a fresh connection on every tick. Poll
        # several times through one connection and assert the backend count
        # stays at one.
        observer = psycopg.connect(
            f"{DATABASE_URL}?application_name=kinerary-observer-test", autocommit=True
        )
        self.addCleanup(observer.close)
        for _ in range(5):
            status = self.queue_status(observer)
            self.assertEqual("ready", status["database"])
            self.assertIn("schema_migrations", status)
            self.assertIn("queued_jobs", status)
        self.assertEqual(1, self._server_backend_count())

    def test_polling_leaves_no_idle_in_transaction_backend(self) -> None:
        observer = psycopg.connect(
            f"{DATABASE_URL}?application_name=kinerary-observer-test", autocommit=True
        )
        self.addCleanup(observer.close)
        self.queue_status(observer)
        with self.connection.cursor() as cursor:
            cursor.execute(
                "SELECT state FROM pg_stat_activity"
                " WHERE datname = current_database() AND application_name = %s",
                ("kinerary-observer-test",),
            )
            states = [row[0] for row in cursor.fetchall()]
        self.assertEqual(["idle"], states, "a reused connection must not sit idle in transaction")


if __name__ == "__main__":
    unittest.main()
