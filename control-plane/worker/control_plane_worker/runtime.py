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


def database_status(database_url: str) -> dict[str, Any]:
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*)::int FROM public.control_plane_schema_migrations")
            migration_count = cursor.fetchone()[0]
            cursor.execute("SELECT count(*)::int FROM control_plane.jobs WHERE state = 'queued'")
            queued_jobs = cursor.fetchone()[0]
    return {"database": "ready", "schema_migrations": migration_count, "queued_jobs": queued_jobs}


def run(database_url_file: str, poll_seconds: float) -> int:
    database_url = read_secret_file(database_url_file)
    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopping:
        try:
            print(json.dumps({"event": "worker.queue_observed", **database_status(database_url)}), flush=True)
        except psycopg.Error:
            print(json.dumps({"event": "worker.database_unavailable", "safe_error_code": "DATABASE_UNAVAILABLE"}), flush=True)
        end = time.monotonic() + poll_seconds
        while not stopping and time.monotonic() < end:
            time.sleep(min(0.25, max(0, end - time.monotonic())))
    return 0
