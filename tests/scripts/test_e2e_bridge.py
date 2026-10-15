"""The e2e's macOS-only bridge restart (scripts/e2e-full-cycle.py, stage_bridge_reach).

CLAUDE.md, "A Mac-provisioned companion that cannot read its own trip": the
worker's SSH-launched trip-mcp bridge has no Local Network grant, so every
unattended Mac run failed the companion stage. The run restarts the bridge from
its own process on Darwin and asserts the bridge's /health says the trip is
reachable. Nothing here runs a subprocess: `run` is a recorder.
"""
from __future__ import annotations

import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "e2e-full-cycle.py"
KEY = "sekrit-key-123"


def load():
    spec = importlib.util.spec_from_file_location("e2e_full_cycle", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BridgeOnMac(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load()
        self.tmp = Path(tempfile.mkdtemp(prefix="bridge-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / "deploy"
        self.env_file = self.deploy / "trips" / "alsace" / "mcp" / ".env"
        self.env_file.parent.mkdir(parents=True)
        self.env_file.write_text(f"MCP_API_KEY={KEY}\nMCP_PORT=3142\n")
        self.repo = self.tmp / "checkout"
        self.ctx = {"slug": "alsace", "vmid": 142}
        self.calls: list[dict] = []

    def fake_run(self, health='{"ok":true}', restart_code=0, healths=None):
        answers = list(healths) if healths is not None else None

        def run(argv, **kw):
            self.calls.append({"argv": argv, **kw})
            if argv[0] == "curl":
                body = answers.pop(0) if answers else health
                return subprocess.CompletedProcess(argv, 0, stdout=body, stderr="")
            return subprocess.CompletedProcess(argv, restart_code, stdout=None, stderr=None)
        return run

    def go(self, system, run=None):
        return self.mod.stage_bridge_reach(
            self.ctx, system=system, run=run or self.fake_run(), sleep=lambda s: None,
            deploy_root=self.deploy, repo=self.repo)

    def curls(self):
        return [c for c in self.calls if c["argv"][0] == "curl"]

    def test_not_darwin_does_nothing_at_all(self) -> None:
        for system in ("Linux", "Windows", ""):
            self.calls.clear()
            self.assertFalse(self.go(system))
            self.assertEqual(self.calls, [], f"{system!r} must not run anything")
        self.assertIsNone(self.mod.bridge_restart_command("Linux", self.deploy, "alsace", self.repo))

    def test_darwin_runs_the_wrappers_documented_command_from_the_deploy_root(self) -> None:
        self.assertTrue(self.go("Darwin"))
        restart = self.calls[0]
        self.assertEqual(restart["argv"], [str(self.deploy / "setup-mcp.sh"), "--restart-only",
                                           "--trip-dir", str(self.deploy / "trips" / "alsace")])
        self.assertEqual(restart["env"]["REPO_ROOT"], str(self.repo))
        self.assertIs(restart["stdin"], subprocess.DEVNULL)

    def test_the_deploy_root_is_never_a_literal_in_the_script(self) -> None:
        # Hard rule 6: the path comes from KINERARY_DEPLOY_ROOT / the module's DEPLOY_ROOT.
        source = SCRIPT.read_text()
        start = source.index("def bridge_restart_command")
        body = source[start:source.index("def stage_companion(ctx", start)]
        self.assertNotIn("/Users/", body)
        self.assertNotIn("kinerary-deploy", body.replace("deploy wrapper", ""))

    def test_the_key_goes_to_curl_on_stdin_never_on_argv(self) -> None:
        self.go("Darwin")
        (health,) = self.curls()
        self.assertEqual(health["argv"], ["curl", "--config", "-"])
        self.assertIn(KEY, health["input"])
        self.assertIn(":3142/health", health["input"])
        for call in self.calls:
            self.assertNotIn(KEY, " ".join(call["argv"]))

    def test_port_falls_back_to_3000_plus_the_vmid(self) -> None:
        self.env_file.write_text(f"MCP_API_KEY={KEY}\n")
        self.go("Darwin")
        (health,) = self.curls()
        self.assertIn(":3142/health", health["input"])

    def test_a_bridge_that_cannot_reach_the_trip_fails_the_run_without_printing_the_key(self) -> None:
        body = '{"ok":false,"code":"EHOSTUNREACH","detail":"' + KEY + '"}'
        with self.assertRaises(self.mod.Failed) as caught:
            self.go("Darwin", run=self.fake_run(health=body))
        self.assertIn("EHOSTUNREACH", str(caught.exception))
        self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(len(self.curls()), 5, "asked a few times before giving up")

    def test_a_bridge_that_is_slow_to_come_up_is_asked_again(self) -> None:
        self.assertTrue(self.go("Darwin", run=self.fake_run(healths=["", "", '{"ok":true}'])))

    def test_a_failed_restart_fails_the_run_and_asks_no_health(self) -> None:
        with self.assertRaises(self.mod.Failed) as caught:
            self.go("Darwin", run=self.fake_run(restart_code=1))
        self.assertIn("--restart-only failed", str(caught.exception))
        self.assertEqual(self.curls(), [])

    def test_a_trip_with_no_bridge_key_fails_before_restarting_anything(self) -> None:
        self.env_file.unlink()
        with self.assertRaises(self.mod.Failed):
            self.go("Darwin")
        self.assertEqual(self.calls, [])

    def test_it_runs_after_the_build_and_before_the_companion_stage(self) -> None:
        source = SCRIPT.read_text()
        self.assertLess(source.index("        stage_served(ctx)\n        stage_bridge_reach(ctx)"),
                        source.index("        stage_companion(ctx)\n"))


if __name__ == "__main__":
    unittest.main()
