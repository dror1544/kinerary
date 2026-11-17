"""F3 of the owner's review of #599: the trip SITE -> shared bridge direction (spec AC-B2.7, AC-B2.8).

A trip's site calls its bridge for booking extraction and enrichment (`${HERMES_URL}/extract`, `/enrich`) with
its own key. A shared bridge has no per-trip port, so a new site is born with HERMES_URL pointing at the shared
bridge, and the worker proves from INSIDE the container that the bridge answers there and knows the site's key.

The script that runs in the container is executed here for real (sh, curl, a local HTTP server standing in for
the bridge), with a curl wrapper that records every argument it is given: the site's key must be on no command
line, and on nothing but the stdin of that one curl.
"""
from __future__ import annotations

import http.server
import os
import shlex
import shutil
import stat
import subprocess
import tempfile
import threading
import unittest
from dataclasses import replace

from provisioning.adapters import ProxmoxLxcAdapter
from provisioning.models import LxcSpec

SPEC = LxcSpec(
    "trip-kinerary", "pve", "t", "s", 2, 1024, 8, "vmbr0", "ip", "gw", "ns", "h", "m", "kinerary",
)
NEW_SPEC = LxcSpec(
    "trip-tokyo-2026", "pve", "local:vztmpl/debian.tar.zst", "local-lvm", 2, 1024, 8, "vmbr0",
    "192.0.2.60/24", "192.0.2.1", "192.0.2.2", "/mnt/pve/nfs/tokyo-2026", "/nfs/tokyo-2026", "tokyo-2026",
)
SITE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef"  # stands in for the site's HERMES_API_KEY
BRIDGE = "http://192.0.2.77:3999"
PCT_LIST = "VMID Status Lock Name\n201 running trip-kinerary\n203 running trip-tokyo-2026\n"


class _Ssh:
    """Answers `pct list`, records every command, and answers the in-container script with `answer`."""

    def __init__(self, answer: str = "", raises: bool = False) -> None:
        self.answer, self.raises, self.commands, self.secrets = answer, raises, [], []

    def run(self, command: str, *, secrets: tuple[str, ...] = ()) -> str:
        self.commands.append(command)
        self.secrets.append(secrets)
        if command == "pct list":
            return PCT_LIST
        if command.startswith("pct exec 201 -- sh -c "):
            if self.raises:
                raise RuntimeError(f"ssh command failed (exit 255): HERMES_API_KEY={SITE_KEY}")
            return self.answer
        if command.startswith("#!/bin/bash") and "BOOTSTRAP_INNER" in command:
            return ""
        if command.startswith("pct create ") or command.startswith("mkdir ") or command.startswith("pvesh "):
            return "204\n" if command.startswith("pvesh") else ""
        raise AssertionError(f"unexpected command {command!r}")


class HermesUrlIsWrittenOnlyForANewSharedTrip(unittest.TestCase):
    def _bootstrap(self, **kwargs: str) -> str:
        ssh = _Ssh()
        # bootstrap() is the in-place converge path: it runs the same script create() does.
        adapter = ProxmoxLxcAdapter(ssh, **kwargs)
        adapter.bootstrap(SPEC)
        return next(c for c in ssh.commands if "BOOTSTRAP_INNER" in c)

    def test_unset_writes_no_hermes_url_line(self) -> None:
        self.assertNotIn("HERMES_URL", self._bootstrap())

    def test_set_writes_it_inside_the_no_env_yet_branch_so_a_re_provision_never_rewrites_it(self) -> None:
        script = self._bootstrap(hermes_url=BRIDGE)
        guard = script.index("if [ ! -f /opt/kinerary/.env ]; then")
        write = script.index(f"printf 'HERMES_URL=%s\\n' {BRIDGE} >> /opt/kinerary/.env")
        end = script.index("\nfi\n", guard)
        self.assertTrue(guard < write < end)
        self.assertEqual(1, script.count("HERMES_URL="))

    def test_anything_but_a_plain_http_origin_is_refused_before_it_can_reach_a_shell(self) -> None:
        for bad in ("https://bridge.example.test/", "http://u:p@192.0.2.1:3", "http://192.0.2.1:3/x", "ftp://192.0.2.1",
                    "http://192.0.2.1:3 ; reboot", "http://$(id)", "http://a.test:80\nX=1", "192.0.2.1:3", "http://"):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                ProxmoxLxcAdapter(_Ssh(), hermes_url=bad)
        ProxmoxLxcAdapter(_Ssh(), hermes_url="https://bridge.example.test")  # a host alone is fine


class SiteToBridgeCheckCommand(unittest.TestCase):
    def test_the_command_that_crosses_ssh_carries_no_key_and_no_address_in_the_evidence(self) -> None:
        ssh = _Ssh("result=answered status=200 curl_exit=0\n")
        ok, evidence = ProxmoxLxcAdapter(ssh).check_site_to_bridge(SPEC, BRIDGE)
        self.assertTrue(ok)
        command = ssh.commands[-1]
        self.assertTrue(command.startswith("pct exec 201 -- sh -c "))
        self.assertNotIn(SITE_KEY, command)
        # The script reads the key inside the container and hands it to curl on stdin from a shell builtin.
        script = shlex.split(command)[-1]
        self.assertIn("/opt/kinerary/.env", script)
        self.assertIn("printf 'header = \"X-API-Key: %s\"\\n' \"$KEY\" | curl ", script)
        curl_line = next(line for line in script.splitlines() if " curl " in line)
        self.assertIn("--config -", curl_line)
        self.assertNotIn("$KEY", curl_line.split("| curl ", 1)[1], "no key on curl's own argument list")
        for text in (evidence, repr(ssh.secrets)):
            self.assertNotIn(SITE_KEY, text)
            self.assertNotIn("192.0.2.77", text)

    def test_what_the_container_answers_is_reported_as_what_it_means(self) -> None:
        cases = {
            "result=answered status=200 curl_exit=0": (True, "health 200"),
            "result=answered status=401 curl_exit=0": (False, "does not recognise"),
            "result=answered status=503 curl_exit=0": (False, "cannot reach its site"),
            "result=answered status=000 curl_exit=7": (False, "could not reach the bridge (curl exit 7)"),
            "result=answered status=000 curl_exit=28": (False, "could not reach the bridge (curl exit 28)"),
            "result=answered status=302 curl_exit=0": (False, "unexpected status 302"),
            "result=no_hermes_url": (False, "no HERMES_URL"),
            "result=hermes_url_differs": (False, "not the shared bridge address"),
            "result=no_site_key": (False, "no HERMES_API_KEY"),
            "result=site_key_unusable": (False, "characters this check will not send"),
            "": (False, "no usable result"),
        }
        for answer, (ok, words) in cases.items():
            with self.subTest(answer=answer):
                got_ok, evidence = ProxmoxLxcAdapter(_Ssh("warning: noise\n" + answer + "\n")).check_site_to_bridge(SPEC, BRIDGE)
                self.assertIs(ok, got_ok)
                self.assertIn(words, evidence)

    def test_no_such_container_is_a_failure_not_a_pass(self) -> None:
        ok, evidence = ProxmoxLxcAdapter(_Ssh()).check_site_to_bridge(replace(SPEC, name="trip-missing"), BRIDGE)
        self.assertFalse(ok)
        self.assertEqual("no such container", evidence)

    def test_an_ssh_failure_raises_without_the_transports_text(self) -> None:
        with self.assertRaises(RuntimeError) as caught:
            ProxmoxLxcAdapter(_Ssh(raises=True)).check_site_to_bridge(SPEC, BRIDGE)
        self.assertNotIn(SITE_KEY, str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_the_expected_address_must_be_a_plain_origin(self) -> None:
        with self.assertRaises(ValueError):
            ProxmoxLxcAdapter(_Ssh()).check_site_to_bridge(SPEC, "http://x.test:1; id")


class _Bridge(http.server.BaseHTTPRequestHandler):
    seen: list[tuple[str, str | None]] = []
    status = 200

    def do_GET(self) -> None:  # noqa: N802
        type(self).seen.append((self.path, self.headers.get("X-API-Key")))
        self.send_response(type(self).status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true, "site": "reachable"}')

    def log_message(self, *args: object) -> None:  # silence
        pass


@unittest.skipUnless(shutil.which("curl") and shutil.which("sh"), "needs curl and sh")
class SiteToBridgeScriptRunsForReal(unittest.TestCase):
    """The script, executed: a real sh and curl against a local server, with the .env path swapped for a temp
    file and curl wrapped so that every argument it receives is written down."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="site-bridge-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        _Bridge.seen, _Bridge.status = [], 200
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Bridge)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.argv_log = os.path.join(self.tmp, "curl-argv.log")
        wrapper = os.path.join(self.tmp, "bin", "curl")
        os.makedirs(os.path.dirname(wrapper))
        with open(wrapper, "w") as handle:
            handle.write(f'#!/bin/sh\nprintf "%s\\n" "$@" >> {shlex.quote(self.argv_log)}\nexec {shlex.quote(shutil.which("curl"))} "$@"\n')
        os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IXUSR)
        self.env_file = os.path.join(self.tmp, "kinerary.env")

    def _run(self, env_text: str, expected: str | None = None) -> tuple[bool, str, str]:
        with open(self.env_file, "w") as handle:
            handle.write(env_text)
        ssh = _Ssh("")
        adapter = ProxmoxLxcAdapter(ssh)
        adapter.check_site_to_bridge(SPEC, expected or self.url)
        script = shlex.split(ssh.commands[-1])[-1].replace("/opt/kinerary/.env", self.env_file)
        out = subprocess.run(
            ["sh", "-c", script], capture_output=True, text=True, timeout=30,
            env={"PATH": os.path.join(self.tmp, "bin") + os.pathsep + os.environ["PATH"]},
        )
        # Feed the real output back through the adapter's own reading of it.
        ssh2 = _Ssh(out.stdout)
        ok, evidence = adapter.__class__(ssh2).check_site_to_bridge(SPEC, expected or self.url)
        return ok, evidence, out.stdout + out.stderr

    def _argv(self) -> str:
        if not os.path.exists(self.argv_log):
            return ""
        with open(self.argv_log) as handle:
            return handle.read()

    def test_a_bridge_that_knows_the_key_passes_and_the_key_was_on_no_command_line(self) -> None:
        ok, evidence, printed = self._run(f"PORT=3000\nHERMES_URL={self.url}\nHERMES_API_KEY={SITE_KEY}\n")
        self.assertTrue(ok, evidence)
        self.assertEqual([("/health", SITE_KEY)], _Bridge.seen, "one request, to /health, carrying the site's own key")
        self.assertNotIn(SITE_KEY, self._argv(), "curl was never given the key as an argument")
        self.assertIn("--config", self._argv())
        self.assertNotIn(SITE_KEY, printed, "nothing the script printed carries the key")
        self.assertNotIn(self.url, printed, "nor the address")

    def test_the_last_hermes_url_line_wins_as_it_does_for_systemd(self) -> None:
        ok, _evidence, _p = self._run(f"HERMES_URL=http://127.0.0.1:9\nHERMES_URL={self.url}\nHERMES_API_KEY={SITE_KEY}\n")
        self.assertTrue(ok)

    def test_a_bridge_that_does_not_know_the_key_is_a_401_failure(self) -> None:
        _Bridge.status = 401
        ok, evidence, _p = self._run(f"HERMES_URL={self.url}\nHERMES_API_KEY={SITE_KEY}\n")
        self.assertFalse(ok)
        self.assertIn("does not recognise", evidence)

    def test_a_site_still_pointed_at_a_per_trip_port_is_named_not_probed(self) -> None:
        ok, evidence, _p = self._run(f"HERMES_URL=http://127.0.0.1:3205\nHERMES_API_KEY={SITE_KEY}\n")
        self.assertFalse(ok)
        self.assertIn("not the shared bridge address", evidence)
        self.assertEqual([], _Bridge.seen, "the other address was not asked, and no key was sent to it")

    def test_a_missing_url_or_key_fails_and_sends_nothing(self) -> None:
        for env_text, words in ((f"HERMES_API_KEY={SITE_KEY}\n", "no HERMES_URL"), (f"HERMES_URL={self.url}\n", "no HERMES_API_KEY"),
                                (f"HERMES_URL={self.url}\nHERMES_API_KEY=bad key;id\n", "will not send")):
            with self.subTest(env=words):
                ok, evidence, _p = self._run(env_text)
                self.assertFalse(ok)
                self.assertIn(words, evidence)
        self.assertEqual([], _Bridge.seen)

    def test_a_bridge_nobody_listens_on_is_unreachable_from_the_container(self) -> None:
        dead = "http://127.0.0.1:1"
        ok, evidence, _p = self._run(f"HERMES_URL={dead}\nHERMES_API_KEY={SITE_KEY}\n", expected=dead)
        self.assertFalse(ok)
        self.assertIn("could not reach the bridge", evidence)


if __name__ == "__main__":
    unittest.main()
