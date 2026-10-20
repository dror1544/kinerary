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
import os
import re
import shutil
import stat
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "companion-install-host.sh"
PS_ARGV = "axww -o pid=,ppid=,uid=,args="


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
        """`pid ppid args` rows, as this account's processes (the table `ps -o
        pid=,ppid=,uid=,args=` prints has a uid column; a row already written
        in the full form is left alone)."""
        out = []
        for row in rows:
            match = re.match(r"^\s*(\d+)\s+(\d+)\s+(.*)$", row)
            out.append(f"{match.group(1)} {match.group(2)} {os.getuid()} {match.group(3)}" if match else row)
        self.ps_table.write_text("\n".join(out) + "\n")

    def procs_full(self, *rows: str) -> None:
        self.ps_table.write_text("\n".join(rows) + "\n")


class RequestBounds(GatewayVerbSandbox):
    def test_a_request_over_64_kib_is_refused_for_every_kind(self) -> None:
        pad = "x" * 70000
        for request in ({"record_type": "companion_gateway_status", "schema_version": 1, "profiles": ["stopped-one"],
                         "pad": pad},
                        {"record_type": "companion_gateway_backfill", "schema_version": 1, "profiles": ["stopped-one"],
                         "pad": pad},
                        {"record_type": "companion_gateway_action", "schema_version": 1, "action": "start",
                         "profile": {"name": "stopped-one"}, "pad": pad},
                        {"record_type": "trip_mcp_bridge_probe", "schema_version": 1, "slug": "x-y",
                         "profile": {"name": "stopped-one"}, "pad": pad},
                        {"profile": {"name": "stopped-one"}, "pad": pad}):
            with self.subTest(kind=request.get("record_type", "install")):
                result = self.send(request)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn("larger than 64 KiB", result.stderr)
                self.assertEqual(result.stdout, "")
        self.assertFalse(self.ps_argv.exists())

    def test_a_request_at_the_limit_is_still_read(self) -> None:
        base = {"record_type": "companion_gateway_status", "schema_version": 1, "profiles": ["stopped-one"], "pad": ""}
        base["pad"] = "x" * (65536 - len(json.dumps(base)))
        self.assertEqual(len(json.dumps(base)), 65536)
        result = self.send(base)
        self.assertEqual(result.stdout.splitlines()[0], "GATEWAY stopped-one stopped 0")

    def test_a_slug_is_a_string_or_absent_and_nothing_else(self) -> None:
        for slug in (0, False, [], {}, 1, ["italy-2026"], {"a": 1}, True):
            for kind in ("companion_gateway_action", "trip_mcp_bridge_probe", "trip_mcp_bridge_request"):
                with self.subTest(slug=slug, kind=kind):
                    request = {"record_type": kind, "schema_version": 1, "slug": slug, "profile": {"name": "stopped-one"}}
                    if kind == "companion_gateway_action":
                        request["action"] = "start"
                    result = self.send(request)
                    self.assertEqual(result.returncode, 2, result.stdout)
                    self.assertIn("unsafe trip slug", result.stderr)


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

    def test_a_decoy_cannot_fake_a_gateway(self) -> None:
        """Argument text alone is what a decoy supplies for free. A process counts
        only if it is this account's and it is a Hermes process."""
        me = os.getuid()
        other = me + 1 if me != 0 else 1
        self.procs_full(
            f"  801     1 {other} hermes -p running-one gateway run",                    # another user's
            f"  802     1 {me} sleep 600 -p running-one gateway run",                    # not Hermes
            f"  803     1 {me} /bin/sh -c echo -p running-one gateway run",             # not Hermes
            f"  804     1 {me} python3 -c print(1) -p running-one gateway run",         # python, no hermes module
            f"  805     1 {me} vi -p running-one gateway run",
            f"  806     1 {me} tail -f /var/log/hermes.log -p running-one gateway run",  # names hermes only as an argument
        )
        self.assertEqual(self.lines(self.send(self.status("running-one"))),
                         ["GATEWAY running-one stopped 0", "STATUS_END 1"])
        # and the genuine shapes still count
        self.procs_full(f"  811     1 {me} /opt/hermes/venv/bin/python -m hermes_cli.main -p running-one gateway run",
                        f"  812     1 {me} /usr/local/bin/hermes -p stopped-one gateway run")
        self.assertEqual(self.lines(self.send(self.status("running-one", "stopped-one"))),
                         ["GATEWAY running-one running 1", "GATEWAY stopped-one running 1", "STATUS_END 2"])

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


TOPOLOGY = """\
version: 1
name: italy-2026
proxmox:
  node: proxmox
  vmid: '104'
  lxc:
    name: trip-italy-2026
    ipv4: 192.168.0.61/24
npm:
  hostname: italy-2026.example.test
  forward_host: 192.168.0.61
  forward_port: 8080
"""

#: A stand-in `hermes` that does what the s6 wrapper does to a process table:
#: `gateway start` adds a gateway line, `gateway stop` removes it. Every call is
#: recorded. `hermes.mode` = "noop" makes both do nothing (a start that fails).
FAKE_HERMES = """#!/usr/bin/env python3
import os, sys
home = os.environ["HOME"]
with open(os.path.join(home, "hermes.calls"), "a") as log:
    log.write(" ".join(sys.argv[1:]) + "\\n")
mode_file = os.path.join(home, "hermes.mode")
if os.path.exists(mode_file) and open(mode_file).read().strip() == "noop":
    sys.exit(0)
args = sys.argv[1:]
table = os.path.join(home, "ps.table")
if args[:2] == ["profile", "create"]:
    os.makedirs(os.path.join(home, ".hermes/profiles", args[2]), exist_ok=True)
elif len(args) >= 4 and args[0] == "-p" and args[2:4] == ["gateway", "start"]:
    with open(table, "a") as t:
        t.write("  900     1 %d hermes -p %s gateway run\\n" % (os.getuid(), args[1]))
elif len(args) >= 4 and args[0] == "-p" and args[2:4] == ["gateway", "stop"]:
    keep = [l for l in open(table).read().splitlines() if "-p %s gateway run" % args[1] not in l]
    open(table, "w").write("\\n".join(keep) + ("\\n" if keep else ""))
"""


class GatewayActionSandbox(GatewayVerbSandbox):
    """The sandbox plus a Linux host: a `uname` that says so, a `hermes` that edits
    the process table, a profile that carries the provenance marker."""

    def setUp(self) -> None:
        super().setUp()
        (self.bin / "hermes").unlink()
        self._exe(self.bin / "hermes", FAKE_HERMES)
        self._exe(self.bin / "uname", '#!/bin/sh\necho "${FAKE_UNAME:-Linux}"\n')
        self.hermes_calls = self.home / "hermes.calls"
        for name in ("trip-intake", "default", "trip-monitor", "kinerary-extract", "italy2026", "no-marker"):
            (self.home / ".hermes/profiles" / name).mkdir(parents=True, exist_ok=True)
            if name != "no-marker":
                (self.home / ".hermes/profiles" / name / "kinerary-managed").write_text("kinerary-managed\n")
        (self.home / ".hermes/profiles/stopped-one/kinerary-managed").write_text("kinerary-managed\n")
        # the venv python the script uses to read a topology
        venv = self.home / ".hermes/hermes-agent/venv/bin"
        venv.mkdir(parents=True)
        (venv / "python3").symlink_to(sys.executable)
        (venv / "python").symlink_to(sys.executable)

    def action(self, name: str, verb: str, **over) -> dict:
        return {"record_type": "companion_gateway_action", "schema_version": 1, "action": verb,
                "profile": {"name": name}, **over}

    def run_action(self, request: dict, *, uname: str = "Linux", wait: int = 3) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_UNAME": uname,
               "KINERARY_GATEWAY_WAIT_SECONDS": str(wait)}
        return subprocess.run(["bash", str(SCRIPT)], input=json.dumps(request), capture_output=True,
                              text=True, env=env, timeout=120)

    def calls(self) -> list[str]:
        return self.hermes_calls.read_text().splitlines() if self.hermes_calls.exists() else []

    def assertVerdict(self, result, name: str, verb: str, outcome: str) -> None:  # noqa: N802
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, f"ACTION {name} {verb} {outcome}\n", f"stdout {result.stdout!r} / {result.stderr!r}")


class GatewayAction(GatewayActionSandbox):
    def test_a_start_starts_exactly_once_and_reports_ok(self) -> None:
        result = self.run_action(self.action("italy2026", "start"))
        self.assertVerdict(result, "italy2026", "start", "ok")
        self.assertEqual(self.calls(), ["-p italy2026 gateway start"], "no stop first: it never restarts")

    def test_a_stop_stops_exactly_once_and_reports_ok(self) -> None:
        self.procs("  700     1 hermes -p italy2026 gateway run")
        result = self.run_action(self.action("italy2026", "stop"))
        self.assertVerdict(result, "italy2026", "stop", "ok")
        self.assertEqual(self.calls(), ["-p italy2026 gateway stop"])

    def test_a_start_of_a_running_gateway_and_a_stop_of_a_stopped_one_touch_nothing(self) -> None:
        self.procs("  700     1 hermes -p italy2026 gateway run")
        self.assertVerdict(self.run_action(self.action("italy2026", "start")), "italy2026", "start", "ok")
        self.procs("")
        self.assertVerdict(self.run_action(self.action("italy2026", "stop")), "italy2026", "stop", "ok")
        self.assertEqual(self.calls(), [], "ok without acting: idempotent, and never a restart")

    def test_a_start_that_does_nothing_is_failed_not_ok(self) -> None:
        (self.home / "hermes.mode").write_text("noop")
        result = self.run_action(self.action("italy2026", "start"), wait=2)
        self.assertVerdict(result, "italy2026", "start", "failed")
        self.assertIn("no gateway appeared", result.stderr)

    def test_a_stop_that_leaves_it_running_is_failed_not_ok(self) -> None:
        self.procs("  700     1 hermes -p italy2026 gateway run")
        (self.home / "hermes.mode").write_text("noop")
        self.assertVerdict(self.run_action(self.action("italy2026", "stop"), wait=2), "italy2026", "stop", "failed")

    def test_the_deny_list_is_never_touched_even_with_a_marker(self) -> None:
        for name in ("default", "trip-monitor", "kinerary-extract"):
            for verb in ("start", "stop"):
                with self.subTest(name=name, verb=verb):
                    self.assertVerdict(self.run_action(self.action(name, verb)), name, verb, "refused")
        self.assertEqual(self.calls(), [])

    def test_the_interviewer_is_never_stopped_but_can_be_started(self) -> None:
        self.assertVerdict(self.run_action(self.action("trip-intake", "stop")), "trip-intake", "stop", "refused")
        self.assertEqual(self.calls(), [])
        self.assertVerdict(self.run_action(self.action("trip-intake", "start")), "trip-intake", "start", "ok")

    def test_a_profile_without_the_provenance_marker_is_never_touched(self) -> None:
        for verb in ("start", "stop"):
            result = self.run_action(self.action("no-marker", verb))
            self.assertVerdict(result, "no-marker", verb, "refused")
            self.assertIn("provenance marker", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_symlinked_profile_directory_is_not_a_profile(self) -> None:
        real = self.home / "elsewhere"
        real.mkdir()
        (real / "kinerary-managed").write_text("kinerary-managed\n")
        (self.home / ".hermes/profiles/linked").symlink_to(real)
        for verb in ("start", "stop"):
            result = self.run_action(self.action("linked", verb))
            self.assertVerdict(result, "linked", verb, "refused")
            self.assertIn("symlink", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_marker_that_is_a_symlink_proves_nothing(self) -> None:
        profile = self.home / ".hermes/profiles/sneaky"
        profile.mkdir()
        (self.home / "somewhere-else").write_text("kinerary-managed\n")
        (profile / "kinerary-managed").symlink_to(self.home / "somewhere-else")
        self.assertVerdict(self.run_action(self.action("sneaky", "start")), "sneaky", "start", "refused")
        (profile / "kinerary-managed").unlink()
        (profile / "kinerary-managed").symlink_to(self.home / "does-not-exist")     # dangling
        self.assertVerdict(self.run_action(self.action("sneaky", "start")), "sneaky", "start", "refused")
        self.assertEqual(self.calls(), [])

    def test_the_protected_list_is_the_one_file_and_a_missing_one_refuses_everything(self) -> None:
        # The script finds the list beside itself, so run a copy without it.
        tree = self.home / "copy"
        (tree / "scripts").mkdir(parents=True)
        (tree / "profile-templates/familytrip-companion").mkdir(parents=True)
        (tree / "profile-templates/familytrip-companion/render_profile.py").write_text("")
        shutil.copy(SCRIPT, tree / "scripts/companion-install-host.sh")
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_UNAME": "Linux"}

        def go(request: dict) -> subprocess.CompletedProcess:
            return subprocess.run(["bash", str(tree / "scripts/companion-install-host.sh")], input=json.dumps(request),
                                  capture_output=True, text=True, env=env, timeout=60)

        for request in (self.action("italy2026", "start"),
                        {"record_type": "companion_gateway_backfill", "schema_version": 1, "profiles": ["italy2026"]}):
            result = go(request)
            self.assertEqual(result.returncode, 2, result.stdout)
            self.assertNotIn("ACTION", result.stdout + "")
            self.assertIn("protected-profiles", result.stderr)
        (tree / "scripts/protected-profiles.txt").write_text("default\nnot a valid name\n")
        self.assertEqual(go(self.action("italy2026", "start")).returncode, 2)
        (tree / "scripts/protected-profiles.txt").write_text("# comment\n\nitaly2026\n")
        self.assertVerdict(go(self.action("italy2026", "start")), "italy2026", "start", "refused")
        self.assertEqual(self.calls(), [])

    def test_the_whole_protected_list_is_refused(self) -> None:
        names = [n for n in (REPO / "scripts/protected-profiles.txt").read_text().splitlines()
                 if n and not n.startswith("#")]
        self.assertGreaterEqual(len(names), 6)
        for name in names:
            (self.home / ".hermes/profiles" / name).mkdir(parents=True, exist_ok=True)
            (self.home / ".hermes/profiles" / name / "kinerary-managed").write_text("kinerary-managed\n")
            with self.subTest(name=name):
                self.assertVerdict(self.run_action(self.action(name, "start")), name, "start", "refused")
        self.assertEqual(self.calls(), [])

    def test_a_profile_that_does_not_exist_is_refused(self) -> None:
        self.assertVerdict(self.run_action(self.action("never-heard-of", "start")), "never-heard-of", "start", "refused")

    def test_a_mac_is_observe_only(self) -> None:
        for verb in ("start", "stop"):
            result = self.run_action(self.action("italy2026", verb), uname="Darwin")
            self.assertVerdict(result, "italy2026", verb, "refused")
            self.assertIn("observe-only", result.stderr)
        self.assertEqual(self.calls(), [], "launchd is the supervisor there; this verb is not a second starter")

    def test_what_is_not_a_closed_verb_or_a_safe_name_is_refused_before_anything_runs(self) -> None:
        bad = [self.action("italy2026", v) for v in ("restart", "START", "start; rm -rf /", "", "stop ")]
        bad += [self.action(n, "start") for n in ("../x", "Italy2026", "a b", "-x", "", "a" * 64)]
        bad += [{"record_type": "companion_gateway_action", "schema_version": 1, "profile": {"name": "italy2026"}},
                {"record_type": "companion_gateway_action", "schema_version": 1, "action": ["start"],
                 "profile": {"name": "italy2026"}},
                {"record_type": "companion_gateway_action", "schema_version": 1, "action": "start", "profile": "italy2026"},
                self.action("italy2026", "start", slug="../../etc"), self.action("italy2026", "start", slug="A B")]
        for request in bad:
            with self.subTest(request=json.dumps(request)[:80]):
                result = self.run_action(request)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertNotIn("ACTION", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.ps_argv.exists(), "nothing was even looked at")

    def test_the_request_cannot_choose_a_path_a_command_or_a_wait(self) -> None:
        result = self.run_action(self.action("italy2026", "start", command="rm -rf /", path="/etc", wait=999,
                                             timeout=1, hermes="/bin/sh"))
        self.assertVerdict(result, "italy2026", "start", "ok")
        self.assertEqual(self.calls(), ["-p italy2026 gateway start"])


class GatewayActionBridge(GatewayActionSandbox):
    """Q8: a dead trip-mcp bridge is brought back BEFORE its gateway starts."""

    def setUp(self) -> None:
        super().setUp()
        self.deploy = self.home / "kinerary-deploy"
        trip = self.deploy / "trips/italy-2026"
        (trip / "mcp").mkdir(parents=True)
        (trip / "topology.yaml").write_text(TOPOLOGY)
        (trip / "mcp/.env").write_text("MCP_API_KEY=s3cret-mcp-key\n")
        # what the bridge wiring writes when it succeeds: it names the profile
        self.provenance = trip / "companion-provenance.json"
        self.provenance.write_text('{"repo_root":"/x","commit":"abc1234","branch":"main","profile":"italy2026",'
                                   '"wired_at":"2026-10-20T10:00:00Z"}\n')
        self.health = self.home / "health.json"
        self.health.write_text('{"ok":true,"site":"reachable"}')
        self._exe(self.bin / "curl", f'#!/bin/sh\ncat >/dev/null\ncat "{self.health}"\n')
        self.restarts = self.home / "setup-mcp.calls"
        # the restart brings the bridge back (flips the health the stand-in curl serves)
        self._exe(self.deploy / "setup-mcp.sh",
                  f'#!/bin/sh\necho "$*" >> "{self.restarts}"\n'
                  f'[ -f "{self.home}/restart.fails" ] && exit 1\n'
                  f'echo \'{{"ok":true}}\' > "{self.health}"\nexit 0\n')
        self.order = self.home / "order.log"

    def start(self, **over) -> subprocess.CompletedProcess:
        return self.run_action(self.action("italy2026", "start", slug="italy-2026", **over))

    def restarted(self) -> list[str]:
        return self.restarts.read_text().splitlines() if self.restarts.exists() else []

    def test_a_dead_bridge_is_restarted_first_then_the_gateway_starts(self) -> None:
        self.health.write_text("")
        result = self.start()
        self.assertVerdict(result, "italy2026", "start", "ok")
        self.assertEqual(self.restarted(), [f"--restart-only --trip-dir {self.deploy}/trips/italy-2026"])
        self.assertEqual(self.calls(), ["-p italy2026 gateway start"])
        self.assertIn("restarting it before the gateway", result.stderr)

    def test_a_bridge_that_cannot_be_brought_back_means_no_start_and_a_loud_failure(self) -> None:
        self.health.write_text("")
        (self.home / "restart.fails").write_text("x")
        result = self.start()
        self.assertVerdict(result, "italy2026", "start", "failed")
        self.assertEqual(self.calls(), [], "a gateway started without its bridge stays toolless for life")
        self.assertIn("bridge is down and could not be restarted", result.stderr)

    def test_a_bridge_that_predates_health_is_restarted_too(self) -> None:
        self.health.write_text("<html>Cannot GET /health</html>")
        self.assertVerdict(self.start(), "italy2026", "start", "ok")
        self.assertEqual(len(self.restarted()), 1)

    def test_a_healthy_bridge_is_left_alone(self) -> None:
        self.assertVerdict(self.start(), "italy2026", "start", "ok")
        self.assertEqual(self.restarted(), [])

    def test_a_bridge_that_answers_but_cannot_reach_its_trip_is_not_restarted_and_the_gateway_still_starts(self) -> None:
        self.health.write_text('{"ok":false,"site":"refused","code":"HTTP_401"}')
        result = self.start()
        self.assertVerdict(result, "italy2026", "start", "ok")
        self.assertEqual(self.restarted(), [])
        self.assertIn("HTTP_401", result.stderr)

    def test_a_trip_with_no_bridge_configured_just_starts(self) -> None:
        (self.deploy / "trips/italy-2026/mcp/.env").unlink()
        self.health.write_text("")
        self.assertVerdict(self.start(), "italy2026", "start", "ok")
        self.assertEqual(self.restarted(), [])

    def test_no_slug_means_no_bridge_step(self) -> None:
        self.health.write_text("")
        self.assertVerdict(self.run_action(self.action("italy2026", "start")), "italy2026", "start", "ok")
        self.assertEqual(self.restarted(), [])

    def test_a_slug_that_is_not_this_profiles_trip_is_refused_and_nothing_is_touched(self) -> None:
        self.health.write_text("")
        # another trip's directory, claiming to be the profile's
        other = self.deploy / "trips/other-trip"
        (other / "mcp").mkdir(parents=True)
        (other / "topology.yaml").write_text(TOPOLOGY.replace("italy-2026", "other-trip").replace("trip-italy", "trip-other"))
        (other / "mcp/.env").write_text("MCP_API_KEY=other-key\n")
        (other / "companion-provenance.json").write_text('{"profile":"someone-else"}\n')
        result = self.run_action(self.action("italy2026", "start", slug="other-trip"))
        self.assertVerdict(result, "italy2026", "start", "refused")
        self.assertIn("no provenance record naming italy2026", result.stderr)
        self.assertEqual(self.restarted(), [])
        self.assertEqual(self.calls(), [])

    def test_a_trip_with_no_provenance_record_or_a_symlinked_one_is_refused(self) -> None:
        self.health.write_text("")
        self.provenance.unlink()
        self.assertVerdict(self.start(), "italy2026", "start", "refused")
        self.provenance.symlink_to(self.home / "elsewhere.json")
        (self.home / "elsewhere.json").write_text('{"profile":"italy2026"}\n')
        self.assertVerdict(self.start(), "italy2026", "start", "refused")
        self.assertEqual(self.restarted(), [])
        self.assertEqual(self.calls(), [])

    def test_a_stop_never_touches_the_bridge(self) -> None:
        self.health.write_text("")
        self.procs("  700     1 hermes -p italy2026 gateway run")
        self.assertVerdict(self.run_action(self.action("italy2026", "stop", slug="italy-2026")),
                           "italy2026", "stop", "ok")
        self.assertEqual(self.restarted(), [])

    def test_the_key_never_reaches_the_output(self) -> None:
        self.health.write_text("")
        result = self.start()
        self.assertNotIn("s3cret-mcp-key", result.stdout + result.stderr)


class GatewayBackfill(GatewayActionSandbox):
    """The marker says "this system installed this profile". The backfill may only
    say so with host-side evidence: a trip's provenance record that names it."""

    def backfill(self, *names, **over) -> dict:
        return {"record_type": "companion_gateway_backfill", "schema_version": 1, "profiles": list(names), **over}

    def evidence(self, trip: str, profile: str) -> None:
        d = self.home / "kinerary-deploy/trips" / trip
        d.mkdir(parents=True, exist_ok=True)
        (d / "companion-provenance.json").write_text(json.dumps({"profile": profile, "commit": "abc1234"}) + "\n")

    def test_marks_only_what_this_system_installed_and_says_so_for_every_name(self) -> None:
        for name in ("new-one", "personal-one"):
            (self.home / ".hermes/profiles" / name).mkdir()
        self.evidence("some-trip", "new-one")
        result = self.run_action(self.backfill("new-one", "personal-one", "italy2026", "default", "never-heard-of"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "BACKFILL new-one marked", "BACKFILL personal-one refused", "BACKFILL italy2026 already",
            "BACKFILL default refused", "BACKFILL never-heard-of absent", "BACKFILL_END 5"])
        self.assertEqual((self.home / ".hermes/profiles/new-one/kinerary-managed").read_text(), "kinerary-managed\n")
        self.assertFalse((self.home / ".hermes/profiles/personal-one/kinerary-managed").exists(),
                         "an existing profile with no evidence is somebody else's")
        self.assertIn("no trip's provenance record names it", result.stderr)

    def test_the_protected_list_is_never_marked_even_with_evidence(self) -> None:
        for name in ("default", "trip-monitor", "kinerary-extract", "elulhome", "familytrip", "kinerarytest"):
            (self.home / ".hermes/profiles" / name).mkdir(parents=True, exist_ok=True)
            marker = self.home / ".hermes/profiles" / name / "kinerary-managed"
            if marker.exists():
                marker.unlink()
            self.evidence(f"trip-{name}", name)
        result = self.run_action(self.backfill("default", "trip-monitor", "kinerary-extract", "elulhome", "familytrip",
                                               "kinerarytest"))
        self.assertTrue(all(line.endswith("refused") for line in result.stdout.splitlines()[:-1]), result.stdout)
        for name in ("default", "trip-monitor", "kinerary-extract", "elulhome", "familytrip", "kinerarytest"):
            self.assertFalse((self.home / ".hermes/profiles" / name / "kinerary-managed").exists(), name)

    def test_forged_or_unreadable_evidence_counts_for_nothing(self) -> None:
        (self.home / ".hermes/profiles/forged-one").mkdir()
        trips = self.home / "kinerary-deploy/trips"
        (trips / "bad-json").mkdir(parents=True)
        (trips / "bad-json/companion-provenance.json").write_text("{not json")
        (trips / "wrong-type").mkdir()
        (trips / "wrong-type/companion-provenance.json").write_text('{"profile": ["forged-one"]}')
        (trips / "linked").mkdir()
        (self.home / "outside.json").write_text('{"profile":"forged-one"}')
        (trips / "linked/companion-provenance.json").symlink_to(self.home / "outside.json")
        (trips / "linked-dir-target").mkdir()
        (self.home / "elsewhere-trip").mkdir()
        (self.home / "elsewhere-trip/companion-provenance.json").write_text('{"profile":"forged-one"}')
        (trips / "linked-dir").symlink_to(self.home / "elsewhere-trip")
        result = self.run_action(self.backfill("forged-one"))
        self.assertEqual(result.stdout.splitlines(), ["BACKFILL forged-one refused", "BACKFILL_END 1"])
        self.assertFalse((self.home / ".hermes/profiles/forged-one/kinerary-managed").exists())

    def test_it_never_follows_a_symlink_to_mark(self) -> None:
        self.evidence("linked-trip", "linked-profile")
        real = self.home / "real-profile"
        real.mkdir()
        (self.home / ".hermes/profiles/linked-profile").symlink_to(real)
        self.evidence("dangling-trip", "dangling-marker")
        profile = self.home / ".hermes/profiles/dangling-marker"
        profile.mkdir()
        target = self.home / "victim.txt"
        (profile / "kinerary-managed").symlink_to(target)
        result = self.run_action(self.backfill("linked-profile", "dangling-marker"))
        self.assertEqual(result.stdout.splitlines(),
                         ["BACKFILL linked-profile refused", "BACKFILL dangling-marker refused", "BACKFILL_END 2"])
        self.assertFalse((real / "kinerary-managed").exists(), "nothing was written through the symlinked directory")
        self.assertFalse(target.exists(), "nothing was created through the dangling marker")

    def test_a_mac_marks_nothing(self) -> None:
        (self.home / ".hermes/profiles/new-one").mkdir()
        self.evidence("some-trip", "new-one")
        result = self.run_action(self.backfill("new-one", "italy2026"), uname="Darwin")
        self.assertEqual(result.stdout.splitlines(),
                         ["BACKFILL new-one refused", "BACKFILL italy2026 refused", "BACKFILL_END 2"])
        self.assertIn("observe-only", result.stderr)
        self.assertFalse((self.home / ".hermes/profiles/new-one/kinerary-managed").exists())

    def test_bad_requests_are_refused_and_mark_nothing(self) -> None:
        (self.home / ".hermes/profiles/new-one").mkdir()
        self.evidence("some-trip", "new-one")
        for over in ({"profiles": []}, {"profiles": ["new-one", "new-one"]}, {"profiles": ["../x"]},
                     {"profiles": "new-one"}, {"profiles": [None]}, {"profiles": [f"p-{n:03d}" for n in range(201)]}):
            with self.subTest(over=str(over)[:60]):
                result = self.run_action({"record_type": "companion_gateway_backfill", "schema_version": 1, **over})
                self.assertEqual(result.returncode, 2)
                self.assertNotIn("BACKFILL", result.stdout)
        self.assertFalse((self.home / ".hermes/profiles/new-one/kinerary-managed").exists())


class InstallWritesTheMarkerAndDarwinHasOneStarter(GatewayActionSandbox):
    def install(self, *, uname: str, preexisting: bool = True) -> subprocess.CompletedProcess:
        if preexisting:
            (self.home / ".hermes/profiles/freshone").mkdir()
        self._exe(self.bin / "launchctl", "#!/bin/sh\nexit 0\n")
        self._exe(self.bin / "pgrep", "#!/bin/sh\nexit 1\n")
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_UNAME": uname,
               "KINERARY_ARCHITECTURE_PROFILE": str(self.home / "none.json")}
        handoff = json.loads((REPO / "profile-templates/familytrip-companion/example.handoff.json").read_text())
        handoff["profile"]["name"] = "freshone"
        request = {"profile": {"name": "freshone"}} if preexisting else handoff
        return subprocess.run(["bash", str(SCRIPT)], input=json.dumps(request),
                              capture_output=True, text=True, env=env, timeout=120)

    def test_a_fresh_install_marks_the_profile_as_managed(self) -> None:
        result = self.install(uname="Linux", preexisting=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("INSTALLED freshone", result.stdout)
        marker = self.home / ".hermes/profiles/freshone/kinerary-managed"
        self.assertTrue(marker.is_file() and not marker.is_symlink())

    def test_a_profile_that_was_already_there_is_not_marked_by_a_retried_install(self) -> None:
        # "Already present" means this run did not create it: it may be someone's
        # own profile that a request merely named. Only the evidenced backfill
        # may mark a profile from before the marker.
        result = self.install(uname="Linux")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ALREADY_PRESENT freshone", result.stdout)
        self.assertFalse((self.home / ".hermes/profiles/freshone/kinerary-managed").exists())

    def test_the_mac_agent_has_one_supervisor_and_no_fallback_starter(self) -> None:
        result = self.install(uname="Darwin")
        self.assertEqual(result.returncode, 0, result.stderr)
        plist = (self.home / "Library/LaunchAgents/ai.hermes.gateway-freshone.plist").read_text()
        self.assertNotIn("--replace", plist, "two starters using --replace kill each other")
        self.assertIn("--external-supervisor", plist)
        keep = plist.split("<key>KeepAlive</key>")[1].split("<key>ThrottleInterval</key>")[0]
        self.assertIn("<key>SuccessfulExit</key>", keep)
        self.assertIn("<false/>", keep, "restart on failure only: a clean stop stays stopped")
        self.assertNotIn("<true/>", keep)
        self.assertNotIn("detached", result.stderr, "there is no detached fallback starter")
        self.assertIn("NOT RUNNING", result.stderr, "and a launchd that did not take it says so")
        self.assertIn("launchctl bootstrap gui/", result.stderr)
        text = SCRIPT.read_text()
        self.assertNotIn("detach.py", text)
        self.assertNotIn("run --replace", text)


if __name__ == "__main__":
    unittest.main()
