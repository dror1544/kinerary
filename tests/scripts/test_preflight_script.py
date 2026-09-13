"""scripts/preflight-deploy.sh — its own variables must survive provisioning.env.

The --deploy path sources ~/kinerary-deploy/provisioning.env (`set -a; .`) so
compose sees the worker's configuration. That file sets REPO_ROOT=/repo — the
worker's path INSIDE its container — and the script's own REPO_ROOT, the
checkout on this Mac, was overwritten by it. Compose was then asked to mount a
host path `/repo`, Docker refused, and the first real --deploy (2026-09-11)
left the worker Created and not running.

Every name compose.local.yml interpolates from the environment is a name
provisioning.env may set. The script must not use one for itself, except the
ones it deliberately hands to compose.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = (REPO / "scripts/preflight-deploy.sh").read_text()
COMPOSE = (REPO / "control-plane/deployment/compose.local.yml").read_text()

# Set by the script ON PURPOSE, for compose to read.
HANDED_TO_COMPOSE = {"WORKER_REPO_ROOT_HOST", "BUILDX_CONFIG"}


class OwnVariables(unittest.TestCase):
    def test_no_script_variable_is_one_provisioning_env_can_overwrite(self):
        from_env = set(re.findall(r"\$\{([A-Z_][A-Z0-9_]*)(?::?-[^}]*)?\}", COMPOSE))
        assigned = set(re.findall(r"^\s*(?:export\s+|local\s+)?([A-Z_][A-Z0-9_]*)=", SCRIPT, re.M))
        collisions = (assigned & from_env) - HANDED_TO_COMPOSE
        self.assertEqual(collisions, set(),
                         f"{sorted(collisions)} would be overwritten by `. provisioning.env` in --deploy")

    def test_compose_is_handed_a_real_checkout(self):
        # Belt and braces: whatever the variable is called, the path compose gets
        # must be checked to be a checkout before compose is run.
        self.assertRegex(SCRIPT, r'\[ -d "\$[A-Z_]+/control-plane/worker" \]')


if __name__ == "__main__":
    unittest.main()
