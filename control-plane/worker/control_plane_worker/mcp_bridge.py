"""Wires a newly-provisioned trip's companion Hermes profile to its own
trip-mcp bridge, via kinerary-deploy/setup-mcp.sh — the same script an
operator runs by hand today for japan-2025/los-angeles-hawaii-vegas-2026.

Reads the container's LAN address from the same topology.yaml
ShellDeployAdapter already relies on (provisioner.py's _private_url), so no
new per-trip state is required — the two adapters just need to agree on
deploy_root/vmid_map.

GATED OFF BY DEFAULT, and that default is what most deployments actually run.
This adapter is used only when --enable-mcp-bridge AND --companion-templates-dir
are both passed; otherwise a NullMcpBridgeAdapter takes its place. The local
compose worker passes neither, so a trip onboarded there gets a live site and
no bridge — its companion answers with no access to trip data, which reads as
a confidently wrong assistant rather than an obviously broken one.

That failure is easy to mistake for a configuration leak. It cost an evening
on 2026-09-02: japan-2026's bridge was in fact correctly configured and had
simply died in a power outage, while a stale shared trip-mcp pointed at another
trip made it look like cross-trip contamination. kinerary-deploy/bring-up.sh
now reports the two states separately — "no bridge" (this step never ran) vs a
dead process it can restart — and names this flag as the usual cause of the
former.

This is a separate, independently-gated step from CompanionProfileAdapter:
installing the profile bundle (SOUL.md/skills/references) is a local
filesystem operation, while this step does real SSH-to-Proxmox and
`hermes mcp add` mutations. A failure here is non-fatal to provisioning —
without it, the trip site itself is fully live and the companion profile
exists; only its ability to reach trip-mcp tools (e.g. set_telegram_group)
is missing, and that gap is closed by re-running setup-mcp.sh by hand later.

Note for whoever builds Phase G's container-creation code: for this bridge
to actually result in a working set_telegram_group call, the deployed
site's own TELEGRAM_BOT_TOKEN (trip.env) must be the SAME bot as the one
connected to Hermes as the shared companion (see CONTROL_PLANE_CHAT_ROUTING_*
in the API's chat-routing endpoint / trip-intake's Hermes profile) — not a
freshly-minted per-trip bot the way japan-2025/los-angeles-hawaii-vegas-2026
were set up. The site's getChatMember-based membership check requires the
token to belong to a bot that is actually a member of the family group, and
that has to be the same bot the organizer is DMing for it to make sense as
one continuous "trip companion." Nothing currently in this codebase enforces
that — it depends on Phase G actually writing the shared token into a new
trip's trip.env instead of minting one.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from typing import Any, Callable, Mapping, Protocol

from .companion_profile import forced_command_argv

logger = logging.getLogger(__name__)


#: Ports below this belong to hand-provisioned trips and the legacy shared
#: bridge (3001, 3011, 3013). Auto-provisioned trips start above all of them.
MCP_PORT_BASE = 3000


def mcp_port_for_vmid(vmid: str) -> int | None:
    """The port this trip's bridge listens on — a function of its container,
    so it is the same on every re-provision and different for every trip.

    Until 2026-09-10 nothing passed `--port` at all, so setup-mcp.sh took its
    3001 default for EVERY trip. Each new trip's bridge therefore killed the
    previous trip's and took its port, and the profile config left behind
    still named it — which is the shape of a companion answering confidently
    out of another family's data. It never actually landed because the kill
    that would have done it was itself broken (BusyBox lsof, same script), so
    this closes a live hole rather than a theoretical one.

    Derived from the vmid because it is already unique per trip, already in
    topology.yaml, and needs no new registry to drift out of sync. Returns
    None for anything that would not produce a sane port, so the caller skips
    the bridge rather than guessing a number that might belong to someone.
    """
    if not vmid or not vmid.isdigit():
        return None
    port = MCP_PORT_BASE + int(vmid)
    if not (3100 <= port <= 3999):
        return None
    return port


class McpBridgeAdapter(Protocol):
    """Wires trip-mcp to a companion Hermes profile. Returns True if wired,
    False if skipped (e.g. no vmid/topology yet available for this slug)."""

    def setup(self, slug: str, profile_name: str) -> bool: ...


class NullMcpBridgeAdapter:
    """No-op — used when kinerary-deploy isn't configured for this
    deployment, or the operator hasn't opted into this step yet. Provisioning
    still succeeds; only the trip-mcp wiring is skipped (same story as
    NullCompanionProfileAdapter).

    Deliberately has no `probe()`: with the bridge flag off there is no bridge
    to ask about, so the idle-loop sweep (BridgeProbeSweep) is off too."""

    def setup(self, slug: str, profile_name: str) -> bool:
        return False


class BridgeProbeError(RuntimeError):
    """A bridge probe that could not be ASKED — ssh failed or timed out, the
    host refused the request, or it answered with something that is not a
    verdict. Distinct from a probe that was asked and said `fail`: this says
    nothing about the bridge, so it never counts toward marking a trip.

    `safe_reason` is the only text of it that is ever logged. It is built from
    the exit status and, at most, one bounded line the forced command composed
    itself (its `companion-install-host: ` prefix) — never the far side's
    stdout or stderr at large, which is another process's output."""

    def __init__(self, safe_reason: str) -> None:
        super().__init__(safe_reason)
        self.safe_reason = safe_reason


def log_fields(event: str, **fields: Any) -> str:
    """`event key=value key="value with spaces" …` — a log MESSAGE that carries
    its own facts.

    The worker's log format (`__main__.LOG_FORMAT`) prints the message and
    nothing else, so a field passed only in `extra` never reaches anyone
    reading the log (#292). Rendering every extra would need an audit of what
    they all hold; these lines are composed from values chosen to be safe to
    print (slugs, trip ids, codes, safe reasons, repair text) and never a key.
    Newlines are escaped so one call is always one log line."""
    parts = [event]
    for key, value in fields.items():
        if value is None or value == "":
            continue
        text = str(value).replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")
        if any(c in text for c in ' "='):
            text = '"' + text.replace('"', '\\"') + '"'
        parts.append(f"{key}={text}")
    return " ".join(parts)


def can_probe(adapter: Any) -> bool:
    """Whether this bridge adapter can be asked if a bridge still reaches its
    trip. Only the SSH adapter can: the Null adapter has no bridge, and the
    local shell adapter has no host of its own to ask on."""
    return callable(getattr(adapter, "probe", None))


class SshMcpBridgeAdapter:
    """Wires a trip's trip-mcp bridge on the host that runs its companion.

    The bridge is `node mcp.js` plus a `hermes mcp add` into the companion's
    profile, so it can only be set up where node and Hermes are. With companions
    installed over SSH (SshCompanionProfileAdapter), that is NOT the worker's
    container: `ShellMcpBridgeAdapter` ran setup-mcp.sh in there, which failed
    with "env: can't execute 'node'" on every provision and shipped every
    companion without its trip tools — found by the first automated full cycle,
    2026-09-11.

    Same key, same forced command as the companion install. The request carries
    only the slug and the profile name; the host derives the site address,
    container and port from its own topology.yaml (scripts/companion-install-host.sh).
    """

    _SLUG = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
    _PROFILE = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")

    def __init__(
        self,
        host: str,
        user: str,
        key_path: str,
        *,
        port: int = 22,
        known_hosts: str | None = None,
        # setup-mcp.sh starts the bridge, registers it and runs `hermes mcp
        # test` over a live connection: ~6 minutes end to end (see
        # ShellMcpBridgeAdapter's note on the 180s that killed it every run).
        timeout: int = 900,
    ) -> None:
        self._host, self._user, self._key_path = host, user, key_path
        self._port, self._known_hosts, self._timeout = port, known_hosts, timeout

    def setup(self, slug: str, profile_name: str) -> bool:
        # Checked here too so a bad value fails in the worker's own log, not as
        # an opaque refusal from the other side of an SSH connection.
        if not self._SLUG.fullmatch(slug or "") or not self._PROFILE.fullmatch(profile_name or ""):
            raise RuntimeError(f"refusing to request a bridge for {slug!r}/{profile_name!r}")
        payload = json.dumps({
            "record_type": "trip_mcp_bridge_request",
            "schema_version": 1,
            "slug": slug,
            "profile": {"name": profile_name},
        })
        result = subprocess.run(
            forced_command_argv(self._host, self._user, self._key_path, self._port, self._known_hosts),
            input=payload, capture_output=True, text=True, timeout=self._timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"trip-mcp bridge over ssh exited {result.returncode}: {(result.stderr or result.stdout)[-500:]}"
            )
        line = (result.stdout or "").strip().splitlines()[-1] if (result.stdout or "").strip() else ""
        # "WIRED <profile>" or "WIRED <profile> <commit>". The commit is the
        # checkout the OTHER side ran from, which the forced command in its
        # authorized_keys chooses and nothing here can see. It is optional only
        # so an older host still reports success rather than failing on a field
        # it does not know to print.
        parts = line.split()
        if len(parts) < 2 or parts[0] != "WIRED" or parts[1] != profile_name:
            raise RuntimeError(f"unrecognized bridge result: {line[:200]!r}")
        self.built_from = parts[2] if len(parts) > 2 else "unreported"
        return True

    #: A probe is one curl on the far side (max-time 15s) behind one ssh
    #: connect (ConnectTimeout 10s). Bounded well below setup()'s 900s: the
    #: sweep runs inside the provisioning loop, and a job waits while it does.
    PROBE_TIMEOUT_SECONDS = 45

    _VERDICT = re.compile(r"HEALTH (ok|fail [A-Za-z0-9_]{1,40})")
    _SCRIPT_LINE = "companion-install-host: "

    def probe(self, slug: str, profile_name: str) -> tuple[bool, str]:
        """Asks the companion host whether this trip's bridge still reaches
        the trip (issue #119). Returns (True, "ok") or (False, <code>) — codes
        are listed at `bridge_health_code` in scripts/companion-install-host.sh.

        Read-only on the far side: the forced command runs no setup-mcp.sh and
        restarts nothing. The bridge's key is read there, beside the trip, and
        never crosses this connection. Anything but exactly one verdict line
        raises BridgeProbeError — "could not ask" is not "the bridge failed".
        """
        if not self._SLUG.fullmatch(slug or "") or not self._PROFILE.fullmatch(profile_name or ""):
            raise BridgeProbeError(f"refusing to probe a bridge for {slug!r}/{profile_name!r}")
        payload = json.dumps({
            "record_type": "trip_mcp_bridge_probe",
            "schema_version": 1,
            "slug": slug,
            "profile": {"name": profile_name},
        })
        try:
            result = subprocess.run(
                forced_command_argv(self._host, self._user, self._key_path, self._port, self._known_hosts),
                input=payload, capture_output=True, text=True, timeout=self.PROBE_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise BridgeProbeError(f"bridge probe over ssh timed out after {self.PROBE_TIMEOUT_SECONDS}s") from None
        except OSError as exc:
            raise BridgeProbeError(f"bridge probe over ssh could not start ({type(exc).__name__})") from None
        if result.returncode != 0:
            raise BridgeProbeError(
                f"bridge probe over ssh exited {result.returncode}: {self._script_reason(result.stderr)}"
            )
        lines = (result.stdout or "").splitlines()
        if len(lines) != 1 or not self._VERDICT.fullmatch(lines[0]):
            raise BridgeProbeError(f"bridge probe returned no single verdict line ({len(lines)} lines)")
        words = lines[0].split(" ")
        return (True, "ok") if words[1] == "ok" else (False, words[2])

    @classmethod
    def _script_reason(cls, stderr: str | None) -> str:
        """The forced command's own last `die` line, bounded — or nothing.
        Other lines (a shell's error, a Python traceback) are not repeated."""
        for line in reversed((stderr or "").splitlines()):
            if line.startswith(cls._SCRIPT_LINE):
                return line[:200]
        return "(no reason the forced command composed)"


class BridgeProbeSweep:
    """Re-asks every live trip's bridge whether it still reaches its trip, on
    the provisioner worker's idle poll loop (issue #119).

    Provisioning asks /health once, at install. A bridge that goes bad after
    that — its key replaced, its host's route to the trip lost, the process
    dead — used to fail every call for good with nothing recording it; the
    companion said, politely and indefinitely, that it could not read the plan.

    WHY HERE. The worker already holds the companion host's forced-command key
    and already writes `reachability`; it is single-threaded, so a probe can
    never race a provision re-wiring the same trip's bridge. Not the API (it
    has no SSH key and must not get one) and not the fleet monitor (its MCP
    must stay unable to write — it READS what this records).

    ALERT ONLY. A failure is recorded, never repaired: an automatic re-wire
    would restart a live trip's bridge and gateway unattended (hard rule 2),
    and would re-read whatever key is on disk — the very thing that may be
    wrong. The recorded reason is what `restart-bridges` and the fleet monitor
    act on; the repair is an operator's.

    WHEN A TRIP IS MARKED: two failed verdicts with no successful verdict
    between them. A success resets the count; "could not ask" (BridgeProbeError
    or anything unexpected) and an unverifiable verdict (UNVERIFIABLE) neither
    count nor reset it. That is deliberate — not "consecutive probes": a
    flapping ssh interleaving errors must not be able to hide a trip whose
    bridge fails every time it is actually asked (owner priority: no silent
    failures). The count is in memory, so a worker restart — which on a deploy
    coincides with the bridges restarting — begins again rather than carrying
    a failure across it.

    A DEAD COMPANION HOST MUST NOT STALL JOB PICKUP. The sweep is serial in the
    provisioning thread, and every probe to an unreachable host waits out its
    timeout; after BREAKER_AFTER could-not-ask results in a row within one
    sweep, the rest of that sweep is abandoned (logged once) and the next
    interval starts over. The sweep's own database connection carries a
    statement_timeout, so a held row lock fails one write instead of parking
    the loop.

    Every line this writes carries its facts IN THE MESSAGE TEXT (`log_fields`):
    the worker's log format prints the message alone and drops `extra` (#292).
    """

    CONFIRM_AFTER = 2
    BREAKER_AFTER = 3
    STATEMENT_TIMEOUT_MS = 5000

    #: Verdicts that are answers but not evidence: never counted as a failure,
    #: never recorded, always logged. Code -> what the operator should do.
    UNVERIFIABLE = {
        "NO_HEALTH_ROUTE": (
            "the trip's running bridge predates /health (#127), so whether it reaches its trip cannot be "
            "checked; restart it on the current checkout (kinerary-cp-release restart-bridges on the VM, "
            "setup-mcp.sh --restart-only on a Mac) — its reachability is left as it was"
        ),
    }

    def __init__(
        self,
        db_url: str,
        adapter: Any,
        *,
        interval_minutes: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._db_url = db_url
        self._adapter = adapter
        self._interval = max(0.0, float(interval_minutes)) * 60
        self._clock = clock
        self._last: float | None = None
        self._failures: dict[str, int] = {}
        self.enabled = self._interval > 0 and can_probe(adapter)

    def describe(self) -> str:
        """One line for the worker's startup output: on, or why not."""
        if self.enabled:
            return f"bridge probe: every {self._interval / 60:g} min over the companion forced command (alert only)"
        if self._interval <= 0:
            return "bridge probe: OFF (--bridge-probe-minutes 0)"
        return (f"bridge probe: OFF ({type(self._adapter).__name__} cannot probe — "
                "the MCP bridge flag is off or no companion SSH host is configured)")

    def maybe_run(self, should_stop: Callable[[], bool] = lambda: False) -> dict[str, int] | None:
        """Sweeps if enabled and the interval has passed since the last sweep
        began (the first idle poll after start counts as due). None otherwise."""
        if not self.enabled:
            return None
        now = self._clock()
        if self._last is not None and now - self._last < self._interval:
            return None
        # Stamped BEFORE the sweep, so a sweep that raises still waits a full
        # interval rather than retrying on every idle poll.
        self._last = now
        return self.run(should_stop)

    def _connect(self) -> Any:
        """The sweep's own connection: autocommit, so no transaction is held
        open across a slow SSH probe, and a statement_timeout, so a row lock
        held elsewhere fails one statement instead of parking the only thread
        that picks up provisioning jobs. Set with SET rather than a connection
        option so it cannot clobber options the database URL already carries."""
        import psycopg
        from psycopg.rows import dict_row

        conn = psycopg.connect(self._db_url, row_factory=dict_row, autocommit=True, connect_timeout=10)
        try:
            conn.execute(f"SET statement_timeout = {int(self.STATEMENT_TIMEOUT_MS)}")
        except Exception:
            conn.close()
            raise
        return conn

    def run(self, should_stop: Callable[[], bool] = lambda: False) -> dict[str, int]:
        from .provisioner import record_bridge_probe

        summary = {"probed": 0, "ok": 0, "failed": 0, "errors": 0, "unverifiable": 0,
                   "marked": 0, "cleared": 0, "write_failed": 0, "aborted": 0}
        could_not_ask_in_a_row = 0
        with self._connect() as conn:
            targets = self._targets(conn)
            # Forget trips that stopped being live, so a trip that comes back
            # later starts from zero and the map cannot grow without bound.
            live = {t["trip_id"] for t in targets}
            self._failures = {k: v for k, v in self._failures.items() if k in live}
            for index, target in enumerate(targets):
                if should_stop():
                    break
                trip_id, slug, profile = target["trip_id"], target["slug"], target["hermes_profile"]
                summary["probed"] += 1
                try:
                    ok, code = self._adapter.probe(slug, profile)
                except Exception as exc:  # never let one trip end the sweep
                    # BridgeProbeError carries a reason composed to be safe to
                    # log; anything else is named by class only, because its
                    # text is not known to be free of what it was handed.
                    error = exc.safe_reason if isinstance(exc, BridgeProbeError) else type(exc).__name__
                    summary["errors"] += 1
                    could_not_ask_in_a_row += 1
                    logger.warning(log_fields(
                        "provisioner.bridge_probe_error", slug=slug, trip_id=trip_id, error=error,
                        effect="could not ask; reachability left as it was, failed-verdict count unchanged",
                    ), extra={"trip_id": trip_id, "slug": slug, "error": error})
                    if could_not_ask_in_a_row >= self.BREAKER_AFTER:
                        skipped = len(targets) - index - 1
                        summary["aborted"] = 1
                        logger.warning(log_fields(
                            "provisioner.bridge_probe_sweep_aborted", after=could_not_ask_in_a_row,
                            last_slug=slug, last_error=error, skipped=skipped,
                            effect=(f"the companion host is not answering; the rest of this sweep is skipped so "
                                    f"provisioning is not held up. Next sweep in {self._interval / 60:g} min"),
                        ), extra={"slug": slug, "error": error, "skipped": skipped})
                        break
                    continue
                could_not_ask_in_a_row = 0

                if not ok and code in self.UNVERIFIABLE:
                    # Asked, answered, and the answer says nothing about
                    # whether the bridge works — so it is not a failure. Loud
                    # every sweep until the bridge is restarted on a current
                    # checkout; the failed-verdict count neither grows nor resets.
                    summary["unverifiable"] += 1
                    logger.warning(log_fields(
                        "provisioner.bridge_probe_unverifiable", slug=slug, trip_id=trip_id, code=code,
                        effect=self.UNVERIFIABLE[code],
                    ), extra={"trip_id": trip_id, "slug": slug, "code": code})
                    continue
                if ok:
                    summary["ok"] += 1
                    self._failures.pop(trip_id, None)
                    outcome = record_bridge_probe(conn, trip_id, ok=True, slug=slug)
                else:
                    # NO_KEY counts here like any failure, although `verify()`
                    # treats a missing mcp/.env as a note: for a LIVE trip with
                    # a companion it means the same thing the organizer sees —
                    # the companion cannot read its trip (decision F7).
                    summary["failed"] += 1
                    count = self._failures.get(trip_id, 0) + 1
                    self._failures[trip_id] = count
                    logger.warning(log_fields(
                        "provisioner.bridge_probe_failed", slug=slug, trip_id=trip_id, code=code,
                        failed_verdicts=f"{min(count, self.CONFIRM_AFTER)}/{self.CONFIRM_AFTER}",
                        rule="failed verdicts with no successful verdict between them",
                    ), extra={"trip_id": trip_id, "slug": slug, "code": code, "failed_verdicts": count})
                    outcome = record_bridge_probe(
                        conn, trip_id, ok=False, code=code,
                        confirmed=count >= self.CONFIRM_AFTER, slug=slug,
                    )
                if outcome in summary:
                    summary[outcome] += 1
        logger.info(log_fields("provisioner.bridge_probe_sweep", **summary), extra=summary)
        return summary

    @staticmethod
    def _targets(conn: Any) -> list[dict[str, Any]]:
        """Every live trip with a companion behind an open binding: the trip is
        `ready_private`, not torn down (`retired-%`), and at least one open
        binding names a profile. One row per trip, the newest binding's
        profile — the same rule migration 20260922060000 used to backfill
        `trips.hermes_profile`."""
        return conn.execute(
            """SELECT DISTINCT ON (t.id) t.id AS trip_id, t.slug, b.hermes_profile
                 FROM control_plane.trips t
                 JOIN control_plane.telegram_chat_bindings b ON b.trip_id = t.id
                WHERE t.lifecycle_state = 'ready_private'
                  AND t.slug NOT LIKE 'retired-%'
                  AND b.closed_at IS NULL
                  AND b.hermes_profile IS NOT NULL
                ORDER BY t.id, b.created_at DESC"""
        ).fetchall()


class ShellMcpBridgeAdapter:
    """Calls kinerary-deploy/setup-mcp.sh via subprocess, mirroring
    ShellDeployAdapter's subprocess pattern in provisioner.py."""

    def __init__(
        self,
        deploy_root: str,
        vmid_map: Mapping[str, str],
        # setup-mcp.sh does not just write config: it starts the bridge,
        # registers it, patches the transport and then RUNS `hermes mcp test`,
        # which enumerates every tool over a live connection. Timed end to end
        # on 2026-09-10 that is ~6 minutes. At 180s it was killed every single
        # run — `setup-mcp.sh exited -15`, SIGTERM, reported as a bridge
        # failure when nothing had failed except the clock. Four provisions in
        # a row lost their MCP wiring to it.
        timeout: int = 900,
    ) -> None:
        self._deploy_root = deploy_root
        self._vmid_map = vmid_map
        self._timeout = timeout

    def setup(self, slug: str, profile_name: str) -> bool:
        trip_dir = os.path.join(self._deploy_root, "trips", slug)
        local_url = self._local_url(trip_dir)
        if not local_url:
            return False

        # The static map only ever covers the two hand-provisioned legacy
        # trips; a Phase-G auto-created trip's vmid instead lives in
        # topology.yaml, written there by compute.LxcProvisionAdapter once
        # Proxmox assigns it.
        vmid = self._vmid_map.get(slug) or self._topology_vmid(trip_dir)
        if not vmid:
            return False

        port = mcp_port_for_vmid(vmid)
        if port is None:
            return False

        setup_mcp_sh = os.path.join(self._deploy_root, "setup-mcp.sh")
        result = subprocess.run(
            [
                setup_mcp_sh, profile_name, local_url,
                "--vmid", vmid, "--trip-dir", trip_dir, "--port", str(port),
            ],
            capture_output=True,
            text=True,
            timeout=self._timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"setup-mcp.sh exited {result.returncode}: "
                f"{result.stderr[:500] or result.stdout[:500]}"
            )
        return True

    def _local_url(self, trip_dir: str) -> str | None:
        """Reads proxmox.lxc.ipv4 and npm.forward_port out of topology.yaml
        with the same deliberately-minimal line scan _private_url uses for
        npm.hostname — not a real YAML parse, matching the existing
        convention in this file rather than adding a new dependency."""
        topology_path = os.path.join(trip_dir, "topology.yaml")
        ipv4 = None
        port = None
        try:
            with open(topology_path, encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if stripped.startswith("ipv4:"):
                        ipv4 = stripped.split(":", 1)[1].strip().split("/")[0]
                    elif stripped.startswith("forward_port:"):
                        port = stripped.split(":", 1)[1].strip()
        except FileNotFoundError:
            return None
        if not ipv4 or not port:
            return None
        return f"http://{ipv4}:{port}"

    def _topology_vmid(self, trip_dir: str) -> str | None:
        """Same deliberately-minimal line scan as _local_url, for the
        proxmox.vmid line compute.LxcProvisionAdapter writes back into
        topology.yaml once it's known (absent for the two legacy trips,
        which never go through that adapter)."""
        topology_path = os.path.join(trip_dir, "topology.yaml")
        try:
            with open(topology_path, encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if stripped.startswith("vmid:"):
                        # yaml.safe_dump quotes a numeric-looking string
                        # value (vmid: '205') to preserve it as text.
                        return stripped.split(":", 1)[1].strip().strip("'\"") or None
        except FileNotFoundError:
            return None
        return None
