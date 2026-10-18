"""Unit tests for the assistant_events Hermes plugin's pure logic.

This plugin loads only inside a real Hermes process, so these tests import
the module DIRECTLY from its file path (it has no `__init__.py`-package
parent to import through — it is a standalone plugin directory, not part of
this repo's own Python package) and exercise only what does not require one:
classification, the MCP-envelope unwrapper, config-gating and profile
resolution. The network call (`_post_batch`) is exercised only through
`on_post_tool_call`'s threading path, never actually sent (there is no
server here to send it to) — proving a batch is QUEUED for delivery, not that
delivery itself succeeds, matching this repo's house style of a focused,
stdlib-only unit test (control-plane/worker/tests/test_country_key.py) rather
than reaching for a mocking framework this plugin's own runtime may not have.

Run directly (no pytest required):
    python3 .agents/hermes-plugins/assistant-events/test_assistant_events_plugin.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List
from urllib import request as urllib_request

_MODULE_PATH = Path(__file__).resolve().parent / "__init__.py"


def _load_plugin():
    spec = importlib.util.spec_from_file_location("assistant_events_plugin", _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin()


class ClassificationTests(unittest.TestCase):
    """The heuristic is conservative: absence of an error is not enough, a
    positive signal of real content is required. See classify_tool_outcome's
    own docstring for the four rules this pins."""

    def test_unknown_tool_is_not_classified_at_all(self) -> None:
        self.assertIsNone(plugin.classify_tool_outcome("read_file", {"content": "hi"}))
        self.assertIsNone(plugin.classify_tool_outcome("web_search", {"results": ["a"]}))

    def test_a_real_populated_result_is_grounded(self) -> None:
        result = {
            "content": [{"type": "text", "text": '{"phases": [{"id": "p1", "name": "Tokyo"}]}'}],
        }
        self.assertEqual(plugin.classify_tool_outcome("get_phase_plan", result), "grounded_answer")

    def test_an_mcp_error_envelope_is_failed(self) -> None:
        result = {"isError": True, "content": [{"type": "text", "text": "Error: 500"}]}
        self.assertEqual(plugin.classify_tool_outcome("get_today", result), "failed_tool")

    def test_a_bare_error_field_is_failed(self) -> None:
        self.assertEqual(plugin.classify_tool_outcome("get_config", {"error": "not found"}), "failed_tool")
        # An empty error string is not a TRUTHY error (rule 1 does not fire),
        # and the dict's only value is itself empty, so rule 3 does instead:
        # missing_data, not failed_tool — there is no real error here, just
        # an empty result shaped like one.
        self.assertEqual(plugin.classify_tool_outcome("get_config", {"error": ""}), "missing_data")

    def test_a_dict_whose_every_value_is_empty_is_missing_data(self) -> None:
        # get_phase_plan with nothing planned yet.
        self.assertEqual(plugin.classify_tool_outcome("get_phase_plan", {"phases": []}), "missing_data")
        # get_today before the trip starts: a data-completeness fact, not a
        # software failure — #review 2026-10-03 split this from failed_tool.
        self.assertEqual(plugin.classify_tool_outcome("get_today", {"phase": None, "day": None}), "missing_data")

    def test_none_and_empty_results_are_missing_data(self) -> None:
        for empty in (None, "", [], {}, "   "):
            self.assertEqual(plugin.classify_tool_outcome("get_budget", empty), "missing_data", repr(empty))

    def test_the_mcp_text_envelope_is_unwrapped_before_judging_emptiness(self) -> None:
        wrapped_empty = {"content": [{"type": "text", "text": "[]"}]}
        self.assertEqual(plugin.classify_tool_outcome("get_bookings", wrapped_empty), "missing_data")
        wrapped_real = {"content": [{"type": "text", "text": '[{"id": "b1"}]'}]}
        self.assertEqual(plugin.classify_tool_outcome("get_bookings", wrapped_real), "grounded_answer")

    def test_a_non_json_text_envelope_falls_back_to_the_raw_text(self) -> None:
        # health_check-style tools can return a plain string; still "real content".
        result = {"content": [{"type": "text", "text": "ok"}]}
        self.assertEqual(plugin.classify_tool_outcome("health_check", result), "grounded_answer")

    def test_a_write_tool_confirming_its_change_is_grounded(self) -> None:
        result = {"content": [{"type": "text", "text": '{"id": "bk_1", "name": "Hotel"}'}]}
        self.assertEqual(plugin.classify_tool_outcome("add_booking", result), "grounded_answer")

    def test_known_tool_names_cover_both_mcp_servers(self) -> None:
        for name in ("get_config", "get_phase_plan", "publish_daily_message"):
            self.assertIn(name, plugin.KNOWN_TOOL_NAMES)
        for name in ("get_assistant_names", "set_assistant_names", "report_bug"):
            self.assertIn(name, plugin.KNOWN_TOOL_NAMES)


class ConfigGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k) for k in (
            "ASSISTANT_EVENTS_INGEST_URL", "ASSISTANT_EVENTS_INGEST_KEY", "ASSISTANT_EVENTS_HERMES_PROFILE",
        )}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_unconfigured_is_inert_and_sends_nothing(self) -> None:
        calls: List[Any] = []
        original = plugin._send_async
        plugin._send_async = lambda events: calls.append(events)  # type: ignore
        try:
            plugin.on_post_tool_call(tool_name="get_config", result={"meta": {"id": "x"}})
            self.assertEqual(calls, [], "no URL/key configured — nothing should be queued for delivery")
        finally:
            plugin._send_async = original  # type: ignore

    def test_configured_and_a_known_tool_queues_exactly_one_event(self) -> None:
        os.environ["ASSISTANT_EVENTS_INGEST_URL"] = "http://127.0.0.1:1/internal/assistant-events/tool-outcomes"
        os.environ["ASSISTANT_EVENTS_INGEST_KEY"] = "test-key"
        os.environ["ASSISTANT_EVENTS_HERMES_PROFILE"] = "test-profile"
        calls: List[List[Dict[str, Any]]] = []
        original = plugin._send_async
        plugin._send_async = lambda events: calls.append(events)  # type: ignore
        try:
            plugin.on_post_tool_call(tool_name="get_config", result={"meta": {"id": "x"}})
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(calls[0]), 1)
            event = calls[0][0]
            self.assertEqual(event["outcome"], "grounded_answer")
            self.assertRegex(event["event_id"], r"^[0-9a-f-]{36}$")
            self.assertEqual(event["tool_name"], "get_config", "the tool name DOES leave this hook — decision 22")
            self.assertNotIn("trip_id", event, "no trip id leaves this hook")
        finally:
            plugin._send_async = original  # type: ignore

    def test_configured_but_an_unknown_tool_queues_nothing(self) -> None:
        os.environ["ASSISTANT_EVENTS_INGEST_URL"] = "http://127.0.0.1:1/internal/assistant-events/tool-outcomes"
        os.environ["ASSISTANT_EVENTS_INGEST_KEY"] = "test-key"
        calls: List[Any] = []
        original = plugin._send_async
        plugin._send_async = lambda events: calls.append(events)  # type: ignore
        try:
            plugin.on_post_tool_call(tool_name="read_file", result={"content": "hi"})
            self.assertEqual(calls, [])
        finally:
            plugin._send_async = original  # type: ignore

    def test_a_hook_that_cannot_resolve_a_profile_drops_the_batch_rather_than_guessing(self) -> None:
        os.environ["ASSISTANT_EVENTS_INGEST_URL"] = "http://127.0.0.1:1/internal/assistant-events/tool-outcomes"
        os.environ["ASSISTANT_EVENTS_INGEST_KEY"] = "test-key"
        # No override and no real hermes_constants module importable here —
        # _resolve_profile_name should fail closed to "", and _send_async
        # should then drop rather than post with an empty profile.
        posted: List[Any] = []
        original_post = plugin._post_batch
        plugin._post_batch = lambda *a, **k: posted.append((a, k))  # type: ignore
        try:
            plugin._send_async([plugin._build_event("grounded_answer", "get_config")])
            self.assertEqual(posted, [], "an unresolvable profile must never be sent as an empty string")
        finally:
            plugin._post_batch = original_post  # type: ignore


class RegisterTests(unittest.TestCase):
    def test_register_wires_exactly_one_hook(self) -> None:
        registered: List[tuple] = []

        class FakeCtx:
            def register_hook(self, name, fn):
                registered.append((name, fn))

        plugin.register(FakeCtx())
        self.assertEqual([name for name, _ in registered], ["post_tool_call"])
        self.assertIs(registered[0][1], plugin.on_post_tool_call)


class NeverRaisesTests(unittest.TestCase):
    """Fail-open: a hook call must never raise into the caller, however
    malformed its inputs — Hermes's own tool-call loop has no handler that
    exists to catch this plugin's own bugs."""

    def test_garbage_inputs_never_raise(self) -> None:
        os.environ["ASSISTANT_EVENTS_INGEST_URL"] = "http://127.0.0.1:1/x"
        os.environ["ASSISTANT_EVENTS_INGEST_KEY"] = "k"
        try:
            for tool_name, result in [
                (None, None), (123, object()), ("get_config", object()),
                ("get_config", {"content": "not-a-list"}), ("get_config", {"content": [1, 2, 3]}),
            ]:
                with self.subTest(tool_name=tool_name):
                    plugin.on_post_tool_call(tool_name=tool_name, result=result)  # type: ignore
        finally:
            os.environ.pop("ASSISTANT_EVENTS_INGEST_URL", None)
            os.environ.pop("ASSISTANT_EVENTS_INGEST_KEY", None)


class DeliveryThreadTests(unittest.TestCase):
    """`_post_batch` itself touches the network; this only proves it runs on
    its own thread (never blocking the caller) and never raises out of that
    thread even when the URL is unreachable."""

    def test_post_batch_against_an_unreachable_url_does_not_raise(self) -> None:
        exceptions: List[BaseException] = []

        def run():
            try:
                plugin._post_batch("http://127.0.0.1:1/nope", "k", "profile-x", [plugin._build_event("failed_tool", "get_config")], 0.5)
            except BaseException as exc:  # pragma: no cover - the assertion is that this never happens
                exceptions.append(exc)

        thread = threading.Thread(target=run)
        thread.start()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive(), "the post must finish well inside its own timeout")
        self.assertEqual(exceptions, [])


if __name__ == "__main__":
    unittest.main()
