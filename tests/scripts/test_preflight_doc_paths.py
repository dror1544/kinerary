"""scripts/preflight-checks.sh — the "references a path that no longer exists" warning.

A doc naming a path that was deleted or moved is worth a warning on every
commit. A doc naming a build output or runtime directory is not: those are
gitignored, so a fresh checkout or worktree never has them, and the warning
fired there on every commit for `control-plane/api/dist` (the API's build) and
`server/data` (the site's SQLite and uploads) while both docs were right. A
warning that is always wrong teaches people to skip the warnings.

Runs the script from a throwaway repo, so the real tree's state cannot decide
the result.
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


class DocPathWarning(unittest.TestCase):
    def run_checks(self, doc: str, gitignore: str, tracked: dict[str, str]) -> str:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as hermes_home:
            root = Path(tmp)
            (root / "scripts").mkdir()
            shutil.copy2(SCRIPT, root / "scripts/preflight-checks.sh")
            (root / "CLAUDE.md").write_text(doc)
            (root / ".gitignore").write_text(gitignore)
            for path, text in tracked.items():
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                (root / path).write_text(text)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "add", "-A"], cwd=root, check=True)
            env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
            env["HERMES_HOME"] = hermes_home
            return subprocess.run(["bash", str(root / "scripts/preflight-checks.sh"), "--all"], cwd=root, env=env,
                                  capture_output=True, text=True, timeout=120).stdout

    def test_a_gitignored_build_or_runtime_path_is_not_stale(self):
        out = self.run_checks(
            doc="The mount is `control-plane/api/dist`; uploads land in `server/data/uploads/`; "
                "the database in `server/data`.\n",
            gitignore="server/data/\n",
            tracked={"control-plane/api/.gitignore": "dist/\n", "control-plane/api/package.json": "{}\n"},
        )
        self.assertNotIn("control-plane/api/dist", out)
        self.assertNotIn("server/data", out)

    def test_a_deleted_path_is_still_reported(self):
        out = self.run_checks(
            doc="Run `scripts/gone.sh`, then `scripts/preflight-checks.sh`.\n",
            gitignore="server/data/\n",
            tracked={},
        )
        self.assertIn("CLAUDE.md references a path that no longer exists: scripts/gone.sh", out)
        self.assertNotIn("scripts/preflight-checks.sh", out.replace("scripts/gone.sh", ""))


if __name__ == "__main__":
    unittest.main()
