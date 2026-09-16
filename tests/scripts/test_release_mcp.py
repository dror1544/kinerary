""".agents/skills/control-plane-release/release-mcp.mjs — trip-monitor's release tools.

The MCP server is the agent's whole reach onto the production control plane's
version, so what is pinned here is what it can send: a fixed catalogue of gate
verbs, every argument validated locally before the VM validates it again, the
SSH call strict about the host key and aimed only at the gate user, no tool
that forwards free text — and no address or key name in the server itself: it
reads them from the private kinerary-deploy repo's control-plane.env.

RELEASE_MCP_ECHO=1 makes each tool return the ssh argv it would run instead of
running it, so none of this needs the VM.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2] / ".agents" / "skills" / "control-plane-release" / "release-mcp.mjs"
NODE = shutil.which("node")


def call(messages: list[dict], config: dict | None, extra_env: dict | None = None) -> list[dict]:
    tmp = Path(tempfile.mkdtemp())
    env = {**os.environ, "RELEASE_MCP_ECHO": "1", "HOME": str(tmp)}
    if config is not None:
        path = tmp / "control-plane.env"
        path.write_text("# facts\n" + "".join(f"{k}={v}\n" for k, v in config.items()))
        env["KINERARY_RELEASE_CONFIG"] = str(path)
    else:
        env["KINERARY_RELEASE_CONFIG"] = str(tmp / "missing.env")
    env.update(extra_env or {})
    stdin = "".join(json.dumps(m) + "\n" for m in messages)
    proc = subprocess.run([NODE, str(SERVER)], input=stdin, capture_output=True, text=True, env=env, timeout=30)
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


GOOD = {"CP_RELEASE_GATE_TARGET": "cprelease@cp.example", "CP_RELEASE_GATE_KEY_ON_MAC": "~/.ssh/release_gate",
        "CP_RELEASE_GATE_KNOWN_HOSTS_ON_MAC": "~/.ssh/known_hosts_cp"}


def tool(name: str, arguments: dict | None = None, id_: int = 2) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}}


@unittest.skipUnless(NODE, "node is not installed")
class ReleaseMcp(unittest.TestCase):
    def result_text(self, responses: list[dict], id_: int = 2) -> tuple[str, bool]:
        response = next(r for r in responses if r.get("id") == id_)
        result = response["result"]
        return result["content"][0]["text"], bool(result.get("isError"))

    def argv_for(self, name: str, arguments: dict | None = None) -> list[str]:
        text, is_error = self.result_text(call([tool(name, arguments)], GOOD))
        self.assertFalse(is_error, text)
        return json.loads(text)

    def test_the_catalogue_is_fixed(self):
        responses = call([{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}], GOOD)
        names = sorted(t["name"] for t in responses[0]["result"]["tools"])
        self.assertEqual(names, sorted([
            "release_status", "release_help", "release_history", "release_snapshots", "release_verify",
            "release_plan", "release_dry_run", "release_request", "release_approve", "release_result", "release_cancel",
        ]))

    def test_the_call_is_strict_and_goes_only_to_the_gate_user(self):
        argv = self.argv_for("release_request", {"action": "upgrade", "rev": "main"})
        self.assertIn("StrictHostKeyChecking=yes", argv)
        self.assertIn("BatchMode=yes", argv)
        self.assertTrue(any(a.startswith("UserKnownHostsFile=") and a.endswith("known_hosts_cp") for a in argv))
        self.assertEqual(argv[-2], "cprelease@cp.example")
        self.assertEqual(argv[-1], "request upgrade main")

    def test_each_tool_maps_to_one_gate_command(self):
        cases = [
            ("release_status", {}, "status"),
            ("release_plan", {"rev": "3a9f1c2"}, "plan 3a9f1c2"),
            ("release_dry_run", {"action": "rollback", "restore_db": True}, "dry-run rollback --restore-db"),
            ("release_dry_run", {"action": "rollback", "to": "aa61f6e"}, "dry-run rollback --to aa61f6e"),
            ("release_request", {"action": "upgrade", "rev": "3a9f1c2", "hermes_rev": "ab0d98414"}, "request upgrade 3a9f1c2 --hermes-rev ab0d98414"),
            ("release_request", {"action": "prune"}, "request prune"),
            ("release_approve", {"request_id": "r-7", "code": "482913"}, "approve r-7 482913"),
            ("release_result", {"request_id": "r-7"}, "result r-7"),
            ("release_cancel", {"request_id": "r-7"}, "cancel r-7"),
        ]
        for name, arguments, expected in cases:
            self.assertEqual(self.argv_for(name, arguments)[-1], expected, name)

    def test_bad_input_is_refused_before_anything_is_sent(self):
        cases = [
            ("release_request", {"action": "upgrade", "rev": "main; reboot"}),
            ("release_request", {"action": "upgrade", "rev": "feature/x"}),
            ("release_request", {"action": "upgrade"}),
            ("release_request", {"action": "install"}),
            ("release_request", {"action": "rollback", "to": "main"}),
            ("release_request", {"action": "prune", "restore_db": True}),
            ("release_plan", {"rev": "$(id)"}),
            ("release_approve", {"request_id": "r-7", "code": "48291"}),
            ("release_approve", {"request_id": "7", "code": "482913"}),
            ("release_approve", {"request_id": "r-7", "code": "482913 extra"}),
        ]
        for name, arguments in cases:
            text, is_error = self.result_text(call([tool(name, arguments)], GOOD))
            self.assertTrue(is_error, f"{name} {arguments}: {text}")
            self.assertTrue(text.startswith("Tool refused"), text)

    def test_the_config_must_name_the_gate_user(self):
        wrong_user = {**GOOD, "CP_RELEASE_GATE_TARGET": "debian@cp.example"}
        text, is_error = self.result_text(call([tool("release_status")], wrong_user))
        self.assertTrue(is_error)
        self.assertIn("cprelease", text)
        no_pin = {k: v for k, v in GOOD.items() if k != "CP_RELEASE_GATE_KNOWN_HOSTS_ON_MAC"}
        text, is_error = self.result_text(call([tool("release_status")], no_pin))
        self.assertTrue(is_error)
        self.assertIn("CP_RELEASE_GATE_KNOWN_HOSTS_ON_MAC", text)

    def test_the_server_itself_carries_no_infrastructure(self):
        source = SERVER.read_text()
        for needle in ("192.168.", "id_ed25519", "Kinerary_bot", "/Users/"):
            self.assertNotIn(needle, source, needle)

    def test_a_named_config_that_is_missing_is_refused(self):
        text, is_error = self.result_text(call([tool("release_status")], None))
        self.assertTrue(is_error)
        self.assertIn("does not exist", text)


if __name__ == "__main__":
    unittest.main()
