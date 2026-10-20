"""The control plane decides which companion gateways run (issue #349), PR A:
record and decide, observe only by default.

Three layers, cheapest first:

  * `decide()` is a pure function, so its rules are a TABLE — this file's
    specification of who runs and why, including the owner's final 2026-10-20
    model (the organizer's current trip, a 2-day warm window after a switch,
    trips underway, a 2-day revival when a message reaches a stopped companion,
    14 days' grace, then archive);
  * the ssh adapter's parsing of the host's lines, with `subprocess.run`
    replaced — a forged or truncated answer is an error, never a verdict;
  * the sweep against a real PostgreSQL (CONTROL_PLANE_TEST_DATABASE_URL, whose
    name must say it is for tests; skipped without one) with a fake host that
    records every call, so "observe never acts" is a fact about calls made.
"""
from __future__ import annotations

import hashlib
import io
import logging
import secrets
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest import mock

import psycopg
from psycopg.rows import dict_row

from control_plane_worker.__main__ import LOG_FORMAT
from control_plane_worker.gateway_reconcile import (
    ADVISORY_LOCK_TEXT,
    DEFAULT_POLICY,
    Decision,
    GatewayFacts,
    GatewayHostError,
    GatewayReconcileSweep,
    Observed,
    Policy,
    SshGatewayAdapter,
    backoff_minutes,
    decide,
    format_plan,
    parse_date,
    set_pin,
)

from tests.support.test_database import test_database_url
from tests.test_provisioner import run_test_migrations

DB_URL = test_database_url()
SKIP = not DB_URL

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)


def d(offset_days: int) -> date:
    """A date relative to NOW's day."""
    return NOW.date() + timedelta(days=offset_days)


# ── decide(): the rules, as a table ───────────────────────────────────────────

R, S = "running", "stopped"

H = timedelta(hours=1)
TWO_DAYS = timedelta(days=2)

#: (label, facts, expected desired, expected reason, expected needs_confirmation)
DECIDE_TABLE: list[tuple[str, dict[str, Any], str, str, bool]] = [
    # --- the interviewer, retirement, pins ---
    ("the interviewer always runs", dict(kind="interviewer"), R, "INTERVIEWER", False),
    ("the interviewer runs even when it is somehow flagged retired",
     dict(kind="interviewer", retired=True, pin="off"), R, "INTERVIEWER", False),
    ("a retired trip is down at once, current or not", dict(retired=True, is_current=True), S, "RETIRED", False),
    ("a teardown pin is down at once, even the organizer's current trip",
     dict(pin="teardown", is_current=True), S, "TEARDOWN", False),
    ("retired beats an operator pin on", dict(retired=True, pin="on"), S, "RETIRED", False),
    ("an operator pin on beats an archived trip", dict(pin="on", end_date=d(-400)), R, "PIN_ON", False),
    ("an operator pin off beats the current trip", dict(pin="off", is_current=True), S, "PIN_OFF", False),
    ("an operator pin off beats a trip underway", dict(pin="off", start_date=d(-1), end_date=d(3)), S, "PIN_OFF", False),
    ("an operator pin off beats a revival", dict(pin="off", asked_at=NOW - H), S, "PIN_OFF", False),
    ("an operator pin off is not held back by a conversation just now",
     dict(pin="off", last_activity_at=NOW - timedelta(minutes=1)), S, "PIN_OFF", False),

    # --- 1. CURRENT_TRIP: any organizer's current trip, until end + 14 days ---
    ("the organizer's current trip runs, with no dates", dict(is_current=True), R, "CURRENT_TRIP", False),
    ("...planned for next year", dict(is_current=True, start_date=d(300), end_date=d(310)), R, "CURRENT_TRIP", False),
    ("...under way: current is named first", dict(is_current=True, start_date=d(-2), end_date=d(5)),
     R, "CURRENT_TRIP", False),
    ("...the 14th day after its end still runs", dict(is_current=True, end_date=d(-14)), R, "CURRENT_TRIP", False),
    ("...the 15th day after its end it is archived, current or not",
     dict(is_current=True, end_date=d(-15)), S, "ARCHIVED", True),
    ("an ask on the current trip changes nothing", dict(is_current=True, asked_at=NOW - H), R, "CURRENT_TRIP", False),

    # --- 2. WARM: switched away less than two days ago ---
    ("a trip switched away from an hour ago stays up", dict(warm_at=NOW - H), R, "WARM", False),
    ("...for two days", dict(warm_at=NOW - TWO_DAYS + timedelta(minutes=1)), R, "WARM", False),
    ("...and not a minute longer", dict(warm_at=NOW - TWO_DAYS), S, "NOT_CURRENT", True),
    ("warm outranks archived inside its two days", dict(warm_at=NOW - H, end_date=d(-90)), R, "WARM", False),
    ("warm does not resurrect a retired trip", dict(warm_at=NOW - H, retired=True), S, "RETIRED", False),

    # --- 3. UNDERWAY: start <= today <= end, whatever the organizer is looking at ---
    ("a trip under way runs though nobody's chat is on it", dict(start_date=d(-3), end_date=d(4)),
     R, "UNDERWAY", False),
    ("the first day of the trip", dict(start_date=d(0), end_date=d(6)), R, "UNDERWAY", False),
    ("the last day of the trip", dict(start_date=d(-5), end_date=d(0)), R, "UNDERWAY", False),
    ("the day before it starts is not underway", dict(start_date=d(1), end_date=d(7)), S, "NOT_CURRENT", True),
    ("the day after it ends is not underway", dict(start_date=d(-7), end_date=d(-1)), S, "NOT_CURRENT", True),
    ("a start date with no end date is not underway", dict(start_date=d(-30)), S, "NOT_CURRENT", True),

    # --- 4. REVIVED: a message reached it while off ---
    ("a message that reached no gateway an hour ago revives a stopped trip",
     dict(asked_at=NOW - H), R, "REVIVED", False),
    ("...for two days", dict(asked_at=NOW - TWO_DAYS + timedelta(minutes=1)), R, "REVIVED", False),
    ("...and not a minute longer", dict(asked_at=NOW - TWO_DAYS), S, "NOT_CURRENT", True),
    ("an archived trip revives the same way", dict(end_date=d(-90), asked_at=NOW - H), R, "REVIVED", False),
    ("...and archives again after two days", dict(end_date=d(-90), asked_at=NOW - TWO_DAYS), S, "ARCHIVED", True),
    ("an ask does not resurrect a retired trip", dict(retired=True, asked_at=NOW - H), S, "RETIRED", False),

    # --- 5/6. the two stops ---
    ("past end + 14 days it is ARCHIVED; a stop needs two sweeps", dict(end_date=d(-15)), S, "ARCHIVED", True),
    ("a long-archived trip stays archived", dict(end_date=d(-400)), S, "ARCHIVED", True),
    ("ended inside its grace and not current is NOT_CURRENT", dict(end_date=d(-14)), S, "NOT_CURRENT", True),
    ("planned and not current is NOT_CURRENT", dict(start_date=d(30), end_date=d(40)), S, "NOT_CURRENT", True),
    ("no dates and not current is NOT_CURRENT", dict(), S, "NOT_CURRENT", True),

    # --- the quiet window: nothing is stopped within 6 hours of a conversation ---
    ("a conversation 5h59m ago holds a NOT_CURRENT stop back",
     dict(last_activity_at=NOW - timedelta(hours=6) + timedelta(minutes=1)), R, "QUIET_WINDOW", False),
    ("...6 hours ago it no longer does", dict(last_activity_at=NOW - timedelta(hours=6)), S, "NOT_CURRENT", True),
    ("the quiet window also holds back an ARCHIVED stop",
     dict(end_date=d(-90), last_activity_at=NOW - H), R, "QUIET_WINDOW", False),
    ("the quiet window does not hold back a RETIRED stop",
     dict(retired=True, last_activity_at=NOW - timedelta(minutes=1)), S, "RETIRED", False),
    ("a revival outranks the quiet window in the reason it reports",
     dict(asked_at=NOW - H, last_activity_at=NOW - H), R, "REVIVED", False),
    ("a trip that runs anyway reports why, not the quiet window",
     dict(start_date=d(-1), end_date=d(1), last_activity_at=NOW - H), R, "UNDERWAY", False),
]


class DecideTable(unittest.TestCase):
    def test_every_row(self) -> None:
        for label, kwargs, desired, reason, confirm in DECIDE_TABLE:
            with self.subTest(label):
                got = decide(GatewayFacts(profile="p-x", **kwargs), NOW)
                self.assertEqual(got, Decision(desired, reason, confirm))

    def test_the_policy_numbers_are_the_owners(self) -> None:
        self.assertEqual((DEFAULT_POLICY.grace_days, DEFAULT_POLICY.revive_days, DEFAULT_POLICY.quiet_hours),
                         (14, 2, 6))

    def test_the_reasons_are_exactly_the_closed_set_the_schema_allows(self) -> None:
        from control_plane_worker.gateway_reconcile import REASONS
        self.assertEqual(set(REASONS), {
            "INTERVIEWER", "PIN_ON", "PIN_OFF", "TEARDOWN", "RETIRED", "CURRENT_TRIP", "WARM", "UNDERWAY",
            "REVIVED", "QUIET_WINDOW", "ARCHIVED", "NOT_CURRENT"})

    def test_every_reason_decide_can_return_is_a_closed_code_the_schema_allows(self) -> None:
        from control_plane_worker.gateway_reconcile import REASONS
        for _label, kwargs, _d, reason, _c in DECIDE_TABLE:
            self.assertIn(reason, REASONS)

    def test_decide_is_pure(self) -> None:
        facts = GatewayFacts(profile="p-x", is_current=True, warm_at=NOW - H)
        self.assertEqual(decide(facts, NOW), decide(facts, NOW))
        self.assertEqual(facts, GatewayFacts(profile="p-x", is_current=True, warm_at=NOW - H))

    def test_dates_read_the_way_the_site_and_the_portal_write_them(self) -> None:
        self.assertEqual(parse_date("2026-09-05T20:00:00+03:00"), date(2026, 9, 5))
        self.assertEqual(parse_date("2026-09-16"), date(2026, 9, 16))
        for bad in (None, "", "soon", "2026-13-40", "05/09/2026"):
            self.assertIsNone(parse_date(bad), bad)

    def test_backoff_grows_and_is_capped(self) -> None:
        self.assertEqual([backoff_minutes(n) for n in (1, 2, 3, 4, 5, 9)], [5, 10, 20, 40, 60, 60])


# ── the ssh adapter: another process's output is data ─────────────────────────

class AdapterParsing(unittest.TestCase):
    def adapter(self) -> SshGatewayAdapter:
        return SshGatewayAdapter("host.invalid", "user", "/key", known_hosts="/kh")

    def run_with(self, stdout: str, returncode: int = 0, stderr: str = "") -> tuple[Any, mock.MagicMock]:
        proc = SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)
        patcher = mock.patch("control_plane_worker.gateway_reconcile.subprocess.run", return_value=proc)
        run = patcher.start()
        self.addCleanup(patcher.stop)
        return self.adapter(), run

    def test_a_good_answer(self) -> None:
        adapter, run = self.run_with("GATEWAY aa-one running 1\nGATEWAY bb-two stopped 0\nSTATUS_END 2\n")
        got = adapter.status(["aa-one", "bb-two"])
        self.assertEqual(got, {"aa-one": Observed("running", 1), "bb-two": Observed("stopped", 0)})
        sent = run.call_args.kwargs["input"]
        self.assertIn('"record_type": "companion_gateway_status"', sent)
        self.assertIn('"profiles": ["aa-one", "bb-two"]', sent)
        self.assertNotIn("/", sent, "the request carries names, never a path")
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "ssh")
        self.assertEqual(argv[-1], "user@host.invalid", "no remote command: the key's forced command decides")

    def test_each_state_the_host_may_report(self) -> None:
        for state in ("running", "duplicate", "stopped", "absent"):
            adapter, _ = self.run_with(f"GATEWAY aa-one {state} 2\nSTATUS_END 1\n")
            self.assertEqual(adapter.status(["aa-one"])["aa-one"].state, state)

    def test_what_is_not_a_verdict_is_an_error_not_a_guess(self) -> None:
        bad = {
            "a forged second answer for one profile": "GATEWAY aa-one running 1\nGATEWAY aa-one stopped 0\nSTATUS_END 1\n",
            "a profile that was not asked about": "GATEWAY aa-one running 1\nGATEWAY zz-evil running 1\nSTATUS_END 2\n",
            "an unknown state": "GATEWAY aa-one flourishing 1\nSTATUS_END 1\n",
            "a trailing word": "GATEWAY aa-one running 1 extra\nSTATUS_END 1\n",
            "a prefix match only": "xGATEWAY aa-one running 1\nSTATUS_END 1\n",
            "no end marker (truncated)": "GATEWAY aa-one running 1\n",
            "an end marker that lies": "GATEWAY aa-one running 1\nSTATUS_END 5\n",
            "a missing profile": "STATUS_END 0\n",
            "lines after the end marker": "GATEWAY aa-one running 1\nSTATUS_END 1\nGATEWAY aa-one stopped 0\n",
            "prose": "all good, nothing is wrong\n",
            "empty": "",
            "a count with three digits": "GATEWAY aa-one running 100\nSTATUS_END 1\n",
        }
        for label, out in bad.items():
            with self.subTest(label):
                adapter, _ = self.run_with(out)
                with self.assertRaises(GatewayHostError):
                    adapter.status(["aa-one"])

    def test_a_failed_ssh_is_could_not_ask_and_names_only_what_the_script_composed(self) -> None:
        adapter, _ = self.run_with(
            "", returncode=2,
            stderr="Traceback ...\nsecret-looking line\ncompanion-install-host: refusing unsafe profile name: 'X'\n")
        with self.assertRaises(GatewayHostError) as ctx:
            adapter.status(["aa-one"])
        self.assertIn("exited 2", ctx.exception.safe_reason)
        self.assertIn("refusing unsafe profile name", ctx.exception.safe_reason)
        self.assertNotIn("secret-looking", ctx.exception.safe_reason)

    def test_a_timeout_and_a_missing_ssh_are_could_not_ask(self) -> None:
        import subprocess
        for exc in (subprocess.TimeoutExpired("ssh", 60), FileNotFoundError("ssh")):
            with mock.patch("control_plane_worker.gateway_reconcile.subprocess.run", side_effect=exc):
                with self.assertRaises(GatewayHostError):
                    self.adapter().status(["aa-one"])

    def test_it_will_not_ask_about_a_name_the_host_would_refuse(self) -> None:
        adapter, run = self.run_with("STATUS_END 0\n")
        for names in (["../etc"], ["Aa-one"], ["a b"], [""], ["-x-"], []):
            with self.subTest(names=names), self.assertRaises(GatewayHostError):
                adapter.status(names)
        run.assert_not_called()

    def test_a_large_fleet_is_asked_in_batches_and_merged(self) -> None:
        names = [f"p-{n:03d}" for n in range(250)]

        def fake(argv: Any, input: str = "", **_kw: Any) -> Any:  # noqa: A002
            asked = __import__("json").loads(input)["profiles"]
            return SimpleNamespace(returncode=0, stderr="", stdout="".join(
                f"GATEWAY {p} stopped 0\n" for p in asked) + f"STATUS_END {len(asked)}\n")

        with mock.patch("control_plane_worker.gateway_reconcile.subprocess.run", side_effect=fake) as run:
            got = self.adapter().status(names)
        self.assertEqual(len(got), 250)
        self.assertEqual(run.call_count, 2)

    def test_act_wants_exactly_its_own_verdict_line(self) -> None:
        for out, expect in (("ACTION aa-one start ok\n", "ok"), ("ACTION aa-one start refused\n", "refused"),
                            ("ACTION aa-one start failed\n", "failed")):
            adapter, _ = self.run_with(out)
            self.assertEqual(adapter.act("aa-one", "start"), expect)
        for out in ("ACTION aa-one stop ok\n", "ACTION bb-two start ok\n", "ACTION aa-one start maybe\n", "",
                    "ACTION aa-one start ok\nACTION aa-one start ok\n", "started\n"):
            with self.subTest(out=out):
                adapter, _ = self.run_with(out)
                with self.assertRaises(GatewayHostError):
                    adapter.act("aa-one", "start")

    def test_act_carries_a_name_and_a_closed_verb_and_nothing_else(self) -> None:
        adapter, run = self.run_with("ACTION aa-one stop ok\n")
        adapter.act("aa-one", "stop")
        payload = __import__("json").loads(run.call_args.kwargs["input"])
        self.assertEqual(payload, {"record_type": "companion_gateway_action", "schema_version": 1,
                                   "action": "stop", "profile": {"name": "aa-one"}})
        for profile, verb in (("aa-one", "restart"), ("aa-one", "stop; rm -rf /"), ("../x", "stop"), ("", "stop")):
            with self.subTest(profile=profile, verb=verb), self.assertRaises(GatewayHostError):
                adapter.act(profile, verb)


# ── the sweep, against a real database ────────────────────────────────────────

class FakeHost:
    """The companion host, as the sweep sees it: answers `status` from a map
    (a profile nobody set is `absent`, which the sweep never acts on) and
    records EVERY call, so what a mode did is read off calls made."""

    def __init__(self) -> None:
        self.states: dict[str, Observed] = {}
        self.status_calls: list[list[str]] = []
        self.act_calls: list[tuple[str, str]] = []
        self.act_result: Any = "ok"          # a string, or a callable(profile, verb) -> str | raises
        self.status_error: Exception | None = None
        self.converge = True                 # an ok action makes the state match

    def set(self, profile: str, state: str, count: int | None = None) -> None:
        self.states[profile] = Observed(state, count if count is not None else (0 if state in ("stopped", "absent") else 1))

    def status(self, profiles: Any) -> dict[str, Observed]:
        self.status_calls.append(list(profiles))
        if self.status_error:
            raise self.status_error
        return {p: self.states.get(p, Observed("absent", 0)) for p in profiles}

    def act(self, profile: str, verb: str) -> str:
        self.act_calls.append((profile, verb))
        result = self.act_result(profile, verb) if callable(self.act_result) else self.act_result
        if result == "ok" and self.converge:
            self.set(profile, "running" if verb == "start" else "stopped")
        return result


class Clock:
    def __init__(self) -> None:
        self.now = 5000.0

    def __call__(self) -> float:
        return self.now


class Rendered:
    """What the worker's log actually SAYS, through the worker's own LOG_FORMAT
    (which prints the message and drops `extra`, #292)."""

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


def rnd(n: int = 6) -> str:
    return secrets.token_hex(n)


def digest(telegram_id: str) -> str:
    return "sha256:" + hashlib.sha256(telegram_id.encode()).hexdigest()


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class SweepTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row, autocommit=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.host = FakeHost()
        self.clock = Clock()
        self.now = datetime.now(timezone.utc)
        self.trips: list[str] = []
        self.users: list[str] = []
        self.profiles: list[str] = []
        self.tg_ids: list[str] = []

    def tearDown(self) -> None:
        c = self.conn
        for profile in self.profiles:
            c.execute("DELETE FROM control_plane.companion_gateway_events WHERE hermes_profile = %s", (profile,))
            c.execute("DELETE FROM control_plane.companion_gateways WHERE hermes_profile = %s", (profile,))
        c.execute("DELETE FROM control_plane.companion_gateway_events WHERE event = 'SWEEP'")
        for trip_id in self.trips:
            c.execute("DELETE FROM control_plane.assistant_events WHERE trip_id = %s", (trip_id,))
            c.execute("DELETE FROM control_plane.trip_memberships WHERE trip_id = %s", (trip_id,))
            c.execute("DELETE FROM control_plane.telegram_chat_bindings WHERE trip_id = %s", (trip_id,))
            c.execute("DELETE FROM control_plane.trips WHERE id = %s", (trip_id,))
        for tg in self.tg_ids:
            c.execute("DELETE FROM control_plane.telegram_organizer_links WHERE telegram_subject_digest = %s",
                      (digest(tg),))
        for user_id in self.users:
            c.execute("DELETE FROM control_plane.telegram_organizer_links WHERE user_id = %s", (user_id,))
            c.execute("DELETE FROM control_plane.users WHERE id = %s", (user_id,))

    # ── fixtures ────────────────────────────────────────────────────────────

    def trip(self, *, profile: str | None = None, lifecycle: str = "ready_private", slug: str | None = None,
             departure: str | None = None, return_date: str | None = None,
             start: date | None = None, end: date | None = None, undated: bool = False) -> dict[str, str]:
        """A provisioned trip. With no dates given it is UNDERWAY (the plain
        "this one should run" fixture); `undated=True` gives it none."""
        if not undated and not (departure or return_date or start or end):
            start, end = self.past(1), self.past(-5)
        trip_id = f"trip_{rnd(8)}"
        slug = slug or f"gw-{rnd(4)}"
        profile = profile or f"gw{rnd(5)}"
        snapshot = None
        if departure or return_date:
            snapshot = psycopg.types.json.Jsonb({"meta": {"departure": departure, "returnDate": return_date}})
        self.conn.execute(
            "INSERT INTO control_plane.trips(id, slug, lifecycle_state, hermes_profile, start_date, end_date, plan_snapshot) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)", (trip_id, slug, lifecycle, profile, start, end, snapshot))
        self.trips.append(trip_id)
        self.profiles.append(profile)
        return {"trip_id": trip_id, "slug": slug, "profile": profile}

    def organizer(self, trip: dict[str, str], tg_id: str, *, role: str = "owner", user_id: str | None = None) -> str:
        user_id = user_id or f"user_{rnd(8)}"
        if user_id not in self.users:
            self.conn.execute("INSERT INTO control_plane.users(id, status, display_name) VALUES (%s, 'active', 'x')",
                              (user_id,))
            self.users.append(user_id)
            self.conn.execute(
                "INSERT INTO control_plane.telegram_organizer_links(id, user_id, telegram_subject_digest, verified_via) "
                "VALUES (%s, %s, %s, 'enrollment_redemption')", (f"tol_{rnd(8)}", user_id, digest(tg_id)))
            self.tg_ids.append(tg_id)
        self.conn.execute(
            "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) "
            "VALUES (%s, %s, %s, %s, 'active')", (f"tm_{rnd(8)}", trip["trip_id"], user_id, role))
        return user_id

    def bind(self, trip: dict[str, str], chat_id: str, *, created_ago: timedelta = timedelta(0),
             closed_ago: timedelta | None = None, reason: str = "organizer_switch") -> None:
        """A binding of a chat to the trip, created `created_ago` ago and, if
        `closed_ago` is given, closed that long ago. A private chat's id is
        digits; a group's starts with a minus."""
        self.conn.execute(
            "INSERT INTO control_plane.telegram_chat_bindings"
            "(id, chat_id, trip_id, hermes_profile, created_at, closed_at, closed_reason) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (f"tcb_{rnd(8)}", chat_id, trip["trip_id"], trip["profile"], self.now - created_ago,
             None if closed_ago is None else self.now - closed_ago, None if closed_ago is None else reason))

    def switch(self, chat_id: str, to: dict[str, str]) -> None:
        """What switchChatToTrip does: close the open binding, open a new one."""
        self.conn.execute(
            "UPDATE control_plane.telegram_chat_bindings SET closed_at = %s, closed_reason = 'organizer_switch' "
            "WHERE chat_id = %s AND closed_at IS NULL", (self.now, chat_id))
        self.bind(to, chat_id)

    def past(self, days: int) -> date:
        """A date `days` before the sweep's today."""
        return self.now.date() - timedelta(days=days)

    def event(self, trip: dict[str, str], kind: str, ago: timedelta) -> None:
        common = dict(trip_id=trip["trip_id"], at=self.now - ago, id=str(uuid.uuid4()))
        if kind == "lost":
            self.conn.execute(
                "INSERT INTO control_plane.assistant_events(event_id, trip_id, occurred_at, source_service, event_type, "
                "outcome, channel_type, trigger_type, requester_role, message_length_bucket, media_kind) "
                "VALUES (%(id)s, %(trip_id)s, %(at)s, 'relay', 'turn_lost', 'lost_gateway_unavailable', 'group', "
                "'mention', 'participant', '1_40', 'none')", common)
        else:
            self.conn.execute(
                "INSERT INTO control_plane.assistant_events(event_id, trip_id, occurred_at, source_service, event_type, "
                "outcome, message_length_bucket) VALUES (%(id)s, %(trip_id)s, %(at)s, 'relay', 'reply_sent', "
                "'reply_delivered', '1_40')", common)

    def sweep(self, mode: str = "observe", **kw: Any) -> GatewayReconcileSweep:
        return GatewayReconcileSweep(DB_URL, self.host, mode=mode, interval_minutes=5, clock=self.clock,
                                     now_fn=lambda: self.now, **kw)

    def row(self, trip: dict[str, str]) -> dict[str, Any]:
        return self.conn.execute("SELECT * FROM control_plane.companion_gateways WHERE hermes_profile = %s",
                                 (trip["profile"],)).fetchone()

    def events(self, trip: dict[str, str] | None = None, event: str | None = None) -> list[dict[str, Any]]:
        sql, args = "SELECT * FROM control_plane.companion_gateway_events WHERE true", []
        if trip:
            sql += " AND hermes_profile = %s"
            args.append(trip["profile"])
        if event:
            sql += " AND event = %s"
            args.append(event)
        return self.conn.execute(sql + " ORDER BY id", args).fetchall()

    def advance(self, minutes: float) -> None:
        self.now += timedelta(minutes=minutes)
        self.clock.now += minutes * 60

    # ── who runs, from real rows ─────────────────────────────────────────────

    def test_the_organizers_current_trip_runs_and_a_planned_one_they_are_not_on_does_not(self) -> None:
        current, other = self.trip(undated=True), self.trip(undated=True)
        for t in (current, other):
            self.organizer(t, "7001")
        self.bind(current, "7001")
        self.host.set(current["profile"], "running")
        self.host.set(other["profile"], "running")
        self.sweep().run()
        self.assertEqual((self.row(current)["desired"], self.row(current)["reason"]), ("running", "CURRENT_TRIP"))
        self.assertEqual((self.row(other)["desired"], self.row(other)["reason"]), ("stopped", "NOT_CURRENT"))

    def test_the_same_person_under_two_user_ids_is_one_organizer(self) -> None:
        a, b = self.trip(undated=True), self.trip(undated=True)
        self.organizer(a, "7002", user_id=f"user_{rnd(8)}")
        self.organizer(b, "7002", user_id=f"user_{rnd(8)}")
        self.bind(b, "7002")
        self.sweep().run()
        self.assertEqual(self.row(a)["reason"], "NOT_CURRENT")
        self.assertEqual(self.row(b)["reason"], "CURRENT_TRIP")

    def test_a_trip_is_current_if_it_is_any_of_its_organizers_current_trip(self) -> None:
        shared, away = self.trip(undated=True), self.trip(undated=True)
        self.organizer(shared, "7003", role="owner")
        self.organizer(shared, "7004", role="organizer")
        self.organizer(away, "7003")
        self.bind(away, "7003")        # the first organizer is elsewhere
        self.bind(shared, "7004")      # the second is on it
        self.sweep().run()
        self.assertEqual(self.row(shared)["reason"], "CURRENT_TRIP")

    def test_a_member_is_not_an_organizer_and_a_group_is_not_a_dm(self) -> None:
        member_trip, group_trip = self.trip(undated=True), self.trip(undated=True)
        self.organizer(member_trip, "7005", role="member")
        self.bind(member_trip, "7005")
        self.bind(group_trip, "-100777")
        self.sweep().run()
        self.assertEqual(self.row(member_trip)["reason"], "NOT_CURRENT")
        self.assertEqual(self.row(group_trip)["reason"], "NOT_CURRENT")

    def test_a_dm_bound_to_a_retired_trip_is_nobodys_current_trip(self) -> None:
        dead = self.trip(slug=f"retired-gw-{rnd(3)}-20260101")
        self.organizer(dead, "7006")
        self.bind(dead, "7006")
        self.sweep().run()
        self.assertEqual(self.row(dead)["reason"], "RETIRED")

    def test_a_pre_provisioning_trip_has_no_gateway_to_decide_about(self) -> None:
        t = self.trip(lifecycle="draft")
        self.sweep().run()
        self.assertIsNone(self.row(t))

    def test_a_switch_starts_the_new_trip_at_once_and_does_not_stop_the_old_one(self) -> None:
        a, b = self.trip(undated=True), self.trip(undated=True)
        for t in (a, b):
            self.organizer(t, "7010")
        self.bind(a, "7010")
        self.host.set(a["profile"], "running")
        self.host.set(b["profile"], "stopped")
        sweep = self.sweep("enforce")
        sweep.run()
        self.assertEqual(self.host.act_calls, [], "a is current and up; b is not current and already down")
        self.switch("7010", b)
        self.advance(1)
        sweep.run()
        self.assertEqual(self.host.act_calls, [(b["profile"], "start")], "no immediate stop on switch")
        self.assertEqual(self.row(a)["reason"], "WARM")
        self.assertEqual(self.row(b)["reason"], "CURRENT_TRIP")

    def test_the_old_trip_stays_up_two_days_and_then_stops_after_two_sweeps(self) -> None:
        a, b = self.trip(undated=True), self.trip(undated=True)
        for t in (a, b):
            self.organizer(t, "7011")
        self.bind(a, "7011")
        self.host.set(a["profile"], "running")
        self.host.set(b["profile"], "running")
        sweep = self.sweep("enforce")
        sweep.run()
        self.switch("7011", b)
        for minutes in (5, 60 * 24, 60 * 23):          # one minute short of two days since the switch
            self.advance(minutes)
            sweep.run()
        self.assertEqual(self.row(a)["reason"], "WARM")
        self.assertEqual(self.host.act_calls, [])
        self.advance(65)
        sweep.run()
        self.assertEqual((self.row(a)["desired"], self.row(a)["reason"]), ("stopped", "NOT_CURRENT"))
        self.assertEqual(self.host.act_calls, [], "decided once: not stopped yet")
        self.advance(5)
        sweep.run()
        self.assertEqual(self.host.act_calls, [(a["profile"], "stop")])

    def test_a_chat_rebound_to_another_trip_also_starts_the_warm_window(self) -> None:
        a, b = self.trip(undated=True), self.trip(undated=True)
        for t in (a, b):
            self.organizer(t, "7012")
        # The provisioner retargeted the chat: a's binding closed for another reason, b's opened.
        self.bind(a, "7012", created_ago=timedelta(days=30), closed_ago=timedelta(minutes=30), reason="retargeted")
        self.bind(b, "7012", created_ago=timedelta(minutes=30))
        self.sweep().run()
        self.assertEqual(self.row(a)["reason"], "WARM")

    def test_a_binding_closed_for_another_reason_with_no_replacement_is_not_warm(self) -> None:
        a = self.trip(undated=True)
        self.organizer(a, "7013")
        self.bind(a, "7013", created_ago=timedelta(days=30), closed_ago=timedelta(minutes=30), reason="chat_left")
        self.sweep().run()
        self.assertEqual(self.row(a)["reason"], "NOT_CURRENT")

    def test_a_trip_underway_runs_whoever_the_organizer_is_talking_to(self) -> None:
        under_way, current = self.trip(start=self.past(3), end=self.past(-4)), self.trip(undated=True)
        for t in (under_way, current):
            self.organizer(t, "7014")
        self.bind(current, "7014")
        self.host.set(under_way["profile"], "stopped")
        self.sweep("enforce").run()
        self.assertEqual(self.row(under_way)["reason"], "UNDERWAY")
        self.assertEqual(self.host.act_calls, [(under_way["profile"], "start")])

    def test_a_current_trip_past_its_grace_is_archived_and_stops_after_two_sweeps(self) -> None:
        t = self.trip(end=self.past(15))
        self.organizer(t, "7015")
        self.bind(t, "7015")
        self.host.set(t["profile"], "running")
        sweep = self.sweep("enforce")
        sweep.run()
        self.assertEqual((self.row(t)["desired"], self.row(t)["reason"]), ("stopped", "ARCHIVED"))
        self.assertEqual(self.host.act_calls, [])
        self.advance(5)
        sweep.run()
        self.assertEqual(self.host.act_calls, [(t["profile"], "stop")])

    def test_the_current_trip_runs_through_day_14_of_its_grace(self) -> None:
        t = self.trip(end=self.past(14))
        self.organizer(t, "7016")
        self.bind(t, "7016")
        self.sweep().run()
        self.assertEqual(self.row(t)["reason"], "CURRENT_TRIP")

    def test_a_lost_turn_revives_a_stopped_trip_for_two_days_and_stops_nobody_else(self) -> None:
        current, revived, lapsed = self.trip(undated=True), self.trip(undated=True), self.trip(undated=True)
        for t in (current, revived, lapsed):
            self.organizer(t, "7017")
        self.bind(current, "7017")
        self.event(revived, "lost", timedelta(hours=1))
        self.event(lapsed, "lost", timedelta(days=2, minutes=1))
        self.host.set(current["profile"], "running")
        self.host.set(revived["profile"], "stopped")
        self.host.set(lapsed["profile"], "stopped")
        self.sweep("enforce").run()
        self.assertEqual((self.row(revived)["desired"], self.row(revived)["reason"]), ("running", "REVIVED"))
        self.assertEqual(self.row(lapsed)["reason"], "NOT_CURRENT")
        self.assertEqual(self.host.act_calls, [(revived["profile"], "start")])

    def test_a_revived_archived_trip_stops_again_after_two_days(self) -> None:
        t = self.trip(end=self.past(90))
        self.event(t, "lost", timedelta(hours=1))
        self.host.set(t["profile"], "stopped")
        sweep = self.sweep("enforce")
        sweep.run()
        self.assertEqual(self.host.act_calls, [(t["profile"], "start")])
        self.advance(60 * 24 + 30)
        sweep.run()
        self.assertEqual(self.row(t)["reason"], "REVIVED")
        self.advance(60 * 24)
        sweep.run()
        self.assertEqual(self.row(t)["reason"], "ARCHIVED")
        self.advance(5)
        sweep.run()
        self.assertEqual(self.host.act_calls, [(t["profile"], "start"), (t["profile"], "stop")])

    def test_the_grace_period_reads_the_deployed_config_first_then_the_portal_columns(self) -> None:
        snap = self.trip(departure="2026-01-01T20:00:00+02:00", return_date=self.past(20).isoformat())
        portal = self.trip(start=self.past(30), end=self.past(20))
        for t in (snap, portal):
            self.host.set(t["profile"], "stopped")
        self.sweep().run()
        for t in (snap, portal):
            self.assertEqual(self.row(t)["reason"], "ARCHIVED", t["slug"])

    def test_a_conversation_within_six_hours_holds_an_archive_stop_but_never_causes_a_start(self) -> None:
        t = self.trip(end=self.past(90))
        self.event(t, "reply", timedelta(hours=2))
        self.host.set(t["profile"], "running")
        sweep = self.sweep("enforce")
        for _ in range(3):
            sweep.run()
            self.advance(5)
        self.assertEqual(self.row(t)["reason"], "QUIET_WINDOW")
        self.assertEqual(self.host.act_calls, [], "held: not stopped")
        self.host.set(t["profile"], "stopped")
        sweep.run()
        self.assertEqual(self.host.act_calls, [], "and a hold never starts a gateway that is already down")

    def test_a_wake_path_with_no_events_to_read_says_so_once(self) -> None:
        t = self.trip()
        self.sweep()._warned_blind = False
        with mock.patch.object(GatewayReconcileSweep, "_warn_if_wake_blind", autospec=True) as spy:
            self.sweep().run()
        spy.assert_called_once()
        # And its own body, against an empty window:
        s = self.sweep()
        with Rendered() as log:
            s._warn_if_wake_blind(self.conn, self.now + timedelta(days=3650))
            s._warn_if_wake_blind(self.conn, self.now + timedelta(days=3650))
        self.assertEqual(log.text.count("gateway_reconcile.wake_signal_blind"), 1, "once per process, not per sweep")
        self.assertIn("ASSISTANT_EVENTS_ENABLED", log.text)
        self.assertIsNotNone(t)

    # ── retired, pins, the interviewer ──────────────────────────────────────

    def test_a_retired_trips_gateway_is_stopped_at_once(self) -> None:
        t = self.trip(slug=f"retired-gw-{rnd(3)}-20260101")
        self.host.set(t["profile"], "running")
        self.sweep("enforce").run()
        self.assertEqual(self.host.act_calls, [(t["profile"], "stop")])

    def test_a_retired_trip_that_is_already_gone_is_converged_not_an_error(self) -> None:
        t = self.trip(slug=f"retired-gw-{rnd(3)}-20260101")
        self.host.set(t["profile"], "absent")
        s = self.sweep("enforce")
        s.run()
        self.assertEqual(self.host.act_calls, [])
        self.assertEqual(self.row(t)["observed"], "absent")

    def test_the_interviewer_is_always_decided_running_and_started_if_it_is_down(self) -> None:
        self.host.set("trip-intake", "stopped")
        self.addCleanup(lambda: self.conn.execute(
            "DELETE FROM control_plane.companion_gateway_events WHERE hermes_profile = 'trip-intake'"))
        self.addCleanup(lambda: self.conn.execute(
            "DELETE FROM control_plane.companion_gateways WHERE hermes_profile = 'trip-intake'"))
        self.sweep("enforce").run()
        self.assertIn(("trip-intake", "start"), self.host.act_calls)
        row = self.conn.execute("SELECT * FROM control_plane.companion_gateways WHERE hermes_profile = 'trip-intake'"
                                ).fetchone()
        self.assertEqual((row["kind"], row["desired"], row["reason"]), ("interviewer", "running", "INTERVIEWER"))

    def test_a_pin_off_is_applied_at_once_and_clear_returns_the_rules(self) -> None:
        t = self.trip()
        self.host.set(t["profile"], "running")
        sweep = self.sweep("enforce")
        sweep.run()
        self.assertEqual(self.row(t)["reason"], "UNDERWAY")
        out = set_pin(DB_URL, self.host, t["profile"], "off", now=self.now)
        self.assertEqual((out["desired"], out["reason"]), ("stopped", "PIN_OFF"))
        self.assertEqual(self.row(t)["pin"], "off")
        self.assertIsNotNone(self.row(t)["pin_set_at"])
        sweep.run()
        self.assertEqual(self.host.act_calls, [(t["profile"], "stop")], "an operator stop needs no second sweep")
        out = set_pin(DB_URL, self.host, t["profile"], "clear", now=self.now)
        self.assertEqual(out["reason"], "UNDERWAY")
        self.assertIsNone(self.row(t)["pin"])
        self.assertEqual([e["pin"] for e in self.events(t, "PIN")], ["off", "clear"])

    def test_the_pin_cli_refuses_what_it_must(self) -> None:
        t = self.trip()
        for profile, pin, why in (("nobody-has-this", "on", "not a gateway the control plane manages"),
                                  ("trip-intake", "off", "interviewer"),
                                  (t["profile"], "teardown", "pin must be on, off or clear"),
                                  ("../x", "on", "not a profile name")):
            with self.subTest(profile=profile, pin=pin):
                with self.assertRaises(ValueError) as ctx:
                    set_pin(DB_URL, self.host, profile, pin, now=self.now)
                self.assertIn(why, str(ctx.exception))
        self.conn.execute(
            "INSERT INTO control_plane.companion_gateways(hermes_profile, trip_id, kind, desired, reason, pin, pin_set_at) "
            "VALUES (%s, %s, 'companion', 'stopped', 'TEARDOWN', 'teardown', now())", (t["profile"], t["trip_id"]))
        with self.assertRaises(ValueError) as ctx:
            set_pin(DB_URL, self.host, t["profile"], "clear", now=self.now)
        self.assertIn("teardown in progress", str(ctx.exception))

    def test_a_teardown_pin_stops_the_gateway_and_nothing_restarts_it(self) -> None:
        t = self.trip()             # an active trip: only the pin says otherwise
        self.bind(t, "7040")
        self.conn.execute(
            "INSERT INTO control_plane.companion_gateways(hermes_profile, trip_id, kind, desired, reason, pin, pin_set_at) "
            "VALUES (%s, %s, 'companion', 'stopped', 'TEARDOWN', 'teardown', now())", (t["profile"], t["trip_id"]))
        self.host.set(t["profile"], "running")
        sweep = self.sweep("enforce")
        sweep.run()
        self.assertEqual(self.host.act_calls, [(t["profile"], "stop")])
        self.advance(5)
        sweep.run()
        self.assertEqual(self.host.act_calls, [(t["profile"], "stop")], "stopped stays stopped: nothing restarts it")
        self.assertEqual(self.row(t)["reason"], "TEARDOWN")

    # ── OBSERVE NEVER ACTS ──────────────────────────────────────────────────

    def test_observe_records_decisions_and_observations_and_calls_act_never(self) -> None:
        up, down, gone, stale = self.trip(), self.trip(), self.trip(), self.trip(end=self.past(90))
        self.host.set(up["profile"], "stopped")                       # should run, is down: would start
        self.host.set(stale["profile"], "running")                    # should not run, is up: would stop
        self.host.set(down["profile"], "stopped")
        self.host.set(gone["profile"], "duplicate", 2)
        self.host.act_result = lambda *_a: self.fail("observe called the host's action verb")
        sweep = self.sweep("observe")
        for _ in range(3):
            summary = sweep.run()
            self.advance(5)
        self.assertEqual(self.host.act_calls, [])
        self.assertEqual(self.events(event="ACTION"), [])
        self.assertIn(up["profile"], summary["would_start"])
        self.assertIn(stale["profile"], summary["would_stop"])
        self.assertIn(gone["profile"], summary["duplicates"])
        self.assertEqual(self.row(up)["observed"], "stopped")
        self.assertEqual(self.row(gone)["observed"], "duplicate")
        self.assertEqual(self.row(gone)["observed_count"], 2)
        self.assertIsNone(self.row(up)["last_action"])

    def test_the_mode_off_and_a_missing_host_never_run_and_say_so(self) -> None:
        off = self.sweep("off")
        self.assertFalse(off.enabled)
        self.assertIn("OFF", off.describe())
        self.assertIsNone(off.maybe_run())
        nohost = GatewayReconcileSweep(DB_URL, None, mode="observe", interval_minutes=5)
        self.assertFalse(nohost.enabled)
        self.assertIn("no companion SSH host", nohost.describe())
        self.assertIn("OBSERVE", self.sweep("observe").describe())
        self.assertIn("acts on nothing", self.sweep("observe").describe())
        with self.assertRaises(ValueError):
            self.sweep("enforce-ish")

    def test_dry_run_decides_and_asks_but_writes_and_acts_on_nothing(self) -> None:
        a, b = self.trip(), self.trip(end=self.past(90))
        self.host.set(a["profile"], "stopped")
        self.host.set(b["profile"], "running")
        before = self.conn.execute("SELECT count(*) AS n FROM control_plane.companion_gateway_events").fetchone()["n"]
        # Whatever the configured mode, dry-run is observe and writes nothing.
        summary = self.sweep("enforce").run(dry_run=True)
        self.assertEqual(summary["mode"], "dry_run")
        self.assertEqual(self.host.act_calls, [])
        self.assertIsNone(self.row(a))
        self.assertEqual(self.conn.execute("SELECT count(*) AS n FROM control_plane.companion_gateway_events"
                                           ).fetchone()["n"], before)
        self.assertIn(a["profile"], summary["would_start"])
        self.assertIn("would start", format_plan(summary))

    # ── record keeping: change only ─────────────────────────────────────────

    def test_a_steady_fleet_writes_nothing_but_its_heartbeat(self) -> None:
        t = self.trip()
        self.host.set(t["profile"], "running")
        sweep = self.sweep()
        sweep.run()
        sweep.run()            # confirmations reaches its cap here: the last decision write
        mark = self.row(t)["updated_at"]
        facts = len(self.events(t))
        sweeps = len(self.events(event="SWEEP"))
        for _ in range(3):
            self.advance(5)
            sweep.run()
        self.assertEqual(self.row(t)["updated_at"], mark, "a steady row is not rewritten")
        self.assertEqual(len(self.events(t)), facts, "no DECIDED/OBSERVED rows for a fact that did not change")
        self.assertEqual(len(self.events(event="SWEEP")), sweeps + 3, "one heartbeat per sweep")

    def test_a_change_is_recorded_once_with_its_codes(self) -> None:
        t = self.trip()
        self.host.set(t["profile"], "running")
        sweep = self.sweep()
        sweep.run()
        self.host.set(t["profile"], "stopped")
        sweep.run()
        decided = self.events(t, "DECIDED")
        observed = self.events(t, "OBSERVED")
        self.assertEqual([(e["desired"], e["reason"]) for e in decided], [("running", "UNDERWAY")])
        self.assertEqual([e["observed"] for e in observed], ["running", "stopped"])
        for e in decided + observed:
            self.assertEqual(e["mode"], "observe")

    def test_every_sweep_leaves_a_heartbeat_with_its_mode_and_result(self) -> None:
        self.trip()
        self.sweep().run()
        self.host.status_error = GatewayHostError("gateway status over ssh exited 255: (no reason)")
        self.sweep("enforce").run()
        beats = self.events(event="SWEEP")
        self.assertEqual([(b["mode"], b["result"]) for b in beats[-2:]],
                         [("observe", "ok"), ("enforce", "host_unreachable")])

    # ── ENFORCE: the safety valves ──────────────────────────────────────────

    def test_a_start_is_immediate_and_recorded(self) -> None:
        t = self.trip()
        self.host.set(t["profile"], "stopped")
        self.sweep("enforce").run()
        self.assertEqual(self.host.act_calls, [(t["profile"], "start")])
        row = self.row(t)
        self.assertEqual((row["last_action"], row["last_result"], row["failures"]), ("start", "ok", 0))
        self.assertEqual([(e["action"], e["result"], e["mode"]) for e in self.events(t, "ACTION")],
                         [("start", "ok", "enforce")])

    def test_at_most_three_actions_per_sweep_and_the_rest_wait_for_the_next(self) -> None:
        ts = [self.trip() for _ in range(5)]
        for t in ts:
            self.host.set(t["profile"], "stopped")
        sweep = self.sweep("enforce")
        first = sweep.run()
        mine = lambda: [c for c in self.host.act_calls if c[0] in {t["profile"] for t in ts}]  # noqa: E731
        self.assertEqual(first["starts"] + first["stops"], 3)
        self.assertGreaterEqual(first["deferred"], 2)
        self.assertEqual(len(mine()), 3)
        self.advance(5)
        sweep.run()
        self.assertEqual(len(mine()), 5)

    def test_a_failed_start_backs_off_and_is_not_hammered(self) -> None:
        t = self.trip()
        self.host.set(t["profile"], "stopped")
        self.host.act_result = "failed"
        sweep = self.sweep("enforce")
        sweep.run()
        self.assertEqual(self.row(t)["failures"], 1)
        self.assertEqual(len(self.host.act_calls), 1)
        self.advance(4)
        sweep.run()
        self.assertEqual(len(self.host.act_calls), 1, "inside the 5 minute backoff: not asked again")
        self.advance(2)
        sweep.run()
        self.assertEqual(len(self.host.act_calls), 2)
        row = self.row(t)
        self.assertEqual(row["failures"], 2)
        self.assertGreater(row["next_attempt_at"], self.now + timedelta(minutes=9), "10 minutes now")
        self.assertEqual(row["last_result"], "failed")

    def test_a_refusal_by_the_host_is_a_failure_that_backs_off(self) -> None:
        t = self.trip()
        self.host.set(t["profile"], "stopped")
        self.host.act_result = "refused"
        self.sweep("enforce").run()
        self.assertEqual((self.row(t)["last_result"], self.row(t)["failures"]), ("refused", 1))

    def test_an_ok_that_changed_nothing_is_recorded_as_not_converged_and_backs_off(self) -> None:
        t = self.trip()
        self.host.set(t["profile"], "stopped")
        self.host.converge = False      # the gateway "starts" and is gone again
        sweep = self.sweep("enforce")
        sweep.run()
        self.advance(5)
        sweep.run()
        row = self.row(t)
        self.assertEqual(row["last_result"], "not_converged")
        self.assertEqual(row["failures"], 1)
        self.assertEqual(len(self.host.act_calls), 1, "never restarted on every sweep")
        self.advance(1)
        sweep.run()
        self.assertEqual(len(self.host.act_calls), 1, "still inside its backoff")

    def test_converging_clears_the_failure_count(self) -> None:
        t = self.trip()
        self.host.set(t["profile"], "stopped")
        self.host.act_result = "failed"
        sweep = self.sweep("enforce")
        sweep.run()
        self.assertEqual(self.row(t)["failures"], 1)
        self.host.set(t["profile"], "running")      # somebody started it
        self.advance(1)
        sweep.run()
        row = self.row(t)
        self.assertEqual((row["failures"], row["next_attempt_at"]), (0, None))

    def test_a_host_that_stops_answering_ends_the_sweep_after_three_errors(self) -> None:
        ts = [self.trip() for _ in range(4)]
        for t in ts:
            self.host.set(t["profile"], "stopped")

        def boom(profile: str, verb: str) -> str:
            raise GatewayHostError("gateway start over ssh timed out after 180s")

        self.host.act_result = boom
        with Rendered() as log:
            summary = self.sweep("enforce").run()
        self.assertEqual(len(self.host.act_calls), 3, "the fourth is never tried: the host is not answering")
        self.assertEqual(summary["result"], "host_unreachable")
        self.assertIn("gateway_reconcile.sweep_aborted", log.text)
        tried = {p for p, _ in self.host.act_calls}
        for t in ts:
            self.assertEqual(self.row(t)["failures"], 1 if t["profile"] in tried else 0)

    def test_when_the_host_cannot_be_asked_decisions_are_recorded_and_nothing_else(self) -> None:
        t = self.trip()
        self.host.status_error = GatewayHostError("gateway status over ssh exited 255: (no reason the forced command composed)")
        with Rendered() as log:
            summary = self.sweep("enforce").run()
        self.assertEqual(summary["result"], "host_unreachable")
        self.assertEqual(self.row(t)["desired"], "running", "the decision is a database fact and is recorded")
        self.assertIsNone(self.row(t)["observed"], "an observation that was never made is not invented")
        self.assertEqual(self.host.act_calls, [])
        self.assertIn("gateway_reconcile.host_unreachable", log.text)
        self.assertIn("exited 255", log.text)

    def test_duplicates_and_absent_profiles_are_reported_never_acted_on(self) -> None:
        dup, absent = self.trip(), self.trip()
        self.host.set(dup["profile"], "duplicate", 2)
        self.host.set(absent["profile"], "absent")
        summary = self.sweep("enforce").run()
        mine = [c for c in self.host.act_calls if c[0] in (dup["profile"], absent["profile"])]
        self.assertEqual(mine, [])
        self.assertIn(dup["profile"], summary["duplicates"])

    def test_the_sweep_holds_the_advisory_lock_and_skips_when_another_has_it(self) -> None:
        other = psycopg.connect(DB_URL, row_factory=dict_row, autocommit=True)
        try:
            self.assertTrue(other.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS g", (ADVISORY_LOCK_TEXT,)
                                          ).fetchone()["g"])
            with Rendered() as log:
                summary = self.sweep("enforce").run()
            self.assertEqual(summary["result"], "lock_busy")
            self.assertEqual(self.host.status_calls, [], "a held lock means the host is not even asked")
            self.assertIn("gateway_reconcile.skipped", log.text)
        finally:
            other.execute("SELECT pg_advisory_unlock(hashtext(%s))", (ADVISORY_LOCK_TEXT,))
            other.close()
        self.sweep("observe").run()     # released: runs

    def test_the_lock_is_released_after_a_sweep_even_a_failed_one(self) -> None:
        self.host.status_error = GatewayHostError("x")
        self.sweep("observe").run()
        other = psycopg.connect(DB_URL, row_factory=dict_row, autocommit=True)
        try:
            self.assertTrue(other.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS g", (ADVISORY_LOCK_TEXT,)
                                          ).fetchone()["g"])
        finally:
            other.execute("SELECT pg_advisory_unlock(hashtext(%s))", (ADVISORY_LOCK_TEXT,))
            other.close()

    def test_old_events_are_pruned_and_recent_ones_kept(self) -> None:
        t = self.trip()
        self.conn.execute(
            "INSERT INTO control_plane.companion_gateway_events(event, occurred_at, mode, result, profiles, actions) "
            "VALUES ('SWEEP', now() - interval '91 days', 'observe', 'ok', 1, 0)")
        self.conn.execute(
            "INSERT INTO control_plane.companion_gateway_events(event, occurred_at, mode, result, profiles, actions) "
            "VALUES ('SWEEP', now() - interval '89 days', 'observe', 'ok', 1, 0)")
        self.sweep().run()
        ages = [e["occurred_at"] for e in self.events(event="SWEEP")]
        self.assertTrue(all(a > datetime.now(timezone.utc) - timedelta(days=90) for a in ages))
        self.assertEqual(len([a for a in ages if a < datetime.now(timezone.utc) - timedelta(days=88)]), 1)
        self.assertIsNotNone(t)

    # ── the wake path: a hint runs a sweep ahead of its interval ────────────

    def test_a_switch_or_a_lost_turn_runs_a_sweep_before_the_interval_a_quiet_database_does_not(self) -> None:
        a, b = self.trip(), self.trip(end=self.past(90))
        sweep = self.sweep()
        self.assertIsNotNone(sweep.maybe_run(), "the first poll sweeps")
        self.clock.now += 40
        self.assertIsNone(sweep.maybe_run(), "nothing happened: no sweep, only a cheap read")
        self.bind(b, "7060")
        self.clock.now += 40
        got = sweep.maybe_run()
        self.assertIsNotNone(got, "an organizer's switch opens a binding: a sweep runs 40s later, not 5 minutes")
        self.clock.now += 40
        self.assertIsNone(sweep.maybe_run())
        self.event(a, "lost", timedelta(seconds=5))
        self.clock.now += 40
        self.assertIsNotNone(sweep.maybe_run(), "a lost family message is the wake signal")

    def test_hints_are_rate_limited_and_the_interval_still_applies(self) -> None:
        t = self.trip()
        sweep = self.sweep()
        sweep.maybe_run()
        self.clock.now += 10
        self.bind(t, str(8 * 10**9 + secrets.randbelow(10**9)))
        self.assertIsNone(sweep.maybe_run(), "inside the minimum gap nothing runs, hint or not")
        self.clock.now += 5 * 60
        self.assertIsNotNone(sweep.maybe_run(), "and the interval sweep is unaffected")

    def test_a_failing_hint_read_is_a_missed_shortcut_not_a_crash(self) -> None:
        sweep = self.sweep()
        sweep.maybe_run()
        self.clock.now += 40
        with mock.patch.object(GatewayReconcileSweep, "_hint_pending", side_effect=RuntimeError("db down")):
            with Rendered() as log:
                self.assertIsNone(sweep.maybe_run())
        self.assertIn("gateway_reconcile.hint_failed", log.text)

    # ── the schema is closed-code only ──────────────────────────────────────

    def test_the_tables_refuse_a_reason_that_is_not_a_closed_code(self) -> None:
        t = self.trip()
        for sql in (
            "INSERT INTO control_plane.companion_gateways(hermes_profile, kind, desired, reason) "
            "VALUES (%s, 'companion', 'running', 'because the owner said so')",
            "INSERT INTO control_plane.companion_gateways(hermes_profile, kind, desired, reason, observed) "
            "VALUES (%s, 'companion', 'running', 'UNDERWAY', 'sort of running')",
            "INSERT INTO control_plane.companion_gateways(hermes_profile, kind, desired, reason, pin) "
            "VALUES (%s, 'companion', 'running', 'UNDERWAY', 'maybe')",
            "INSERT INTO control_plane.companion_gateways(hermes_profile, kind, desired, reason, pin) "
            "VALUES (%s, 'companion', 'running', 'UNDERWAY', 'on')",       # a pin needs its time
            "INSERT INTO control_plane.companion_gateways(hermes_profile, kind, desired, reason, last_action) "
            "VALUES (%s, 'companion', 'running', 'UNDERWAY', 'start')",     # an action needs its time and result
            "INSERT INTO control_plane.companion_gateways(hermes_profile, kind, desired, reason) "
            "VALUES ('UPPER CASE', 'companion', 'running', 'UNDERWAY')",
        ):
            with self.subTest(sql=sql[:90]), self.assertRaises(psycopg.errors.CheckViolation):
                self.conn.execute(sql, (t["profile"],) if "%s" in sql else ())
        for sql in (
            "INSERT INTO control_plane.companion_gateway_events(event, hermes_profile, desired, reason) "
            "VALUES ('DECIDED', %s, 'running', 'free text goes here')",
            "INSERT INTO control_plane.companion_gateway_events(event) VALUES ('DECIDED')",
            "INSERT INTO control_plane.companion_gateway_events(event, mode, result, profiles, actions) "
            "VALUES ('SWEEP', 'dry_run', 'ok', 1, 0)",
            "INSERT INTO control_plane.companion_gateway_events(event, hermes_profile, action, result) "
            "VALUES ('ACTION', %s, 'restart', 'ok')",
        ):
            with self.subTest(sql=sql[:90]), self.assertRaises(psycopg.errors.CheckViolation):
                self.conn.execute(sql, (t["profile"],) if "%s" in sql else ())

    def test_the_tables_hold_no_free_text_column(self) -> None:
        cols = self.conn.execute(
            "SELECT table_name, column_name, data_type FROM information_schema.columns "
            "WHERE table_schema = 'control_plane' AND table_name IN ('companion_gateways', 'companion_gateway_events') "
            "AND data_type = 'text'").fetchall()
        checked = self.conn.execute(
            "SELECT conrelid::regclass::text AS t, pg_get_constraintdef(oid) AS def FROM pg_constraint "
            "WHERE contype = 'c' AND conrelid::regclass::text IN "
            "('control_plane.companion_gateways', 'control_plane.companion_gateway_events')").fetchall()
        defs = " ".join(r["def"] for r in checked)
        for c in cols:
            if c["column_name"] in ("trip_id", "hermes_profile"):
                continue    # an opaque id and a charset-checked name
            self.assertIn(c["column_name"], defs, f"{c['table_name']}.{c['column_name']} is text with no CHECK")


if __name__ == "__main__":
    unittest.main()
