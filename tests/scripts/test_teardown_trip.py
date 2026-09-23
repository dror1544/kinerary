"""scripts/teardown-trip.py — the parts that can go wrong quietly.

Nothing here touches Docker, Proxmox, Hermes or launchd: psql and subprocess
are replaced. What is tested is the logic a mistake in which would not show up
as a failure — an allowlist edit that widens the interviewer instead of
narrowing it, a retired slug whose old resources are no longer found, a trip
real people used being accepted as a target.

    python3 -m unittest discover -s tests/scripts        (needs PyYAML)
"""
from __future__ import annotations

import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "teardown-trip.py"
spec = importlib.util.spec_from_file_location("teardown_trip", SCRIPT)
teardown = importlib.util.module_from_spec(spec)
spec.loader.exec_module(teardown)


CONFIG = """model:
  default: claude-sonnet-5
gateway:
  multiplex_profiles: true
  multiplex_profile_allowlist:
    - japan2026
    - italy2026
  profile_routes: []
platforms:
  telegram:
    home_channel:
      chat_id: '391627336'
"""


class NarrowAllowlist(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "config.yaml"
        patcher = mock.patch.object(teardown, "INTERVIEWER_CONFIG", self.path)
        patcher.start()
        self.addCleanup(patcher.stop)
        run = mock.patch.object(teardown.subprocess, "run")
        self.run = run.start()
        self.addCleanup(run.stop)

    def tearDown(self):
        self.dir.cleanup()

    def test_removes_one_entry_and_leaves_every_other_line_alone(self):
        self.path.write_text(CONFIG)
        teardown.narrow_allowlist("japan2026")
        after = self.path.read_text()
        self.assertEqual(yaml.safe_load(after)["gateway"]["multiplex_profile_allowlist"], ["italy2026"])
        self.assertEqual(after, CONFIG.replace("    - japan2026\n", ""))

    def test_the_last_entry_leaves_an_empty_list_never_a_missing_key(self):
        # A MISSING key means serve-all in Hermes (gateway/config.py); [] means
        # the default profile only. Deleting the key would widen the gateway.
        self.path.write_text(CONFIG.replace("    - italy2026\n", ""))
        teardown.narrow_allowlist("japan2026")
        gateway = yaml.safe_load(self.path.read_text())["gateway"]
        self.assertIn("multiplex_profile_allowlist", gateway)
        self.assertEqual(gateway["multiplex_profile_allowlist"], [])

    def test_an_inline_list_is_handled_too(self):
        self.path.write_text(CONFIG.replace(
            "  multiplex_profile_allowlist:\n    - japan2026\n    - italy2026\n",
            "  multiplex_profile_allowlist: [japan2026, italy2026]\n"))
        teardown.narrow_allowlist("italy2026")
        self.assertEqual(yaml.safe_load(self.path.read_text())["gateway"]["multiplex_profile_allowlist"], ["japan2026"])

    def test_the_interviewer_is_restarted_so_its_ticker_for_the_profile_stops(self):
        self.path.write_text(CONFIG)
        teardown.narrow_allowlist("japan2026")
        argv = self.run.call_args.args[0]
        self.assertEqual(argv[1:], ["--profile", "trip-intake", "gateway", "restart"])


class RetireInDb(unittest.TestCase):
    def test_an_open_interview_is_closed_with_the_trip(self):
        # Left open, the relay would later message the organizer's chat that an
        # interview for a trip that no longer exists is about to close.
        seen: list[str] = []
        with mock.patch.object(teardown, "psql", side_effect=lambda sql: seen.append(sql) or "0"):
            teardown.retire_in_db({"id": "trip_abcdefgh12", "slug": "japan-2026", "orig": "japan-2026"})
        tx = seen[-1]
        self.assertIn("UPDATE control_plane.intake_sessions SET expired_at = now()", tx)
        self.assertIn("state <> 'confirmed'", tx)
        self.assertLess(tx.index("BEGIN"), tx.index("intake_sessions"))
        self.assertLess(tx.index("intake_sessions"), tx.index("COMMIT"))

    def test_a_live_group_binding_token_is_revoked_with_the_trip(self):
        # issue #175: a token issued into the organizer's DM stays redeemable
        # for up to its own TTL (7-30 days) with nothing on the trip row
        # saying it is gone. Revoking it here closes the reproduction path
        # `redeemGroupBindingToken`'s own retired-slug check narrows but does
        # not eliminate on its own.
        seen: list[str] = []
        with mock.patch.object(teardown, "psql", side_effect=lambda sql: seen.append(sql) or "0"):
            teardown.retire_in_db({"id": "trip_abcdefgh12", "slug": "japan-2026", "orig": "japan-2026"})
        tx = seen[-1]
        self.assertIn(
            "UPDATE control_plane.telegram_group_binding_tokens SET expires_at = now() "
            "WHERE trip_id = 'trip_abcdefgh12' AND expires_at > now()",
            tx,
        )
        self.assertLess(tx.index("BEGIN"), tx.index("telegram_group_binding_tokens"))
        self.assertLess(tx.index("telegram_group_binding_tokens"), tx.index("COMMIT"))

    def test_an_already_retired_trip_still_revokes_a_lingering_token(self):
        # The fast path for a trip that is already `retired-...` (e.g. a
        # rerun) must not skip revocation just because the slug rename is
        # already done.
        seen: list[str] = []
        with mock.patch.object(teardown, "psql", side_effect=lambda sql: seen.append(sql) or "0"):
            teardown.retire_in_db({"id": "trip_abcdefgh12", "slug": "retired-japan-2026-20260101", "orig": "japan-2026"})
        self.assertTrue(any("telegram_group_binding_tokens" in sql for sql in seen))

    def test_the_already_retired_fast_path_is_one_transaction_not_three_calls(self):
        # A process that died between separate bare psql() calls used to be
        # able to close bindings and sessions and still leave a live
        # group-binding token behind — reopening the exact gap this task
        # exists to close, by its own non-atomicity. One BEGIN...COMMIT call,
        # the same shape the rename branch below already uses, means a crash
        # anywhere in it leaves the database exactly as it was before.
        seen: list[str] = []
        with mock.patch.object(teardown, "psql", side_effect=lambda sql: seen.append(sql) or "0"):
            teardown.retire_in_db({"id": "trip_abcdefgh12", "slug": "retired-japan-2026-20260101", "orig": "japan-2026"})
        self.assertEqual(len(seen), 1, "exactly one psql() call for the whole fast path")
        tx = seen[0]
        self.assertLess(tx.index("BEGIN"), tx.index("telegram_group_binding_tokens"))
        self.assertLess(tx.index("telegram_group_binding_tokens"), tx.index("telegram_chat_bindings"))
        self.assertLess(tx.index("telegram_chat_bindings"), tx.index("intake_sessions"))
        self.assertLess(tx.index("intake_sessions"), tx.index("COMMIT"))

    def test_the_revoke_runs_first_in_both_branches_to_avoid_a_real_deadlock(self):
        # regression-planner reproduced an actual `40P01: deadlock detected`
        # against real Postgres: redeemGroupBindingToken's INSERT takes a
        # FOR KEY SHARE lock on `trips` through its FK to it, so with the
        # revoke last this transaction locked bindings/trips first and the
        # token row last — the OPPOSITE order from a concurrent
        # redeemGroupBindingToken call, which locks the token row first (its
        # own FOR UPDATE) and then waits on `trips` through the same FK.
        # Revoking first here matches that other transaction's order instead
        # of opposing it, in BOTH branches — the already-retired fast path
        # and the slug-rename path.
        for trip in (
            {"id": "trip_abcdefgh12", "slug": "retired-japan-2026-20260101", "orig": "japan-2026"},
            {"id": "trip_abcdefgh12", "slug": "japan-2026", "orig": "japan-2026"},
        ):
            with self.subTest(slug=trip["slug"]):
                seen: list[str] = []
                with mock.patch.object(teardown, "psql", side_effect=lambda sql: seen.append(sql) or "0"):
                    teardown.retire_in_db(trip)
                tx = seen[-1]
                self.assertLess(
                    tx.index("BEGIN"), tx.index("telegram_group_binding_tokens"),
                    "the revoke is not before BEGIN",
                )
                self.assertLess(
                    tx.index("telegram_group_binding_tokens"), tx.index("telegram_chat_bindings"),
                    "the revoke must run before the bindings-close, not after",
                )

    def test_the_revocation_never_touches_an_already_expired_token(self):
        # The table's own CHECK forbids expires_at <= created_at; only
        # touching a still-live token (expires_at > now()) is what keeps this
        # from ever trying to set an expiry at or before creation.
        seen: list[str] = []
        with mock.patch.object(teardown, "psql", side_effect=lambda sql: seen.append(sql) or "0"):
            teardown.retire_in_db({"id": "trip_abcdefgh12", "slug": "japan-2026", "orig": "japan-2026"})
        tx = seen[-1]
        self.assertIn("AND expires_at > now()", tx)


class OriginalSlug(unittest.TestCase):
    def test_a_retired_slug_still_names_its_old_resources(self):
        self.assertEqual(teardown.original_slug("retired-japan-2026-20260911"), "japan-2026")
        self.assertEqual(teardown.original_slug("retired-japan-2026-20260911-2"), "japan-2026")
        self.assertEqual(teardown.original_slug("italy-2026"), "italy-2026")


class ResourceSlug(unittest.TestCase):
    """Where a trip's container and deploy dir actually live."""

    def test_a_retired_trip_keeps_its_original_names(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "japan-2026").mkdir()
            self.assertEqual(teardown.resource_slug("retired-japan-2026-20260911", Path(d)), "japan-2026")

    def test_a_trip_built_after_it_was_retired_is_found_under_the_retired_name(self):
        # 2026-09-12: `--stop-after confirm --teardown` retired the trip while
        # the build confirming had started was still running, and the worker
        # finished it under the retired slug. Looking only under the original
        # name reported "nothing to do" over a live container.
        slug = "retired-draft-sreq-ed12c0c6fe8c5a4bfe926c1493094675-20260912"
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / slug).mkdir()
            self.assertEqual(teardown.resource_slug(slug, Path(d)), slug)

    def test_an_unretired_trip_is_its_own_slug(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(teardown.resource_slug("italy-2026", Path(d)), "italy-2026")

    def test_the_container_name_is_cut_where_proxmox_cuts_it(self):
        # compute.py's `f"trip-{slug}"[:63]`. The live container was named
        # `trip-retired-draft-sreq-…-202609`; comparing against the uncut name
        # refused a topology that described the trip exactly.
        slug = "retired-draft-sreq-ed12c0c6fe8c5a4bfe926c1493094675-20260912"
        self.assertEqual(teardown.expected_lxc_name(slug),
                         "trip-retired-draft-sreq-ed12c0c6fe8c5a4bfe926c1493094675-202609")
        self.assertEqual(teardown.expected_lxc_name("japan-2026"), "trip-japan-2026")


class Resolve(unittest.TestCase):
    def fake_psql(self, trip: dict, bound: str = "", shared: str = "0", open_: str = "0", live_tokens: str = "0"):
        def psql(sql: str) -> str:
            if "row_to_json" in sql:
                return json.dumps(trip)
            if "SELECT hermes_profile" in sql:
                return bound
            if "trip_id <>" in sql:
                return shared
            if "telegram_group_binding_tokens" in sql:
                return live_tokens
            return open_
        return mock.patch.object(teardown, "psql", side_effect=psql)

    def test_a_trip_real_people_used_is_refused(self):
        for state in ("activation_approved", "active", "completed", "sealed"):
            with self.fake_psql({"id": "trip_abcdefgh12", "slug": "japan-2026", "lifecycle_state": state}):
                with self.assertRaises(teardown.Refused):
                    teardown.resolve("japan-2026")

    def test_a_profile_another_trip_still_uses_is_refused(self):
        with self.fake_psql({"id": "trip_abcdefgh12", "slug": "japan-2026", "lifecycle_state": "ready_private"},
                            bound="japan2026", shared="1"):
            with self.assertRaises(teardown.Refused):
                teardown.resolve("japan-2026")

    def test_the_interviewer_is_never_a_companion_to_delete(self):
        with self.fake_psql({"id": "trip_abcdefgh12", "slug": "x-2026", "lifecycle_state": "draft"}, bound="trip-intake"):
            with self.assertRaises(teardown.Refused):
                teardown.resolve("x-2026")

    def test_a_test_trip_resolves_to_its_profile(self):
        with self.fake_psql({"id": "trip_abcdefgh12", "slug": "japan-2026", "lifecycle_state": "ready_private"}):
            trip = teardown.resolve("japan-2026")
        self.assertEqual((trip["orig"], trip["profile"]), ("japan-2026", "japan2026"))

    def test_a_live_group_binding_token_is_counted_so_the_dry_run_shows_it(self):
        # Before this, the dry-run's "database" line could read "(nothing to
        # do)" for a trip with zero open bindings and an already-retired slug
        # that nonetheless still has a live group-binding token to revoke.
        with self.fake_psql(
            {"id": "trip_abcdefgh12", "slug": "japan-2026", "lifecycle_state": "ready_private"},
            live_tokens="1",
        ):
            trip = teardown.resolve("japan-2026")
        self.assertEqual(trip["live_group_tokens"], 1)

    def test_input_that_is_neither_id_nor_slug_is_refused_before_any_query(self):
        with mock.patch.object(teardown, "psql") as psql:
            with self.assertRaises(teardown.Refused):
                teardown.resolve("x'; DROP TABLE trips; --")
            psql.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class KeepContainer(unittest.TestCase):
    """--keep-container: the renames that keep a kept site out of the next
    trip's way. Each one is a real hazard for the trip that takes the freed
    slug — see the docstring of scripts/teardown-trip.py."""

    RAW = {
        "version": 1, "name": "japan-2026",
        "proxmox": {"node": "proxmox", "vmid": "101", "lxc": {
            "name": "trip-japan-2026", "template": "local:vztmpl/debian.tar.zst", "storage": "local",
            "cores": 2, "memory_mb": 1024, "disk_gb": 8, "bridge": "vmbr0", "ipv4": "192.168.0.95/24",
            "gateway": "192.168.0.1", "nameserver": "192.168.0.41",
            "nfs_host_dir": "/mnt/pve/truenas-nfs/japan-2026", "nfs_mount_path": "/nfs/japan-2026"}},
        "npm": {"hostname": "japan-2026.example.store", "forward_host": "192.168.0.95", "forward_port": 8080},
        "cloudflare": {"tunnel_id": "t", "hostname": "japan-2026.example.store", "service": "http://localhost:80"},
    }

    def test_every_name_a_new_trip_of_the_slug_would_derive_is_moved_away(self):
        out = teardown.reference_topology(self.RAW, "japan-2026")
        lxc = out["proxmox"]["lxc"]
        self.assertEqual(out["name"], "ref-japan-2026")
        # provisioning finds a container by name: a kept trip-japan-2026 would be adopted
        self.assertNotEqual(lxc["name"], teardown.expected_lxc_name("japan-2026"))
        # a first provision of japan-2026 wipes nfs/japan-2026
        self.assertEqual(lxc["nfs_host_dir"], "/mnt/pve/truenas-nfs/ref-japan-2026")
        self.assertEqual(out["npm"]["hostname"], "ref-japan-2026.example.store")

    def test_a_data_dir_named_by_trip_id_is_left_where_it_is(self):
        # The rename exists so the next trip to take this slug cannot adopt
        # this family's data. A directory named by trip id cannot be adopted —
        # ids are never reused — so moving it would only break the kept site's
        # own mount for no gain.
        import copy
        raw = copy.deepcopy(self.RAW)
        raw["proxmox"]["lxc"]["nfs_host_dir"] = "/mnt/pve/truenas-nfs/trip_9f2c11aa4d"

        out = teardown.reference_topology(raw, "japan-2026")

        self.assertEqual(out["proxmox"]["lxc"]["nfs_host_dir"], "/mnt/pve/truenas-nfs/trip_9f2c11aa4d")
        self.assertEqual(out["name"], "ref-japan-2026", "everything else still moves")

    def test_the_address_and_the_path_inside_the_container_do_not_move(self):
        out = teardown.reference_topology(self.RAW, "japan-2026")
        # the site's own .env names the mount path; the IP allocator reads ipv4
        self.assertEqual(out["proxmox"]["lxc"]["nfs_mount_path"], "/nfs/japan-2026")
        self.assertIn("ipv4: 192.168.0.95/24", yaml.safe_dump(out))
        self.assertEqual(out["npm"]["forward_host"], "192.168.0.95")

    def test_the_input_is_not_changed_and_the_result_still_loads(self):
        before = json.dumps(self.RAW, sort_keys=True)
        out = teardown.reference_topology(self.RAW, "japan-2026")
        self.assertEqual(json.dumps(self.RAW, sort_keys=True), before)
        import sys
        sys.path.insert(0, str(SCRIPT.parents[1]))
        from provisioning.models import load_topology
        self.assertEqual(load_topology(out).lxc.name, "ref-japan-2026")

    def test_a_failure_after_stopping_still_starts_the_container_again(self):
        commands = []
        class Ssh:
            def run(self, command):
                commands.append(command)
                if command.startswith("mv "):
                    raise RuntimeError("mv failed")
                return ""
        class Proxmox:
            ssh = Ssh()
            def inspect(self, spec):
                return {"vmid": "101", "status": "running", "name": spec.name}
        prov = mock.Mock(proxmox=Proxmox())
        topo = mock.Mock(lxc=mock.Mock(name="trip-japan-2026", nfs_host_dir="/mnt/pve/truenas-nfs/japan-2026",
                                       nfs_mount_path="/nfs/japan-2026"))
        with self.assertRaises(RuntimeError):
            teardown.keep_container(prov, topo, "japan-2026")
        self.assertEqual(commands[-1], "pct start 101")
        self.assertIn("pct stop 101", commands)

    def test_an_existing_reference_dir_is_never_merged_into(self):
        class Ssh:
            def run(self, command):
                if command.startswith("test -e"):
                    return "EXISTS\n"
                raise AssertionError(f"ran {command!r} after finding the target exists")
        class Proxmox:
            ssh = Ssh()
            def inspect(self, spec):
                return {"vmid": "101", "status": "running", "name": "trip-japan-2026"}
        topo = mock.Mock(lxc=mock.Mock(nfs_host_dir="/mnt/pve/truenas-nfs/japan-2026", nfs_mount_path="/nfs/japan-2026"))
        with self.assertRaises(RuntimeError):
            teardown.keep_container(mock.Mock(proxmox=Proxmox()), topo, "japan-2026")


class DocumentTablesAlignment(unittest.TestCase):
    """DOCUMENT_TABLES must name every table the document-store feature owns —
    found independently here, from the TypeScript source, rather than from
    DOCUMENT_TABLES itself: a table added on one side and forgotten on the
    other must fail this test, not agree with itself.

    source_artifacts is real (created in 0001_foundation.sql, not a
    document-registry table by origin) and belongs here on its own terms —
    document-registry.ts reads and writes it, so the same backup-before-
    teardown obligation applies. An earlier report called it a phantom; it is
    not. Whether teardown SHOULD back it up is a separate product question,
    decided as: yes, for now — Dror, 2026-09-21.

    intake_sessions/intake_versions/trip_memberships are excluded:
    document-correction.ts joins against them, but they are pre-existing
    tables the document-store feature does not own, and this test's job is
    the tables it does.
    """

    REPO_ROOT = SCRIPT.parents[1]
    SOURCE_FILES = (
        "control-plane/api/src/document-registry.ts",
        "control-plane/api/src/document-intake.ts",
        "control-plane/api/src/answer-provenance.ts",
        "control-plane/api/src/document-correction.ts",
    )
    NOT_DOCUMENT_TABLES = {"intake_sessions", "intake_versions", "trip_memberships"}

    def test_document_tables_matches_every_table_the_ts_source_references(self):
        found: set[str] = set()
        for rel in self.SOURCE_FILES:
            text = (self.REPO_ROOT / rel).read_text(encoding="utf-8")
            found |= set(re.findall(r"control_plane\.([a-z_]+)", text))
        found -= self.NOT_DOCUMENT_TABLES
        self.assertEqual(
            found, set(teardown.DOCUMENT_TABLES),
            "DOCUMENT_TABLES has drifted from the tables document-registry.ts / "
            "document-intake.ts / answer-provenance.ts / document-correction.ts "
            "actually reference — a table added on one side and not the other "
            "would otherwise back up nothing for it, silently.",
        )


class BuildProvisioner(unittest.TestCase):
    """Teardown inspects and deletes; it never calls create_container, so it
    never allocates. The pool it passes is therefore dead input — and a dead
    default that names a real address is the kind that is believed later, on a
    host whose Proxmox is shared with another stack."""

    def patched_adapter(self):
        import sys
        sys.path[:0] = [str(teardown.REPO / "control-plane/worker"), str(teardown.REPO)]
        import control_plane_worker.compute as compute
        return mock.patch.object(compute, "LxcProvisionAdapter")

    def build(self, env):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(teardown, "DEPLOY_ROOT", Path(d)), \
                mock.patch.dict(teardown.os.environ, env), \
                self.patched_adapter() as adapter:
            teardown.os.environ.pop("PROVISIONER_LXC_IP_POOL", None)
            teardown.os.environ.update(env)
            teardown.build_provisioner()
        return adapter.call_args.kwargs

    def test_a_pool_in_the_environment_is_not_adopted(self):
        # the Mac's own pool spans .60-.99 and overlaps the VM's reserved .95-.99
        self.assertEqual(self.build({"PROVISIONER_LXC_IP_POOL": '["192.168.0.95"]'})["ip_pool"], [])

    def test_it_needs_no_pool_variable_at_all(self):
        self.assertEqual(self.build({})["ip_pool"], [])
