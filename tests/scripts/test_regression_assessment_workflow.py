""".github/workflows/regression-assessment.yml — the "is this configured"
credentials gate.

Until #323 the `Check credentials` step found neither
`CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY`, wrote `configured=false`
and a `::warning`, and every later step's `if: steps.auth.outputs.configured
== 'true'` guard then skipped quietly. A skipped step is a green job, so
"Assess deployment risk" showed pass in 3-6s while no assessment ran, and
nobody opens a green check — verified silent since ~2026-09-25 on run
36689902888.

This file reads the workflow FILE AS TEXT (no PyYAML — the Mac's python3 may
not have it, see CLAUDE.md's "Testing" section) and asserts the new contract:
the credentials step itself fails loud on the unconfigured branch, and no
later step still depends on a `configured` output that no longer exists.
"""
from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[2]
    / ".github"
    / "workflows"
    / "regression-assessment.yml"
)

ERROR_TITLE = "Regression assessment not configured"


def _workflow_text() -> str:
    return WORKFLOW.read_text()


def _extract_step_script(text: str, step_name: str) -> str:
    """Pull the shell body of `- name: <step_name>`'s `run: |` block out of
    the workflow YAML, by text, dedented to real shell. Good enough for one
    step's script; not a YAML parser."""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(rf"^\s*- name:\s*{re.escape(step_name)}\s*$", line):
            start = i
            break
    assert start is not None, f"step {step_name!r} not found in {WORKFLOW}"

    run_at = None
    for i in range(start, len(lines)):
        m = re.match(r"^(\s*)run:\s*\|\s*$", lines[i])
        if m:
            run_at = i
            run_indent = len(m.group(1))
            break
        # Stop if we hit the next step first (this step has no `run:`).
        if i > start and re.match(r"^\s*- name:", lines[i]):
            break
    assert run_at is not None, f"no `run: |` block under step {step_name!r}"

    body_lines = []
    for line in lines[run_at + 1 :]:
        if line.strip() == "":
            body_lines.append("")
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent <= run_indent:
            break
        body_lines.append(line)

    # Dedent to the minimum indentation among non-blank body lines.
    indents = [len(l) - len(l.lstrip(" ")) for l in body_lines if l.strip()]
    base = min(indents) if indents else 0
    return "\n".join(l[base:] if l.strip() else l for l in body_lines)


def _run_credentials_script(script: str, env: dict) -> subprocess.CompletedProcess:
    full_env = {"PATH": "/usr/bin:/bin"}
    full_env.update(env)
    return subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        env=full_env,
    )


class CheckCredentialsStep(unittest.TestCase):
    def setUp(self):
        self.text = _workflow_text()
        self.script = _extract_step_script(self.text, "Check credentials")

    def test_exits_nonzero_when_unconfigured(self):
        # GITHUB_OUTPUT still has to exist for `>> "$GITHUB_OUTPUT"` writes
        # that happen before any failure — point it at a scratch file so the
        # script's own behaviour, not a missing env var, is what's measured.
        import tempfile

        with tempfile.NamedTemporaryFile() as f:
            result = _run_credentials_script(
                self.script, {"GITHUB_OUTPUT": f.name}
            )
        self.assertNotEqual(
            result.returncode,
            0,
            f"unconfigured run must fail; stdout={result.stdout!r} "
            f"stderr={result.stderr!r}",
        )

    def test_emits_error_not_warning_with_the_expected_title(self):
        import tempfile

        with tempfile.NamedTemporaryFile() as f:
            result = _run_credentials_script(
                self.script, {"GITHUB_OUTPUT": f.name}
            )
        combined = result.stdout + result.stderr
        self.assertIn(f"::error title={ERROR_TITLE}", combined)
        self.assertNotIn(f"::warning title={ERROR_TITLE}", combined)

    def test_succeeds_when_oauth_token_present(self):
        import tempfile

        with tempfile.NamedTemporaryFile() as f:
            result = _run_credentials_script(
                self.script,
                {"GITHUB_OUTPUT": f.name, "OAUTH": "fake-token", "APIKEY": ""},
            )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_succeeds_when_api_key_present(self):
        import tempfile

        with tempfile.NamedTemporaryFile() as f:
            result = _run_credentials_script(
                self.script,
                {"GITHUB_OUTPUT": f.name, "OAUTH": "", "APIKEY": "fake-key"},
            )
        self.assertEqual(result.returncode, 0, result.stderr)


class NoDeadConfiguredGuards(unittest.TestCase):
    def test_no_step_still_guards_on_steps_auth_outputs_configured(self):
        text = _workflow_text()
        self.assertNotIn(
            "steps.auth.outputs.configured",
            text,
            "a step is still gated on `configured`, which the credentials "
            "step's exit code now makes dead: the step never runs long "
            "enough to set that output on the branch that used to guard "
            "against, so the guard can never usefully be false again.",
        )

    def test_relevant_guards_from_320_are_untouched(self):
        # #320's pre-filter guard is a separate concern this task must not
        # touch — confirm it is still there, on the Assess and Post steps.
        text = _workflow_text()
        self.assertIn("steps.ctx.outputs.relevant == 'true'", text)


if __name__ == "__main__":
    unittest.main()
