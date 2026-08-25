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
import subprocess
import time
from pathlib import Path
from typing import Any, Mapping, Protocol

import psycopg
from psycopg.rows import dict_row

from .companion_profile import (
    CompanionProfileAdapter,
    NullCompanionProfileAdapter,
    build_companion_handoff,
)
from .compute import ComputeAdapter, NullComputeAdapter
from .mcp_bridge import McpBridgeAdapter, NullMcpBridgeAdapter
from .transformer import derive_trip_slug, transform_intake

logger = logging.getLogger(__name__)

# Slug assigned at signup approval, before the interview reveals the trip.
DRAFT_SLUG_PREFIX = "draft-"
# Bounded so a pathological base cannot spin the worker.
SLUG_COLLISION_LIMIT = 100


class DeployAdapter(Protocol):
    """Deploys a trip config and returns the private URL."""

    def deploy(self, slug: str, config: dict[str, Any]) -> str: ...


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

    def deploy(self, slug: str, config: dict[str, Any]) -> str:
        # A static vmid_map entry (the two legacy, hand-provisioned trips)
        # always wins; a slug with no entry falls to the compute adapter —
        # NullComputeAdapter by default, which raises the same error this
        # used to raise unconditionally before Phase G existed.
        vmid = self._vmid_map.get(slug) or self._compute.create_container(slug)

        trip_dir = os.path.join(self._deploy_root, "trips", slug)
        os.makedirs(trip_dir, exist_ok=True)
        config_path = os.path.join(trip_dir, "trip.config.json")
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump(config, fh, ensure_ascii=False, indent=2)

        deploy_sh = os.path.join(self._deploy_root, "deploy.sh")
        env = {**os.environ}
        if self._repo_root:
            env["REPO_ROOT"] = self._repo_root

        result = subprocess.run(
            [deploy_sh, slug, vmid, "--sync-config", "--restart", "--trip-dir", trip_dir],
            capture_output=True,
            text=True,
            timeout=self._timeout,
            env=env,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"deploy.sh exited {result.returncode}: "
                f"{result.stderr[:500] or result.stdout[:500]}"
            )

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


class ProvisionerWorker:
    """Claims one approved provision job at a time, transforms intake to
    trip.config.json, deploys via the deploy adapter, and records the result.

    All DB operations are direct PostgreSQL — the worker does not call the
    TypeScript API. The claim/complete/fail logic mirrors job-queue.ts exactly:
    approval is consumed only at terminal events (success or exhausted failure).
    """

    LEASE_SECONDS = 600  # 10 minutes; deployment timeout is 5 minutes and no heartbeat exists yet
    DEFAULT_WORKER_ID_PREFIX = "provisioner"

    def __init__(
        self,
        db_url: str,
        deploy: DeployAdapter,
        worker_id: str | None = None,
        companion: CompanionProfileAdapter | None = None,
        mcp_bridge: McpBridgeAdapter | None = None,
    ) -> None:
        self._db_url = db_url
        self._deploy = deploy
        self._worker_id = worker_id or f"{self.DEFAULT_WORKER_ID_PREFIX}_{secrets.token_hex(8)}"
        self._companion = companion or NullCompanionProfileAdapter()
        self._mcp_bridge = mcp_bridge or NullMcpBridgeAdapter()

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

                # Transform to trip.config.json.
                config = transform_intake(answers)

                # The slug assigned at signup approval is a placeholder — the
                # destination and dates were not known yet. Now that the intake
                # is confirmed, promote it to the one the family will see.
                slug = self._promote_draft_slug(conn, trip_id, slug, answers)

                # Deploy.
                private_url = self._deploy.deploy(slug, config)

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

        return True

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

                # Enqueue organizer notification. recipient is the owner's real,
                # sendable Telegram chat id when one is on file (added in
                # migration 0017 — provider_subject_id, never the identity
                # digest) so the API's outbox dispatcher can actually deliver
                # this; NULL if no telegram identity is on file yet, which the
                # dispatcher treats as unsendable and marks 'skipped' rather
                # than retrying forever.
                cur.execute(
                    """
                    SELECT ui.provider_subject_id
                    FROM control_plane.trip_memberships tm
                    JOIN control_plane.user_identities ui
                      ON ui.user_id = tm.user_id AND ui.provider = 'telegram'
                    WHERE tm.trip_id = %s AND tm.role = 'owner' AND tm.status = 'active'
                    LIMIT 1
                    """,
                    (trip_id,),
                )
                owner_row = cur.fetchone()
                recipient_chat_id = owner_row["provider_subject_id"] if owner_row else None

                notif_payload = json.dumps({"private_url": private_url})
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

        # Companion-profile creation and its chat binding are best-effort
        # side effects performed after the transaction above durably commits
        # — the same "commit first, external side effect after" shape as
        # signup.ts's notification send. A failure here must never roll back
        # a successful provisioning run; it's logged and the trip is still
        # ready_private, just without an assigned companion yet.
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
                logger.info("provisioner.companion_profile_skipped", extra={
                    "trip_id": trip_id, "reason": "assistant_questions_unanswered",
                })
            else:
                hermes_profile = self._companion.install(handoff)
                if hermes_profile:
                    # Independently gated and independently non-fatal: a
                    # trip-mcp wiring failure must not block the chat
                    # binding below — the organizer should still land in
                    # the right companion profile-home even if that
                    # profile can't reach trip-mcp tools yet.
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
                if hermes_profile and recipient_chat_id:
                    with conn.transaction():
                        with conn.cursor() as cur:
                            cur.execute(
                                """
                                INSERT INTO control_plane.telegram_chat_bindings
                                  (chat_id, trip_id, hermes_profile)
                                VALUES (%s, %s, %s)
                                ON CONFLICT (chat_id) DO UPDATE
                                  SET trip_id = EXCLUDED.trip_id, hermes_profile = EXCLUDED.hermes_profile
                                """,
                                (recipient_chat_id, trip_id, hermes_profile),
                            )
                    logger.info("provisioner.companion_profile_bound", extra={
                        "trip_id": trip_id, "hermes_profile": hermes_profile,
                    })
        except Exception:
            logger.warning(
                "provisioner.companion_profile_failed",
                extra={"trip_id": trip_id},
                exc_info=True,
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

                    # Enqueue failure notification. Same real-chat-id lookup as
                    # _complete — see its comment for why 'organizer' (a role
                    # string, not an address) was never actually deliverable.
                    cur.execute(
                        """
                        SELECT ui.provider_subject_id
                        FROM control_plane.jobs j
                        JOIN control_plane.trip_memberships tm
                          ON tm.trip_id = j.trip_id AND tm.role = 'owner' AND tm.status = 'active'
                        JOIN control_plane.user_identities ui
                          ON ui.user_id = tm.user_id AND ui.provider = 'telegram'
                        WHERE j.id = %s
                        LIMIT 1
                        """,
                        (job_id,),
                    )
                    owner_row = cur.fetchone()
                    recipient_chat_id = owner_row["provider_subject_id"] if owner_row else None

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
