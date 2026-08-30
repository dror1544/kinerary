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

    def deploy(
        self,
        slug: str,
        config: dict[str, Any],
        *,
        first_provision: bool = False,
        sidecars: dict[str, Any] | None = None,
    ) -> str:
        if self._fail:
            exc = RuntimeError("simulated deploy failure")
            exc.safe_error_code = self._error_code  # type: ignore[attr-defined]
            raise exc
        self.deployed.append({
            "slug": slug, "config": config, "first_provision": first_provision,
            "sidecars": sidecars or {},
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
    first_provision: bool | None = None,
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

    def test_no_binding_written_when_the_companion_adapter_declines(self) -> None:
        class DecliningAdapter:
            def install(self, handoff: dict) -> str | None:
                return None

        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-companion-decline",
            companion=DecliningAdapter(),
        )
        worker.run_once()
        row = self.conn.execute(
            "SELECT 1 FROM control_plane.telegram_chat_bindings WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNone(row)

    def test_default_null_adapter_skips_companion_profile_without_error(self) -> None:
        worker = ProvisionerWorker(db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-companion-default")
        result = worker.run_once()
        self.assertTrue(result)
        row = self.conn.execute(
            "SELECT 1 FROM control_plane.telegram_chat_bindings WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchone()
        self.assertIsNone(row)

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
            # Both derive from the same Japan intake, so one takes the suffix.
            self.assertTrue(any(s.endswith("-2") for s in slugs), slugs)
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
