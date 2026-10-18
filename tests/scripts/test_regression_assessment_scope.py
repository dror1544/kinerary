"""scripts/regression-assessment-scope.sh — the regression-assessment
pre-filter.

.github/workflows/regression-assessment.yml pipes `gh pr diff --name-only`
into this script before it spends an Opus run. Exit 0 means "every changed
path is documentation, tests or stylesheets — skip the assessment". Exit 1
means "assess", including on empty input: a missed assessment is silent, a
redundant one is merely noise, so the script fails toward assessing.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "regression-assessment-scope.sh"


def run(paths_text: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(SCRIPT)],
        input=paths_text,
        capture_output=True,
        text=True,
    )


class RegressionAssessmentScope(unittest.TestCase):
    def test_docs_only_is_skippable(self):
        result = run("docs/a.md\nREADME.md\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")

    def test_docs_plus_server_code_is_assessed(self):
        result = run("docs/a.md\nserver/server.js\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("assess: server/server.js", result.stderr)

    def test_tests_only_is_skippable(self):
        result = run(
            "tests/x.test.js\n"
            "control-plane/api/test/y.test.ts\n"
            "tests/scripts/test_z.py\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_never_safe_wins_over_test_directory_pattern(self):
        result = run(".agents/skills/x/tests/f\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("assess: .agents/skills/x/tests/f", result.stderr)

    def test_claude_dir_is_never_safe(self):
        result = run(".claude/agents/developer.md\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("assess: .claude/agents/developer.md", result.stderr)

    def test_stylesheet_is_skippable(self):
        result = run("site/style.css\n")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_html_is_not_a_stylesheet(self):
        result = run("site/index.html\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("assess: site/index.html", result.stderr)

    def test_site_modern_css_is_never_safe(self):
        # The tracked SPA build is never skippable, even though the file
        # extension alone would otherwise read as a stylesheet.
        result = run("site/modern/app.css\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("assess: site/modern/app.css", result.stderr)

    def test_migration_is_never_safe(self):
        result = run("control-plane/db/migrations/20260929000000_x.sql\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "assess: control-plane/db/migrations/20260929000000_x.sql", result.stderr
        )

    def test_claude_md_is_never_safe(self):
        result = run("CLAUDE.md\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("assess: CLAUDE.md", result.stderr)

    def test_empty_input_is_assessed(self):
        result = run("")
        self.assertEqual(result.returncode, 1)

    def test_trailing_newline_does_not_change_the_result(self):
        with_newline = run("docs/a.md\n")
        without_newline = run("docs/a.md")
        self.assertEqual(with_newline.returncode, without_newline.returncode)
        self.assertEqual(with_newline.returncode, 0)


if __name__ == "__main__":
    unittest.main()
