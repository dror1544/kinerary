"""The verification aggregator: the gate Sprint 6's build list asks for,
immediately before a trip is marked `ready_private`
(docs/onboarding-mvp-sprint-plan.md, Sprint 6; docs/sprint6-tracks.md:472).

Until this module existed, `control_plane.verification_evidence`
(`0001_foundation.sql`) had been live since the FIRST migration with zero
writers, and `ready_private` was set unconditionally
(provisioner.py's `_complete`). Six signals are required: release
compatibility, runtime/service health, rendered trip data, MCP/context/
profile isolation, messaging binding, backup checkpoint. Each one produces
exactly one `verification_evidence` row, every time this runs, whatever the
outcome — the whole point of the table is to make a failure VISIBLE, never
to swallow it the way a `try/except: pass` would.

── Why only THREE of the six are a hard gate today, and that is a judgment
   call, not an oversight ──────────────────────────────────────────────────

`release_compatibility`, `runtime_health` and `rendered_data` are checkable
the moment `_deploy.deploy()` returns a private_url — nothing else has to
happen first — so `gate_ready_private()` runs them right before the
`ready_private` UPDATE and BLOCKS the transition (raises `VerificationFailed`,
caught by `_work_claimed_job`'s existing handler exactly like a materialize
failure) when any of them is not `passed`.

`mcp_isolation` and `messaging_binding` cannot honestly be checked at that
same point for a FIRST provision: `_attach_companion` — which installs the
companion profile, wires the trip-mcp bridge and opens the chat binding —
runs AFTER `_complete()`'s transaction commits, on purpose
("the companion profile and the chat binding are two independent side
effects performed after the transaction above durably commits ... A failure
here must never roll back a successful provisioning run" — `_attach_companion`
docstring, hardened by real incidents on 2026-09-06 and 2026-09-20). Making
these two a HARD gate would mean reordering that commit — attaching the
companion and opening the binding BEFORE `ready_private` is ever set — which
is a deliberate, dated, tested invariant this task does not reverse
unilaterally. Blocking on them anyway, today, would not make provisioning
safer; every first-provision job would fail every time (nothing has wired a
companion yet), which is the "fails open" shape in a different costume: the
gate gets worked around instead of trusted. So at the pre-`ready_private`
point they are recorded `skipped`, honestly, with the reason stated in the
evidence — and `record_post_attach_evidence()` below records REAL evidence
for both right after `_attach_companion` finishes, for operational visibility.
That recording is informational: it does not revert `ready_private`, matching
the existing non-fatal companion-failure design and the backward-compat
requirement that a trip already `ready_private` is never retroactively
broken. Moving these two into the hard gate is a real option — it needs the
reorder above, and is named as a carry-forward, not papered over here.

`backup_checkpoint` has no mechanism to check against anywhere in this
codebase: `kinerary-cp-release` snapshots the whole control-plane VM, not a
single trip, and TrueNAS NFS is where a trip's data lives, not a recorded
backup event. There is no `backup_checkpoints` table, no per-trip snapshot
naming convention, nothing this worktree can ask. It is always `skipped`,
honestly, rather than a fabricated `passed` — see `check_backup_checkpoint`.
"""
from __future__ import annotations

import hashlib
import json
import secrets
from typing import AbstractSet, Any, Callable, Mapping, NamedTuple
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .mcp_bridge import BridgeProbeError, can_probe

# ── Check names (control_plane.verification_evidence.check_name) ───────────

RELEASE_COMPATIBILITY = "release_compatibility"
RUNTIME_HEALTH = "runtime_health"
RENDERED_DATA = "rendered_data"
MCP_ISOLATION = "mcp_isolation"
MESSAGING_BINDING = "messaging_binding"
BACKUP_CHECKPOINT = "backup_checkpoint"

CHECK_NAMES = (
    RELEASE_COMPATIBILITY, RUNTIME_HEALTH, RENDERED_DATA,
    MCP_ISOLATION, MESSAGING_BINDING, BACKUP_CHECKPOINT,
)

#: The three signals `gate_ready_private` actually blocks on today. See the
#: module docstring for exactly why the other three are not in this set.
HARD_GATE_CHECKS = frozenset({RELEASE_COMPATIBILITY, RUNTIME_HEALTH, RENDERED_DATA})

_OUTCOMES = ("passed", "failed", "skipped")

#: (url) -> (status, body). Injectable so tests never make a real network
#: call. Production gets `default_http_get` unless the deploy adapter in
#: play already knows how to answer for the URL it just handed back — see
#: ProvisionerWorker's resolution of this in provisioner.py, which is the
#: same "defaults to a passthrough, __main__/a test double can override"
#: shape as EnrichFn and MaterializeFn.
HttpGetFn = Callable[[str], "tuple[int, str]"]


class CheckResult(NamedTuple):
    check_name: str
    outcome: str  # "passed" | "failed" | "skipped"
    evidence: str  # the raw string this outcome is reproducible evidence of


def evidence_digest(raw: str) -> str:
    """`sha256:<64 hex>` — the exact shape verification_evidence.evidence_digest
    CHECKs for. Hashes the raw evidence (a response body, or a structured
    description of what was checked), never a placeholder."""
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_evidence_id() -> str:
    return f"ve_{secrets.token_hex(16)}"


# ── HTTP transport ───────────────────────────────────────────────────────────

def default_http_get(url: str, timeout: float = 10.0) -> "tuple[int, str]":
    """A real GET. `private_url` is a value this worker already trusts and
    already hands to the organizer (same provenance as the notification
    sent in `_complete`), so this only pins the scheme — never file://, never
    anything else urlopen would otherwise honour."""
    if urlsplit(url).scheme not in ("http", "https"):
        raise ValueError(f"refusing non-http(s) scheme in verification probe: {url!r}")
    request = Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        # nosec B310: scheme is checked above.
        with urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        return exc.code, (exc.read() or b"").decode("utf-8", errors="replace")


# ── Individual checks — each pure enough to unit-test with a fake conn/get ──

def check_release_compatibility(conn: Any, plan_desired: Mapping[str, Any]) -> CheckResult:
    """Is the release this plan named still one the control plane considers
    valid? Re-reads `control_plane.releases` (the same table `generatePlan()`
    selects `available` releases from, and `promoteRelease()`/`release-
    registry.ts` is the only writer of) rather than inventing a second notion
    of compatibility — a race where an operator deprecates a release while a
    job is mid-flight is exactly what this re-check is for."""
    release_id = plan_desired.get("release_id")
    if not release_id:
        return CheckResult(RELEASE_COMPATIBILITY, "skipped", "plan.desired carries no release_id")
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM control_plane.releases WHERE id = %s", (release_id,))
        row = cur.fetchone()
    if row is None:
        evidence = json.dumps({"release_id": release_id, "status": None}, sort_keys=True)
        return CheckResult(RELEASE_COMPATIBILITY, "failed", evidence)
    status = row["status"] if isinstance(row, Mapping) else row[0]
    evidence = json.dumps({"release_id": release_id, "status": status}, sort_keys=True)
    if status == "available":
        return CheckResult(RELEASE_COMPATIBILITY, "passed", evidence)
    return CheckResult(RELEASE_COMPATIBILITY, "failed", evidence)


def check_runtime_health(get: HttpGetFn, private_url: str | None) -> CheckResult:
    """The trip's own `GET /api/health` (server/server.js) — deliberately
    unauthenticated, same reasoning as the companion bridge's own /health
    probe (CLAUDE.md, "A Mac-provisioned companion that cannot read its own
    trip"): ask the real site, not just "is the container running"."""
    if not private_url:
        return CheckResult(RUNTIME_HEALTH, "failed", "no private_url to probe")
    url = private_url.rstrip("/") + "/api/health"
    try:
        status, body = get(url)
    except Exception as exc:  # network error, timeout, bad scheme
        return CheckResult(RUNTIME_HEALTH, "failed", f"GET {url} raised {type(exc).__name__}: {exc}")
    if status != 200:
        return CheckResult(RUNTIME_HEALTH, "failed", f"GET {url} -> HTTP {status}: {body[:500]}")
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        return CheckResult(RUNTIME_HEALTH, "failed", f"GET {url} -> non-JSON body: {body[:500]}")
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return CheckResult(RUNTIME_HEALTH, "failed", body)
    return CheckResult(RUNTIME_HEALTH, "passed", body)


def check_rendered_data(
    get: HttpGetFn,
    private_url: str | None,
    expected_usernames: AbstractSet[str] = frozenset(),
    expected_departure: str | None = None,
    expected_return_date: str | None = None,
) -> CheckResult:
    """The trip's own `GET /api/config/roster` — deliberately unauthenticated
    (server/server.js: "the login screen needs to show a pick-yourself roster
    before any session exists"), so this is checkable with no credentials and
    still proves real trip.config.json content reached the site, not an empty
    or broken shell.

    #review 2026-10-03 [P2], round 1: a nonempty check alone passes ANY
    reachable trip's roster — a stale deployment or a `private_url` ingress
    misrouted to another trip's container would pass both this and
    `runtime_health` while `ready_private` commits for the WRONG data.
    `expected_usernames` is the plan's own participant usernames
    (provisioner.py: `config["participants"]`, the exact config this deploy
    was FOR). An empty set skips the comparison rather than failing every
    trip retroactively — the plain nonempty check below still applies either
    way.

    #review 2026-10-03 [P2], round 2: usernames alone do not identify the
    TRIP — two trips for the same family (a second trip, re-provisioned with
    the same roster) share them, so a `private_url` misrouted to the sibling
    trip, or a stale deployment of it, still passes round 1's check.
    `expected_departure`/`expected_return_date` (provisioner.py:
    `config["meta"]`, the same deploy's own dates) are compared against a
    SECOND unauthenticated route, `GET /api/config/deployment-identity`
    (server/server.js) — two trips for one family cannot share both dates
    without being the same trip. Either expected value being `None` skips
    that half of the comparison the same way an empty `expected_usernames`
    does; this is additive to round 1, not a replacement for it.
    """
    if not private_url:
        return CheckResult(RENDERED_DATA, "failed", "no private_url to probe")
    url = private_url.rstrip("/") + "/api/config/roster"
    try:
        status, body = get(url)
    except Exception as exc:
        return CheckResult(RENDERED_DATA, "failed", f"GET {url} raised {type(exc).__name__}: {exc}")
    if status != 200:
        return CheckResult(RENDERED_DATA, "failed", f"GET {url} -> HTTP {status}: {body[:500]}")
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        return CheckResult(RENDERED_DATA, "failed", f"GET {url} -> non-JSON body: {body[:500]}")
    participants = payload.get("participants") if isinstance(payload, dict) else None
    if not isinstance(participants, list) or not participants:
        return CheckResult(RENDERED_DATA, "failed", body)
    if expected_usernames:
        actual_usernames = {p.get("username") for p in participants if isinstance(p, dict) and p.get("username")}
        if actual_usernames != set(expected_usernames):
            return CheckResult(
                RENDERED_DATA, "failed",
                f"roster mismatch at {url}: expected usernames {sorted(expected_usernames)}, "
                f"got {sorted(actual_usernames)} — this private_url may be serving another trip",
            )
    if expected_departure is not None or expected_return_date is not None:
        identity_url = private_url.rstrip("/") + "/api/config/deployment-identity"
        try:
            id_status, id_body = get(identity_url)
        except Exception as exc:
            return CheckResult(RENDERED_DATA, "failed", f"GET {identity_url} raised {type(exc).__name__}: {exc}")
        if id_status != 200:
            return CheckResult(RENDERED_DATA, "failed", f"GET {identity_url} -> HTTP {id_status}: {id_body[:500]}")
        try:
            id_payload = json.loads(id_body)
        except (ValueError, TypeError):
            return CheckResult(RENDERED_DATA, "failed", f"GET {identity_url} -> non-JSON body: {id_body[:500]}")
        actual_departure = id_payload.get("departure") if isinstance(id_payload, dict) else None
        actual_return_date = id_payload.get("returnDate") if isinstance(id_payload, dict) else None
        mismatches = []
        if expected_departure is not None and actual_departure != expected_departure:
            mismatches.append(f"departure: expected {expected_departure!r}, got {actual_departure!r}")
        if expected_return_date is not None and actual_return_date != expected_return_date:
            mismatches.append(f"returnDate: expected {expected_return_date!r}, got {actual_return_date!r}")
        if mismatches:
            return CheckResult(
                RENDERED_DATA, "failed",
                f"deployment identity mismatch at {identity_url}: {'; '.join(mismatches)} — "
                "this private_url may be serving a different trip for the same family",
            )
    return CheckResult(RENDERED_DATA, "passed", body)


def check_mcp_isolation(adapter: Any, slug: str, hermes_profile: str | None) -> CheckResult:
    """Reuses `McpBridgeAdapter.probe()` (issue #119's own bridge health
    probe) rather than inventing a second isolation check. Only meaningful
    once a companion exists; `can_probe` is the SAME gate `BridgeProbeSweep`
    already uses to decide whether an adapter can be asked at all."""
    if not hermes_profile:
        return CheckResult(MCP_ISOLATION, "skipped", "no companion profile installed for this trip")
    if not can_probe(adapter):
        return CheckResult(
            MCP_ISOLATION, "skipped",
            f"{type(adapter).__name__} cannot probe (MCP bridge flag off or no companion SSH host configured)",
        )
    try:
        ok, code = adapter.probe(slug, hermes_profile)
    except BridgeProbeError as exc:
        # "Could not be asked" is not evidence either way — same rule
        # BridgeProbeSweep already applies to this exact exception.
        return CheckResult(MCP_ISOLATION, "skipped", f"could not ask: {exc.safe_reason}")
    except Exception as exc:  # pragma: no cover - defensive
        return CheckResult(MCP_ISOLATION, "failed", f"probe raised {type(exc).__name__}: {exc}")
    if ok:
        return CheckResult(MCP_ISOLATION, "passed", f"HEALTH ok slug={slug} profile={hermes_profile}")
    return CheckResult(MCP_ISOLATION, "failed", f"HEALTH fail {code} slug={slug} profile={hermes_profile}")


def check_messaging_binding(conn: Any, trip_id: str) -> CheckResult:
    """An open `telegram_chat_bindings` row for this trip IS the existing,
    pre-this-task check for this signal (docs/sprint6-tracks.md:472 names it
    as one of the two signals that already had any check at all) — reused
    as-is rather than re-derived."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM control_plane.telegram_chat_bindings "
            "WHERE trip_id = %s AND closed_at IS NULL LIMIT 1",
            (trip_id,),
        )
        bound = cur.fetchone() is not None
    if bound:
        return CheckResult(MESSAGING_BINDING, "passed", f"trip {trip_id} has an open chat binding")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT unreachable_reason FROM control_plane.trips WHERE id = %s",
            (trip_id,),
        )
        row = cur.fetchone()
    reason = (row["unreachable_reason"] if isinstance(row, Mapping) else (row[0] if row else None)) if row else None
    if reason in ("NO_ORGANIZER_CHAT", "BINDING_REFUSED", "BINDING_FAILED"):
        return CheckResult(MESSAGING_BINDING, "failed", f"no open binding; recorded reason={reason}")
    return CheckResult(MESSAGING_BINDING, "skipped", "no open binding yet and no binding attempt recorded")


def check_backup_checkpoint() -> CheckResult:
    """No per-trip backup/snapshot recorder exists in this codebase. See the
    module docstring. A real check needs a future `backup_checkpoints` table
    or NFS-snapshot naming convention this worktree does not have — this is
    an honest, permanent `skipped` until that exists, never a fabricated
    `passed`."""
    return CheckResult(
        BACKUP_CHECKPOINT, "skipped",
        "no per-trip backup checkpoint mechanism exists yet: kinerary-cp-release "
        "snapshots the whole control-plane VM, not a trip; TrueNAS NFS is where "
        "trip data lives, not a recorded backup event. A real check needs a "
        "future per-trip backup recorder this worktree does not have.",
    )


# ── Aggregation / recording ──────────────────────────────────────────────────

def run_pre_ready_private_checks(
    conn: Any, *,
    plan_desired: Mapping[str, Any],
    private_url: str | None,
    http_get: HttpGetFn,
    expected_usernames: AbstractSet[str] = frozenset(),
    expected_departure: str | None = None,
    expected_return_date: str | None = None,
) -> list[CheckResult]:
    """All six, in the shape they can honestly be evaluated in BEFORE
    `_attach_companion` has run. See the module docstring for why the last
    three are not real checks at this point."""
    return [
        check_release_compatibility(conn, plan_desired),
        check_runtime_health(http_get, private_url),
        check_rendered_data(http_get, private_url, expected_usernames, expected_departure, expected_return_date),
        CheckResult(
            MCP_ISOLATION, "skipped",
            "not attempted yet: the companion/bridge wiring step (_attach_companion) "
            "runs after the ready_private decision by design; see record_post_attach_evidence",
        ),
        CheckResult(
            MESSAGING_BINDING, "skipped",
            "not attempted yet: the chat binding (_attach_companion) runs after the "
            "ready_private decision by design; see record_post_attach_evidence",
        ),
        check_backup_checkpoint(),
    ]


def record_evidence(
    conn: Any, *, trip_id: str, deployment_ref: str | None, results: list[CheckResult],
) -> None:
    """One verification_evidence row per result, in its own transaction —
    written whether the outcome is passed, failed OR skipped. This is the
    table's entire reason to exist: a failure recorded, never swallowed."""
    with conn.transaction():
        with conn.cursor() as cur:
            for result in results:
                assert result.outcome in _OUTCOMES, f"unknown outcome {result.outcome!r}"
                cur.execute(
                    """
                    INSERT INTO control_plane.verification_evidence
                      (id, trip_id, deployment_ref, check_name, outcome, evidence_digest, observed_at)
                    VALUES (%s, %s, %s, %s, %s, %s, now())
                    """,
                    (
                        _generate_evidence_id(), trip_id, deployment_ref,
                        result.check_name, result.outcome, evidence_digest(result.evidence),
                    ),
                )


class VerificationFailed(RuntimeError):
    """Raised when a hard-gate check is not `passed` (including unexpectedly
    missing — never treated as an automatic pass). Carries `safe_error_code`
    so `_work_claimed_job`'s existing handler files it exactly like a
    materialize failure: the job fails/retries, the trip stays in whatever
    lifecycle_state it already had."""

    safe_error_code = "VERIFICATION_FAILED"

    def __init__(self, failures: list[CheckResult]) -> None:
        self.failures = failures
        detail = ", ".join(f"{f.check_name}={f.outcome}" for f in failures)
        super().__init__(f"verification gate failed: {detail}")


def gate_ready_private(
    conn: Any, *,
    trip_id: str,
    deployment_ref: str | None,
    plan_desired: Mapping[str, Any],
    private_url: str | None,
    http_get: HttpGetFn | None = None,
    expected_usernames: AbstractSet[str] = frozenset(),
    expected_departure: str | None = None,
    expected_return_date: str | None = None,
) -> list[CheckResult]:
    """Runs all six checks, records evidence for all six (always — a hard-gate
    failure is recorded before it is ever raised, so the evidence survives
    the job failing), then raises `VerificationFailed` if any HARD_GATE_CHECKS
    entry did not come back `passed` — including one that is missing from the
    results entirely, which is a bug in this module, not a pass."""
    get = http_get or default_http_get
    results = run_pre_ready_private_checks(
        conn, plan_desired=plan_desired, private_url=private_url, http_get=get,
        expected_usernames=expected_usernames,
        expected_departure=expected_departure, expected_return_date=expected_return_date,
    )
    record_evidence(conn, trip_id=trip_id, deployment_ref=deployment_ref, results=results)

    by_name = {r.check_name: r for r in results}
    failures = [
        by_name[name] if name in by_name and by_name[name].outcome == "passed" else
        by_name.get(name) or CheckResult(name, "failed", "check did not run (bug: missing from aggregator output)")
        for name in HARD_GATE_CHECKS
    ]
    failures = [f for f in failures if f.outcome != "passed"]
    if failures:
        raise VerificationFailed(failures)
    return results


def record_post_attach_evidence(
    conn: Any, *,
    trip_id: str,
    deployment_ref: str | None,
    slug: str,
    hermes_profile: str | None,
    mcp_bridge_adapter: Any,
) -> list[CheckResult]:
    """Real evidence for `mcp_isolation` and `messaging_binding`, recorded
    right after `_attach_companion` finishes. Informational only: it never
    reverts `ready_private` — see the module docstring for why that is a
    deliberate, documented limit rather than an oversight. Callers should
    treat a failure here as non-fatal (best-effort), matching every other
    side effect `_attach_companion` already performs this way."""
    results = [
        check_mcp_isolation(mcp_bridge_adapter, slug, hermes_profile),
        check_messaging_binding(conn, trip_id),
    ]
    record_evidence(conn, trip_id=trip_id, deployment_ref=deployment_ref, results=results)
    return results
