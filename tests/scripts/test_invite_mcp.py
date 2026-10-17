""".agents/skills/organizer-invites/invite-mcp.mjs — what an agent may send.

This server is a monitoring agent's only write onto a control plane, so what is
pinned here is the size of the door: a fixed pair of verbs, every argument
validated locally before the host validates it again, an SSH call strict about
the host key and aimed only at the gate user, and no tool that forwards free
text.

INVITE_MCP_ECHO=1 makes each tool return the ssh argv it would run instead of
running it, so none of this needs a host.

    python3 -m unittest discover -s tests/scripts
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2] / ".agents" / "skills" / "organizer-invites" / "invite-mcp.mjs"
NODE = shutil.which("node")

GOOD = {
    "CP_INVITE_GATE_TARGET": "cpinvite@cp.example",
    "CP_INVITE_GATE_KEY_ON_MAC": "~/.ssh/invite_gate",
    "CP_INVITE_GATE_KNOWN_HOSTS_ON_MAC": "~/.ssh/known_hosts_cp",
}


def tool(name: str, arguments: dict | None = None, id_: int = 2) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}}


@unittest.skipUnless(NODE, "node is not installed")
class InviteMcp(unittest.TestCase):
    def call(self, messages: list[dict], config: dict | None = GOOD) -> list[dict]:
        tmp = Path(tempfile.mkdtemp())
        env = {**os.environ, "INVITE_MCP_ECHO": "1", "HOME": str(tmp)}
        if config is not None:
            path = tmp / "control-plane.env"
            path.write_text("# facts\n" + "".join(f"{k}={v}\n" for k, v in config.items()))
            env["KINERARY_INVITE_CONFIG"] = str(path)
        else:
            env["KINERARY_INVITE_CONFIG"] = str(tmp / "missing.env")
        stdin = "".join(json.dumps(m) + "\n" for m in messages)
        proc = subprocess.run([NODE, str(SERVER)], input=stdin, capture_output=True, text=True, env=env, timeout=30)
        return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]

    def result_text(self, responses: list[dict], id_: int = 2) -> tuple[str, bool]:
        response = next(r for r in responses if r.get("id") == id_)
        result = response["result"]
        return result["content"][0]["text"], bool(result.get("isError"))

    def argv_for(self, name: str, arguments: dict | None = None, config: dict | None = GOOD) -> list[str]:
        text, is_error = self.result_text(self.call([tool(name, arguments)], config))
        self.assertFalse(is_error, text)
        return json.loads(text)

    def test_the_catalogue_is_fixed(self):
        responses = self.call([{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
        names = sorted(t["name"] for t in responses[0]["result"]["tools"])
        self.assertEqual(names, ["invite_create", "invite_help", "invite_preview"])

    def test_no_tool_accepts_a_command_a_trip_id_or_a_password(self):
        responses = self.call([{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
        for definition in responses[0]["result"]["tools"]:
            properties = set(definition["inputSchema"].get("properties", {}))
            self.assertEqual(properties - {"email", "language", "requested_by"}, set(), definition["name"])

    def test_the_call_is_strict_and_goes_only_to_the_gate_user(self):
        argv = self.argv_for("invite_preview", {"email": "someone@example.com"})
        self.assertTrue(argv[0].endswith("ssh"), argv[0])
        self.assertIn("cpinvite@cp.example", argv)
        joined = " ".join(argv)
        self.assertIn("StrictHostKeyChecking=yes", joined)
        self.assertIn("BatchMode=yes", joined)
        self.assertIn("IdentitiesOnly=yes", joined)
        # The whole remote side is ONE argument, and it is only ever verbs.
        self.assertEqual(argv[-1], "preview someone@example.com")

    def test_an_address_that_is_not_an_address_never_leaves_this_machine(self):
        for email in ["", "not-an-email", "a@b", "someone@example.com; rm -rf /", "a b@example.com",
                      "$(whoami)@example.com", "someone@example.com\nwhoami"]:
            text, is_error = self.result_text(self.call([tool("invite_preview", {"email": email})]))
            self.assertTrue(is_error, f"accepted {email!r}")
            self.assertIn("Refused", text)

    def test_a_language_the_interview_cannot_speak_is_refused(self):
        text, is_error = self.result_text(self.call([tool("invite_create", {
            "email": "someone@example.com", "language": "fr", "requested_by": "dror"})]))
        self.assertTrue(is_error)
        self.assertIn("en and he", text)

    def test_who_asked_is_carried_across_but_cannot_carry_anything_else(self):
        argv = self.argv_for("invite_create", {
            "email": "someone@example.com", "language": "he", "requested_by": "dror; cat /etc/passwd"})
        self.assertEqual(argv[-1], "create someone@example.com he drorcatetcpasswd")

    def test_an_invitation_must_say_who_asked_for_it(self):
        text, is_error = self.result_text(self.call([tool("invite_create", {
            "email": "someone@example.com", "language": "en", "requested_by": " "})]))
        self.assertTrue(is_error)
        self.assertIn("requested_by", text)

    def test_a_config_naming_another_user_is_refused(self):
        # The key is authorized only for the gate user. A config naming another
        # is either a mistake or a key with more power than this tool should hold.
        text, is_error = self.result_text(self.call(
            [tool("invite_preview", {"email": "someone@example.com"})],
            {**GOOD, "CP_INVITE_GATE_TARGET": "root@cp.example"},
        ))
        self.assertTrue(is_error)
        self.assertIn("cpinvite@", text)

    def test_without_the_deployment_s_own_facts_it_refuses_rather_than_guessing(self):
        text, is_error = self.result_text(self.call([tool("invite_preview", {"email": "someone@example.com"})], None))
        self.assertTrue(is_error)
        self.assertIn("control-plane.env", text)

    def test_nothing_in_the_server_names_a_host_a_key_or_a_bot(self):
        source = SERVER.read_text()
        for secret in ["192.168.", "id_ed25519", "Kinerary_bot", "ara-united"]:
            self.assertNotIn(secret, source, f"{secret} is infrastructure data, and this repo is public")


if __name__ == "__main__":
    unittest.main()
