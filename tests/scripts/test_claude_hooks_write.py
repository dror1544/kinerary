"""scripts/claude-hooks/pretooluse-write.sh — two files no tool edits directly.

CLAUDE.md is policy (decision 2026-09-20): a subagent detects drift and prepares
a diff, a person applies it. .project/sprint.json is the sprint/baseline state:
it changes only through scripts/project-state.py, which records who, when, why.
"""
from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HOOK = REPO / "scripts/claude-hooks/pretooluse-write.sh"


def hook(file_path: str, agent_type: str = None) -> dict:
    payload = {"tool_name": "Write", "tool_input": {"file_path": str(REPO / file_path)}}
    if agent_type is not None:
        payload["agent_type"] = agent_type
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    out = subprocess.run(["bash", str(HOOK)], cwd=REPO, env=env, input=json.dumps(payload),
                         capture_output=True, text=True, timeout=60).stdout.strip()
    return json.loads(out)["hookSpecificOutput"] if out else {}


class PolicyAndState(unittest.TestCase):
    def test_a_subagent_may_not_write_claude_md(self):
        d = hook("CLAUDE.md", agent_type="doc-keeper")
        self.assertEqual(d.get("permissionDecision"), "deny")
        self.assertIn("policy", d["permissionDecisionReason"])
        self.assertIn("doc-keeper", d["permissionDecisionReason"])

    def test_the_lead_session_may_still_write_claude_md(self):
        self.assertEqual(hook("CLAUDE.md"), {})

    def test_nobody_hand_edits_the_sprint_state(self):
        for agent in (None, "developer"):
            d = hook(".project/sprint.json", agent_type=agent)
            self.assertEqual(d.get("permissionDecision"), "deny", agent)
            self.assertIn("scripts/project-state.py", d["permissionDecisionReason"])

    def test_an_ordinary_document_is_untouched_by_these_rules(self):
        self.assertEqual(hook("docs/agent-team-plan.md", agent_type="doc-keeper"), {})


if __name__ == "__main__":
    unittest.main()
