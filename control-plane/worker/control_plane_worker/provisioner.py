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

from .transformer import transform_intake

logger = logging.getLogger(__name__)


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
    ) -> None:
        self._deploy_root = deploy_root
        self._vmid_map = vmid_map
        self._repo_root = repo_root or os.environ.get("REPO_ROOT", "")
        self._timeout = timeout

    def deploy(self, slug: str, config: dict[str, Any]) -> str:
        vmid = self._vmid_map.get(slug)
        if not vmid:
            raise ValueError(f"no vmid configured for slug {slug!r}")

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

    LEASE_SECONDS = 300  # 5 minutes; heartbeat not yet implemented (Sprint 5)
    DEFAULT_WORKER_ID_PREFIX = "provisioner"

    def __init__(
        self,
        db_url: str,
        deploy: DeployAdapter,
        worker_id: str | None = None,
    ) -> None:
        self._db_url = db_url
        self._deploy = deploy
        self._worker_id = worker_id or f"{self.DEFAULT_WORKER_ID_PREFIX}_{secrets.token_hex(8)}"

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

                # Deploy.
                private_url = self._deploy.deploy(slug, config)

                # Commit success.
                self._complete(conn, job_id, plan_id, trip_id, private_url)

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

    def _complete(
        self,
        conn: psycopg.Connection,
        job_id: str,
        plan_id: str,
        trip_id: str,
        private_url: str,
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

                # Transition trip to ready_private.
                cur.execute(
                    """
                    UPDATE control_plane.trips
                    SET    lifecycle_state = 'ready_private', updated_at = now()
                    WHERE  id = %s
                    """,
                    (trip_id,),
                )

                # Enqueue organizer notification.
                notif_payload = json.dumps({"private_url": private_url})
                cur.execute(
                    """
                    INSERT INTO control_plane.notification_outbox
                      (id, trip_id, kind, recipient, payload)
                    VALUES (%s, %s, 'provisioning_complete', 'organizer', %s::jsonb)
                    """,
                    (_generate_notif_id(), trip_id, notif_payload),
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

                    # Enqueue failure notification.
                    notif_payload = json.dumps({"safe_error_code": error_code})
                    cur.execute(
                        """
                        INSERT INTO control_plane.notification_outbox
                          (id, trip_id, kind, recipient, payload)
                        VALUES (%s,
                                (SELECT trip_id FROM control_plane.jobs WHERE id = %s),
                                'provisioning_failed', 'organizer', %s::jsonb)
                        """,
                        (_generate_notif_id(), job_id, notif_payload),
                    )
