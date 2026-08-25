"""Unit tests for companion_profile.py's pure mapping logic and adapters.
No database needed — build_companion_handoff reads from transform_intake()'s
OUTPUT shape (a plain dict), not from the database or raw answers.
"""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from control_plane_worker.companion_profile import (
    NullCompanionProfileAdapter,
    RenderProfileAdapter,
    _slugify_profile_name,
    build_companion_handoff,
)

BASE_CONFIG_NO_AGENT: dict = {
    "meta": {"title": "Tokyo Family Trip", "defaultLang": "en"},
    "theme": {"palette": "blue", "font": "inter", "rtlDefault": False},
    "participants": [
        {"username": "noa", "name": "Noa", "name_en": "Noa"},
    ],
}

FULL_CONFIG: dict = {
    "meta": {"title": "Tokyo Family Trip", "defaultLang": "he"},
    "theme": {"palette": "blue", "font": "inter", "rtlDefault": False},
    "participants": [
        {
            "username": "noa",
            "name": "נועה",
            "name_en": "Noa",
            "needs": [
                {"type": "dietary", "severity": "firm", "text": {"he": "צמחונית", "en": "Vegetarian"}},
            ],
        },
        {"username": "eitan", "name": "איתן", "name_en": "Eitan"},
    ],
    "agent": {
        "organizers": ["noa"],
        "name": "טל",
        "name_en": "Tal",
        "gender": "neutral",
        "tone": "warm",
        "timezone": "Asia/Tokyo",
        "proactive": {"morning_briefing": "07:30"},
        "standing_instructions": [
            {"visibility": "organizer", "text": {"he": "קצב רגוע", "en": "Easygoing pace"}},
        ],
    },
}


class BuildCompanionHandoffTests(unittest.TestCase):
    def test_returns_none_without_an_agent_block(self) -> None:
        result = build_companion_handoff(
            trip_id="trip_abc", slug="tokyo-2026", config=BASE_CONFIG_NO_AGENT,
            intake_version_id="intk_abc", intake_schema_version=2,
            intake_digest="sha256:" + "a" * 64, confirmed_at="2026-01-01T00:00:00+00:00",
            canonical_site_url="https://tokyo-2026.example",
        )
        self.assertIsNone(result)

    def test_returns_none_when_organizer_does_not_resolve_to_a_participant(self) -> None:
        config = {**FULL_CONFIG, "agent": {**FULL_CONFIG["agent"], "organizers": []}}
        result = build_companion_handoff(
            trip_id="trip_abc", slug="tokyo-2026", config=config,
            intake_version_id="intk_abc", intake_schema_version=2,
            intake_digest="sha256:" + "a" * 64, confirmed_at="2026-01-01T00:00:00+00:00",
            canonical_site_url="https://tokyo-2026.example",
        )
        self.assertIsNone(result)

    def test_builds_a_valid_handoff_for_a_full_config(self) -> None:
        result = build_companion_handoff(
            trip_id="trip_abc", slug="tokyo-kyoto-2026", config=FULL_CONFIG,
            intake_version_id="intk_abc", intake_schema_version=2,
            intake_digest="sha256:" + "a" * 64, confirmed_at="2026-01-01T00:00:00+00:00",
            canonical_site_url="https://tokyo-2026.example",
        )
        self.assertIsNotNone(result)
        assert result is not None  # narrows for the type checker
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["record_type"], "trip_assistant_profile_input")
        self.assertRegex(result["profile"]["name"], r"^[a-z][a-z0-9]{2,31}$")
        self.assertEqual(result["trip"]["title"], "Tokyo Family Trip")
        self.assertEqual(result["trip"]["default_language"], "he")
        self.assertEqual(result["trip"]["canonical_site_url"], "https://tokyo-2026.example")
        self.assertEqual(result["assistant"]["name"], "טל")
        self.assertEqual(result["assistant"]["gender"], "neutral")
        self.assertEqual(result["organizer"]["person_ref"], "participant:noa")
        self.assertEqual(result["organizer"]["display_name"], "נועה")
        self.assertEqual(result["source"]["intake_version_ref"], "intk_abc")
        self.assertEqual(result["source"]["intake_digest"], "sha256:" + "a" * 64)

        needs = result["interview"]["participant_needs"]
        self.assertEqual(len(needs), 1)
        self.assertEqual(needs[0]["person_ref"], "participant:noa")
        self.assertEqual(needs[0]["type"], "dietary")
        self.assertEqual(needs[0]["severity"], "firm")
        # Organizer-only by default — matches transformer.py's _instruction()
        # policy, not a guess made in this module.
        self.assertEqual(needs[0]["visibility"], "organizer")
        self.assertEqual(needs[0]["status"], "confirmed")
        self.assertEqual(needs[0]["text"], {"he": "צמחונית", "en": "Vegetarian"})

    def test_never_emits_a_secret_shaped_key(self) -> None:
        # profile-templates' render_profile.py already scans for this, but a
        # unit test here catches a regression before it ever reaches that
        # subprocess boundary.
        result = build_companion_handoff(
            trip_id="trip_abc", slug="tokyo-2026", config=FULL_CONFIG,
            intake_version_id="intk_abc", intake_schema_version=2,
            intake_digest="sha256:" + "a" * 64, confirmed_at="2026-01-01T00:00:00+00:00",
            canonical_site_url="https://tokyo-2026.example",
        )
        blob = json.dumps(result)
        for forbidden in ("token", "password", "secret", "api_key", "bot_token", "confirmation_code"):
            self.assertNotIn(forbidden, blob.lower())


class SlugifyProfileNameTests(unittest.TestCase):
    def test_strips_hyphens_and_stays_in_bounds(self) -> None:
        self.assertRegex(_slugify_profile_name("tokyo-kyoto-2026"), r"^[a-z][a-z0-9]{2,31}$")

    def test_prefixes_when_the_slug_starts_with_a_digit(self) -> None:
        name = _slugify_profile_name("2026-tokyo")
        self.assertTrue(name[0].isalpha())


class NullCompanionProfileAdapterTests(unittest.TestCase):
    def test_install_always_returns_none(self) -> None:
        self.assertIsNone(NullCompanionProfileAdapter().install({"profile": {"name": "x"}}))


class RenderProfileAdapterTests(unittest.TestCase):
    def test_install_invokes_render_profile_and_returns_the_profile_name(self) -> None:
        adapter = RenderProfileAdapter(templates_dir="/fake/templates")
        with patch("control_plane_worker.companion_profile.subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0
            mock_run.return_value.stderr = ""
            mock_run.return_value.stdout = ""
            name = adapter.install({"profile": {"name": "tokyo2026"}})
        self.assertEqual(name, "tokyo2026")
        args = mock_run.call_args.args[0]
        self.assertIn("--install-profile", args)
        self.assertIn("tokyo2026", args)

    def test_install_raises_on_a_nonzero_exit(self) -> None:
        adapter = RenderProfileAdapter(templates_dir="/fake/templates")
        with patch("control_plane_worker.companion_profile.subprocess.run") as mock_run:
            mock_run.return_value.returncode = 2
            mock_run.return_value.stderr = "ERROR: refusing to overwrite existing profile"
            mock_run.return_value.stdout = ""
            with self.assertRaises(RuntimeError):
                adapter.install({"profile": {"name": "tokyo2026"}})


if __name__ == "__main__":
    unittest.main()
