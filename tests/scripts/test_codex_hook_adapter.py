"""Codex transport must preserve shared policy without unsupported ask decisions."""
from __future__ import annotations

import json
import importlib.util
import io
import shutil
import subprocess
import sys
from unittest.mock import patch

from test_claude_hooks_bash import Harness, REPO


class CodexAdapter(Harness):
    def setUp(self):
        super().setUp()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.hermes.cleanup)
        self.addCleanup(self.log.unlink, missing_ok=True)
        for name in ("codex-adapter.py", "pretooluse-write.sh", "sessionstart.sh"):
            shutil.copy2(REPO / "scripts/claude-hooks" / name,
                         self.root / "scripts/claude-hooks" / name)

    def call(self, mode, payload):
        raw = payload if isinstance(payload, str) else json.dumps(payload)
        result = subprocess.run(
            [sys.executable, "scripts/claude-hooks/codex-adapter.py", mode],
            cwd=self.root, env=self.env, input=raw, capture_output=True,
            text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout).get("hookSpecificOutput", {}) if result.stdout.strip() else {}

    def bash(self, command, **extra):
        return self.call("bash", {"tool_name": "Bash", "tool_input": {"command": command}, **extra})

    def patch(self, text, **extra):
        return self.call("write", {"tool_name": "apply_patch", "tool_input": {"command": text}, **extra})

    def assertDenied(self, result):
        self.assertEqual(result.get("permissionDecision"), "deny", result)
        self.assertTrue(result.get("permissionDecisionReason"), result)

    def test_feature_commit_remains_allowed(self):
        subprocess.run(["git", "checkout", "-qb", "fix/example"], cwd=self.root, check=True)
        self.assertEqual(self.bash("git commit -m 'docs: note'"), {})

    def test_policy_commit_ask_becomes_deny(self):
        subprocess.run(["git", "checkout", "-qb", "fix/example"], cwd=self.root, check=True)
        (self.root / ".codex").mkdir()
        (self.root / ".codex/hooks.json").write_text("{}\n")
        subprocess.run(["git", "add", ".codex/hooks.json"], cwd=self.root, check=True)
        self.assertDenied(self.bash("git commit -m 'fix: hooks'"))

    def test_sensitive_commands_are_denied(self):
        for command in ("git push origin main", "docker compose up -d --build"):
            with self.subTest(command=command):
                self.assertDenied(self.bash(command))

    def test_subagent_identity_is_preserved(self):
        subprocess.run(["git", "checkout", "-qb", "fix/example"], cwd=self.root, check=True)
        self.assertDenied(self.bash("git commit -m 'note'", agent_type="developer"))

    def test_subagent_without_role_cannot_inherit_lead_privileges(self):
        subprocess.run(["git", "checkout", "-qb", "fix/example"], cwd=self.root, check=True)
        for identity in ({"agent_id": "child"}, {"agent_id": "child", "agent_type": ""}):
            with self.subTest(identity=identity):
                self.assertDenied(self.bash("git commit -m 'note'", **identity))

    def test_invalid_inputs_fail_closed(self):
        for mode, payload in (("bash", "{bad"), ("write", "{bad"), ("bash", {}),
                              ("write", {}), ("bash", {"tool_input": {"command": []}}),
                              ("write", {"tool_input": {"command": "not a patch"}})):
            with self.subTest(mode=mode, payload=payload):
                self.assertDenied(self.call(mode, payload))

    def test_all_patch_path_operations_are_checked(self):
        patches = (
            "*** Add File: .project/sprint.json\n+{}",
            "*** Update File: .project/sprint.json\n@@\n-old\n+new",
            "*** Delete File: .project/sprint.json",
            "*** Update File: safe.txt\n*** Move to: .project/sprint.json\n@@\n-old\n+new",
            "*** Add File: trip/booking.txt\n+data",
            "*** Add File: ../outside.txt\n+data",
            "*** Add File: /tmp/outside-kinerary.txt\n+data",
        )
        for body in patches:
            with self.subTest(body=body):
                self.assertDenied(self.patch("*** Begin Patch\n" + body + "\n*** End Patch"))

    def test_a_later_protected_path_is_not_skipped(self):
        self.assertDenied(self.patch(
            "*** Begin Patch\n*** Add File: safe.txt\n+ok\n"
            "*** Delete File: .project/sprint.json\n*** End Patch"))

    def test_symlink_does_not_hide_a_protected_lexical_path(self):
        (self.root / "trips").mkdir()
        (self.root / "trip").symlink_to(self.root / "trips", target_is_directory=True)
        self.assertDenied(self.patch(
            "*** Begin Patch\n*** Add File: trip/booking.md\n+data\n*** End Patch"))

    def test_symlink_does_not_hide_a_protected_destination(self):
        (self.root / ".project").mkdir()
        (self.root / "alias").symlink_to(self.root / ".project", target_is_directory=True)
        self.assertDenied(self.patch(
            "*** Begin Patch\n*** Add File: alias/sprint.json\n+{}\n*** End Patch"))

    def test_benign_multifile_patch_passes(self):
        result = self.patch(
            "*** Begin Patch\n*** Add File: docs/new.md\n+hello\n"
            "*** Update File: note.md\n@@\n-x\n+y\n"
            "*** Delete File: old.md\n*** End Patch")
        self.assertIn(result.get("permissionDecision"), (None, "allow"))

    def test_subagent_cannot_patch_policy(self):
        self.assertDenied(self.patch(
            "*** Begin Patch\n*** Update File: CLAUDE.md\n@@\n-old\n+new\n*** End Patch",
            agent_type="developer"))

    def test_legacy_file_path_is_checked(self):
        self.assertDenied(self.call("write", {
            "tool_name": "Write", "tool_input": {"file_path": str(self.root / ".project/sprint.json")}}))
        result = self.call("write", {"tool_name": "Write", "tool_input": {"file_path": "docs/ok.md"}})
        self.assertIn(result.get("permissionDecision"), (None, "allow"))

    def test_session_context_is_forwarded(self):
        result = self.call("session", {})
        self.assertEqual(result.get("hookEventName"), "SessionStart")
        self.assertIn("Repo state: on 'main'", result.get("additionalContext", ""))

    def test_shared_hook_failures_do_not_allow_writes(self):
        hook = self.root / "scripts/claude-hooks/pretooluse-write.sh"
        for body in ("echo not-json\n", "exit 1\n", 'echo \'{"unexpected":true}\'\n'):
            with self.subTest(body=body):
                hook.write_text("#!/bin/sh\n" + body)
                self.assertDenied(self.call("write", {
                    "tool_name": "Write", "tool_input": {"file_path": "docs/ok.md"}}))

    def test_missing_shared_hook_fails_closed(self):
        (self.root / "scripts/claude-hooks/pretooluse-write.sh").unlink()
        self.assertDenied(self.call("write", {
            "tool_name": "Write", "tool_input": {"file_path": "docs/ok.md"}}))

    def test_shared_policy_timeout_becomes_deny_without_waiting(self):
        spec = importlib.util.spec_from_file_location(
            "codex_adapter_test", REPO / "scripts/claude-hooks/codex-adapter.py")
        adapter = importlib.util.module_from_spec(spec)
        with patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(adapter)
        output = io.StringIO()
        payload = json.dumps({"tool_input": {"command": "git status"}})
        with patch.object(adapter, "run_policy", side_effect=subprocess.TimeoutExpired("policy", 0.01)), \
                patch.object(sys, "argv", ["codex-adapter.py", "bash"]), \
                patch.object(sys, "stdin", io.StringIO(payload)), patch.object(sys, "stdout", output):
            self.assertEqual(adapter.main(), 0)
        self.assertDenied(json.loads(output.getvalue())["hookSpecificOutput"])

    def test_malformed_reasons_fail_closed(self):
        hook = self.root / "scripts/claude-hooks/pretooluse-write.sh"
        for decision in ("ask", "allow", "deny"):
            for reason in (None, 17, []):
                with self.subTest(decision=decision, reason=reason):
                    response = json.dumps({"hookSpecificOutput": {
                        "hookEventName": "PreToolUse", "permissionDecision": decision,
                        "permissionDecisionReason": reason}})
                    hook.write_text("#!/bin/sh\ncat <<'END'\n" + response + "\nEND\n")
                    self.assertDenied(self.call("write", {"tool_input": {"file_path": "docs/ok.md"}}))

    def test_missing_preflight_dependency_fails_closed(self):
        (self.root / "scripts/preflight-checks.sh").unlink()
        self.assertDenied(self.call("write", {"tool_input": {"file_path": "docs/ok.md"}}))

    def test_nonexecutable_preflight_dependency_fails_closed(self):
        (self.root / "scripts/preflight-checks.sh").chmod(0o644)
        self.assertDenied(self.call("write", {"tool_input": {"file_path": "docs/ok.md"}}))

    def test_missing_command_classifier_fails_closed(self):
        (self.root / "scripts/claude-hooks/match-command.py").unlink()
        self.assertDenied(self.bash("git status"))

    def test_wrong_git_working_directory_fails_closed(self):
        result = subprocess.run(
            [sys.executable, str(self.root / "scripts/claude-hooks/codex-adapter.py"), "bash"],
            cwd=self.hermes.name, env=self.env,
            input=json.dumps({"tool_input": {"command": "git commit -m 'note'"}}),
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertDenied(json.loads(result.stdout).get("hookSpecificOutput", {}))

    def test_multiple_paths_share_one_deadline(self):
        spec = importlib.util.spec_from_file_location(
            "codex_adapter_budget", self.root / "scripts/claude-hooks/codex-adapter.py")
        adapter = importlib.util.module_from_spec(spec)
        with patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(adapter)
        command = "*** Begin Patch\n*** Add File: a.md\n+a\n*** Add File: b.md\n+b\n*** End Patch"
        with patch.object(adapter, "run_policy", return_value={}) as run, \
                patch.object(adapter, "checked_paths", side_effect=lambda p: [str(self.root / p)]):
            adapter.handle("write", {"tool_input": {"command": command}})
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0].args[2], run.call_args_list[1].args[2])

    def test_policy_uses_remaining_budget_and_stops_at_deadline(self):
        spec = importlib.util.spec_from_file_location(
            "codex_adapter_remaining", self.root / "scripts/claude-hooks/codex-adapter.py")
        adapter = importlib.util.module_from_spec(spec)
        with patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(adapter)
        with patch.object(adapter.time, "monotonic", return_value=18), \
                patch.object(adapter.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess([], 0, str(self.root)),
                    subprocess.CompletedProcess([], 0, "{}")]) as run:
            adapter.run_policy("pretooluse-write.sh", {}, 20)
        self.assertEqual(run.call_args.kwargs["timeout"], 2)
        with patch.object(adapter.time, "monotonic", return_value=21), \
                patch.object(adapter.subprocess, "run", return_value=
                             subprocess.CompletedProcess([], 0, str(self.root))) as run:
            with self.assertRaises(ValueError):
                adapter.run_policy("pretooluse-write.sh", {}, 20)
        self.assertFalse(any(call.args[0][0] == "bash" for call in run.call_args_list))
