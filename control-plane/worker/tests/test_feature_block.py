"""AC-11 — a provision writes a `features` block holding exactly the registered
switches that are on for the trip, each as the literal `true`, and nothing else.
(#567 slice S2; docs/specs/sprint-9/567-feature-switches.md.)

Two parts. The pure block builder and the registry pin run anywhere. The provision
tests hit a real PostgreSQL database (CONTROL_PLANE_TEST_DATABASE_URL, skipped when
absent) through the same worker and fake deploy adapter as test_provisioner.py.

Which contract shape this exercises: `features` is a top-level key of
trip.config.json written by the PROVISIONER after transform_intake/enrich_config, so
it does not depend on which of the two interview paths produced `phases[].planned`
or `phases[].venues`. The provision tests run the default (agentless-shaped) intake;
the allow-list round trip over BOTH producer shapes is
tests/config-allow-list.test.js, whose helper applies the same block.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from control_plane_worker import feature_block
from control_plane_worker.feature_block import (
    MEMBER_VISIBLE_SWITCHES,
    REGISTERED_SWITCHES,
    build_features_block,
    resolve_features,
    with_features,
)
from control_plane_worker.provisioner import ProvisionerWorker

from tests.support.test_database import test_database_url
from tests.test_provisioner import (
    FakeDeployAdapter,
    run_test_migrations,
    setup_fixture,
    teardown_fixture,
)

DB_URL = test_database_url()
SKIP = not DB_URL

REPO = Path(__file__).resolve().parents[3]
REGISTRY_JS = REPO / "shared" / "feature-switches.js"


def js_registry_names() -> list[str]:
    """The names in shared/feature-switches.js, in order. Through node when there is
    one (the registry's own answer); from the source text otherwise — either way the
    mirror is compared against the JavaScript file, not against itself."""
    node = shutil.which("node")
    if node:
        out = subprocess.run(
            [node, "-e", "console.log(JSON.stringify(require(process.argv[1]).FEATURE_SWITCHES.map(e=>e.name)))",
             str(REGISTRY_JS)],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0:
            return json.loads(out.stdout)
    block = REGISTRY_JS.read_text(encoding="utf-8").split("const FEATURE_SWITCHES = Object.freeze([", 1)[1].split("]);", 1)[0]
    return re.findall(r"^\s*name:\s*'([a-z][a-z0-9_]{2,40})'", block, flags=re.MULTILINE)


def js_member_visible_names() -> list[str]:
    node = shutil.which("node")
    if node:
        out = subprocess.run(
            [node, "-e", "console.log(JSON.stringify(require(process.argv[1]).FEATURE_SWITCHES"
                         ".filter(e=>e.memberVisible===true).map(e=>e.name)))", str(REGISTRY_JS)],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0:
            return json.loads(out.stdout)
    block = REGISTRY_JS.read_text(encoding="utf-8").split("const FEATURE_SWITCHES = Object.freeze([", 1)[1].split("]);", 1)[0]
    return [m.group(1) for m in re.finditer(r"name:\s*'([a-z][a-z0-9_]{2,40})'[^}]*?memberVisible:\s*true", block, flags=re.DOTALL)]


class RegistryMirrorTests(unittest.TestCase):
    def test_the_member_visible_mirror_is_the_javascript_registrys_member_visible_names(self) -> None:
        self.assertEqual(list(feature_block.MEMBER_VISIBLE_SWITCHES), js_member_visible_names(),
                         "MEMBER_VISIBLE_SWITCHES must mirror the memberVisible entries of shared/feature-switches.js")
        self.assertTrue(set(feature_block.MEMBER_VISIBLE_SWITCHES) <= set(REGISTERED_SWITCHES))

    def test_the_worker_mirror_is_the_javascript_registry_names_in_order(self) -> None:
        self.assertEqual(list(REGISTERED_SWITCHES), js_registry_names(),
                         "control_plane_worker/feature_block.py REGISTERED_SWITCHES must mirror "
                         "shared/feature-switches.js — add the new switch name to both")

    def test_the_mirror_is_not_empty_and_names_are_well_formed(self) -> None:
        self.assertTrue(REGISTERED_SWITCHES)
        for name in REGISTERED_SWITCHES:
            self.assertRegex(name, r"^[a-z][a-z0-9_]{2,40}$")


class BlockBuilderTests(unittest.TestCase):
    def test_only_registered_names_that_are_literally_true_appear_each_as_true(self) -> None:
        block = build_features_block({"delivery_probe": True, "ghost_feature": True})
        self.assertEqual({"delivery_probe": True}, block)
        self.assertIs(block["delivery_probe"], True)

    def test_a_retired_switch_is_never_written_even_when_a_stored_setting_says_on(self) -> None:
        # site_video_layout was retired on 2026-11-21 (the video layout is the only layout). A row left in the
        # database must not put the name back into a trip's file at its next rollout.
        self.assertNotIn("site_video_layout", REGISTERED_SWITCHES)
        self.assertNotIn("site_video_layout", MEMBER_VISIBLE_SWITCHES)
        self.assertEqual({}, build_features_block({"site_video_layout": True}))
        self.assertEqual({"delivery_probe": True}, build_features_block(["site_video_layout", "delivery_probe"]))

    def test_anything_but_the_literal_true_is_off(self) -> None:
        for answer in (False, None, 1, "true", "t", "yes", [], {"on": True}, 0):
            self.assertEqual({}, build_features_block({"delivery_probe": answer}), repr(answer))

    def test_a_list_of_names_is_accepted_and_filtered_by_the_registry(self) -> None:
        self.assertEqual({"delivery_probe": True}, build_features_block(["delivery_probe", "nope"]))
        self.assertEqual({}, build_features_block([]))

    def test_with_features_replaces_an_old_block_and_touches_nothing_else(self) -> None:
        config: dict[str, Any] = {"meta": {"title": "T"}, "participants": [{"username": "a"}],
                                  "features": {"ghost_feature": True, "delivery_probe": True}}
        before = json.dumps(config, sort_keys=True)
        out = with_features(config, {})
        self.assertEqual({}, out["features"])
        self.assertEqual(config["meta"], out["meta"])
        self.assertEqual(config["participants"], out["participants"])
        self.assertEqual(before, json.dumps(config, sort_keys=True), "the input must not be modified")


@unittest.skipIf(SKIP, "CONTROL_PLANE_TEST_DATABASE_URL not set")
class ProvisionWritesFeaturesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        run_test_migrations()
        cls.conn = psycopg.connect(DB_URL, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        self.fix = setup_fixture(self.conn)
        self.fake_deploy = FakeDeployAdapter()
        self.worker = ProvisionerWorker(db_url=DB_URL, deploy=self.fake_deploy, worker_id="test-feature-block")

    def tearDown(self) -> None:
        self.conn.rollback()
        with self.conn.transaction():
            self.conn.execute("DELETE FROM control_plane.feature_switch_settings WHERE trip_id = %s OR scope <> 'trip'",
                              (self.fix["trip_id"],))
        teardown_fixture(self.conn, self.fix)

    def _set(self, scope: str, enabled: bool, trip_id: str | None = None, name: str = "delivery_probe") -> None:
        with self.conn.transaction():
            self.conn.execute(
                "INSERT INTO control_plane.feature_switch_settings(switch, scope, trip_id, enabled, changed_by) "
                "VALUES (%s, %s, %s, %s, %s)",
                (name, scope, trip_id, enabled, "sha256:" + "a" * 64),
            )

    def _deployed_config(self) -> dict[str, Any]:
        self.worker.run_once()
        self.assertEqual(1, len(self.fake_deploy.deployed), "the provision did not reach the deploy adapter")
        return self.fake_deploy.deployed[0]["config"]

    def test_a_trip_with_every_switch_off_gets_an_empty_features_block(self) -> None:
        config = self._deployed_config()
        self.assertEqual({}, config["features"])

    def test_a_switch_on_for_this_trip_is_written_as_the_literal_true_and_nothing_else_is(self) -> None:
        self._set("trip", True, self.fix["trip_id"])
        config = self._deployed_config()
        self.assertEqual({"delivery_probe": True}, config["features"])
        self.assertIs(config["features"]["delivery_probe"], True)

    def test_a_switch_on_for_another_trip_only_is_not_written(self) -> None:
        other = setup_fixture(self.conn)
        try:
            self._set("trip", True, other["trip_id"])
            config = self._deployed_config()
            self.assertEqual({}, config["features"])
        finally:
            self.conn.rollback()
            with self.conn.transaction():
                self.conn.execute("DELETE FROM control_plane.feature_switch_settings WHERE trip_id = %s", (other["trip_id"],))
            teardown_fixture(self.conn, other)

    def test_every_trip_on_with_this_trip_off_is_off(self) -> None:
        self._set("all_trips", True)
        self._set("trip", False, self.fix["trip_id"])
        self.assertEqual({}, self._deployed_config()["features"])

    def test_every_trip_on_reaches_this_trip(self) -> None:
        self._set("all_trips", True)
        self.assertEqual({"delivery_probe": True}, self._deployed_config()["features"])

    def test_a_stored_row_for_an_unregistered_name_never_reaches_the_block(self) -> None:
        self._set("trip", True, self.fix["trip_id"], name="ghost_feature")
        self.assertEqual({}, self._deployed_config()["features"])

    def test_the_block_is_the_only_key_the_provisioner_adds_to_the_config(self) -> None:
        from control_plane_worker.transformer import transform_intake
        from tests.test_provisioner import JAPAN_INTAKE
        config = self._deployed_config()
        produced = set(transform_intake(JAPAN_INTAKE).keys())
        self.assertEqual(produced | {"features"}, set(config.keys()))

    def test_a_failed_read_writes_an_empty_block_logs_it_and_still_deploys(self) -> None:
        # The worker newer than the schema: the function is not there. The provision
        # must not fail over a switch, and must not turn anything on.
        self._set("trip", True, self.fix["trip_id"])
        self.conn.execute("ALTER FUNCTION control_plane.feature_enabled(text, text) RENAME TO feature_enabled_gone")
        self.conn.commit()
        try:
            with self.assertLogs("control_plane_worker.feature_block", level="WARNING") as logs:
                config = self._deployed_config()
        finally:
            self.conn.execute("ALTER FUNCTION control_plane.feature_enabled_gone(text, text) RENAME TO feature_enabled")
            self.conn.commit()
        self.assertEqual({}, config["features"])
        self.assertTrue(any("feature_block.read_failed" in line for line in logs.output))
        records = [r for r in logs.records if r.getMessage() == "feature_block.read_failed"]
        self.assertEqual(1, len(records))
        self.assertEqual(self.fix["trip_id"], records[0].trip_id, "the log names WHICH trip was given an all-off block")
        self.assertNotIn("feature_enabled", records[0].getMessage() + str(vars(records[0]).get("error_type", "")),
                         "the driver's message (which can quote a DSN) is not logged")
        state = self.conn.execute("SELECT state FROM control_plane.jobs WHERE id = %s", (self.fix["job_id"],)).fetchone()
        self.assertEqual("succeeded", state["state"])

    def test_resolve_features_runs_in_a_savepoint_so_a_failure_leaves_the_connection_usable(self) -> None:
        self.conn.execute("ALTER FUNCTION control_plane.feature_enabled(text, text) RENAME TO feature_enabled_gone")
        self.conn.commit()
        try:
            with self.conn.transaction():
                with self.assertLogs("control_plane_worker.feature_block", level="WARNING"):
                    self.assertEqual({}, resolve_features(self.conn, self.fix["trip_id"]))
                # the outer transaction is not aborted
                self.assertEqual(1, self.conn.execute("SELECT 1 AS one").fetchone()["one"])
        finally:
            self.conn.execute("ALTER FUNCTION control_plane.feature_enabled_gone(text, text) RENAME TO feature_enabled")
            self.conn.commit()

    def test_the_plan_snapshot_the_review_reads_does_not_carry_the_block(self) -> None:
        self._set("trip", True, self.fix["trip_id"])
        self.worker.run_once()
        row = self.conn.execute("SELECT plan_snapshot FROM control_plane.trips WHERE id = %s", (self.fix["trip_id"],)).fetchone()
        self.assertNotIn("features", row["plan_snapshot"])


if __name__ == "__main__":
    unittest.main()
