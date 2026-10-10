"""The idle-loop bridge probe (issue #119): a live trip whose trip-mcp bridge
stops reaching its trip is FOUND, recorded as a reachability fact the fleet
monitor already reads, and cleared again when it recovers — and nothing is
restarted on the way.

These hit a real PostgreSQL database (CONTROL_PLANE_TEST_DATABASE_URL, whose
name must say it is for tests) and skip without one. No SSH: the adapter is a
fake that answers by slug.
"""
from __future__ import annotations

import io
import logging
import secrets
import unittest
from typing import Any

import psycopg
from psycopg.rows import dict_row

from control_plane_worker.__main__ import LOG_FORMAT
from control_plane_worker.mcp_bridge import (
    BridgeProbeError,
    BridgeProbeSweep,
    NullMcpBridgeAdapter,
    ShellMcpBridgeAdapter,
)
from control_plane_worker.provisioner import bridge_probe_consequence, record_bridge_probe

from tests.support.test_database import test_database_url
from tests.test_provisioner import run_test_migrations

DB_URL = test_database_url()
SKIP = not DB_URL

# A stand-in for the trip's agent key. The worker never holds the real one —
# the forced command reads it beside the trip — so the only way one could reach
# a log line here is through text an adapter hands back. The tests make sure
# none of that text is repeated.
KEY = "k3y" + secrets.token_hex(24)


def rnd(n: int = 8) -> str:
    return secrets.token_hex(n)


class FakeProber:
    """Answers `probe()` from a per-slug script: True, a failure code string,
    or an exception instance. Records every call."""

    def __init__(self) -> None:
        self.answers: dict[str, Any] = {}
        self.calls: list[tuple[str, str]] = []

    def setup(self, slug: str, profile_name: str) -> bool:  # pragma: no cover - never called
        raise AssertionError("a probe sweep must never (re)wire a bridge")

    def probe(self, slug: str, profile_name: str) -> tuple[bool, str]:
        self.calls.append((slug, profile_name))
        answer = self.answers.get(slug, True)
        if isinstance(answer, BaseException):
            raise answer
        if answer is True:
            return True, "ok"
        return False, answer

    def probed(self, slug: str) -> int:
        return sum(1 for s, _ in self.calls if s == slug)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Rendered:
    """What the worker's log actually SAYS: every line under
    `control_plane_worker`, rendered through the worker's own LOG_FORMAT.

    That format prints the message and nothing else — `extra={...}` fields are
    dropped (#292) — so a fact that lives only in `extra` is a fact nobody
    reading the worker's log ever sees. Asserting against this, not against
    LogRecord attributes, is the point."""

    def __enter__(self) -> "Rendered":
        self.buf = io.StringIO()
        self.handler = logging.StreamHandler(self.buf)
        self.handler.setFormatter(logging.Formatter(LOG_FORMAT))
        self.logger = logging.getLogger("control_plane_worker")
        self.old_level = self.logger.level
        self.logger.setLevel(logging.DEBUG)
        self.logger.addHandler(self.handler)
        return self

    def __exit__(self, *_exc: object) -> None:
        self.logger.removeHandler(self.handler)
        self.logger.setLevel(self.old_level)

    @property
    def text(self) -> str:
        return self.buf.getvalue()

    def lines(self, event: str, slug: str | None = None) -> list[str]:
        return [ln for ln in self.text.splitlines()
                if f" {event} " in ln + " " and (slug is None or f"slug={slug}" in ln)]


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class BridgeProbeSweepTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row, autocommit=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.trips: list[str] = []
        self.prober = FakeProber()
        self.clock = Clock()

    def tearDown(self) -> None:
        for trip_id in self.trips:
            self.conn.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (trip_id,))
            self.conn.execute("DELETE FROM control_plane.trips WHERE id = %s", (trip_id,))

    # ── fixtures ────────────────────────────────────────────────────────────

    def trip(
        self, *, slug: str | None = None, state: str = "ready_private",
        reachability: str = "reachable", reason: str | None = None,
        profile: str | None = "__default__", closed: bool = False,
        order: int | None = None,
    ) -> dict:
        # The sweep visits trips in id order; `order` pins a position (the
        # prefix sorts before any random hex id) for tests where order matters.
        trip_id = f"trip_0000{order:03d}{rnd()}" if order is not None else f"trip_{rnd()}"
        slug = slug or f"probe-{rnd(4)}"
        self.conn.execute(
            "INSERT INTO control_plane.trips(id, slug, lifecycle_state, reachability, unreachable_reason) "
            "VALUES (%s, %s, %s, %s, %s)",
            (trip_id, slug, state, reachability, reason),
        )
        self.trips.append(trip_id)
        if profile is not None:
            self.conn.execute(
                "INSERT INTO control_plane.telegram_chat_bindings"
                "(id, chat_id, trip_id, hermes_profile, closed_at, closed_reason) "
                "VALUES (%s, %s, %s, %s, CASE WHEN %s THEN now() END, CASE WHEN %s THEN 'test_closed' END)",
                (f"tcb_{rnd()}", "8" + str(secrets.randbelow(10**9)).zfill(9), trip_id,
                 slug.replace("-", "") if profile == "__default__" else profile, closed, closed),
            )
        return {"trip_id": trip_id, "slug": slug}

    def null_profile_trip(self) -> dict:
        """A trip whose only open binding carries no companion (migration 0043)."""
        t = self.trip(profile=None)
        self.conn.execute(
            "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) "
            "VALUES (%s, %s, %s, NULL)",
            (f"tcb_{rnd()}", "8" + str(secrets.randbelow(10**9)).zfill(9), t["trip_id"]),
        )
        return t

    def state(self, t: dict) -> tuple[str, str | None, Any]:
        row = self.conn.execute(
            "SELECT reachability, unreachable_reason, reachability_checked_at FROM control_plane.trips WHERE id = %s",
            (t["trip_id"],),
        ).fetchone()
        return row["reachability"], row["unreachable_reason"], row["reachability_checked_at"]

    def sweep(self, adapter: Any = None, minutes: float = 30) -> BridgeProbeSweep:
        return BridgeProbeSweep(DB_URL, adapter if adapter is not None else self.prober,
                                interval_minutes=minutes, clock=self.clock)

    # ── (a) two consecutive failures, never one ─────────────────────────────

    def test_two_consecutive_failures_mark_a_reachable_trip_bridge_failed_and_one_does_not(self) -> None:
        t = self.trip()
        self.prober.answers[t["slug"]] = "HTTP_401"
        sweep = self.sweep()

        sweep.run()
        reach, reason, checked_first = self.state(t)
        self.assertEqual((reach, reason), ("reachable", None), "one failure is a blip, not a fact")
        self.assertIsNotNone(checked_first, "every probe stamps reachability_checked_at")

        sweep.run()
        reach, reason, checked_second = self.state(t)
        self.assertEqual((reach, reason), ("unreachable", "TRIP_MCP_BRIDGE_FAILED"))
        self.assertGreaterEqual(checked_second, checked_first)

    def test_a_success_between_failures_resets_the_count(self) -> None:
        t = self.trip()
        sweep = self.sweep()
        for answer in ("none", True, "none"):
            self.prober.answers[t["slug"]] = answer
            sweep.run()
        self.assertEqual(self.state(t)[:2], ("reachable", None))

    def test_a_probe_error_is_not_counted_as_a_failure_and_changes_nothing(self) -> None:
        # "Could not ask" (ssh down, an older host refusing the kind) is not
        # "the bridge failed": it is logged, and the trip's fact is left alone.
        t = self.trip()
        sweep = self.sweep()
        self.prober.answers[t["slug"]] = BridgeProbeError("exited 255: companion-install-host: no topology")
        with Rendered() as log:
            sweep.run()
            sweep.run()
        self.assertEqual(self.state(t), ("reachable", None, None), "not stamped either: nothing was learned")
        errors = log.lines("provisioner.bridge_probe_error", t["slug"])
        self.assertEqual(len(errors), 2, log.text)
        self.assertIn("companion-install-host: no topology", errors[0], "the safe reason is in the text")

    def test_a_bridge_older_than_health_is_never_marked_failed(self) -> None:
        # Its mcp.js predates /health (#127): it cannot be verified, which is
        # not the same as broken. Said loudly, recorded as nothing.
        t = self.trip()
        self.prober.answers[t["slug"]] = "NO_HEALTH_ROUTE"
        sweep = self.sweep()
        with Rendered() as log:
            for _ in range(3):
                sweep.run()
        self.assertEqual(self.state(t), ("reachable", None, None))
        unverifiable = log.lines("provisioner.bridge_probe_unverifiable", t["slug"])
        self.assertEqual(len(unverifiable), 3, log.text)
        self.assertIn("code=NO_HEALTH_ROUTE", unverifiable[0])
        self.assertIn("restart-bridges", unverifiable[0])

    # ── F5: "two failed verdicts with no successful verdict between them" ──

    def test_could_not_ask_between_two_failures_does_not_reset_the_count(self) -> None:
        # A flapping ssh must not be able to hide a persistently failing trip:
        # an error neither counts nor resets, so fail, error, fail MARKS.
        t = self.trip()
        sweep = self.sweep()
        for answer in ("HTTP_401", BridgeProbeError("exited 255: ssh"), "HTTP_401"):
            self.prober.answers[t["slug"]] = answer
            sweep.run()
        self.assertEqual(self.state(t)[:2], ("unreachable", "TRIP_MCP_BRIDGE_FAILED"))

    def test_an_unverifiable_verdict_between_two_failures_does_not_reset_the_count(self) -> None:
        t = self.trip()
        sweep = self.sweep()
        for answer in ("none", "NO_HEALTH_ROUTE", "none"):
            self.prober.answers[t["slug"]] = answer
            sweep.run()
        self.assertEqual(self.state(t)[:2], ("unreachable", "TRIP_MCP_BRIDGE_FAILED"))

    def test_a_success_between_two_failures_does_reset_it(self) -> None:
        t = self.trip()
        sweep = self.sweep()
        for answer in ("HTTP_401", True, "HTTP_401"):
            self.prober.answers[t["slug"]] = answer
            sweep.run()
        self.assertEqual(self.state(t)[:2], ("reachable", None))

    # ── F4: a dead companion host must not stall job pickup ────────────────

    def test_three_could_not_ask_in_a_row_abort_the_rest_of_the_sweep_once(self) -> None:
        trips = [self.trip(order=i) for i in range(6)]
        for t in trips:
            self.prober.answers[t["slug"]] = BridgeProbeError("bridge probe over ssh timed out after 45s")
        sweep = self.sweep()
        with Rendered() as log:
            summary = sweep.maybe_run()
        self.assertEqual([self.prober.probed(t["slug"]) for t in trips], [1, 1, 1, 0, 0, 0])
        aborted = log.lines("provisioner.bridge_probe_sweep_aborted")
        self.assertEqual(len(aborted), 1, log.text)
        self.assertIn(f"last_slug={trips[2]['slug']}", aborted[0])
        self.assertIn("timed out after 45s", aborted[0])
        self.assertIn("skipped=3", aborted[0])
        self.assertEqual(summary["aborted"], 1)
        # Nothing was learned about any of them, so nothing is recorded.
        self.assertEqual({self.state(t) for t in trips}, {("reachable", None, None)})
        # And the NEXT interval tries again from the start.
        self.clock.now += 31 * 60
        sweep.maybe_run()
        self.assertEqual(self.prober.probed(trips[0]["slug"]), 2)

    def test_a_verdict_between_errors_restarts_the_breaker_count(self) -> None:
        answers = [BridgeProbeError("x"), BridgeProbeError("x"), True, BridgeProbeError("x"),
                   "NO_HEALTH_ROUTE", BridgeProbeError("x"), BridgeProbeError("x")]
        trips = [self.trip(order=i) for i in range(len(answers))]
        for t, answer in zip(trips, answers):
            self.prober.answers[t["slug"]] = answer
        self.sweep().run()
        self.assertEqual([self.prober.probed(t["slug"]) for t in trips], [1] * len(answers))

    def test_the_sweep_connection_cannot_wait_forever_on_a_lock(self) -> None:
        # A held row lock on a trip must fail one statement, not park the only
        # thread that picks up provisioning jobs.
        self.assertEqual(BridgeProbeSweep.STATEMENT_TIMEOUT_MS, 5000)
        with self.sweep()._connect() as conn:
            self.assertEqual(conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"], "5s")

    def test_a_locked_trip_row_times_out_instead_of_stalling_the_loop(self) -> None:
        t = self.trip(reachability="unreachable", reason="TRIP_MCP_BRIDGE_FAILED")
        holder = psycopg.connect(DB_URL, autocommit=False)
        try:
            holder.execute("SELECT 1 FROM control_plane.trips WHERE id = %s FOR UPDATE", (t["trip_id"],))
            with Rendered() as log:
                summary = self.sweep().run()
            self.assertGreaterEqual(summary["write_failed"], 1)
            failed = log.lines("provisioner.reachability_write_failed", t["slug"])
            self.assertEqual(len(failed), 1, log.text)
        finally:
            holder.rollback()
            holder.close()
        self.assertEqual(self.state(t)[:2], ("unreachable", "TRIP_MCP_BRIDGE_FAILED"), "nothing half-written")

    def test_a_restart_of_the_worker_starts_the_count_again(self) -> None:
        # The counter is in memory on purpose: a deploy restarts the bridges and
        # the worker together, and one failure straddling it must not flip a trip.
        t = self.trip()
        self.prober.answers[t["slug"]] = "none"
        self.sweep().run()
        self.sweep().run()
        self.assertEqual(self.state(t)[:2], ("reachable", None))

    # ── (b) a failure never overwrites a different reason ──────────────────

    def test_a_failure_never_overwrites_another_reason(self) -> None:
        for reason in ("NO_ORGANIZER_CHAT", "BINDING_REFUSED", "COMPANION_INSTALL_FAILED", "ORGANIZER_UNRESOLVED"):
            with self.subTest(reason=reason):
                t = self.trip(reachability="unreachable", reason=reason)
                self.prober.answers[t["slug"]] = "HTTP_401"
                sweep = self.sweep()
                for _ in range(3):
                    sweep.run()
                reach, kept, checked = self.state(t)
                self.assertEqual((reach, kept), ("unreachable", reason))
                self.assertIsNotNone(checked)

    def test_a_failure_does_not_claim_an_unknown_trip(self) -> None:
        # 'unknown' is the fail-safe default (migration 0042); a probe has no
        # standing to decide it — only the provisioning path does.
        t = self.trip(reachability="unknown")
        self.prober.answers[t["slug"]] = "none"
        sweep = self.sweep()
        sweep.run()
        sweep.run()
        self.assertEqual(self.state(t)[:2], ("unknown", None))

    # ── (c) success clears only TRIP_MCP_BRIDGE_FAILED ──────────────────────

    def test_a_success_clears_a_bridge_failure(self) -> None:
        t = self.trip(reachability="unreachable", reason="TRIP_MCP_BRIDGE_FAILED")
        self.sweep().run()
        self.assertEqual(self.state(t)[:2], ("reachable", None))

    def test_a_success_clears_nothing_else(self) -> None:
        for reachability, reason in (("unreachable", "NO_ORGANIZER_CHAT"), ("unreachable", "BINDING_REFUSED"),
                                     ("unreachable", "TRIP_RETIRED"), ("unknown", None)):
            with self.subTest(reason=reason):
                t = self.trip(reachability=reachability, reason=reason)
                self.sweep().run()
                reach, kept, checked = self.state(t)
                self.assertEqual((reach, kept), (reachability, reason))
                self.assertIsNotNone(checked)

    def test_the_whole_cycle_fail_fail_recover(self) -> None:
        t = self.trip()
        sweep = self.sweep()
        self.prober.answers[t["slug"]] = "EHOSTUNREACH"
        sweep.run()
        sweep.run()
        self.assertEqual(self.state(t)[:2], ("unreachable", "TRIP_MCP_BRIDGE_FAILED"))
        self.prober.answers[t["slug"]] = True
        sweep.run()
        self.assertEqual(self.state(t)[:2], ("reachable", None))

    # ── (d) off means off ──────────────────────────────────────────────────

    def test_the_null_adapter_probes_nothing(self) -> None:
        self.trip()
        sweep = self.sweep(NullMcpBridgeAdapter())
        self.assertFalse(sweep.enabled)
        self.assertIsNone(sweep.maybe_run())

    def test_the_local_shell_adapter_probes_nothing(self) -> None:
        sweep = self.sweep(ShellMcpBridgeAdapter(deploy_root="/nowhere", vmid_map={}))
        self.assertFalse(sweep.enabled)
        self.assertIsNone(sweep.maybe_run())

    def test_an_interval_of_zero_probes_nothing(self) -> None:
        t = self.trip()
        sweep = self.sweep(minutes=0)
        self.assertFalse(sweep.enabled)
        self.clock.now += 10 ** 6
        self.assertIsNone(sweep.maybe_run())
        self.assertEqual(self.prober.probed(t["slug"]), 0)

    def test_it_runs_at_most_once_per_interval(self) -> None:
        t = self.trip()
        sweep = self.sweep(minutes=30)
        self.assertIsNotNone(sweep.maybe_run(), "the first idle poll after start sweeps")
        self.clock.now += 29 * 60
        self.assertIsNone(sweep.maybe_run())
        self.clock.now += 61
        self.assertIsNotNone(sweep.maybe_run())
        self.assertEqual(self.prober.probed(t["slug"]), 2)

    def test_a_stop_request_ends_the_sweep_between_trips(self) -> None:
        a, b = self.trip(), self.trip()
        self.sweep().run(should_stop=lambda: True)
        self.assertEqual(self.prober.probed(a["slug"]) + self.prober.probed(b["slug"]), 0)

    # ── (e) only live trips with a companion behind an open binding ────────

    def test_retired_dead_and_companionless_trips_are_not_probed(self) -> None:
        live = self.trip()
        retired = self.trip(slug=f"retired-probe-{rnd(3)}-20260920")
        not_live = self.trip(state="provisioning_approved")
        closed = self.trip(closed=True)
        no_binding = self.trip(profile=None)
        companionless = self.null_profile_trip()
        self.sweep().run()
        self.assertEqual(self.prober.probed(live["slug"]), 1)
        for t in (retired, not_live, closed, no_binding, companionless):
            with self.subTest(slug=t["slug"]):
                self.assertEqual(self.prober.probed(t["slug"]), 0)
                self.assertIsNone(self.state(t)[2], "a trip that was not probed is not stamped")

    def test_a_trip_with_two_open_bindings_is_probed_once_with_the_newest_profile(self) -> None:
        t = self.trip(profile="older-profile")
        self.conn.execute(
            "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile, created_at) "
            "VALUES (%s, %s, %s, 'newer-profile', now() + interval '1 minute')",
            (f"tcb_{rnd()}", "-100" + str(secrets.randbelow(10**9)), t["trip_id"]),
        )
        self.sweep().run()
        self.assertEqual([c for c in self.prober.calls if c[0] == t["slug"]], [(t["slug"], "newer-profile")])

    # ── (g) no key in any log line; the alert names the repair ─────────────

    def test_no_key_in_any_log_line_and_the_alert_names_the_repair(self) -> None:
        t = self.trip()
        errored = self.trip()
        self.prober.answers[t["slug"]] = "HTTP_401"
        # An adapter that let text through would be the only route a key has
        # into this process's logs. Neither exception shape may be repeated.
        self.prober.answers[errored["slug"]] = RuntimeError(f"MCP_API_KEY={KEY}")
        sweep = self.sweep()
        with self.assertLogs(level=logging.DEBUG) as cm, Rendered() as log:
            sweep.run()
            sweep.run()
        everything = "\n".join(cm.output) + "\n".join(str(r.__dict__) for r in cm.records) + log.text
        self.assertNotIn(KEY, everything)

        marked = log.lines("provisioner.trip_unreachable", t["slug"])
        self.assertEqual(len(marked), 1, "one alert when the fact changes, not one per sweep")
        self.assertTrue(marked[0].startswith("WARNING "), marked[0])
        for fact in ("reason=TRIP_MCP_BRIDGE_FAILED", "code=HTTP_401", f"trip_id={t['trip_id']}",
                     f"--reconcile-companion {t['trip_id']}", "kinerary-cp-release restart-bridges",
                     f"trips/{t['slug']}/trip.env"):
            self.assertIn(fact, marked[0])

        failures = log.lines("provisioner.bridge_probe_failed", t["slug"])
        self.assertEqual(len(failures), 2, "every failed probe is a line carrying its code")
        self.assertTrue(all(ln.startswith("WARNING ") and "code=HTTP_401" in ln for ln in failures), failures)
        self.assertIn("failed_verdicts=1/2", failures[0])
        self.assertIn("failed_verdicts=2/2", failures[1])
        # The unexpected exception is named by class only.
        self.assertIn("error=RuntimeError", log.lines("provisioner.bridge_probe_error", errored["slug"])[0])

    def test_ehostunreach_is_not_described_as_a_key_mismatch(self) -> None:
        # CLAUDE.md: EHOSTUNREACH is the Mac's Local Network grant (staging
        # only). Telling an operator to chase a key would send them the wrong way.
        t = self.trip()
        self.prober.answers[t["slug"]] = "EHOSTUNREACH"
        sweep = self.sweep()
        with Rendered() as log:
            sweep.run()
            sweep.run()
        marked = log.lines("provisioner.trip_unreachable", t["slug"])[0]
        self.assertIn("Local Network", marked)
        self.assertNotIn("key mismatch", marked.lower())

    # ── F1: every new line says its facts in the text the worker emits ─────

    def test_every_new_line_carries_slug_and_code_in_the_rendered_text(self) -> None:
        failing = self.trip(order=0)
        unverifiable = self.trip(order=1)
        erroring = self.trip(order=2)
        recovering = self.trip(order=3, reachability="unreachable", reason="TRIP_MCP_BRIDGE_FAILED")
        self.prober.answers[failing["slug"]] = "ECONNREFUSED"
        self.prober.answers[unverifiable["slug"]] = "NO_HEALTH_ROUTE"
        self.prober.answers[erroring["slug"]] = BridgeProbeError(
            "bridge probe over ssh exited 2: companion-install-host: no topology for x on this host")
        sweep = self.sweep()
        with Rendered() as log:
            sweep.run()
            sweep.run()
        text = log.text
        self.assertNotIn(KEY, text)

        failed = log.lines("provisioner.bridge_probe_failed", failing["slug"])
        self.assertTrue(failed and all("code=ECONNREFUSED" in ln for ln in failed), text)
        mark = log.lines("provisioner.trip_unreachable", failing["slug"])
        self.assertEqual(len(mark), 1, text)
        self.assertIn("code=ECONNREFUSED", mark[0])
        self.assertIn("check the site first", mark[0], "a site outage names the site, not the bridge")

        unv = log.lines("provisioner.bridge_probe_unverifiable", unverifiable["slug"])
        self.assertTrue(unv and "code=NO_HEALTH_ROUTE" in unv[0], text)

        err = log.lines("provisioner.bridge_probe_error", erroring["slug"])
        self.assertTrue(err and "no topology for x on this host" in err[0], text)

        clear = log.lines("provisioner.trip_reachable", recovering["slug"])
        self.assertEqual(len(clear), 1, text)
        self.assertIn("cleared=TRIP_MCP_BRIDGE_FAILED", clear[0])

        summaries = log.lines("provisioner.bridge_probe_sweep")
        self.assertEqual(len(summaries), 2, text)
        for fact in ("probed=", "ok=", "failed=", "errors=", "unverifiable=", "marked=", "cleared="):
            self.assertIn(fact, summaries[0])
        self.assertIn("marked=1", summaries[1])


class RecordWriteFailureTests(unittest.TestCase):
    """The recorder never raises, and says so in text when it cannot write."""

    def test_a_write_failure_is_a_rendered_line_with_the_slug(self) -> None:
        class Broken:
            def transaction(self):
                raise psycopg.OperationalError("canceling statement due to statement timeout")

        with Rendered() as log:
            outcome = record_bridge_probe(Broken(), "trip_x", ok=False, code="none", confirmed=True, slug="some-trip")
        self.assertEqual(outcome, "write_failed")
        line = log.lines("provisioner.reachability_write_failed", "some-trip")
        self.assertEqual(len(line), 1, log.text)
        self.assertIn("trip_id=trip_x", line[0])


class ConsequenceByCodeTests(unittest.TestCase):
    """F3: the repair the alert names depends on WHICH hop failed. /health
    fetches the trip site through the bridge, so a dead site fails it too —
    and restarting a live companion's bridge does not fix a dead site."""

    def text(self, code: str) -> str:
        return bridge_probe_consequence(code, "trip_abc", "some-trip")

    def test_a_key_mismatch_names_the_re_wire_and_the_stale_trip_env(self) -> None:
        for code in ("HTTP_401", "HTTP_403"):
            with self.subTest(code=code):
                t = self.text(code)
                self.assertIn("key", t)
                self.assertIn("kinerary-cp-release restart-bridges", t)
                self.assertIn("python -m control_plane_worker provision --reconcile-companion trip_abc", t)
                self.assertIn("trips/some-trip/trip.env", t)
                self.assertLess(t.index("restart-bridges"), t.index("--reconcile-companion"),
                                "restart-bridges first, re-wire from scratch second")

    def test_a_site_that_did_not_answer_sends_the_operator_to_the_site(self) -> None:
        for code in ("ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH",
                     "UND_ERR_CONNECT_TIMEOUT", "HTTP_502", "HTTP_503"):
            with self.subTest(code=code):
                t = self.text(code)
                self.assertIn("did not answer through the bridge", t)
                self.assertIn("check the site first", t)
                self.assertIn("restarting the bridge will not fix a dead site", t)
                self.assertNotIn("--reconcile-companion", t)
                self.assertNotIn("kinerary-cp-release restart-bridges", t)

    def test_ehostunreach_keeps_the_mac_local_network_wording(self) -> None:
        t = self.text("EHOSTUNREACH")
        self.assertIn("Local Network", t)
        self.assertIn("setup-mcp.sh --restart-only --trip-dir ./trips/some-trip", t)
        self.assertNotIn("key mismatch", t.lower())

    def test_a_dead_bridge_says_the_bridge_is_not_answering(self) -> None:
        t = self.text("none")
        self.assertIn("bridge did not answer", t)
        self.assertIn("kinerary-cp-release restart-bridges", t)
        self.assertNotIn("check the site first", t)

    def test_the_remaining_codes_name_themselves(self) -> None:
        for code in ("NO_KEY", "BRIDGE_401", "UNRECOGNIZED", "HTTP_404"):
            with self.subTest(code=code):
                self.assertIn(code, self.text(code))


if __name__ == "__main__":
    unittest.main()
