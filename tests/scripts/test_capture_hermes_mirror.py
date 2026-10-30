"""scripts/capture-hermes-mirror.py - the relay's Hermes assumptions, read from Hermes SOURCE (#380).

The script parses a Hermes source tree with `ast` (it never imports or runs it)
and writes one JSON fixture. These tests build a SYNTHETIC mini tree that has
every anchor the script looks for, so they say nothing about real Hermes - that
is what `control-plane/api/test/hermes-mirror.test.ts` and
`scripts/capture-hermes-mirror.py --check` are for.

  AC-6  an anchor that is missing or ambiguous: exit non-zero, name it, write nothing
  AC-7  --check: exit 0 when the tree equals the fixture, 1 with a readable diff otherwise
  and: extraction is exact, parses without importing, refuses a patched file
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "capture-hermes-mirror.py"

BASE_PY = '''
_RETRYABLE_ERROR_PATTERNS = (
    "ConnectError", "network", "broken pipe")

class BasePlatformAdapter:
    @staticmethod
    def _is_retryable_error(error):
        lowered = (error or "").lower()
        return any(pat in lowered for pat in _RETRYABLE_ERROR_PATTERNS)

    @staticmethod
    def _is_timeout_error(error):
        lowered = (error or "").lower()
        return any(pat in lowered for pat in ("timed out", "readtimeout"))
'''

WS_PY = '''
import os  # a real import: the script must read this file, not run it
raise RuntimeError("this file must never be executed")
_OUTBOUND_TIMEOUT_S = 30.0

class Transport:
    async def _request_response(self, action, platform=None):
        frame = {"type": "outbound", "requestId": "r", "action": action}
        if platform:
            frame["platform"] = platform
            frame["botId"] = "b"
        return frame

    async def get_chat_info(self, chat_id):
        return await self._request_response({"op": "get_chat_info", "chat_id": chat_id})
'''

DESCRIPTOR_PY = '''
CONTRACT_VERSION = 1

class CapabilityDescriptor:
    contract_version: int
    platform: str
    supported_ops: tuple = ()
    LEGACY_OPS = ("send", "edit")
'''

ADAPTER_PY = '''
class RelayAdapter:
    def send(self, chat_id):
        return {"op": "send", "chat_id": chat_id}

    def typing(self, chat_id):
        return {"op": "typing", "chat_id": chat_id}

    async def card(self, chat_id):
        # task-card ops are built by one helper from its `op` argument
        return await self._card_frame(chat_id, "task_card", None, {})

    def _with_scope(self, chat_id, metadata):
        meta = dict(metadata or {})
        for key, cache in (("scope_id", {}), ("profile", {})):
            meta[key] = cache.get(chat_id)
        return meta
'''

LOCALE = '''approval:
  header: "not read"
gateway:
  exec_approval:
    header: "Hermes wants to run a command"
    smart_deny_heading: "Smart DENY"
    smart_deny_line: "Smart DENY: once"
    text_choice_once: "Reply `{prefix}approve` to run it once"
    text_choice_session: "`{prefix}approve session` for this session"
    text_choice_always: "`{prefix}approve always` permanently"
    text_choice_deny: "`{prefix}deny` to cancel"
    deadline: "If you don't answer within {window} it will NOT run."
    timed_out_notice: "Approval timed out after {window}"
  busy:
    steered_subagents_head: "Steered into current run and subagents"
    steered_head: "Steered into current run"
    redirected_head: "Redirected current run"
    subagent_working_head: "Subagent working"
    compressing_head: "Compressing context"
    queued_head: "Queued for the next turn"
    interrupting_head: "Interrupting current task"
  set_home:
    success: "Home channel set to **{name}**"
  notify:
    # a comment, and a block scalar that must be skipped, not misread as keys
    note: |
      busy_looking: "text"
    no_home_channel: "No home channel for {platform}. Type {sethome_cmd}"
'''

FALLBACK_PY = '''
def try_activate_fallback(agent, reason=None):
    notice = (
        f"Model fallback: {agent.old} unavailable "
        f"({reason}); using {agent.new}.")
    if reason:
        notice += " Primary retry eligible."
    return notice
'''

AUTORAISE_PY = '''
def _build_codex_gpt5_autoraise_notice(autoraise, context_length=None):
    return (
        f"Codex {autoraise} caps context, so auto-compaction was raised "
        f"to {context_length}%\\n"
        f"  Opt back out: hermes config set compression.codex_gpt55_autoraise false"
    )
'''

PROMPT_PY = '''
def _truncate_content(content, filename, queue_warning=True):
    remedy = (
        "trim the file" if queue_warning
        else f"read_file: {filename}"
    )
    msg = f"Context file {filename} TRUNCATED: {len(content)} chars - {remedy}"
    return msg
'''

CONFIG_PY = '''
DEFAULT_CONFIG = {
    "context_file_max_chars": None,
    "display": {"interim_assistant_messages": True, "suppress_warning_notifications": False},
    "compression": {"codex_gpt55_autoraise_notice": True},
    "auxiliary": {"background_review": {"x": 1, **{"y": 2}}},
}
'''

MCP_PY = '''
import logging
logger = logging.getLogger(__name__)

def discover(name, transport, tools):
    logger.info("MCP server '%s' (%s): registered %d tool(s): %s", name, transport, len(tools), tools)
    logger.info("MCP server '%s' (lazy): registered %d tool(s) from schema cache", name, len(tools))
'''

EXECUTOR_PY = '''
import logging
logger = logging.getLogger(__name__)

def run(name, took, n):
    logger.info("tool %s completed (%.2fs, %d chars)", name, took, n)

def run_concurrent(ref, took, n):
    logger.info(
        "tool %s completed (%.2fs, %d chars)", ref.name, took, n
    )
'''

FILES = {
    "gateway/platforms/base.py": BASE_PY,
    "gateway/relay/ws_transport.py": WS_PY,
    "gateway/relay/descriptor.py": DESCRIPTOR_PY,
    "gateway/relay/adapter.py": ADAPTER_PY,
    "locales/en.yaml": LOCALE,
    "agent/chat_completion_helpers.py": FALLBACK_PY,
    "agent/agent_init.py": AUTORAISE_PY,
    "agent/prompt_builder.py": PROMPT_PY,
    "hermes_cli/config_defaults.py": CONFIG_PY,
    "tools/mcp_tool_discovery.py": MCP_PY,
    "agent/tool_executor.py": EXECUTOR_PY,
}


def make_tree(root: Path, **overrides: str) -> Path:
    for rel, text in {**FILES, **overrides}.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def run(*args: str) -> subprocess.CompletedProcess:
    # -I: the script's own isolation flag, the way a caller runs it.
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True, timeout=60)


class CaptureHermesMirror(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="capture-hermes-mirror-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.tree = make_tree(self.tmp / "hermes")
        self.out = self.tmp / "out" / "fixture.json"

    def capture(self, tree: Path | None = None) -> subprocess.CompletedProcess:
        return run("--source", str(tree or self.tree), "--revision", "abc1234567",
                   "--captured", "2026-10-30", "--out", str(self.out))

    def check(self, tree: Path | None = None) -> subprocess.CompletedProcess:
        return run("--source", str(tree or self.tree), "--revision", "abc1234567", "--check", str(self.out))

    def fixture(self) -> dict:
        return json.loads(self.out.read_text(encoding="utf-8"))

    # ------------------------------------------------------------ extraction --
    def test_extraction_is_exact_and_never_executes_the_source(self):
        """ws_transport.py in the mini tree raises on execution; reading it by ast is the point."""
        proc = self.capture()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        f = self.fixture()
        self.assertEqual(f["revision"], "abc1234567")
        self.assertEqual(f["captured"], "2026-10-30")
        self.assertEqual(f["error_classifier"], {
            "timeout_substrings": ["timed out", "readtimeout"],
            "retryable_substrings": ["connecterror", "network", "broken pipe"],  # lower-cased as Hermes compares
        })
        self.assertEqual(f["outbound_timeout_seconds"], 30.0)
        self.assertEqual(f["relay_contract"], {
            "contract_version": 1,
            "descriptor_fields": ["contract_version", "platform", "supported_ops"],
            "legacy_ops": ["send", "edit"],
            "ops": ["get_chat_info", "send", "task_card", "typing"],
            "outbound_frame_fields": ["action", "botId", "platform", "requestId", "type"],
            "outbound_metadata_fields": ["profile", "scope_id"],
        })
        self.assertEqual(f["approval_prompt_strings"]["gateway.exec_approval.text_choice_once"],
                         "reply `{prefix}approve` to run it once")
        self.assertEqual(f["approval_prompt_strings"]["gateway.exec_approval.deadline"],
                         "if you don't answer within {window} it will not run.")
        status = f["status_strings"]
        self.assertEqual(status["gateway.busy.redirected_head"], "redirected current run")
        self.assertEqual(status["gateway.set_home.success"], "home channel set to **{name}**")
        self.assertEqual(
            status["agent/chat_completion_helpers.py:try_activate_fallback:notice"],
            "model fallback: {} unavailable ({}); using {}. primary retry eligible.")
        self.assertEqual(
            status["agent/agent_init.py:_build_codex_gpt5_autoraise_notice:return"],
            "codex {} caps context, so auto-compaction was raised to {}%\n"
            "  opt back out: hermes config set compression.codex_gpt55_autoraise false")
        self.assertEqual(status["agent/prompt_builder.py:_truncate_content:msg"],
                         "context file {} truncated: {} chars - {}")
        self.assertEqual(status["agent/prompt_builder.py:_truncate_content:remedy#0"], "trim the file")
        self.assertEqual(status["agent/prompt_builder.py:_truncate_content:remedy#1"], "read_file: {}")
        self.assertEqual(f["log_formats"], {
            "mcp_registered": "MCP server '%s' (%s): registered %d tool(s): %s",
            "tool_completed": "tool %s completed (%.2fs, %d chars)",  # two call sites, one format
        })
        self.assertEqual(f["config_keys"], [
            "auxiliary", "auxiliary.background_review", "auxiliary.background_review.x",
            "compression", "compression.codex_gpt55_autoraise_notice", "context_file_max_chars",
            "display", "display.interim_assistant_messages", "display.suppress_warning_notifications"])
        self.assertEqual(f["config_key_spreads"], ["auxiliary.background_review"],
                         "a `**` spread hides keys; it is recorded, not ignored")
        self.assertEqual(sorted(f["source_files"]), sorted(FILES))
        for digest in f["source_files"].values():
            self.assertRegex(digest, r"^[0-9a-f]{64}$")

    def test_the_same_tree_captures_the_same_bytes(self):
        self.capture()
        first = self.out.read_text(encoding="utf-8")
        self.capture()
        self.assertEqual(self.out.read_text(encoding="utf-8"), first)

    # ----------------------------------------------------- AC-6: anchor drift --
    def assert_drift(self, proc: subprocess.CompletedProcess, *names: str) -> None:
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        for name in names:
            self.assertIn(name, proc.stderr, f"the failure must name the anchor {name!r}")
        self.assertFalse(self.out.exists(), "a missing anchor is drift: no fixture may be written")

    def test_ac6_a_renamed_symbol_names_the_anchor_and_writes_nothing(self):
        renamed = BASE_PY.replace("_RETRYABLE_ERROR_PATTERNS", "_RETRYABLE_PATTERNS")
        proc = self.capture(make_tree(self.tmp / "renamed", **{"gateway/platforms/base.py": renamed}))
        self.assert_drift(proc, "_RETRYABLE_ERROR_PATTERNS", "gateway/platforms/base.py")

    def test_ac6_a_missing_function_is_drift_not_an_empty_list(self):
        gone = BASE_PY.replace("_is_timeout_error", "_is_timeout")
        self.assert_drift(self.capture(make_tree(self.tmp / "gone", **{"gateway/platforms/base.py": gone})),
                          "_is_timeout_error")

    def test_ac6_a_missing_catalog_key_names_the_key(self):
        proc = self.capture(make_tree(self.tmp / "key", **{"locales/en.yaml": LOCALE.replace("redirected_head", "redirected")}))
        self.assert_drift(proc, "gateway.busy.redirected_head", "locales/en.yaml")

    def test_ac6_a_missing_file_names_the_file(self):
        tree = make_tree(self.tmp / "nofile")
        (tree / "gateway/relay/descriptor.py").unlink()
        self.assert_drift(self.capture(tree), "gateway/relay/descriptor.py")

    def test_ac6_an_ambiguous_anchor_is_drift_too(self):
        twice = BASE_PY + "\n_RETRYABLE_ERROR_PATTERNS = ('other',)\n"
        self.assert_drift(self.capture(make_tree(self.tmp / "twice", **{"gateway/platforms/base.py": twice})),
                          "_RETRYABLE_ERROR_PATTERNS", "ambiguous")

    def test_ac6_two_different_log_formats_are_ambiguous(self):
        other = EXECUTOR_PY + '\ndef again(n):\n    logger.info("tool %s completed (%d)", n, 1)\n'
        self.assert_drift(self.capture(make_tree(self.tmp / "logs", **{"agent/tool_executor.py": other})),
                          "tool_completed", "ambiguous")

    def test_ac6_a_log_format_that_vanished_is_drift(self):
        quiet = EXECUTOR_PY.replace("completed", "finished")
        self.assert_drift(self.capture(make_tree(self.tmp / "quiet", **{"agent/tool_executor.py": quiet})),
                          "tool_completed")

    def test_ac6_a_status_variable_that_is_no_longer_assigned_is_drift(self):
        moved = PROMPT_PY.replace("msg =", "message =")
        self.assert_drift(self.capture(make_tree(self.tmp / "moved", **{"agent/prompt_builder.py": moved})),
                          "_truncate_content", "msg")

    def test_ac6_an_existing_fixture_survives_a_failed_capture(self):
        self.assertEqual(self.capture().returncode, 0)
        before = self.out.read_text(encoding="utf-8")
        broken = make_tree(self.tmp / "broken", **{"gateway/relay/ws_transport.py": WS_PY.replace("_OUTBOUND_TIMEOUT_S", "_T")})
        self.assertEqual(self.capture(broken).returncode, 2)
        self.assertEqual(self.out.read_text(encoding="utf-8"), before)

    # ------------------------------------------------------- AC-7: --check --
    def test_ac7_check_passes_when_the_tree_equals_the_fixture(self):
        self.capture()
        proc = self.check()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_ac7_check_ignores_the_capture_date(self):
        self.capture()
        f = self.fixture()
        f["captured"] = "2020-01-01"
        self.out.write_text(json.dumps(f), encoding="utf-8")
        self.assertEqual(self.check().returncode, 0)

    def test_ac7_an_edited_pattern_is_a_readable_diff(self):
        self.capture()
        edited = make_tree(self.tmp / "edited", **{
            "gateway/platforms/base.py": BASE_PY.replace('"network"', '"network", "ssl error"')})
        proc = self.check(edited)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn('+      "ssl error",', proc.stdout)
        self.assertIn("recapture", proc.stderr)

    def test_ac7_a_reworded_status_line_is_a_diff_naming_its_key(self):
        self.capture()
        edited = make_tree(self.tmp / "reworded", **{
            "locales/en.yaml": LOCALE.replace("Redirected current run", "Message redirected")})
        proc = self.check(edited)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("-    \"gateway.busy.redirected_head\": \"redirected current run\"", proc.stdout)
        self.assertIn("+    \"gateway.busy.redirected_head\": \"message redirected\"", proc.stdout)

    def test_ac7_an_edited_source_file_with_the_same_extraction_still_differs_by_hash(self):
        """The hashes pin the files read: a change the anchors do not see is still a change."""
        self.capture()
        padded = make_tree(self.tmp / "padded", **{"gateway/platforms/base.py": BASE_PY + "\n# a comment\n"})
        proc = self.check(padded)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("gateway/platforms/base.py", proc.stdout)

    def test_ac7_check_of_a_different_revision_differs(self):
        self.capture()
        proc = run("--source", str(self.tree), "--revision", "def7654321", "--check", str(self.out))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("def7654321", proc.stdout)

    def test_ac7_check_drift_is_still_exit_2_not_1(self):
        self.capture()
        broken = make_tree(self.tmp / "broken", **{"gateway/platforms/base.py": BASE_PY.replace("_is_timeout_error", "x")})
        self.assertEqual(self.check(broken).returncode, 2)

    # ------------------------------------------------------------- usage --
    def test_a_tree_that_is_not_a_checkout_needs_an_explicit_revision(self):
        proc = run("--source", str(self.tree), "--out", str(self.out))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("--revision", proc.stderr)
        self.assertFalse(self.out.exists())

    def test_a_patched_file_in_a_git_checkout_is_refused_unless_allowed(self):
        """A fixture of patched bytes would claim to describe the revision it does not."""
        subprocess.run(["git", "init", "-q"], cwd=self.tree, check=True)
        subprocess.run(["git", "add", "-A"], cwd=self.tree, check=True)
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], cwd=self.tree, check=True)
        clean = run("--source", str(self.tree), "--out", str(self.out))
        self.assertEqual(clean.returncode, 0, clean.stderr)
        self.assertEqual(self.fixture()["revision"], subprocess.run(
            ["git", "rev-parse", "--short=10", "HEAD"], cwd=self.tree, capture_output=True, text=True).stdout.strip())
        (self.tree / "gateway/platforms/base.py").write_text(BASE_PY + "\n# local patch\n")
        dirty = run("--source", str(self.tree), "--out", str(self.tmp / "dirty.json"))
        self.assertEqual(dirty.returncode, 2)
        self.assertIn("gateway/platforms/base.py", dirty.stderr)
        self.assertFalse((self.tmp / "dirty.json").exists())
        allowed = run("--source", str(self.tree), "--allow-dirty", "--out", str(self.tmp / "dirty.json"))
        self.assertEqual(allowed.returncode, 0, allowed.stderr)


if __name__ == "__main__":
    unittest.main()
