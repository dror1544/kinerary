"""Integration tests for the provisioner worker.

These tests hit a real PostgreSQL database (CONTROL_PLANE_TEST_DATABASE_URL)
and exercise the full claim → transform → deploy → complete/fail flow.
They are skipped when the env var is absent (e.g., unit-only CI runs).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import unittest
from typing import Any

import psycopg
from psycopg.rows import dict_row

from control_plane_worker.provisioner import (
    BindingRefused,
    DeployAdapter,
    ProvisionerWorker,
    bind_chat_to_trip,
    attach_profile_to_orphan_bindings,
)
from control_plane_worker.release_source import ReleaseSourceError

from tests.support.test_database import test_database_url

# Refuses a database whose name does not mark it as scratch — these tests
# write into whatever they are given. See tests/support/test_database.py.
DB_URL = test_database_url()
SKIP = not DB_URL


# ── Fake deploy adapter ───────────────────────────────────────────────────────

class FakeDeployAdapter:
    def __init__(self, fail: bool = False, error_code: str = "FAKE_DEPLOY_FAILURE") -> None:
        self.deployed: list[dict[str, Any]] = []
        self._fail = fail
        self._error_code = error_code

    def deploy(
        self,
        slug: str,
        config: dict[str, Any],
        *,
        first_provision: bool = False,
        sidecars: dict[str, Any] | None = None,
        source_dir: str | None = None,
    ) -> str:
        if self._fail:
            exc = RuntimeError("simulated deploy failure")
            exc.safe_error_code = self._error_code  # type: ignore[attr-defined]
            raise exc
        self.deployed.append({
            "slug": slug, "config": config, "first_provision": first_provision,
            "sidecars": sidecars or {}, "source_dir": source_dir,
        })
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


def setup_fixture(
    conn: psycopg.Connection, slug: str | None = None, intake: dict | None = None,
    first_provision: bool | None = None, desired_extra: dict | None = None,
) -> dict:
    """Create a trip with an approved provision job ready to claim.

    *slug* defaults to a non-draft `prov-test-*` value, so slug promotion stays
    out of the way unless a test explicitly seeds a `draft-` placeholder.
    *intake* defaults to JAPAN_INTAKE (no assistant/travelers questions —
    exercises the "no companion profile" path); pass a richer dict (see
    ChatIdRecipientTests/CompanionProfileTests) to exercise the companion path.
    """
    tag = rnd(6)

    user_id = f"user_{rnd()}"
    trip_id = f"trip_{rnd()}"
    release_id = f"rls_{rnd()}"
    intake_id = f"intk_{rnd()}"
    plan_id = f"plan_{rnd()}"
    job_id = f"job_{rnd()}"
    appr_id = f"appr_{rnd()}"
    corr_id = f"corr_{rnd(8)}"

    intake_data = json.dumps(intake if intake is not None else JAPAN_INTAKE)
    intake_digest = sha256(intake_data)
    desired: dict[str, Any] = {
        "release_id": release_id,
        "intake_version_id": intake_id,
        "intake_digest": intake_digest,
        "resource_intent": [{"logical_type": "trip_runtime", "isolation_tier": "shared_test"}],
    }
    if first_provision is not None:
        desired["first_provision"] = first_provision
    if desired_extra:
        desired.update(desired_extra)
    plan_desired = json.dumps(desired)
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
                (trip_id, slug or f"prov-test-{tag}"),
            )
            cur.execute(
                "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES (%s, %s, %s, 'owner', 'active')",
                (f"memb_{rnd()}", trip_id, user_id),
            )
            cur.execute(
                # Direct insert (not via promoteRelease), so it must carry the
                # promotion bookkeeping migration 0027's
                # releases_available_requires_promotion demands of any
                # 'available' row — same as migration 0016's seed and the
                # planner.test.ts fixture.
                """INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by)
                   VALUES (%s, %s, %s, 1, 1, 1, 'available', now(), 'test:fixture')""",
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
            cur.execute("DELETE FROM control_plane.runtime_routes WHERE trip_id = %s", (trip_id,))
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

    def test_happy_path_registers_a_ready_runtime_route(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT route_ref, state FROM control_plane.runtime_routes WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertRegex(row["route_ref"], r"^route_[A-Za-z0-9]{8,64}$")
        self.assertEqual(row["state"], "ready")

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
        # setup_fixture's owner has no telegram identity on file — recipient
        # is NULL, not the old literal 'organizer' string, which was never a
        # deliverable address. See ChatIdRecipientTests for the found case.
        self.assertIsNone(row["recipient"])
        self.assertIn("private_url", row["payload"])

    def test_happy_path_retires_the_plan_as_executed(self) -> None:
        self.worker.run_once()
        row = self.conn.execute(
            "SELECT status FROM control_plane.plans WHERE id = %s",
            (self.fix["plan_id"],),
        ).fetchone()
        # Terminal success must also clear plans_trip_active_idx, otherwise a
        # later correction cannot produce a replacement plan for the trip.
        self.assertEqual(row["status"], "executed")

    def test_happy_path_calls_deploy_adapter_with_slug_and_config(self) -> None:
        self.worker.run_once()
        self.assertEqual(len(self.fake_deploy.deployed), 1)
        deployed = self.fake_deploy.deployed[0]
        self.assertIn("prov-test-", deployed["slug"])
        config = deployed["config"]
        self.assertIn("meta", config)
        # Year is derived from the (real) departure date, so check the parts
        # that don't move rather than a full string that would go stale.
        self.assertIn("Japan", config["meta"]["title"])
        self.assertIn("Family", config["meta"]["title"])

    def test_first_provision_from_plan_desired_reaches_the_deploy_adapter(self) -> None:
        self.conn.execute(
            "UPDATE control_plane.plans SET desired = jsonb_set(desired, '{first_provision}', 'true') WHERE id = %s",
            (self.fix["plan_id"],),
        )
        self.conn.commit()
        self.worker.run_once()
        self.assertTrue(self.fake_deploy.deployed[0]["first_provision"])

    def test_first_provision_defaults_false_when_desired_omits_it(self) -> None:
        # The default fixture writes no first_provision key.
        self.worker.run_once()
        self.assertFalse(self.fake_deploy.deployed[0]["first_provision"])

    def test_deploy_always_gets_an_empty_trivia_sidecar(self) -> None:
        # Control-plane trips ship without trivia (documented descope in the
        # sprint plan); writing an empty file stops the trip server logging a
        # missing-file error on every boot.
        self.worker.run_once()
        sidecars = self.fake_deploy.deployed[0]["sidecars"]
        self.assertEqual([], sidecars["trivia_questions.json"])
        identity = sidecars["control-plane.identity.json"]
        self.assertEqual(self.fix["trip_id"], identity["tripId"])
        self.assertIsNone(identity["owner"], "an unresolved organizer must not be guessed")

    def test_owner_identity_is_bound_to_the_resolved_local_organizer(self) -> None:
        teardown_fixture(self.conn, self.fix)
        self.fix = setup_fixture(self.conn, intake={
            **JAPAN_INTAKE,
            "travelers": {"kind": "structured", "schema_version": 2,
                          "data": [{"name": "Alice", "name_en": "Alice", "age": 35}]},
            "organizer_identity": {"kind": "text", "schema_version": 1, "text": "Alice"},
        })
        self.worker.run_once()
        deployed = self.fake_deploy.deployed[0]
        identity = deployed["sidecars"]["control-plane.identity.json"]
        self.assertEqual(self.fix["user_id"], identity["owner"]["userId"])
        self.assertIn(identity["owner"]["username"], deployed["config"]["agent"]["organizers"])
        self.assertNotIn("control_plane_user_id", json.dumps(deployed["config"]))

    def test_bookings_sidecar_is_derived_from_phases_and_anchors(self) -> None:
        teardown_fixture(self.conn, self.fix)
        self.fix = setup_fixture(self.conn, intake={
            **JAPAN_INTAKE,
            "phases": {"kind": "structured", "schema_version": 2, "data": [
                {"name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                 "accommodation": {"name": "OMO3 Asakusa"}},
            ]},
            "travel_anchors": {"kind": "structured", "schema_version": 2, "data": [
                {"type": "activity", "detail": "Tokyo Skytree — 20 Sep 2026 10:00"},
            ]},
        })
        self.worker.run_once()
        bookings = self.fake_deploy.deployed[0]["sidecars"]["bookings.json"]
        kinds = sorted(b["type"] for b in bookings)
        self.assertEqual(["attraction", "hotel"], kinds)
        self.assertTrue(all(b["seed_key"] for b in bookings))

    def test_no_bookings_means_no_bookings_sidecar(self) -> None:
        # Default fixture intake has no phases and no anchors.
        self.worker.run_once()
        self.assertNotIn("bookings.json", self.fake_deploy.deployed[0]["sidecars"])

    def test_enrich_hook_receives_the_config_and_destination(self) -> None:
        seen: dict[str, Any] = {}

        def fake_enrich(config: dict, destination: str) -> dict:
            seen["destination"] = destination
            return {**config, "travel_info": {"countries": {"Japan": {"flag": "🇯🇵"}}}}

        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=self.fake_deploy, worker_id="test-enrich",
            enrich=fake_enrich,
        )
        worker.run_once()
        self.assertEqual("Japan", seen["destination"])
        self.assertEqual(
            "🇯🇵",
            self.fake_deploy.deployed[0]["config"]["travel_info"]["countries"]["Japan"]["flag"],
        )

    def test_a_raising_enrich_hook_does_not_fail_the_job(self) -> None:
        def boom(config: dict, destination: str) -> dict:
            raise RuntimeError("enrichment exploded")

        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=self.fake_deploy, worker_id="test-enrich-boom",
            enrich=boom,
        )
        worker.run_once()
        row = self.conn.execute(
            "SELECT state FROM control_plane.jobs WHERE id = %s", (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual("succeeded", row["state"])

    def test_lease_heartbeat_renews_while_a_slow_job_runs(self) -> None:
        # A deploy that blocks long enough for several heartbeat intervals.
        import time as _time

        class SlowDeploy(FakeDeployAdapter):
            def deploy(self, *args: Any, **kwargs: Any) -> str:
                _time.sleep(0.5)
                return super().deploy(*args, **kwargs)

        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=SlowDeploy(), worker_id="hb-test",
        )
        worker.LEASE_SECONDS = 4
        worker.HEARTBEAT_INTERVAL_SECONDS = 0.15

        t0 = self.conn.execute("SELECT now() AS n").fetchone()["n"]
        worker.run_once()

        row = self.conn.execute(
            "SELECT state, last_heartbeat_at FROM control_plane.jobs WHERE id = %s",
            (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual(row["state"], "succeeded")
        # _claim stamps last_heartbeat_at at ~t0; a beat during the 0.5s deploy
        # pushes it at least one interval past that.
        self.assertGreater(
            (row["last_heartbeat_at"] - t0).total_seconds(),
            worker.HEARTBEAT_INTERVAL_SECONDS,
        )

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
class ReleaseMaterializationTests(unittest.TestCase):
    """The provisioner must deploy the promoted release's source_revision, not
    whatever is in the worker's checkout (Sprint 4.7 review P1)."""

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fake_deploy = FakeDeployAdapter()
        self.materialize_calls: list[tuple[str, str | None]] = []
        self.made_dirs: list[str] = []

    def tearDown(self) -> None:
        teardown_fixture(self.conn, self.fix)

    def _fake_materialize(self, revision: str, digest: str | None) -> str:
        import tempfile
        self.materialize_calls.append((revision, digest))
        path = tempfile.mkdtemp(prefix="fake-release-")
        self.made_dirs.append(path)
        return path

    def _worker(self, **kw: Any) -> ProvisionerWorker:
        kw.setdefault("materialize", self._fake_materialize)
        return ProvisionerWorker(
            db_url=DB_URL, deploy=self.fake_deploy, worker_id="test-release-mat", **kw,
        )

    def test_verified_release_is_materialized_and_deployed_from_that_checkout(self) -> None:
        rev = "a" * 40
        self.fix = setup_fixture(self.conn, desired_extra={
            "release_verified": True,
            "release_source_revision": rev,
            "release_artifact_digest": sha256("tree"),
        })
        self._worker().run_once()

        self.assertEqual(self.materialize_calls, [(rev, sha256("tree"))])
        deployed = self.fake_deploy.deployed[0]
        self.assertEqual(deployed["source_dir"], self.made_dirs[0])
        # The checkout is a throwaway — cleaned up after the deploy returns.
        self.assertFalse(os.path.exists(self.made_dirs[0]))

    def test_unverified_dev_seed_release_deploys_repo_root_with_a_warning(self) -> None:
        self.fix = setup_fixture(self.conn, desired_extra={
            "release_source_revision": "b" * 40,  # present, but no release_verified
        })
        with self.assertLogs("control_plane_worker.provisioner", level="WARNING") as logs:
            self._worker().run_once()
        self.assertEqual(self.materialize_calls, [])
        self.assertIsNone(self.fake_deploy.deployed[0]["source_dir"])
        self.assertTrue(any("release_unverified" in line for line in logs.output))

    def test_a_materialize_failure_fails_the_job_and_never_deploys(self) -> None:
        self.fix = setup_fixture(self.conn, desired_extra={
            "release_verified": True,
            "release_source_revision": "c" * 40,
            "release_artifact_digest": sha256("expected"),
        })

        def boom(revision: str, digest: str | None) -> str:
            raise ReleaseSourceError("digest mismatch", "RELEASE_ARTIFACT_DIGEST_MISMATCH")

        # Exhaust retries so the failure is terminal, not re-queued.
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()

        self._worker(materialize=boom).run_once()

        self.assertEqual(len(self.fake_deploy.deployed), 0)
        row = self.conn.execute(
            "SELECT state, safe_error_code FROM control_plane.jobs WHERE id = %s",
            (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["safe_error_code"], "RELEASE_ARTIFACT_DIGEST_MISMATCH")


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class ChatIdRecipientTests(unittest.TestCase):
    """_complete/_fail must resolve the trip owner's real Telegram chat id
    (user_identities.provider_subject_id, migration 0017) into the outbox
    row's recipient — that's what makes the notification actually
    deliverable, unlike the old hardcoded 'organizer' role string."""

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn)
        self.identity_id = f"idnt_{rnd()}"
        self.chat_id = "700000" + rnd(3)

    def tearDown(self) -> None:
        self.conn.rollback()
        with self.conn.transaction():
            # A4: a binding is opened whenever an organizer chat id is known,
            # companion or not, so these fixtures now leave one behind.
            self.conn.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (self.fix["trip_id"],))
            self.conn.execute("DELETE FROM control_plane.user_identities WHERE id = %s", (self.identity_id,))
        teardown_fixture(self.conn, self.fix)

    def _add_owner_telegram_identity(self) -> None:
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.user_identities
                     (id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at)
                   VALUES (%s, %s, 'telegram', %s, %s, now())""",
                (self.identity_id, self.fix["user_id"], sha256(self.chat_id), self.chat_id),
            )

    def test_complete_writes_the_owner_real_chat_id_as_recipient(self) -> None:
        self._add_owner_telegram_identity()
        worker = ProvisionerWorker(db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-chatid")
        worker.run_once()
        row = self.conn.execute(
            "SELECT recipient FROM control_plane.notification_outbox WHERE trip_id = %s AND kind = 'provisioning_complete'",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(row["recipient"], self.chat_id)

    def test_fail_writes_the_owner_real_chat_id_as_recipient(self) -> None:
        self._add_owner_telegram_identity()
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()
        worker = ProvisionerWorker(db_url=DB_URL, deploy=FakeDeployAdapter(fail=True), worker_id="test-chatid")
        worker.run_once()
        row = self.conn.execute(
            "SELECT recipient FROM control_plane.notification_outbox WHERE trip_id = %s AND kind = 'provisioning_failed'",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(row["recipient"], self.chat_id)

    def test_complete_falls_back_to_the_interview_chat_id_hint_when_no_verified_identity(self) -> None:
        # No _add_owner_telegram_identity() call — the owner has no verified
        # Telegram identity on file (e.g. today's password-signup stopgap),
        # only migration 0022's best-effort hint captured at interview start.
        self.conn.execute(
            "UPDATE control_plane.trips SET notification_chat_id_hint = %s WHERE id = %s",
            (self.chat_id, self.fix["trip_id"]),
        )
        self.conn.commit()
        worker = ProvisionerWorker(db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-chatid-hint")
        worker.run_once()
        row = self.conn.execute(
            "SELECT recipient FROM control_plane.notification_outbox WHERE trip_id = %s AND kind = 'provisioning_complete'",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(row["recipient"], self.chat_id)

    def test_complete_prefers_verified_identity_over_the_hint(self) -> None:
        self._add_owner_telegram_identity()
        self.conn.execute(
            "UPDATE control_plane.trips SET notification_chat_id_hint = %s WHERE id = %s",
            ("999999999", self.fix["trip_id"]),
        )
        self.conn.commit()
        worker = ProvisionerWorker(db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-chatid-pref")
        worker.run_once()
        row = self.conn.execute(
            "SELECT recipient FROM control_plane.notification_outbox WHERE trip_id = %s AND kind = 'provisioning_complete'",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(row["recipient"], self.chat_id)


# Answers organizer_identity/bot_name/bot_gender/bot_tone/dietary — enough for
# transform_intake() to produce an `agent` block, so build_companion_handoff()
# doesn't return None.
COMPANION_INTAKE = {
    **JAPAN_INTAKE,
    "travelers": {"kind": "structured", "schema_version": 1, "data": [
        {"name": "Noa", "age": 34, "family": "Sagi"},
        {"name": "Eitan", "age": 36, "family": "Sagi"},
    ]},
    "organizer_identity": {"kind": "text", "schema_version": 1, "text": "Noa"},
    "bot_name": {"kind": "text", "schema_version": 1, "text": "Tal"},
    "bot_gender": {"kind": "choice", "option_id": "neutral", "schema_version": 1, "other_text": None},
    "bot_tone": {"kind": "choice", "option_id": "warm", "schema_version": 1, "other_text": None},
    "dietary": {"kind": "multi_choice", "schema_version": 1, "option_ids": ["vegetarian"]},
    "dietary_scope": {"kind": "structured", "schema_version": 1, "data": {"vegetarian": ["Noa"]}},
}


# The same intake, answered the way run 13's organizer actually answered it:
# a full name, given + family. COMPANION_INTAKE above says "Noa" — a bare first
# name, the one form that already resolved — so it could not have caught this.
FULL_NAME_ORGANIZER_INTAKE = {
    **COMPANION_INTAKE,
    "travelers": {"kind": "structured", "schema_version": 1, "data": [
        {"name": "ניר", "name_en": "Nir", "age": 56, "family": "סולומון", "family_en": "Solomon"},
        {"name": "נעה", "name_en": "Noa", "age": 25, "family": "סולומון", "family_en": "Solomon"},
    ]},
    "organizer_identity": {"kind": "text", "schema_version": 1, "text": "ניר סולומון"},
    "dietary_scope": {"kind": "structured", "schema_version": 1, "data": {"vegetarian": ["נעה"]}},
}


class FakeCompanionProfileAdapter:
    def __init__(self) -> None:
        self.installed: list[dict] = []

    def install(self, handoff: dict) -> str | None:
        self.installed.append(handoff)
        return handoff["profile"]["name"]


class FakeMcpBridgeAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def setup(self, slug: str, profile_name: str) -> bool:
        self.calls.append((slug, profile_name))
        return True


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class CompanionProfileTests(unittest.TestCase):
    """End-to-end: a confirmed intake with assistant answers produces a
    companion-profile install call and a telegram_chat_bindings row, using
    the organizer's real chat id from migration 0017 — same lookup Phase E's
    ChatIdRecipientTests already exercises for notification recipient."""

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn, intake=COMPANION_INTAKE)
        self.identity_id = f"idnt_{rnd()}"
        self.chat_id = "800000" + rnd(3)
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.user_identities
                     (id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at)
                   VALUES (%s, %s, 'telegram', %s, %s, now())""",
                (self.identity_id, self.fix["user_id"], sha256(self.chat_id), self.chat_id),
            )

    def tearDown(self) -> None:
        self.conn.rollback()
        with self.conn.transaction():
            self.conn.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (self.fix["trip_id"],))
            self.conn.execute("DELETE FROM control_plane.user_identities WHERE id = %s", (self.identity_id,))
        teardown_fixture(self.conn, self.fix)

    def test_companion_profile_installed_and_bound_to_the_organizer_chat_id(self) -> None:
        companion = FakeCompanionProfileAdapter()
        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-companion",
            companion=companion,
        )
        worker.run_once()

        self.assertEqual(len(companion.installed), 1)
        handoff = companion.installed[0]
        self.assertEqual(handoff["organizer"]["display_name"], "Noa")
        self.assertEqual(handoff["assistant"]["name"], "Tal")

        row = self.conn.execute(
            "SELECT trip_id, hermes_profile FROM control_plane.telegram_chat_bindings WHERE chat_id = %s",
            (self.chat_id,),
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["trip_id"], self.fix["trip_id"])
        self.assertEqual(row["hermes_profile"], handoff["profile"]["name"])

    def test_the_group_introduction_facts_are_kept_on_the_trip(self) -> None:
        """The GROUP arrival message is composed days later, out of this column.

        Every line of it is a fact — the assistant's name, the site, the shared
        login and who to use it as — and the dispatcher refuses to invent any of
        them: with no `assistant_name` stored it falls through to a bare "this
        group is connected to the trip" and pins nothing.

        So "the column is non-null" is not the property worth asserting. It held
        valid JSON all along. What it did not hold, until 2026-09-12, was
        anything the message is made of: the write was handed `notif_payload`
        (the site-ready line, `private_url` alone) where it meant `intro_facts`.
        Every trip provisioned since migration 0044 got an uncomposable
        introduction, and the first group to notice was a live family's.
        """
        deploy = FakeDeployAdapter()
        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=deploy, worker_id="test-companion-intro",
            companion=FakeCompanionProfileAdapter(),
        )
        worker.run_once()

        intro = self.conn.execute(
            "SELECT companion_intro FROM control_plane.trips WHERE id = %s",
            (self.fix["trip_id"],),
        ).fetchone()["companion_intro"]

        self.assertEqual(intro["assistant_name"], "Tal")
        self.assertEqual(
            intro["private_url"], f"https://{deploy.deployed[0]['slug']}.test.example"
        )
        self.assertIn("trip_title", intro)
        self.assertIn("language", intro)
        # Who to log in AS — the seed password is shared, so the username is
        # the only thing telling two travellers apart.
        self.assertEqual(
            sorted(p["name"] for p in intro["login_usernames"]),
            ["Eitan", "Noa"],
        )

    def test_no_binding_written_when_the_companion_adapter_declines(self) -> None:
        class DecliningAdapter:
            def install(self, handoff: dict) -> str | None:
                return None

        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-companion-decline",
            companion=DecliningAdapter(),
        )
        worker.run_once()
        # A4 inverted this assertion deliberately. It used to demand NO
        # binding when the companion declined — the coupling that, on
        # 2026-09-06, let one failed component take routing down with it. The
        # binding is now opened with a NULL profile: the chat belongs to this
        # trip either way, and the companion can be retried without first
        # reconstructing routing.
        row = self.conn.execute(
            "SELECT hermes_profile FROM control_plane.telegram_chat_bindings "
            "WHERE trip_id = %s AND closed_at IS NULL",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNotNone(row, "routing should not wait on the assistant")
        self.assertIsNone(row["hermes_profile"], "bound, but with no assistant behind it")
        # And the binding must NOT be mistaken for health.
        state = self.conn.execute(
            "SELECT reachability, unreachable_reason FROM control_plane.trips WHERE id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(
            (state["reachability"], state["unreachable_reason"]),
            ("unreachable", "COMPANION_TEMPLATES_ABSENT"),
        )

    def test_default_null_adapter_binds_the_chat_but_claims_no_health(self) -> None:
        worker = ProvisionerWorker(db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-companion-default")
        result = worker.run_once()
        self.assertTrue(result)
        row = self.conn.execute(
            "SELECT hermes_profile FROM control_plane.telegram_chat_bindings "
            "WHERE trip_id = %s AND closed_at IS NULL",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertIsNone(row["hermes_profile"])
        state = self.conn.execute(
            "SELECT reachability FROM control_plane.trips WHERE id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(state["reachability"], "unreachable")

    def test_mcp_bridge_is_called_with_the_slug_and_installed_profile_name(self) -> None:
        companion = FakeCompanionProfileAdapter()
        bridge = FakeMcpBridgeAdapter()
        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-bridge",
            companion=companion, mcp_bridge=bridge,
        )
        worker.run_once()

        self.assertEqual(len(bridge.calls), 1)
        slug, profile_name = bridge.calls[0]
        trip_row = self.conn.execute(
            "SELECT slug FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(slug, trip_row["slug"])
        self.assertEqual(profile_name, companion.installed[0]["profile"]["name"])
        # The binding still gets written even though a real bridge run
        # happened — bridge success/failure must not gate it either way.
        row = self.conn.execute(
            "SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = %s",
            (self.chat_id,),
        ).fetchone()
        self.assertIsNotNone(row)

    def test_a_failing_bridge_does_not_block_the_chat_binding_or_the_job(self) -> None:
        companion = FakeCompanionProfileAdapter()

        class RaisingBridge:
            def setup(self, slug: str, profile_name: str) -> bool:
                raise RuntimeError("setup-mcp.sh exited 1: boom")

        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-bridge-fail",
            companion=companion, mcp_bridge=RaisingBridge(),
        )
        result = worker.run_once()

        self.assertTrue(result)
        row = self.conn.execute(
            "SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = %s",
            (self.chat_id,),
        ).fetchone()
        self.assertIsNotNone(row)
        job_state = self.conn.execute(
            "SELECT state FROM control_plane.jobs WHERE trip_id = %s", (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(job_state["state"], "succeeded")

    def test_a_chat_already_serving_another_trip_is_not_taken(self) -> None:
        """The provisioner must not retarget a chat that is in force for another
        trip, and must not fail the provision over it either.

        Before this, the binding write was `ON CONFLICT (chat_id) DO UPDATE`
        inside a broad `except Exception: logger.warning` — so the group got
        silently moved to the new trip AND nothing said so. Now the provision
        still succeeds (a companion install is a best-effort side effect and
        must not roll back a deployed trip), the existing binding survives
        untouched, and the new trip is left with no open binding, which is the
        durable, queryable evidence that it is unroutable.
        """
        other = setup_fixture(self.conn)
        try:
            with self.conn.transaction():
                self.conn.execute(
                    """INSERT INTO control_plane.telegram_chat_bindings
                         (id, chat_id, trip_id, hermes_profile)
                       VALUES (%s, %s, %s, %s)""",
                    (f"tcb_{rnd()}", self.chat_id, other["trip_id"], "companion-incumbent"),
                )

            worker = ProvisionerWorker(
                db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-binding-refused",
                companion=FakeCompanionProfileAdapter(),
            )
            self.assertTrue(worker.run_once(), "the provision itself still succeeds")

            job_state = self.conn.execute(
                "SELECT state FROM control_plane.jobs WHERE trip_id = %s", (self.fix["trip_id"],),
            ).fetchone()
            self.assertEqual(job_state["state"], "succeeded")

            # The incumbent binding is untouched — not closed, not retargeted.
            open_rows = self.conn.execute(
                """SELECT trip_id, hermes_profile FROM control_plane.telegram_chat_bindings
                   WHERE chat_id = %s AND closed_at IS NULL""",
                (self.chat_id,),
            ).fetchall()
            self.assertEqual(len(open_rows), 1)
            self.assertEqual(open_rows[0]["trip_id"], other["trip_id"])
            self.assertEqual(open_rows[0]["hermes_profile"], "companion-incumbent")

            # And the new trip is detectably unroutable rather than silently so.
            self.assertIsNone(
                self.conn.execute(
                    """SELECT 1 FROM control_plane.telegram_chat_bindings
                       WHERE trip_id = %s AND closed_at IS NULL""",
                    (self.fix["trip_id"],),
                ).fetchone()
            )
        finally:
            self.conn.rollback()
            with self.conn.transaction():
                self.conn.execute(
                    "DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s",
                    (other["trip_id"],),
                )
            teardown_fixture(self.conn, other)


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class SlugPromotionTests(unittest.TestCase):
    """The slug assigned at signup approval is a placeholder; once the intake is
    confirmed the provisioner promotes it to one derived from the destination.

    This is what keeps `draft-sreq-acbfb02b84e46cd5...` out of the URL the
    family receives, and what let deploy.sh's TRIP_DIR guard reject the trip.
    """

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def _worker(self, deploy: FakeDeployAdapter) -> ProvisionerWorker:
        return ProvisionerWorker(db_url=DB_URL, deploy=deploy, worker_id="test-provisioner")

    def _slug_of(self, trip_id: str) -> str:
        row = self.conn.execute(
            "SELECT slug FROM control_plane.trips WHERE id = %s", (trip_id,)
        ).fetchone()
        return row["slug"]

    def test_draft_slug_is_promoted_from_the_intake(self) -> None:
        fix = setup_fixture(self.conn, slug=f"draft-sreq-{rnd(16)}")
        try:
            deploy = FakeDeployAdapter()
            self._worker(deploy).run_once()

            deployed_slug = deploy.deployed[0]["slug"]
            self.assertFalse(deployed_slug.startswith("draft-"))
            self.assertTrue(deployed_slug.startswith("japan-"), deployed_slug)
            # The database is updated too, not just the value handed to deploy.
            self.assertEqual(self._slug_of(fix["trip_id"]), deployed_slug)
        finally:
            teardown_fixture(self.conn, fix)

    def test_non_draft_slug_is_left_alone(self) -> None:
        fix = setup_fixture(self.conn)
        try:
            original = self._slug_of(fix["trip_id"])
            deploy = FakeDeployAdapter()
            self._worker(deploy).run_once()

            self.assertEqual(deploy.deployed[0]["slug"], original)
            self.assertEqual(self._slug_of(fix["trip_id"]), original)
        finally:
            teardown_fixture(self.conn, fix)

    def test_collision_with_an_existing_trip_gets_a_suffix(self) -> None:
        taken = setup_fixture(self.conn, slug=f"draft-sreq-{rnd(16)}")
        second = setup_fixture(self.conn, slug=f"draft-sreq-{rnd(16)}")
        try:
            first_deploy = FakeDeployAdapter()
            self._worker(first_deploy).run_once()
            second_deploy = FakeDeployAdapter()
            self._worker(second_deploy).run_once()

            slugs = {self._slug_of(taken["trip_id"]), self._slug_of(second["trip_id"])}
            self.assertEqual(len(slugs), 2, f"slugs collided: {slugs}")
            # Both derive from the same Japan intake, so at least one takes a
            # numeric suffix. Which number is NOT asserted: this database is
            # shared with real trips, and the first real provisioning run
            # (2026-09-06) took `japan-2026-2`, after which this test demanded
            # a suffix that was no longer available and failed on data rather
            # than behaviour. The property is "collisions are suffixed", not
            # "the suffix is 2".
            self.assertTrue(
                any(re.fullmatch(r"japan-2026-\d+", s) for s in slugs),
                f"expected a numeric-suffixed slug among {slugs}",
            )
        finally:
            teardown_fixture(self.conn, second)
            teardown_fixture(self.conn, taken)

    def test_promoted_slug_survives_a_deploy_failure(self) -> None:
        fix = setup_fixture(self.conn, slug=f"draft-sreq-{rnd(16)}")
        try:
            self._worker(FakeDeployAdapter(fail=True)).run_once()
            # Committed in its own transaction, so a retry reuses this slug
            # instead of allocating a fresh one on every attempt.
            promoted = self._slug_of(fix["trip_id"])
            self.assertFalse(promoted.startswith("draft-"))
            self.assertTrue(promoted.startswith("japan-"), promoted)
        finally:
            teardown_fixture(self.conn, fix)


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

    def test_exhausted_failure_retires_the_plan(self) -> None:
        """A terminal failure must move the plan out of 'approved'.

        plans_trip_active_idx is UNIQUE on trip_id WHERE status IN
        ('pending_approval', 'approved'). A plan left approved after its job
        died wedges the trip: the job is unclaimable, the approval is spent,
        and no replacement plan can even be inserted.
        """
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()

        self.worker.run_once()

        plan_row = self.conn.execute(
            "SELECT status FROM control_plane.plans WHERE id = %s",
            (self.fix["plan_id"],),
        ).fetchone()
        self.assertEqual(plan_row["status"], "superseded")

    def test_exhausted_failure_leaves_room_for_a_replacement_plan(self) -> None:
        """The point of retiring the plan: re-planning has to become possible."""
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()
        self.worker.run_once()
        self.conn.rollback()

        # Insert a replacement plan exactly as the planner would. Before the
        # lifecycle fix this raised UniqueViolation on plans_trip_active_idx.
        replacement_id = f"plan_{rnd()}"
        self.conn.execute(
            """INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired, updated_at)
               VALUES (%s, %s, %s, 'provision', %s, 'approved', %s::jsonb, now())""",
            (
                replacement_id,
                self.fix["trip_id"],
                self.fix["release_id"],
                sha256(f"replacement-{replacement_id}"),
                json.dumps({"release_id": self.fix["release_id"], "intake_version_id": self.fix["intake_id"]}),
            ),
        )
        self.conn.commit()

        row = self.conn.execute(
            "SELECT count(*) AS n FROM control_plane.plans WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(row["n"], 2)

    def test_retriable_failure_leaves_the_plan_approved(self) -> None:
        """Only *terminal* failure retires the plan — a retry still needs it."""
        self.worker.run_once()  # attempt 1 of 3, retriable

        plan_row = self.conn.execute(
            "SELECT status FROM control_plane.plans WHERE id = %s",
            (self.fix["plan_id"],),
        ).fetchone()
        self.assertEqual(plan_row["status"], "approved")

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


class ShellDeployAdapterErrorReportingTests(unittest.TestCase):
    """deploy.sh writes its progress and its failure diagnostics to stdout, and
    only SSH's own "Permanently added ... to the list of known hosts" warnings
    to stderr. The original `stderr or stdout` fallback therefore reported
    nothing but those warnings on every real failure — a health-check failure
    on 2026-08-28 printed 6 identical warning lines and not one word about the
    cause, which was `npm install` dying several stages earlier.
    """

    def _run_failing_deploy(self, stdout: str, stderr: str) -> str:
        from unittest import mock

        from control_plane_worker.provisioner import ShellDeployAdapter

        adapter = ShellDeployAdapter(
            deploy_root="/deploy-root", vmid_map={"japan-2026": "101"}, repo_root="/repo",
        )
        completed = mock.Mock(returncode=1, stdout=stdout, stderr=stderr)
        with mock.patch("control_plane_worker.provisioner.subprocess.run", return_value=completed), \
             mock.patch("control_plane_worker.provisioner.os.makedirs"), \
             mock.patch("builtins.open", mock.mock_open()), \
             mock.patch("control_plane_worker.provisioner.json.dump"):
            with self.assertRaises(RuntimeError) as caught:
                adapter.deploy("japan-2026", {"trip": {}})
        return str(caught.exception)

    def test_stdout_is_reported_even_when_stderr_is_non_empty(self) -> None:
        message = self._run_failing_deploy(
            stdout="Installing server dependencies...\ngyp ERR! find Python\n",
            stderr="Warning: Permanently added '192.168.0.40' (ED25519) to the list of known hosts.\n",
        )

        self.assertIn("gyp ERR!", message)

    def test_stderr_is_still_reported(self) -> None:
        message = self._run_failing_deploy(stdout="", stderr="ssh: connect to host: Connection refused\n")

        self.assertIn("Connection refused", message)


class ShellDeployAdapterSidecarTests(unittest.TestCase):
    """The transformer's bookings.json / trivia_questions.json land next to
    trip.config.json in the trip dir, which deploy.sh tars wholesale onto the
    container — so they only need to be written to disk, not passed to
    deploy.sh explicitly.
    """

    def test_sidecar_files_are_written_next_to_the_config(self) -> None:
        import tempfile
        from unittest import mock

        from control_plane_worker.provisioner import ShellDeployAdapter

        with tempfile.TemporaryDirectory() as deploy_root:
            adapter = ShellDeployAdapter(
                deploy_root=deploy_root, vmid_map={"japan-2026": "101"}, repo_root="/repo",
            )
            completed = mock.Mock(returncode=0, stdout="", stderr="")
            with mock.patch("control_plane_worker.provisioner.subprocess.run", return_value=completed), \
                 mock.patch.object(ShellDeployAdapter, "_private_url", return_value="https://japan-2026.example"):
                adapter.deploy(
                    "japan-2026", {"meta": {"title": "Japan"}},
                    sidecars={"bookings.json": [{"seed_key": "hotel_tokyo"}], "trivia_questions.json": []},
                )

            trip_dir = os.path.join(deploy_root, "trips", "japan-2026")
            with open(os.path.join(trip_dir, "bookings.json"), encoding="utf-8") as fh:
                self.assertEqual([{"seed_key": "hotel_tokyo"}], json.load(fh))
            with open(os.path.join(trip_dir, "trivia_questions.json"), encoding="utf-8") as fh:
                self.assertEqual([], json.load(fh))


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class ChatBindingLifecycleTests(unittest.TestCase):
    """A reassignment must CLOSE the old binding rather than overwrite it, and
    must never silently retarget a chat that is actively serving another trip.

    Before migration 0029 the provisioner did `ON CONFLICT (chat_id) DO UPDATE
    SET trip_id = ...`, so a chat bound to trip A became bound to trip B with
    no trace it had ever meant anything else — the exact behaviour the sprint
    plan forbids.
    """

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix_a = setup_fixture(self.conn)
        self.fix_b = setup_fixture(self.conn)
        self.chat_id = "800900" + rnd(3)

    def tearDown(self) -> None:
        self.conn.rollback()
        with self.conn.transaction():
            self.conn.execute(
                "DELETE FROM control_plane.telegram_chat_bindings WHERE chat_id = %s",
                (self.chat_id,),
            )
        teardown_fixture(self.conn, self.fix_a)
        teardown_fixture(self.conn, self.fix_b)

    def _rows(self) -> list[dict[str, Any]]:
        return self.conn.execute(
            """SELECT trip_id, hermes_profile, closed_at, closed_reason
               FROM control_plane.telegram_chat_bindings
               WHERE chat_id = %s
               ORDER BY created_at, closed_at NULLS LAST""",
            (self.chat_id,),
        ).fetchall()

    def _open_row(self) -> dict[str, Any] | None:
        return self.conn.execute(
            """SELECT trip_id, hermes_profile FROM control_plane.telegram_chat_bindings
               WHERE chat_id = %s AND closed_at IS NULL""",
            (self.chat_id,),
        ).fetchone()

    def test_first_binding_opens(self) -> None:
        outcome = bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a")
        self.assertEqual(outcome, "created")
        row = self._open_row()
        self.assertEqual(row["trip_id"], self.fix_a["trip_id"])
        self.assertEqual(row["hermes_profile"], "companion-a")

    def test_reprovisioning_the_same_trip_is_a_no_op(self) -> None:
        bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a")
        outcome = bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a")
        self.assertEqual(outcome, "unchanged")
        # No history churn from simply re-provisioning an unchanged trip.
        self.assertEqual(len(self._rows()), 1)

    def test_a_changed_profile_on_the_same_trip_still_leaves_a_trail(self) -> None:
        bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a")
        outcome = bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a-v2")
        self.assertEqual(outcome, "profile_rebound")

        rows = self._rows()
        self.assertEqual(len(rows), 2, "the old row is closed, not overwritten")
        closed = [r for r in rows if r["closed_at"] is not None]
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0]["hermes_profile"], "companion-a")
        self.assertEqual(closed[0]["closed_reason"], "profile_rebound")
        self.assertEqual(self._open_row()["hermes_profile"], "companion-a-v2")

    def test_retargeting_to_another_trip_is_refused(self) -> None:
        # The case the plan calls out: this chat is actively serving trip A.
        # A provisioning job for trip B has no signed organizer action, so it
        # must not take the chat.
        bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a")

        with self.assertRaises(BindingRefused) as caught:
            bind_chat_to_trip(self.conn, self.chat_id, self.fix_b["trip_id"], "companion-b")
        self.assertEqual(caught.exception.existing_trip_id, self.fix_a["trip_id"])
        self.assertEqual(caught.exception.requested_trip_id, self.fix_b["trip_id"])

        # And the existing binding is untouched — the refusal must not be a
        # partial write that leaves the chat pointing nowhere.
        self.assertEqual(len(self._rows()), 1)
        self.assertEqual(self._open_row()["trip_id"], self.fix_a["trip_id"])
        self.assertEqual(self._open_row()["hermes_profile"], "companion-a")

    def test_a_closed_binding_frees_the_chat_for_another_trip(self) -> None:
        # Reassignment is not forbidden, only silent reassignment. Once the old
        # binding is deliberately closed, the chat is available again — and the
        # history of what it used to serve survives.
        bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a")
        with self.conn.transaction():
            self.conn.execute(
                """UPDATE control_plane.telegram_chat_bindings
                   SET closed_at = now(), closed_reason = 'organizer_reassigned'
                   WHERE chat_id = %s AND closed_at IS NULL""",
                (self.chat_id,),
            )

        outcome = bind_chat_to_trip(self.conn, self.chat_id, self.fix_b["trip_id"], "companion-b")
        self.assertEqual(outcome, "created")
        self.assertEqual(self._open_row()["trip_id"], self.fix_b["trip_id"])

        history = [r for r in self._rows() if r["closed_at"] is not None]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["trip_id"], self.fix_a["trip_id"])
        self.assertEqual(history[0]["closed_reason"], "organizer_reassigned")

    def test_only_one_binding_per_chat_can_be_open(self) -> None:
        # Migration 0029's partial unique index is the backstop under a race
        # the FOR UPDATE lock would normally serialise.
        bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a")
        with self.assertRaises(psycopg.errors.UniqueViolation):
            with self.conn.transaction():
                self.conn.execute(
                    """INSERT INTO control_plane.telegram_chat_bindings
                         (id, chat_id, trip_id, hermes_profile)
                       VALUES (%s, %s, %s, %s)""",
                    (f"tcb_{rnd()}", self.chat_id, self.fix_b["trip_id"], "companion-b"),
                )

    def test_closed_at_and_closed_reason_cannot_disagree(self) -> None:
        # A half-closed row would be read as open by one filter and closed by
        # another — the constraint keeps "closed" a single fact.
        bind_chat_to_trip(self.conn, self.chat_id, self.fix_a["trip_id"], "companion-a")
        with self.assertRaises(psycopg.errors.CheckViolation):
            with self.conn.transaction():
                self.conn.execute(
                    """UPDATE control_plane.telegram_chat_bindings
                       SET closed_at = now()
                       WHERE chat_id = %s""",
                    (self.chat_id,),
                )


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class OperatorNotificationTests(unittest.TestCase):
    """The operator's own copy of a provisioning outcome.

    Observability, never a gate: these rows are written in the same transaction
    as the outcome they report, are addressed to the operator rather than the
    organizer, and are simply absent when no operator chat id is configured.
    """

    OPERATOR_CHAT = "operator-chat-9"

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

    def _worker(self, *, operator_chat_id, fail=False):
        return ProvisionerWorker(
            db_url=DB_URL,
            deploy=FakeDeployAdapter(fail=fail, error_code="FAKE_DEPLOY_FAILURE"),
            worker_id="test-provisioner-operator",
            operator_chat_id=operator_chat_id,
        )

    def _rows(self, notification_type):
        self.conn.rollback()
        return self.conn.execute(
            "SELECT recipient, payload, state FROM control_plane.notification_outbox "
            "WHERE trip_id = %s AND notification_type = %s",
            (self.fix["trip_id"], notification_type),
        ).fetchall()

    def test_success_writes_an_operator_copy_alongside_the_organizer_one(self) -> None:
        self._worker(operator_chat_id=self.OPERATOR_CHAT).run_once()

        operator = self._rows("operator_provisioning_complete")
        self.assertEqual(len(operator), 1)
        self.assertEqual(operator[0]["recipient"], self.OPERATOR_CHAT)
        self.assertEqual(operator[0]["state"], "pending")
        self.assertIn("private_url", operator[0]["payload"])
        self.assertEqual(operator[0]["payload"]["trip_id"], self.fix["trip_id"])

        # The organizer's row is untouched and still addressed elsewhere.
        organizer = self._rows("provisioning_complete")
        self.assertEqual(len(organizer), 1)
        self.assertNotEqual(organizer[0]["recipient"], self.OPERATOR_CHAT)

    def test_no_operator_chat_id_writes_no_operator_row(self) -> None:
        self._worker(operator_chat_id=None).run_once()
        self.assertEqual(self._rows("operator_provisioning_complete"), [])
        # The organizer still gets theirs — the two are independent.
        self.assertEqual(len(self._rows("provisioning_complete")), 1)

    def test_empty_operator_chat_id_is_treated_as_unset(self) -> None:
        # __main__ passes os.environ.get(..., "") — an unset env var must not
        # produce a row addressed to the empty string.
        self._worker(operator_chat_id="").run_once()
        self.assertEqual(self._rows("operator_provisioning_complete"), [])

    def test_exhausted_failure_writes_an_operator_copy_with_the_error_code(self) -> None:
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()

        self._worker(operator_chat_id=self.OPERATOR_CHAT, fail=True).run_once()

        operator = self._rows("operator_provisioning_failed")
        self.assertEqual(len(operator), 1)
        self.assertEqual(operator[0]["recipient"], self.OPERATOR_CHAT)
        self.assertEqual(operator[0]["payload"]["safe_error_code"], "FAKE_DEPLOY_FAILURE")

    def test_retriable_failure_writes_no_operator_row(self) -> None:
        # Still has retries left, so it is not an outcome worth reporting yet.
        self._worker(operator_chat_id=self.OPERATOR_CHAT, fail=True).run_once()
        self.assertEqual(self._rows("operator_provisioning_failed"), [])


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class OrganizerFullNameReachesCompanionTests(unittest.TestCase):
    """Proves the A1 fix carries all the way to companion invocation.

    The unit tests in test_transformer.py prove `_resolve_organizers` returns
    a username. That is necessary and not sufficient: what broke on
    2026-09-06 was the chain BEHIND it — no organizer, so `_derive_agent`
    writes no `agent.organizers`, so `build_companion_handoff` returns None,
    so `install()` is never called and no chat binding is written. This
    asserts the call actually happens, which is the only thing that makes the
    trip reachable.
    """

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn, intake=FULL_NAME_ORGANIZER_INTAKE)
        self.identity_id = f"idnt_{rnd()}"
        self.chat_id = "810000" + rnd(3)
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.user_identities
                     (id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at)
                   VALUES (%s, %s, 'telegram', %s, %s, now())""",
                (self.identity_id, self.fix["user_id"], sha256(self.chat_id), self.chat_id),
            )

    def tearDown(self) -> None:
        self.conn.rollback()
        with self.conn.transaction():
            self.conn.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (self.fix["trip_id"],))
            self.conn.execute("DELETE FROM control_plane.user_identities WHERE id = %s", (self.identity_id,))
        teardown_fixture(self.conn, self.fix)

    def test_a_full_name_answer_reaches_install_and_binds_the_chat(self) -> None:
        companion = FakeCompanionProfileAdapter()
        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-fullname",
            companion=companion,
        )
        worker.run_once()

        self.assertEqual(
            len(companion.installed), 1,
            "the companion was never invoked — organizer resolution stopped the chain again",
        )
        self.assertEqual(companion.installed[0]["organizer"]["display_name"], "ניר")

        row = self.conn.execute(
            "SELECT chat_id FROM control_plane.telegram_chat_bindings "
            "WHERE trip_id = %s AND closed_at IS NULL",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNotNone(row, "provisioned but unroutable — no open chat binding")
        self.assertEqual(row["chat_id"], self.chat_id)


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class ReachabilityTests(unittest.TestCase):
    """A2: a trip that cannot be reached must say so, and say why.

    The failure this exists to end: on 2026-09-06 a provisioning run reported
    success at every level the system records — job 'succeeded', lifecycle
    'ready_private', site answering 200 — while the organizer messaging the
    bot got "I don't have a trip for this chat". Nothing disagreed with
    "ready", because nothing recorded reachability. The whole run emitted one
    log line.
    """

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def _reachability(self, trip_id: str) -> tuple[str, str | None]:
        row = self.conn.execute(
            "SELECT reachability, unreachable_reason FROM control_plane.trips WHERE id = %s",
            (trip_id,),
        ).fetchone()
        return row["reachability"], row["unreachable_reason"]

    def _with_chat(self, fix: dict) -> str:
        chat_id = "820000" + rnd(3)
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.user_identities
                     (id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at)
                   VALUES (%s, %s, 'telegram', %s, %s, now())""",
                (f"idnt_{rnd()}", fix["user_id"], sha256(chat_id), chat_id),
            )
        return chat_id

    def _cleanup(self, fix: dict) -> None:
        self.conn.rollback()
        with self.conn.transaction():
            self.conn.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (fix["trip_id"],))
            self.conn.execute(
                "DELETE FROM control_plane.user_identities WHERE user_id = %s AND provider = 'telegram'",
                (fix["user_id"],),
            )
        teardown_fixture(self.conn, fix)

    def test_a_trip_starts_unknown_rather_than_healthy(self) -> None:
        # The fail-safe default. A trip nobody has checked must not claim to
        # be reachable, and 'unknown' is distinguishable from 'unreachable' —
        # one means nobody asked, the other means we asked and the answer was
        # no.
        fix = setup_fixture(self.conn, intake=COMPANION_INTAKE)
        try:
            self.assertEqual(self._reachability(fix["trip_id"]), ("unknown", None))
        finally:
            self._cleanup(fix)

    def test_a_bound_companion_records_reachable_with_no_reason(self) -> None:
        fix = setup_fixture(self.conn, intake=FULL_NAME_ORGANIZER_INTAKE)
        chat_id = self._with_chat(fix)
        try:
            ProvisionerWorker(
                db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-reach-ok",
                companion=FakeCompanionProfileAdapter(),
            ).run_once()
            self.assertEqual(self._reachability(fix["trip_id"]), ("reachable", None))
            row = self.conn.execute(
                "SELECT chat_id FROM control_plane.telegram_chat_bindings "
                "WHERE trip_id = %s AND closed_at IS NULL", (fix["trip_id"],),
            ).fetchone()
            self.assertEqual(row["chat_id"], chat_id)
        finally:
            self._cleanup(fix)

    def test_an_unresolved_organizer_is_named_as_the_reason(self) -> None:
        # The 2026-09-06 failure exactly: assistant answers present, so there
        # IS a companion to build, but organizer_identity resolves to nobody.
        intake = {
            **FULL_NAME_ORGANIZER_INTAKE,
            "organizer_identity": {"kind": "text", "schema_version": 1, "text": "Someone Not On This Trip"},
        }
        fix = setup_fixture(self.conn, intake=intake)
        self._with_chat(fix)
        try:
            companion = FakeCompanionProfileAdapter()
            ProvisionerWorker(
                db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-reach-org",
                companion=companion,
            ).run_once()
            self.assertEqual(companion.installed, [], "no organizer, so nothing to install")
            self.assertEqual(
                self._reachability(fix["trip_id"]),
                ("unreachable", "ORGANIZER_UNRESOLVED"),
            )
        finally:
            self._cleanup(fix)

    def test_a_failing_companion_install_is_named_as_the_reason(self) -> None:
        # How B1 (no hermes/node in the worker image) presents.
        class ExplodingAdapter:
            def install(self, handoff: dict) -> str | None:
                raise RuntimeError("render_profile.py exited 127: hermes: not found")

        fix = setup_fixture(self.conn, intake=FULL_NAME_ORGANIZER_INTAKE)
        self._with_chat(fix)
        try:
            ProvisionerWorker(
                db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-reach-b1",
                companion=ExplodingAdapter(),
            ).run_once()
            self.assertEqual(
                self._reachability(fix["trip_id"]),
                ("unreachable", "COMPANION_INSTALL_FAILED"),
            )
        finally:
            self._cleanup(fix)

    def test_no_companion_adapter_is_named_rather_than_passed_over(self) -> None:
        fix = setup_fixture(self.conn, intake=FULL_NAME_ORGANIZER_INTAKE)
        self._with_chat(fix)
        try:
            ProvisionerWorker(
                db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-reach-null",
            ).run_once()
            self.assertEqual(
                self._reachability(fix["trip_id"]),
                ("unreachable", "COMPANION_TEMPLATES_ABSENT"),
            )
        finally:
            self._cleanup(fix)

    def test_a_companion_with_nobody_to_bind_to_is_named(self) -> None:
        # No telegram identity for the owner: a companion exists and cannot be
        # reached. A different retry from every other reason here — nothing is
        # broken, an organizer chat id is simply not known yet.
        fix = setup_fixture(self.conn, intake=FULL_NAME_ORGANIZER_INTAKE)
        try:
            ProvisionerWorker(
                db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-reach-nochat",
                companion=FakeCompanionProfileAdapter(),
            ).run_once()
            self.assertEqual(
                self._reachability(fix["trip_id"]),
                ("unreachable", "NO_ORGANIZER_CHAT"),
            )
        finally:
            self._cleanup(fix)

    def test_the_database_refuses_an_unreachable_trip_with_no_reason(self) -> None:
        # The invariant, enforced where it cannot be forgotten: "unreachable"
        # without a reason is the silent failure this whole change exists to
        # end, and "reachable, but here is why it is not" is incoherent.
        fix = setup_fixture(self.conn, intake=COMPANION_INTAKE)
        try:
            for reachability, reason in (("unreachable", None), ("reachable", "BINDING_FAILED")):
                with self.subTest(reachability=reachability, reason=reason):
                    with self.assertRaises(psycopg.errors.CheckViolation):
                        with self.conn.transaction():
                            self.conn.execute(
                                "UPDATE control_plane.trips SET reachability = %s, unreachable_reason = %s WHERE id = %s",
                                (reachability, reason, fix["trip_id"]),
                            )
        finally:
            self._cleanup(fix)


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class InterviewChatIsTheOrganizerChatTests(unittest.TestCase):
    """An organizer with no Telegram identity is still reachable.

    The password signup stopgap creates no telegram `user_identities` row, and
    the deep-link path deliberately does NOT write the verified chat into
    `trips.notification_chat_id_hint` (that column is for UNVERIFIED hints).
    So on 2026-09-06 a trip whose entire interview happened in chat 391627336
    finished provisioning with "no organizer chat id", an installed companion
    nobody was bound to, and reachability NO_ORGANIZER_CHAT.

    The chat was never unknown. It was in `intake_sessions.telegram_chat_id`,
    verified, the whole time.
    """

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn, intake=FULL_NAME_ORGANIZER_INTAKE)
        self.chat_id = "830000" + rnd(3)
        # An interview conducted in a known, verified chat — and an owner with
        # NO telegram identity, which is what the password stopgap produces.
        # `enrollment_id` is required but nothing here reads it; the session
        # exists only to carry the chat the interview happened in.
        self.session_id = f"sess_{rnd()}"
        self.enrollment_id = f"ienr_{rnd()}"
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.interview_enrollments
                     (id, trip_id, user_id, token_digest, state, expires_at, consumed_at)
                   VALUES (%s, %s, %s, %s, 'consumed', now() + interval '1 day', now())""",
                (self.enrollment_id, self.fix["trip_id"], self.fix["user_id"], sha256(rnd(32))),
            )
            self.conn.execute(
                """INSERT INTO control_plane.intake_sessions
                     (id, trip_id, user_id, enrollment_id, state, telegram_chat_id)
                   VALUES (%s, %s, %s, %s, 'confirmed', %s)""",
                (self.session_id, self.fix["trip_id"], self.fix["user_id"],
                 self.enrollment_id, self.chat_id),
            )

    def tearDown(self) -> None:
        self.conn.rollback()
        with self.conn.transaction():
            self.conn.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (self.fix["trip_id"],))
            self.conn.execute("DELETE FROM control_plane.intake_sessions WHERE id = %s", (self.session_id,))
            self.conn.execute("DELETE FROM control_plane.interview_enrollments WHERE id = %s", (self.enrollment_id,))
            self.conn.execute(
                "DELETE FROM control_plane.user_identities WHERE user_id = %s", (self.fix["user_id"],),
            )
        teardown_fixture(self.conn, self.fix)

    def test_the_interview_chat_binds_the_companion(self) -> None:
        companion = FakeCompanionProfileAdapter()
        ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-interview-chat",
            companion=companion,
        ).run_once()

        row = self.conn.execute(
            "SELECT chat_id, hermes_profile FROM control_plane.telegram_chat_bindings "
            "WHERE trip_id = %s AND closed_at IS NULL",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNotNone(row, "the interview's own chat should have bound the companion")
        self.assertEqual(row["chat_id"], self.chat_id)
        self.assertIsNotNone(row["hermes_profile"])

        state = self.conn.execute(
            "SELECT reachability, unreachable_reason FROM control_plane.trips WHERE id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual((state["reachability"], state["unreachable_reason"]), ("reachable", None))

    def test_a_verified_telegram_identity_still_wins(self) -> None:
        # Provenance order, not convenience: an identity on the account is a
        # stronger claim about WHO the organizer is than the chat a link was
        # opened in, so it must not be displaced by this fix.
        identity_chat = "840000" + rnd(3)
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.user_identities
                     (id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at)
                   VALUES (%s, %s, 'telegram', %s, %s, now())""",
                (f"idnt_{rnd()}", self.fix["user_id"], sha256(identity_chat), identity_chat),
            )
        try:
            ProvisionerWorker(
                db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-identity-wins",
                companion=FakeCompanionProfileAdapter(),
            ).run_once()
            row = self.conn.execute(
                "SELECT chat_id FROM control_plane.telegram_chat_bindings "
                "WHERE trip_id = %s AND closed_at IS NULL",
                (self.fix["trip_id"],),
            ).fetchone()
            self.assertEqual(row["chat_id"], identity_chat)
        finally:
            pass  # tearDown removes the identity; see its comment.


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class OrphanBindingAdoptionTests(unittest.TestCase):
    """A chat bound before the companion existed must not wait forever."""

    def setUp(self) -> None:
        self.conn = psycopg.connect(DB_URL, autocommit=True)
        self.trip_id = f"trip_{secrets.token_hex(16)}"
        self.other_trip_id = f"trip_{secrets.token_hex(16)}"
        with self.conn.cursor() as cur:
            for tid in (self.trip_id, self.other_trip_id):
                cur.execute(
                    "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES (%s, %s, 'ready_private')",
                    (tid, tid.replace("_", "-")),
                )

    def tearDown(self) -> None:
        with self.conn.cursor() as cur:
            for tid in (self.trip_id, self.other_trip_id):
                cur.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (tid,))
                cur.execute("DELETE FROM control_plane.trips WHERE id = %s", (tid,))
        self.conn.close()

    def _bind(self, chat_id: str, trip_id: str, profile: str | None) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)"
                " VALUES (%s, %s, %s, %s)",
                (f"tcb_{secrets.token_hex(16)}", chat_id, trip_id, profile),
            )

    def _profile_of(self, chat_id: str) -> str | None:
        with self.conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT hermes_profile FROM control_plane.telegram_chat_bindings"
                " WHERE chat_id = %s AND closed_at IS NULL",
                (chat_id,),
            )
            row = cur.fetchone()
            return row["hermes_profile"] if row else None

    def test_a_group_bound_before_the_companion_gets_it_afterwards(self) -> None:
        # 2026-09-07, live: the organizer bound their family group with a token
        # while the companion did not yet exist, so the row stored NULL. The
        # companion arrived twenty minutes later on a retry and bound only the
        # organizer's DM. The group answered "I'm still finishing your
        # assistant" permanently, because nothing was going to finish it there.
        self._bind("-1004305582269", self.trip_id, None)
        adopted = attach_profile_to_orphan_bindings(self.conn, self.trip_id, "companion-japan")
        self.assertEqual(adopted, 1)
        self.assertEqual(self._profile_of("-1004305582269"), "companion-japan")

    def test_a_binding_that_already_has_a_profile_is_left_alone(self) -> None:
        # Pointing at another profile is a decision, not a gap.
        self._bind("391627336", self.trip_id, "companion-existing")
        attach_profile_to_orphan_bindings(self.conn, self.trip_id, "companion-new")
        self.assertEqual(self._profile_of("391627336"), "companion-existing")

    def test_another_trip_s_orphan_is_not_adopted(self) -> None:
        # The one that would be a real leak: handing this trip's companion to a
        # chat belonging to somebody else's trip.
        self._bind("-100999", self.other_trip_id, None)
        adopted = attach_profile_to_orphan_bindings(self.conn, self.trip_id, "companion-japan")
        self.assertEqual(adopted, 0)
        self.assertIsNone(self._profile_of("-100999"))

    def test_a_closed_binding_is_not_revived(self) -> None:
        self._bind("-100888", self.trip_id, None)
        with self.conn.cursor() as cur:
            # closed_reason travels with closed_at — "closed" is a single fact,
            # and telegram_chat_bindings_closed_reason_ck enforces it (see
            # test_closed_at_and_closed_reason_cannot_disagree, which asserts
            # that a bare closed_at is rejected). Closing the row illegally here
            # raised CheckViolation before this test could assert anything.
            cur.execute(
                "UPDATE control_plane.telegram_chat_bindings "
                "SET closed_at = now(), closed_reason = 'profile_rebound' WHERE chat_id = %s",
                ("-100888",),
            )
        self.assertEqual(attach_profile_to_orphan_bindings(self.conn, self.trip_id, "companion-japan"), 0)

    def test_every_waiting_chat_is_adopted_at_once(self) -> None:
        for chat in ("-100111", "-100222", "391627336"):
            self._bind(chat, self.trip_id, None)
        self.assertEqual(attach_profile_to_orphan_bindings(self.conn, self.trip_id, "companion-japan"), 3)
