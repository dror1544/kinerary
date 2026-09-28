"""The provisioner CLI's defaults.

Two of these flags decide whether a newly onboarded trip gets a companion
profile and an MCP bridge at all. Both used to default OFF, which is why a
"no bridge" row in bring-up.sh's status table was almost never an operator
forgetting — it was the default, and the pipeline that already knew how to
wire both was simply never asked to.

They now default ON, and that is a claim worth reading off the parser rather
than trusting a comment.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

from control_plane_worker.__main__ import build_parser


def _parse(argv: list[str], env: dict[str, str] | None = None):
    # Defaults are captured at parser-construction time from os.environ, so the
    # parser has to be built inside the patched environment, not before it.
    with mock.patch.dict(os.environ, env or {}, clear=False):
        return build_parser().parse_args(argv)


class ProvisionDefaultsTests(unittest.TestCase):
    def test_mcp_bridge_is_on_by_default(self) -> None:
        args = _parse(["provision"])
        self.assertTrue(args.enable_mcp_bridge)

    def test_mcp_bridge_can_be_turned_off_by_env(self) -> None:
        args = _parse(["provision"], {"PROVISIONER_MCP_BRIDGE_ENABLED": "0"})
        self.assertFalse(args.enable_mcp_bridge)

    def test_mcp_bridge_can_be_turned_off_by_flag(self) -> None:
        args = _parse(["provision", "--no-enable-mcp-bridge"])
        self.assertFalse(args.enable_mcp_bridge)

    def test_companion_profile_is_on_by_default(self) -> None:
        args = _parse(["provision"])
        self.assertFalse(args.no_companion_profile)

    def test_companion_profile_can_be_turned_off_by_env(self) -> None:
        args = _parse(["provision"], {"PROVISIONER_COMPANION_PROFILE_ENABLED": "0"})
        self.assertTrue(args.no_companion_profile)

    def test_an_explicit_templates_dir_still_wins(self) -> None:
        args = _parse(["provision", "--companion-templates-dir", "/somewhere/else"])
        self.assertEqual(args.companion_templates_dir, "/somewhere/else")


class BridgeProbeIntervalTests(unittest.TestCase):
    """Issue #119: the idle-loop bridge probe is ON by default (every 30
    minutes, so two consecutive failures are found within about an hour), and
    0 turns it off. Read off the parser, not a comment."""

    @staticmethod
    def _parse_env(value: str | None):
        """Parse `provision` with the variable unset (None) or set to value."""
        env = {k: v for k, v in os.environ.items() if k != "PROVISIONER_BRIDGE_PROBE_MINUTES"}
        if value is not None:
            env["PROVISIONER_BRIDGE_PROBE_MINUTES"] = value
        with mock.patch.dict(os.environ, env, clear=True):
            return build_parser().parse_args(["provision"])

    def test_on_by_default_every_thirty_minutes(self) -> None:
        self.assertEqual(self._parse_env(None).bridge_probe_minutes, 30)

    def test_an_empty_variable_means_the_default_not_a_crash(self) -> None:
        # compose passes `${PROVISIONER_BRIDGE_PROBE_MINUTES:-}`, i.e. "" when
        # vm.env does not set it. Refusing "" would crash-loop the worker and
        # stop provisioning; it means "not set", so it means 30.
        self.assertEqual(self._parse_env("").bridge_probe_minutes, 30)

    def test_the_environment_sets_it(self) -> None:
        self.assertEqual(self._parse_env("0").bridge_probe_minutes, 0)
        self.assertEqual(self._parse_env("45").bridge_probe_minutes, 45)

    def test_a_non_numeric_environment_value_is_still_refused(self) -> None:
        for bad in ("abc", "-5", " "):
            with self.subTest(value=bad), self.assertRaises(SystemExit), mock.patch("sys.stderr"):
                self._parse_env(bad)

    def test_the_worker_logs_with_the_format_the_probe_lines_are_tested_against(self) -> None:
        # The probe's log lines are asserted as rendered through LOG_FORMAT;
        # this pins that LOG_FORMAT is what the worker actually configures.
        from control_plane_worker.__main__ import LOG_FORMAT, _configure_logging
        with mock.patch("logging.basicConfig") as basic:
            _configure_logging()
        self.assertEqual(basic.call_args.kwargs["format"], LOG_FORMAT)

    def test_the_flag_sets_it(self) -> None:
        self.assertEqual(_parse(["provision", "--bridge-probe-minutes", "5"]).bridge_probe_minutes, 5)

    def test_the_probe_runs_only_on_an_idle_poll_and_a_failed_sweep_still_sleeps(self) -> None:
        """Only when run_once() found no job — the same thread, so a probe can
        never race a provision re-wiring the same trip's bridge."""
        from control_plane_worker.__main__ import poll_loop

        events: list[str] = []
        answers = iter([True, True, False, False])

        class Worker:
            def run_once(self) -> bool:
                found = next(answers)
                events.append("job" if found else "idle")
                return found

        class Sweep:
            def maybe_run(self, should_stop):
                events.append("probe")
                raise RuntimeError("database gone")

        clock = [0.0]

        def sleep(seconds: float) -> None:
            if events[-1] != "sleep":  # one entry per idle wait, however it is sliced
                events.append("sleep")
            clock[0] += seconds

        def stopping() -> bool:
            polls = sum(1 for e in events if e in ("job", "idle"))
            return polls >= 4 and events[-1] == "sleep" and clock[0] >= 2.0

        with mock.patch("builtins.print") as printed:
            poll_loop(Worker(), Sweep(), 1.0, stopping, sleep=sleep, monotonic=lambda: clock[0])
        self.assertEqual(events, ["job", "job", "idle", "probe", "sleep", "idle", "probe", "sleep"])
        self.assertIn("provisioner.bridge_probe_sweep_failed", str(printed.call_args_list))
        self.assertNotIn("database gone", str(printed.call_args_list), "driver text is never echoed")

    def test_a_negative_or_unreadable_interval_is_refused_not_guessed(self) -> None:
        for bad in (["provision", "--bridge-probe-minutes", "-1"],
                    ["provision", "--bridge-probe-minutes", "soon"]):
            with self.subTest(argv=bad), self.assertRaises(SystemExit), \
                    mock.patch("sys.stderr"):
                _parse(bad)


class TemplatesDirResolutionTests(unittest.TestCase):
    """The derivation that makes "on by default" need no new configuration.

    Mirrors the resolution in main(): unset templates dir + a repo root that
    actually contains the templates => use them; anything else => leave it
    unset and deploy the site alone, exactly as before.
    """

    @staticmethod
    def _resolve(templates_dir: str | None, repo_root: str | None, opt_out: bool) -> str | None:
        resolved = templates_dir
        if not resolved and repo_root:
            candidate = os.path.join(repo_root, "profile-templates", "familytrip-companion")
            if os.path.isdir(candidate):
                resolved = candidate
        if opt_out:
            resolved = None
        return resolved

    def test_derived_from_repo_root_when_the_templates_are_there(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            expected = os.path.join(repo, "profile-templates", "familytrip-companion")
            os.makedirs(expected)
            self.assertEqual(self._resolve(None, repo, opt_out=False), expected)

    def test_a_repo_root_without_templates_stays_unset(self) -> None:
        # Quiet rather than fatal: a job that cannot find templates must still
        # deploy a site, which is what it did before this defaulted on.
        with tempfile.TemporaryDirectory() as repo:
            self.assertIsNone(self._resolve(None, repo, opt_out=False))

    def test_no_repo_root_stays_unset(self) -> None:
        self.assertIsNone(self._resolve(None, None, opt_out=False))

    def test_opting_out_beats_a_present_templates_dir(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            os.makedirs(os.path.join(repo, "profile-templates", "familytrip-companion"))
            self.assertIsNone(self._resolve(None, repo, opt_out=True))

    def test_opting_out_beats_an_explicit_templates_dir(self) -> None:
        self.assertIsNone(self._resolve("/somewhere/else", None, opt_out=True))

    def test_the_repo_really_does_carry_the_templates_at_that_path(self) -> None:
        # Guards the derivation against the layout moving underneath it: the
        # path is constructed, so nothing else would notice a rename.
        # tests/ -> worker/ -> control-plane/ -> repo root
        here = os.path.abspath(__file__)
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(here))))
        self.assertTrue(
            os.path.isdir(os.path.join(repo_root, "profile-templates", "familytrip-companion")),
            "profile-templates/familytrip-companion moved; the default derivation needs updating",
        )


if __name__ == "__main__":
    unittest.main()
