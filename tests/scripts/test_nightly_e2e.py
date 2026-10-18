"""scripts/nightly-e2e.sh — it deploys staging unattended, so what matters most is
when it refuses and when it skips. A stub `docker` stands in for the staging
database; no test here reaches git, a stack or a network."""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "nightly-e2e.sh"


class Nightly(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.checkout = root / "checkout"
        self.checkout.mkdir()
        (self.checkout / ".nightly-e2e-checkout").write_text("")
        self.reports = root / "reports"
        self.bin = root / "bin"
        self.bin.mkdir()
        self.docker("0", "0")
        self.env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                    "NIGHTLY_CHECKOUT": str(self.checkout), "NIGHTLY_REPORTS": str(self.reports)}

    def docker(self, live, busy, fail=False):
        """Answers the live-session count and the job count; fail=True is a database that is down."""
        stub = self.bin / "docker"
        stub.write_text("#!/bin/sh\nexit 1\n" if fail else f"""#!/bin/sh
case "$*" in *intake_sessions*) echo {live} ;; *jobs*) echo {busy} ;; esac
""")
        stub.chmod(0o755)

    def run_it(self, **env):
        e = {**self.env, **env}
        for k, v in list(e.items()):
            if v is None:
                del e[k]
        return subprocess.run(["bash", str(SCRIPT)], env=e, capture_output=True, text=True, timeout=60)

    def report(self):
        return next(self.reports.glob("nightly-e2e-*.md")).read_text()

    def test_refuses_without_its_settings(self):
        for missing in ("NIGHTLY_CHECKOUT", "NIGHTLY_REPORTS"):
            r = self.run_it(**{missing: None})
            self.assertNotEqual(r.returncode, 0, missing)
            self.assertIn("kinerary-deploy", r.stderr)

    def test_refuses_a_checkout_without_the_marker(self):
        (self.checkout / ".nightly-e2e-checkout").unlink()
        r = self.run_it()
        self.assertEqual(r.returncode, 2)
        self.assertIn("reset --hard", r.stderr)

    def test_refuses_the_japan_fixture(self):
        r = self.run_it(NIGHTLY_SCENARIO="japan")
        self.assertEqual(r.returncode, 2)
        self.assertIn("live trip", r.stderr)

    def test_skips_while_someone_is_interviewing_on_staging(self):
        self.docker("1", "0")
        r = self.run_it()
        self.assertEqual(r.returncode, 0)
        self.assertIn("SKIPPED — someone was mid-interview", self.report())

    def test_skips_while_a_provisioning_job_runs(self):
        self.docker("0", "2")
        self.assertEqual(self.run_it().returncode, 0)
        self.assertIn("SKIPPED — a provisioning job", self.report())

    def test_skips_when_the_deployment_guard_says_no(self):
        r = self.run_it(KINERARY_NIGHTLY_GUARD="echo 'the VM is provisioning'; exit 1")
        self.assertEqual(r.returncode, 0)
        self.assertIn("SKIPPED — deployment guard: the VM is provisioning", self.report())

    def test_a_guard_that_cannot_answer_skips_rather_than_proceeds(self):
        """Fail closed: a query that failed is not "nobody is interviewing"."""
        self.docker("0", "0", fail=True)
        r = self.run_it()
        self.assertEqual(r.returncode, 0)
        self.assertIn("SKIPPED — could not read staging", self.report())

    def hold_lock(self, pid):
        self.reports.mkdir(parents=True, exist_ok=True)
        (self.reports / ".lock").write_text(f"{pid}\n")

    def test_skips_while_a_live_run_holds_the_lock(self):
        holder = subprocess.Popen(["sleep", "30"])
        self.addCleanup(holder.kill)
        self.hold_lock(holder.pid)
        self.assertEqual(self.run_it().returncode, 0)
        self.assertIn("SKIPPED — another nightly run", self.report())
        self.assertEqual((self.reports / ".lock").read_text().strip(), str(holder.pid),
                         "a skipped run must not release someone else's lock")

    def test_a_lock_left_by_a_dead_run_is_taken_over(self):
        """A kill -9 or a power cut must not skip every night after it."""
        dead = subprocess.Popen(["true"]); dead.wait()
        self.hold_lock(dead.pid)
        self.docker("1", "0")  # so the run stops right after taking the lock
        self.run_it()
        report = self.report()
        self.assertNotIn("another nightly run", report)
        self.assertIn("stale lock", report)
        self.assertFalse((self.reports / ".lock").exists(), "the run releases the lock it took")


if __name__ == "__main__":
    unittest.main()
