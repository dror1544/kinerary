"""scripts/e2e-full-cycle.py leaves nothing behind on a run that passed.

Every automated run used to add a loose /tmp/kinerary-e2e-fake-telegram-<port>.log
and regenerate /tmp/kinerary-e2e-<scenario>/ — five stand-in logs had piled up
by the evening of 2026-09-11, none of them from a run anyone needed to read.
"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "e2e-full-cycle.py"


def load():
    spec = importlib.util.spec_from_file_location("e2e_full_cycle", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkDirTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load()
        self.work = Path(tempfile.mkdtemp(prefix="e2e-test-"))
        (self.work / "japan").mkdir()
        (self.work / "fake-telegram.log").write_text("getUpdates\n")

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.work, ignore_errors=True)

    def test_a_passing_run_removes_its_documents_and_logs(self) -> None:
        self.mod.finish_workdir(self.work, passed=True)
        self.assertFalse(self.work.exists())

    def test_a_failing_run_keeps_them_for_whoever_reads_the_failure(self) -> None:
        self.mod.finish_workdir(self.work, passed=False)
        self.assertTrue((self.work / "fake-telegram.log").exists())

    def test_the_stand_ins_log_lives_in_the_runs_own_directory(self) -> None:
        self.assertEqual(self.mod.Auto(self.work).log.parent, self.work)


if __name__ == "__main__":
    unittest.main()
