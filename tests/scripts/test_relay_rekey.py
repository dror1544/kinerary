"""scripts/relay-rekey.py — move enrolled profiles to per-gateway relay keys.

docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, AC-K1.5, AC-K1.6 and AC-K1.8.

Profiles start out holding the SHARED secret (`relay.gateway_secret_refs`); the
re-key writes keys derived from the DERIVATION master
(`relay.gateway_key_master_refs[0]`), a different secret no profile has held. The
script refuses when the master is missing or equals a shared secret.

The real script, run as a subprocess against a sandboxed HOME and a sandboxed
architecture profile. The derived values are checked against the vector file the
TypeScript tests read (control-plane/api/test/fixtures/relay-key-vectors.json),
so the Python minter, the shell minter and the relay's verifier are pinned to one
set of bytes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "relay-rekey.py"
VECTORS = json.loads((REPO / "control-plane/api/test/fixtures/relay-key-vectors.json").read_text(encoding="utf-8"))["vectors"]

SHARED = "shared-secret-every-profile-holds"  # what every enrolled profile holds before the re-key
MASTER = "master-secret-one"  # the derivation master: no profile has held it
SHARED_ID = "trip-example-a"
INTERVIEWER_ID = "kinerary-trip-intake"


def derive(master: str, gateway_id: str) -> str:
    return hmac.new(master.encode(), f"kinerary-relay-gateway:v1:{gateway_id}".encode(), hashlib.sha256).hexdigest()


def token(gateway_id: str, key: str) -> str:
    signed = f"{gateway_id}:0"
    sig = hmac.new(key.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{signed}:{sig}".encode()).decode().rstrip("=")


class RelayRekey(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.profiles = self.home / ".hermes" / "profiles"
        self.profiles.mkdir(parents=True)
        self.shared_file = self.root / "relay.secret"
        self.shared_file.write_text(SHARED + "\n")
        self.master_file = self.root / "relay-key-master.secret"
        self.master_file.write_text(MASTER + "\n")
        self.arch = self.root / "architecture.json"
        self.write_arch("both")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_arch(self, mode: str | None, refs: list[str] | None = None, master_refs: object = "default") -> None:
        relay: dict = {
            "bind_host": "127.0.0.1",
            "port": 4312,
            "gateway_secret_refs": refs if refs is not None else [f"file://{self.shared_file}"],
        }
        if master_refs == "default":
            relay["gateway_key_master_refs"] = [f"file://{self.master_file}"]
        elif master_refs is not None:
            relay["gateway_key_master_refs"] = master_refs
        if mode is not None:
            relay["gateway_key_mode"] = mode
        self.arch.write_text(json.dumps({"relay": relay}))

    def profile(self, name: str, gateway_id: str | None, secret: str | None, with_token: bool = True,
                extra: str = "") -> Path:
        directory = self.profiles / name
        directory.mkdir(parents=True)
        lines = ["# written by the installer", "SOMETHING_ELSE=keep me", "GATEWAY_RELAY_URL=http://127.0.0.1:4312"]
        if gateway_id is not None:
            lines.append(f"GATEWAY_RELAY_ID={gateway_id}")
        if secret is not None:
            lines.append(f"GATEWAY_RELAY_SECRET={secret}")
        if with_token and gateway_id is not None and secret is not None:
            lines.append(f"COMPANION_CONTROL_TOKEN={token(gateway_id, secret)}")
        lines.append("HERMES_WRITE_SAFE_ROOT=/somewhere")
        env = directory / ".env"
        env.write_text("\n".join(lines) + "\n" + extra)
        env.chmod(0o600)
        return env

    def run_script(self, *args: str) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin", "KINERARY_ARCHITECTURE_PROFILE": str(self.arch)}
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=60)

    @staticmethod
    def values(env: Path) -> dict[str, str]:
        out = {}
        for line in env.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                out[k] = v
        return out

    # -- the plan changes nothing ---------------------------------------------------------

    def test_the_plan_names_the_change_and_writes_nothing(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED)
        before = env.read_text()
        result = self.run_script("--profile", "trip-one")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("trip-one", result.stdout)
        self.assertIn(SHARED_ID, result.stdout)
        self.assertIn("shared -> derived", result.stdout)
        self.assertIn("plan only", result.stdout)
        self.assertEqual(env.read_text(), before)

    def test_a_profile_already_holding_its_derived_key_is_reported_and_left_alone(self) -> None:
        env = self.profile("trip-one", SHARED_ID, derive(MASTER, SHARED_ID))
        before = env.read_text()
        for extra in ([], ["--execute"]):
            result = self.run_script("--profile", "trip-one", *extra)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("already derived", result.stdout)
            self.assertEqual(env.read_text(), before)

    # -- --execute -----------------------------------------------------------------------

    def test_execute_writes_the_vector_key_and_token_and_keeps_every_other_line(self) -> None:
        for vector in VECTORS:
            with self.subTest(id=vector["id"]):
                self.master_file.write_text(vector["master"])
                name = "trip-v" + hashlib.sha256(vector["id"].encode()).hexdigest()[:8]
                env = self.profile(name, vector["id"], SHARED)
                lines_before = env.read_text().splitlines()
                result = self.run_script("--profile", name, "--execute")
                self.assertEqual(result.returncode, 0, result.stderr)
                values = self.values(env)
                self.assertEqual(values["GATEWAY_RELAY_SECRET"], vector["derived"])
                self.assertEqual(values["COMPANION_CONTROL_TOKEN"], vector["token"])
                # Every other line is byte-for-byte what it was.
                lines_after = env.read_text().splitlines()
                self.assertEqual(len(lines_after), len(lines_before))
                for before, after in zip(lines_before, lines_after):
                    if not before.startswith(("GATEWAY_RELAY_SECRET=", "COMPANION_CONTROL_TOKEN=")):
                        self.assertEqual(before, after)
                self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)

    def test_it_uses_each_profiles_own_gateway_id_not_its_name(self) -> None:
        # The interviewer's profile is `trip-intake` and its gateway id is something else.
        env = self.profile("trip-intake", INTERVIEWER_ID, SHARED)
        result = self.run_script("--profile", "trip-intake", "--execute")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.values(env)["GATEWAY_RELAY_SECRET"], derive(MASTER, INTERVIEWER_ID))
        self.assertNotEqual(self.values(env)["GATEWAY_RELAY_SECRET"], derive(MASTER, "trip-intake"))

    def test_a_profile_without_a_control_token_does_not_gain_one(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED, with_token=False)
        self.run_script("--profile", "trip-one", "--execute")
        self.assertNotIn("COMPANION_CONTROL_TOKEN", env.read_text())
        self.assertEqual(self.values(env)["GATEWAY_RELAY_SECRET"], derive(MASTER, SHARED_ID))

    def test_the_replacement_is_atomic_and_leaves_no_temp_file(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED)
        inode_before = env.stat().st_ino
        self.run_script("--profile", "trip-one", "--execute")
        self.assertNotEqual(env.stat().st_ino, inode_before, "a replaced file, not a rewritten one")
        self.assertEqual(sorted(p.name for p in env.parent.iterdir()), [".env"])

    def test_several_profiles_and_all_enrolled(self) -> None:
        a = self.profile("trip-one", "gw-one", SHARED)
        b = self.profile("trip-two", "gw-two", SHARED)
        (self.profiles / "not-enrolled").mkdir()
        (self.profiles / "not-enrolled" / ".env").write_text("OTHER=1\n")
        (self.profiles / "no-env-at-all").mkdir()
        result = self.run_script("--all-enrolled", "--execute")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.values(a)["GATEWAY_RELAY_SECRET"], derive(MASTER, "gw-one"))
        self.assertEqual(self.values(b)["GATEWAY_RELAY_SECRET"], derive(MASTER, "gw-two"))
        self.assertEqual((self.profiles / "not-enrolled" / ".env").read_text(), "OTHER=1\n")
        self.assertNotIn("not-enrolled", result.stdout)

        c = self.profile("trip-three", "gw-three", SHARED)
        d = self.profile("trip-four", "gw-four", SHARED)
        result = self.run_script("--profile", "trip-three,trip-four", "--execute")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.values(c)["GATEWAY_RELAY_SECRET"], derive(MASTER, "gw-three"))
        self.assertEqual(self.values(d)["GATEWAY_RELAY_SECRET"], derive(MASTER, "gw-four"))

    def test_it_restarts_nothing_and_lists_what_needs_a_restart(self) -> None:
        self.profile("trip-one", SHARED_ID, SHARED)
        result = self.run_script("--profile", "trip-one", "--execute")
        self.assertIn("restart these gateways", result.stdout)
        self.assertIn("trip-one", result.stdout)
        self.assertIn("nothing was restarted", result.stdout)

    # -- refusals ---------------------------------------------------------------------------

    def assert_refused_and_unchanged(self, result: subprocess.CompletedProcess, *envs: Path, snapshot: dict) -> None:
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("refused", result.stderr)
        for env in envs:
            self.assertEqual(env.read_text(), snapshot[env], f"{env} was changed")

    def test_it_refuses_while_the_relay_mode_is_shared_or_absent(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED)
        snap = {env: env.read_text()}
        for mode in ("shared", None):
            with self.subTest(mode=mode):
                self.write_arch(mode)
                for extra in ([], ["--execute"]):
                    result = self.run_script("--profile", "trip-one", *extra)
                    self.assert_refused_and_unchanged(result, env, snapshot=snap)
                    self.assertIn("both", result.stderr)

    def test_it_proceeds_in_both_and_derived(self) -> None:
        for mode in ("both", "derived"):
            with self.subTest(mode=mode):
                self.write_arch(mode)
                self.assertEqual(self.run_script("--profile", "nothing-here").returncode, 1)  # refused for the profile, not the mode
                self.profile("trip-" + mode, "gw-" + mode, SHARED)
                result = self.run_script("--profile", "trip-" + mode)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_it_refuses_an_unknown_mode(self) -> None:
        self.profile("trip-one", SHARED_ID, SHARED)
        self.write_arch("Derived")
        self.assertEqual(self.run_script("--profile", "trip-one").returncode, 1)

    def test_it_refuses_a_profile_with_no_gateway_id_or_no_secret(self) -> None:
        no_id = self.profile("trip-no-id", None, SHARED)
        no_id.write_text(no_id.read_text() + f"GATEWAY_RELAY_SECRET={SHARED}\n")
        no_secret = self.profile("trip-no-secret", SHARED_ID, None)
        snap = {no_id: no_id.read_text(), no_secret: no_secret.read_text()}
        for name in ("trip-no-id", "trip-no-secret"):
            result = self.run_script("--profile", name, "--execute")
            self.assert_refused_and_unchanged(result, no_id, no_secret, snapshot=snap)

    def test_it_refuses_symlinks(self) -> None:
        real = self.profile("trip-real", SHARED_ID, SHARED)
        (self.profiles / "trip-link").symlink_to(self.profiles / "trip-real")
        linked_env = self.profile("trip-envlink", SHARED_ID, SHARED)
        target = self.root / "elsewhere.env"
        target.write_text(linked_env.read_text())
        linked_env.unlink()
        linked_env.symlink_to(target)
        snap = {real: real.read_text(), target: target.read_text()}
        for name in ("trip-link", "trip-envlink"):
            result = self.run_script("--profile", name, "--execute")
            self.assert_refused_and_unchanged(result, real, target, snapshot=snap)
            self.assertIn("symlink", result.stderr)
        # ...and --all-enrolled refuses the whole run rather than skipping them quietly.
        result = self.run_script("--all-enrolled", "--execute")
        self.assert_refused_and_unchanged(result, real, target, snapshot=snap)

    def test_one_refused_profile_means_nothing_is_written(self) -> None:
        good = self.profile("trip-good", "gw-good", SHARED)
        bad = self.profile("trip-bad", None, SHARED)
        snap = {good: good.read_text(), bad: bad.read_text()}
        result = self.run_script("--profile", "trip-good,trip-bad", "--execute")
        self.assert_refused_and_unchanged(result, good, bad, snapshot=snap)

    def test_it_refuses_a_name_that_is_not_a_profile_name(self) -> None:
        for name in ("../escape", "UPPER", "a", "with/slash"):
            result = self.run_script("--profile", name, "--execute")
            self.assertEqual(result.returncode, 1, name)

    def test_it_refuses_a_master_it_cannot_read(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED)
        snap = {env: env.read_text()}
        cases = {
            "env ref": ["env://SOME_VARIABLE"],
            "missing file": [f"file://{self.root}/does-not-exist"],
            "no refs": [],
            "field absent": None,
        }
        for mode in ("both", "derived"):
            for label, refs in cases.items():
                with self.subTest(mode=mode, label=label):
                    self.write_arch(mode, master_refs=refs)
                    result = self.run_script("--profile", "trip-one", "--execute")
                    self.assert_refused_and_unchanged(result, env, snapshot=snap)
                    self.assertIn("gateway_key_master_refs", result.stderr)
        self.master_file.write_text("  \n")
        self.write_arch("both")
        self.assert_refused_and_unchanged(self.run_script("--profile", "trip-one", "--execute"), env, snapshot=snap)

    def test_it_refuses_a_derivation_master_equal_to_a_shared_secret(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED)
        snap = {env: env.read_text()}
        later = self.root / "previous-shared.secret"
        later.write_text(MASTER + "\n")
        for label, master_text, shared_refs in (
            ("first shared", SHARED, None),
            ("a later shared in the rotation list", MASTER, [f"file://{self.shared_file}", f"file://{later}"]),
        ):
            for mode in ("both", "derived"):
                with self.subTest(label=label, mode=mode):
                    self.master_file.write_text(master_text + "\n")
                    self.write_arch(mode, shared_refs)
                    for extra in ([], ["--execute"]):
                        result = self.run_script("--profile", "trip-one", *extra)
                        self.assert_refused_and_unchanged(result, env, snapshot=snap)
                        self.assertIn("gateway_key_master_refs", result.stderr)
                        self.assertIn("gateway_secret_refs", result.stderr)
                        self.assertNotIn(master_text, result.stdout + result.stderr)

    def test_a_shared_secret_it_cannot_read_is_refused_and_an_env_one_is_compared(self) -> None:
        """Every shared secret is read before a key is written: one that cannot be read cannot be proved
        different from the master (PR #599 boundary re-check)."""
        env = self.profile("trip-one", SHARED_ID, SHARED)
        snap = {env: env.read_text()}
        for label, refs in (
            ("vault", ["vault://secret/data/kinerary/relay#gateway"]),
            ("missing file", [f"file://{self.root / 'absent.secret'}"]),
            ("unset variable", ["env://RELAY_SHARED_UNSET"]),
            ("readable then unreadable", [f"file://{self.shared_file}", "vault://secret/data/x#y"]),
        ):
            with self.subTest(label=label):
                self.write_arch("both", refs)
                result = self.run_script("--profile", "trip-one", "--execute")
                self.assert_refused_and_unchanged(result, env, snapshot=snap)
                self.assertIn("gateway_secret_refs", result.stderr)
        # An env:// shared secret is read from the environment and compared, as the relay reads it.
        self.write_arch("both", ["env://RELAY_SHARED_FOR_TEST"])
        base = {"HOME": str(self.home), "PATH": "/usr/bin:/bin", "KINERARY_ARCHITECTURE_PROFILE": str(self.arch)}
        equal = subprocess.run([sys.executable, str(SCRIPT), "--profile", "trip-one", "--execute"], capture_output=True,
                               text=True, timeout=60, env={**base, "RELAY_SHARED_FOR_TEST": f"  {MASTER}\n"})
        self.assert_refused_and_unchanged(equal, env, snapshot=snap)
        self.assertNotIn(MASTER, equal.stdout + equal.stderr)
        distinct = subprocess.run([sys.executable, str(SCRIPT), "--profile", "trip-one", "--execute"], capture_output=True,
                                  text=True, timeout=60, env={**base, "RELAY_SHARED_FOR_TEST": SHARED})
        self.assertEqual(distinct.returncode, 0, distinct.stderr)
        self.assertEqual(self.values(env)["GATEWAY_RELAY_SECRET"], derive(MASTER, SHARED_ID))

    def test_a_later_master_it_cannot_read_is_refused(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED)
        snap = {env: env.read_text()}
        for later in ("vault://secret/data/x#y", f"file://{self.root / 'absent-master.secret'}"):
            with self.subTest(later=later):
                self.write_arch("both", master_refs=[f"file://{self.master_file}", later])
                result = self.run_script("--profile", "trip-one", "--execute")
                self.assert_refused_and_unchanged(result, env, snapshot=snap)
                self.assertIn("gateway_key_master_refs", result.stderr)

    def test_it_uses_the_derivation_master_not_the_shared_secret(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED)
        self.run_script("--profile", "trip-one", "--execute")
        key = self.values(env)["GATEWAY_RELAY_SECRET"]
        self.assertEqual(key, derive(MASTER, SHARED_ID))
        self.assertNotEqual(key, derive(SHARED, SHARED_ID), "a key derived from what profiles hold is no credential")
        self.assertNotIn(SHARED, env.read_text())

    def test_a_profile_holding_a_key_derived_from_the_shared_secret_is_replaced(self) -> None:
        env = self.profile("trip-one", SHARED_ID, derive(SHARED, SHARED_ID))
        result = self.run_script("--profile", "trip-one", "--execute")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("unrecognised -> derived", result.stdout)
        self.assertEqual(self.values(env)["GATEWAY_RELAY_SECRET"], derive(MASTER, SHARED_ID))

    def test_it_refuses_a_gateway_id_the_derivation_does_not_accept(self) -> None:
        refused = json.loads((REPO / "control-plane/api/test/fixtures/relay-key-vectors.json").read_text(encoding="utf-8"))["refused_ids"]
        for index, gateway_id in enumerate(refused):
            with self.subTest(id=gateway_id):
                env = self.profile(f"trip-odd-{index}", gateway_id, SHARED)
                snap = {env: env.read_text()}
                result = self.run_script("--profile", f"trip-odd-{index}", "--execute")
                self.assert_refused_and_unchanged(result, env, snapshot=snap)

    # -- never prints a key ---------------------------------------------------------------------

    def test_no_key_token_or_master_is_ever_printed(self) -> None:
        env = self.profile("trip-one", SHARED_ID, SHARED)
        derived = derive(MASTER, SHARED_ID)
        old_token = token(SHARED_ID, SHARED)
        new_token = token(SHARED_ID, derived)
        runs = [
            self.run_script("--profile", "trip-one"),
            self.run_script("--profile", "trip-one", "--execute"),
            self.run_script("--profile", "trip-one", "--execute"),
        ]
        self.write_arch("both", master_refs=[f"file://{self.root}/missing"])
        runs.append(self.run_script("--profile", "trip-one"))
        self.write_arch("both", master_refs=[f"file://{self.shared_file}"])
        runs.append(self.run_script("--profile", "trip-one"))
        self.write_arch("shared")
        runs.append(self.run_script("--profile", "trip-one"))
        for result in runs:
            out = result.stdout + result.stderr
            for secret in (SHARED, MASTER, derived, old_token, new_token, str(self.master_file), str(self.shared_file)):
                self.assertNotIn(secret, out)
        self.assertEqual(self.values(env)["GATEWAY_RELAY_SECRET"], derived)


if __name__ == "__main__":
    unittest.main()
