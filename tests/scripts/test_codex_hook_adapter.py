"""Codex transport must preserve shared policy without unsupported ask decisions."""
from __future__ import annotations

import hashlib
import json
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# tests/scripts has no __init__.py; make the sibling import work under both
# `discover -s tests/scripts` and `python3 -m unittest tests.scripts.<module>`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_claude_hooks_bash import Harness, REPO  # noqa: E402


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

    # Review round 1. Codex 0.153.2's apply_patch trims Unicode White_Space
    # from a header line before it takes the path (proven offline with
    # `codex --codex-run-as-apply-patch`; docs/test-reports/codex-hooks-2026-09-26.md),
    # so the adapter must check the trimmed path, not the path as typed.
    def assertAllowed(self, result):
        self.assertIn(result.get("permissionDecision"), (None, "allow"), result)

    def test_trailing_whitespace_codex_strips_cannot_hide_a_protected_path(self):
        for ch in (" ", "\t", "\u00a0", "\r", "\u2028", "\u3000"):
            for body in ("*** Update File: .project/sprint.json" + ch + "\n@@\n-old\n+new",
                         "*** Update File: safe.txt\n*** Move to: .project/sprint.json" + ch
                         + "\n@@\n-old\n+new"):
                with self.subTest(char=repr(ch), body=body[:22]):
                    self.assertDenied(self.patch("*** Begin Patch\n" + body + "\n*** End Patch"))

    def test_subagent_cannot_patch_policy_behind_a_trailing_space(self):
        self.assertDenied(self.patch(
            "*** Begin Patch\n*** Update File: CLAUDE.md \n@@\n-old\n+new\n*** End Patch",
            agent_type="developer"))

    def test_indented_header_on_a_protected_path_is_denied(self):
        for indent in ("  ", "\t", "\u00a0"):
            with self.subTest(indent=repr(indent)):
                self.assertDenied(self.patch(
                    "*** Begin Patch\n" + indent + "*** Update File: .project/sprint.json\n"
                    "@@\n-old\n+new\n*** End Patch"))

    def test_indented_header_on_an_ordinary_path_is_checked_and_allowed(self):
        self.assertAllowed(self.patch(
            "*** Begin Patch\n  *** Add File: docs/indented.md\n+hi\n*** End Patch"))

    def test_trailing_whitespace_on_an_ordinary_path_is_allowed(self):
        self.assertAllowed(self.patch(
            "*** Begin Patch\n*** Add File: docs/new.md \t\n+hi\n*** End Patch"))

    def test_interior_ascii_space_in_a_path_is_allowed(self):
        self.assertAllowed(self.patch(
            "*** Begin Patch\n*** Add File: docs/My Notes (Manual).md\n+hi\n*** End Patch"))

    def test_path_characters_codex_does_not_strip_fail_closed(self):
        # Codex keeps these in the path it writes (U+001C-U+001F, ZWSP, BOM
        # trailing; controls anywhere), so the adapter cannot prove the path
        # it checks is the path written. (A leading U+0020 is kept literally
        # and checked as written: round 2, below.)
        for value in ("docs/x.md\x1f", "docs/x.md\x1c", "docs/x.md\u200b", "docs/x.md\ufeff",
                      "\u00a0docs/x.md", "docs/a\tb.md", "docs/a\x0bb.md", "docs/a\u2028b.md",
                      "docs/a\x7fb.md", "docs/\u202ex.md"):
            with self.subTest(value=repr(value)):
                self.assertDenied(self.patch(
                    "*** Begin Patch\n*** Add File: " + value + "\n+hi\n*** End Patch"))

    def test_deny_with_an_empty_reason_still_carries_a_reason(self):
        # Codex treats a deny without a non-empty reason as a failed hook and
        # runs the call; the adapter must never emit one.
        hook = self.root / "scripts/claude-hooks/pretooluse-write.sh"
        for reason in ("", "   ", "\n"):
            with self.subTest(reason=repr(reason)):
                response = json.dumps({"hookSpecificOutput": {
                    "hookEventName": "PreToolUse", "permissionDecision": "deny",
                    "permissionDecisionReason": reason}})
                hook.write_text("#!/bin/sh\ncat <<'END'\n" + response + "\nEND\n")
                result = self.call("write", {"tool_input": {"file_path": "docs/ok.md"}})
                self.assertEqual(result.get("permissionDecision"), "deny", result)
                self.assertTrue(result.get("permissionDecisionReason", "").strip(), result)

    def test_odd_agent_identities_cannot_inherit_lead_privileges(self):
        subprocess.run(["git", "checkout", "-qb", "fix/example"], cwd=self.root, check=True)
        for identity in ({"agent_id": 0}, {"agent_id": ""}, {"agent_id": False},
                         {"agent_id": "child", "agent_type": "\n"},
                         {"agent_id": "child", "agent_type": " \t"},
                         {"agent_type": "\n"}, {"agent_type": "  "}):
            with self.subTest(identity=identity):
                self.assertDenied(self.bash("git commit -m 'note'", **identity))

    def test_payload_without_agent_keys_is_the_lead(self):
        # Every lead payload captured from Codex 0.153.2 omits both keys
        # (capture.jsonl: agent_id present only on subagent payloads).
        subprocess.run(["git", "checkout", "-qb", "fix/example"], cwd=self.root, check=True)
        self.assertEqual(self.bash("git commit -m 'docs: note'", session_id="s", turn_id="t"), {})

    # Review round 2 (PR #261).
    def adapter(self):
        spec = importlib.util.spec_from_file_location(
            "codex_adapter_round2", self.root / "scripts/claude-hooks/codex-adapter.py")
        adapter = importlib.util.module_from_spec(spec)
        with patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(adapter)
        return adapter

    def test_header_lookalike_in_update_context_is_not_a_file_operation(self):
        # Codex's repro: offline Codex updates only docs/readme.md here.
        repro = ("*** Begin Patch\n*** Update File: docs/readme.md\n@@\n"
                 " *** Update File: .project/sprint.json\n-old\n+new\n*** End Patch")
        self.assertEqual(self.adapter().patch_paths(repro), ["docs/readme.md"])
        self.assertAllowed(self.patch(repro))
        for line in (" *** Add File: CLAUDE.md", " *** Delete File: .project/sprint.json",
                     " *** Move to: .project/sprint.json", "   *** Update File: trip/x.md",
                     "+*** Add File: .project/sprint.json", "-*** Delete File: CLAUDE.md",
                     "", " *** End Patch"):
            with self.subTest(line=line):
                self.assertEqual(self.adapter().patch_paths(
                    "*** Begin Patch\n*** Update File: docs/readme.md\n@@\n-old\n+new\n"
                    + line + "\n*** End Patch"), ["docs/readme.md"])

    def test_header_after_an_add_or_delete_block_is_a_header(self):
        # There the next line is at header position, and Codex trims it.
        for before in ("*** Add File: docs/n.md\n+x\n", "*** Delete File: docs/old.md\n"):
            for indent in ("", "  ", "\t", "\u00a0", "\u3000"):
                with self.subTest(before=before[:18], indent=repr(indent)):
                    self.assertDenied(self.patch(
                        "*** Begin Patch\n" + before + indent
                        + "*** Update File: .project/sprint.json\n@@\n-old\n+new\n*** End Patch"))

    def test_header_after_end_of_file_marker_is_a_header(self):
        for marker in ("*** End of File", "*** End of File ", "*** End of File\t"):
            with self.subTest(marker=repr(marker)):
                self.assertEqual(self.adapter().patch_paths(
                    "*** Begin Patch\n*** Update File: docs/a.md\n@@\n x\n+y\n" + marker
                    + "\n*** Delete File: CLAUDE.md\n*** End Patch"), ["docs/a.md", "CLAUDE.md"])

    def test_move_to_is_read_only_directly_after_its_update_header(self):
        adapter = self.adapter()
        self.assertEqual(adapter.patch_paths(
            "*** Begin Patch\n*** Update File: a.md\n*** Move to: b.md \n@@\n-x\n+y\n*** End Patch"),
            ["a.md", "b.md"])
        # Indented, Codex reads it as a context line, not a move.
        self.assertEqual(adapter.patch_paths(
            "*** Begin Patch\n*** Update File: a.md\n  *** Move to: b.md\n-x\n+y\n*** End Patch"),
            ["a.md"])

    def test_what_codex_rejects_at_header_position_is_refused(self):
        adapter = self.adapter()
        for body in ("\n*** Add File: a.md\n+x", "*** Add File: a.md\n+x\n\n*** Add File: b.md\n+y",
                     "*** Update File: a.md\n@@\n-x\n+y\n***Add File: b.md\n+z",
                     "*** Update File: a.md\n@@\n-x\n+y\n*** End Patch\n*** Add File: b.md\n+z",
                     "*** Update File: a.md\n*** Move to: b.md\n*** Move to: c.md\n@@\n-x\n+y",
                     "*** Add File:a.md\n+x", "*** add file: a.md\n+x"):
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    adapter.patch_paths("*** Begin Patch\n" + body + "\n*** End Patch")

    def test_leading_space_in_a_path_is_kept_as_codex_keeps_it(self):
        # `*** Add File:  lead.md` makes " lead.md" (offline engine, 2026-09-26).
        self.assertEqual(self.adapter().patch_paths(
            "*** Begin Patch\n*** Add File:  lead.md\n+x\n*** Update File: a.md\n"
            "*** Move to:  b.md\n@@\n-x\n+y\n*** End Patch"), [" lead.md", "a.md", " b.md"])

    def test_crlf_patch_is_parsed_like_lf(self):
        self.assertEqual(self.adapter().patch_paths(
            "*** Begin Patch\r\n*** Update File: a.md\r\n@@\r\n x\r\n+y\r\n*** End of File\r\n"
            "*** Add File: .project/sprint.json\r\n+{}\r\n*** End Patch\r\n"),
            ["a.md", ".project/sprint.json"])

    def test_nul_in_agent_type_cannot_become_the_lead(self):
        # A shell cannot hold NUL, so $(jq -r .agent_type) reads "\u0000" as empty.
        subprocess.run(["git", "checkout", "-qb", "fix/example"], cwd=self.root, check=True)
        for role in ("\u0000", "\u0000\n", "\u0000\u0000", "dev\u0000", "dev\u200b", "dev\tx"):
            with self.subTest(role=repr(role)):
                self.assertDenied(self.bash("git commit -m 'note'", agent_type=role))
                self.assertDenied(self.patch(
                    "*** Begin Patch\n*** Update File: CLAUDE.md\n@@\n-old\n+new\n*** End Patch",
                    agent_type=role))

    def test_ordinary_roles_reach_the_shared_hook_as_subagents(self):
        for role in ("default", "developer", "doc keeper"):
            with self.subTest(role=role):
                self.assertAllowed(self.call("write", {
                    "tool_input": {"file_path": "docs/ok.md"}, "agent_type": role}))
                result = self.patch(
                    "*** Begin Patch\n*** Update File: CLAUDE.md\n@@\n-old\n+new\n*** End Patch",
                    agent_type=role)
                self.assertDenied(result)
                self.assertIn("A subagent (%s) never edits it" % role,
                              result["permissionDecisionReason"])

    def case_insensitive(self):
        probe = self.root / "CaseProbe"
        probe.write_text("")
        try:
            return (self.root / "caseprobe").exists()
        finally:
            probe.unlink()

    def seed_protected(self):
        (self.root / ".project").mkdir(exist_ok=True)
        (self.root / ".project/sprint.json").write_text("old\n")
        (self.root / "CLAUDE.md").write_text("old\n")
        (self.root / "trip").mkdir(exist_ok=True)
        (self.root / "trip/proof.txt").write_text("old\n")
        if not self.case_insensitive():
            self.skipTest("case-sensitive filesystem: no other spelling opens an existing file")

    def test_an_alias_spelling_cannot_reach_a_protected_file(self):
        # On a case-insensitive filesystem these open the existing protected
        # file, and Path.resolve() keeps the spelling it was given.
        self.seed_protected()
        cases = [("Update", ".PROJECT/sprint.json", {}), ("Update", ".project/SPRINT.JSON", {}),
                 ("Delete", ".Project/Sprint.Json", {}), ("Update", "claude.md", {"agent_type": "developer"}),
                 ("Update", "TRIP/proof.txt", {}), ("Add", "TRIP/new.txt", {})]
        if (self.root / ".project/\u017fprint.json").exists():  # U+017F LONG S folds to s
            cases.append(("Update", ".project/\u017fprint.json", {}))
        for op, value, extra in cases:
            body = {"Update": "\n@@\n-old\n+new", "Delete": "", "Add": "\n+x"}[op]
            with self.subTest(op=op, path=value):
                self.assertDenied(self.patch(
                    "*** Begin Patch\n*** %s File: %s%s\n*** End Patch" % (op, value, body), **extra))
                self.assertDenied(self.call("write", {"tool_input": {"file_path": value}, **extra}))

    def test_a_new_leaf_under_an_alias_directory_is_checked_in_every_spelling(self):
        # Round 3: the spelling as written, the on-disk spelling and the
        # case-folded one are all checked; round 2 kept only the on-disk one.
        self.seed_protected()
        root, adapter = self.root.resolve(), self.adapter()
        self.assertEqual(adapter.checked_paths(str(root / ".PROJECT/newfile")),
                         [str(root / ".PROJECT/newfile"), str(root / ".project/newfile")])
        self.assertEqual(adapter.checked_paths(str(root / "docs/New.md")),
                         [str(root / "docs/New.md"), str(root / "docs/new.md")])

    def test_an_alias_matching_two_directory_entries_fails_closed(self):
        self.seed_protected()
        root = self.root.resolve()
        os.link(root / ".project/sprint.json", root / ".project/Other.json")
        with self.assertRaises(ValueError):
            self.adapter().checked_paths(str(root / ".project/OTHER.json"))

    # Review round 3 (PR #260). The shared rules are case-sensitive: trip/* at
    # the repository root (preflight B3), .project/sprint.json and, for a
    # subagent, CLAUDE.md (pretooluse-write.sh). Round 2's tests only ever
    # had the disk spell the protected directory the way the rule does, so
    # rewriting to the on-disk spelling looked safe. These put the disk's
    # spelling and the rule's spelling apart, in both directions, and with
    # no directory at all.
    def reset_trip(self, spelling):
        for name in os.listdir(self.root):
            if name.casefold() == "trip":
                shutil.rmtree(self.root / name)
        if spelling:
            (self.root / spelling).mkdir()

    def assertEveryRouteDenied(self, value, **extra):
        self.assertDenied(self.patch(
            "*** Begin Patch\n*** Add File: %s\n+proof\n*** End Patch" % value, **extra))
        self.assertDenied(self.patch(
            "*** Begin Patch\n*** Update File: docs/a.md\n*** Move to: %s\n@@\n-old\n+new\n"
            "*** End Patch" % value, **extra))
        self.assertDenied(self.call("write", {"tool_input": {"file_path": value}, **extra}))

    def test_codex_round3_repro_existing_uppercase_trip_directory(self):
        self.reset_trip("TRIP")
        result = self.patch("*** Begin Patch\n*** Add File: trip/proof.txt\n+proof\n*** End Patch")
        self.assertDenied(result)
        self.assertIn("hard rule 4", result["permissionDecisionReason"])

    def test_trip_is_denied_whatever_the_disk_calls_it(self):
        cases = (("TRIP", ("trip/proof.txt", "TRIP/proof.txt", "Trip/x.txt")),
                 ("trip", ("TRIP/proof.txt", "Trip/x.txt", "trip/x.txt")),
                 ("Trip", ("trip/x.txt", "TRIP/x.txt")),
                 (None, ("TRIP/proof.txt", "Trip/proof.txt", "trip/proof.txt", "tRiP/a/b.txt")))
        for existing, values in cases:
            for value in values:
                with self.subTest(existing=existing, path=value):
                    self.reset_trip(existing)
                    self.assertEveryRouteDenied(value)

    def test_sprint_lock_and_policy_aliases_are_denied_by_every_route(self):
        (self.root / ".project").mkdir()
        (self.root / ".project/sprint.json").write_text("old\n")
        (self.root / "CLAUDE.md").write_text("old\n")
        for value in (".project/sprint.json", ".PROJECT/sprint.json", ".project/SPRINT.JSON",
                      ".project/\u017fprint.json"):
            with self.subTest(path=value):
                self.assertEveryRouteDenied(value)
                self.assertDenied(self.patch(
                    "*** Begin Patch\n*** Delete File: %s\n*** End Patch" % value))
        if self.case_insensitive():  # claude.md is another file where case matters
            for value in ("CLAUDE.md", "claude.md", "Claude.MD"):
                with self.subTest(path=value, role="developer"):
                    self.assertEveryRouteDenied(value, agent_type="developer")

    def test_near_misses_of_protected_paths_stay_allowed(self):
        (self.root / "docs").mkdir()
        (self.root / "docs/readme.md").write_text("old\n")
        for existing in ("trip", "TRIP", None):
            for value in ("docs/TRIP/x.md", "docs/trip/x.md", "docs/trip-notes.md", "tripwire.md",
                          "Trip-notes.md", "Docs/readme.md", "trips/demo/x.md", "TRIPS/demo/x.md",
                          ".project/other.json", "docs/.project/sprint.json", "docs/CLAUDE.md"):
                with self.subTest(existing=existing, path=value):
                    self.reset_trip(existing)
                    self.assertAllowed(self.patch(
                        "*** Begin Patch\n*** Add File: %s\n+x\n*** End Patch" % value,
                        agent_type="developer"))
                    self.assertAllowed(self.call("write", {"tool_input": {"file_path": value}}))

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


SEED = ("line1\n*** Update File: .project/sprint.json\nold\n*** Add File: ctx-add.txt\n"
        "*** Delete File: ctx-del.txt\n*** Move to: ctx-mv.txt\n*** End of File\n"
        "*** End Patch\n@@ ctx\nline9\n")
SEEDED = ("a.txt", "b.txt", "docs/readme.md", "ctx-del.txt", ".project/sprint.json")
# Key shapes from the round-2 differential corpus (3,256 patches, 0 disagreements;
# docs/test-reports/codex-hooks-2026-09-26.md). Each is run through Codex's own
# offline engine and compared with patch_paths().
DIFFERENTIAL = (
    "*** Update File: docs/readme.md\n@@\n *** Update File: .project/sprint.json\n-old\n+new",
    "*** Update File: docs/readme.md\n@@\n-old\n+new\n *** Add File: ctx-add.txt",
    "*** Update File: a.txt\n@@\n line9\n+t\n*** End of File\n*** Add File: evil.txt\n+x",
    "*** Update File: a.txt\n@@\n line9\n+t\n*** End of File \n*** Add File: evil.txt\n+x",
    "*** Update File: a.txt\n@@\n line9\n+t\n*** End of File\n  *** Add File: evil.txt\n+x",
    "*** Update File: a.txt\n@@\n-old\n+new\n\t*** Add File: evil.txt\n+x",
    "*** Update File: a.txt\n@@\n-old\n+new\n\n\n*** Add File: evil.txt\n+x",
    "*** Update File: a.txt\n@@\n-old\n+new\n*** Update File: b.txt\n*** Move to: .project/sprint.json\n@@\n-old\n+new",
    "*** Update File: a.txt\n  *** Move to: mv.txt\n@@\n-old\n+new",
    "*** Update File: a.txt\n*** Move to: mv.txt \n@@\n-old\n+new",
    "*** Update File: a.txt\n*** Move to:  mv.txt\n@@\n-old\n+new",
    "*** Add File: n.txt\n+x\n  *** Add File: evil.txt\n+y",
    "*** Add File: n.txt\n+x\n\u2028*** Add File: evil.txt\n+y",
    "*** Add File: n.txt\n+x\n\n*** Add File: evil.txt\n+y",
    "*** Delete File: b.txt\n\u3000*** Delete File: a.txt",
    "  *** Add File: docs/indented.md\n+hi",
    "*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n*** Add File: evil.txt\n+x",
    "*** Update File: a.txt\n@@\n-old\n+new\n+*** Add File: body.txt\n-*** Add File: ctx-add.txt",
)


def codex_engine():
    """The codex binary, if its offline apply_patch engine runs here; else None."""
    codex = shutil.which("codex")
    if not codex:
        return None
    scratch = tempfile.mkdtemp()
    try:
        if subprocess.run(["git", "rev-parse", "--git-dir"], cwd=scratch,
                          capture_output=True).returncode == 0:
            return None  # never let the engine write inside a repository
        result = subprocess.run(
            [codex, "--codex-run-as-apply-patch",
             "*** Begin Patch\n*** Add File: probe.txt\n+x\n*** End Patch"],
            cwd=scratch, capture_output=True, timeout=30)
        return codex if result.returncode == 0 and os.path.exists(
            os.path.join(scratch, "probe.txt")) else None
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


class DifferentialAgainstCodex(unittest.TestCase):
    """Whatever Codex's own engine writes, patch_paths() must name (or refuse).

    Optional: skipped where the codex CLI is absent (CI). No model is involved:
    `codex --codex-run-as-apply-patch` is the offline patch engine only.
    """

    @classmethod
    def setUpClass(cls):
        cls.codex = codex_engine()
        if not cls.codex:
            raise unittest.SkipTest("codex offline apply_patch engine not runnable here")
        spec = importlib.util.spec_from_file_location(
            "codex_adapter_differential", REPO / "scripts/claude-hooks/codex-adapter.py")
        cls.adapter = importlib.util.module_from_spec(spec)
        with patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(cls.adapter)

    def touched_by_codex(self, patch_text):
        scratch = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, scratch, True)

        def snapshot():
            found = {}
            for folder, _, files in os.walk(scratch):
                for name in files:
                    full = os.path.join(folder, name)
                    with open(full, "rb") as handle:
                        found[os.path.relpath(full, scratch)] = hashlib.sha1(handle.read()).hexdigest()
            return found

        for rel in SEEDED:
            os.makedirs(os.path.join(scratch, os.path.dirname(rel)), exist_ok=True)
            with open(os.path.join(scratch, rel), "w") as handle:
                handle.write(SEED)
        before = snapshot()
        subprocess.run([self.codex, "--codex-run-as-apply-patch", patch_text], cwd=scratch,
                       capture_output=True, timeout=60)
        after = snapshot()
        return {p for p in set(before) | set(after) if before.get(p) != after.get(p)}

    def test_every_path_codex_writes_is_checked(self):
        for body in DIFFERENTIAL:
            text = "*** Begin Patch\n" + body + "\n*** End Patch"
            with self.subTest(patch=body):
                touched = self.touched_by_codex(text)
                try:
                    listed = {os.path.normpath(p) for p in self.adapter.patch_paths(text)}
                except ValueError:
                    continue  # the adapter refuses the call outright
                self.assertLessEqual(touched, listed)

    def test_the_readme_repro_touches_only_readme(self):
        text = "*** Begin Patch\n" + DIFFERENTIAL[0] + "\n*** End Patch"
        self.assertEqual(self.touched_by_codex(text), {"docs/readme.md"})
        self.assertEqual(self.adapter.patch_paths(text), ["docs/readme.md"])
