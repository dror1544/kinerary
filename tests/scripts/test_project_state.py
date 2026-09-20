"""scripts/project-state.py — the sprint and baseline locks, as a file a fresh session can read.

Both locks lived in a memory file and in Dror's head until 2026-09-20. The
script is the only way the file changes, so every change carries who, when and
why; moving the baseline while it is locked, or the sprint while it is locked,
needs --override and is recorded as such.

Runs in a throwaway repository, so the real tree's state cannot decide the result.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/project-state.py"
GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"]


class Repo:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        shutil.copy2(SCRIPT, self.root / "scripts/project-state.py")
        (self.root / "docs/test-reports").mkdir(parents=True)
        (self.root / "docs/test-reports/baseline.md").write_text("# baseline\n")
        self.git("init", "-q", "-b", "main")
        self.git("add", "-A")
        self.git(*GIT_ID, "commit", "-qm", "first")
        self.git("checkout", "-qb", "integration/sprint-9")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, name: str) -> str:
        (self.root / name).write_text(name)
        self.git("add", name)
        self.git(*GIT_ID, "commit", "-qm", name)
        return self.git("rev-parse", "HEAD")

    def run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "scripts/project-state.py", *args], cwd=self.root,
                              env=self.env, capture_output=True, text=True)

    def state(self) -> dict:
        return json.loads((self.root / ".project/sprint.json").read_text())

    def init(self, **kw) -> subprocess.CompletedProcess:
        args = ["init", "--sprint-id", "9", "--integration-branch", "integration/sprint-9",
                "--scope", "plan=docs/plan.md", "--report", "docs/test-reports/baseline.md",
                "--by", "tester", "--reason", "test"]
        for k, v in kw.items():
            args += [f"--{k.replace('_', '-')}", v]
        return self.run(*args)


class Init(unittest.TestCase):
    def test_init_records_the_branch_head_as_the_baseline_and_passes_check(self):
        r = Repo()
        self.assertEqual(r.init().returncode, 0)
        s = r.state()
        self.assertEqual(s["baseline"]["commit"], r.git("rev-parse", "integration/sprint-9"))
        self.assertEqual(s["locks"]["sprint"]["state"], "open")
        self.assertEqual(s["locks"]["baseline"]["state"], "open")
        self.assertEqual(s["history"][0]["by"], "tester")
        check = r.run("check")
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        self.assertIn("Sprint 9 on integration/sprint-9", r.run("show", "--line").stdout)

    def test_init_refuses_to_overwrite(self):
        r = Repo()
        r.init()
        self.assertEqual(r.init().returncode, 2)


class Check(unittest.TestCase):
    def test_a_baseline_commit_not_in_the_repository_is_a_problem(self):
        r = Repo()
        r.init()
        s = r.state()
        s["baseline"]["commit"] = "0" * 40
        (r.root / ".project/sprint.json").write_text(json.dumps(s))
        c = r.run("check")
        self.assertEqual(c.returncode, 1)
        self.assertIn("not a commit in this repository", c.stdout)

    def test_a_baseline_commit_off_the_integration_branch_is_a_problem(self):
        r = Repo()
        r.init()
        r.git("checkout", "-qb", "elsewhere")
        stray = r.commit("stray")
        r.git("checkout", "-q", "integration/sprint-9")
        s = r.state()
        s["baseline"]["commit"] = stray
        (r.root / ".project/sprint.json").write_text(json.dumps(s))
        c = r.run("check")
        self.assertEqual(c.returncode, 1)
        self.assertIn("is not on integration/sprint-9", c.stdout)

    def test_a_lock_without_who_when_why_is_a_problem(self):
        r = Repo()
        r.init()
        s = r.state()
        s["locks"]["sprint"]["reason"] = ""
        (r.root / ".project/sprint.json").write_text(json.dumps(s))
        c = r.run("check")
        self.assertEqual(c.returncode, 1)
        self.assertIn("locks.sprint.reason is missing", c.stdout)


class Locks(unittest.TestCase):
    def test_locking_the_baseline_pins_the_branch_head_and_records_who(self):
        r = Repo()
        r.init()
        head = r.commit("fix")
        out = r.run("lock", "baseline", "--by", "Dror", "--reason", "fixes landed")
        self.assertEqual(out.returncode, 0, out.stderr)
        s = r.state()
        self.assertEqual(s["locks"]["baseline"]["state"], "locked")
        self.assertEqual(s["locks"]["baseline"]["by"], "Dror")
        self.assertEqual(s["baseline"]["commit"], head)
        self.assertEqual(s["history"][-1]["change"], f"lock baseline at {head[:7]}")
        self.assertIn("baseline LOCKED", r.run("show", "--line").stdout)

    def test_locking_twice_is_refused(self):
        r = Repo()
        r.init()
        r.run("lock", "sprint", "--by", "Dror", "--reason", "not ready")
        again = r.run("lock", "sprint", "--by", "Dror", "--reason", "still not ready")
        self.assertEqual(again.returncode, 2)
        self.assertIn("already locked", again.stderr)

    def test_the_baseline_does_not_move_while_locked_without_an_override(self):
        r = Repo()
        r.init()
        r.run("lock", "baseline", "--by", "Dror", "--reason", "settled")
        pinned = r.state()["baseline"]["commit"]
        later = r.commit("later")
        refused = r.run("set-baseline", "--commit", later, "--by", "agent", "--reason", "moved it")
        self.assertEqual(refused.returncode, 2)
        self.assertIn("--override", refused.stderr)
        self.assertEqual(r.state()["baseline"]["commit"], pinned)
        forced = r.run("set-baseline", "--commit", later, "--by", "Dror", "--reason", "re-baselined", "--override")
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertEqual(r.state()["baseline"]["commit"], later)
        self.assertTrue(r.state()["history"][-1]["override"])

    def test_the_sprint_does_not_change_while_locked_without_an_override(self):
        r = Repo()
        r.init()
        r.run("lock", "sprint", "--by", "Dror", "--reason", "not ready")
        refused = r.run("set-sprint", "--id", "10", "--integration-branch", "integration/sprint-10",
                        "--by", "agent", "--reason", "next")
        self.assertEqual(refused.returncode, 2)
        self.assertEqual(r.state()["sprint"]["id"], "9")


class DescribeChange(unittest.TestCase):
    def test_names_lock_baseline_and_override_changes(self):
        r = Repo()
        r.init()
        old = (r.root / "old.json")
        old.write_text((r.root / ".project/sprint.json").read_text())
        r.run("lock", "baseline", "--by", "Dror", "--reason", "settled")
        later = r.commit("later")
        r.run("set-baseline", "--commit", later, "--by", "Dror", "--reason", "re-baselined", "--override")
        out = r.run("describe-change", str(old), ".project/sprint.json").stdout
        self.assertIn("baseline lock: open -> locked (by Dror: settled)", out)
        self.assertIn(f"baseline commit: {old.read_text() and json.loads(old.read_text())['baseline']['commit'][:7]} -> {later[:7]}", out)
        self.assertIn("OVERRIDE used: set-baseline", out)

    def test_an_absent_old_file_is_a_creation_not_a_crash(self):
        r = Repo()
        r.init()
        out = r.run("describe-change", "nope.json", ".project/sprint.json")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("sprint lock: none -> open", out.stdout)


if __name__ == "__main__":
    unittest.main()
