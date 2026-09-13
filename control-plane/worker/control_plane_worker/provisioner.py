"""Provisioner worker: claims approved provision jobs from PostgreSQL and
deploys Kinerary trip instances via the kinerary-deploy shell scripts.

The worker operates exclusively over the private PostgreSQL queue — it has no
public HTTP listener and no inbound network surface. The only privileged entry
point is the database connection.

The deploy adapter interface is injectable so tests can use a fake that writes
config to a temp directory without touching Proxmox. The real adapter calls
kinerary-deploy/deploy.sh via subprocess.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Protocol

import psycopg
from psycopg.rows import dict_row

from .companion_profile import (
    CompanionProfileAdapter,
    NullCompanionProfileAdapter,
    build_companion_handoff,
)
from .compute import ComputeAdapter, NullComputeAdapter
from .mcp_bridge import McpBridgeAdapter, NullMcpBridgeAdapter
from .release_source import ReleaseSourceError, materialize_release_source
from .transformer import (
    derive_bookings,
    derive_trip_slug,
    intake_destination,
    transform_intake,
)

# (config, destination) -> config. See ProvisionerWorker.__init__ for why this
# defaults to a passthrough rather than the live enrich_config.
EnrichFn = Callable[[dict[str, Any], str], dict[str, Any]]

# (source_revision, artifact_digest | None) -> a directory holding site/ server/
# shared/ checked out at that revision. Injectable so tests do not need a git
# repo; None means "use the real release_source.materialize_release_source".
MaterializeFn = Callable[[str, Optional[str]], str]

logger = logging.getLogger(__name__)

# Slug assigned at signup approval, before the interview reveals the trip.
DRAFT_SLUG_PREFIX = "draft-"
# Bounded so a pathological base cannot spin the worker.
SLUG_COLLISION_LIMIT = 100


class DeployAdapter(Protocol):
    """Deploys a trip config and returns the private URL."""

    def deploy(
        self,
        slug: str,
        config: dict[str, Any],
        *,
        first_provision: bool = False,
        sidecars: Mapping[str, Any] | None = None,
        source_dir: str | None = None,
    ) -> str: ...


# ── Reachability ─────────────────────────────────────────────────────────────

#: Why a provisioned trip cannot be reached from Telegram. A closed set on
#: purpose: an operator reading `unreachable_reason` needs to know which
#: component to retry, and free text does not answer that.
UNREACHABLE_REASONS = {
    # The organizer's answer matched no participant, or matched more than one.
    # `_resolve_organizers` refuses to guess, so there is no organizer to give
    # a private channel to. This is what actually happened on 2026-09-06.
    "ORGANIZER_UNRESOLVED",
    # The assistant questions were never answered, so there is no companion to
    # name. Legitimate for a trip whose organizer skipped them.
    "ASSISTANT_UNCONFIGURED",
    # This deployment has no companion templates directory, so the Null
    # adapter is in play and no profile was ever going to be created.
    "COMPANION_TEMPLATES_ABSENT",
    # `render_profile.py` failed — today, because the worker image carries
    # neither `hermes` nor `node` (activation-scope.md B1).
    "COMPANION_INSTALL_FAILED",
    # A companion exists but there is no organizer chat id to bind it to.
    "NO_ORGANIZER_CHAT",
    # The chat is already bound to a different trip; moving it is a reviewed
    # organizer action this job has no standing to perform.
    "BINDING_REFUSED",
    # The binding write itself failed.
    "BINDING_FAILED",
}


def _record_reachability(
    conn: Any,
    trip_id: str,
    *,
    reachable: bool,
    reason: str | None = None,
    consequence: str = "",
) -> None:
    """Records whether this trip can be reached, and logs it if it cannot.

    Two things this deliberately is NOT. It is not part of `lifecycle_state`:
    `activation_approved`/`active` sit unused in that enum and
    `docs/activation-scope.md` says not to implement them merely because they
    exist. And it is never DERIVED — not from an open binding row, not from
    `assistant_names` being populated. A binding can outlive the profile it
    points at, which is exactly the false-healthy state that makes an
    independent retry impossible to reason about.

    Unreachable logs at WARNING because the whole failure this addresses was
    an `info` line nobody saw: the successful run of 2026-09-06 emitted one
    log line in total, and none of them said the trip was unreachable.
    """
    assert reachable or reason in UNREACHABLE_REASONS, f"unknown reason {reason!r}"
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE control_plane.trips
                          SET reachability = %s,
                              unreachable_reason = %s,
                              reachability_checked_at = now()
                        WHERE id = %s""",
                    ("reachable" if reachable else "unreachable",
                     None if reachable else reason, trip_id),
                )
    except Exception:
        # Never fail a provisioning run over its own observability.
        logger.warning("provisioner.reachability_write_failed",
                       extra={"trip_id": trip_id}, exc_info=True)
        return

    if reachable:
        logger.info("provisioner.trip_reachable", extra={"trip_id": trip_id})
    else:
        logger.warning("provisioner.trip_unreachable", extra={
            "trip_id": trip_id,
            "reason": reason,
            "consequence": consequence or "the organizer cannot reach this trip from Telegram",
        })


class ShellDeployAdapter:
    """Calls kinerary-deploy/deploy.sh via subprocess.

    Reads the private URL from the per-trip topology.yaml (npm.hostname).
    """

    def __init__(
        self,
        deploy_root: str,
        vmid_map: Mapping[str, str],
        repo_root: str | None = None,
        timeout: int = 300,
        compute: ComputeAdapter | None = None,
    ) -> None:
        self._deploy_root = deploy_root
        self._vmid_map = vmid_map
        self._repo_root = repo_root or os.environ.get("REPO_ROOT", "")
        self._timeout = timeout
        self._compute = compute or NullComputeAdapter()

    def deploy(
        self,
        slug: str,
        config: dict[str, Any],
        *,
        first_provision: bool = False,
        sidecars: Mapping[str, Any] | None = None,
        source_dir: str | None = None,
    ) -> str:
        # A static vmid_map entry (the two legacy, hand-provisioned trips)
        # always wins; a slug with no entry falls to the compute adapter —
        # NullComputeAdapter by default, which raises the same error this
        # used to raise unconditionally before Phase G existed. first_provision
        # only reaches the compute path (a vmid_map trip is a long-lived hand
        # box whose data is never reset here).
        vmid = self._vmid_map.get(slug) or self._compute.create_container(
            slug, first_provision=first_provision
        )

        trip_dir = os.path.join(self._deploy_root, "trips", slug)
        os.makedirs(trip_dir, exist_ok=True)
        config_path = os.path.join(trip_dir, "trip.config.json")
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump(config, fh, ensure_ascii=False, indent=2)

        # bookings.json / trivia_questions.json sit beside trip.config.json;
        # deploy.sh tars the whole trip dir onto the container, so writing them
        # here is all that's needed — they are not deploy.sh arguments.
        for name, payload in (sidecars or {}).items():
            with open(os.path.join(trip_dir, name), "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)

        deploy_sh = os.path.join(self._deploy_root, "deploy.sh")
        env = {**os.environ}
        # A materialized release checkout (site/ server/ shared/ at the promoted
        # revision) wins over the ambient repo — deploy.sh tars ${REPO_ROOT}/{server,site,shared}.
        repo_root = source_dir or self._repo_root
        if repo_root:
            env["REPO_ROOT"] = repo_root

        result = subprocess.run(
            [deploy_sh, slug, vmid, "--sync-config", "--restart", "--trip-dir", trip_dir],
            capture_output=True,
            text=True,
            timeout=self._timeout,
            env=env,
        )
        if result.returncode != 0:
            # BOTH streams, not `stderr or stdout`: deploy.sh reports progress
            # and its failure diagnostics (the health check's journalctl dump,
            # npm's build errors) on stdout, while stderr carries only ssh's
            # "Permanently added ... known hosts" warnings. Preferring stderr
            # therefore reported pure noise on every real failure. Tails are
            # kept because the failing command's own message comes last.
            detail = " | ".join(
                f"{name}: {text.strip()[-600:]}"
                for name, text in (("stdout", result.stdout), ("stderr", result.stderr))
                if text and text.strip()
            )
            raise RuntimeError(f"deploy.sh exited {result.returncode}: {detail or '(no output)'}")

        return self._private_url(trip_dir)

    def _private_url(self, trip_dir: str) -> str:
        topology_path = os.path.join(trip_dir, "topology.yaml")
        try:
            with open(topology_path, encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if stripped.startswith("hostname:") and "npm:" not in stripped:
                        # The npm.hostname line — take the first indented hostname
                        hostname = stripped.split(":", 1)[1].strip()
                        if hostname and not hostname.startswith("$"):
                            return f"https://{hostname}"
        except FileNotFoundError:
            pass
        raise ValueError(f"could not determine private URL from {topology_path}")


def _generate_notif_id() -> str:
    return f"notif_{secrets.token_hex(16)}"


def _generate_binding_id() -> str:
    return f"tcb_{secrets.token_hex(16)}"


def _generate_route_id() -> str:
    return f"route_{secrets.token_hex(16)}"


class BindingRefused(Exception):
    """A chat is already bound, in force, to a DIFFERENT trip.

    Retargeting it is a reassignment, and the sprint plan requires one to be
    confirmed by a signed organizer action and reviewed — none of which a
    background provisioning job has or can obtain. Silently rebinding would
    take a group that is actively using trip A and point it at trip B, so the
    provisioner refuses and leaves the existing binding untouched.
    """

    def __init__(self, chat_id: str, existing_trip_id: str, requested_trip_id: str) -> None:
        super().__init__("chat is already bound to another trip")
        self.chat_id = chat_id
        self.existing_trip_id = existing_trip_id
        self.requested_trip_id = requested_trip_id


def attach_profile_to_orphan_bindings(
    conn: psycopg.Connection, trip_id: str, hermes_profile: str
) -> int:
    """Gives the trip's companion to every open binding that has none.

    A binding can legitimately exist without a profile (migration 0043): routing
    and the assistant behind it are separate components. The gap is what happens
    when the profile arrives LATER — nothing went back for the bindings made
    before it.

    Live on 2026-09-07: the organizer bound their family group with a token
    while the companion did not yet exist, so the row stored NULL. The companion
    was installed twenty minutes later, on a retry, and bound only the
    organizer's DM. The group kept answering "I'm still finishing your
    assistant" — honestly, and permanently, because nothing was ever going to
    finish it for that chat.

    One companion serves every chat on its trip, so a binding orphaned by
    ordering is simply out of date. Scoped to this trip's OWN open bindings, and
    only those with no profile: a chat pointing at some other profile is a
    decision, not a gap, and is left alone.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE control_plane.telegram_chat_bindings
               SET hermes_profile = %s
             WHERE trip_id = %s
               AND closed_at IS NULL
               AND hermes_profile IS NULL
            """,
            (hermes_profile, trip_id),
        )
        return cur.rowcount or 0


def link_organizer_person(
    conn: psycopg.Connection,
    trip_id: str,
    telegram_user_id: str,
    participant_username: str,
    display_name: str | None,
) -> bool:
    """Records WHO the chat being bound belongs to, not just where it routes.

    `bind_chat_to_trip` answers "which companion serves this chat". This
    answers "and whose chat is it" — the join that was missing, between the
    participant `_resolve_organizers` already picked out of the intake and the
    chat id the binding is about to use. Both are in hand in the same
    transaction; until 2026-09-12 nothing put them in the same row, so the
    assistant could route a message perfectly and still have no idea it was
    talking to the organizer (migration 0051 has the full story).

    Private-chat ids only. A group id is not a person, and the one place this
    is called from passes the organizer's own chat — but the schema and this
    guard both say so, because the next caller will be a family member binding
    themselves and "whoever spoke in the group" is exactly the mistake to make
    impossible rather than to avoid.

    Returns whether a row is now there. Non-fatal by construction: a trip whose
    identity link fails still routes, exactly as every trip did before this
    existed.
    """
    if not telegram_user_id.isdigit() or not participant_username:
        return False
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO control_plane.trip_person_links
                  (id, trip_id, telegram_user_id, participant_username,
                   display_name, role, verified_via)
                VALUES (%s, %s, %s, %s, %s, 'organizer', 'interview_chat')
                ON CONFLICT (trip_id, telegram_user_id) DO UPDATE
                   SET participant_username = EXCLUDED.participant_username,
                       display_name = EXCLUDED.display_name,
                       role = EXCLUDED.role
                """,
                (
                    f"tpl_{secrets.token_hex(16)}",
                    trip_id,
                    telegram_user_id,
                    participant_username,
                    display_name,
                ),
            )
    return True


def bind_chat_to_trip(
    conn: psycopg.Connection,
    chat_id: str,
    trip_id: str,
    hermes_profile: str | None,
) -> str:
    """Opens the binding that routes `chat_id` to `trip_id`, closing rather
    than overwriting whatever was there before.

    `hermes_profile` may be None: the chat belongs to the trip whether or not
    an assistant has been installed behind it yet (migration 0043). That is
    NOT a claim the trip is reachable — `trips.reachability` is, and it is
    written elsewhere. Binding an unserved chat is what lets the companion be
    retried later without first reconstructing routing.

    Returns the outcome as a short string for logging: "created", "unchanged",
    or "profile_rebound".

    Three cases, and the distinction between the last two is the whole point:

      no open binding      -> open one.
      same trip            -> not a reassignment. Identical profile is a
                              no-op (a re-provision of an unchanged trip);
                              a changed profile closes the old row and opens
                              a new one, so even this leaves a trail.
      a DIFFERENT trip     -> refuse. See BindingRefused.

    Runs in one transaction and takes FOR UPDATE on the open row, so two
    provisions racing for the same chat serialise here instead of both
    believing they won. The partial unique index from migration 0029 is the
    backstop if they somehow don't.
    """
    with conn.transaction():
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT id, trip_id, hermes_profile
                FROM control_plane.telegram_chat_bindings
                WHERE chat_id = %s AND closed_at IS NULL
                FOR UPDATE
                """,
                (chat_id,),
            )
            existing = cur.fetchone()

            if existing is not None:
                if existing["trip_id"] != trip_id:
                    raise BindingRefused(chat_id, existing["trip_id"], trip_id)
                if existing["hermes_profile"] == hermes_profile:
                    return "unchanged"

                cur.execute(
                    """
                    UPDATE control_plane.telegram_chat_bindings
                    SET closed_at = now(), closed_reason = 'profile_rebound'
                    WHERE id = %s
                    """,
                    (existing["id"],),
                )

            cur.execute(
                """
                INSERT INTO control_plane.telegram_chat_bindings
                  (id, chat_id, trip_id, hermes_profile)
                VALUES (%s, %s, %s, %s)
                """,
                (_generate_binding_id(), chat_id, trip_id, hermes_profile),
            )
            return "created" if existing is None else "profile_rebound"


class _LeaseHeartbeat:
    """Renews a claimed job's lease on a background thread while run_once()
    works the job.

    run_once() is single-threaded and blocks on multi-minute SSH subprocesses
    during a real provision — the container bootstrap alone has a 900s ceiling
    — so without this the lease can expire under a perfectly healthy run and
    recoverStaleLeases re-queues the job, producing a second provision. The
    thread renews every `interval_seconds`; if the renewing UPDATE ever matches
    no row the lease is no longer ours (stolen, or the job already moved on)
    and the thread stops. Transient DB errors are logged and retried until
    stop().

    Used as a context manager so start/stop is exception-safe.
    """

    def __init__(
        self,
        db_url: str,
        job_id: str,
        worker_id: str,
        lease_seconds: float,
        interval_seconds: float,
    ) -> None:
        self._db_url = db_url
        self._job_id = job_id
        self._worker_id = worker_id
        self._lease_seconds = lease_seconds
        self._interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.lease_lost = False

    def __enter__(self) -> "_LeaseHeartbeat":
        self._thread = threading.Thread(
            target=self._loop,
            name=f"lease-heartbeat-{self._job_id}",
            daemon=True,
        )
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        # wait() at the top: the claim already set lease_expires_at and
        # last_heartbeat_at, so the first renewal is only due one interval in.
        # A fast job (every unit test) stops before this first wait returns and
        # never opens a connection here.
        while not self._stop.wait(self._interval_seconds):
            try:
                with psycopg.connect(self._db_url) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE control_plane.jobs
                            SET    lease_expires_at = now() + make_interval(secs => %s::float8),
                                   last_heartbeat_at = now(),
                                   updated_at = now()
                            WHERE  id = %s AND lease_owner = %s AND state = 'leased'
                            """,
                            (self._lease_seconds, self._job_id, self._worker_id),
                        )
                        if cur.rowcount == 0:
                            # The job is no longer 'leased' by us: either it
                            # just completed (a beat racing _complete/_fail at
                            # the tail — harmless) or the lease was stolen. The
                            # thread's job is only to renew, so either way it
                            # stops; _complete/_fail's own lease guards and
                            # recoverStaleLeases are the real safety net.
                            logger.info(
                                "provisioner.heartbeat_stopping_lease_not_held",
                                extra={"job_id": self._job_id},
                            )
                            self.lease_lost = True
                            return
            except Exception:  # transient DB blip — keep beating until stop()
                logger.warning(
                    "provisioner.heartbeat_failed",
                    exc_info=True,
                    extra={"job_id": self._job_id},
                )


class ProvisionerWorker:
    """Claims one approved provision job at a time, transforms intake to
    trip.config.json, deploys via the deploy adapter, and records the result.

    All DB operations are direct PostgreSQL — the worker does not call the
    TypeScript API. The claim/complete/fail logic mirrors job-queue.ts exactly:
    approval is consumed only at terminal events (success or exhausted failure).
    """

    # Covers the 900s single-remote-command ceiling (SubprocessSshTransport in
    # provisioning/adapters.py) even if the heartbeat thread stalls. A running
    # job's lease is renewed every HEARTBEAT_INTERVAL_SECONDS on a side thread
    # (see _LeaseHeartbeat), so a genuinely long healthy provision never loses
    # its lease; a dead worker's lease still expires within LEASE_SECONDS of its
    # last beat and recoverStaleLeases reclaims it.
    LEASE_SECONDS = 900
    HEARTBEAT_INTERVAL_SECONDS = 60
    DEFAULT_WORKER_ID_PREFIX = "provisioner"

    def __init__(
        self,
        db_url: str,
        deploy: DeployAdapter,
        worker_id: str | None = None,
        companion: CompanionProfileAdapter | None = None,
        mcp_bridge: McpBridgeAdapter | None = None,
        enrich: EnrichFn | None = None,
        repo_root: str | None = None,
        materialize: MaterializeFn | None = None,
        operator_chat_id: str | None = None,
        seed_password: str | None = None,
    ) -> None:
        self._db_url = db_url
        self._deploy = deploy
        # Raw Telegram chat id for the operator's own copy of the provisioning
        # outcome. None (the default, and every existing test) enqueues no
        # operator row at all — the organizer notification is unaffected either
        # way, and nothing in the job path reads these rows back.
        self._operator_chat_id = operator_chat_id or None
        # The shared site login, carried into the organizer's introduction so
        # they can be TOLD the password rather than walked through finding it.
        # It is the SAME value the compute adapter bakes into the site's .env —
        # passed here rather than re-read, so the two can never disagree.
        # Empty (the default, and every existing test) simply omits the line.
        self._seed_password = seed_password or None
        self._worker_id = worker_id or f"{self.DEFAULT_WORKER_ID_PREFIX}_{secrets.token_hex(8)}"
        self._companion = companion or NullCompanionProfileAdapter()
        self._mcp_bridge = mcp_bridge or NullMcpBridgeAdapter()
        # Default is a no-op passthrough: destination enrichment makes live
        # HTTP calls, so it stays off unless __main__ wires enrich_config in,
        # matching how compute/mcp_bridge default to their Null adapters.
        self._enrich = enrich or (lambda config, destination: config)
        # Where to check out a promoted release's source_revision from. Same
        # value ShellDeployAdapter uses as its fallback REPO_ROOT.
        self._repo_root = repo_root or os.environ.get("PROVISIONER_REPO_ROOT") or os.environ.get("REPO_ROOT", "")
        self._materialize = materialize or (
            lambda revision, digest: materialize_release_source(self._repo_root, revision, digest)
        )

    # ── public API ──────────────────────────────────────────────────────────────

    def run_once(self) -> bool:
        """Claim and process one provision job. Returns True if a job was found."""
        with psycopg.connect(self._db_url, row_factory=dict_row) as conn:
            claim = self._claim(conn)
            if claim is None:
                return False

            job_id = claim["job_id"]
            trip_id = claim["trip_id"]
            plan_id = claim["plan_id"]
            attempt = claim["attempt"]

            # Renew the lease on a side thread for the life of the job — the
            # body below blocks on multi-minute SSH subprocesses and must not
            # let a healthy run's lease lapse into a re-queue.
            with _LeaseHeartbeat(
                self._db_url, job_id, self._worker_id,
                self.LEASE_SECONDS, self.HEARTBEAT_INTERVAL_SECONDS,
            ):
                self._work_claimed_job(conn, job_id, trip_id, plan_id, attempt)

        return True

    def _work_claimed_job(
        self,
        conn: psycopg.Connection,
        job_id: str,
        trip_id: str,
        plan_id: str,
        attempt: int,
    ) -> None:
        try:
            # Load plan.desired to get intake_version_id.
            plan_desired = self._load_plan_desired(conn, plan_id)
            intake_version_id = plan_desired.get("intake_version_id")
            if not intake_version_id:
                raise ValueError("plan.desired missing intake_version_id")

            # Load trip slug.
            slug = self._load_trip_slug(conn, trip_id)

            # Load intake answers from intake_versions.data.
            answers = self._load_intake_data(conn, intake_version_id)

            # Transform to trip.config.json. The language comes from the
            # intake VERSION, not the session — the session does not survive a
            # reset or a correction, and this runs long after either.
            config = transform_intake(
                answers,
                language=self._load_intake_language(conn, intake_version_id),
            )

            # Deterministic destination enrichment (Sprint 4.5): currency /
            # emergency numbers for the country, lat-lng per phase, a hero
            # photo per phase — each from a keyless public API. The default
            # is a passthrough; __main__ injects the live enrich_config.
            # It self-guards, but a provision job must never fail on an
            # enrichment miss, so wrap it again here.
            try:
                config = self._enrich(config, intake_destination(answers))
            except Exception:  # pragma: no cover - enrich_config self-guards
                logger.warning("provisioner.enrichment_failed", exc_info=True)

            # Sidecar files that live beside trip.config.json in the trip
            # dir. trivia_questions.json is always written empty: control-
            # plane trips ship without trivia (documented descope in
            # docs/onboarding-mvp-sprint-plan.md, Sprint 4.5), and an empty
            # file stops the trip server erroring on every boot.
            # bookings.json carries the phase hotels and the travel_anchors
            # the interview captured, which the config itself drops.
            sidecars: dict[str, Any] = {"trivia_questions.json": []}
            # Private identity sidecar: never part of the public trip config.
            # The transformer resolves organizer_identity to exactly one local
            # participant. Ambiguity disables portal handoff, never guesses.
            organizers = (config.get("agent") or {}).get("organizers", [])
            with conn.cursor(row_factory=dict_row) as identity_cur:
                identity_cur.execute(
                    "SELECT user_id FROM control_plane.trip_memberships "
                    "WHERE trip_id = %s AND role = 'owner' AND status = 'active'",
                    (trip_id,),
                )
                owners = identity_cur.fetchall()
            owner = ({"userId": owners[0]["user_id"], "username": organizers[0]}
                     if len(owners) == 1 and len(organizers) == 1 else None)
            sidecars["control-plane.identity.json"] = {
                "version": 1, "tripId": trip_id, "owner": owner,
            }

            bookings = derive_bookings(config, answers)
            if bookings:
                sidecars["bookings.json"] = bookings

            # The slug assigned at signup approval is a placeholder — the
            # destination and dates were not known yet. Now that the intake
            # is confirmed, promote it to the one the family will see.
            slug = self._promote_draft_slug(conn, trip_id, slug, answers)

            # Deploy the exact source the promoted release was scanned at, not
            # whatever is in the worker's repo checkout. A manifest-backed
            # release (release_verified) is materialized and digest-verified; the
            # hand-seeded dev release has no manifest and no real digest, so it
            # falls back to REPO_ROOT with a warning.
            source_dir = self._materialize_release_if_verified(plan_desired, job_id)
            try:
                # first_provision (from plan.desired, computed by the planner)
                # tells the compute adapter whether this trip has ever been
                # provisioned successfully — if not, any leftover per-trip NFS
                # data is debris from a failed earlier attempt and is cleared so
                # the freshly seeded users/config take.
                private_url = self._deploy.deploy(
                    slug, config,
                    first_provision=bool(plan_desired.get("first_provision", False)),
                    sidecars=sidecars,
                    source_dir=source_dir,
                )
            finally:
                if source_dir:
                    shutil.rmtree(source_dir, ignore_errors=True)

            # Commit success.
            self._complete(
                conn, job_id, plan_id, trip_id, private_url,
                slug=slug, config=config, intake_version_id=intake_version_id,
            )

            logger.info(
                "provisioner.job_succeeded",
                extra={"job_id": job_id, "trip_id": trip_id, "attempt": attempt},
            )

        except Exception as exc:
            error_code = getattr(exc, "safe_error_code", None) or "PROVISIONER_ERROR"
            logger.warning(
                "provisioner.job_failed",
                extra={"job_id": job_id, "error_code": error_code, "attempt": attempt},
                exc_info=True,
            )
            self._fail(conn, job_id, plan_id, error_code)

    def _materialize_release_if_verified(
        self, plan_desired: Mapping[str, Any], job_id: str,
    ) -> str | None:
        """A checkout dir for a manifest-backed release's source_revision, or
        None to deploy from REPO_ROOT. A materialize failure (unreachable
        revision, digest mismatch) is fatal — it carries a safe_error_code so
        the job records why rather than deploying unverified code."""
        revision = plan_desired.get("release_source_revision")
        if not revision:
            return None
        if not plan_desired.get("release_verified"):
            # The dev-seed release (migration 0016): no manifest, artifact_digest
            # is a placeholder. Deploy REPO_ROOT as before, but say so.
            logger.warning(
                "provisioner.release_unverified",
                extra={"job_id": job_id, "release_source_revision": revision},
            )
            return None
        digest = plan_desired.get("release_artifact_digest")
        try:
            return self._materialize(revision, digest)
        except ReleaseSourceError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            exc.safe_error_code = "RELEASE_MATERIALIZE_FAILED"  # type: ignore[attr-defined]
            raise

    # ── DB operations (mirror job-queue.ts) ────────────────────────────────────

    def _claim(self, conn: psycopg.Connection) -> dict | None:
        with conn.transaction():
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT j.id AS job_id, j.trip_id, j.plan_id,
                           p.digest AS plan_digest, j.attempt, j.max_attempts
                    FROM   control_plane.jobs j
                    JOIN   control_plane.plans p ON p.id = j.plan_id
                    JOIN   control_plane.plan_approvals pa ON pa.plan_id = j.plan_id
                    WHERE  j.state = 'queued'
                      AND  j.job_type = 'provision'
                      AND  pa.used_at IS NULL
                      AND  pa.expires_at > now()
                      AND  pa.plan_digest = p.digest
                    ORDER BY j.created_at
                    LIMIT  1
                    FOR UPDATE OF j, pa SKIP LOCKED
                    """,
                )
                row = cur.fetchone()
                if row is None:
                    return None

                lease_expires_at = time.time() + self.LEASE_SECONDS
                cur.execute(
                    """
                    UPDATE control_plane.jobs
                    SET    state = 'leased',
                           lease_owner = %s,
                           lease_expires_at = to_timestamp(%s),
                           last_heartbeat_at = now(),
                           attempt = attempt + 1,
                           updated_at = now()
                    WHERE  id = %s
                    """,
                    (self._worker_id, lease_expires_at, row["job_id"]),
                )
                return row

    def _load_plan_desired(self, conn: psycopg.Connection, plan_id: str) -> dict:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT desired FROM control_plane.plans WHERE id = %s",
                (plan_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise ValueError(f"plan {plan_id!r} not found")
            return row["desired"]

    def _load_trip_slug(self, conn: psycopg.Connection, trip_id: str) -> str:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT slug FROM control_plane.trips WHERE id = %s",
                (trip_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise ValueError(f"trip {trip_id!r} not found")
            return row["slug"]

    def _promote_draft_slug(
        self,
        conn: psycopg.Connection,
        trip_id: str,
        current_slug: str,
        answers: Mapping[str, Any],
    ) -> str:
        """Replace a placeholder draft slug with one derived from the intake.

        Only ever rewrites a `draft-` placeholder. Once a trip carries a real
        slug, deployment config may already point at it, so it is left alone.

        Commits in its own transaction so the slug survives a later deploy
        failure — a retry then reuses the same slug instead of allocating a new
        one on every attempt. Returns the slug to deploy under.
        """
        if not current_slug.startswith(DRAFT_SLUG_PREFIX):
            return current_slug

        base = derive_trip_slug(answers)
        with conn.transaction():
            with conn.cursor(row_factory=dict_row) as cur:
                for attempt in range(SLUG_COLLISION_LIMIT):
                    candidate = base if attempt == 0 else f"{base}-{attempt + 1}"
                    cur.execute(
                        "SELECT 1 FROM control_plane.trips WHERE slug = %s AND id <> %s",
                        (candidate, trip_id),
                    )
                    if cur.fetchone() is not None:
                        continue
                    cur.execute(
                        "UPDATE control_plane.trips SET slug = %s WHERE id = %s",
                        (candidate, trip_id),
                    )
                    logger.info(
                        "provisioner.slug_promoted",
                        extra={"trip_id": trip_id, "slug": candidate},
                    )
                    return candidate

        raise ValueError(
            f"no free slug for base {base!r} after {SLUG_COLLISION_LIMIT} attempts"
        )

    def _enqueue_companion_intro(
        self,
        conn: "psycopg.Connection",
        trip_id: str,
        recipient_chat_id: str,
        intro_facts: dict,
    ) -> None:
        """Queues the organizer's companion introduction.

        Separate from `provisioning_complete` on purpose: that one says the SITE
        is ready and is true the moment the deploy lands. This one says the
        ASSISTANT is ready and hands over a token for binding a group to it, so
        it must not exist until the companion does.
        """
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO control_plane.notification_outbox
                  (id, trip_id, kind, recipient, payload, signup_request_id,
                   notification_type, adapter, state)
                VALUES (%s, %s, 'companion_ready', %s, %s::jsonb,
                        NULL, 'companion_ready', 'provisioner', 'pending')
                """,
                (_generate_notif_id(), trip_id, recipient_chat_id, json.dumps(intro_facts)),
            )

    def _load_intake_language(
        self, conn: psycopg.Connection, intake_version_id: str
    ) -> str | None:
        """The language the interview was held in (migration 0046).

        NULL for every version confirmed before that column existed, which the
        transformer reads as English — the behaviour those trips already have.
        """
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT language FROM control_plane.intake_versions WHERE id = %s",
                (intake_version_id,),
            )
            row = cur.fetchone()
            return (row or {}).get("language")

    def _load_intake_data(self, conn: psycopg.Connection, intake_version_id: str) -> dict:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT data FROM control_plane.intake_versions WHERE id = %s",
                (intake_version_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise ValueError(f"intake version {intake_version_id!r} not found")
            data = row["data"]
            if not data:
                raise ValueError(
                    f"intake version {intake_version_id!r} has no data "
                    "(was it confirmed before migration 0013?)"
                )
            return data

    def _load_intake_provenance(self, conn: psycopg.Connection, intake_version_id: str) -> dict[str, Any]:
        """digest/confirmed_at/schema_version for the companion-profile
        handoff's `source` block — kept separate from _load_intake_data since
        most callers only need the answers, not this provenance metadata."""
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT digest, confirmed_at, schema_version FROM control_plane.intake_versions WHERE id = %s",
                (intake_version_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise ValueError(f"intake version {intake_version_id!r} not found")
            return {
                "digest": row["digest"],
                "confirmed_at": row["confirmed_at"].isoformat(),
                "schema_version": row["schema_version"],
            }

    def _complete(
        self,
        conn: psycopg.Connection,
        job_id: str,
        plan_id: str,
        trip_id: str,
        private_url: str,
        slug: str,
        config: dict[str, Any],
        intake_version_id: str,
    ) -> None:
        result_json = json.dumps({"private_url": private_url})
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE control_plane.jobs
                    SET    state = 'succeeded',
                           result = %s::jsonb,
                           lease_owner = NULL,
                           lease_expires_at = NULL,
                           updated_at = now()
                    WHERE  id = %s AND lease_owner = %s AND state = 'leased'
                    """,
                    (result_json, job_id, self._worker_id),
                )
                if cur.rowcount == 0:
                    raise RuntimeError(f"could not mark job {job_id!r} succeeded (lease stolen?)")

                # Consume the approval — same as completeJob in TypeScript.
                cur.execute(
                    """
                    UPDATE control_plane.plan_approvals
                    SET    used_at = now()
                    WHERE  plan_id = %s AND used_at IS NULL
                    """,
                    (plan_id,),
                )

                # Retire the plan out of 'approved' — plans_trip_active_idx is a
                # partial unique index over (pending_approval, approved), so a
                # plan left approved after a terminal job permanently blocks
                # re-planning and correction for the trip.
                cur.execute(
                    """
                    UPDATE control_plane.plans
                    SET    status = 'executed', updated_at = now()
                    WHERE  id = %s AND status = 'approved'
                    """,
                    (plan_id,),
                )

                # Transition trip to ready_private.
                cur.execute(
                    """
                    UPDATE control_plane.trips
                    SET    lifecycle_state = 'ready_private', updated_at = now()
                    WHERE  id = %s
                    """,
                    (trip_id,),
                )

                # Register the runtime in the same transaction that marks the
                # deployment successful. Migration 0034 backfilled old jobs,
                # but without this writer every newly provisioned trip stayed
                # permanently invisible to the gateway, invitations, and the
                # dashboard's real launch path. Re-provisioning keeps the
                # opaque route_ref stable and only restores readiness.
                cur.execute(
                    """
                    INSERT INTO control_plane.runtime_routes
                      (trip_id, route_ref, state)
                    VALUES (%s, %s, 'ready')
                    ON CONFLICT (trip_id) DO UPDATE
                    SET state = 'ready', updated_at = now()
                    """,
                    (trip_id, _generate_route_id()),
                )

                # Enqueue organizer notification. recipient is the owner's real,
                # sendable Telegram chat id when one is on file (added in
                # migration 0017 — provider_subject_id, never the identity
                # digest) so the API's outbox dispatcher can actually deliver
                # this. Falls back to trips.notification_chat_id_hint
                # (migration 0022 — an UNVERIFIED, best-effort id captured at
                # interview start, for organizers who signed up via a
                # non-Telegram identity such as the password stopgap) only
                # when no verified identity is on file; NULL if neither is
                # present, which the dispatcher treats as unsendable and marks
                # 'skipped' rather than retrying forever.
                cur.execute(
                    """
                    SELECT ui.provider_subject_id,
                           s.telegram_chat_id AS interview_chat_id,
                           t.notification_chat_id_hint
                    FROM control_plane.trip_memberships tm
                    JOIN control_plane.trips t ON t.id = tm.trip_id
                    LEFT JOIN control_plane.user_identities ui
                      ON ui.user_id = tm.user_id AND ui.provider = 'telegram'
                    LEFT JOIN LATERAL (
                        SELECT telegram_chat_id
                        FROM control_plane.intake_sessions
                        WHERE trip_id = tm.trip_id AND telegram_chat_id IS NOT NULL
                        ORDER BY updated_at DESC
                        LIMIT 1
                    ) s ON TRUE
                    WHERE tm.trip_id = %s AND tm.role = 'owner' AND tm.status = 'active'
                    LIMIT 1
                    """,
                    (trip_id,),
                )
                owner_row = cur.fetchone()
                # Preference order is by PROVENANCE, not convenience:
                #   1. a verified Telegram identity on the owner's account;
                #   2. the chat the interview was actually conducted in —
                #      equally verified, because Telegram gave us that id when
                #      the organizer opened the deep link there (chat_router
                #      passes it as `verifiedTelegramChatId`, and deliberately
                #      does NOT write it to the unverified hint column);
                #   3. the unverified hint from migration 0022, last.
                #
                # (2) was missing until 2026-09-06 and is the COMMON case: an
                # organizer using the password signup stopgap has no Telegram
                # identity, so a trip whose entire interview happened in a
                # known chat still ended with "no organizer chat id" and an
                # unbindable companion. The chat was never unknown — it was in
                # intake_sessions the whole time.
                recipient_chat_id = (
                    (owner_row["provider_subject_id"]
                     or owner_row["interview_chat_id"]
                     or owner_row["notification_chat_id_hint"])
                    if owner_row else None
                )

                # The facts the organizer's introduction is composed from
                # (docs/companion-introduction-design.md). Composed API-side,
                # from these — never by the agent, because every line is a fact
                # that is worse than useless if invented.
                #
                # `login_password` is the shared seed login. It is already on
                # the site's .env; carrying it here is what lets the organizer
                # be TOLD it rather than having to be walked through finding
                # it. Absent, the wording falls back to "log in from the site".
                agent_cfg = config.get("agent") or {}
                meta_cfg = config.get("meta") or {}
                # NOT enqueued here. See the companion block below: the
                # introduction hands over a group-binding token, and a token
                # that exists before the companion does is a race the organizer
                # loses — they bind a group to a trip with no assistant, and the
                # binding stores NULL forever. Enqueued after the companion is
                # actually bound instead.
                intro_facts = {
                    "private_url": private_url,
                    "assistant_name": agent_cfg.get("name"),
                    "trip_title": meta_cfg.get("title"),
                    "trip_slug": slug,
                    "language": meta_cfg.get("defaultLang")
                    if meta_cfg.get("defaultLang") in ("he", "en") else "en",
                    "login_password": self._seed_password or None,
                    # WHO to log in as. The seed password is shared, so the
                    # username is the only thing telling two travellers apart —
                    # and it is derived from their name (`ella`, `nirsolomon`),
                    # not chosen, so it cannot be guessed from the site. The
                    # modern site has no name picker either, which on
                    # 2026-09-12 left an organizer with a password and no idea
                    # what to type beside it.
                    "login_usernames": [
                        {"name": p.get("name") or p.get("username"), "username": p.get("username")}
                        for p in (config.get("participants") or [])
                        if p.get("username")
                    ],
                    "proactive": agent_cfg.get("proactive") or {},
                }
                # The site-ready line only. Without `assistant_name` the
                # dispatcher words this as the plain "your trip site is ready",
                # which is exactly what is true at this point: the site is up,
                # the assistant is not yet.
                notif_payload = json.dumps({"private_url": private_url})

                # The same facts kept on the trip (migration 0044), because the
                # GROUP introduction cannot be composed now — there is no group
                # yet, and there may not be one for days. When the organizer
                # finally adds the bot to a family group, this run is long over
                # and the seed password exists nowhere else the control plane
                # can read.
                # `intro_facts`, NOT `notif_payload`. The two were transposed
                # here until 2026-09-12, and the failure was silent in exactly
                # the way a wrong variable is: the column existed, held valid
                # JSON, and carried one true fact. What it did not carry was
                # `assistant_name` — so when an organizer finally posted their
                # binding token in the family group, the dispatcher found no
                # name to greet with, fell through to the bare "this group is
                # connected to the trip", and pinned nothing. The arrival
                # message this column exists to make possible had never been
                # composable since the column was added.
                cur.execute(
                    "UPDATE control_plane.trips SET companion_intro = %s::jsonb WHERE id = %s",
                    (json.dumps(intro_facts), trip_id),
                )
                cur.execute(
                    """
                    INSERT INTO control_plane.notification_outbox
                      (id, trip_id, kind, recipient, payload, signup_request_id,
                       notification_type, adapter, state)
                    VALUES (%s, %s, 'provisioning_complete', %s, %s::jsonb,
                            NULL, 'provisioning_complete', 'provisioner', 'pending')
                    """,
                    (_generate_notif_id(), trip_id, recipient_chat_id, notif_payload),
                )

                self._enqueue_operator_notification(
                    cur, trip_id, "operator_provisioning_complete",
                    {"private_url": private_url},
                )

        # Companion-profile creation and its chat binding are best-effort
        # side effects performed after the transaction above durably commits
        # — the same "commit first, external side effect after" shape as
        # signup.ts's notification send. A failure here must never roll back
        # a successful provisioning run; it's logged and the trip is still
        # ready_private, just without an assigned companion yet.
        # The companion profile and the chat binding are two independent
        # components, attempted in that order and recovered separately (A4).
        # Until 2026-09-06 the binding sat inside `if hermes_profile`, so a
        # companion failure took routing down with it and left the organizer
        # with "I don't have a trip for this chat" — one broken component
        # presenting as two. `hermes_profile` stays None when the companion
        # did not install, and the binding is opened anyway.
        hermes_profile: str | None = None
        try:
            provenance = self._load_intake_provenance(conn, intake_version_id)
            handoff = build_companion_handoff(
                trip_id=trip_id,
                slug=slug,
                config=config,
                intake_version_id=intake_version_id,
                intake_schema_version=provenance["schema_version"],
                intake_digest=provenance["digest"],
                confirmed_at=provenance["confirmed_at"],
                canonical_site_url=private_url,
            )
            if handoff is None:
                # Two different failures wore one label until 2026-09-06, and
                # the distinction is the difference between "the organizer
                # skipped the assistant questions" (fine) and "we could not
                # work out which traveller they are" (a defect that cost a
                # trip its companion). Say which.
                agent_block = config.get("agent") or {}
                reason = (
                    "ORGANIZER_UNRESOLVED" if agent_block.get("name")
                    else "ASSISTANT_UNCONFIGURED"
                )
                logger.info("provisioner.companion_profile_skipped", extra={
                    "trip_id": trip_id, "reason": reason,
                })
                _record_reachability(
                    conn, trip_id, reachable=False, reason=reason,
                    consequence=(
                        "organizer_identity matched no participant, so no companion was created"
                        if reason == "ORGANIZER_UNRESOLVED"
                        else "the assistant questions were not answered, so there is no companion to create"
                    ),
                )
            else:
                hermes_profile = self._companion.install(handoff)
                if not hermes_profile:
                    # The Null adapter, or an adapter that declined. Nothing
                    # raised, so without this the run would report success
                    # with no companion and nothing said about it.
                    _record_reachability(
                        conn, trip_id, reachable=False,
                        reason="COMPANION_TEMPLATES_ABSENT",
                        consequence="no companion profile adapter is configured for this deployment",
                    )
                else:
                    # Independently gated and independently non-fatal: a
                    # trip-mcp wiring failure must not block the chat binding
                    # below — the organizer should still land in the right
                    # companion profile-home even if that profile can't reach
                    # trip-mcp tools yet.
                    try:
                        wired = self._mcp_bridge.setup(slug, hermes_profile)
                        logger.info(
                            "provisioner.mcp_bridge_wired" if wired else "provisioner.mcp_bridge_skipped",
                            extra={"trip_id": trip_id, "hermes_profile": hermes_profile},
                        )
                    except Exception:
                        logger.warning(
                            "provisioner.mcp_bridge_failed",
                            extra={"trip_id": trip_id, "hermes_profile": hermes_profile},
                            exc_info=True,
                        )

                    # The assistant's wake-words, recorded as a ROUTING fact
                    # (migration 0030). Under the relay the group relevance
                    # gate is the router's job, not Hermes's, so the router
                    # needs its own copy — it cannot read a Hermes profile
                    # directory from inside a container.
                    names = [
                        n for n in (
                            (handoff.get("assistant") or {}).get("name"),
                            (handoff.get("assistant") or {}).get("name_en"),
                        )
                        if isinstance(n, str) and n.strip()
                    ]
                    unique_names = list(dict.fromkeys(name.strip() for name in names))
                    if unique_names:
                        try:
                            with conn.transaction():
                                with conn.cursor() as cur:
                                    cur.execute(
                                        "UPDATE control_plane.trips SET assistant_names = %s WHERE id = %s",
                                        (unique_names, trip_id),
                                    )
                        except Exception:
                            logger.warning("provisioner.assistant_names_failed", extra={
                                "trip_id": trip_id,
                                "consequence": "group messages will fall back to @mention/reply only",
                            }, exc_info=True)
        except Exception:
            # Everything above raised past its own handler — in practice
            # `install()` itself, which is how B1 (no `hermes`/`node` reachable
            # from the worker) presents. Recorded with the reason an operator
            # would act on rather than left as a stack trace. Execution
            # continues to the binding below ON PURPOSE.
            logger.warning(
                "provisioner.companion_profile_failed",
                extra={"trip_id": trip_id},
                exc_info=True,
            )
            _record_reachability(
                conn, trip_id, reachable=False, reason="COMPANION_INSTALL_FAILED",
                consequence="the companion profile could not be created; the trip has no assistant",
            )

        # ── The chat binding, attempted whatever the companion did ──────────
        if not recipient_chat_id:
            if hermes_profile:
                # A companion exists and nobody can talk to it. A different
                # retry from every other reason here: nothing is broken, an
                # organizer chat id is simply not known yet.
                _record_reachability(
                    conn, trip_id, reachable=False, reason="NO_ORGANIZER_CHAT",
                    consequence="a companion exists but no organizer chat id is known to bind it to",
                )
        else:
            try:
                outcome = bind_chat_to_trip(conn, recipient_chat_id, trip_id, hermes_profile)
                # The same chat, as a PERSON. Deliberately here and not in its
                # own step: the two facts are one fact — this chat is the
                # organizer's — and separating them is how one of them came to
                # be recorded for months while the other was not.
                organizer_username = next(
                    iter((config.get("agent") or {}).get("organizers") or []), None
                )
                if organizer_username:
                    organizer_display = next(
                        (
                            p.get("name") or p.get("name_en")
                            for p in (config.get("participants") or [])
                            if p.get("username") == organizer_username
                        ),
                        None,
                    )
                    try:
                        linked = link_organizer_person(
                            conn, trip_id, recipient_chat_id,
                            organizer_username, organizer_display,
                        )
                        logger.info(
                            "provisioner.organizer_person_linked" if linked
                            else "provisioner.organizer_person_link_skipped",
                            extra={"trip_id": trip_id, "participant": organizer_username},
                        )
                    except Exception:
                        # Routing is the load-bearing half and it is already
                        # done. A trip that cannot say who the organizer is
                        # behaves exactly as every trip did before this.
                        logger.warning(
                            "provisioner.organizer_person_link_failed",
                            extra={"trip_id": trip_id}, exc_info=True,
                        )
                if hermes_profile:
                    # Every OTHER chat already bound to this trip and still
                    # waiting for a companion — a family group bound by token
                    # before the profile existed, most often. Without this they
                    # answer COMPANION_PENDING for good.
                    adopted = attach_profile_to_orphan_bindings(conn, trip_id, hermes_profile)
                    if adopted:
                        logger.info("provisioner.orphan_bindings_adopted", extra={
                            "trip_id": trip_id, "count": adopted,
                        })
                    # NOW the introduction, because now there is something to
                    # introduce. It carries a group-binding token, and a token
                    # delivered before this point lets the organizer bind a
                    # group to a trip with no assistant — which stores NULL and
                    # answers COMPANION_PENDING for good. Live on 2026-09-07.
                    #
                    # A companion that never installs therefore sends no
                    # introduction at all: the organizer gets the site-ready
                    # message and nothing that claims an assistant is waiting
                    # for them.
                    self._enqueue_companion_intro(
                        conn, trip_id, recipient_chat_id, intro_facts,
                    )
                    logger.info("provisioner.companion_profile_bound", extra={
                        "trip_id": trip_id,
                        "hermes_profile": hermes_profile,
                        "outcome": outcome,
                    })
                    # The ONE place 'reachable' is ever written, and it is
                    # written by the code that opened the binding to a profile
                    # that actually installed — never later, from the presence
                    # of a binding row. A binding can outlive the profile it
                    # points at, and can now legitimately exist without one.
                    _record_reachability(conn, trip_id, reachable=True)
                else:
                    logger.info("provisioner.chat_bound_without_companion", extra={
                        "trip_id": trip_id,
                        "outcome": outcome,
                        "consequence": "routing exists; the assistant behind it does not yet",
                    })
            except BindingRefused as refused:
                # Not a bug and not retryable: the chat legitimately belongs to
                # another trip, and moving it is a reviewed organizer action
                # this job has no standing to perform.
                logger.error("provisioner.companion_binding_refused", extra={
                    "trip_id": trip_id,
                    "existing_trip_id": refused.existing_trip_id,
                    "hermes_profile": hermes_profile,
                    "consequence": "trip is not reachable from this chat; reassignment needs an organizer action",
                })
                _record_reachability(
                    conn, trip_id, reachable=False, reason="BINDING_REFUSED",
                    consequence="the chat is bound to another trip; reassignment needs an organizer action",
                )
            except Exception:
                logger.error("provisioner.companion_binding_failed", extra={
                    "trip_id": trip_id,
                    "hermes_profile": hermes_profile,
                    "consequence": "trip provisioned but is unroutable — no open chat binding",
                }, exc_info=True)
                _record_reachability(
                    conn, trip_id, reachable=False, reason="BINDING_FAILED",
                    consequence="the chat binding write failed; the trip has no routing",
                )

    def _enqueue_operator_notification(
        self,
        cur: Any,
        trip_id: str,
        notification_type: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        """The operator's own copy of a provisioning outcome.

        Addressed to the configured operator chat, never to the organizer —
        which is why it may carry identifiers and a safe error code that the
        organizer-facing row deliberately withholds. Written in the same
        transaction as the outcome it reports, so the two cannot disagree.

        Observability only: nothing in the job path reads these rows back, and
        no operator chat id configured means no row at all rather than a row
        the dispatcher would mark 'skipped'.
        """
        if not self._operator_chat_id:
            return
        cur.execute(
            """
            SELECT t.title, t.destination_label, t.slug, u.display_name AS organizer_name
            FROM control_plane.trips t
            LEFT JOIN control_plane.trip_memberships tm
              ON tm.trip_id = t.id AND tm.role = 'owner' AND tm.status = 'active'
            LEFT JOIN control_plane.users u ON u.id = tm.user_id
            WHERE t.id = %s
            """,
            (trip_id,),
        )
        row = cur.fetchone() or {}
        payload: dict[str, Any] = {
            "trip_id": trip_id,
            "trip_title": row.get("title") or row.get("destination_label"),
            "trip_slug": row.get("slug"),
            "organizer": row.get("organizer_name"),
        }
        payload.update(extra or {})
        cur.execute(
            """
            INSERT INTO control_plane.notification_outbox
              (id, trip_id, kind, recipient, payload, signup_request_id,
               notification_type, adapter, state)
            VALUES (%s, %s, %s, %s, %s::jsonb, NULL, %s, 'provisioner', 'pending')
            """,
            (
                _generate_notif_id(), trip_id, notification_type,
                self._operator_chat_id, json.dumps(payload), notification_type,
            ),
        )

    def _fail(
        self,
        conn: psycopg.Connection,
        job_id: str,
        plan_id: str,
        error_code: str,
    ) -> None:
        """Re-queues the job if retries remain; marks it failed and consumes
        the approval if attempts are exhausted (mirrors failJob in TypeScript)."""
        with conn.transaction():
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    UPDATE control_plane.jobs
                    SET    state = CASE
                                     WHEN attempt >= max_attempts THEN 'failed'
                                     ELSE 'queued'
                                   END,
                           safe_error_code = CASE
                                     WHEN attempt >= max_attempts THEN %s
                                     ELSE NULL
                                   END,
                           lease_owner = NULL,
                           lease_expires_at = NULL,
                           updated_at = now()
                    WHERE  id = %s AND lease_owner = %s AND state = 'leased'
                    RETURNING attempt, max_attempts
                    """,
                    (error_code, job_id, self._worker_id),
                )
                row = cur.fetchone()
                if row is None:
                    return  # lease was stolen — nothing to do
                if row["attempt"] >= row["max_attempts"]:
                    cur.execute(
                        """
                        UPDATE control_plane.plan_approvals
                        SET    used_at = now()
                        WHERE  plan_id = %s AND used_at IS NULL
                        """,
                        (plan_id,),
                    )

                    # ...and retire the plan, for the same reason _complete
                    # does. Without this the trip keeps a spent approval, an
                    # unclaimable job and a plan still holding the active-plan
                    # index — no re-plan, no correction, no way forward.
                    cur.execute(
                        """
                        UPDATE control_plane.plans
                        SET    status = 'superseded', updated_at = now()
                        WHERE  id = %s AND status = 'approved'
                        """,
                        (plan_id,),
                    )

                    # Enqueue failure notification. Same real-chat-id lookup
                    # (with the same notification_chat_id_hint fallback) as
                    # _complete — see its comment for why 'organizer' (a role
                    # string, not an address) was never actually deliverable.
                    cur.execute(
                        """
                        SELECT ui.provider_subject_id,
                               s.telegram_chat_id AS interview_chat_id,
                               t.notification_chat_id_hint
                        FROM control_plane.jobs j
                        JOIN control_plane.trip_memberships tm
                          ON tm.trip_id = j.trip_id AND tm.role = 'owner' AND tm.status = 'active'
                        JOIN control_plane.trips t ON t.id = j.trip_id
                        LEFT JOIN control_plane.user_identities ui
                          ON ui.user_id = tm.user_id AND ui.provider = 'telegram'
                        LEFT JOIN LATERAL (
                            SELECT telegram_chat_id
                            FROM control_plane.intake_sessions
                            WHERE trip_id = j.trip_id AND telegram_chat_id IS NOT NULL
                            ORDER BY updated_at DESC
                            LIMIT 1
                        ) s ON TRUE
                        WHERE j.id = %s
                        LIMIT 1
                        """,
                        (job_id,),
                    )
                    owner_row = cur.fetchone()
                    # Preference order is by PROVENANCE, not convenience:
                    #   1. a verified Telegram identity on the owner's account;
                    #   2. the chat the interview was actually conducted in —
                    #      equally verified, because Telegram gave us that id when
                    #      the organizer opened the deep link there (chat_router
                    #      passes it as `verifiedTelegramChatId`, and deliberately
                    #      does NOT write it to the unverified hint column);
                    #   3. the unverified hint from migration 0022, last.
                    #
                    # (2) was missing until 2026-09-06 and is the COMMON case: an
                    # organizer using the password signup stopgap has no Telegram
                    # identity, so a trip whose entire interview happened in a
                    # known chat still ended with "no organizer chat id" and an
                    # unbindable companion. The chat was never unknown — it was in
                    # intake_sessions the whole time.
                    recipient_chat_id = (
                        (owner_row["provider_subject_id"]
                         or owner_row["interview_chat_id"]
                         or owner_row["notification_chat_id_hint"])
                        if owner_row else None
                    )

                    notif_payload = json.dumps({"safe_error_code": error_code})
                    cur.execute(
                        """
                        INSERT INTO control_plane.notification_outbox
                          (id, trip_id, kind, recipient, payload, signup_request_id,
                           notification_type, adapter, state)
                        VALUES (%s,
                                (SELECT trip_id FROM control_plane.jobs WHERE id = %s),
                                'provisioning_failed', %s, %s::jsonb,
                                NULL, 'provisioning_failed', 'provisioner', 'pending')
                        """,
                        (_generate_notif_id(), job_id, recipient_chat_id, notif_payload),
                    )

                    if self._operator_chat_id:
                        cur.execute(
                            "SELECT trip_id FROM control_plane.jobs WHERE id = %s",
                            (job_id,),
                        )
                        job_row = cur.fetchone()
                        if job_row:
                            self._enqueue_operator_notification(
                                cur, job_row["trip_id"], "operator_provisioning_failed",
                                {"safe_error_code": error_code},
                            )
