"""scripts/claude-hooks/pretooluse-write.sh — two files no tool edits directly,
and (#262) that protection surviving a differently-spelled alias of the same
on-disk path on a case/normalisation-insensitive filesystem (APFS, this Mac).

CLAUDE.md is policy (decision 2026-09-20): a subagent detects drift and prepares
a diff, a person applies it. .project/sprint.json is the sprint/baseline state:
it changes only through scripts/project-state.py, which records who, when, why.
trip/ (singular) is hard rule 4 — it is reserved for whatever TRIP_DIR defaults
to when unset; new trips go in trips/<slug>/.

Runs from a throwaway repository (Harness, shared with
test_codex_hook_adapter.py — the sibling route #261 already protects) so a
controlled, differently-spelled trip/, .project/ and CLAUDE.md can be set up
without touching the real tree.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

# tests/scripts has no __init__.py; make the sibling import work under both
# `discover -s tests/scripts` and `python3 -m unittest tests.scripts.<module>`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_claude_hooks_bash import Harness, REPO  # noqa: E402


class WriteGuard(Harness):
    def setUp(self):
        super().setUp()
        for name in ("pretooluse-write.sh", "path_canon.py"):
            shutil.copy2(REPO / "scripts/claude-hooks" / name,
                         self.root / "scripts/claude-hooks" / name)
        # macOS: /var (where tempfile puts self.root) is itself a symlink to
        # /private/var. `git rev-parse --show-toplevel`, run from inside the
        # hook's own subprocess, reports the physically-resolved path; a
        # file_path built from the unresolved self.root would then fail the
        # hook's own REPO_ROOT-prefix strip for a reason that has nothing to
        # do with #262. Build test payloads against the same resolved root
        # the hook itself will see.
        self.realroot = self.root.resolve()

    def hook(self, file_path: str, agent_type: str = None) -> dict:
        value = file_path if os.path.isabs(file_path) else str(self.realroot / file_path)
        payload = {"tool_name": "Write", "tool_input": {"file_path": value}}
        if agent_type is not None:
            payload["agent_type"] = agent_type
        out = subprocess.run(
            ["bash", "scripts/claude-hooks/pretooluse-write.sh"], cwd=self.root, env=self.env,
            input=json.dumps(payload), capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        return json.loads(out)["hookSpecificOutput"] if out else {}

    def assertDenied(self, result):
        self.assertEqual(result.get("permissionDecision"), "deny", result)

    def assertAllowed(self, result):
        self.assertIn(result.get("permissionDecision"), (None, "allow"), result)


class PolicyAndState(WriteGuard):
    def test_a_subagent_may_not_write_claude_md(self):
        (self.root / "CLAUDE.md").write_text("old\n")
        d = self.hook("CLAUDE.md", agent_type="doc-keeper")
        self.assertDenied(d)
        self.assertIn("policy", d["permissionDecisionReason"])
        self.assertIn("doc-keeper", d["permissionDecisionReason"])

    def test_the_lead_session_may_still_write_claude_md(self):
        (self.root / "CLAUDE.md").write_text("old\n")
        self.assertAllowed(self.hook("CLAUDE.md"))

    def test_nobody_hand_edits_the_sprint_state(self):
        (self.root / ".project").mkdir()
        (self.root / ".project/sprint.json").write_text("old\n")
        for agent in (None, "developer"):
            d = self.hook(".project/sprint.json", agent_type=agent)
            self.assertDenied(d)
            self.assertIn("scripts/project-state.py", d["permissionDecisionReason"])

    def test_an_ordinary_document_is_untouched_by_these_rules(self):
        (self.root / "docs").mkdir()
        self.assertAllowed(self.hook("docs/agent-team-plan.md", agent_type="doc-keeper"))

    def test_writing_trip_singular_is_denied(self):
        self.assertDenied(self.hook("trip/x.txt"))


class AliasSpellingsOfProtectedPaths(WriteGuard):
    """Issue #262. Each row below is measured, through the real hook, in a
    throwaway repo: before the fix every "bypass" row is wrongly ALLOWED,
    after the fix every row (bypass or already-correct) is DENIED."""

    def case_insensitive(self):
        probe = self.root / "CaseProbe"
        probe.write_text("")
        try:
            return (self.root / "caseprobe").exists()
        finally:
            probe.unlink()

    def seed(self):
        (self.root / ".project").mkdir(exist_ok=True)
        (self.root / ".project/sprint.json").write_text("old\n")
        (self.root / "CLAUDE.md").write_text("old\n")
        (self.root / "trip").mkdir(exist_ok=True)
        (self.root / "trip/x.txt").write_text("old\n")
        if not self.case_insensitive():
            self.skipTest("case-sensitive filesystem: no other spelling opens an existing file")

    def test_the_six_measured_rows(self):
        # The exact table from the issue report, reproduced directly against
        # pretooluse-write.sh (not through the Codex adapter, which #261
        # already canonicalizes ahead of — this is Claude's own Write/Edit
        # route, which had no canonicalization step at all).
        self.seed()
        rows = [
            (".project/sprint.json", None),       # deny (correct, pre- and post-fix)
            (".PROJECT/sprint.json", None),        # bypass pre-fix
            ("trip/x.txt", None),                  # deny (correct, pre- and post-fix)
            ("TRIP/x.txt", None),                  # bypass pre-fix
            ("CLAUDE.md", "developer"),             # deny (correct, pre- and post-fix)
            ("claude.md", "developer"),             # bypass pre-fix
        ]
        confusable = ".project/ſprint.json"  # U+017F LONG S folds to 's'
        if (self.root / confusable).exists():
            rows.append((confusable, None))        # bypass pre-fix, where the FS folds it
        for path, agent_type in rows:
            with self.subTest(path=path, agent_type=agent_type):
                self.assertDenied(self.hook(path, agent_type=agent_type))

    def test_a_new_leaf_under_an_aliased_directory_is_still_caught(self):
        # TRIP/newfile.txt does not exist yet — only trip/ does — but a
        # case-insensitive filesystem still treats it as inside the same
        # directory, so this has to be caught at the directory level, not by
        # asking "does this exact file exist".
        self.seed()
        self.assertDenied(self.hook("TRIP/newfile.txt"))

    def test_sprint_json_new_leaf_spelling_is_caught_too(self):
        self.seed()
        self.assertDenied(self.hook(".PROJECT/sprint.json"))

    def test_legitimate_writes_in_any_case_or_spelling_are_still_allowed(self):
        # The fix must not become a false-positive generator: a near-miss, in
        # any case, through any route, stays allowed.
        self.seed()
        (self.root / "docs").mkdir(exist_ok=True)
        (self.root / "trips/demo").mkdir(parents=True, exist_ok=True)
        for path in ("docs/readme.md", "DOCS/README.MD", "Docs/Readme.Md",
                     "trips/demo/x.txt", "TRIPS/demo/x.txt", "tripwire.md",
                     "docs/trip-notes.md", "Trip-notes.md", ".project/other.json",
                     "docs/.project/sprint.json", "docs/CLAUDE.md"):
            with self.subTest(path=path):
                self.assertAllowed(self.hook(path))

    def test_legitimate_new_files_in_any_case_are_still_allowed(self):
        # Not-yet-existing files, same story: only the protected directory
        # itself (and its descendants) is denied, not every differently-cased
        # neighbour.
        self.seed()
        for path in ("Docs/new-file.md", "TRIPS/demo/new.txt", "trip-ideas.md"):
            with self.subTest(path=path):
                self.assertAllowed(self.hook(path))


if __name__ == "__main__":
    unittest.main()
