"""Private PostgreSQL queue observer used by the Sprint 0 worker runtime."""
from __future__ import annotations

import json
from pathlib import Path
import signal
import time
from typing import Any

import psycopg


def read_secret_file(path: str) -> str:
    value = Path(path).read_text(encoding="utf-8").strip()
    if not value:
        raise ValueError("database URL secret file is empty")
    return value


def queue_status(connection: psycopg.Connection) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*)::int FROM public.control_plane_schema_migrations")
        migration_count = cursor.fetchone()[0]
        cursor.execute("SELECT count(*)::int FROM control_plane.jobs WHERE state = 'queued'")
        queued_jobs = cursor.fetchone()[0]
    return {"database": "ready", "schema_migrations": migration_count, "queued_jobs": queued_jobs}


def database_status(database_url: str) -> dict[str, Any]:
    """One-shot check used by the container healthcheck."""
    with psycopg.connect(database_url) as connection:
        return queue_status(connection)


def run(database_url_file: str, poll_seconds: float) -> int:
    database_url = read_secret_file(database_url_file)
    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # The observer holds one connection across polls instead of reconnecting
    # every tick, and drops it only when the database goes away. autocommit
    # keeps each read its own transaction, so the idle connection never sits
    # idle-in-transaction between polls.
    connection: psycopg.Connection | None = None
    try:
        while not stopping:
            try:
                if connection is None or connection.closed:
                    connection = psycopg.connect(database_url, autocommit=True)
                print(json.dumps({"event": "worker.queue_observed", **queue_status(connection)}), flush=True)
            except psycopg.Error:
                if connection is not None:
                    connection.close()
                    connection = None
                print(json.dumps({"event": "worker.database_unavailable", "safe_error_code": "DATABASE_UNAVAILABLE"}), flush=True)
            end = time.monotonic() + poll_seconds
            while not stopping and time.monotonic() < end:
                time.sleep(min(0.25, max(0, end - time.monotonic())))
    finally:
        if connection is not None:
            connection.close()
    return 0
