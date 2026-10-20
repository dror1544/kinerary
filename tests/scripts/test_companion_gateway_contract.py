"""Issue #349: facts that two or more files must agree on, pinned so the next edit
to one of them fails here instead of in production.

Each of these is a place the same thing is spelled out in two languages (Python
worker, TypeScript relay, bash forced command, SQL migration, a release tool),
where drift is silent: a lock key that differs means two tools that think they
exclude each other do not; a dormant predicate that differs means the relay waits
for a gateway the release tool ignores; a reason code the worker writes and the
CHECK refuses stops the sweep with an error the operator reads as a database
problem.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


WORKER = "control-plane/worker/control_plane_worker/gateway_reconcile.py"
RELEASE = "control-plane/deployment/vm-release.py"
TEARDOWN = "scripts/teardown-trip.py"
WAIT = "control-plane/api/src/relay/gateway-wait.ts"
HOST = "scripts/companion-install-host.sh"
MIGRATION = "control-plane/db/migrations/20261021100000_companion_gateways.sql"
DOC = "docs/control-plane-vm-deployment.md"


class OneLock(unittest.TestCase):
    def test_the_sweep_the_release_tool_and_teardown_name_the_same_advisory_lock(self):
        spellings = {
            WORKER: re.search(r'ADVISORY_LOCK_TEXT = "([^"]+)"', read(WORKER)),
            RELEASE: re.search(r'GATEWAY_LOCK_TEXT = "([^"]+)"', read(RELEASE)),
            TEARDOWN: re.search(r'GATEWAY_LOCK_TEXT = "([^"]+)"', read(TEARDOWN)),
        }
        for path, match in spellings.items():
            self.assertIsNotNone(match, f"{path} no longer names the companion-gateway lock")
        self.assertEqual({m.group(1) for m in spellings.values()}, {"control_plane.companion_gateways"})
        self.assertIn("pg_try_advisory_lock(hashtext(%s))", read(WORKER))
        self.assertIn("pg_advisory_lock(hashtext('{GATEWAY_LOCK_TEXT}'))", read(RELEASE))
        self.assertIn("pg_advisory_xact_lock(hashtext('{GATEWAY_LOCK_TEXT}'))", read(TEARDOWN))

    def test_a_release_waits_two_minutes_for_it_as_the_runbook_says(self):
        self.assertRegex(read(RELEASE), r"WAIT_SECONDS = 120\b")
        self.assertIn("within two minutes", read(DOC))


class OneDormantPredicate(unittest.TestCase):
    def test_the_relay_wait_and_the_release_tool_skip_the_same_companions(self):
        wait = " ".join(read(WAIT).split())
        release = " ".join(read(RELEASE).split())
        predicate = "g.hermes_profile = b.hermes_profile AND g.desired = 'stopped'"
        self.assertIn(predicate, wait)
        self.assertIn(predicate, release)
        for text in (wait, release):
            self.assertIn("control_plane.companion_gateways g", text)
            self.assertIn("NOT EXISTS", text)

    def test_the_release_tool_degrades_on_a_database_from_before_the_migration(self):
        self.assertIn("to_regclass('control_plane.companion_gateways')", read(RELEASE))


class OneReasonSet(unittest.TestCase):
    def reasons_in_worker(self) -> set[str]:
        block = re.search(r"REASONS = \((.*?)\n\)", read(WORKER), re.S)
        self.assertIsNotNone(block)
        return set(re.findall(r'"([A-Z_]+)"', block.group(1)))

    def test_the_reasons_the_worker_can_write_are_exactly_the_ones_both_tables_accept(self):
        migration = read(MIGRATION)
        checks = re.findall(r"reason\s+(?:text NOT NULL )?(?:text )?CHECK \(reason IN \((.*?)\)\)", migration, re.S)
        self.assertEqual(len(checks), 2, "both tables carry the reason CHECK")
        for check in checks:
            self.assertEqual(set(re.findall(r"'([A-Z_]+)'", check)), self.reasons_in_worker())

    def test_every_reason_decide_returns_is_in_that_set(self):
        used = set(re.findall(r'Decision\("(?:running|stopped)", "([A-Z_]+)"', read(WORKER)))
        if '"ARCHIVED" if past_grace else "NOT_CURRENT"' in read(WORKER):
            used |= {"ARCHIVED", "NOT_CURRENT"}
        self.assertTrue(used <= self.reasons_in_worker(), used - self.reasons_in_worker())
        self.assertEqual(used, self.reasons_in_worker(), "a reason nothing returns is a reason nothing explains")


class OneProvenanceMarkerAndDenyList(unittest.TestCase):
    def test_the_marker_and_the_deny_list_are_the_ones_the_runbook_states(self):
        host, doc = read(HOST), read(DOC)
        self.assertIn('GATEWAY_MARKER="kinerary-managed"', host)
        self.assertIn("`kinerary-managed`", doc)
        deny = re.search(r'GATEWAY_DENY="([^"]+)"', host).group(1).split()
        self.assertEqual(sorted(deny), ["default", "kinerary-extract", "trip-monitor"])
        for name in deny:
            self.assertIn(f"`{name}`", doc)

    def test_the_host_never_stops_the_interviewer_and_the_worker_names_the_same_profile(self):
        self.assertIn('[ "$name" = trip-intake ]', read(HOST))
        self.assertIn('INTERVIEWER_PROFILE = "trip-intake"', read(WORKER))


if __name__ == "__main__":
    unittest.main()
