"""AC-K2.7: the per-trip key variables pass through compose, unset by default.

Read as text and YAML, not through `docker compose config`, so it runs wherever the
provisioning tests do. (tests/scripts/test_vm_web_profile.py renders the real thing
where docker is available and pins that the web profile moves nothing else.)
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEPLOYMENT = ROOT / "control-plane" / "deployment"


def _services(name: str) -> dict:
    return yaml.safe_load((DEPLOYMENT / name).read_text(encoding="utf-8"))["services"]


def _vm_release():
    for key, sub in (("KINERARY_CP_STATE_DIR", "state"), ("KINERARY_CP_BACKUP_DIR", "backups"), ("KINERARY_CP_LOG_DIR", "log")):
        os.environ.setdefault(key, str(Path(tempfile.mkdtemp(prefix="trip-key-env-")) / sub))
    spec = importlib.util.spec_from_file_location("vm_release_trip_keys", DEPLOYMENT / "vm-release.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["vm_release_trip_keys"] = module
    spec.loader.exec_module(module)
    return module


class TripKeyVariablesPassThrough(unittest.TestCase):
    def test_the_vm_gateway_is_handed_the_master_and_the_legacy_key_empty_by_default(self) -> None:
        env = _services("compose.vm.yml")["runtime-gateway"]["environment"]
        self.assertEqual("${RUNTIME_TRIP_KEY_MASTER:-}", env["RUNTIME_TRIP_KEY_MASTER"])
        self.assertEqual("${RUNTIME_LEGACY_TRIP_KEY:-}", env["RUNTIME_LEGACY_TRIP_KEY"])

    def test_the_vm_worker_is_handed_the_same_master_under_its_own_name(self) -> None:
        env = _services("compose.vm.yml")["worker"]["environment"]
        self.assertEqual("${RUNTIME_TRIP_KEY_MASTER:-}", env["CONTROL_PLANE_TRIP_KEY_MASTER"])
        # the control-plane key is still the worker's exchange key, unchanged
        self.assertEqual("${RUNTIME_EXCHANGE_KEY:-}", env["CONTROL_PLANE_EXCHANGE_KEY"])

    def test_the_local_worker_is_handed_the_master_empty_by_default(self) -> None:
        env = _services("compose.local.yml")["worker"]["environment"]
        self.assertEqual("${CONTROL_PLANE_TRIP_KEY_MASTER:-}", env["CONTROL_PLANE_TRIP_KEY_MASTER"])
        self.assertEqual("${CONTROL_PLANE_EXCHANGE_KEY:-}", env["CONTROL_PLANE_EXCHANGE_KEY"])

    def test_the_master_reaches_nothing_that_does_not_need_it(self) -> None:
        # The master never leaves the gateway and the worker: not the api, the portal, the relay or any other service.
        for compose in ("compose.vm.yml", "compose.local.yml"):
            for service, definition in _services(compose).items():
                env = definition.get("environment") or {}
                names = set(env) if isinstance(env, dict) else {str(item).split("=", 1)[0] for item in env}
                holders = names & {"RUNTIME_TRIP_KEY_MASTER", "RUNTIME_LEGACY_TRIP_KEY", "CONTROL_PLANE_TRIP_KEY_MASTER"}
                if holders:
                    self.assertIn(service, ("runtime-gateway", "worker"), f"{compose}: {service} is handed {sorted(holders)}")

    def test_every_default_is_empty_so_nothing_changes_until_a_deployment_sets_one(self) -> None:
        for compose in ("compose.vm.yml", "compose.local.yml"):
            text = (DEPLOYMENT / compose).read_text(encoding="utf-8")
            for line in re.findall(r"^\s*(?:RUNTIME_TRIP_KEY_MASTER|RUNTIME_LEGACY_TRIP_KEY|CONTROL_PLANE_TRIP_KEY_MASTER):\s*(.*)$", text, re.M):
                self.assertRegex(line, r"^\$\{[A-Z_]+:-\}$", f"{compose}: {line!r} must default to empty")

    def test_the_vm_env_example_lists_both_gateway_variables_empty(self) -> None:
        text = (DEPLOYMENT / "vm.env.example").read_text(encoding="utf-8")
        for name in ("RUNTIME_TRIP_KEY_MASTER", "RUNTIME_LEGACY_TRIP_KEY"):
            self.assertRegex(text, rf"(?m)^{name}=\s+#", name)

    def test_the_release_tool_does_not_require_them_and_does_not_hand_them_to_the_api(self) -> None:
        # Optional means optional: a deployment that never sets them must still pass the pre-switch check,
        # and the api (which reads route kinds from the database, never a key) is never given one.
        release = _vm_release()
        new = {"RUNTIME_TRIP_KEY_MASTER", "RUNTIME_LEGACY_TRIP_KEY", "CONTROL_PLANE_TRIP_KEY_MASTER"}
        self.assertFalse(new & set(release.WEB_REQUIRED_ENV))
        self.assertFalse(new & set(release.WEB_API_ENV))
        env = {name: "x" for name in release.WEB_REQUIRED_ENV}
        env.update({"PORTAL_ORIGIN": "https://portal.example.com", "RUNTIME_ORIGIN": "https://runtime.example.com"})
        self.assertEqual([], [p for p in release.web_config_problems(env, None) if "TRIP_KEY" in p])
        self.assertTrue(all(name not in p for p in release.web_config_problems(env, None) for name in new))


if __name__ == "__main__":
    unittest.main()
