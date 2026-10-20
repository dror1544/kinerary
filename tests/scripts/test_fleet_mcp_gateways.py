"""fleet-mcp.mjs — what the monitor can say about companion gateways (#349).

"Stopped on purpose" and "broken" must never read the same. The control plane
decides which companion gateways run and records it (migration
20261021100000); the monitor reads the record. These tests pin the two halves:

  * rendering and degradation, from rows handed to a stand-in `psql`, like
    test_fleet_mcp.py: a stack a schema behind degrades, an empty record says
    so rather than saying nothing, and the alert text for a healthy fleet is
    byte-for-byte what it was before this existed;
  * the SELECTION — which rows are DORMANT, BROKEN, STRAY ... — against a real
    PostgreSQL (CONTROL_PLANE_TEST_DATABASE_URL, whose name must say it is for
    tests), because a fake psql never evaluates SQL and the health CASE is
    where "broken" and "on purpose" are told apart. Skipped without one.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from tests.scripts import test_fleet_mcp as base

ROOT = Path(__file__).resolve().parents[2]
SERVER = base.SERVER
NODE = base.NODE
MIGRATIONS = ROOT / "control-plane" / "db" / "migrations"

#: Rows for the gateway queries, by a marker unique to each. They come BEFORE the
#: generic ones, because the first marker found in a statement answers it.
SWEEP = "ORDER BY e.occurred_at DESC LIMIT 1;"
HEALTH = "GROUP BY 1,2,3 ORDER BY 1,2,3"
ATTENTION_OVERVIEW = "SELECT x.name, x.cls, x.health"
ATTENTION_ALERTS = "SELECT x.name, x.health, x.reason"
SILENT = "HAVING count(*) > 0"
DETAIL = "SELECT x.health, x.desired, x.reason"
DETAIL_EVENTS = "ge.event <> 'SWEEP'"


def with_gateways(*extra: list) -> list:
    """The pinned fixtures of test_fleet_mcp.py, on a stack that HAS the table."""
    return [*extra, *[f for f in base.FIXTURES if "companion_gateways" not in f[0]]]


@unittest.skipUnless(NODE, "node is not installed")
class GatewayRendering(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.log = self.tmp / "sql.log"
        fake = self.tmp / "fake-psql.py"
        fake.write_text(base.FAKE_PSQL)
        fake.chmod(0o755)
        self.config = self.tmp / "fleet-stacks.json"
        self.config.write_text(json.dumps({"default_stack": "prod", "stacks": {
            "prod": {"label": "a control plane", "production": True,
                     "argv": [shutil.which("python3") or "python3", str(fake)]}}}))

    def tool(self, name: str, arguments: dict | None = None, fixtures: list | None = None) -> tuple[str, bool]:
        path = self.tmp / "fixtures.json"
        path.write_text(json.dumps(base.FIXTURES if fixtures is None else fixtures))
        stdin = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": {"name": name, "arguments": arguments or {}}}) + "\n"
        proc = subprocess.run([NODE, str(SERVER)], input=stdin, capture_output=True, text=True, timeout=60,
                              env={**os.environ, "KINERARY_FLEET_CONFIG": str(self.config),
                                   "FLEET_TEST_SQL_LOG": str(self.log), "FLEET_TEST_FIXTURES": str(path)})
        result = json.loads(proc.stdout.splitlines()[0])["result"]
        return result["content"][0]["text"], bool(result.get("isError"))

    def statements(self) -> list[str]:
        raw = [s.strip() for s in self.log.read_text().split("\n\x00\n") if s.strip()] if self.log.exists() else []
        return [re.sub(r"--[^\n]*", "", s) for s in raw]

    # ---- a stack a schema behind, and a stack where nothing was recorded ------

    def test_a_stack_behind_the_migration_says_nothing_new_and_asks_nothing_new(self) -> None:
        for tool in ("fleet_overview", "alerts", "trip_detail"):
            self.log.unlink(missing_ok=True)
            text, is_error = self.tool(tool, {"trip": "japan-2026"} if tool == "trip_detail" else {})
            self.assertFalse(is_error, text)
            self.assertNotIn("GATEWAY", text.upper().replace("GATEWAYS ", ""), tool)
            self.assertEqual([s for s in self.statements() if "companion_gateway" in s and "to_regclass" not in s],
                             [], f"{tool} queried a table this stack does not have")

    def test_an_empty_record_is_said_not_omitted(self) -> None:
        text, is_error = self.tool("fleet_overview", fixtures=with_gateways())
        self.assertFalse(is_error, text)
        self.assertIn("COMPANION GATEWAYS", text)
        self.assertIn("no sweep has ever been recorded", text)
        digest, _ = self.tool("fleet_overview", {"format": "digest"}, fixtures=with_gateways())
        self.assertIn("**Companion gateways**", digest)
        self.assertIn("never recorded a sweep", digest)
        base.FleetMcp.assert_telegram_safe(self, digest)  # type: ignore[arg-type]

    def test_alerts_stay_byte_identical_when_the_record_exists_and_nothing_is_wrong(self) -> None:
        # Hermes hashes the alerts bytes: a table that exists but has no
        # problem rows must not change a character of the text.
        text, is_error = self.tool("alerts", fixtures=with_gateways())
        self.assertFalse(is_error, text)
        self.assertEqual(text, base.TEXT_ALERTS)
        digest, _ = self.tool("alerts", {"format": "digest"}, fixtures=with_gateways())
        self.assertEqual(digest, base.DIGEST_ALERTS)

    # ---- the overview ---------------------------------------------------------

    def overview_fixtures(self) -> list:
        return with_gateways(
            [SWEEP, [["observe", "ok", "3"]]],
            [HEALTH, [["live", "RUNNING", "CURRENT_TRIP", "2"], ["live", "DORMANT", "NOT_CURRENT", "3"],
                      ["live", "DORMANT", "ARCHIVED", "4"], ["live", "PENDING_STOP", "ARCHIVED", "1"],
                      ["live", "BROKEN", "CURRENT_TRIP", "1"], ["retired", "DORMANT", "RETIRED", "30"],
                      ["retired", "STRAY", "RETIRED", "1"]]],
            [ATTENTION_OVERVIEW, [["trip-a", "live", "BROKEN", "CURRENT_TRIP", "stopped", "3"],
                                  ["old-trip", "retired", "STRAY", "RETIRED", "running", "0"]]],
        )

    def test_the_overview_counts_health_names_the_reasons_and_lists_what_needs_attention(self) -> None:
        text, is_error = self.tool("fleet_overview", fixtures=self.overview_fixtures())
        self.assertFalse(is_error, text)
        section = text.split("COMPANION GATEWAYS")[1]
        self.assertIn("reconciler: observe, last sweep 3 min ago (ok)", section)
        self.assertIn("health: RUNNING=2, DORMANT=7, PENDING_STOP=1, BROKEN=1, STRAY=1", section,
                      "test debris (retired) is not counted as a healthy fleet, but a stray gateway is")
        self.assertIn("dormant because: NOT_CURRENT=3, ARCHIVED=4", section)
        self.assertIn("NEEDS ATTENTION", section)
        self.assertIn("trip-a | BROKEN | CURRENT_TRIP | stopped | 3", section)
        self.assertIn("old-trip | STRAY | RETIRED | running | 0", section)
        self.assertIn("'dormant' is stopped on purpose, 'broken' is not", section)

    def test_a_stale_reconciler_says_so_next_to_the_numbers_it_made_stale(self) -> None:
        fx = with_gateways([SWEEP, [["observe", "host_unreachable", "95"]]])
        text, _ = self.tool("fleet_overview", fixtures=fx)
        self.assertIn("last sweep 95 min ago (host_unreachable) — STALE: nothing below is current", text)

    def test_the_overview_digest_is_one_message_without_boxes(self) -> None:
        text, is_error = self.tool("fleet_overview", {"format": "digest"}, fixtures=self.overview_fixtures())
        self.assertFalse(is_error, text)
        section = text.split("**Companion gateways**")[1]
        self.assertIn("reconciler: observe, last sweep 3 min ago (ok)", section)
        self.assertIn("2 running · 7 dormant · 1 pending_stop · 1 broken · 1 stray", section)
        self.assertIn("⚠️ trip-a: broken", section)
        self.assertIn("⚠️ old-trip: stray", section)
        base.FleetMcp.assert_telegram_safe(self, text)  # type: ignore[arg-type]

    # ---- the alerts -----------------------------------------------------------

    def test_a_gateway_that_should_be_up_and_is_not_is_an_alert_and_a_dormant_one_never_is(self) -> None:
        fx = with_gateways([ATTENTION_ALERTS, [
            ["trip-a", "BROKEN", "CURRENT_TRIP", "stopped", "0"],
            ["trip-b", "BROKEN", "CURRENT_TRIP", "absent", "3"],
            ["old-1", "STRAY", "RETIRED", "running", "0"],
            ["trip-c", "DUPLICATE", "CURRENT_TRIP", "duplicate", "0"]]])
        text, is_error = self.tool("alerts", fixtures=fx)
        self.assertFalse(is_error, text)
        self.assertIn("COMPANION GATEWAY\n"
                      "  • trip-a — companion gateway is down but should be running (CURRENT_TRIP): the host reports it stopped\n"
                      "  • trip-b — companion gateway is down but should be running (CURRENT_TRIP): the host reports it absent; "
                      "3 start attempt(s) failed\n"
                      "  • old-1 — a gateway is still running although this trip was torn down (RETIRED)\n"
                      "  • trip-c — two independent gateway processes are running for one companion", text)
        digest, _ = self.tool("alerts", {"format": "digest"}, fixtures=fx)
        self.assertIn("• companion gateway: trip-a — companion gateway is down but should be running", digest)
        base.FleetMcp.assert_telegram_safe(self, digest)  # type: ignore[arg-type]
        # What the alert query asks for is the needs-attention set and nothing else.
        sql = next(s for s in self.statements() if ATTENTION_ALERTS in s)
        self.assertIn("IN ('BROKEN','STRAY','DUPLICATE')", sql)
        for quiet in ("DORMANT", "PENDING_STOP", "RUNNING", "STARTING", "UNOBSERVED"):
            self.assertNotIn(f"x.health = '{quiet}'", sql)
            self.assertNotIn(f"IN ('{quiet}'", sql)

    def test_a_silent_reconciler_is_an_alert_with_a_fixed_time(self) -> None:
        text, _ = self.tool("alerts", fixtures=with_gateways([SILENT, [["2026-10-21 08:05 UTC"]]]))
        self.assertIn("GATEWAY RECONCILER SILENT\n  • no good sweep since 2026-10-21 08:05 UTC; "
                      "the gateway health reported by this tool is stale", text)
        sql = next(s for s in self.statements() if SILENT in s)
        self.assertNotIn("now()", sql.split("FROM")[0], "alerts must not print a moving value")

    def test_a_reconciler_that_never_had_a_good_sweep_says_that_not_since_never(self) -> None:
        text, _ = self.tool("alerts", fixtures=with_gateways([SILENT, [["never"]]]))
        self.assertIn("no good sweep has ever completed (the host may not understand the status request yet)", text)
        self.assertNotIn("since never", text)
        digest, _ = self.tool("alerts", {"format": "digest"}, fixtures=with_gateways([SILENT, [["never"]]]))
        self.assertIn("gateway reconciler silent: no good sweep has ever completed; gateway health is stale", digest)

    def test_alert_queries_read_a_fixed_set_of_closed_columns(self) -> None:
        self.tool("alerts", fixtures=with_gateways())
        self.tool("fleet_overview", fixtures=with_gateways())
        self.tool("trip_detail", {"trip": "japan-2026"}, fixtures=with_gateways())
        joined = "\n".join(s for s in self.statements() if "companion_gateway" in s)
        self.assertIn("control_plane.companion_gateways", joined)
        self.assertNotRegex(joined, r"SELECT \*", "a column list, so the grant list can be exact")
        self.assertNotIn("telegram_chat_bindings", joined, "the monitor never needs a chat id for this")

    def test_a_failing_gateway_query_is_an_error_never_an_empty_answer(self) -> None:
        text, is_error = self.tool("fleet_overview", fixtures=with_gateways(
            [HEALTH, 'ERROR:  permission denied for table companion_gateways']))
        self.assertTrue(is_error)
        self.assertIn("permission denied", text)

    # ---- trip detail ----------------------------------------------------------

    HEAD = ["trip_x", "japan-2026", "live", "ready_private", "reachable", "-", "Japan", "Tokyo", "-", "-",
            "2026-09-01 10:00", "not built yet"]

    def test_trip_detail_says_what_was_decided_what_the_host_said_and_what_changed(self) -> None:
        fx = with_gateways(
            ["coalesce(t.destination_label,'-')", [self.HEAD]],
            [DETAIL, [["DORMANT", "stopped", "ARCHIVED", "stopped", "0", "2026-10-21 08:00 UTC", "-",
                       "stop ok", "10-21 08:05 UTC", "0", "-", "10-21 08:10 UTC"]]],
            [DETAIL_EVENTS, [["10-21 08:05 UTC", "ACTION", "-", "-", "-", "stop", "ok", "-"],
                             ["10-21 08:00 UTC", "DECIDED", "stopped", "ARCHIVED", "-", "-", "-", "-"]]],
        )
        text, is_error = self.tool("trip_detail", {"trip": "japan-2026"}, fixtures=fx)
        self.assertFalse(is_error, text)
        section = text.split("COMPANION GATEWAY")[1]
        self.assertIn("dormant = stopped on purpose, broken = should be up and is not", section)
        self.assertIn("DORMANT | stopped | ARCHIVED | stopped (0)", section)
        self.assertIn("10-21 08:05 UTC | ACTION | - | - | - | stop | ok | -", section)

    def test_a_trip_with_no_decision_yet_says_so(self) -> None:
        text, _ = self.tool("trip_detail", {"trip": "japan-2026"},
                            fixtures=with_gateways(["coalesce(t.destination_label,'-')", [self.HEAD]]))
        self.assertIn("(no decision recorded for this trip yet)", text)


# ── the selection, against a real PostgreSQL ──────────────────────────────────

REAL_PSQL = """#!/usr/bin/env python3
import os, sys
import psycopg
sql = sys.stdin.read()
with psycopg.connect(os.environ["FLEET_TEST_DB"], autocommit=True) as conn:
    conn.execute("SET default_transaction_read_only = on")
    try:
        cur = conn.execute(sql)
    except Exception as exc:
        sys.stderr.write("ERROR:  %s\\n" % exc)
        sys.exit(1)
    if cur.description:
        for row in cur.fetchall():
            cells = ["" if v is None else ("t" if v is True else "f" if v is False else str(v)) for v in row]
            sys.stdout.write("\\x1f".join(cells) + "\\n")
"""


def _db_url() -> str | None:
    url = os.environ.get("CONTROL_PLANE_TEST_DATABASE_URL")
    if not url:
        return None
    name = url.rsplit("/", 1)[-1].lower()
    if "test" not in name:
        raise RuntimeError("CONTROL_PLANE_TEST_DATABASE_URL does not name a scratch database")
    return url


try:
    import psycopg  # noqa: F401
    HAVE_PSYCOPG = True
except ImportError:  # pragma: no cover - the plain tests/scripts environment
    HAVE_PSYCOPG = False


@unittest.skipUnless(NODE and HAVE_PSYCOPG and _db_url(), "needs node, psycopg and CONTROL_PLANE_TEST_DATABASE_URL")
class GatewayHealthAgainstPostgres(unittest.TestCase):
    """Rows in, health out: the CASE that tells a stopped-on-purpose gateway
    from a broken one, evaluated by the database that will run it."""

    @classmethod
    def setUpClass(cls) -> None:
        import psycopg
        cls.url = _db_url()
        cls.conn = psycopg.connect(cls.url, autocommit=True)
        cls.conn.execute("CREATE TABLE IF NOT EXISTS public.control_plane_schema_migrations "
                         "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        for sql_file in sorted(MIGRATIONS.glob("*.sql")):
            if cls.conn.execute("SELECT 1 FROM public.control_plane_schema_migrations WHERE version = %s",
                                (sql_file.name,)).fetchone():
                continue
            with cls.conn.transaction():
                cls.conn.execute(sql_file.read_text(encoding="utf-8"))
                cls.conn.execute("INSERT INTO public.control_plane_schema_migrations(version) VALUES (%s)",
                                 (sql_file.name,))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        fake = self.tmp / "psql.py"
        fake.write_text(REAL_PSQL)
        fake.chmod(0o755)
        self.config = self.tmp / "fleet-stacks.json"
        self.config.write_text(json.dumps({"default_stack": "t", "stacks": {
            "t": {"label": "test stack", "argv": [sys.executable, str(fake)]}}}))
        self.trips: list[str] = []
        self.conn.execute("DELETE FROM control_plane.companion_gateway_events WHERE event = 'SWEEP'")

    def tearDown(self) -> None:
        for trip_id in self.trips:
            self.conn.execute("DELETE FROM control_plane.companion_gateway_events WHERE trip_id = %s", (trip_id,))
            self.conn.execute("DELETE FROM control_plane.companion_gateways WHERE trip_id = %s", (trip_id,))
            self.conn.execute("DELETE FROM control_plane.trips WHERE id = %s", (trip_id,))
        self.conn.execute("DELETE FROM control_plane.companion_gateway_events WHERE event = 'SWEEP'")

    def tool(self, name: str, arguments: dict | None = None) -> str:
        stdin = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": {"name": name, "arguments": arguments or {}}}) + "\n"
        proc = subprocess.run([NODE, str(SERVER)], input=stdin, capture_output=True, text=True, timeout=120,
                              env={**os.environ, "KINERARY_FLEET_CONFIG": str(self.config),
                                   "FLEET_TEST_DB": self.url})
        result = json.loads(proc.stdout.splitlines()[0])["result"]
        self.assertFalse(result.get("isError"), result["content"][0]["text"])
        return result["content"][0]["text"]

    def sweep(self, *, ago_minutes: int = 1, result: str = "ok") -> None:
        self.conn.execute(
            "INSERT INTO control_plane.companion_gateway_events(event, occurred_at, mode, result, profiles, actions) "
            "VALUES ('SWEEP', now() - make_interval(mins => %s), 'observe', %s, 1, 0)", (ago_minutes, result))

    def gateway(self, label: str, *, desired: str, reason: str, observed: str | None, failures: int = 0,
                decided_ago: int = 60, slug: str | None = None, stopped_ok: bool = False,
                last_action: str | None = None, last_result: str | None = None) -> str:
        """`stopped_ok` is the shorthand for "the reconciler stopped it and the
        host confirmed": a successful stop on record."""
        if stopped_ok:
            last_action, last_result = "stop", "ok"
        trip_id = f"trip_{uuid.uuid4().hex[:12]}"
        slug = slug or f"gwh-{label}-{uuid.uuid4().hex[:4]}"
        self.conn.execute("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES (%s, %s, 'planned')",
                          (trip_id, slug))
        self.trips.append(trip_id)
        self.conn.execute(
            "INSERT INTO control_plane.companion_gateways(hermes_profile, trip_id, kind, desired, reason, observed, "
            "observed_count, failures, decided_at, observed_at, last_action, last_action_at, last_result) "
            "VALUES (%s, %s, 'companion', %s, %s, %s, %s, %s, now() - make_interval(mins => %s), "
            "CASE WHEN %s::text IS NULL THEN NULL ELSE now() END, %s, "
            "CASE WHEN %s::text IS NULL THEN NULL ELSE now() END, %s)",
            (f"gwh{uuid.uuid4().hex[:10]}", trip_id, desired, reason, observed,
             None if observed is None else (0 if observed in ("stopped", "absent") else 1), failures, decided_ago,
             observed, last_action, last_action, last_result))
        return slug

    def health_of(self, slug: str) -> str:
        text = self.tool("trip_detail", {"trip": slug})
        row = text.split("COMPANION GATEWAY")[1].split("\n")[2]
        return row.split("|")[0].strip()

    def test_each_health_class_is_told_apart(self) -> None:
        self.sweep()
        cases = {
            "RUNNING": dict(desired="running", reason="CURRENT_TRIP", observed="running"),
            "DORMANT": dict(desired="stopped", reason="ARCHIVED", observed="stopped", stopped_ok=True),
            "DORMANT-absent": dict(desired="stopped", reason="RETIRED", observed="absent", stopped_ok=True),
            # decided, never stopped by the reconciler (observe mode): NOT dormant
            "PENDING_STOP-never-stopped": dict(desired="stopped", reason="NOT_CURRENT", observed="stopped"),
            "PENDING_STOP-failed-stop": dict(desired="stopped", reason="NOT_CURRENT", observed="stopped",
                                             last_action="stop", last_result="failed"),
            "PENDING_STOP-came-back": dict(desired="stopped", reason="NOT_CURRENT", observed="running",
                                           stopped_ok=True),
            "PENDING_STOP-stopped-then-started": dict(desired="stopped", reason="NOT_CURRENT", observed="stopped",
                                                      last_action="start", last_result="ok"),
            "PENDING_STOP-hold": dict(desired="running", reason="QUIET_WINDOW", observed="stopped", decided_ago=120),
            "PENDING_STOP": dict(desired="stopped", reason="ARCHIVED", observed="running"),
            "STRAY": dict(desired="stopped", reason="RETIRED", observed="running"),
            "STRAY-teardown": dict(desired="stopped", reason="TEARDOWN", observed="running"),
            "DUPLICATE": dict(desired="running", reason="CURRENT_TRIP", observed="duplicate"),
            "BROKEN": dict(desired="running", reason="CURRENT_TRIP", observed="stopped", decided_ago=20),
            "BROKEN-absent": dict(desired="running", reason="CURRENT_TRIP", observed="absent", decided_ago=20),
            "BROKEN-failures": dict(desired="running", reason="CURRENT_TRIP", observed="stopped", decided_ago=2, failures=3),
            "STARTING": dict(desired="running", reason="CURRENT_TRIP", observed="stopped", decided_ago=2, failures=2),
            "UNOBSERVED": dict(desired="running", reason="CURRENT_TRIP", observed=None),
        }
        slugs = {label: self.gateway(label.lower().replace("_", "-"), **kw) for label, kw in cases.items()}
        for label, slug in slugs.items():
            with self.subTest(label):
                self.assertEqual(self.health_of(slug), label.split("-")[0])

    def test_without_a_recent_good_sweep_nothing_is_called_healthy_or_dormant(self) -> None:
        self.sweep(ago_minutes=45)
        self.sweep(ago_minutes=1, result="host_unreachable")
        slugs = [self.gateway("a", desired="running", reason="CURRENT_TRIP", observed="running"),
                 self.gateway("b", desired="stopped", reason="ARCHIVED", observed="stopped", stopped_ok=True),
                 self.gateway("c", desired="stopped", reason="RETIRED", observed="running")]
        for slug in slugs:
            self.assertEqual(self.health_of(slug), "UNOBSERVED", slug)
        alerts = self.tool("alerts")
        self.assertIn("GATEWAY RECONCILER SILENT", alerts)
        self.assertNotIn("COMPANION GATEWAY\n", alerts, "per-gateway claims are withheld while they are stale")

    def test_alerts_name_what_needs_a_person_and_nothing_that_was_on_purpose(self) -> None:
        self.sweep()
        up = self.gateway("up", desired="running", reason="CURRENT_TRIP", observed="running")
        dormant = self.gateway("dormant", desired="stopped", reason="ARCHIVED", observed="stopped", stopped_ok=True)
        pending = self.gateway("pending", desired="stopped", reason="ARCHIVED", observed="running")
        broken = self.gateway("broken", desired="running", reason="CURRENT_TRIP", observed="stopped", decided_ago=30,
                              failures=1)
        stray = self.gateway("stray", desired="stopped", reason="RETIRED", observed="running",
                             slug=f"retired-gwh-{uuid.uuid4().hex[:6]}-20260101")
        text = self.tool("alerts")
        self.assertIn(f"{broken} — companion gateway is down but should be running (CURRENT_TRIP): "
                      "the host reports it stopped; 1 start attempt(s) failed", text)
        self.assertIn(f"{stray} — a gateway is still running although this trip was torn down (RETIRED)", text)
        for slug in (up, dormant, pending):
            self.assertNotIn(slug, text)
        # Byte-stable: the same fleet, asked again, says the same thing.
        self.assertEqual(self.tool("alerts"), text)

    def test_the_overview_counts_them(self) -> None:
        self.sweep()
        self.gateway("one", desired="running", reason="CURRENT_TRIP", observed="running")
        self.gateway("two", desired="stopped", reason="ARCHIVED", observed="stopped", stopped_ok=True)
        text = self.tool("fleet_overview")
        self.assertIn("COMPANION GATEWAYS", text)
        self.assertRegex(text, r"reconciler: observe, last sweep \d+ min ago \(ok\)")
        self.assertIn("RUNNING=", text)
        self.assertIn("DORMANT=", text)

    def test_an_alert_on_a_stack_where_the_reconciler_never_ran_stays_quiet(self) -> None:
        # No SWEEP row at all: the migration is applied, the worker has not
        # restarted. There is nothing stale to report, and the overview says so.
        self.conn.execute("DELETE FROM control_plane.companion_gateway_events WHERE event = 'SWEEP'")
        self.assertNotIn("GATEWAY RECONCILER SILENT", self.tool("alerts"))
        self.assertIn("no sweep has ever been recorded", self.tool("fleet_overview"))


if __name__ == "__main__":
    unittest.main()
