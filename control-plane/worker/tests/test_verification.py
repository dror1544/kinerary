"""The verification aggregator (Sprint 6, docs/sprint6-tracks.md:472): the
gate before `ready_private` that `control_plane.verification_evidence` had
never had a writer for.

Pure logic (the HTTP-based checks, mcp_isolation, backup_checkpoint) is
tested with fakes and needs no database. Everything that reads/writes
PostgreSQL (release_compatibility, messaging_binding, record_evidence,
gate_ready_private, and the full ProvisionerWorker integration) hits a real
one via CONTROL_PLANE_TEST_DATABASE_URL and skips without it — same rule as
test_provisioner.py.
"""
from __future__ import annotations

import json
import secrets
import unittest

import psycopg
from psycopg.rows import dict_row

from control_plane_worker import verification
from control_plane_worker.mcp_bridge import BridgeProbeError
from control_plane_worker.provisioner import ProvisionerWorker

from tests.support.test_database import test_database_url
from tests.test_provisioner import (
    COMPANION_INTAKE,
    FakeCompanionProfileAdapter,
    FakeDeployAdapter,
    rnd,
    run_test_migrations,
    setup_fixture,
    sha256,
    teardown_fixture,
)

DB_URL = test_database_url()
SKIP = not DB_URL


# ── Pure logic: no database ─────────────────────────────────────────────────

class FakeGet:
    """A canned HTTP transport: `url -> (status, body)`, with a default of
    404 for anything not registered. Records every call."""

    def __init__(self) -> None:
        self.responses: dict[str, tuple[int, str]] = {}
        self.raises: dict[str, Exception] = {}
        self.calls: list[str] = []

    def set(self, suffix: str, status: int, body: str) -> None:
        self.responses[suffix] = (status, body)

    def set_raises(self, suffix: str, exc: Exception) -> None:
        self.raises[suffix] = exc

    def __call__(self, url: str) -> tuple[int, str]:
        self.calls.append(url)
        for suffix, exc in self.raises.items():
            if url.endswith(suffix):
                raise exc
        for suffix, response in self.responses.items():
            if url.endswith(suffix):
                return response
        return 404, "not found"


class EvidenceDigestTests(unittest.TestCase):
    def test_shape_matches_the_table_check_constraint(self) -> None:
        digest = verification.evidence_digest("anything")
        self.assertRegex(digest, r"^sha256:[a-f0-9]{64}$")

    def test_is_deterministic(self) -> None:
        self.assertEqual(verification.evidence_digest("x"), verification.evidence_digest("x"))

    def test_differs_for_different_evidence(self) -> None:
        self.assertNotEqual(verification.evidence_digest("x"), verification.evidence_digest("y"))


class RetryingTests(unittest.TestCase):
    """#review 2026-10-03: found live — a hard gate probing a freshly
    deployed site the instant deploy() returns, with no grace period, can
    mistake ordinary DNS/NPM/Cloudflare propagation lag for a broken
    deployment. These test `_retrying` in isolation, with a fake sleep that
    never actually sleeps — the real `time.sleep` default is for production,
    not tests."""

    def test_a_passing_result_on_the_first_try_never_retries_or_sleeps(self) -> None:
        calls = []
        sleeps = []
        def check() -> verification.CheckResult:
            calls.append(1)
            return verification.CheckResult("x", "passed", "ok")
        result = verification._retrying(check, attempts=5, delay_s=10.0, sleep=sleeps.append)
        self.assertEqual(result.outcome, "passed")
        self.assertEqual(len(calls), 1)
        self.assertEqual(sleeps, [])

    def test_a_skipped_result_never_retries_either(self) -> None:
        calls = []
        def check() -> verification.CheckResult:
            calls.append(1)
            return verification.CheckResult("x", "skipped", "no reason to ask")
        result = verification._retrying(check, attempts=5, delay_s=10.0, sleep=lambda s: None)
        self.assertEqual(result.outcome, "skipped")
        self.assertEqual(len(calls), 1)

    def test_a_failure_that_recovers_on_a_later_attempt_passes(self) -> None:
        outcomes = iter(["failed", "failed", "passed"])
        sleeps = []
        def check() -> verification.CheckResult:
            return verification.CheckResult("x", next(outcomes), "evidence")
        result = verification._retrying(check, attempts=5, delay_s=7.5, sleep=sleeps.append)
        self.assertEqual(result.outcome, "passed")
        self.assertEqual(sleeps, [7.5, 7.5], "slept once before each retry, not before the first or last call")

    def test_a_failure_that_never_recovers_is_reported_as_failed_after_the_full_budget(self) -> None:
        calls = []
        def check() -> verification.CheckResult:
            calls.append(1)
            return verification.CheckResult("x", "failed", f"attempt {len(calls)}")
        result = verification._retrying(check, attempts=4, delay_s=1.0, sleep=lambda s: None)
        self.assertEqual(result.outcome, "failed")
        self.assertEqual(len(calls), 4, "exactly the requested number of attempts, no more")

    def test_attempts_1_is_the_old_unretried_behavior(self) -> None:
        calls = []
        def check() -> verification.CheckResult:
            calls.append(1)
            return verification.CheckResult("x", "failed", "nope")
        result = verification._retrying(check)  # every default
        self.assertEqual(result.outcome, "failed")
        self.assertEqual(len(calls), 1)


class RuntimeHealthCheckTests(unittest.TestCase):
    def test_passes_on_ok_true(self) -> None:
        get = FakeGet()
        get.set("/api/health", 200, '{"ok": true}')
        result = verification.check_runtime_health(get, "https://trip.example")
        self.assertEqual(result.outcome, "passed")
        self.assertEqual(result.check_name, verification.RUNTIME_HEALTH)
        self.assertIn("ok", result.evidence)

    def test_fails_on_ok_false(self) -> None:
        get = FakeGet()
        get.set("/api/health", 200, '{"ok": false}')
        result = verification.check_runtime_health(get, "https://trip.example")
        self.assertEqual(result.outcome, "failed")

    def test_fails_on_non_200(self) -> None:
        get = FakeGet()
        get.set("/api/health", 503, "service unavailable")
        result = verification.check_runtime_health(get, "https://trip.example")
        self.assertEqual(result.outcome, "failed")
        self.assertIn("503", result.evidence)

    def test_fails_on_non_json_body(self) -> None:
        get = FakeGet()
        get.set("/api/health", 200, "<html>not json</html>")
        result = verification.check_runtime_health(get, "https://trip.example")
        self.assertEqual(result.outcome, "failed")

    def test_fails_when_the_get_raises(self) -> None:
        get = FakeGet()
        get.set_raises("/api/health", ConnectionRefusedError("no route to host"))
        result = verification.check_runtime_health(get, "https://trip.example")
        self.assertEqual(result.outcome, "failed")
        self.assertIn("ConnectionRefusedError", result.evidence)

    def test_fails_with_no_private_url(self) -> None:
        get = FakeGet()
        result = verification.check_runtime_health(get, None)
        self.assertEqual(result.outcome, "failed")
        self.assertEqual(get.calls, [])

    def test_probes_the_exact_health_route(self) -> None:
        get = FakeGet()
        get.set("/api/health", 200, '{"ok": true}')
        verification.check_runtime_health(get, "https://trip.example/")
        self.assertEqual(get.calls, ["https://trip.example/api/health"])


class RenderedDataCheckTests(unittest.TestCase):
    def test_passes_on_non_empty_roster(self) -> None:
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"participants": [{"username": "a"}]}))
        result = verification.check_rendered_data(get, "https://trip.example")
        self.assertEqual(result.outcome, "passed")

    def test_fails_on_empty_roster(self) -> None:
        """The exact "empty/broken shell" the brief calls out — a 200 with
        no real content must not read as success."""
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"participants": []}))
        result = verification.check_rendered_data(get, "https://trip.example")
        self.assertEqual(result.outcome, "failed")

    def test_fails_on_missing_participants_key(self) -> None:
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"unexpected": True}))
        result = verification.check_rendered_data(get, "https://trip.example")
        self.assertEqual(result.outcome, "failed")

    def test_fails_on_non_200(self) -> None:
        get = FakeGet()
        get.set("/api/config/roster", 500, "boom")
        result = verification.check_rendered_data(get, "https://trip.example")
        self.assertEqual(result.outcome, "failed")

    def test_passes_when_the_roster_matches_the_expected_usernames(self) -> None:
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"participants": [{"username": "tali"}, {"username": "ron"}]}))
        result = verification.check_rendered_data(get, "https://trip.example", frozenset({"tali", "ron"}))
        self.assertEqual(result.outcome, "passed")

    def test_fails_when_the_roster_belongs_to_a_different_trip(self) -> None:
        """#review 2026-10-03 [P2]: a nonempty roster alone used to pass this
        check even when it was some OTHER trip's roster — a misrouted
        private_url serving the wrong container would pass both this and
        runtime_health. Caught now by comparing against the deploy's own
        expected usernames."""
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"participants": [{"username": "someone_else"}]}))
        result = verification.check_rendered_data(get, "https://trip.example", frozenset({"tali", "ron"}))
        self.assertEqual(result.outcome, "failed")
        self.assertIn("roster mismatch", result.evidence)

    def test_a_nonempty_roster_still_passes_with_no_expected_usernames_to_compare(self) -> None:
        """An empty expected_usernames (no participant with a username at
        all) skips the identity comparison rather than failing every such
        trip retroactively -- the plain nonempty check still applies."""
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"participants": [{"username": "a"}]}))
        result = verification.check_rendered_data(get, "https://trip.example", frozenset())
        self.assertEqual(result.outcome, "passed")

    def test_passes_when_departure_and_return_date_both_match(self) -> None:
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"participants": [{"username": "tali"}]}))
        get.set(
            "/api/config/deployment-identity", 200,
            json.dumps({"departure": "2027-03-10T06:00:00+03:00", "returnDate": "2027-03-20"}),
        )
        result = verification.check_rendered_data(
            get, "https://trip.example", frozenset({"tali"}),
            expected_departure="2027-03-10T06:00:00+03:00", expected_return_date="2027-03-20",
        )
        self.assertEqual(result.outcome, "passed")

    def test_fails_when_the_matching_roster_belongs_to_a_sibling_trip_for_the_same_family(self) -> None:
        """#review 2026-10-03 [P2], round 2: a SECOND trip for the same
        family can share its roster exactly -- round 1's username comparison
        alone would pass against the wrong trip. departure/returnDate cannot
        collide between two distinct real trips for one family."""
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"participants": [{"username": "tali"}]}))
        get.set(
            "/api/config/deployment-identity", 200,
            json.dumps({"departure": "2028-07-01T06:00:00+03:00", "returnDate": "2028-07-10"}),
        )
        result = verification.check_rendered_data(
            get, "https://trip.example", frozenset({"tali"}),
            expected_departure="2027-03-10T06:00:00+03:00", expected_return_date="2027-03-20",
        )
        self.assertEqual(result.outcome, "failed")
        self.assertIn("deployment identity mismatch", result.evidence)

    def test_still_passes_with_no_expected_dates_to_compare(self) -> None:
        """Matching round 1's own fallback: expected_departure/
        expected_return_date both None skips this half of the comparison
        rather than failing retroactively."""
        get = FakeGet()
        get.set("/api/config/roster", 200, json.dumps({"participants": [{"username": "tali"}]}))
        result = verification.check_rendered_data(get, "https://trip.example", frozenset({"tali"}))
        self.assertEqual(result.outcome, "passed")


class DefaultHttpGetTests(unittest.TestCase):
    def test_refuses_non_http_schemes(self) -> None:
        with self.assertRaises(ValueError):
            verification.default_http_get("file:///etc/passwd")


class McpIsolationCheckTests(unittest.TestCase):
    def test_skipped_with_no_companion_profile(self) -> None:
        result = verification.check_mcp_isolation(object(), "slug", None)
        self.assertEqual(result.outcome, "skipped")

    def test_skipped_when_adapter_cannot_probe(self) -> None:
        class NoProbe:
            def setup(self, slug: str, profile: str) -> bool:
                return True

        result = verification.check_mcp_isolation(NoProbe(), "slug", "profile")
        self.assertEqual(result.outcome, "skipped")

    def test_skipped_when_the_probe_could_not_be_asked(self) -> None:
        class Prober:
            def probe(self, slug: str, profile: str) -> tuple[bool, str]:
                raise BridgeProbeError("ssh timed out")

        result = verification.check_mcp_isolation(Prober(), "slug", "profile")
        self.assertEqual(result.outcome, "skipped")

    def test_passed_on_ok_verdict(self) -> None:
        class Prober:
            def probe(self, slug: str, profile: str) -> tuple[bool, str]:
                return True, "ok"

        result = verification.check_mcp_isolation(Prober(), "slug", "profile")
        self.assertEqual(result.outcome, "passed")

    def test_failed_on_a_real_failure_verdict(self) -> None:
        class Prober:
            def probe(self, slug: str, profile: str) -> tuple[bool, str]:
                return False, "EHOSTUNREACH"

        result = verification.check_mcp_isolation(Prober(), "slug", "profile")
        self.assertEqual(result.outcome, "failed")
        self.assertIn("EHOSTUNREACH", result.evidence)


class BackupCheckpointCheckTests(unittest.TestCase):
    def test_is_always_an_honest_skip(self) -> None:
        """No per-trip backup mechanism exists in this codebase — see
        verification.py's module docstring. This must never silently become
        a fabricated `passed`."""
        result = verification.check_backup_checkpoint()
        self.assertEqual(result.outcome, "skipped")
        self.assertEqual(result.check_name, verification.BACKUP_CHECKPOINT)


# ── Database-backed: release_compatibility, messaging_binding, recording ───

@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class ReleaseCompatibilityCheckTests(unittest.TestCase):
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
        self.conn.rollback()
        teardown_fixture(self.conn, self.fix)

    def test_passes_for_an_available_release(self) -> None:
        result = verification.check_release_compatibility(
            self.conn, {"release_id": self.fix["release_id"]},
        )
        self.assertEqual(result.outcome, "passed")

    def test_fails_for_a_deprecated_release(self) -> None:
        with self.conn.transaction():
            self.conn.execute(
                "UPDATE control_plane.releases SET status = 'deprecated' WHERE id = %s",
                (self.fix["release_id"],),
            )
        result = verification.check_release_compatibility(
            self.conn, {"release_id": self.fix["release_id"]},
        )
        self.assertEqual(result.outcome, "failed")
        self.assertIn("deprecated", result.evidence)

    def test_fails_for_a_retired_release(self) -> None:
        with self.conn.transaction():
            self.conn.execute(
                "UPDATE control_plane.releases SET status = 'retired' WHERE id = %s",
                (self.fix["release_id"],),
            )
        result = verification.check_release_compatibility(
            self.conn, {"release_id": self.fix["release_id"]},
        )
        self.assertEqual(result.outcome, "failed")

    def test_skipped_with_no_release_id_on_the_plan(self) -> None:
        result = verification.check_release_compatibility(self.conn, {})
        self.assertEqual(result.outcome, "skipped")

    def test_fails_for_a_release_id_that_does_not_exist(self) -> None:
        result = verification.check_release_compatibility(
            self.conn, {"release_id": "rls_" + rnd()},
        )
        self.assertEqual(result.outcome, "failed")


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class MessagingBindingCheckTests(unittest.TestCase):
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
        self.conn.rollback()
        teardown_fixture(self.conn, self.fix)

    def test_skipped_with_no_binding_attempted(self) -> None:
        result = verification.check_messaging_binding(self.conn, self.fix["trip_id"])
        self.assertEqual(result.outcome, "skipped")

    def test_failed_when_a_binding_reason_was_recorded(self) -> None:
        with self.conn.transaction():
            self.conn.execute(
                "UPDATE control_plane.trips SET reachability = 'unreachable', "
                "unreachable_reason = 'NO_ORGANIZER_CHAT' WHERE id = %s",
                (self.fix["trip_id"],),
            )
        result = verification.check_messaging_binding(self.conn, self.fix["trip_id"])
        self.assertEqual(result.outcome, "failed")

    def test_passed_with_an_open_binding(self) -> None:
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.telegram_chat_bindings
                     (id, chat_id, trip_id, hermes_profile)
                   VALUES (%s, %s, %s, 'tal')""",
                (f"tcb_{rnd()}", "800000001", self.fix["trip_id"]),
            )
        try:
            result = verification.check_messaging_binding(self.conn, self.fix["trip_id"])
            # check_messaging_binding only reads, but a read still leaves the
            # connection "in transaction" under manual commit — close it
            # before the next write, or that write becomes a savepoint inside
            # a transaction tearDown's rollback() would undo instead of
            # persisting.
            self.conn.commit()
            self.assertEqual(result.outcome, "passed")
        finally:
            with self.conn.transaction():
                self.conn.execute(
                    "DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s",
                    (self.fix["trip_id"],),
                )


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class RecordEvidenceTests(unittest.TestCase):
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
        self.conn.rollback()
        teardown_fixture(self.conn, self.fix)

    def test_writes_one_row_per_result_including_failures(self) -> None:
        """The whole reason verification_evidence exists: a failure is
        recorded, never swallowed."""
        results = [
            verification.CheckResult("a", "passed", "ev-a"),
            verification.CheckResult("b", "failed", "ev-b"),
            verification.CheckResult("c", "skipped", "ev-c"),
        ]
        verification.record_evidence(
            self.conn, trip_id=self.fix["trip_id"], deployment_ref="rev123", results=results,
        )
        rows = self.conn.execute(
            "SELECT check_name, outcome, evidence_digest, deployment_ref "
            "FROM control_plane.verification_evidence WHERE trip_id = %s ORDER BY check_name",
            (self.fix["trip_id"],),
        ).fetchall()
        self.assertEqual(len(rows), 3)
        self.assertEqual([r["outcome"] for r in rows], ["passed", "failed", "skipped"])
        for row in rows:
            self.assertRegex(row["evidence_digest"], r"^sha256:[a-f0-9]{64}$")
            self.assertEqual(row["deployment_ref"], "rev123")


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class GateReadyPrivateTests(unittest.TestCase):
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
        self.conn.rollback()
        teardown_fixture(self.conn, self.fix)

    def _get(self, health_ok: bool = True, roster: list | None = None) -> FakeGet:
        get = FakeGet()
        if health_ok:
            get.set("/api/health", 200, '{"ok": true}')
        else:
            get.set("/api/health", 503, '{"ok": false}')
        get.set("/api/config/roster", 200, json.dumps({"participants": roster if roster is not None else [{"username": "a"}]}))
        return get

    def test_passes_and_records_six_rows_when_the_three_hard_checks_pass(self) -> None:
        verification.gate_ready_private(
            self.conn, trip_id=self.fix["trip_id"], deployment_ref="rev1",
            plan_desired={"release_id": self.fix["release_id"]},
            private_url="https://trip.example", http_get=self._get(),
        )
        rows = self.conn.execute(
            "SELECT check_name, outcome FROM control_plane.verification_evidence WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchall()
        self.assertEqual({r["check_name"] for r in rows}, set(verification.CHECK_NAMES))
        outcomes = {r["check_name"]: r["outcome"] for r in rows}
        self.assertEqual(outcomes[verification.RELEASE_COMPATIBILITY], "passed")
        self.assertEqual(outcomes[verification.RUNTIME_HEALTH], "passed")
        self.assertEqual(outcomes[verification.RENDERED_DATA], "passed")
        self.assertEqual(outcomes[verification.MCP_ISOLATION], "skipped")
        self.assertEqual(outcomes[verification.MESSAGING_BINDING], "skipped")
        self.assertEqual(outcomes[verification.BACKUP_CHECKPOINT], "skipped")

    def test_retries_a_site_that_becomes_healthy_partway_through_the_budget(self) -> None:
        """#review 2026-10-03: found live — a freshly deployed, genuinely
        healthy trip can fail runtime_health/rendered_data on nothing but
        ordinary external DNS/NPM/Cloudflare propagation lag if probed the
        instant deploy() returns. This simulates exactly that: unhealthy for
        the first two attempts, healthy on the third — the gate must pass,
        not fail, and must record the FINAL (passing) evidence."""
        # health_calls counts ONLY /api/health calls — the roster call
        # check_rendered_data also makes through the same `get` shares no
        # state with this, and always succeeds immediately, so it must not
        # perturb the count this test's math depends on.
        health_calls = {"n": 0}
        def get(url: str) -> tuple[int, str]:
            if url.endswith("/api/health"):
                health_calls["n"] += 1
                # Unhealthy for the first two attempts, healthy on the third.
                return (200, '{"ok": true}') if health_calls["n"] >= 3 else (503, '{"ok": false}')
            return 200, json.dumps({"participants": [{"username": "a"}]})
        sleeps: list[float] = []
        verification.gate_ready_private(
            self.conn, trip_id=self.fix["trip_id"], deployment_ref="rev1",
            plan_desired={"release_id": self.fix["release_id"]},
            private_url="https://trip.example", http_get=get,
            retry_attempts=4, retry_delay_s=2.0, sleep=sleeps.append,
        )
        self.assertEqual(health_calls["n"], 3, "stopped retrying the instant it passed, not exhausting all 4 attempts")
        self.assertEqual(sleeps, [2.0, 2.0], "slept once before each retry, never after the attempt that finally passed")
        rows = self.conn.execute(
            "SELECT outcome FROM control_plane.verification_evidence "
            "WHERE trip_id = %s AND check_name = %s",
            (self.fix["trip_id"], verification.RUNTIME_HEALTH),
        ).fetchall()
        self.assertEqual([r["outcome"] for r in rows], ["passed"], "the recorded evidence is the final, passing attempt")

    def test_still_fails_when_the_site_never_recovers_within_the_retry_budget(self) -> None:
        get = self._get(health_ok=False)
        sleeps: list[float] = []
        with self.assertRaises(verification.VerificationFailed):
            verification.gate_ready_private(
                self.conn, trip_id=self.fix["trip_id"], deployment_ref="rev1",
                plan_desired={"release_id": self.fix["release_id"]},
                private_url="https://trip.example", http_get=get,
                retry_attempts=3, retry_delay_s=1.0, sleep=sleeps.append,
            )
        self.assertEqual(sleeps, [1.0, 1.0], "a hard gate that never recovers still fails, after the full budget")
        self.assertEqual(len([c for c in get.calls if c.endswith("/api/health")]), 3)

    def test_raises_and_still_records_evidence_when_release_is_deprecated(self) -> None:
        with self.conn.transaction():
            self.conn.execute(
                "UPDATE control_plane.releases SET status = 'deprecated' WHERE id = %s",
                (self.fix["release_id"],),
            )
        with self.assertRaises(verification.VerificationFailed) as ctx:
            verification.gate_ready_private(
                self.conn, trip_id=self.fix["trip_id"], deployment_ref="rev1",
                plan_desired={"release_id": self.fix["release_id"]},
                private_url="https://trip.example", http_get=self._get(),
            )
        self.assertEqual(ctx.exception.safe_error_code, "VERIFICATION_FAILED")
        rows = self.conn.execute(
            "SELECT check_name, outcome FROM control_plane.verification_evidence WHERE trip_id = %s",
            (self.fix["trip_id"],),
        ).fetchall()
        outcomes = {r["check_name"]: r["outcome"] for r in rows}
        self.assertEqual(outcomes[verification.RELEASE_COMPATIBILITY], "failed")

    def test_raises_when_the_site_health_check_fails(self) -> None:
        with self.assertRaises(verification.VerificationFailed):
            verification.gate_ready_private(
                self.conn, trip_id=self.fix["trip_id"], deployment_ref="rev1",
                plan_desired={"release_id": self.fix["release_id"]},
                private_url="https://trip.example", http_get=self._get(health_ok=False),
            )

    def test_raises_when_rendered_data_is_an_empty_shell(self) -> None:
        with self.assertRaises(verification.VerificationFailed):
            verification.gate_ready_private(
                self.conn, trip_id=self.fix["trip_id"], deployment_ref="rev1",
                plan_desired={"release_id": self.fix["release_id"]},
                private_url="https://trip.example", http_get=self._get(roster=[]),
            )

    def test_never_raises_on_the_three_signals_that_are_not_hard_gated(self) -> None:
        """mcp_isolation, messaging_binding and backup_checkpoint are always
        `skipped` at this point in the pipeline (see verification.py) — that
        must never block a trip that is otherwise healthy."""
        try:
            verification.gate_ready_private(
                self.conn, trip_id=self.fix["trip_id"], deployment_ref="rev1",
                plan_desired={"release_id": self.fix["release_id"]},
                private_url="https://trip.example", http_get=self._get(),
            )
        except verification.VerificationFailed as exc:  # pragma: no cover
            self.fail(f"unexpected hard-gate failure: {exc.failures}")


# ── Full ProvisionerWorker integration ──────────────────────────────────────

@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class ProvisionerVerificationIntegrationTests(unittest.TestCase):
    """The gate wired into `_work_claimed_job`/`_complete`/`_attach_companion`
    — not just the aggregator module in isolation."""

    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def tearDown(self) -> None:
        self.conn.rollback()
        teardown_fixture(self.conn, self.fix)

    def _evidence(self, trip_id: str) -> dict[str, str]:
        rows = self.conn.execute(
            "SELECT check_name, outcome FROM control_plane.verification_evidence WHERE trip_id = %s",
            (trip_id,),
        ).fetchall()
        return {r["check_name"]: r["outcome"] for r in rows}

    def test_happy_path_still_reaches_ready_private_and_writes_six_rows(self) -> None:
        """FakeDeployAdapter's own `http_get` is what makes the default
        happy-path tests in test_provisioner.py keep working unmodified —
        this test exercises that exact wiring directly."""
        self.fix = setup_fixture(self.conn)
        worker = ProvisionerWorker(db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-verify-happy")
        worker.run_once()

        trip = self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(trip["lifecycle_state"], "ready_private")

        outcomes = self._evidence(self.fix["trip_id"])
        self.assertEqual(len(outcomes), len(verification.CHECK_NAMES))
        self.assertEqual(outcomes[verification.RELEASE_COMPATIBILITY], "passed")
        self.assertEqual(outcomes[verification.RUNTIME_HEALTH], "passed")
        self.assertEqual(outcomes[verification.RENDERED_DATA], "passed")

        row = self.conn.execute(
            "SELECT deployment_ref FROM control_plane.verification_evidence "
            "WHERE trip_id = %s AND check_name = %s",
            (self.fix["trip_id"], verification.RELEASE_COMPATIBILITY),
        ).fetchone()
        self.assertEqual(row["deployment_ref"], self.fix["release_id"])

    def test_a_deprecated_release_blocks_ready_private_and_fails_the_job(self) -> None:
        self.fix = setup_fixture(self.conn)
        with self.conn.transaction():
            self.conn.execute(
                "UPDATE control_plane.releases SET status = 'deprecated' WHERE id = %s",
                (self.fix["release_id"],),
            )
        # Exhaust retries so the outcome is terminal within one run_once().
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()

        worker = ProvisionerWorker(db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-verify-deprecated")
        worker.run_once()

        trip = self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],),
        ).fetchone()
        self.assertNotEqual(trip["lifecycle_state"], "ready_private")

        job = self.conn.execute(
            "SELECT state, safe_error_code FROM control_plane.jobs WHERE id = %s", (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["safe_error_code"], "VERIFICATION_FAILED")

        # The deploy DID happen (that is how a bad release is caught post-
        # deploy, same posture as every other check here) and the evidence
        # for it is on record even though the job failed.
        outcomes = self._evidence(self.fix["trip_id"])
        self.assertEqual(outcomes[verification.RELEASE_COMPATIBILITY], "failed")

    def test_an_unhealthy_site_blocks_ready_private(self) -> None:
        self.fix = setup_fixture(self.conn)
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()

        # verification_retry_attempts=1: this test is about the gate
        # blocking ready_private on a genuinely unhealthy site, not about
        # the retry budget itself (RetryingTests and
        # GateReadyPrivateTests.test_still_fails_when_the_site_never_recovers
        # cover that directly) — without this override it would wait
        # through the real ~60s production retry budget for real.
        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(health_ok=False), worker_id="test-verify-unhealthy",
            verification_retry_attempts=1,
        )
        worker.run_once()

        trip = self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],),
        ).fetchone()
        self.assertNotEqual(trip["lifecycle_state"], "ready_private")
        job = self.conn.execute(
            "SELECT safe_error_code FROM control_plane.jobs WHERE id = %s", (self.fix["job_id"],),
        ).fetchone()
        self.assertEqual(job["safe_error_code"], "VERIFICATION_FAILED")

    def test_an_empty_roster_blocks_ready_private_but_health_still_passes(self) -> None:
        self.fix = setup_fixture(self.conn)
        self.conn.execute(
            "UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE id = %s",
            (self.fix["job_id"],),
        )
        self.conn.commit()

        # Same reasoning as test_an_unhealthy_site_blocks_ready_private above.
        worker = ProvisionerWorker(
            db_url=DB_URL, deploy=FakeDeployAdapter(roster_participants=[]), worker_id="test-verify-empty",
            verification_retry_attempts=1,
        )
        worker.run_once()

        outcomes = self._evidence(self.fix["trip_id"])
        self.assertEqual(outcomes[verification.RUNTIME_HEALTH], "passed")
        self.assertEqual(outcomes[verification.RENDERED_DATA], "failed")
        trip = self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],),
        ).fetchone()
        self.assertNotEqual(trip["lifecycle_state"], "ready_private")

    def test_post_attach_evidence_is_recorded_for_a_bound_companion_trip(self) -> None:
        """mcp_isolation/messaging_binding get REAL evidence once
        `_attach_companion` has actually run — not just the pre-gate skip."""
        self.fix = setup_fixture(self.conn, intake=COMPANION_INTAKE)
        identity_id = f"idnt_{rnd()}"
        chat_id = "8" + str(secrets.randbelow(10**9)).zfill(9)
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO control_plane.user_identities
                     (id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at)
                   VALUES (%s, %s, 'telegram', %s, %s, now())""",
                (identity_id, self.fix["user_id"], sha256(chat_id), chat_id),
            )
        try:
            worker = ProvisionerWorker(
                db_url=DB_URL, deploy=FakeDeployAdapter(), worker_id="test-verify-companion",
                companion=FakeCompanionProfileAdapter(),
            )
            worker.run_once()

            outcomes = self._evidence(self.fix["trip_id"])
            # A real chat binding was opened -> passed, not the pre-attach skip.
            self.assertEqual(outcomes[verification.MESSAGING_BINDING], "passed")
            # No MCP bridge adapter configured (NullMcpBridgeAdapter, the
            # default) -> cannot probe -> an honest skip, never a fabricated
            # pass.
            self.assertEqual(outcomes[verification.MCP_ISOLATION], "skipped")

            trip = self.conn.execute(
                "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],),
            ).fetchone()
            self.assertEqual(trip["lifecycle_state"], "ready_private")
        finally:
            self.conn.rollback()
            with self.conn.transaction():
                self.conn.execute("DELETE FROM control_plane.trip_person_links WHERE trip_id = %s", (self.fix["trip_id"],))
                self.conn.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (self.fix["trip_id"],))
                self.conn.execute("DELETE FROM control_plane.user_identities WHERE id = %s", (identity_id,))

    def test_a_trip_already_ready_private_before_this_existed_is_untouched(self) -> None:
        """Backward compatibility: nothing here sweeps or re-checks a trip
        that reached `ready_private` the old way (no plan/job ever run
        through `_complete`). Its lifecycle_state and its (nonexistent)
        evidence rows must stay exactly as they were."""
        self.fix = setup_fixture(self.conn)
        with self.conn.transaction():
            self.conn.execute(
                "UPDATE control_plane.trips SET lifecycle_state = 'ready_private' WHERE id = %s",
                (self.fix["trip_id"],),
            )
        rows = self.conn.execute(
            "SELECT 1 FROM control_plane.verification_evidence WHERE trip_id = %s", (self.fix["trip_id"],),
        ).fetchall()
        self.assertEqual(rows, [])
        trip = self.conn.execute(
            "SELECT lifecycle_state FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],),
        ).fetchone()
        self.assertEqual(trip["lifecycle_state"], "ready_private")
