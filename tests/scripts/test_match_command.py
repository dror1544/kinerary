"""scripts/claude-hooks/match-command.py — what becomes a commit/deploy prompt.

Hard rules 1 and 2 are about intent, so the hook's job is to make sure every
commit and every live change is a question put to a person. A miss here is
silent: the command just runs. Hence a table of the commands that matter.
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "claude-hooks" / "match-command.py"


def classify(command: str) -> str:
    return subprocess.run([sys.executable, str(SCRIPT)], input=command, capture_output=True, text=True).stdout.strip()


class Classify(unittest.TestCase):
    def test_commits(self):
        self.assertEqual(classify("git commit -m 'x'"), "commit")
        self.assertEqual(classify("git -C some/dir commit -F -"), "commit")

    def test_prose_about_commits_is_not_a_commit(self):
        self.assertEqual(classify("cat > notes.md <<'EOF'\nnever git commit without approval\nEOF"), "none")

    def test_deploys(self):
        for command in (
            "~/kinerary-deploy/trips/japan-2026/deploy.sh",
            "docker compose -f control-plane/deployment/compose.local.yml up -d --build --wait",
            "scripts/preflight-deploy.sh --deploy",
            "scripts/preflight-deploy.sh",  # every preflight prompts: safe direction, one keystroke
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_a_teardown_that_executes_is_a_live_change(self):
        self.assertEqual(classify("scripts/teardown-trip.py --trip japan-2026 --execute"), "deploy")
        self.assertEqual(classify("cd x && python3 scripts/teardown-trip.py --trip trip_abc --execute"), "deploy")

    def test_a_teardown_dry_run_is_read_only(self):
        self.assertEqual(classify("scripts/teardown-trip.py --trip japan-2026"), "none")

    def test_ordinary_commands(self):
        self.assertEqual(classify("ls -la && git status"), "none")


if __name__ == "__main__":
    unittest.main()
