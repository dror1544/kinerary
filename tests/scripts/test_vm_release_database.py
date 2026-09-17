"""kinerary-cp-release against a real PostgreSQL — the backup and --restore-db path.

A throwaway postgres:16-alpine container (the image the VM runs), started for
this file and removed after it. What is pinned here:

- a backup's row counts describe the DUMP, not the live database a moment
  later: they are counted in a copy restored from the dump, so a write that
  lands between pg_dump and the count cannot make a valid dump fail later;
- every backup is proven restorable when it is taken;
- a dump that does not restore changes nothing: pg_restore's exit status is
  the verdict, the scratch database is removed, the live one is untouched;
- --restore-db replaces the live database only with a copy that restored
  cleanly and matched the dump, and keeps the replaced one under another name.

Skipped when docker is not available.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "control-plane" / "deployment" / "vm-release.py"
IMAGE = "postgres:16-alpine"
DOCKER = shutil.which("docker")


def docker_ready() -> bool:
    if not DOCKER:
        return False
    return subprocess.run([DOCKER, "image", "inspect", IMAGE], capture_output=True).returncode == 0


SCHEMA = """
CREATE SCHEMA control_plane;
CREATE TABLE public.control_plane_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.control_plane_schema_migrations(version) VALUES ('0001_foundation.sql'), ('0002_more.sql');
CREATE TABLE control_plane.trips (
  id text PRIMARY KEY CHECK (id ~ '^trip_[a-z0-9]{8,}$'),
  slug text NOT NULL UNIQUE,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('draft','ready_private')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control_plane.telegram_chat_bindings (
  id text PRIMARY KEY, trip_id text NOT NULL REFERENCES control_plane.trips(id), chat_id text NOT NULL
);
CREATE UNIQUE INDEX bindings_chat_idx ON control_plane.telegram_chat_bindings (chat_id);
CREATE FUNCTION control_plane.touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trips_touch BEFORE UPDATE ON control_plane.trips FOR EACH ROW EXECUTE FUNCTION control_plane.touch();
INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ('trip_aaaaaaaa', 'japan', 'ready_private'), ('trip_bbbbbbbb', 'usa', 'draft');
INSERT INTO control_plane.telegram_chat_bindings VALUES ('tcb_1', 'trip_aaaaaaaa', '1001');
"""


@unittest.skipUnless(docker_ready(), f"docker with {IMAGE} is not available")
class RestoreAgainstPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = f"cpr-dbtest-{uuid.uuid4().hex[:8]}"
        subprocess.run([DOCKER, "run", "-d", "--rm", "--name", cls.container,
                        "-e", "POSTGRES_USER=kinerary_control_plane", "-e", "POSTGRES_DB=kinerary_control_plane",
                        "-e", "POSTGRES_PASSWORD=test", IMAGE], check=True, capture_output=True)
        for _ in range(60):
            ready = subprocess.run([DOCKER, "exec", cls.container, "pg_isready", "-U", "kinerary_control_plane",
                                    "-d", "kinerary_control_plane"], capture_output=True)
            if ready.returncode == 0:
                # pg_isready answers during the image's init restart; a real query does not.
                probe = subprocess.run([DOCKER, "exec", cls.container, "psql", "-U", "kinerary_control_plane", "-d",
                                        "kinerary_control_plane", "-c", "SELECT 1"], capture_output=True)
                if probe.returncode == 0:
                    break
            time.sleep(1)
        cls.tmp = Path(tempfile.mkdtemp(prefix="cpr-db-"))
        (cls.tmp / "deploy").mkdir()
        (cls.tmp / "deploy" / "vm.env").write_text("KINERARY_REV=aaaaaaa\n")
        (cls.tmp / "hermes" / "profiles" / "trip-intake").mkdir(parents=True)
        env = {
            "KINERARY_CP_PG_CONTAINER": cls.container,
            "KINERARY_CP_DEPLOY_ROOT": str(cls.tmp / "deploy"),
            "KINERARY_CP_BACKUP_DIR": str(cls.tmp / "backups"),
            "KINERARY_CP_STATE_DIR": str(cls.tmp / "state"),
            "KINERARY_CP_LOG_DIR": str(cls.tmp / "log"),
            "KINERARY_CP_HERMES_DATA": str(cls.tmp / "hermes"),
        }
        cls.saved_env = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        spec = importlib.util.spec_from_file_location("vm_release_database_under_test", TOOL)
        cls.vr = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.vr)

    @classmethod
    def tearDownClass(cls):
        subprocess.run([DOCKER, "rm", "-f", cls.container], capture_output=True)
        for key, value in cls.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.sql("postgres", "DROP DATABASE IF EXISTS kinerary_control_plane WITH (FORCE)")
        for name in self.databases():
            if name.startswith("kinerary_control_plane_"):
                self.sql("postgres", f'DROP DATABASE "{name}" WITH (FORCE)')
        self.sql("postgres", "CREATE DATABASE kinerary_control_plane")
        self.sql("kinerary_control_plane", SCHEMA)
        self.cp = self.vr.ControlPlane(self.vr.Report(io.StringIO(), color=False))

    def sql(self, db: str, text: str) -> str:
        proc = subprocess.run([DOCKER, "exec", "-i", self.container, "psql", "-U", "kinerary_control_plane", "-d", db,
                               "-At", "-v", "ON_ERROR_STOP=1"], input=text.encode(), capture_output=True)
        if proc.returncode != 0:
            raise AssertionError(proc.stderr.decode())
        return proc.stdout.decode().strip()

    def databases(self) -> list[str]:
        return self.sql("postgres", "SELECT datname FROM pg_database ORDER BY 1").splitlines()

    def test_backup_counts_describe_the_dump_even_when_writes_land_after_it(self):
        test = self

        class WriteDuringBackup(self.vr.ControlPlane):
            def dump_database(self, path):
                super().dump_database(path)
                # The race the old code lost: a write after pg_dump, before counting.
                test.sql("kinerary_control_plane",
                         "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ('trip_cccccccc', 'late', 'draft')")

        cp = WriteDuringBackup(self.vr.Report(io.StringIO(), color=False))
        backup = cp.take_backup("aaaaaaa-to-bbbbbbb", include_hermes=False)
        counts = json.loads((backup / "db.counts.json").read_text())
        self.assertEqual(counts["control_plane.trips"], 2, "the dump holds 2 trips; the live database has 3")
        self.assertEqual(counts["public.control_plane_schema_migrations"], 2)
        self.assertFalse([d for d in self.databases() if "_verify_" in d], "the proof-of-restore copy is removed")

        # And the dump restores to exactly those counts, so a rollback accepts it.
        scratch = self.cp.prepare_restored_database(backup, "20260917t000000z")
        self.assertEqual(self.cp.table_counts(db=scratch)["control_plane.trips"], 2)
        self.cp.drop_database(scratch)

    def test_a_dump_that_does_not_restore_changes_nothing(self):
        backup = self.cp.take_backup("aaaaaaa-to-bbbbbbb", include_hermes=False)
        dump = backup / "db.dump"
        dump.write_bytes(dump.read_bytes()[: len(dump.read_bytes()) // 2])  # truncated mid-archive
        before = self.sql("kinerary_control_plane", "SELECT count(*) FROM control_plane.trips")
        with self.assertRaises(self.vr.Refused) as refused:
            self.cp.prepare_restored_database(backup, "20260917t000100z")
        self.assertIn("pg_restore", str(refused.exception))
        self.assertEqual(self.sql("kinerary_control_plane", "SELECT count(*) FROM control_plane.trips"), before)
        self.assertEqual([d for d in self.databases() if d.startswith("kinerary_control_plane_")], [],
                         "no half-restored scratch database is left behind")

    def test_a_restore_that_times_out_leaves_nothing_behind(self):
        backup = self.cp.take_backup("aaaaaaa-to-bbbbbbb", include_hermes=False)
        real_run = subprocess.run

        def run(argv, *args, **kwargs):
            if "pg_restore" in argv:
                raise subprocess.TimeoutExpired(argv, kwargs.get("timeout"))
            return real_run(argv, *args, **kwargs)

        with mock.patch.object(self.vr.subprocess, "run", run):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.cp.prepare_restored_database(backup, "20260917t000150z")
        self.assertEqual([d for d in self.databases() if d.startswith("kinerary_control_plane_")], [],
                         "the database created for the restore is dropped when pg_restore never finishes")

    def test_a_restore_whose_counts_differ_from_the_dump_is_refused(self):
        backup = self.cp.take_backup("aaaaaaa-to-bbbbbbb", include_hermes=False)
        counts = json.loads((backup / "db.counts.json").read_text())
        counts["control_plane.trips"] = 99
        (backup / "db.counts.json").write_text(json.dumps(counts))
        with self.assertRaises(self.vr.Refused):
            self.cp.prepare_restored_database(backup, "20260917t000200z")
        self.assertEqual([d for d in self.databases() if d.startswith("kinerary_control_plane_")], [])

    def test_a_backup_that_cannot_be_restored_is_refused_when_it_is_taken(self):
        class BrokenDump(self.vr.ControlPlane):
            def dump_database(self, path):
                path.write_bytes(b"PGDMP not really an archive")

        cp = BrokenDump(self.vr.Report(io.StringIO(), color=False))
        with self.assertRaises(self.vr.Refused):
            cp.take_backup("aaaaaaa-to-bbbbbbb", include_hermes=False)
        leftovers = [p for p in (self.tmp / "backups").glob("*") if p.is_dir() and not (p / "db.counts.json").exists()]
        self.assertEqual(leftovers, [], "a failed backup leaves no directory that looks like a backup")

    def test_the_swap_replaces_the_live_database_and_keeps_the_old_one(self):
        backup = self.cp.take_backup("aaaaaaa-to-bbbbbbb", include_hermes=False)
        self.sql("kinerary_control_plane",
                 "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ('trip_dddddddd', 'newer', 'draft')")
        scratch = self.cp.prepare_restored_database(backup, "20260917t000300z")
        aside = self.cp.swap_in_database(scratch, "20260917t000300z")
        self.assertEqual(self.sql("kinerary_control_plane", "SELECT count(*) FROM control_plane.trips"), "2")
        self.assertEqual(self.sql(aside, "SELECT count(*) FROM control_plane.trips"), "3",
                         "the replaced database is kept, with the writes the restore discarded")
        # Constraints, indexes and triggers came across, not just rows.
        self.assertEqual(self.sql("kinerary_control_plane",
                                  "SELECT count(*) FROM pg_trigger WHERE tgname = 'trips_touch'"), "1")
        with self.assertRaises(AssertionError):
            self.sql("kinerary_control_plane", "INSERT INTO control_plane.telegram_chat_bindings VALUES ('tcb_2', 'trip_bbbbbbbb', '1001')")


if __name__ == "__main__":
    unittest.main()
