"""scripts/preflight-checks.sh — it must find the repo when a git hook runs it.

git exports GIT_DIR to hooks. With GIT_DIR set, `git -C scripts rev-parse
--show-toplevel` answers `scripts/` rather than the checkout, so under
`git commit` the script ran from the wrong directory: every Hermes profile
skill looked uncaptured (a warning naming all of them, on every commit), and
the drift check compared nothing, so a drift that should block a commit could
not. Run by hand, the same check was correct — which is how it went unnoticed.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/preflight-checks.sh"


def a_repo_skill() -> Path:
    for d in sorted((REPO / ".agents/skills").iterdir()):
        if d.is_dir() and not d.is_symlink() and (d / "SKILL.md").exists():
            return d
    raise unittest.SkipTest("no repo skill to install into a fake profile")


class UnderAGitHook(unittest.TestCase):
    def test_a_captured_skill_is_not_reported_as_profile_only(self):
        skill = a_repo_skill()
        git_dir = subprocess.run(["git", "rev-parse", "--absolute-git-dir"], cwd=REPO,
                                 capture_output=True, text=True, check=True).stdout.strip()
        with tempfile.TemporaryDirectory() as home:
            dest = Path(home) / "profiles/someprofile/skills/travel" / skill.name
            shutil.copytree(skill, dest)
            env = {**os.environ, "HERMES_HOME": home, "GIT_DIR": git_dir}
            out = subprocess.run([str(SCRIPT), "--all"], cwd=REPO, env=env,
                                 capture_output=True, text=True).stdout
        self.assertNotIn(f"someprofile/{skill.name}", out,
                         "a skill that exists in .agents/skills was reported as profile-only "
                         "— the script is not running from the repo root under GIT_DIR")


if __name__ == "__main__":
    unittest.main()
