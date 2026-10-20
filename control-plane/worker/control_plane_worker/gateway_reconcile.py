"""The control plane decides which companion gateways run (issue #349).

Until this existed nothing said which companions are MEANT to be up. A Hermes
host starts whatever each profile last recorded, newer Hermes starts named
profiles stopped at boot, and the fleet monitor could not tell "stopped on
purpose" from "broken". This module is the decider and, only when told to, the
actor:

  * `decide()` is a PURE function: facts the database already holds in, a
    (desired, reason) pair out. Every rule is in it, in order, and the table
    test in tests/test_gateway_reconcile.py is the specification.
  * `GatewayReconcileSweep` runs it on the provisioner worker's idle poll loop
    (the BridgeProbeSweep precedent: the worker already holds the companion
    host's forced-command key, is single-threaded, and writes the same kind of
    fact). It RECORDS every decision and every observation in
    `control_plane.companion_gateways`, and — only in `enforce` mode — starts
    and stops gateways through the forced command.

MODES. `observe` (the default) records and reports and never acts: there is no
call to the action adapter on that path, and a test pins it. `enforce` acts.
`off` is the sweep not existing. An unreadable mode REFUSES at startup (see
__main__.py), because a typo quietly becoming `observe` or `off` is the
silent-downgrade shape this repository keeps paying for.

THE RULE (owner decisions, 2026-10-20), in the order decide() applies it:

  1. The interviewer always runs.
  2. A retired (torn-down) trip is down; so is one pinned `teardown`.
  3. An operator pin (`on`/`off`) beats everything automatic below.
  4. An organizer has at most ONE running companion: the trip their Telegram
     DM is currently bound to (the /switch target). Their other trips are
     stopped, even inside their grace period. "Organizer" is a trip membership
     with role owner or organizer; a trip with several organizers runs if it is
     ANY of its organizers' current trip. An organizer with no open DM binding
     constrains nothing.
  5. The current trip (and a trip nobody's DM constrains) runs until
     GRACE_DAYS after its end date; no dates, or unreadable dates, means it
     runs. There is no pre-trip dormancy.
  6. A stop that rule 4 or 5 would make is overridden by a WAKE (a family
     message to a stopped companion, recorded by the relay as a lost turn,
     keeps it up WAKE_DAYS, alongside the organizer's current trip) and then by
     the QUIET window (nothing is stopped within QUIET_HOURS of a
     conversation).
  7. The one open question: a trip whose family is IN it (today within its
     dates, with a group chat bound) but which is not its organizer's current
     trip. Rule 4 read literally stops it. `MIDTRIP_FAMILY_RULE` decides, and
     it defaults to "keep" — fail safe for travellers — until the owner says.

WHY STARTS ARE NOT DEBOUNCED BUT STOPS ARE. A wrongly started gateway costs a
process for a few minutes; a wrongly stopped one is a dark companion for a
family. So a start acts at once, and a stop for a reason a flap could produce
(rules 4 and 5) must have been decided on two consecutive sweeps — unless the
organizer's own /switch just closed that trip's DM binding, which is the
confirmation. Retired, teardown and operator stops are certain and act at once.

Every log line carries its facts in the message text (`log_fields`): the
worker's format prints the message and drops `extra` (#292).
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Sequence

from .companion_profile import forced_command_argv
from .mcp_bridge import log_fields

logger = logging.getLogger(__name__)

# ── policy ────────────────────────────────────────────────────────────────────

GRACE_DAYS = 14
WAKE_DAYS = 2
QUIET_HOURS = 6
#: A DM binding opened or closed by /switch within this long is "just now": the
#: sweep treats the organizer's own action as the confirmation of a stop.
SWITCH_WINDOW_MINUTES = 30
#: Consecutive sweeps a flap-prone stop must be decided before it is acted on.
STOP_CONFIRMATIONS = 2
MAX_ACTIONS_PER_SWEEP = 3
BACKOFF_BASE_MINUTES = 5
BACKOFF_CAP_MINUTES = 60
#: A host that does not answer this many times in a row ends the sweep.
BREAKER_AFTER = 3
EVENT_RETENTION_DAYS = 90
STATEMENT_TIMEOUT_MS = 5000
INTERVIEWER_PROFILE = "trip-intake"

#: What to do with a trip whose family is in it but which is not its
#: organizer's current trip. "keep" or "stop". See the module doc, rule 7.
MIDTRIP_FAMILY_RULE = "keep"

#: The advisory lock the sweep, the `--pin` CLI, teardown-trip.py and
#: vm-release.py all take, by this exact text through hashtext(), so none of
#: them can compute a different key. Held per SESSION for the whole sweep.
ADVISORY_LOCK_TEXT = "control_plane.companion_gateways"

PROFILE_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")

MODES = ("observe", "enforce", "off")

#: Trips that have not been provisioned yet have no companion to decide about.
PRE_PROVISIONING_STATES = (
    "pending_signup_approval", "draft", "intake_in_progress", "intake_confirmed",
    "planned", "provisioning_approved", "provisioning",
)

#: The relay's wake signal: a turn it could not hand to a gateway.
WAKE_OUTCOMES = ("lost_gateway_unavailable", "lost_companion_unreachable")

REASONS = (
    "INTERVIEWER", "PIN_ON", "PIN_OFF", "TEARDOWN", "RETIRED",
    "CURRENT_TRIP", "IN_WINDOW", "WAKE", "MIDTRIP_PROTECTED", "QUIET_WINDOW",
    "NOT_CURRENT_TRIP", "TRIP_ENDED",
)

#: A reason that only HOLDS a running gateway: it never justifies starting one.
HOLD_ONLY_REASONS = frozenset({"QUIET_WINDOW"})


# ── the decision ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GatewayFacts:
    """Everything decide() may know. Plain values, so a test builds one in a line."""

    profile: str
    kind: str = "companion"              # 'interviewer' | 'companion'
    trip_id: str | None = None
    retired: bool = False
    pin: str | None = None               # 'on' | 'off' | 'teardown' | None
    start_date: date | None = None
    end_date: date | None = None
    #: At least one organizer of this trip has an open private DM binding (to
    #: ANY trip). When none does, nothing constrains this trip to one-per-organizer.
    organizer_dm_known: bool = False
    #: Some organizer's DM binding points at THIS trip.
    is_current: bool = False
    #: An organizer's /switch closed the DM binding to this trip within
    #: SWITCH_WINDOW_MINUTES: their own action, so no second sweep is needed.
    switched_away: bool = False
    has_group: bool = False
    last_wake_at: datetime | None = None
    last_activity_at: datetime | None = None


@dataclass(frozen=True)
class Decision:
    desired: str                          # 'running' | 'stopped'
    reason: str
    #: True when a STOP for this reason must have been decided on two
    #: consecutive sweeps. Meaningless for a start, which never waits.
    needs_confirmation: bool = False


@dataclass(frozen=True)
class Policy:
    grace_days: int = GRACE_DAYS
    wake_days: int = WAKE_DAYS
    quiet_hours: int = QUIET_HOURS
    midtrip_family_rule: str = MIDTRIP_FAMILY_RULE


DEFAULT_POLICY = Policy()


def decide(facts: GatewayFacts, now: datetime, policy: Policy = DEFAULT_POLICY) -> Decision:
    """(desired, reason) for one gateway. Pure: no I/O, no clock, no globals."""
    if facts.kind == "interviewer":
        return Decision("running", "INTERVIEWER")
    if facts.retired:
        return Decision("stopped", "RETIRED")
    if facts.pin == "teardown":
        return Decision("stopped", "TEARDOWN")
    if facts.pin == "on":
        return Decision("running", "PIN_ON")
    if facts.pin == "off":
        return Decision("stopped", "PIN_OFF")

    today = now.astimezone(timezone.utc).date()
    midtrip = (
        facts.start_date is not None and facts.end_date is not None
        and facts.start_date <= today <= facts.end_date
    )
    window_open = facts.end_date is None or today <= facts.end_date + timedelta(days=policy.grace_days)

    if facts.organizer_dm_known and not facts.is_current:
        if facts.has_group and midtrip and policy.midtrip_family_rule == "keep":
            return Decision("running", "MIDTRIP_PROTECTED")
        base = Decision("stopped", "NOT_CURRENT_TRIP", needs_confirmation=not facts.switched_away)
    elif not window_open:
        base = Decision("stopped", "TRIP_ENDED", needs_confirmation=True)
    else:
        return Decision("running", "CURRENT_TRIP" if facts.is_current else "IN_WINDOW")

    if facts.last_wake_at is not None and now - facts.last_wake_at < timedelta(days=policy.wake_days):
        return Decision("running", "WAKE")
    if facts.last_activity_at is not None and now - facts.last_activity_at < timedelta(hours=policy.quiet_hours):
        return Decision("running", "QUIET_WINDOW")
    return base


# ── what the host reports, and how it is asked ────────────────────────────────

@dataclass(frozen=True)
class Observed:
    state: str       # 'running' | 'duplicate' | 'stopped' | 'absent'
    count: int


class GatewayHostError(RuntimeError):
    """The companion host could not be ASKED, or answered with something that is
    not a verdict. Says nothing about any gateway, so it never changes a
    recorded observation. `safe_reason` is the only text of it that is logged:
    an exit status and at most one bounded line the forced command composed."""

    def __init__(self, safe_reason: str) -> None:
        super().__init__(safe_reason)
        self.safe_reason = safe_reason


def can_reconcile(adapter: Any) -> bool:
    """Whether this adapter can ask a host about gateways: only the SSH one can."""
    return callable(getattr(adapter, "status", None))


class SshGatewayAdapter:
    """Asks, and (PR B) tells, the companion host about gateways over the same
    forced-command key every other companion request uses.

    The requests carry NAMES and a verb from a closed set, nothing else: not a
    path, not a command, not an address. The host validates them again with its
    own regex before anything runs, and answers in lines this class parses by
    FULL MATCH — another process's output is data, never a verdict by prefix.
    """

    STATUS_TIMEOUT_SECONDS = 60
    ACTION_TIMEOUT_SECONDS = 180
    MAX_PROFILES = 200
    VERBS = ("start", "stop")

    _STATUS_LINE = re.compile(r"GATEWAY ([a-z0-9][a-z0-9-]{1,62}) (running|duplicate|stopped|absent) ([0-9]{1,2})")
    _STATUS_END = re.compile(r"STATUS_END ([0-9]{1,4})")
    _ACTION_LINE = re.compile(r"ACTION ([a-z0-9][a-z0-9-]{1,62}) (start|stop) (ok|refused|failed)")
    _SCRIPT_LINE = "companion-install-host: "

    def __init__(self, host: str, user: str, key_path: str, *, port: int = 22,
                 known_hosts: str | None = None) -> None:
        self._host, self._user, self._key_path = host, user, key_path
        self._port, self._known_hosts = port, known_hosts

    def _ssh(self, payload: dict[str, Any], timeout: int, what: str) -> list[str]:
        try:
            result = subprocess.run(
                forced_command_argv(self._host, self._user, self._key_path, self._port, self._known_hosts),
                input=json.dumps(payload), capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise GatewayHostError(f"{what} over ssh timed out after {timeout}s") from None
        except OSError as exc:
            raise GatewayHostError(f"{what} over ssh could not start ({type(exc).__name__})") from None
        if result.returncode != 0:
            raise GatewayHostError(f"{what} over ssh exited {result.returncode}: {self._script_reason(result.stderr)}")
        return (result.stdout or "").splitlines()

    def status(self, profiles: Sequence[str]) -> dict[str, Observed]:
        """One call for every profile asked about: {profile: Observed}. Raises
        GatewayHostError unless the host answered for EXACTLY the profiles asked
        about and closed with a matching STATUS_END (a truncated answer is not a
        shorter list)."""
        names = list(dict.fromkeys(profiles))
        if not names or not all(PROFILE_RE.fullmatch(n) for n in names):
            raise GatewayHostError(f"refusing to ask about {len(names)} profile(s)")
        if len(names) > self.MAX_PROFILES:
            merged: dict[str, Observed] = {}
            for start in range(0, len(names), self.MAX_PROFILES):
                merged.update(self.status(names[start:start + self.MAX_PROFILES]))
            return merged
        lines = self._ssh(
            {"record_type": "companion_gateway_status", "schema_version": 1, "profiles": names},
            self.STATUS_TIMEOUT_SECONDS, "gateway status",
        )
        answers: dict[str, Observed] = {}
        ended = None
        for index, line in enumerate(lines):
            end = self._STATUS_END.fullmatch(line)
            if end:
                if index != len(lines) - 1:
                    raise GatewayHostError("gateway status had lines after its end marker")
                ended = int(end.group(1))
                continue
            match = self._STATUS_LINE.fullmatch(line)
            if not match or match.group(1) not in names or match.group(1) in answers:
                raise GatewayHostError(f"gateway status returned a line that is not a verdict (line {index + 1})")
            answers[match.group(1)] = Observed(match.group(2), int(match.group(3)))
        if ended is None or ended != len(answers) or set(answers) != set(names):
            raise GatewayHostError(
                f"gateway status answered for {len(answers)} of {len(names)} profile(s), end marker {ended}")
        return answers

    def act(self, profile: str, verb: str) -> str:
        """Start or stop one profile's gateway. Returns 'ok', 'refused' or
        'failed' as the host said; raises GatewayHostError when it was not asked."""
        if verb not in self.VERBS or not PROFILE_RE.fullmatch(profile or ""):
            raise GatewayHostError(f"refusing to {verb!r} {profile!r}")
        lines = self._ssh(
            {"record_type": "companion_gateway_action", "schema_version": 1, "action": verb,
             "profile": {"name": profile}},
            self.ACTION_TIMEOUT_SECONDS, f"gateway {verb}",
        )
        if len(lines) != 1:
            raise GatewayHostError(f"gateway {verb} returned {len(lines)} lines, not one verdict")
        match = self._ACTION_LINE.fullmatch(lines[0])
        if not match or match.group(1) != profile or match.group(2) != verb:
            raise GatewayHostError(f"gateway {verb} returned a line that is not its verdict")
        return match.group(3)

    @classmethod
    def _script_reason(cls, stderr: str | None) -> str:
        for line in reversed((stderr or "").splitlines()):
            if line.startswith(cls._SCRIPT_LINE):
                return line[:200]
        return "(no reason the forced command composed)"


# ── facts from the database ───────────────────────────────────────────────────

_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


def parse_date(text: Any) -> date | None:
    """The leading YYYY-MM-DD of `text`, or None. A departure is an ISO
    datetime, a return date a date, a portal column a date: all start the same
    way. Anything that is not a real calendar date is None, which decide() reads
    as "no dates" — the running side."""
    match = _DATE.match(str(text or ""))
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


FACTS_SQL = """
WITH named AS (
  SELECT t.hermes_profile AS profile, t.id AS trip_id, 0 AS rank FROM control_plane.trips t
   WHERE t.hermes_profile IS NOT NULL
  UNION ALL
  SELECT b.hermes_profile, b.trip_id, 1 FROM control_plane.telegram_chat_bindings b
   WHERE b.hermes_profile IS NOT NULL
), pick AS (
  SELECT DISTINCT ON (n.profile) n.profile, n.trip_id
    FROM named n JOIN control_plane.trips t ON t.id = n.trip_id
   WHERE n.profile ~ '^[a-z0-9][a-z0-9-]{1,62}$'
     AND t.lifecycle_state <> ALL(%(pre)s)
   ORDER BY n.profile, (t.slug LIKE 'retired-%%'), n.rank, t.created_at DESC
), org AS (
  SELECT DISTINCT m.trip_id, l.telegram_subject_digest AS digest
    FROM control_plane.trip_memberships m
    JOIN control_plane.telegram_organizer_links l ON l.user_id = m.user_id
   WHERE m.role IN ('owner', 'organizer') AND m.status = 'active'
), dm AS (
  SELECT b.trip_id, b.created_at, b.closed_at, b.closed_reason,
         'sha256:' || encode(sha256(convert_to(b.chat_id, 'UTF8')), 'hex') AS digest
    FROM control_plane.telegram_chat_bindings b
    JOIN control_plane.trips bt ON bt.id = b.trip_id
   WHERE b.chat_id ~ '^[0-9]{1,20}$' AND bt.slug NOT LIKE 'retired-%%'
)
SELECT p.profile, t.id AS trip_id, t.slug,
       (t.slug LIKE 'retired-%%' OR EXISTS (
          SELECT 1 FROM control_plane.telegram_chat_bindings d
           WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')) AS retired,
       t.start_date::text AS start_date, t.end_date::text AS end_date,
       t.plan_snapshot #>> '{meta,departure}' AS departure,
       t.plan_snapshot #>> '{meta,returnDate}' AS return_date,
       EXISTS (SELECT 1 FROM org o JOIN dm ON dm.digest = o.digest AND dm.closed_at IS NULL
                WHERE o.trip_id = t.id) AS organizer_dm_known,
       EXISTS (SELECT 1 FROM org o JOIN dm ON dm.digest = o.digest AND dm.closed_at IS NULL AND dm.trip_id = t.id
                WHERE o.trip_id = t.id) AS is_current,
       EXISTS (SELECT 1 FROM org o JOIN dm ON dm.digest = o.digest AND dm.trip_id = t.id
                WHERE o.trip_id = t.id AND dm.closed_reason = 'organizer_switch'
                  AND dm.closed_at > %(switch_since)s) AS switched_away,
       EXISTS (SELECT 1 FROM control_plane.telegram_chat_bindings g
                WHERE g.trip_id = t.id AND g.closed_at IS NULL AND g.chat_id !~ '^[0-9]{1,20}$') AS has_group,
       (SELECT max(e.occurred_at) FROM control_plane.assistant_events e
         WHERE e.trip_id = t.id AND e.event_type = 'turn_lost' AND e.outcome = ANY(%(wake)s)
           AND e.occurred_at > %(wake_since)s) AS last_wake_at,
       (SELECT max(e.occurred_at) FROM control_plane.assistant_events e
         WHERE e.trip_id = t.id AND e.occurred_at > %(quiet_since)s) AS last_activity_at,
       g.pin
  FROM pick p
  JOIN control_plane.trips t ON t.id = p.trip_id
  LEFT JOIN control_plane.companion_gateways g ON g.hermes_profile = p.profile
 ORDER BY p.profile
"""


def load_facts(conn: Any, now: datetime, interviewer_profile: str = INTERVIEWER_PROFILE,
               policy: Policy = DEFAULT_POLICY) -> list[GatewayFacts]:
    """One GatewayFacts per managed profile: the interviewer, then every
    companion profile the control plane has named for a provisioned trip."""
    rows = conn.execute(FACTS_SQL, {
        "pre": list(PRE_PROVISIONING_STATES),
        "wake": list(WAKE_OUTCOMES),
        "switch_since": now - timedelta(minutes=SWITCH_WINDOW_MINUTES),
        "wake_since": now - timedelta(days=policy.wake_days),
        "quiet_since": now - timedelta(hours=policy.quiet_hours),
    }).fetchall()
    out = [GatewayFacts(profile=interviewer_profile, kind="interviewer")]
    for row in rows:
        if row["profile"] == interviewer_profile:
            continue  # a trip row naming the interviewer's profile must not demote it
        out.append(GatewayFacts(
            profile=row["profile"], kind="companion", trip_id=row["trip_id"],
            retired=bool(row["retired"]), pin=row["pin"],
            start_date=parse_date(row["departure"]) or parse_date(row["start_date"]),
            end_date=parse_date(row["return_date"]) or parse_date(row["end_date"]),
            organizer_dm_known=bool(row["organizer_dm_known"]), is_current=bool(row["is_current"]),
            switched_away=bool(row["switched_away"]), has_group=bool(row["has_group"]),
            last_wake_at=row["last_wake_at"], last_activity_at=row["last_activity_at"],
        ))
    return out


# ── the pin, shared by the CLI and (PR B) teardown ─────────────────────────────

def advisory_lock(conn: Any, *, wait_seconds: float = 0.0, sleep: Callable[[float], None] = time.sleep) -> bool:
    """Takes the session-level advisory lock; True if held. With wait_seconds it
    retries (a pin must not be lost to a sweep that happens to be running);
    without, it returns at once (a sweep that finds another running skips)."""
    deadline = time.monotonic() + wait_seconds
    while True:
        row = conn.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS got", (ADVISORY_LOCK_TEXT,)).fetchone()
        if row["got"]:
            return True
        if time.monotonic() >= deadline:
            return False
        sleep(1.0)


def advisory_unlock(conn: Any) -> None:
    conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (ADVISORY_LOCK_TEXT,))


# ── the sweep ─────────────────────────────────────────────────────────────────

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def backoff_minutes(failures: int) -> int:
    """5, 10, 20, 40, then an hour: a gateway that will not start is retried
    less and less often, never hammered."""
    return min(BACKOFF_CAP_MINUTES, BACKOFF_BASE_MINUTES * (2 ** max(0, failures - 1)))


class GatewayReconcileSweep:
    """Decide, record, and — in `enforce` mode only — act. See the module doc.

    One instance per worker process. `maybe_run` is what the poll loop calls on
    an idle poll: it runs a sweep when the interval has passed, or sooner when a
    cheap read of the database says something happened that a sweep must not
    wait for (an organizer's /switch opened a DM binding, or the relay recorded
    a lost turn — the wake signal). No HTTP route, no new writer in the API: the
    API's existing writes ARE the hint.
    """

    def __init__(
        self,
        db_url: str,
        adapter: Any,
        *,
        mode: str = "observe",
        interval_minutes: float = 5.0,
        hint_seconds: float = 30.0,
        min_gap_seconds: float = 30.0,
        interviewer_profile: str = INTERVIEWER_PROFILE,
        policy: Policy = DEFAULT_POLICY,
        clock: Callable[[], float] = time.monotonic,
        now_fn: Callable[[], datetime] = _utcnow,
    ) -> None:
        if mode not in MODES:
            raise ValueError(f"gateway reconcile mode must be one of {', '.join(MODES)}, not {mode!r}")
        self._db_url, self._adapter, self.mode = db_url, adapter, mode
        self._interval = max(0.0, float(interval_minutes)) * 60
        self._hint_seconds, self._min_gap = float(hint_seconds), float(min_gap_seconds)
        self._interviewer, self._policy = interviewer_profile, policy
        self._clock, self._now = clock, now_fn
        self._last: float | None = None
        self._last_hint_check: float | None = None
        self._watermark: tuple[Any, Any, Any] | None = None
        self._warned_blind = False
        self.enabled = mode != "off" and self._interval > 0 and can_reconcile(adapter)

    # -- startup line ---------------------------------------------------------

    def describe(self) -> str:
        if self.enabled:
            return (f"gateway reconcile: {self.mode.upper()} every {self._interval / 60:g} min "
                    f"(+ a switch/wake hint every {self._hint_seconds:g}s) over the companion forced command"
                    + (" — records and reports, acts on nothing" if self.mode == "observe" else ""))
        if self.mode == "off":
            return "gateway reconcile: OFF (--gateway-reconcile-mode off)"
        if self._interval <= 0:
            return "gateway reconcile: OFF (--gateway-reconcile-minutes 0)"
        return (f"gateway reconcile: OFF ({type(self._adapter).__name__} cannot ask a host about gateways — "
                "no companion SSH host is configured)")

    # -- scheduling -----------------------------------------------------------

    def maybe_run(self, should_stop: Callable[[], bool] = lambda: False) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        now = self._clock()
        due = self._last is None or now - self._last >= self._interval
        if not due:
            if now - self._last < self._min_gap:  # type: ignore[operator]
                return None
            if self._last_hint_check is not None and now - self._last_hint_check < self._hint_seconds:
                return None
            self._last_hint_check = now
            try:
                due = self._hint_pending()
            except Exception as exc:  # a failed hint is only a missed shortcut
                logger.warning(log_fields("gateway_reconcile.hint_failed", error=type(exc).__name__))
                return None
            if not due:
                return None
            logger.info(log_fields("gateway_reconcile.hinted", effect="running a sweep ahead of its interval"))
        if self._watermark is None:
            # The hint's baseline is taken BEFORE the sweep, so anything that
            # happens while it runs is seen by the next look rather than lost.
            try:
                self._hint_pending()
            except Exception:  # noqa: BLE001 - the baseline is a convenience, the sweep is not
                pass
        # Stamped BEFORE the sweep, so one that raises still waits its interval.
        self._last = now
        self._last_hint_check = now
        return self.run(should_stop)

    def _connect(self) -> Any:
        import psycopg
        from psycopg.rows import dict_row

        conn = psycopg.connect(self._db_url, row_factory=dict_row, autocommit=True, connect_timeout=10)
        try:
            conn.execute(f"SET statement_timeout = {int(STATEMENT_TIMEOUT_MS)}")
        except Exception:
            conn.close()
            raise
        return conn

    def _hint_pending(self) -> bool:
        """True when a binding was opened (a /switch, a new trip) or a wake
        signal was recorded since the last look. The first look only sets the
        baseline — the sweep that is about to run, or just ran, covers the past."""
        with self._connect() as conn:
            row = conn.execute(
                """SELECT (SELECT max(created_at) FROM control_plane.telegram_chat_bindings) AS binding,
                          (SELECT max(closed_at) FROM control_plane.telegram_chat_bindings
                            WHERE closed_reason = 'organizer_switch') AS switched,
                          (SELECT max(occurred_at) FROM control_plane.assistant_events
                            WHERE event_type = 'turn_lost' AND outcome = ANY(%s)
                              AND occurred_at > now() - interval '3 days') AS lost""",
                (list(WAKE_OUTCOMES),),
            ).fetchone()
        mark = (row["binding"], row["switched"], row["lost"])
        previous, self._watermark = self._watermark, mark
        return previous is not None and mark != previous

    # -- one sweep ------------------------------------------------------------

    def run(self, should_stop: Callable[[], bool] = lambda: False, *,
            dry_run: bool = False) -> dict[str, Any]:
        """One sweep. `dry_run` reads and decides and asks the host, and writes
        and acts on NOTHING: it is the operator's "what would you do" and it is
        always observe, whatever the configured mode."""
        mode = "observe" if dry_run else self.mode
        now = self._now()
        summary: dict[str, Any] = {
            "mode": "dry_run" if dry_run else mode, "profiles": 0, "running": 0, "stopped": 0,
            "changed": 0, "starts": 0, "stops": 0, "failed": 0, "deferred": 0,
            "would_start": [], "would_stop": [], "duplicates": [], "result": "ok",
        }
        conn = self._connect()
        locked = False
        try:
            locked = advisory_lock(conn)
            if not locked:
                summary["result"] = "lock_busy"
                logger.info(log_fields("gateway_reconcile.skipped", reason="another holder has the advisory lock "
                                       "(a teardown, a release, a pin, or a sweep)"))
                return summary
            self._sweep(conn, now, mode, summary, should_stop, write=not dry_run)
        except GatewayHostError as exc:
            summary["result"] = "host_unreachable"
            logger.warning(log_fields(
                "gateway_reconcile.host_unreachable", error=exc.safe_reason,
                effect="no observation recorded and nothing started or stopped this sweep"))
        except Exception as exc:
            summary["result"] = "error"
            logger.error(log_fields("gateway_reconcile.error", error=type(exc).__name__,
                                    effect="this sweep is abandoned; the next one starts from the database"))
        finally:
            try:
                if not dry_run and summary["result"] != "lock_busy":
                    self._event(conn, "SWEEP", mode=mode, result=summary["result"],
                                profiles=summary["profiles"], actions=summary["starts"] + summary["stops"])
                    self._prune(conn)
            except Exception as exc:  # the heartbeat must not mask the sweep's own outcome
                logger.warning(log_fields("gateway_reconcile.heartbeat_failed", error=type(exc).__name__))
            try:
                if locked:
                    advisory_unlock(conn)
            finally:
                conn.close()
        logger.info(log_fields(
            "gateway_reconcile.sweep",
            **{k: v for k, v in summary.items() if not isinstance(v, list)},
            would_start=",".join(summary["would_start"]), would_stop=",".join(summary["would_stop"]),
            duplicates=",".join(summary["duplicates"]),
        ))
        return summary

    def _sweep(self, conn: Any, now: datetime, mode: str, summary: dict[str, Any],
               should_stop: Callable[[], bool], *, write: bool) -> None:
        facts = load_facts(conn, now, self._interviewer, self._policy)
        decisions = {f.profile: (f, decide(f, now, self._policy)) for f in facts}
        summary["profiles"] = len(decisions)
        summary["running"] = sum(1 for _, d in decisions.values() if d.desired == "running")
        summary["stopped"] = summary["profiles"] - summary["running"]
        self._warn_if_wake_blind(conn, now)

        rows = {r["hermes_profile"]: r for r in conn.execute("SELECT * FROM control_plane.companion_gateways").fetchall()}
        if write:
            for profile, (f, d) in decisions.items():
                rows[profile] = self._record_decision(conn, rows.get(profile), f, d, now, summary)

        observed = self._adapter.status(list(decisions))  # may raise GatewayHostError: nothing below runs
        if write:
            for profile, obs in observed.items():
                rows[profile] = self._record_observation(conn, rows.get(profile), decisions[profile][1], obs, now)

        # What would be done, from the DECISION and the observation alone — so
        # observe and dry-run report the same list enforce would act on, and a
        # steady fleet reports an empty one.
        todo = self._plan(decisions, observed, rows, now)
        for item in todo:
            summary["would_start" if item["action"] == "start" else "would_stop"].append(item["profile"])
        summary["duplicates"] = sorted(p for p, o in observed.items() if o.state == "duplicate")
        if mode != "enforce" or not write:
            return

        errors_in_a_row = 0
        for item in todo:
            if should_stop():
                break
            if summary["starts"] + summary["stops"] >= MAX_ACTIONS_PER_SWEEP:
                summary["deferred"] += 1
                continue
            profile, verb = item["profile"], item["action"]
            try:
                result = self._adapter.act(profile, verb)
            except GatewayHostError as exc:
                errors_in_a_row += 1
                summary["failed"] += 1
                logger.warning(log_fields("gateway_reconcile.action_error", profile=profile, action=verb,
                                          error=exc.safe_reason))
                self._record_action(conn, profile, decisions[profile][0].trip_id, verb, "failed", now, rows[profile])
                if errors_in_a_row >= BREAKER_AFTER:
                    summary["result"] = "host_unreachable"
                    logger.warning(log_fields("gateway_reconcile.sweep_aborted", after=errors_in_a_row,
                                              effect="the host is not answering; the rest of this sweep is skipped"))
                    break
                continue
            errors_in_a_row = 0
            summary["starts" if verb == "start" else "stops"] += 1
            if result != "ok":
                summary["failed"] += 1
            self._record_action(conn, profile, decisions[profile][0].trip_id, verb, result, now, rows[profile])
            logger.info(log_fields("gateway_reconcile.action", profile=profile, action=verb, result=result,
                                   reason=decisions[profile][1].reason))

    # -- the plan: pure given the records -------------------------------------

    @staticmethod
    def _plan(decisions: Mapping[str, tuple[GatewayFacts, Decision]], observed: Mapping[str, Observed],
              rows: Mapping[str, Mapping[str, Any]], now: datetime) -> list[dict[str, str]]:
        """Starts first (the interviewer first of them), then stops; each in
        profile order. A profile on backoff, an unconfirmed flap-prone stop, a
        hold-only reason, a duplicate and an absent profile produce nothing."""
        starts, stops = [], []
        for profile in sorted(decisions, key=lambda p: (decisions[p][0].kind != "interviewer", p)):
            facts, decision = decisions[profile]
            obs = observed.get(profile)
            row = rows.get(profile) or {}
            if obs is None or obs.state in ("duplicate", "absent"):
                continue
            wait = row.get("next_attempt_at")
            if wait is not None and wait > now:
                continue
            if decision.desired == "running" and obs.state == "stopped" and decision.reason not in HOLD_ONLY_REASONS:
                starts.append({"profile": profile, "action": "start"})
            elif decision.desired == "stopped" and obs.state == "running":
                confirmed = int(row.get("confirmations") or 1) >= STOP_CONFIRMATIONS
                if confirmed or not decision.needs_confirmation:
                    stops.append({"profile": profile, "action": "stop"})
        return starts + stops

    # -- records --------------------------------------------------------------

    def _event(self, conn: Any, event: str, **cols: Any) -> None:
        names = ["event", *cols]
        conn.execute(
            f"INSERT INTO control_plane.companion_gateway_events ({', '.join(names)}) "
            f"VALUES ({', '.join(['%s'] * len(names))})",
            [event, *cols.values()],
        )

    def _record_decision(self, conn: Any, row: Mapping[str, Any] | None, facts: GatewayFacts, d: Decision,
                         now: datetime, summary: dict[str, Any]) -> Mapping[str, Any]:
        mode = self.mode if self.mode != "off" else "observe"
        if row is None:
            row = conn.execute(
                """INSERT INTO control_plane.companion_gateways
                     (hermes_profile, trip_id, kind, desired, reason, decided_at, confirmations)
                   VALUES (%s, %s, %s, %s, %s, %s, 1) RETURNING *""",
                (facts.profile, facts.trip_id, facts.kind, d.desired, d.reason, now),
            ).fetchone()
            self._event(conn, "DECIDED", mode=mode, hermes_profile=facts.profile, trip_id=facts.trip_id,
                        desired=d.desired, reason=d.reason)
            summary["changed"] += 1
            return row
        if row["desired"] != d.desired:
            row = conn.execute(
                """UPDATE control_plane.companion_gateways
                      SET desired = %s, reason = %s, decided_at = %s, confirmations = 1, trip_id = %s,
                          kind = %s, updated_at = now()
                    WHERE hermes_profile = %s RETURNING *""",
                (d.desired, d.reason, now, facts.trip_id, facts.kind, facts.profile),
            ).fetchone()
        elif row["reason"] != d.reason:
            row = conn.execute(
                """UPDATE control_plane.companion_gateways
                      SET reason = %s, trip_id = %s, kind = %s, updated_at = now()
                    WHERE hermes_profile = %s RETURNING *""",
                (d.reason, facts.trip_id, facts.kind, facts.profile),
            ).fetchone()
        elif int(row["confirmations"]) < STOP_CONFIRMATIONS:
            row = conn.execute(
                """UPDATE control_plane.companion_gateways
                      SET confirmations = confirmations + 1, trip_id = %s, kind = %s, updated_at = now()
                    WHERE hermes_profile = %s RETURNING *""",
                (facts.trip_id, facts.kind, facts.profile),
            ).fetchone()
            return row
        else:
            if row["trip_id"] != facts.trip_id:
                row = conn.execute(
                    "UPDATE control_plane.companion_gateways SET trip_id = %s, updated_at = now() "
                    "WHERE hermes_profile = %s RETURNING *", (facts.trip_id, facts.profile),
                ).fetchone()
            return row
        self._event(conn, "DECIDED", mode=mode, hermes_profile=facts.profile, trip_id=facts.trip_id,
                    desired=d.desired, reason=d.reason)
        summary["changed"] += 1
        logger.info(log_fields("gateway_reconcile.decided", profile=facts.profile, desired=d.desired, reason=d.reason))
        return row

    def _record_observation(self, conn: Any, row: Mapping[str, Any], d: Decision, obs: Observed,
                            now: datetime) -> Mapping[str, Any]:
        mode = self.mode if self.mode != "off" else "observe"
        profile = row["hermes_profile"]
        changed = row["observed"] != obs.state or row["observed_count"] != obs.count
        if changed:
            row = conn.execute(
                """UPDATE control_plane.companion_gateways
                      SET observed = %s, observed_count = %s, observed_at = %s, updated_at = now()
                    WHERE hermes_profile = %s RETURNING *""",
                (obs.state, obs.count, now, profile),
            ).fetchone()
            self._event(conn, "OBSERVED", mode=mode, hermes_profile=profile, trip_id=row["trip_id"],
                        observed=obs.state)
        wanted = "running" if d.desired == "running" else "stopped"
        converged = (obs.state == "running") == (wanted == "running") and obs.state != "duplicate"
        if converged and (row["failures"] or row["next_attempt_at"] is not None):
            return conn.execute(
                "UPDATE control_plane.companion_gateways SET failures = 0, next_attempt_at = NULL, "
                "updated_at = now() WHERE hermes_profile = %s RETURNING *", (profile,),
            ).fetchone()
        # An action that said ok and changed nothing: record it as it is, so
        # the backoff applies — a gateway that exits at once is never restarted
        # on every sweep.
        needed = "start" if d.desired == "running" else "stop"
        if (not converged and row["last_action"] == needed and row["last_result"] == "ok"
                and obs.state in ("running", "stopped")):
            failures = int(row["failures"]) + 1
            return conn.execute(
                """UPDATE control_plane.companion_gateways
                      SET last_result = 'not_converged', failures = %s, next_attempt_at = %s, updated_at = now()
                    WHERE hermes_profile = %s RETURNING *""",
                (min(failures, 99), now + timedelta(minutes=backoff_minutes(failures)), profile),
            ).fetchone()
        return row

    def _record_action(self, conn: Any, profile: str, trip_id: str | None, verb: str, result: str,
                       now: datetime, row: Mapping[str, Any]) -> None:
        failures = 0 if result == "ok" else min(int(row["failures"]) + 1, 99)
        conn.execute(
            """UPDATE control_plane.companion_gateways
                  SET last_action = %s, last_action_at = %s, last_result = %s, failures = %s,
                      next_attempt_at = %s, updated_at = now()
                WHERE hermes_profile = %s""",
            (verb, now, result, failures,
             None if result == "ok" else now + timedelta(minutes=backoff_minutes(failures)), profile),
        )
        self._event(conn, "ACTION", mode="enforce", hermes_profile=profile, trip_id=trip_id,
                    action=verb, result=result)

    def _prune(self, conn: Any) -> None:
        conn.execute(
            "DELETE FROM control_plane.companion_gateway_events WHERE occurred_at < %s",
            (self._now() - timedelta(days=EVENT_RETENTION_DAYS),),
        )

    def _warn_if_wake_blind(self, conn: Any, now: datetime) -> None:
        """The wake path reads the relay's lost-turn events, which exist only when
        the relay runs with ASSISTANT_EVENTS_ENABLED=1. With it off, a family
        message to a stopped companion is lost and nothing here can start it —
        the quiet failure this exists to make loud, once per process."""
        if self._warned_blind:
            return
        row = conn.execute(
            "SELECT count(*) AS n FROM control_plane.assistant_events WHERE occurred_at > %s",
            (now - timedelta(days=7),),
        ).fetchone()
        if row["n"] == 0:
            self._warned_blind = True
            logger.warning(log_fields(
                "gateway_reconcile.wake_signal_blind", events_7d=0,
                effect="no assistant event was recorded in 7 days, so a message to a stopped companion cannot wake it "
                       "(is the relay running with ASSISTANT_EVENTS_ENABLED=1?)"))


# ── operator pin ──────────────────────────────────────────────────────────────

def set_pin(db_url: str, adapter: Any, profile: str, pin: str, *, now: datetime | None = None,
            lock_wait_seconds: float = 60.0) -> dict[str, Any]:
    """`reconcile-gateways --pin PROFILE on|off|clear`: the operator's override,
    written under the advisory lock so a sweep cannot be mid-flight, and applied
    to the recorded decision at once (the next enforce sweep acts on it).

    Only a profile the control plane manages can be pinned: a name nobody has
    ever bound to a provisioned trip is refused, not created. `teardown` is not
    available here — it belongs to scripts/teardown-trip.py."""
    import psycopg
    from psycopg.rows import dict_row

    if pin not in ("on", "off", "clear"):
        raise ValueError(f"pin must be on, off or clear, not {pin!r}")
    if not PROFILE_RE.fullmatch(profile or ""):
        raise ValueError(f"not a profile name: {profile!r}")
    when = now or _utcnow()
    with psycopg.connect(db_url, row_factory=dict_row, autocommit=True, connect_timeout=10) as conn:
        conn.execute(f"SET statement_timeout = {int(STATEMENT_TIMEOUT_MS)}")
        if not advisory_lock(conn, wait_seconds=lock_wait_seconds):
            raise RuntimeError("could not take the companion gateway lock (a sweep, teardown or release holds it)")
        try:
            sweep = GatewayReconcileSweep("-", adapter, mode="observe", interval_minutes=0, now_fn=lambda: when)
            facts = {f.profile: f for f in load_facts(conn, when)}
            current = facts.get(profile)
            if current is None:
                raise ValueError(f"{profile!r} is not a gateway the control plane manages")
            if current.kind == "interviewer":
                raise ValueError("the interviewer always runs and cannot be pinned")
            if current.pin == "teardown":
                raise ValueError(f"{profile!r} is pinned by a teardown in progress; that is not an operator's to clear")
            summary = {"changed": 0}
            row = conn.execute("SELECT * FROM control_plane.companion_gateways WHERE hermes_profile = %s",
                               (profile,)).fetchone()
            new_pin = None if pin == "clear" else pin
            decided = decide(replace(current, pin=new_pin), when)
            row = sweep._record_decision(conn, row, replace(current, pin=new_pin), decided, when, summary)
            conn.execute(
                "UPDATE control_plane.companion_gateways SET pin = %s, pin_set_at = %s, updated_at = now() "
                "WHERE hermes_profile = %s",
                (new_pin, when if new_pin else None, profile),
            )
            sweep._event(conn, "PIN", hermes_profile=profile, trip_id=current.trip_id, pin=pin)
            return {"profile": profile, "pin": pin, "desired": decided.desired, "reason": decided.reason}
        finally:
            advisory_unlock(conn)


# ── a human-readable plan for the CLI ─────────────────────────────────────────

def format_plan(summary: Mapping[str, Any]) -> str:
    lines = [f"gateway reconcile ({summary['mode']}): {summary['profiles']} profile(s), "
             f"{summary['running']} should run, {summary['stopped']} should not — result {summary['result']}"]
    for key, label in (("would_start", "would start"), ("would_stop", "would stop"), ("duplicates", "DUPLICATE")):
        if summary.get(key):
            lines.append(f"  {label}: {', '.join(summary[key])}")
    if not any(summary.get(k) for k in ("would_start", "would_stop", "duplicates")):
        lines.append("  nothing to do: every observed gateway matches its decision")
    return "\n".join(lines)
