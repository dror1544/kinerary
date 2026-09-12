"""Unit tests for companion_profile.py's pure mapping logic and adapters.
No database needed — build_companion_handoff reads from transform_intake()'s
OUTPUT shape (a plain dict), not from the database or raw answers.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

import yaml
from types import SimpleNamespace
from unittest import mock
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


class SshCompanionProfileAdapterTests(unittest.TestCase):
    """The transport, and the properties that keep it a bridge rather than a
    foundation."""

    def _adapter(self, **kw):
        from control_plane_worker.companion_profile import SshCompanionProfileAdapter
        return SshCompanionProfileAdapter(
            host="host.example", user="deploy", key_path="/keys/companion", **kw
        )

    def test_it_passes_no_remote_command_at_all(self) -> None:
        # The single most important property. The key's forced command decides
        # what runs; if this argv ever grew a trailing command, a compromised
        # worker would have general host execution instead of one wrapper.
        captured = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            captured["input"] = kwargs.get("input")
            return SimpleNamespace(returncode=0, stdout="INSTALLED trip-japan-2026\n", stderr="")

        with mock.patch("control_plane_worker.companion_profile.subprocess.run", fake_run):
            self._adapter().install({"profile": {"name": "trip-japan-2026"}})

        argv = captured["argv"]
        self.assertEqual(argv[0], "ssh")
        self.assertEqual(argv[-1], "deploy@host.example",
                         "the destination must be the LAST argument — nothing after it to execute")

    def test_the_handoff_travels_on_stdin_not_in_the_command_line(self) -> None:
        # Content on argv would be visible in `ps` on the host and would invite
        # quoting bugs; the wrapper reads stdin precisely so it never has to
        # trust an argument.
        captured = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            captured["input"] = kwargs.get("input")
            return SimpleNamespace(returncode=0, stdout="INSTALLED trip-x\n", stderr="")

        handoff = {"profile": {"name": "trip-x"}, "organizer": {"display_name": "ניר"}}
        with mock.patch("control_plane_worker.companion_profile.subprocess.run", fake_run):
            self._adapter().install(handoff)

        self.assertIn("ניר", captured["input"])
        self.assertFalse(any("ניר" in part for part in captured["argv"]))

    def test_an_already_present_profile_is_a_success_not_a_failure(self) -> None:
        # A retried job after a partial success must not fail the run: the
        # profile from the earlier attempt is there and is correct.
        def fake_run(argv, **kwargs):
            return SimpleNamespace(returncode=0, stdout="ALREADY_PRESENT trip-y\n", stderr="")

        with mock.patch("control_plane_worker.companion_profile.subprocess.run", fake_run):
            self.assertEqual(self._adapter().install({"profile": {"name": "trip-y"}}), "trip-y")

    def test_a_failing_remote_raises_a_plain_error(self) -> None:
        # Nothing above the adapter should learn that SSH was involved — the
        # provisioner records COMPANION_INSTALL_FAILED either way, and under
        # K3s this same failure will arrive from an orchestrator.
        def fake_run(argv, **kwargs):
            return SimpleNamespace(returncode=255, stdout="", stderr="Permission denied (publickey).")

        with mock.patch("control_plane_worker.companion_profile.subprocess.run", fake_run):
            with self.assertRaises(RuntimeError):
                self._adapter().install({"profile": {"name": "trip-z"}})

    def test_unrecognized_output_is_refused_rather_than_guessed(self) -> None:
        for stdout in ("", "ok\n", "INSTALLED\n", "SOMETHING_ELSE trip-a\n"):
            def fake_run(argv, _stdout=stdout, **kwargs):
                return SimpleNamespace(returncode=0, stdout=_stdout, stderr="")
            with self.subTest(stdout=stdout):
                with mock.patch("control_plane_worker.companion_profile.subprocess.run", fake_run):
                    with self.assertRaises(RuntimeError):
                        self._adapter().install({"profile": {"name": "trip-a"}})

    def test_preflight_fails_at_startup_when_the_key_is_absent(self) -> None:
        with self.assertRaises(RuntimeError):
            self._adapter().preflight()

    def test_it_satisfies_the_same_contract_as_the_other_adapters(self) -> None:
        # The abstraction is the durable part. If this stops being substitutable
        # for RenderProfileAdapter / NullCompanionProfileAdapter, the K3s
        # implementation cannot simply replace it either.
        import inspect
        from control_plane_worker.companion_profile import (
            CompanionProfileAdapter, NullCompanionProfileAdapter, RenderProfileAdapter,
        )
        # `CompanionProfileAdapter` is a plain Protocol (not runtime_checkable),
        # so substitutability is checked structurally: same method, same
        # call shape.
        expected = inspect.signature(CompanionProfileAdapter.install)
        for cls in (NullCompanionProfileAdapter, RenderProfileAdapter, type(self._adapter())):
            with self.subTest(cls=cls.__name__):
                self.assertTrue(callable(getattr(cls, "install", None)))
                self.assertEqual(
                    list(inspect.signature(cls.install).parameters),
                    list(expected.parameters),
                    "adapters must stay interchangeable — the K3s implementation replaces this one",
                )


class CompanionOverlayTemplateTests(unittest.TestCase):
    """The rendered profile must not re-enable Hermes's own onboarding.

    Kept here rather than in the template directory because the trap is a YAML
    one and nothing else would catch it: `profile_build: off` is a YAML 1.1
    BOOLEAN, and the reader (agent/onboarding.py) accepts only the string —
    `isinstance(mode, str) and mode.lower() == "off"`. Unquoted, the setting
    parses cleanly, reads as False, falls back to the default "ask", and the
    family's first message is answered with an offer to build a user profile.
    That is what happened on 2026-09-12, and a config that looks right while
    doing nothing is exactly the failure a test is for.
    """

    OVERLAY = (
        Path(__file__).resolve().parents[3]
        / "profile-templates/familytrip-companion/templates/config.overlay.yaml.tpl"
    )

    def test_hermes_onboarding_is_off_as_a_string(self) -> None:
        overlay = yaml.safe_load(self.OVERLAY.read_text(encoding="utf-8"))
        onboarding = overlay["onboarding"]
        self.assertEqual(onboarding["profile_build"], "off")
        self.assertIsInstance(
            onboarding["profile_build"], str,
            "a bare `off` is the boolean False here, which the reader ignores",
        )
        # And the one-shot flag is spent before the profile ever speaks.
        self.assertIs(onboarding["seen"]["profile_build_offered"], True)

