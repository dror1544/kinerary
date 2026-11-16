"""scripts/companion-install-host.sh — wiring a companion to the SHARED trip-mcp bridge.

docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md, AC-B2.1 .. B2.5.

Shared mode is the host's own decision: it is on only when THIS host's
environment sets both KINERARY_SHARED_BRIDGE_ROUTES_DIR and
KINERARY_SHARED_BRIDGE_URL. Nothing about it comes from the request, which is
the one thing here that is a trust boundary (the forced command for the
worker's key). What a wiring does instead of starting a process: one route file
(the trip's address and agent key, and only the hash of the companion's token)
and one `mcp_servers.trip-mcp` entry in the profile, whose header refers to the
token by name.

Same sandbox shape as test_companion_install_host.py: the real script, a
sandboxed HOME, and stand-ins for hermes, launchctl and curl. The stand-in curl
records argv and stdin apart, because which of the two a secret travels in is
the difference between a secret and a line in `ps`.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_companion_gateway_verbs as gateway_verbs  # noqa: E402  (sandbox base only; not collected twice)

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "companion-install-host.sh"

# A trip with no npm section at all: the wildcard shape. `lxc.forward_port` is
# where the site port lives for such a trip; vmid is deliberately out of the
# 3100-3999 bridge-port window (no bridge port is derived in shared mode).
TOPOLOGY = """\
version: 1
name: italy-2026
routing: wildcard
proxmox:
  node: proxmox
  vmid: '9999'
  lxc:
    name: trip-italy-2026
    ipv4: 192.168.0.61/24
    forward_port: 8080
"""

TOPOLOGY_NPM_ONLY = """\
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
  forward_port: 8081
"""

TRIP_KEY = "agent-key-from-the-hook-0123456789"
ENV_TRIP_KEY = "agent-key-from-the-env-file-0123456789"
ENV_MCP_KEY = "mcp-key-from-the-env-file-0123456789"
SHARED_URL = "http://127.0.0.1:3999"
EXISTING_CONFIG = """\
model:
  default: some-model
mcp_servers:
  other-tool:
    url: http://127.0.0.1:1234/sse
  trip-mcp:
    url: http://127.0.0.1:3104/sse
    transport: sse
    headers:
      X-API-Key: old-per-trip-key
agent:
  max_turns: 40
"""


class SharedSandbox(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / ".local/bin").mkdir(parents=True)
        venv = self.home / ".hermes/hermes-agent/venv/bin"
        venv.mkdir(parents=True)
        (venv / "python3").symlink_to(sys.executable)
        (venv / "python").symlink_to(sys.executable)
        self.profile = self.home / ".hermes/profiles/italy2026"
        self.profile.mkdir(parents=True)
        (self.profile / "config.yaml").write_text(EXISTING_CONFIG)
        (self.profile / "config.yaml").chmod(0o640)
        (self.profile / ".env").write_text("RELAY_GATEWAY_ID=italy2026\n")
        # the marker a profile this system installed carries (provenance is only
        # recorded for such a profile, exactly as in per-trip wiring)
        (self.profile / "kinerary-managed").write_text("kinerary-managed\n")
        registered = ('mkdir -p "$HOME/.hermes/profiles/italy2026/logs"; '
                      "echo \"INFO tools.mcp_tool: MCP server 'trip-mcp' (HTTP): registered 44 tool(s)\" "
                      '>> "$HOME/.hermes/profiles/italy2026/logs/agent.log"')
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self._exe(self.bin / "launchctl", f'#!/bin/sh\n[ "$1" = bootstrap ] && {{ {registered}; }}\nexit 0\n')
        hermes = f'#!/bin/sh\ncase "$*" in *"gateway start"*) {registered};; esac\nexit 0\n'
        self._exe(self.bin / "hermes", hermes)
        # The script puts ~/.local/bin FIRST on its PATH; on Linux the gateway is
        # started through `hermes`, so the stand-in has to be found there too.
        self._exe(self.home / ".local/bin/hermes", hermes)
        self.deploy = self.home / "kinerary-deploy"
        self.trip = self.deploy / "trips/italy-2026"
        self.trip.mkdir(parents=True)
        (self.trip / "topology.yaml").write_text(TOPOLOGY)
        self.setup_calls = self.home / "setup-mcp.calls"
        self._exe(self.deploy / "setup-mcp.sh", f'#!/bin/sh\necho "$*" >> "{self.setup_calls}"\nexit 0\n')
        # The deployment's own hook (it lives in kinerary-deploy, not this repo):
        # stdout is the trip's agent key.
        self.hook = self.deploy / "trip-agent-key.sh"
        self.hook_calls = self.home / "hook.calls"
        self._exe(self.hook, f'#!/bin/sh\necho "$*" >> "{self.hook_calls}"\nprintf "%s\\n" "{TRIP_KEY}"\n')
        self.routes = self.home / "routes"
        self.routes.mkdir(mode=0o700)
        # curl: /ready and /health are answered from files; a `health.seq` file,
        # when present, gives one answer per line and is consumed (a route that
        # the bridge has not picked up yet answers 401 first).
        self.ready = self.home / "ready.json"
        self.ready.write_text('{"ok":true}')
        self.health = self.home / "health.json"
        self.health.write_text('{"ok":true,"site":"reachable"}')
        self.seq = self.home / "health.seq"
        self.curl_argv = self.home / "curl.argv"
        self.curl_stdin = self.home / "curl.stdin"
        self._exe(self.bin / "curl", f"""#!/bin/sh
echo "$*" >> "{self.curl_argv}"
case "$*" in
  *"--config -"*) cat >> "{self.curl_stdin}"; echo "--" >> "{self.curl_stdin}" ;;
esac
case "$*" in
  */ready*) cat "{self.ready}"; exit 0 ;;
esac
if [ -s "{self.seq}" ]; then
  head -1 "{self.seq}"; tail -n +2 "{self.seq}" > "{self.seq}.next"; mv "{self.seq}.next" "{self.seq}"; exit 0
fi
cat "{self.health}"
""")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def _exe(path: Path, body: str) -> None:
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def env(self, **over) -> dict:
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin",
               "KINERARY_SHARED_BRIDGE_ROUTES_DIR": str(self.routes),
               "KINERARY_SHARED_BRIDGE_URL": SHARED_URL}
        env.update(over)
        return {k: v for k, v in env.items() if v is not None}

    def send(self, request: dict, **env_over) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(SCRIPT)], input=json.dumps(request), capture_output=True,
                              text=True, env=self.env(**env_over), timeout=120)

    def wire(self, **over) -> dict:
        return {"record_type": "trip_mcp_bridge_request", "schema_version": 1,
                "slug": "italy-2026", "profile": {"name": "italy2026"}, **over}

    def probe(self, **over) -> dict:
        return {"record_type": "trip_mcp_bridge_probe", "schema_version": 1,
                "slug": "italy-2026", "profile": {"name": "italy2026"}, **over}

    def route(self) -> dict:
        return json.loads((self.routes / "italy-2026.json").read_text())

    def config(self) -> dict:
        return yaml.safe_load((self.profile / "config.yaml").read_text())

    def token(self) -> str:
        lines = [ln for ln in (self.profile / ".env").read_text().splitlines() if ln.startswith("TRIP_MCP_TOKEN=")]
        self.assertEqual(len(lines), 1, "exactly one TRIP_MCP_TOKEN line")
        return lines[0].split("=", 1)[1]

    def assertWired(self, result) -> None:  # noqa: N802
        self.assertEqual(result.returncode, 0, result.stderr)
        parts = result.stdout.strip().splitlines()[-1].split()
        self.assertEqual(parts[:2], ["WIRED", "italy2026"], result.stdout)
        self.assertEqual(len(parts), 3, f"provenance missing from {result.stdout!r}")

    def assertNothingWritten(self) -> None:  # noqa: N802
        self.assertEqual(list(self.routes.iterdir()), [], "a refused wiring must leave no route file")
        self.assertNotIn("TRIP_MCP_TOKEN", (self.profile / ".env").read_text())
        self.assertEqual((self.profile / "config.yaml").read_text(), EXISTING_CONFIG)


class SharedWiring(SharedSandbox):
    def test_a_companion_is_wired_with_one_route_file_and_one_profile_entry_and_no_process(self) -> None:
        result = self.send(self.wire())
        self.assertWired(result)
        # AC-B2.2: no setup-mcp.sh, no port.
        self.assertFalse(self.setup_calls.exists(), "shared mode must not call setup-mcp.sh")
        self.assertEqual(self.hook_calls.read_text().strip(), "italy-2026")
        route = self.route()
        token = self.token()
        self.assertRegex(token, r"^[0-9a-f]{64}$", "32 random bytes, hex")
        self.assertEqual(route, {
            "schema_version": 1, "trip": "italy-2026",
            "api_base_url": "http://192.168.0.61:8080",
            "trip_api_key": TRIP_KEY,
            "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
        })
        # only the HASH of the token is in the route; the token itself is not
        self.assertNotIn(token, (self.routes / "italy-2026.json").read_text())
        self.assertEqual(stat.S_IMODE((self.routes / "italy-2026.json").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.profile / ".env").stat().st_mode), 0o600)
        # the profile entry, and nothing else of the profile touched
        cfg = self.config()
        self.assertEqual(cfg["mcp_servers"]["trip-mcp"], {
            "transport": "sse", "url": f"{SHARED_URL}/sse", "headers": {"X-API-Key": "${TRIP_MCP_TOKEN}"}})
        self.assertEqual(cfg["mcp_servers"]["other-tool"], {"url": "http://127.0.0.1:1234/sse"})
        self.assertEqual(cfg["model"], {"default": "some-model"})
        self.assertEqual(cfg["agent"], {"max_turns": 40})
        self.assertEqual(stat.S_IMODE((self.profile / "config.yaml").stat().st_mode), 0o640, "mode of an existing config is kept")
        self.assertIn("RELAY_GATEWAY_ID=italy2026", (self.profile / ".env").read_text(), "existing .env lines kept")
        # AC-B2.2: the same provenance record as today
        prov = json.loads((self.trip / "companion-provenance.json").read_text())
        self.assertEqual(prov["profile"], "italy2026")

    def test_a_profile_this_system_did_not_mark_gets_no_provenance_record_but_is_still_wired(self) -> None:
        (self.profile / "kinerary-managed").unlink()
        result = self.send(self.wire())
        self.assertWired(result)
        self.assertFalse((self.trip / "companion-provenance.json").exists())
        self.assertIn("provenance not recorded", result.stderr)

    def test_running_it_twice_leaves_one_route_one_entry_and_the_same_token(self) -> None:
        self.assertWired(self.send(self.wire()))
        first_token, first_route = self.token(), self.route()
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.token(), first_token)
        self.assertEqual(self.route(), first_route)
        self.assertEqual([p.name for p in self.routes.iterdir()], ["italy-2026.json"], "no temp file left behind")
        self.assertEqual(list(self.config()["mcp_servers"]), ["other-tool", "trip-mcp"])
        text = (self.profile / ".env").read_text()
        self.assertEqual(text.count("TRIP_MCP_TOKEN="), 1)

    def test_a_token_already_in_the_profile_is_kept(self) -> None:
        existing = "a1" * 32
        (self.profile / ".env").write_text(f"RELAY_GATEWAY_ID=italy2026\nTRIP_MCP_TOKEN={existing}\n")
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.token(), existing)
        self.assertEqual(self.route()["token_sha256"], hashlib.sha256(existing.encode()).hexdigest())

    def test_a_profile_env_with_no_trailing_newline_is_not_corrupted(self) -> None:
        (self.profile / ".env").write_text("RELAY_GATEWAY_ID=italy2026")
        self.assertWired(self.send(self.wire()))
        self.assertIn("RELAY_GATEWAY_ID=italy2026\nTRIP_MCP_TOKEN=", (self.profile / ".env").read_text())

    def test_a_malformed_token_in_the_profile_is_refused_not_silently_rotated(self) -> None:
        (self.profile / ".env").write_text('TRIP_MCP_TOKEN=has a space"\n')
        result = self.send(self.wire())
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("WIRED", result.stdout)
        self.assertEqual(list(self.routes.iterdir()), [])

    def test_a_profile_with_no_config_yaml_gets_one(self) -> None:
        (self.profile / "config.yaml").unlink()
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.config(), {"mcp_servers": {"trip-mcp": {
            "transport": "sse", "url": f"{SHARED_URL}/sse", "headers": {"X-API-Key": "${TRIP_MCP_TOKEN}"}}}})

    def test_the_gateway_is_restarted_and_the_bridge_asked_for_the_trip_with_the_trips_token(self) -> None:
        result = self.send(self.wire())
        self.assertWired(result)
        stdin = self.curl_stdin.read_text()
        self.assertIn(f'url = "{SHARED_URL}/health"', stdin)
        self.assertIn(f"X-API-Key: {self.token()}", stdin)
        self.assertIn("/ready", self.curl_argv.read_text(), "the bridge's /ready is asked first")

    def test_a_bridge_that_cannot_reach_the_trip_is_not_reported_wired(self) -> None:
        self.health.write_text('{"ok":false,"site":"unreachable","code":"EHOSTUNREACH"}')
        result = self.send(self.wire())
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("WIRED", result.stdout)
        self.assertIn("EHOSTUNREACH", result.stderr)
        self.assertIn("shared", result.stderr.lower())

    def test_a_route_the_bridge_has_not_picked_up_yet_is_waited_for_before_the_gateway_starts(self) -> None:
        # The bridge rescans once a second: the first answers are 401. A gateway
        # started now would be refused three times and park its trip-mcp for life.
        self.seq.write_text('{"error":"unauthorized"}\n{"error":"unauthorized"}\n')
        result = self.send(self.wire())
        self.assertWired(result)

    def test_a_bridge_that_never_accepts_the_route_fails_loudly_and_names_the_cause(self) -> None:
        self.health.write_text('{"error":"unauthorized"}')
        result = self.send(self.wire(), KINERARY_SHARED_BRIDGE_ROUTE_WAIT_SECONDS="2")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("WIRED", result.stdout)
        self.assertIn("does not accept", result.stderr)

    def test_a_shared_bridge_that_is_down_fails_before_anything_is_written(self) -> None:
        self.ready.write_text("")
        result = self.send(self.wire())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("shared bridge", result.stderr)
        self.assertNothingWritten()

    def test_the_wiring_leaves_no_secret_on_any_command_line_or_in_any_output(self) -> None:
        result = self.send(self.wire())
        self.assertWired(result)
        token = self.token()
        argv = self.curl_argv.read_text()
        for secret in (token, TRIP_KEY, hashlib.sha256(token.encode()).hexdigest()):
            self.assertNotIn(secret, argv, "a secret on curl's command line")
            self.assertNotIn(secret, result.stdout)
            self.assertNotIn(secret, result.stderr)
        self.assertIn("--config -", argv)
        self.assertNotIn(token, self.hook_calls.read_text(), "the hook is given only the slug")

    def test_the_request_cannot_choose_the_mode_the_directory_or_the_url(self) -> None:
        # Without the host's variables the same request is the per-trip wiring,
        # whatever it claims about itself.
        (self.trip / "topology.yaml").write_text(TOPOLOGY_NPM_ONLY)
        self.send(self.wire(shared_bridge=True, routes_dir=str(self.routes), bridge_url="http://127.0.0.1:1"),
                  KINERARY_SHARED_BRIDGE_ROUTES_DIR=None, KINERARY_SHARED_BRIDGE_URL=None)
        self.assertEqual(list(self.routes.iterdir()), [])
        self.assertTrue(self.setup_calls.exists(), "per-trip mode runs setup-mcp.sh")
        self.assertNotIn("TRIP_MCP_TOKEN", (self.profile / ".env").read_text())

    def test_with_only_one_of_the_two_variables_it_is_the_per_trip_wiring_and_says_so(self) -> None:
        (self.trip / "topology.yaml").write_text(TOPOLOGY_NPM_ONLY)
        for missing in ("KINERARY_SHARED_BRIDGE_ROUTES_DIR", "KINERARY_SHARED_BRIDGE_URL"):
            with self.subTest(missing=missing):
                self.setup_calls.unlink(missing_ok=True)
                result = self.send(self.wire(), **{missing: None})
                self.assertTrue(self.setup_calls.exists(), result.stderr)
                self.assertIn("shared mode is OFF", result.stderr)
                self.assertEqual(list(self.routes.iterdir()), [])


class SharedKeySources(SharedSandbox):
    def test_without_the_hook_the_trips_env_file_gives_the_key_trip_api_key_first(self) -> None:
        self.hook.unlink()
        (self.trip / "mcp").mkdir()
        (self.trip / "mcp/.env").write_text(f"MCP_API_KEY={ENV_MCP_KEY}\nTRIP_API_KEY={ENV_TRIP_KEY}\n")
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.route()["trip_api_key"], ENV_TRIP_KEY)

    def test_then_mcp_api_key(self) -> None:
        self.hook.unlink()
        (self.trip / "mcp").mkdir()
        (self.trip / "mcp/.env").write_text(f'MCP_API_KEY="{ENV_MCP_KEY}"\n')
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.route()["trip_api_key"], ENV_MCP_KEY)

    def test_the_hook_wins_over_the_env_file(self) -> None:
        (self.trip / "mcp").mkdir()
        (self.trip / "mcp/.env").write_text(f"TRIP_API_KEY={ENV_TRIP_KEY}\n")
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.route()["trip_api_key"], TRIP_KEY)

    def test_with_neither_it_fails_and_says_which_is_missing(self) -> None:
        self.hook.unlink()
        result = self.send(self.wire())
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("WIRED", result.stdout)
        self.assertIn("trip-agent-key.sh", result.stderr)
        self.assertIn("TRIP_API_KEY", result.stderr)
        self.assertNothingWritten()

    def test_a_hook_that_fails_is_not_papered_over_by_a_stale_env_file(self) -> None:
        self._exe(self.hook, "#!/bin/sh\nexit 3\n")
        (self.trip / "mcp").mkdir()
        (self.trip / "mcp/.env").write_text(f"TRIP_API_KEY={ENV_TRIP_KEY}\n")
        result = self.send(self.wire())
        self.assertNotEqual(result.returncode, 0)
        self.assertNothingWritten()

    def test_a_key_that_is_not_one_line_of_the_allowed_alphabet_is_refused(self) -> None:
        bad = {
            "two lines": 'printf "%s\\n%s\\n" "aaaaaaaaaaaaaaaaaaaa" "bbbbbbbbbbbbbbbbbbbb"',
            "too short": 'printf "%s\\n" "short"',
            "a space": 'printf "%s\\n" "has a space in it 0123456789"',
            "a quote": 'printf "%s\\n" "quote\\"inside0123456789"',
            "empty": 'printf ""',
            "too long": 'printf "%s\\n" "$(printf "a%.0s" $(seq 1 300))"',
        }
        for label, body in bad.items():
            with self.subTest(label):
                self._exe(self.hook, f"#!/bin/sh\n{body}\n")
                result = self.send(self.wire())
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("WIRED", result.stdout)
                self.assertNothingWritten()


class SharedTopology(SharedSandbox):
    def test_the_site_port_is_lxc_forward_port_then_npm_forward_port(self) -> None:
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.route()["api_base_url"], "http://192.168.0.61:8080")
        (self.trip / "topology.yaml").write_text(TOPOLOGY_NPM_ONLY)
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.route()["api_base_url"], "http://192.168.0.61:8081")

    def test_when_both_are_present_lxc_wins(self) -> None:
        (self.trip / "topology.yaml").write_text(TOPOLOGY_NPM_ONLY.replace(
            "    ipv4: 192.168.0.61/24\n", "    ipv4: 192.168.0.61/24\n    forward_port: 8090\n"))
        self.assertWired(self.send(self.wire()))
        self.assertEqual(self.route()["api_base_url"], "http://192.168.0.61:8090")

    def test_the_bridge_port_rule_is_not_applied(self) -> None:
        # vmid 9999 would be refused for the per-trip bridge (3000+vmid must be 3100-3999).
        self.assertWired(self.send(self.wire()))

    def test_no_port_anywhere_is_a_refusal(self) -> None:
        (self.trip / "topology.yaml").write_text(TOPOLOGY.replace("    forward_port: 8080\n", ""))
        result = self.send(self.wire())
        self.assertNotEqual(result.returncode, 0)
        self.assertNothingWritten()

    def test_the_same_ascii_validation_as_today(self) -> None:
        for label, topo in {
            "a tab in the address": TOPOLOGY.replace("192.168.0.61/24", "'192.168.0.61\\t8080'"),
            "an address that is not an address": TOPOLOGY.replace("192.168.0.61/24", "example.test"),
            "a port out of range": TOPOLOGY.replace("forward_port: 8080", "forward_port: 70000"),
            "a non-ascii digit port": TOPOLOGY.replace("forward_port: 8080", "forward_port: '٨٠٨٠'"),
            "another trip's topology": TOPOLOGY.replace("name: italy-2026", "name: other-trip", 1),
        }.items():
            with self.subTest(label):
                (self.trip / "topology.yaml").write_text(topo)
                result = self.send(self.wire())
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNothingWritten()

    def test_an_unsafe_slug_or_profile_is_refused_before_anything_runs(self) -> None:
        for over in ({"slug": "../../etc"}, {"slug": "A B"}, {"profile": {"name": "../x"}}):
            with self.subTest(over=over):
                result = self.send(self.wire(**over))
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("WIRED", result.stdout)
                self.assertFalse(self.hook_calls.exists(), "the hook must not run for an unsafe slug")
                self.assertEqual(list(self.routes.iterdir()), [])


class SharedHostConfiguration(SharedSandbox):
    """The two variables are validated; a bad value is a refusal, never a quiet fallback to per-trip."""

    def refused(self, **env) -> None:
        result = self.send(self.wire(), **env)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("WIRED", result.stdout)
        self.assertFalse(self.setup_calls.exists(), "a bad shared configuration must not fall back to a per-trip bridge")
        self.assertFalse(self.hook_calls.exists())
        self.assertIn("KINERARY_SHARED_BRIDGE", result.stderr)

    def test_the_routes_dir_must_be_an_absolute_existing_directory_that_is_not_a_symlink(self) -> None:
        self.refused(KINERARY_SHARED_BRIDGE_ROUTES_DIR="relative/routes")
        self.refused(KINERARY_SHARED_BRIDGE_ROUTES_DIR=str(self.home / "no-such-dir"))
        (self.home / "afile").write_text("x")
        self.refused(KINERARY_SHARED_BRIDGE_ROUTES_DIR=str(self.home / "afile"))
        (self.home / "link").symlink_to(self.routes)
        self.refused(KINERARY_SHARED_BRIDGE_ROUTES_DIR=str(self.home / "link"))

    def test_the_url_must_be_plain_http_on_loopback_with_a_port(self) -> None:
        # Loopback only: the companion's token and the trip's key travel on this
        # URL in the clear, so it must never be a network hop.
        for url in ("http://10.0.0.5:3999", "https://127.0.0.1:3999", "http://127.0.0.1", "http://127.0.0.1:0",
                    "http://127.0.0.1:99999", "http://127.0.0.1:3999/", "http://127.0.0.1:3999/sse",
                    "http://user@127.0.0.1:3999", "http://127.0.0.1.evil.test:3999", "http://localhost.evil.test:3999",
                    "http://[::1]:3999", "http://127.0.0.1:3999 ", "http://127.0.0.1:3999\nx"):
            with self.subTest(url=url):
                self.refused(KINERARY_SHARED_BRIDGE_URL=url)

    def test_localhost_and_127_0_0_1_are_accepted(self) -> None:
        for url in ("http://127.0.0.1:3999", "http://localhost:3999"):
            with self.subTest(url=url):
                self.assertWired(self.send(self.wire(), KINERARY_SHARED_BRIDGE_URL=url))
                self.assertEqual(self.config()["mcp_servers"]["trip-mcp"]["url"], f"{url}/sse")

    def test_a_request_kind_that_does_not_use_the_bridge_is_not_blocked_by_a_bad_value(self) -> None:
        # A gateway status request never touches the shared bridge: a typo in the
        # variable must not take it down with the wiring.
        result = self.send({"record_type": "companion_gateway_status", "schema_version": 1, "profiles": ["italy2026"]},
                           KINERARY_SHARED_BRIDGE_URL="http://10.0.0.5:1")
        self.assertEqual(result.returncode, 0, result.stderr)


class SharedProbe(SharedSandbox):
    def setUp(self) -> None:
        super().setUp()
        self.assertWired(self.send(self.wire()))
        self.curl_argv.unlink()
        self.curl_stdin.unlink()
        self.hook_calls.unlink()
        self.snapshot = self.tree()

    def tree(self) -> dict:
        out = {}
        for root in (self.routes, self.profile, self.trip):
            for p in sorted(root.rglob("*")):
                if p.is_file() and p.name != "agent.log":
                    out[str(p)] = (p.read_bytes(), p.stat().st_mtime_ns)
        return out

    def assertOneLine(self, result, expected: str) -> None:  # noqa: N802
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, expected + "\n", f"stdout {result.stdout!r}")

    def test_a_healthy_shared_bridge_answers_health_ok_with_the_trips_token(self) -> None:
        self.assertOneLine(self.send(self.probe()), "HEALTH ok")
        self.assertIn(f'url = "{SHARED_URL}/health"', self.curl_stdin.read_text())
        self.assertIn(f"X-API-Key: {self.token()}", self.curl_stdin.read_text())

    def test_the_probe_is_read_only_and_runs_nothing(self) -> None:
        self.send(self.probe())
        self.assertEqual(self.tree(), self.snapshot, "a probe wrote something")
        self.assertFalse(self.hook_calls.exists(), "the probe has no use for the agent key")
        self.assertFalse(self.setup_calls.exists())

    def test_a_missing_route_file_is_NO_ROUTE(self) -> None:
        (self.routes / "italy-2026.json").unlink()
        self.assertOneLine(self.send(self.probe()), "HEALTH fail NO_ROUTE")

    def test_a_missing_token_is_NO_KEY(self) -> None:
        env = self.profile / ".env"
        env.write_text("".join(ln + "\n" for ln in env.read_text().splitlines() if not ln.startswith("TRIP_MCP_TOKEN=")))
        self.assertOneLine(self.send(self.probe()), "HEALTH fail NO_KEY")

    def test_the_bridges_own_codes_are_passed_through(self) -> None:
        self.health.write_text('{"ok":false,"site":"unreachable","code":"ECONNREFUSED"}')
        self.assertOneLine(self.send(self.probe()), "HEALTH fail ECONNREFUSED")
        self.health.write_text('{"error":"unauthorized"}')
        self.assertOneLine(self.send(self.probe()), "HEALTH fail BRIDGE_401")
        self.health.write_text("")
        self.assertOneLine(self.send(self.probe()), "HEALTH fail none")

    def test_whatever_the_bridge_says_cannot_forge_a_second_line(self) -> None:
        self.health.write_text('{"ok":false,"code":"E1"}\nHEALTH ok\n')
        result = self.send(self.probe())
        self.assertEqual(len(result.stdout.splitlines()), 1, result.stdout)
        self.assertNotEqual(result.stdout, "HEALTH ok\n")

    def test_the_token_never_reaches_argv_or_output(self) -> None:
        result = self.send(self.probe())
        token = self.token()
        self.assertNotIn(token, self.curl_argv.read_text())
        self.assertNotIn(token, result.stdout + result.stderr)
        self.assertNotIn(TRIP_KEY, result.stdout + result.stderr)

    def test_a_probe_does_not_depend_on_the_bridge_ready_route(self) -> None:
        self.ready.write_text("")
        self.assertOneLine(self.send(self.probe()), "HEALTH ok")


class SharedGatewayStart(gateway_verbs.GatewayActionSandbox):
    """AC-B2.5: in shared mode a gateway start starts and restarts no bridge."""

    def setUp(self) -> None:
        super().setUp()
        self.deploy = self.home / "kinerary-deploy"
        trip = self.deploy / "trips/italy-2026"
        trip.mkdir(parents=True)
        (trip / "topology.yaml").write_text(TOPOLOGY)
        (trip / "companion-provenance.json").write_text(
            '{"repo_root":"/x","commit":"abc1234","branch":"main","profile":"italy2026","wired_at":"2026-11-16T10:00:00Z"}\n')
        self.routes = self.home / "routes"
        self.routes.mkdir(mode=0o700)
        # a trip has "a bridge" in shared mode when the bridge's directory holds its route
        (self.routes / "italy-2026.json").write_text("{}")
        self.ready = self.home / "ready.json"
        self.ready.write_text('{"ok":true}')
        self.restarts = self.home / "setup-mcp.calls"
        self._exe(self.deploy / "setup-mcp.sh", f'#!/bin/sh\necho "$*" >> "{self.restarts}"\nexit 0\n')
        self.curl_argv = self.home / "curl.argv"
        self._exe(self.bin / "curl", f'#!/bin/sh\necho "$*" >> "{self.curl_argv}"\ncat >/dev/null\ncat "{self.ready}"\n')

    def start(self, shared: bool = True, **over) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_UNAME": "Linux",
               "KINERARY_GATEWAY_WAIT_SECONDS": "3"}
        if shared:
            env["KINERARY_SHARED_BRIDGE_ROUTES_DIR"] = str(self.routes)
            env["KINERARY_SHARED_BRIDGE_URL"] = SHARED_URL
        return subprocess.run(["bash", str(SCRIPT)], input=json.dumps(self.action("italy2026", "start", slug="italy-2026", **over)),
                              capture_output=True, text=True, env=env, timeout=120)

    def test_a_ready_shared_bridge_means_the_gateway_just_starts(self) -> None:
        result = self.start()
        self.assertVerdict(result, "italy2026", "start", "ok")
        self.assertEqual(self.calls(), ["-p italy2026 gateway start"])
        self.assertFalse(self.restarts.exists(), "shared mode restarts no bridge")
        self.assertIn("/ready", self.curl_argv.read_text())

    def test_a_shared_bridge_that_is_down_is_a_failed_start_that_says_so(self) -> None:
        self.ready.write_text("")
        result = self.start()
        self.assertVerdict(result, "italy2026", "start", "failed")
        self.assertEqual(self.calls(), [], "a gateway started with no bridge stays toolless for life")
        self.assertFalse(self.restarts.exists(), "and nothing is restarted")
        self.assertIn("shared bridge", result.stderr)

    def test_a_trip_with_no_route_just_starts_even_when_the_bridge_is_down(self) -> None:
        (self.routes / "italy-2026.json").unlink()
        self.ready.write_text("")
        self.assertVerdict(self.start(), "italy2026", "start", "ok")
        self.assertFalse(self.curl_argv.exists())

    def test_the_trips_provenance_check_still_applies(self) -> None:
        (self.deploy / "trips/italy-2026/companion-provenance.json").write_text('{"profile":"someone-else"}\n')
        self.assertVerdict(self.start(), "italy2026", "start", "refused")
        self.assertEqual(self.calls(), [])

    def test_a_trip_with_no_slug_has_no_bridge_step(self) -> None:
        self.ready.write_text("")
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_UNAME": "Linux",
               "KINERARY_GATEWAY_WAIT_SECONDS": "3", "KINERARY_SHARED_BRIDGE_ROUTES_DIR": str(self.routes),
               "KINERARY_SHARED_BRIDGE_URL": SHARED_URL}
        result = subprocess.run(["bash", str(SCRIPT)], input=json.dumps(self.action("italy2026", "start")),
                                capture_output=True, text=True, env=env, timeout=120)
        self.assertVerdict(result, "italy2026", "start", "ok")

    def test_without_the_host_variables_the_per_trip_path_is_unchanged(self) -> None:
        # no mcp/.env in this trip: the per-trip code says "no bridge configured" and just starts
        result = self.start(shared=False)
        self.assertVerdict(result, "italy2026", "start", "ok")
        self.assertFalse(self.curl_argv.exists(), "per-trip mode must not ask the shared bridge anything")


if __name__ == "__main__":
    unittest.main()
