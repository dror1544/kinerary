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


FLEET = ".agents/skills/trip-fleet-monitor/fleet-mcp.mjs"

#: "Dormant" is what the reconciler DID, not what it decided: a stopped decision,
#: a stop it performed that succeeded, and a host that confirmed it stopped (or
#: gone). Every place that skips a dormant companion must say exactly this.
DORMANT_ATOMS = (
    "g.desired='stopped'",
    "g.last_action='stop'",
    "g.last_result='ok'",
    "g.observedIN('stopped','absent')",
)


def squash(text: str) -> str:
    return "".join(text.split())


class OneDormantPredicate(unittest.TestCase):
    def test_the_relay_wait_the_release_tool_and_the_fleet_monitor_mean_the_same_thing_by_dormant(self):
        for path in (WAIT, RELEASE, FLEET):
            text = squash(read(path))
            for atom in DORMANT_ATOMS:
                self.assertIn(atom, text, f"{path} no longer requires {atom} for a companion to count as dormant")

    def test_the_relay_wait_and_the_release_tool_skip_the_same_companions(self):
        wait = squash(read(WAIT))
        release = squash(read(RELEASE))
        # The very same conjunction, in the same order, after the join.
        conjunction = squash(
            "g.hermes_profile = b.hermes_profile AND g.desired = 'stopped' AND g.last_action = 'stop' "
            "AND g.last_result = 'ok' AND g.observed IN ('stopped', 'absent')")
        self.assertIn(conjunction, wait)
        self.assertIn(conjunction, release)
        for text in (wait, release):
            self.assertIn("control_plane.companion_gateways", text)
            self.assertIn("NOTEXISTS", text)

    def test_the_fleet_monitor_never_calls_a_decision_alone_dormant(self):
        fleet = read(FLEET)
        case = fleet[fleet.index("const GATEWAY_HEALTH_SQL"):]
        case = case[:case.index("END`;")]
        dormant_line = next(line for line in case.splitlines() if "THEN 'DORMANT'" in line)
        self.assertIn("last_action = 'stop'", dormant_line)
        self.assertIn("last_result = 'ok'", dormant_line)
        self.assertEqual(case.count("'DORMANT'"), 1, "one way to be DORMANT, and it is the predicate above")
        self.assertIn("THEN 'PENDING_STOP'", case, "a decided-but-not-stopped gateway is not dormant")

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
    PROTECTED = "scripts/protected-profiles.txt"

    def protected(self) -> list[str]:
        return [line for line in read(self.PROTECTED).splitlines() if line and not line.startswith("#")]

    def test_the_forced_command_and_teardown_read_the_one_list(self):
        host, teardown = read(HOST), read(TEARDOWN)
        self.assertIn('PROTECTED_FILE="$REPO_ROOT/scripts/protected-profiles.txt"', host)
        self.assertNotIn('GATEWAY_DENY=" ', host, "no second, inline list in the forced command")
        self.assertIn('Path(__file__).resolve().parent / "protected-profiles.txt"', teardown)
        self.assertRegex(teardown, r'names = \{"trip-intake"\}')
        names = self.protected()
        self.assertTrue(all(re.fullmatch(r"[a-z0-9-]+", n) for n in names), names)
        self.assertEqual(len(names), len(set(names)))

    def test_the_list_holds_everything_the_review_named_and_not_the_interviewer(self):
        names = set(self.protected())
        self.assertTrue({"default", "trip-monitor", "kinerary-extract", "elulhome", "familytrip", "kinerarytest"} <= names)
        self.assertNotIn("trip-intake", names, "the interviewer is managed (always running), not protected from management")

    def test_a_missing_or_malformed_list_makes_the_forced_command_refuse_everything(self):
        host = read(HOST)
        self.assertIn("no protected-profiles list at $PROTECTED_FILE: refusing to touch any gateway", host)
        self.assertIn("malformed entry in $PROTECTED_FILE: refusing to touch any gateway", host)

    def test_the_marker_is_written_only_by_a_fresh_install_and_by_the_evidenced_backfill(self):
        host = read(HOST)
        calls = re.findall(r"^\s*mark_managed \"\$PROFILE_NAME\"", host, re.M)
        self.assertEqual(len(calls), 1, "exactly one place installs the marker: the fresh-install path")
        present_block = host[host.index('if [ -d "$HOME/.hermes/profiles/$PROFILE_NAME" ]; then'):host.index("ALREADY_PRESENT %s")]
        self.assertNotIn("mark_managed", present_block)
        self.assertIn("companion-provenance.json", host.split("evidenced(deploy_root)")[1][:900])

    def test_the_marker_and_the_protected_list_are_the_ones_the_runbook_states(self):
        host, doc = read(HOST), read(DOC)
        self.assertIn('GATEWAY_MARKER="kinerary-managed"', host)
        self.assertIn("`kinerary-managed`", doc)
        self.assertIn("scripts/protected-profiles.txt", doc)

    def test_the_host_never_stops_the_interviewer_and_the_worker_names_the_same_profile(self):
        self.assertIn('[ "$name" = trip-intake ]', read(HOST))
        self.assertIn('INTERVIEWER_PROFILE = "trip-intake"', read(WORKER))


if __name__ == "__main__":
    unittest.main()
