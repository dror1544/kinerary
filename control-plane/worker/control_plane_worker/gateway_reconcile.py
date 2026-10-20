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

THE RULE (owner decisions, 2026-10-20, final), in the order decide() applies it
to a trip companion (the interviewer always runs; a retired trip, a `teardown`
pin and the operator's `on`/`off` pin come first):

  1. CURRENT_TRIP. The trip is the current trip of ANY of its organizers: an
     open private-chat binding of theirs points at it (the /switch target;
     "organizer" is an active owner/organizer membership, matched to the chat
     by the same sha256 digest the API uses). It runs, unless it is past its
     end date + GRACE_DAYS (14), which is rule 5.
  2. WARM. It was an organizer's current trip and they switched away (the
     binding closed by /switch, or the chat was bound to another trip) less
     than WARM_DAYS (2) ago. It keeps running for those two days, unless it is
     already past its grace: an archived trip is archived even if it was just
     current.
  3. UNDERWAY. start_date <= today <= end_date. It runs whatever its
     organizer is looking at.
  4. REVIVED. A user asked for it less than REVIVE_DAYS (2) ago: a message
     reached it while it was off (the relay recorded a lost turn), or an
     organizer of it opened a private-chat binding to it (a /switch to an
     archived trip). It runs, alongside whatever else runs: a revival never
     stops another trip.
  5. ARCHIVED. Today is past end_date + 14 days. Stopped.
  6. NOT_CURRENT. Anything else: planned, or ended within its grace, and not
     current, not warm, not underway, not revived; or no dates and not
     current. Stopped.
  A stop (5 or 6) is HELD for QUIET_HOURS (6) after any conversation with the
  trip (reason QUIET_WINDOW). The hold only holds: it never starts a gateway.

There is no limit on how many companions an organizer has running while their
trips are underway or warm; what bounds the fleet is the current trip, the
warm window, the dates and the revival.

A PROFILE CAN BE NAMED BY SEVERAL TRIPS (a slug freed by teardown can be reused
by a new trip with the same profile name). decide() is per trip; the profile
runs if ANY trip naming it says run, and the record says which trips justify it
(`justified_by`). Only if every trip says stop does it stop.

WHAT COUNTS AS DORMANT. Other systems skip a "dormant" companion (the relay's
startup wait, the release tool's verify and restart-bridges, the fleet monitor):
that is a gateway the reconciler has actually stopped and the host has
confirmed stopped - last_action = 'stop', last_result = 'ok', observed
stopped/absent, desired stopped. A desired-stopped gateway that is running, or
that nobody has stopped (observe mode never does), is still expected. To make
convergence real in enforce mode the sweep sends an idempotent `stop` for a
desired-stopped gateway it finds already stopped but has not yet recorded a
confirmed stop for (the host answers ok without touching anything).

THE LOCK IS NOT HELD ACROSS THE NETWORK. The sweep takes the advisory lock to
decide and record, releases it around every call to the host (a status read can
take a minute, an action three), and re-takes it to record the result - so
`kinerary-cp-release` and `teardown-trip.py`, which wait two minutes for it,
are never starved. Before each action it re-takes the lock and re-decides that
one profile; if the answer changed (a pin landed) the action is dropped.

WHY STARTS ARE NOT DEBOUNCED BUT STOPS ARE. A wrongly started gateway costs a
process for a few minutes; a wrongly stopped one is a dark companion for a
family. So a start acts at once, and a stop that a date or a clock decides
(ARCHIVED, NOT_CURRENT) must have been decided on two consecutive sweeps.
Retired, teardown and operator stops are certain and act at once. A /switch
does not stop the trip it leaves: it becomes WARM for two days first.

Every log line carries its facts in the message text (`log_fields`): the
worker's format prints the message and drops `extra` (#292).
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping, Sequence

from .companion_profile import forced_command_argv
from .mcp_bridge import log_fields

logger = logging.getLogger(__name__)

# ── policy ────────────────────────────────────────────────────────────────────

GRACE_DAYS = 14
WARM_DAYS = 2
REVIVE_DAYS = 2
QUIET_HOURS = 6
#: Consecutive sweeps a flap-prone stop must be decided before it is acted on.
STOP_CONFIRMATIONS = 2
MAX_ACTIONS_PER_SWEEP = 3
BACKOFF_BASE_MINUTES = 5
BACKOFF_CAP_MINUTES = 60
#: A host that does not answer this many times in a row ends the sweep.
BREAKER_AFTER = 3
EVENT_RETENTION_DAYS = 90
#: How long the sweep waits to RE-take the lock between host calls before it
#: abandons the sweep (a release or teardown holds it that long at most).
LOCK_REWAIT_SECONDS = 30
STATEMENT_TIMEOUT_MS = 5000
INTERVIEWER_PROFILE = "trip-intake"

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

#: The relay's revive signal: a turn it could not hand to a gateway.
WAKE_OUTCOMES = ("lost_gateway_unavailable", "lost_companion_unreachable")

REASONS = (
    "INTERVIEWER", "PIN_ON", "PIN_OFF", "TEARDOWN", "RETIRED",
    "CURRENT_TRIP", "WARM", "UNDERWAY", "REVIVED", "QUIET_WINDOW", "ARCHIVED", "NOT_CURRENT",
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
    slug: str | None = None              # the trip's slug, for the bridge check before a start
    retired: bool = False
    pin: str | None = None               # 'on' | 'off' | 'teardown' | None - only a pin set FOR THIS TRIP
    start_date: date | None = None
    end_date: date | None = None
    #: Some organizer's open private-chat binding points at THIS trip.
    is_current: bool = False
    #: When an organizer last stopped having this as their current trip (their
    #: binding closed by /switch, or the chat bound elsewhere), within
    #: WARM_DAYS; None if they did not.
    warm_at: datetime | None = None
    #: When an organizer of this trip last opened a private-chat binding to it
    #: (a /switch to it), within REVIVE_DAYS; None if none did. For a trip
    #: still inside its grace this is also CURRENT_TRIP; for an archived one it
    #: is the ask that revives it.
    switched_at: datetime | None = None
    #: When the relay last lost a turn for this trip because no gateway took it
    #: (a message to a stopped companion), within REVIVE_DAYS; None if none.
    asked_at: datetime | None = None
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
    warm_days: int = WARM_DAYS
    revive_days: int = REVIVE_DAYS
    quiet_hours: int = QUIET_HOURS


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
    past_grace = facts.end_date is not None and today > facts.end_date + timedelta(days=policy.grace_days)

    if facts.is_current and not past_grace:
        return Decision("running", "CURRENT_TRIP")
    if (facts.warm_at is not None and now - facts.warm_at < timedelta(days=policy.warm_days)
            and not past_grace):
        return Decision("running", "WARM")
    if facts.start_date is not None and facts.end_date is not None and facts.start_date <= today <= facts.end_date:
        return Decision("running", "UNDERWAY")
    asks = [t for t in (facts.asked_at, facts.switched_at) if t is not None]
    if asks and now - max(asks) < timedelta(days=policy.revive_days):
        return Decision("running", "REVIVED")

    # A stop, held back for a conversation that is still warm.
    if facts.last_activity_at is not None and now - facts.last_activity_at < timedelta(hours=policy.quiet_hours):
        return Decision("running", "QUIET_WINDOW")
    return Decision("stopped", "ARCHIVED" if past_grace else "NOT_CURRENT", needs_confirmation=True)


#: Which running reason to report when several trips want a profile up.
_RUN_RANK = {r: i for i, r in enumerate(
    ("INTERVIEWER", "PIN_ON", "CURRENT_TRIP", "UNDERWAY", "WARM", "REVIVED", "QUIET_WINDOW"))}
#: Which stop reason to report when every trip says stop (live trips first).
_STOP_RANK = {r: i for i, r in enumerate(("TEARDOWN", "PIN_OFF", "ARCHIVED", "NOT_CURRENT", "RETIRED"))}


@dataclass(frozen=True)
class ProfileDecision:
    """The decision for one PROFILE, which may be named by several trips."""

    profile: str
    kind: str
    desired: str
    reason: str
    needs_confirmation: bool
    #: The trip that justifies the decision (the best running one, else the
    #: newest live one); the slug is the one the host checks a bridge for.
    trip_id: str | None = None
    slug: str | None = None
    #: Every trip that says run (empty when the profile is stopped).
    justified_by: tuple[str, ...] = ()


def decide_profile(group: Sequence[GatewayFacts], now: datetime, policy: Policy = DEFAULT_POLICY) -> ProfileDecision:
    """One decision per profile from one decision per trip naming it.

    A profile runs if ANY trip naming it says run: a stale or archived trip that
    happens to share the profile name must never stop a live one. It stops only
    when every trip says stop, and then the reason comes from the live trips
    (a retired trip's RETIRED only speaks when nothing live names the profile).
    Pure, like decide()."""
    decided = [(f, decide(f, now, policy)) for f in group]
    first = group[0]
    running = sorted(((f, d) for f, d in decided if d.desired == "running"), key=lambda fd: _RUN_RANK[fd[1].reason])
    if running:
        best_f, best_d = running[0]
        return ProfileDecision(first.profile, first.kind, "running", best_d.reason, False, best_f.trip_id, best_f.slug,
                               tuple(f.trip_id for f, _ in running if f.trip_id))
    live = [(f, d) for f, d in decided if not f.retired] or decided
    live.sort(key=lambda fd: _STOP_RANK.get(fd[1].reason, 99))
    f0, d0 = live[0]
    return ProfileDecision(first.profile, first.kind, "stopped", d0.reason,
                           all(d.needs_confirmation for _, d in live), f0.trip_id, f0.slug, ())


def group_by_profile(facts: Iterable[GatewayFacts]) -> dict[str, list[GatewayFacts]]:
    groups: dict[str, list[GatewayFacts]] = {}
    for f in facts:
        groups.setdefault(f.profile, []).append(f)
    return groups


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

    _SLUG_RE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
    _BACKFILL_LINE = re.compile(r"BACKFILL ([a-z0-9][a-z0-9-]{1,62}) (marked|already|refused|absent)")
    _BACKFILL_END = re.compile(r"BACKFILL_END ([0-9]{1,4})")

    def backfill(self, profiles: Sequence[str]) -> dict[str, str]:
        """Ask the host to write the provenance marker into profiles that exist
        and are not on its deny list: {profile: marked|already|refused|absent}.
        Same discipline as `status`: exactly the names asked, a closing count."""
        names = list(dict.fromkeys(profiles))
        if not names or len(names) > self.MAX_PROFILES or not all(PROFILE_RE.fullmatch(n) for n in names):
            raise GatewayHostError(f"refusing to backfill {len(names)} profile(s)")
        lines = self._ssh(
            {"record_type": "companion_gateway_backfill", "schema_version": 1, "profiles": names},
            self.STATUS_TIMEOUT_SECONDS, "gateway backfill",
        )
        out: dict[str, str] = {}
        ended = None
        for index, line in enumerate(lines):
            end = self._BACKFILL_END.fullmatch(line)
            if end:
                if index != len(lines) - 1:
                    raise GatewayHostError("gateway backfill had lines after its end marker")
                ended = int(end.group(1))
                continue
            match = self._BACKFILL_LINE.fullmatch(line)
            if not match or match.group(1) not in names or match.group(1) in out:
                raise GatewayHostError(f"gateway backfill returned a line that is not a verdict (line {index + 1})")
            out[match.group(1)] = match.group(2)
        if ended is None or ended != len(out) or set(out) != set(names):
            raise GatewayHostError(f"gateway backfill answered for {len(out)} of {len(names)} profile(s)")
        return out

    def act(self, profile: str, verb: str, slug: str | None = None) -> str:
        """Start or stop one profile's gateway. Returns 'ok', 'refused' or
        'failed' as the host said; raises GatewayHostError when it was not asked.
        `slug`, for a start, names the trip whose trip-mcp bridge the host checks
        (and restarts if it is not answering) before the gateway starts."""
        if verb not in self.VERBS or not PROFILE_RE.fullmatch(profile or ""):
            raise GatewayHostError(f"refusing to {verb!r} {profile!r}")
        if slug is not None and (verb != "start" or not self._SLUG_RE.fullmatch(slug) or len(slug) > 80):
            raise GatewayHostError(f"refusing to {verb} {profile!r} with slug {slug!r}")
        payload = {"record_type": "companion_gateway_action", "schema_version": 1, "action": verb,
                   "profile": {"name": profile}}
        if slug:
            payload["slug"] = slug
        lines = self._ssh(
            payload,
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
  SELECT DISTINCT n.profile, n.trip_id
    FROM named n JOIN control_plane.trips t ON t.id = n.trip_id
   WHERE n.profile ~ '^[a-z0-9][a-z0-9-]{1,62}$'
     AND t.lifecycle_state <> ALL(%(pre)s)
), org AS (
  SELECT DISTINCT m.trip_id, l.telegram_subject_digest AS digest
    FROM control_plane.trip_memberships m
    JOIN control_plane.telegram_organizer_links l ON l.user_id = m.user_id
   WHERE m.role IN ('owner', 'organizer') AND m.status = 'active'
), dm AS (
  SELECT b.chat_id, b.trip_id, b.created_at, b.closed_at, b.closed_reason,
         'sha256:' || encode(sha256(convert_to(b.chat_id, 'UTF8')), 'hex') AS digest
    FROM control_plane.telegram_chat_bindings b
   WHERE b.chat_id ~ '^[0-9]{1,20}$'
)
SELECT p.profile, t.id AS trip_id, t.slug,
       (t.slug LIKE 'retired-%%' OR EXISTS (
          SELECT 1 FROM control_plane.telegram_chat_bindings d
           WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')) AS retired,
       t.start_date::text AS start_date, t.end_date::text AS end_date,
       t.plan_snapshot #>> '{meta,departure}' AS departure,
       t.plan_snapshot #>> '{meta,returnDate}' AS return_date,
       EXISTS (SELECT 1 FROM org o JOIN dm ON dm.digest = o.digest AND dm.closed_at IS NULL AND dm.trip_id = t.id
                WHERE o.trip_id = t.id) AS is_current,
       (SELECT max(dm.created_at) FROM org o JOIN dm ON dm.digest = o.digest AND dm.trip_id = t.id
         WHERE o.trip_id = t.id AND dm.created_at > %(revive_since)s) AS switched_at,
       (SELECT max(dm.closed_at) FROM org o JOIN dm ON dm.digest = o.digest AND dm.trip_id = t.id
         WHERE o.trip_id = t.id AND dm.closed_at > %(warm_since)s
           AND (dm.closed_reason = 'organizer_switch'
                OR EXISTS (SELECT 1 FROM dm d2 WHERE d2.chat_id = dm.chat_id AND d2.trip_id <> dm.trip_id
                            AND d2.created_at >= dm.closed_at - interval '1 minute'))) AS warm_at,
       (SELECT max(e.occurred_at) FROM control_plane.assistant_events e
         WHERE e.trip_id = t.id AND e.event_type = 'turn_lost' AND e.outcome = ANY(%(wake)s)
           AND e.occurred_at > %(revive_since)s) AS asked_at,
       (SELECT max(e.occurred_at) FROM control_plane.assistant_events e
         WHERE e.trip_id = t.id AND e.occurred_at > %(quiet_since)s) AS last_activity_at,
       CASE WHEN g.pin_trip_id = t.id THEN g.pin END AS pin
  FROM pick p
  JOIN control_plane.trips t ON t.id = p.trip_id
  LEFT JOIN control_plane.companion_gateways g ON g.hermes_profile = p.profile
 ORDER BY p.profile, (t.slug LIKE 'retired-%%'), t.created_at DESC, t.id
"""


def load_facts(conn: Any, now: datetime, interviewer_profile: str = INTERVIEWER_PROFILE,
               policy: Policy = DEFAULT_POLICY) -> list[GatewayFacts]:
    """The interviewer, then one GatewayFacts per (profile, trip) the control
    plane has named for a provisioned trip: a profile named by several trips
    appears once per trip, live and newest first. A pin counts only for the trip
    it was set for."""
    rows = conn.execute(FACTS_SQL, {
        "pre": list(PRE_PROVISIONING_STATES),
        "wake": list(WAKE_OUTCOMES),
        "revive_since": now - timedelta(days=policy.revive_days),
        "warm_since": now - timedelta(days=policy.warm_days),
        "quiet_since": now - timedelta(hours=policy.quiet_hours),
    }).fetchall()
    out = [GatewayFacts(profile=interviewer_profile, kind="interviewer")]
    for row in rows:
        if row["profile"] == interviewer_profile:
            continue  # a trip row naming the interviewer's profile must not demote it
        out.append(GatewayFacts(
            profile=row["profile"], kind="companion", trip_id=row["trip_id"], slug=row["slug"],
            retired=bool(row["retired"]), pin=row["pin"],
            start_date=parse_date(row["departure"]) or parse_date(row["start_date"]),
            end_date=parse_date(row["return_date"]) or parse_date(row["end_date"]),
            is_current=bool(row["is_current"]), warm_at=row["warm_at"],
            switched_at=row["switched_at"], asked_at=row["asked_at"],
            last_activity_at=row["last_activity_at"],
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
        self._watermark: tuple[Any, Any] | None = None
        self._warned_blind = False
        self.enabled = mode != "off" and self._interval > 0 and can_reconcile(adapter)

    # -- startup line ---------------------------------------------------------

    def describe(self) -> str:
        if self.enabled:
            return (f"gateway reconcile: {self.mode.upper()} every {self._interval / 60:g} min "
                    f"(+ a switch/ask hint every {self._hint_seconds:g}s) over the companion forced command"
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
                          (SELECT max(occurred_at) FROM control_plane.assistant_events
                            WHERE event_type = 'turn_lost' AND outcome = ANY(%s)
                              AND occurred_at > now() - interval '3 days') AS lost""",
                (list(WAKE_OUTCOMES),),
            ).fetchone()
        mark = (row["binding"], row["lost"])
        previous, self._watermark = self._watermark, mark
        return previous is not None and mark != previous

    # -- one sweep ------------------------------------------------------------

    class _LockBusy(Exception):
        """The advisory lock could not be had (first take: skip the sweep)."""

    class _LockLost(Exception):
        """The lock could not be RE-taken between host calls: abandon the sweep."""

    @contextmanager
    def _locked(self, conn: Any, *, first: bool = False):
        """Hold the advisory lock for one stretch of database work. The first
        take does not wait (another holder means skip this sweep); every later
        take waits LOCK_REWAIT_SECONDS, because a release or teardown may be
        holding it for the moment it takes them to record."""
        if not advisory_lock(conn, wait_seconds=0.0 if first else float(LOCK_REWAIT_SECONDS)):
            raise self._LockBusy() if first else self._LockLost()
        try:
            yield
        finally:
            advisory_unlock(conn)

    def run(self, should_stop: Callable[[], bool] = lambda: False, *,
            dry_run: bool = False) -> dict[str, Any]:
        """One sweep. `dry_run` reads and decides and asks the host, and writes
        and acts on NOTHING: it is the operator's "what would you do" and it is
        always observe, whatever the configured mode."""
        mode = "observe" if dry_run else self.mode
        summary: dict[str, Any] = {
            "mode": "dry_run" if dry_run else mode, "profiles": 0, "running": 0, "stopped": 0,
            "changed": 0, "starts": 0, "stops": 0, "failed": 0, "deferred": 0,
            "would_start": [], "would_stop": [], "would_confirm": [], "duplicates": [], "result": "ok",
        }
        conn = self._connect()
        try:
            self._sweep(conn, mode, summary, should_stop, write=not dry_run)
        except self._LockBusy:
            summary["result"] = "lock_busy"
            logger.info(log_fields("gateway_reconcile.skipped", reason="another holder has the advisory lock "
                                   "(a teardown, a release, a pin, or a sweep)"))
            conn.close()
            return summary
        except self._LockLost:
            summary["result"] = "lock_busy"
            logger.warning(log_fields(
                "gateway_reconcile.lock_lost", waited=LOCK_REWAIT_SECONDS,
                effect="a release or teardown held the lock for the whole wait; the rest of this sweep is abandoned "
                       "and the next one starts from the database"))
        except GatewayHostError as exc:
            summary["result"] = "host_unreachable"
            logger.warning(log_fields(
                "gateway_reconcile.host_unreachable", error=exc.safe_reason,
                effect="no observation recorded and nothing started or stopped this sweep"))
        except Exception as exc:
            summary["result"] = "error"
            logger.error(log_fields("gateway_reconcile.error", error=type(exc).__name__,
                                    effect="this sweep is abandoned; the next one starts from the database"))
        try:
            if not dry_run:
                self._event(conn, "SWEEP", mode=mode, result=summary["result"],
                            profiles=summary["profiles"], actions=summary["starts"] + summary["stops"])
                self._prune(conn)
        except Exception as exc:  # the heartbeat must not mask the sweep's own outcome
            logger.warning(log_fields("gateway_reconcile.heartbeat_failed", error=type(exc).__name__))
        finally:
            conn.close()
        logger.info(log_fields(
            "gateway_reconcile.sweep",
            **{k: v for k, v in summary.items() if not isinstance(v, list)},
            would_start=",".join(summary["would_start"]), would_stop=",".join(summary["would_stop"]),
            would_confirm=len(summary["would_confirm"]), duplicates=",".join(summary["duplicates"]),
        ))
        return summary

    def _decide_all(self, conn: Any, now: datetime) -> dict[str, ProfileDecision]:
        groups = group_by_profile(load_facts(conn, now, self._interviewer, self._policy))
        return {profile: decide_profile(group, now, self._policy) for profile, group in groups.items()}

    def _sweep(self, conn: Any, mode: str, summary: dict[str, Any],
               should_stop: Callable[[], bool], *, write: bool) -> None:
        now = self._now()
        # 1. decide and record, under the lock; released before any host call.
        with self._locked(conn, first=True):
            decisions = self._decide_all(conn, now)
            summary["profiles"] = len(decisions)
            summary["running"] = sum(1 for d in decisions.values() if d.desired == "running")
            summary["stopped"] = summary["profiles"] - summary["running"]
            self._warn_if_wake_blind(conn, now)
            if write:
                rows = {r["hermes_profile"]: r for r in
                        conn.execute("SELECT * FROM control_plane.companion_gateways").fetchall()}
                for profile, d in decisions.items():
                    rows[profile] = self._record_decision(conn, rows.get(profile), d, now, summary)

        # 2. ask the host: NO lock (a status read can take a minute).
        observed = self._adapter.status(list(decisions))  # may raise GatewayHostError: nothing below runs

        # 3. record what it said and plan, under the lock again.
        with self._locked(conn):
            rows = {r["hermes_profile"]: r for r in
                    conn.execute("SELECT * FROM control_plane.companion_gateways").fetchall()}
            if write:
                for profile, obs in observed.items():
                    rows[profile] = self._record_observation(conn, rows.get(profile), decisions[profile], obs, now)
            # What would be done, from the DECISION and the observation alone, so
            # observe and dry-run report the same list enforce would act on, and
            # a steady fleet reports an empty one.
            todo = self._plan(decisions, observed, rows, now)
        for item in todo:
            if item["noop"]:
                summary["would_confirm"].append(item["profile"])
            else:
                summary["would_start" if item["action"] == "start" else "would_stop"].append(item["profile"])
        summary["duplicates"] = sorted(p for p, o in observed.items() if o.state == "duplicate")
        if mode != "enforce" or not write:
            return

        # 4. act, one profile at a time: re-decide it under the lock, release,
        # call the host, re-take the lock to record.
        errors_in_a_row = 0
        for item in todo:
            if should_stop():
                break
            if summary["starts"] + summary["stops"] >= MAX_ACTIONS_PER_SWEEP:
                summary["deferred"] += 1
                continue
            profile, verb = item["profile"], item["action"]
            planned = decisions[profile]
            with self._locked(conn):
                fresh = self._decide_all(conn, self._now()).get(profile)
                if fresh is None or fresh.desired != planned.desired or fresh.reason in HOLD_ONLY_REASONS:
                    logger.info(log_fields("gateway_reconcile.action_dropped", profile=profile, action=verb,
                                           effect="the decision changed before the host was called"))
                    continue
                row = conn.execute("SELECT * FROM control_plane.companion_gateways WHERE hermes_profile = %s",
                                   (profile,)).fetchone()
            try:
                result = self._adapter.act(profile, verb, planned.slug if verb == "start" and planned.kind == "companion" else None)
            except GatewayHostError as exc:
                errors_in_a_row += 1
                summary["failed"] += 1
                logger.warning(log_fields("gateway_reconcile.action_error", profile=profile, action=verb,
                                          error=exc.safe_reason))
                with self._locked(conn):
                    self._record_action(conn, profile, planned.trip_id, verb, "failed", self._now(), row)
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
            with self._locked(conn):
                self._record_action(conn, profile, planned.trip_id, verb, result, self._now(), row)
            logger.info(log_fields("gateway_reconcile.action", profile=profile, action=verb, result=result,
                                   reason=planned.reason))

    # -- the plan: pure given the records -------------------------------------

    @staticmethod
    def _plan(decisions: Mapping[str, ProfileDecision], observed: Mapping[str, Observed],
              rows: Mapping[str, Mapping[str, Any]], now: datetime) -> list[dict[str, Any]]:
        """Starts first (the interviewer first of them), then stops; each in
        profile order. A profile on backoff, an unconfirmed flap-prone stop, a
        hold-only reason, a duplicate and an absent profile produce nothing.

        A desired-stopped gateway found already `stopped` with no confirmed stop
        on record gets a `noop` stop: the host answers ok without touching it,
        and that record is what makes it DORMANT to everything that skips
        dormant companions (see the module doc)."""
        starts, stops, confirms = [], [], []
        for profile in sorted(decisions, key=lambda p: (decisions[p].kind != "interviewer", p)):
            decision = decisions[profile]
            obs = observed.get(profile)
            row = rows.get(profile) or {}
            if obs is None or obs.state in ("duplicate", "absent"):
                continue
            wait = row.get("next_attempt_at")
            if wait is not None and wait > now:
                continue
            if decision.desired == "running" and obs.state == "stopped" and decision.reason not in HOLD_ONLY_REASONS:
                starts.append({"profile": profile, "action": "start", "noop": False})
                continue
            if decision.desired != "stopped":
                continue
            confirmed = int(row.get("confirmations") or 1) >= STOP_CONFIRMATIONS
            if not (confirmed or not decision.needs_confirmation):
                continue
            if obs.state == "running":
                stops.append({"profile": profile, "action": "stop", "noop": False})
            elif obs.state == "stopped" and not (row.get("last_action") == "stop" and row.get("last_result") == "ok"):
                confirms.append({"profile": profile, "action": "stop", "noop": True})
        return starts + stops + confirms

    # -- records --------------------------------------------------------------

    def _event(self, conn: Any, event: str, **cols: Any) -> None:
        names = ["event", *cols]
        conn.execute(
            f"INSERT INTO control_plane.companion_gateway_events ({', '.join(names)}) "
            f"VALUES ({', '.join(['%s'] * len(names))})",
            [event, *cols.values()],
        )

    def _record_decision(self, conn: Any, row: Mapping[str, Any] | None, d: ProfileDecision,
                         now: datetime, summary: dict[str, Any]) -> Mapping[str, Any]:
        mode = self.mode if self.mode != "off" else "observe"
        by = list(d.justified_by)
        if row is None:
            row = conn.execute(
                """INSERT INTO control_plane.companion_gateways
                     (hermes_profile, trip_id, kind, desired, reason, decided_at, confirmations, justified_by)
                   VALUES (%s, %s, %s, %s, %s, %s, 1, %s) RETURNING *""",
                (d.profile, d.trip_id, d.kind, d.desired, d.reason, now, by),
            ).fetchone()
            self._event(conn, "DECIDED", mode=mode, hermes_profile=d.profile, trip_id=d.trip_id,
                        desired=d.desired, reason=d.reason)
            summary["changed"] += 1
            return row
        if row["desired"] != d.desired:
            row = conn.execute(
                """UPDATE control_plane.companion_gateways
                      SET desired = %s, reason = %s, decided_at = %s, confirmations = 1, trip_id = %s,
                          kind = %s, justified_by = %s, updated_at = now()
                    WHERE hermes_profile = %s RETURNING *""",
                (d.desired, d.reason, now, d.trip_id, d.kind, by, d.profile),
            ).fetchone()
        elif row["reason"] != d.reason:
            row = conn.execute(
                """UPDATE control_plane.companion_gateways
                      SET reason = %s, trip_id = %s, kind = %s, justified_by = %s, updated_at = now()
                    WHERE hermes_profile = %s RETURNING *""",
                (d.reason, d.trip_id, d.kind, by, d.profile),
            ).fetchone()
        elif int(row["confirmations"]) < STOP_CONFIRMATIONS:
            row = conn.execute(
                """UPDATE control_plane.companion_gateways
                      SET confirmations = confirmations + 1, trip_id = %s, kind = %s, justified_by = %s,
                          updated_at = now()
                    WHERE hermes_profile = %s RETURNING *""",
                (d.trip_id, d.kind, by, d.profile),
            ).fetchone()
            return row
        else:
            if row["trip_id"] != d.trip_id or list(row["justified_by"] or []) != by:
                row = conn.execute(
                    "UPDATE control_plane.companion_gateways SET trip_id = %s, justified_by = %s, updated_at = now() "
                    "WHERE hermes_profile = %s RETURNING *", (d.trip_id, by, d.profile),
                ).fetchone()
            return row
        self._event(conn, "DECIDED", mode=mode, hermes_profile=d.profile, trip_id=d.trip_id,
                    desired=d.desired, reason=d.reason)
        summary["changed"] += 1
        logger.info(log_fields("gateway_reconcile.decided", profile=d.profile, desired=d.desired, reason=d.reason))
        return row

    def _record_observation(self, conn: Any, row: Mapping[str, Any], d: ProfileDecision, obs: Observed,
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
            group = [f for f in load_facts(conn, when) if f.profile == profile]
            raw = conn.execute("SELECT * FROM control_plane.companion_gateways WHERE hermes_profile = %s",
                               (profile,)).fetchone()
            if not group and raw is None:
                raise ValueError(f"{profile!r} is not a gateway the control plane manages")
            if group and group[0].kind == "interviewer":
                raise ValueError("the interviewer always runs and cannot be pinned")
            live = [f for f in group if not f.retired]
            # A teardown pin belongs to the trip being torn down. While that trip
            # is still alive it is not an operator's to clear; once it is retired
            # (or the pin is for a trip that no longer names this profile) it is
            # just a stale record, and clearing it is exactly the repair.
            if raw and raw["pin"] == "teardown" and any(f.trip_id == raw["pin_trip_id"] for f in live):
                raise ValueError(f"{profile!r} is pinned by a teardown in progress; that is not an operator's to clear")
            new_pin = None if pin == "clear" else pin
            if new_pin is None:
                target = raw["pin_trip_id"] if raw else None
            else:
                if not live:
                    raise ValueError(f"every trip naming {profile!r} is retired; there is nothing to pin")
                target = live[0].trip_id          # the newest live trip naming it
            regrouped = [replace(f, pin=new_pin) if f.trip_id == target else f for f in group]
            decided = decide_profile(regrouped, when) if regrouped else None
            if decided is not None:
                sweep._record_decision(conn, raw, decided, when, {"changed": 0})
            conn.execute(
                "UPDATE control_plane.companion_gateways SET pin = %s, pin_trip_id = %s, pin_set_at = %s, "
                "updated_at = now() WHERE hermes_profile = %s",
                (new_pin, target if new_pin else None, when if new_pin else None, profile),
            )
            sweep._event(conn, "PIN", hermes_profile=profile, trip_id=target if target and group else None, pin=pin)
            return {"profile": profile, "pin": pin,
                    "desired": decided.desired if decided else (raw or {}).get("desired"),
                    "reason": decided.reason if decided else (raw or {}).get("reason"),
                    "trip_id": target}
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
