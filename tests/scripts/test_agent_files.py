"""`.claude/agents/*.md` — every role declares its tier, and the roles that must not write cannot.

Decision 8 (2026-09-20): Opus for judgment calls, Sonnet for everyday work,
declared per file so the Mac's personal `effortLevel: xhigh` never leaks into
a subagent. A `disallowedTools: Agent(x)` entry would remove the whole Agent
tool, so nothing uses one.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
AGENTS = REPO / ".claude/agents"
MODELS = {"sonnet", "opus", "haiku", "inherit", "fable"}
EFFORTS = {"low", "medium", "high", "xhigh", "max"}
READ_ONLY = {"verifier", "boundary-reviewer"}
TEAM = {"developer", "integrator", "doc-keeper"}


def frontmatter(path: Path) -> dict:
    text = path.read_text()
    head = text.split("\n---\n", 1)[0].lstrip("---\n")
    return {k.strip(): v.strip() for k, _, v in (line.partition(":") for line in head.splitlines() if line.strip())}


class AgentFiles(unittest.TestCase):
    def test_the_team_roles_exist(self):
        for name in TEAM:
            self.assertTrue((AGENTS / f"{name}.md").exists(), name)

    def test_every_role_declares_a_model_and_an_effort(self):
        for path in sorted(AGENTS.glob("*.md")):
            fm = frontmatter(path)
            self.assertEqual(fm.get("name"), path.stem, path.name)
            self.assertIn(fm.get("model"), MODELS, path.name)
            self.assertIn(fm.get("effort"), EFFORTS, path.name)
            self.assertTrue(fm.get("description"), path.name)

    def test_read_only_roles_have_no_write_or_edit(self):
        for name in READ_ONLY:
            tools = frontmatter(AGENTS / f"{name}.md").get("tools", "")
            self.assertNotRegex(tools, r"\b(Write|Edit)\b", name)

    def test_no_role_disallows_a_specific_subagent(self):
        # `disallowedTools: Agent(x)` removes the Agent tool entirely (docs, 2026-09-20).
        for path in AGENTS.glob("*.md"):
            self.assertNotIn("disallowedTools: Agent(", path.read_text(), path.name)

    def test_judgment_roles_run_opus_and_everyday_roles_run_sonnet(self):
        expected = {"regression-planner": "opus", "boundary-reviewer": "opus",
                    "developer": "sonnet", "integrator": "sonnet", "doc-keeper": "sonnet",
                    "verifier": "sonnet", "pr-steward": "sonnet", "sprint-scribe": "sonnet", "run-capture": "sonnet"}
        for name, model in expected.items():
            self.assertEqual(frontmatter(AGENTS / f"{name}.md").get("model"), model, name)


if __name__ == "__main__":
    unittest.main()
