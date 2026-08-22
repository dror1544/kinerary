"""Integration tests for the provisioner worker.

These tests hit a real PostgreSQL database (CONTROL_PLANE_TEST_DATABASE_URL)
and exercise the full claim → transform → deploy → complete/fail flow.
They are skipped when the env var is absent (e.g., unit-only CI runs).
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import unittest
from typing import Any

import psycopg
from psycopg.rows import dict_row

from control_plane_worker.provisioner import DeployAdapter, ProvisionerWorker

DB_URL = os.environ.get("CONTROL_PLANE_TEST_DATABASE_URL")
SKIP = not DB_URL


# ── Fake deploy adapter ───────────────────────────────────────────────────────

class FakeDeployAdapter:
    def __init__(self, fail: bool = False, error_code: str = "FAKE_DEPLOY_FAILURE") -> None:
        self.deployed: list[dict[str, Any]] = []
        self._fail = fail
        self._error_code = error_code

    def deploy(self, slug: str, config: dict[str, Any]) -> str:
        if self._fail:
            exc = RuntimeError("simulated deploy failure")
            exc.safe_error_code = self._error_code  # type: ignore[attr-defined]
            raise exc
        self.deployed.append({"slug": slug, "config": config})
        return f"https://{slug}.test.example"


# ── Fixture helpers ───────────────────────────────────────────────────────────

def rnd(n: int = 16) -> str:
    return secrets.token_hex(n)


def sha256(s: str) -> str:
    return "sha256:" + hashlib.sha256(s.encode()).hexdigest()


JAPAN_INTAKE = {
    "trip_type": {"kind": "choice", "option_id": "family", "schema_version": 1, "other_text": None},
    "destination": {"kind": "text", "schema_version": 1, "text": "Japan"},
    "group_size": {"kind": "choice", "option_id": "2", "schema_version": 1, "other_text": None},
    "trip_duration": {"kind": "choice", "option_id": "two_weeks", "schema_version": 1, "other_text": None},
}


def setup_fixture(conn: psycopg.Connection) -> dict:
    """Create a trip with an approved provision job ready to claim."""
    tag = rnd(6)

    user_id = f"user_{rnd()}"
    trip_id = f"trip_{rnd()}"
    release_id = f"rls_{rnd()}"
    intake_id = f"intk_{rnd()}"
    plan_id = f"plan_{rnd()}"
    job_id = f"job_{rnd()}"
    appr_id = f"appr_{rnd()}"
    corr_id = f"corr_{rnd(8)}"

    intake_data = json.dumps(JAPAN_INTAKE)
    intake_digest = sha256(intake_data)
    plan_desired = json.dumps({
        "release_id": release_id,
        "intake_version_id": intake_id,
        "intake_digest": intake_digest,
        "resource_intent": [{"logical_type": "trip_runtime", "isolation_tier": "shared_test"}],
    })
    plan_digest = sha256(plan_desired)
    token_digest = sha256(f"raw-token-{tag}")

    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO control_plane.users(id, status, display_name) VALUES (%s, 'active', 'Owner')",
                (user_id,),
            )
            cur.execute(
                "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES (%s, %s, 'provisioning_approved')",
                (trip_id, f"prov-test-{tag}"),
            )
            cur.execute(
                "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES (%s, %s, %s, 'owner', 'active')",
                (f"memb_{rnd()}", trip_id, user_id),
            )
            cur.execute(
                """INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status)
                   VALUES (%s, %s, %s, 1, 1, 1, 'available')""",
                (release_id, rnd(20), sha256(f"artifact-{tag}")),
            )
            # artifact_ref is a back-reference to the session, but for the
            # provisioner test we populate data directly so the ref isn't used.
            cur.execute(
                """INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version, data)
                   VALUES (%s, %s, 1, %s, %s, now(), 1, %s::jsonb)""",
                (intake_id, trip_id, f"intake:sessions:sess_{tag}:v1", intake_digest, intake_data),
            )
            cur.execute(
                """INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired, updated_at)
                   VALUES (%s, %s, %s, 'provision', %s, 'approved', %s::jsonb, now())""",
                (plan_id, trip_id, release_id, plan_digest, plan_desired),
            )
            cur.execute(
                """INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, max_attempts)
                   VALUES (%s, %s, %s, 'provision', %s, %s, 'queued', 3)""",
                (job_id, trip_id, plan_id, f"prov-{tag}", corr_id),
            )
            cur.execute(
                """INSERT INTO control_plane.plan_approvals(id, plan_id, plan_digest, token_digest, issued_by, expires_at)
                   VALUES (%s, %s, %s, %s, 'test:organizer', now() + interval '1 hour')""",
                (appr_id, plan_id, plan_digest, token_digest),
            )

    return {
        "user_id": user_id, "trip_id": trip_id, "release_id": release_id,
        "intake_id": intake_id, "plan_id": plan_id, "job_id": job_id, "appr_id": appr_id,
    }


def teardown_fixture(conn: psycopg.Connection, fix: dict) -> None:
    # Assertions use the shared connection and may leave a read transaction
    # open. Roll it back before starting cleanup so the worker's separate
    # connection can see the next fixture.
    conn.rollback()
    trip_id = fix["trip_id"]
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("DELETE FROM control_plane.notification_outbox WHERE trip_id = %s", (trip_id,))
            cur.execute("DELETE FROM control_plane.plan_approvals WHERE plan_id IN (SELECT id FROM control_plane.plans WHERE trip_id = %s)", (trip_id,))
            cur.execute("DELETE FROM control_plane.job_steps WHERE job_id IN (SELECT id FROM control_plane.jobs WHERE trip_id = %s)", (trip_id,))
            cur.execute("DELETE FROM control_plane.jobs WHERE trip_id = %s", (trip_id,))
            cur.execute("DELETE FROM control_plane.plans WHERE trip_id = %s", (trip_id,))
            cur.execute("DELETE FROM control_plane.intake_versions WHERE trip_id = %s", (trip_id,))
            cur.execute("DELETE FROM control_plane.trip_memberships WHERE trip_id = %s", (trip_id,))
            cur.execute("DELETE FROM control_plane.trips WHERE id = %s", (trip_id,))
            cur.execute("DELETE FROM control_plane.releases WHERE id = %s", (fix["release_id"],))
            cur.execute("DELETE FROM control_plane.users WHERE id = %s", (fix["user_id"],))


# ── Tests ─────────────────────────────────────────────────────────────────────

def run_test_migrations() -> None:
    from pathlib import Path
    conn = psycopg.connect(DB_URL, autocommit=True)
    migrations_dir = Path(__file__).parent.parent.parent / "db" / "migrations"
    conn.autocommit = False
    conn.execute("CREATE TABLE IF NOT EXISTS public.control_plane_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
    conn.commit()
    for sql_file in sorted(migrations_dir.glob("*.sql")):
        version = sql_file.name
        row = conn.execute("SELECT 1 FROM public.control_plane_schema_migrations WHERE version = %s", (version,)).fetchone()
        if row:
            continue
        conn.execute(sql_file.read_text(encoding="utf-8"))
        conn.execute("INSERT INTO public.control_plane_schema_migrations(version) VALUES (%s)", (version,))
        conn.commit()
    conn.close()


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class ProvisionerHappyPathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn)
        self.fake_deploy = FakeDeployAdapter()
        self.worker = ProvisionerWorker(
            db_url=DB_URL,
            deploy=self.fake_deploy,
            worker_id="test-provisioner",
        )

    def tearDown(self) -> None:
        teardown_fixture(self.conn, self.fix)

    def test_happy_path_returns_true(self) -> None:
        self.assertTrue(self.worker.run_once())

    def test_happy_path_marks_job_succeeded(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT state FROM control_plane.jobs WHERE id = %s",
            (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual(row["state"], "succeeded")

    def test_happy_path_records_private_url_in_result(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT result FROM control_plane.jobs WHERE id = %s",
            (self.fix["job_id"],),
        ).fetchone()
        result = row["result"]
        self.assertIn("private_url", result)
        self.assertIn("prov-test-", result["private_url"])

    def test_happy_path_sets_trip_to_ready_private(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(row["lifecycle_state"], "ready_private")

    def test_happy_path_consumes_approval(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT used_at FROM control_plane.plan_approvals WHERE id = %s",
            (self.fix["appr_id"],),
        ).fetchone()
        self.assertIsNotNone(row["used_at"])

    def test_happy_path_enqueues_organizer_notification(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT kind, recipient, payload FROM control_plane.notification_outbox WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["kind"], "provisioning_complete")
        self.assertEqual(row["recipient"], "organizer")
        self.assertIn("private_url", row["payload"])

    def test_happy_path_calls_deploy_adapter_with_slug_and_config(self) -> None:
        self.worker.run_once()
        self.assertEqual(len(self.fake_deploy.deployed), 1)
        deployed = self.fake_deploy.deployed[0]
        self.assertIn("prov-test-", deployed["slug"])
        config = deployed["config"]
        self.assertIn("meta", config)
        self.assertEqual(config["meta"]["title"], "Japan — Family")

    def test_empty_queue_returns_false(self) -> None:
        # Consume the job first.
        self.worker.run_once()
        # Second call: queue is empty.
        result = self.worker.run_once()
        self.assertFalse(result)

    def test_no_claimable_job_when_approval_expired(self) -> None:
        # Expire the approval.
        self.conn.execute(
            "UPDATE control_plane.plan_approvals SET expires_at = now() - interval '1 second' WHERE id = %s",
            (self.fix["appr_id"],),
        )
        self.conn.commit()
        result = self.worker.run_once()
        self.assertFalse(result)
        # Job should still be queued.
        row = self.conn.execute(
            "SELECT state FROM control_plane.jobs WHERE id = %s",
            (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual(row["state"], "queued")


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class ProvisionerFailureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn)
        self.fake_deploy = FakeDeployAdapter(fail=True, error_code="FAKE_DEPLOY_FAILURE")
        self.worker = ProvisionerWorker(
            db_url=DB_URL,
            deploy=self.fake_deploy,
            worker_id="test-provisioner-fail",
        )

    def tearDown(self) -> None:
        teardown_fixture(self.conn, self.fix)

    def test_deploy_failure_returns_true(self) -> None:
        self.assertTrue(self.worker.run_once())

    def test_deploy_failure_re_queues_job_when_retries_remain(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT state, attempt FROM control_plane.jobs WHERE id = %s",
            (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual(row["state"], "queued")
        self.assertEqual(row["attempt"], 1)

    def test_deploy_failure_does_not_consume_approval_when_retriable(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT used_at FROM control_plane.plan_approvals WHERE id = %s",
            (self.fix["appr_id"],),
        ).fetchone()
        self.assertIsNone(row["used_at"])

    def test_deploy_failure_does_not_change_trip_state(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(row["lifecycle_state"], "provisioning_approved")

    def test_exhausted_failure_marks_job_failed_and_consumes_approval(self) -> None:
        # Exhaust retries: set attempt = max_attempts - 1.
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()

        self.worker.run_once()

        job_row = self.conn.execute(
            "SELECT state, safe_error_code FROM control_plane.jobs WHERE id = %s",
            (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual(job_row["state"], "failed")
        self.assertEqual(job_row["safe_error_code"], "FAKE_DEPLOY_FAILURE")

        appr_row = self.conn.execute(
            "SELECT used_at FROM control_plane.plan_approvals WHERE id = %s",
            (self.fix["appr_id"],),
        ).fetchone()
        self.assertIsNotNone(appr_row["used_at"])

    def test_exhausted_failure_enqueues_failure_notification(self) -> None:
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()
        self.worker.run_once()

        row = self.conn.execute(
            "SELECT kind, payload FROM control_plane.notification_outbox WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["kind"], "provisioning_failed")
        self.assertIn("safe_error_code", row["payload"])


if __name__ == "__main__":
    unittest.main()
