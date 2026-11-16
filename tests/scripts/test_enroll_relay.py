"""scripts/companion-install-host.sh `enroll_relay` — which relay key a gateway is given.

docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, AC-K1.1 and AC-K1.4.

In `shared` mode (the default, and what an architecture profile with no
`relay.gateway_key_mode` means) a profile gets the relay's master secret. In
`both` and `derived` it gets `derive(master, profile name)` and the master never
reaches its `.env`. COMPANION_CONTROL_TOKEN is minted with whichever key was
written.

Drives the real function in isolation, the way test_companion_install_host_shared
drives its own: the text of `enroll_relay` is cut out of the script and run in a
sandboxed HOME. The only edit is that `/usr/bin/python3` is replaced by a wrapper
that records its argv, because "no key on a command line" is the property under
test and a recording is the only way to see a command line that has already
exited. This file does not depend on launchd, a hermes stand-in or PATH tricks,
so it runs the same on Linux and macOS.
"""
from __future__ import annotations

import json
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "companion-install-host.sh"
VECTORS = json.loads((REPO / "control-plane/api/test/fixtures/relay-key-vectors.json").read_text(encoding="utf-8"))["vectors"]

MASTER = "master-secret-one"
PROFILE = "trip-example-a"


def extract_enroll_relay() -> str:
    """The function's text. Its closing brace is not the first `}` at column 0:
    the inline Python holds a dict literal that ends that way. The last line
    before the real end is the one that says it enrolled, so cut there."""
    text = SCRIPT.read_text(encoding="utf-8")
    match = re.search(r"^enroll_relay\(\) \{\n.*?enrolled %s with the relay[^\n]*\n\}\n", text, re.S | re.M)
    assert match, f"enroll_relay not found in {SCRIPT}"
    return match.group(0)


class EnrollRelay(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        self.argv_log = Path(self.tmp.name) / "python-argv.log"
        wrapper = self.bin / "python3-recording"
        wrapper.write_text(
            "#!/bin/sh\n"
            f"printf '%s\\n' \"$*\" >> '{self.argv_log}'\n"
            f"exec '{sys.executable}' \"$@\"\n"
        )
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
        body = extract_enroll_relay()
        self.assertIn("/usr/bin/python3", body)
        self.function = body.replace("/usr/bin/python3", str(wrapper))
        self.secret_file = Path(self.tmp.name) / "relay.secret"
        self.secret_file.write_text(MASTER + "\n")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def arch(self, **relay_extra: object) -> Path:
        path = Path(self.tmp.name) / "architecture.json"
        path.write_text(json.dumps({
            "relay": {
                "bind_host": "127.0.0.1",
                "port": 4312,
                "gateway_secret_refs": [f"file://{self.secret_file}"],
                **relay_extra,
            }
        }))
        return path

    def enroll(self, arch: Path, name: str = PROFILE) -> subprocess.CompletedProcess:
        script = f'set -euo pipefail\nARCH_PROFILE="{arch}"\n{self.function}\nenroll_relay "{name}"\n'
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin"}
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env, timeout=60)

    def env_file(self, name: str = PROFILE) -> Path:
        return self.home / ".hermes" / "profiles" / name / ".env"

    def env_values(self, name: str = PROFILE) -> dict[str, str]:
        out = {}
        for line in self.env_file(name).read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                out[key] = value
        return out

    def make_profile(self, name: str = PROFILE) -> None:
        (self.home / ".hermes" / "profiles" / name).mkdir(parents=True, exist_ok=True)

    def vector(self, gateway_id: str) -> dict:
        return next(v for v in VECTORS if v["id"] == gateway_id)

    # -- the master, for the modes that hand it out ------------------------------

    def test_no_mode_in_the_profile_writes_the_master(self) -> None:
        self.make_profile()
        result = self.enroll(self.arch())
        self.assertEqual(result.returncode, 0, result.stderr)
        values = self.env_values()
        self.assertEqual(values["GATEWAY_RELAY_SECRET"], MASTER)
        self.assertEqual(values["GATEWAY_RELAY_ID"], PROFILE)
        self.assertEqual(values["GATEWAY_RELAY_URL"], "http://127.0.0.1:4312")

    def test_shared_control_token_is_signed_with_the_master(self) -> None:
        self.make_profile()
        self.enroll(self.arch(gateway_key_mode="shared"))
        self.assertEqual(self.env_values()["GATEWAY_RELAY_SECRET"], MASTER)
        # A master-signed token for this id, in the relay's own format.
        import base64, hashlib, hmac
        signed = f"{PROFILE}:0"
        sig = hmac.new(MASTER.encode(), signed.encode(), hashlib.sha256).hexdigest()
        expected = base64.urlsafe_b64encode(f"{signed}:{sig}".encode()).decode().rstrip("=")
        self.assertEqual(self.env_values()["COMPANION_CONTROL_TOKEN"], expected)

    # -- the derived key ----------------------------------------------------------

    def test_derived_and_both_write_the_vector_key_and_token(self) -> None:
        # Shared with the TypeScript tests: the same vector file, the same bytes.
        for mode in ("both", "derived"):
            for vector in VECTORS:
                with self.subTest(mode=mode, id=vector["id"]):
                    self.secret_file.write_text(vector["master"] + "\n")
                    name = vector["id"]
                    self.make_profile(name)
                    result = self.enroll(self.arch(gateway_key_mode=mode), name)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    values = self.env_values(name)
                    self.assertEqual(values["GATEWAY_RELAY_SECRET"], vector["derived"])
                    self.assertEqual(values["COMPANION_CONTROL_TOKEN"], vector["token"])
                    self.assertEqual(values["GATEWAY_RELAY_ID"], name)

    def test_the_master_is_nowhere_in_the_env_file_in_derived_and_both(self) -> None:
        for mode in ("both", "derived"):
            with self.subTest(mode=mode):
                self.make_profile()
                result = self.enroll(self.arch(gateway_key_mode=mode))
                self.assertEqual(result.returncode, 0, result.stderr)
                text = self.env_file().read_text()
                self.assertNotIn(MASTER, text)
                self.assertNotIn(MASTER, result.stdout + result.stderr)
                self.assertEqual(stat.S_IMODE(self.env_file().stat().st_mode), 0o600)

    def test_a_rerun_replaces_the_managed_lines_and_keeps_the_rest(self) -> None:
        self.make_profile()
        self.env_file().write_text("OTHER_SETTING=kept\nGATEWAY_RELAY_SECRET=old-master-value\n")
        self.enroll(self.arch(gateway_key_mode="derived"))
        self.enroll(self.arch(gateway_key_mode="derived"))
        text = self.env_file().read_text()
        self.assertIn("OTHER_SETTING=kept", text)
        self.assertEqual(text.count("GATEWAY_RELAY_SECRET="), 1)
        self.assertNotIn("old-master-value", text)

    # -- nothing on a command line -------------------------------------------------

    def test_no_key_is_ever_on_a_command_line(self) -> None:
        for mode in (None, "shared", "both", "derived"):
            with self.subTest(mode=mode):
                self.make_profile()
                self.argv_log.write_text("")
                arch = self.arch(gateway_key_mode=mode) if mode else self.arch()
                result = self.enroll(arch)
                self.assertEqual(result.returncode, 0, result.stderr)
                argv = self.argv_log.read_text()
                self.assertTrue(argv.strip(), "the wrapper recorded nothing: the test is not looking at the real calls")
                derived = next(v["derived"] for v in VECTORS if v["master"] == "master-secret-one" and v["id"] == "trip-example-a")
                for secret in (MASTER, derived):
                    self.assertNotIn(secret, argv)
                # ...nor the token, which is as good as the key for the companion MCP.
                self.assertNotIn(self.env_values()["COMPANION_CONTROL_TOKEN"], argv)

    # -- refusing, loudly ------------------------------------------------------------

    def test_an_unknown_mode_enrols_nothing_and_says_so(self) -> None:
        self.make_profile()
        result = self.enroll(self.arch(gateway_key_mode="Derived"))
        self.assertEqual(result.returncode, 0)
        self.assertIn("UNENROLLED", result.stderr)
        self.assertIn("gateway_key_mode", result.stderr)
        self.assertFalse(self.env_file().exists(), "nothing may be written under a mode this script does not know")

    def test_an_empty_secret_file_enrols_nothing_in_any_mode(self) -> None:
        self.secret_file.write_text("\n")
        for mode in ("shared", "derived"):
            with self.subTest(mode=mode):
                self.make_profile()
                result = self.enroll(self.arch(gateway_key_mode=mode))
                self.assertIn("UNENROLLED", result.stderr)
                self.assertFalse(self.env_file().exists())


if __name__ == "__main__":
    unittest.main()
