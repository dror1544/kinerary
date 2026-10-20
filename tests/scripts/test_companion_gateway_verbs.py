"""scripts/companion-install-host.sh — the gateway verbs (issue #349).

`companion_gateway_status`: which companion gateways are running on THIS host,
asked of names the control plane already knows, changing NOTHING.

The control plane cannot decide which companions run if it cannot see which do;
and what it sees is another process's command line, so the answer is a closed
grammar the worker parses by full match: one line per name asked plus a count
line that makes a truncated answer distinguishable from a short one. These run
the real script in a sandboxed HOME, with a stand-in `ps` printing a table the
test controls, and prove it validates before it looks, looks only with a fixed
argv, and cannot be made to print a verdict by what a process line says.
"""
from __future__ import annotations

import json
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "companion-install-host.sh"
PS_ARGV = "axww -o pid=,ppid=,args="


class GatewayVerbSandbox(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        # The script insists on a Hermes CLI before it reads a request; nothing
        # below may call it, and a test asserts nothing did.
        self.hermes_calls = self.home / "hermes.calls"
        self._exe(self.bin / "hermes", f'#!/bin/sh\necho "$*" >> "{self.hermes_calls}"\nexit 0\n')
        self.ps_table = self.home / "ps.table"
        self.ps_argv = self.home / "ps.argv"
        self.ps_table.write_text("")
        self._exe(self.bin / "ps", f'#!/bin/sh\necho "$*" >> "{self.ps_argv}"\ncat "{self.ps_table}"\n')
        for name in ("stopped-one", "running-one"):
            (self.home / ".hermes/profiles" / name).mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def _exe(path: Path, body: str) -> None:
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def send(self, request: dict) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin"}
        return subprocess.run(["bash", str(SCRIPT)], input=json.dumps(request), capture_output=True,
                              text=True, env=env, timeout=60)

    def procs(self, *rows: str) -> None:
        self.ps_table.write_text("\n".join(rows) + "\n")


class GatewayStatus(GatewayVerbSandbox):
    def status(self, *names, **over) -> dict:
        return {"record_type": "companion_gateway_status", "schema_version": 1, "profiles": list(names), **over}

    def lines(self, result) -> list[str]:
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def test_each_state_in_the_order_asked_and_a_closing_count(self) -> None:
        self.procs(
            "  101     1 /venv/bin/python -m hermes_cli.main --profile running-one gateway run --replace",
            "  102     1 /venv/bin/python -m hermes_cli.main --profile dup-one gateway run",
            "  103     1 hermes -p dup-one gateway run",
        )
        (self.home / ".hermes/profiles/dup-one").mkdir()
        result = self.send(self.status("stopped-one", "running-one", "dup-one", "never-heard-of"))
        self.assertEqual(self.lines(result), [
            "GATEWAY stopped-one stopped 0",
            "GATEWAY running-one running 1",
            "GATEWAY dup-one duplicate 2",
            "GATEWAY never-heard-of absent 0",
            "STATUS_END 4",
        ])

    def test_a_supervisor_wrapper_repeating_the_command_line_is_one_gateway_not_two(self) -> None:
        # launchd on the Mac runs a stderr-timestamp wrapper whose arguments
        # contain the whole gateway command; the child is a second match.
        self.procs(
            "  200     1 python -m hermes_cli.stderr_timestamp --error-log /x -- python -m hermes_cli.main "
            "--profile running-one gateway run --replace",
            "  201   200 python -m hermes_cli.main --profile running-one gateway run --replace",
        )
        self.assertEqual(self.lines(self.send(self.status("running-one"))),
                         ["GATEWAY running-one running 1", "STATUS_END 1"])

    def test_both_spellings_count_and_only_a_run_counts(self) -> None:
        self.procs(
            "  301     1 hermes -p running-one gateway run",
            "  302     1 hermes -p stopped-one gateway start",
            "  303     1 hermes -p stopped-one gateway status",
            "  304     1 hermes -p stopped-one gateway runner",
            "  305     1 vi notes-about--profile stopped-one gateway run",
        )
        self.assertEqual(self.lines(self.send(self.status("running-one", "stopped-one"))), [
            "GATEWAY running-one running 1", "GATEWAY stopped-one stopped 0", "STATUS_END 2"])

    def test_a_longer_profile_name_does_not_make_a_shorter_one_look_running(self) -> None:
        (self.home / ".hermes/profiles/italy").mkdir()
        self.procs("  401     1 hermes -p italy-2026 gateway run", "  402     1 hermes -p xitaly gateway run")
        self.assertEqual(self.lines(self.send(self.status("italy"))), ["GATEWAY italy stopped 0", "STATUS_END 1"])

    def test_a_running_gateway_for_a_profile_not_asked_about_is_not_reported(self) -> None:
        self.procs("  501     1 hermes -p somebody-elses gateway run")
        self.assertNotIn("somebody-elses", self.send(self.status("stopped-one")).stdout)

    def test_a_process_line_cannot_forge_a_verdict(self) -> None:
        self.procs(
            "  601     1 sh -c echo; GATEWAY running-one running 1",
            "GATEWAY running-one running 1",
            "STATUS_END 0",
        )
        self.assertEqual(self.lines(self.send(self.status("running-one"))),
                         ["GATEWAY running-one stopped 0", "STATUS_END 1"])

    def test_it_changes_nothing_and_runs_nothing_but_ps(self) -> None:
        self.procs("  701     1 hermes -p running-one gateway run")
        self.send(self.status("running-one", "stopped-one"))
        self.assertFalse(self.hermes_calls.exists(), "the Hermes CLI is not called: nothing is started or stopped")
        self.assertEqual(self.ps_argv.read_text().splitlines(), [PS_ARGV],
                         "ps is called once, with a fixed argv the request cannot influence")
        self.assertFalse((self.home / ".hermes/profiles/running-one/.env").exists())
        self.assertEqual(sorted(p.name for p in (self.home / ".hermes/profiles").iterdir()),
                         ["running-one", "stopped-one"])

    def test_nothing_in_the_request_but_the_names_is_read(self) -> None:
        self.procs("")
        result = self.send(self.status("stopped-one", slug="../../etc", port=4444, site_url="http://10.6.6.6/",
                                       action="start", command="rm -rf /"))
        self.assertEqual(self.lines(result), ["GATEWAY stopped-one stopped 0", "STATUS_END 1"])
        self.assertEqual(self.ps_argv.read_text().splitlines(), [PS_ARGV])
        self.assertFalse(self.hermes_calls.exists())

    def test_a_malformed_request_is_refused_before_anything_is_looked_at(self) -> None:
        bad = {
            "no list": {"profiles": "stopped-one"},
            "an object": {"profiles": {"name": "stopped-one"}},
            "empty": {"profiles": []},
            "missing": None,
            "too many": {"profiles": [f"p-{n:03d}" for n in range(201)]},
            "a duplicate": {"profiles": ["stopped-one", "stopped-one"]},
            "upper case": {"profiles": ["Stopped-one"]},
            "a path": {"profiles": ["../etc"]},
            "a leading dash": {"profiles": ["-x"]},
            "too short": {"profiles": ["a"]},
            "too long": {"profiles": ["a" * 64]},
            "a number": {"profiles": [12345]},
            "a space": {"profiles": ["a b"]},
            "a newline": {"profiles": ["ab\nGATEWAY x running 1"]},
            "one bad among good": {"profiles": ["stopped-one", "../x"]},
            "a null": {"profiles": [None]},
            "a nested list": {"profiles": [["stopped-one"]]},
        }
        for label, over in bad.items():
            with self.subTest(label):
                request = {"record_type": "companion_gateway_status", "schema_version": 1}
                if over:
                    request.update(over)
                result = self.send(request)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertNotIn("GATEWAY", result.stdout)
                self.assertNotIn("STATUS_END", result.stdout)
        self.assertFalse(self.ps_argv.exists(), "nothing is looked at for a refused request")

    def test_the_largest_allowed_request_is_answered_whole(self) -> None:
        names = [f"p-{n:03d}" for n in range(200)]
        out = self.lines(self.send(self.status(*names)))
        self.assertEqual(len(out), 201)
        self.assertEqual(out[-1], "STATUS_END 200")

    def test_a_near_miss_request_type_is_refused(self) -> None:
        for kind in ("companion_gateway_status ", "COMPANION_GATEWAY_STATUS", "companion_gateway_statuses",
                     "companion_gateway_statu"):
            with self.subTest(kind=kind):
                self.assertEqual(self.send(self.status("stopped-one", record_type=kind)).returncode, 2)
        self.assertFalse(self.ps_argv.exists())

    def test_a_ps_that_fails_is_an_error_not_an_empty_answer(self) -> None:
        # "Nothing is running" must never be the way a broken ps looks.
        self._exe(self.bin / "ps", "#!/bin/sh\nexit 1\n")
        result = self.send(self.status("stopped-one"))
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("GATEWAY", result.stdout)
        self.assertIn("could not list processes", result.stderr)

    def test_a_missing_ps_is_an_error_too(self) -> None:
        (self.bin / "ps").unlink()
        env = {"HOME": str(self.home), "PATH": str(self.bin)}
        result = subprocess.run(["/bin/bash", str(SCRIPT)], input=json.dumps(self.status("stopped-one")),
                                capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("GATEWAY", result.stdout)

    def test_the_other_request_kinds_still_demand_a_profile_object(self) -> None:
        # Adding a kind with no `profile` object must not have loosened the rest.
        for kind in ("trip_mcp_bridge_request", "trip_mcp_bridge_probe", "trip_assistant_profile_input"):
            with self.subTest(kind=kind):
                result = self.send({"record_type": kind, "slug": "x-y"})
                self.assertEqual(result.returncode, 2)
                self.assertIn("unsafe profile name", result.stderr)


if __name__ == "__main__":
    unittest.main()
