"""control-plane/deployment/vm-invite.py — what the gate lets through.

The gate is the second half of the invitation door: the agent's MCP validates
locally, and this validates again on the host, where the argument actually
turns into a call. Tested without a control plane by checking what `parse_gate`
accepts and refuses, and by pointing the tool at a stand-in API.

    python3 -m unittest discover -s tests/scripts
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "control-plane" / "deployment" / "vm-invite.py"
spec = importlib.util.spec_from_file_location("vm_invite", SCRIPT)
vm_invite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm_invite)


class GateParsing(unittest.TestCase):
    def test_the_verbs_are_fixed(self):
        self.assertEqual(vm_invite.parse_gate(["preview", "a@example.com"]), ("preview", ["a@example.com"]))
        self.assertEqual(
            vm_invite.parse_gate(["create", "a@example.com", "he", "dror"]),
            ("create", ["a@example.com", "he", "dror"]),
        )
        self.assertEqual(vm_invite.parse_gate(["help"]), ("help", []))

    def test_anything_else_is_refused(self):
        for tokens in [[], ["status"], ["reset-password", "a@example.com"], ["create"],
                       ["preview"], ["preview", "a@example.com", "extra"],
                       ["create", "a@example.com", "he"], ["create", "a@example.com", "fr", "dror"]]:
            with self.assertRaises(vm_invite.Refusal, msg=f"accepted {tokens}"):
                vm_invite.parse_gate(tokens)

    def test_a_token_that_could_mean_something_to_a_shell_is_refused(self):
        for token in ["a@example.com;whoami", "$(whoami)@example.com", "a@example.com|tee",
                      "../../etc/passwd", "a@example.com`id`", "a b@example.com", "*"]:
            with self.assertRaises(vm_invite.Refusal, msg=f"accepted {token!r}"):
                vm_invite.parse_gate(["preview", token])

    def test_an_address_has_to_look_like_one(self):
        for address in ["a@b", "@example.com", "someone@", "someone@example", "x" * 80 + "@example.com"]:
            with self.assertRaises(vm_invite.Refusal, msg=f"accepted {address!r}"):
                vm_invite.parse_gate(["preview", address])

    def test_nothing_in_the_tool_names_a_host_a_key_or_a_bot(self):
        source = SCRIPT.read_text()
        for secret in ["192.168.", "id_ed25519", "Kinerary_bot", "ara-united"]:
            self.assertNotIn(secret, source, f"{secret} is infrastructure data, and this repo is public")


class EnvReading(unittest.TestCase):
    def test_an_env_file_is_read_the_way_a_shell_would(self):
        values = vm_invite.read_env_text(
            "# a comment\n"
            "export CONTROL_PLANE_OPERATOR_KEY=abc123\n"
            'KINERARY_API="http://127.0.0.1:4310"\n'
            "\n"
            "EMPTY=\n"
        )
        self.assertEqual(values["CONTROL_PLANE_OPERATOR_KEY"], "abc123")
        self.assertEqual(values["KINERARY_API"], "http://127.0.0.1:4310")
        self.assertEqual(values["EMPTY"], "")


class _Handler(BaseHTTPRequestHandler):
    """A stand-in control plane that records what it was asked."""

    calls: list = []

    def do_POST(self):  # noqa: N802 — BaseHTTPRequestHandler's spelling
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or "{}")
        # Lowercased: urllib sends "X-api-key", and a test that asserts one
        # spelling would fail on a client that picks another.
        _Handler.calls.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        if self.path.endswith("/preview"):
            payload = {"ok": True, "plan": {"kind": "new", "tripId": None, "tripSlug": None, "existing": []}}
            status = 200
        else:
            payload = {
                "kind": "new", "tripId": "trip_abc", "invitationId": "invt_abc",
                "deepLink": "https://t.me/a_bot?start=tok", "expiresAt": "2026-09-19T00:00:00.000Z",
                "language": "he", "message": "היי! זה הקישור שלכם\nhttps://t.me/a_bot?start=tok",
            }
            status = 201
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_args):  # keep the test output clean
        return


class AgainstAStandInControlPlane(unittest.TestCase):
    def setUp(self):
        _Handler.calls = []
        self.server = HTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.tmp = Path(tempfile.mkdtemp())
        env = self.tmp / "vm.env"
        env.write_text(
            f"KINERARY_API=http://127.0.0.1:{self.server.server_port}\n"
            "CONTROL_PLANE_OPERATOR_KEY=operator-key\n"
            "KINERARY_BOT_USERNAME=a_bot\n"
            f"TELEGRAM_BOT_TOKEN_FILE={self.tmp}/no-token\n"
        )
        self.facts = vm_invite.read_env_text(env.read_text())

    def tearDown(self):
        self.server.shutdown()

    def test_the_operator_key_is_presented_and_the_address_is_sent_once(self):
        code = vm_invite.cmd_preview(self.facts, "someone@example.com")
        self.assertEqual(code, 0)
        path, headers, body = _Handler.calls[0]
        self.assertEqual(path, "/internal/operator/invitations/preview")
        self.assertEqual(headers.get("x-api-key"), "operator-key")
        self.assertEqual(body, {"email": "someone@example.com"})

    def test_creating_carries_the_language_the_bot_and_who_asked(self):
        code = vm_invite.cmd_create(self.facts, "someone@example.com", "he", "dror")
        self.assertEqual(code, 0)
        _path, _headers, body = _Handler.calls[0]
        self.assertEqual(body["language"], "he")
        self.assertEqual(body["invitedBy"], "dror")
        # No reachable token, so the configured handle is the fallback.
        self.assertEqual(body["botUsername"], "a_bot")

    def test_without_an_operator_key_it_says_what_is_missing_rather_than_calling(self):
        facts = {k: v for k, v in self.facts.items() if k != "CONTROL_PLANE_OPERATOR_KEY"}
        with self.assertRaises(vm_invite.Refusal) as caught:
            vm_invite.cmd_preview(facts, "someone@example.com")
        self.assertIn("CONTROL_PLANE_OPERATOR_KEY", str(caught.exception))
        self.assertEqual(_Handler.calls, [])


if __name__ == "__main__":
    unittest.main()
