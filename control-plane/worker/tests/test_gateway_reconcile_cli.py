"""#349: the control plane decides which companion gateways run. It ships in
OBSERVE — it records and reports and acts on nothing — and that default, the
refusal of an unreadable mode, and the loop wiring are read off the parser and
the loop, not off a comment."""
from __future__ import annotations

import os
import unittest
from unittest import mock

from control_plane_worker.__main__ import build_parser


class GatewayReconcileFlagsTests(unittest.TestCase):
    @staticmethod
    def _env(**kv: str):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GATEWAY_RECONCILE_")}
        env.update(kv)
        return mock.patch.dict(os.environ, env, clear=True)

    def test_observe_every_five_minutes_by_default(self) -> None:
        with self._env():
            args = build_parser().parse_args(["provision"])
        self.assertEqual((args.gateway_reconcile_mode, args.gateway_reconcile_minutes), ("observe", 5))

    def test_an_empty_variable_means_the_default_not_a_crash(self) -> None:
        # compose passes `${GATEWAY_RECONCILE_MODE:-}`, so unset arrives as "".
        with self._env(GATEWAY_RECONCILE_MODE="", GATEWAY_RECONCILE_MINUTES=""):
            args = build_parser().parse_args(["provision"])
        self.assertEqual((args.gateway_reconcile_mode, args.gateway_reconcile_minutes), ("observe", 5))

    def test_the_environment_and_the_flag_set_it(self) -> None:
        with self._env(GATEWAY_RECONCILE_MODE="enforce", GATEWAY_RECONCILE_MINUTES="2"):
            args = build_parser().parse_args(["provision"])
            self.assertEqual((args.gateway_reconcile_mode, args.gateway_reconcile_minutes), ("enforce", 2))
        with self._env():
            args = build_parser().parse_args(["provision", "--gateway-reconcile-mode", "off"])
        self.assertEqual(args.gateway_reconcile_mode, "off")

    def test_an_unreadable_mode_refuses_rather_than_becoming_observe_or_off(self) -> None:
        for bad in ("enforced", "ENFORCE!", "on", "1", "true"):
            with self.subTest(mode=bad), self._env(GATEWAY_RECONCILE_MODE=bad), \
                    self.assertRaises(SystemExit), mock.patch("sys.stderr"):
                build_parser().parse_args(["provision"])
        with self._env(), self.assertRaises(SystemExit), mock.patch("sys.stderr"):
            build_parser().parse_args(["provision", "--gateway-reconcile-minutes", "-3"])

    def test_the_cli_needs_exactly_one_of_once_dry_run_pin(self) -> None:
        with self._env():
            self.assertTrue(build_parser().parse_args(["reconcile-gateways", "--dry-run"]).dry_run)
            self.assertEqual(
                build_parser().parse_args(["reconcile-gateways", "--pin", "p-x", "off"]).pin, ["p-x", "off"])
            args = build_parser().parse_args(["reconcile-gateways", "--once"])
            self.assertEqual(args.mode, "observe", "a bare --once must not enforce")
            for argv in (["reconcile-gateways"], ["reconcile-gateways", "--once", "--dry-run"],
                         ["reconcile-gateways", "--once", "--pin", "p-x", "on"]):
                with self.subTest(argv=argv), self.assertRaises(SystemExit), mock.patch("sys.stderr"):
                    build_parser().parse_args(argv)

    def test_the_gateway_sweep_runs_on_an_idle_poll_after_the_probe_and_its_failure_is_its_own(self) -> None:
        from control_plane_worker.__main__ import poll_loop

        events: list[str] = []
        answers = iter([True, False, False])

        class Worker:
            def run_once(self) -> bool:
                found = next(answers)
                events.append("job" if found else "idle")
                return found

        class Probe:
            def maybe_run(self, should_stop):
                events.append("probe")

        class Gateways:
            def maybe_run(self, should_stop):
                events.append("gateways")
                raise RuntimeError("password=hunter2")

        clock = [0.0]

        def sleep(seconds: float) -> None:
            if events[-1] != "sleep":
                events.append("sleep")
            clock[0] += seconds

        def stopping() -> bool:
            polls = sum(1 for e in events if e in ("job", "idle"))
            return polls >= 3 and events[-1] == "sleep" and clock[0] >= 2.0

        with mock.patch("builtins.print") as printed:
            poll_loop(Worker(), Probe(), 1.0, stopping, sleep=sleep, monotonic=lambda: clock[0],
                      gateway_sweep=Gateways())
        self.assertEqual(events, ["job", "idle", "probe", "gateways", "sleep", "idle", "probe", "gateways", "sleep"])
        self.assertIn("provisioner.gateway_reconcile_failed", str(printed.call_args_list))
        self.assertNotIn("hunter2", str(printed.call_args_list), "driver text is never echoed")

    def test_without_a_gateway_sweep_the_loop_is_what_it_was(self) -> None:
        from control_plane_worker.__main__ import poll_loop

        events: list[str] = []

        class Worker:
            def run_once(self) -> bool:
                events.append("idle")
                return False

        class Probe:
            def maybe_run(self, should_stop):
                events.append("probe")

        n = [0]

        def stopping() -> bool:
            n[0] += 1
            return n[0] > 3

        poll_loop(Worker(), Probe(), 0.0, stopping, sleep=lambda s: None, monotonic=lambda: 0.0)
        self.assertEqual(set(events), {"idle", "probe"})
        self.assertEqual(events[:2], ["idle", "probe"])

    def test_the_gateway_adapter_needs_all_three_ssh_settings_and_not_provisioning(self) -> None:
        from control_plane_worker.__main__ import _gateway_adapter

        class A:
            companion_ssh_host, companion_ssh_user, companion_ssh_key = "h", "u", "/k"
            companion_ssh_known_hosts = None
            no_companion_profile = True      # provisioning off, as on the VM outside a test run

        self.assertIsNotNone(_gateway_adapter(A()),
                             "the VM keeps provisioning off and still needs its gateways decided")
        a = A()
        a.companion_ssh_key = None
        self.assertIsNone(_gateway_adapter(a))


if __name__ == "__main__":
    unittest.main()
