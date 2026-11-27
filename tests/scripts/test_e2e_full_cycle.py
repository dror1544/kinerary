"""scripts/e2e-full-cycle.py leaves nothing behind on a run that passed.

Every automated run used to add a loose /tmp/kinerary-e2e-fake-telegram-<port>.log
and regenerate /tmp/kinerary-e2e-<scenario>/ — five stand-in logs had piled up
by the evening of 2026-09-11, none of them from a run anyone needed to read.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "e2e-full-cycle.py"


def load():
    spec = importlib.util.spec_from_file_location("e2e_full_cycle", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkDirTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load()
        self.work = Path(tempfile.mkdtemp(prefix="e2e-test-"))
        (self.work / "japan").mkdir()
        (self.work / "fake-telegram.log").write_text("getUpdates\n")

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.work, ignore_errors=True)

    def test_a_passing_run_removes_its_documents_and_logs(self) -> None:
        self.mod.finish_workdir(self.work, passed=True)
        self.assertFalse(self.work.exists())

    def test_a_failing_run_keeps_them_for_whoever_reads_the_failure(self) -> None:
        self.mod.finish_workdir(self.work, passed=False)
        self.assertTrue((self.work / "fake-telegram.log").exists())

    def test_the_stand_ins_log_lives_in_the_runs_own_directory(self) -> None:
        self.assertEqual(self.mod.Auto(self.work).log.parent, self.work)


class TeardownInterpreterTests(unittest.TestCase):
    """The Python teardown runs under the interpreter that invoked it.

    `teardown-trip.py` opens `#!/usr/bin/env python3`, so launching it as a
    bare script hands it whichever python is first on the caller's PATH. On
    2026-09-18 that was a stray `.venv-telegram-manager` (3.9.6, python.org
    framework, CA store never populated), and all three scenarios of a full
    run ended the same way:

        ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED]
        certificate verify failed: unable to get local issuer certificate
        ✗ teardown exited 1 — see above; the trip may be half-removed

    It died reading Cloudflare, before touching anything, so three trips were
    left fully provisioned on shared infrastructure — container, DNS, proxy
    host, profile and all. Nothing was wrong with the teardown; it was handed
    an interpreter that cannot speak TLS.

    The preflight provides a venv precisely so its tools have their
    dependencies. `sys.executable` is that venv, so the teardown gets the same
    interpreter, the same packages and the same trust store as the run that
    called it — and none of it depends on a shell's PATH any more.
    """

    def setUp(self) -> None:
        self.mod = load()

    def run_teardown(self, env: dict) -> list[str]:
        seen: list[list[str]] = []

        def fake_run(argv, *a, **kw):
            seen.append(list(argv))
            return mock.Mock(returncode=0)

        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(self.mod.subprocess, "run", fake_run):
            self.mod.stage_teardown({"trip_id": "trip_deadbeef"})
        self.assertEqual(len(seen), 1, "teardown runs exactly one command")
        return seen[0]

    def test_a_python_teardown_is_run_through_sys_executable(self) -> None:
        argv = self.run_teardown({"KINERARY_TEARDOWN": ""})
        script = str(self.mod.REPO / "scripts/teardown-trip.py")
        self.assertEqual(argv[0], sys.executable, "the interpreter is named, not left to PATH")
        self.assertEqual(argv[1], script)
        self.assertEqual(argv[2:], ["--trip", "trip_deadbeef", "--execute"])

    def test_the_script_is_never_executed_directly(self) -> None:
        # The drift this guards: `subprocess.run([script, ...])` reads the
        # shebang, and the shebang reads PATH.
        argv = self.run_teardown({"KINERARY_TEARDOWN": ""})
        self.assertTrue(argv[0].endswith(("python", "python3", "python3.12", "python3.13"))
                        or argv[0] == sys.executable,
                        f"argv[0] should be an interpreter, got {argv[0]}")
        self.assertFalse(argv[0].endswith(".py"), "the script must not be argv[0]")

    def test_a_non_python_twin_is_left_alone(self) -> None:
        # KINERARY_TEARDOWN names the VM's shell twin
        # (control-plane/deployment/vm-teardown-trip.sh). It is not Python and
        # must keep being run as itself — the fix is about which interpreter a
        # PYTHON script gets, not about wrapping everything in one.
        argv = self.run_teardown({"KINERARY_TEARDOWN": "/opt/kinerary/vm-teardown-trip.sh"})
        self.assertEqual(argv, ["/opt/kinerary/vm-teardown-trip.sh", "--trip", "trip_deadbeef", "--execute"])

    def test_a_python_twin_gets_the_interpreter_too(self) -> None:
        # The rule is about the LANGUAGE of the script, not about which of the
        # two paths named it.
        argv = self.run_teardown({"KINERARY_TEARDOWN": "/somewhere/other-teardown.py"})
        self.assertEqual(argv[:2], [sys.executable, "/somewhere/other-teardown.py"])


class TeardownIsRunAgainAfterAFailure(unittest.TestCase):
    """A teardown that fails part-way is run again, after a pause, up to TEARDOWN_ATTEMPTS times.

    teardown-trip.py reads what is left before each step, so a second run carries on where the first stopped.
    On 2026-11-18 one SSH connect to the Proxmox host timed out mid-teardown and failed the night; the same
    command finished cleanly later that day.
    """

    def setUp(self) -> None:
        self.mod = load()

    def run_with(self, codes: list[int]) -> tuple[int, int, list[float]]:
        calls: list[list[str]] = []
        sleeps: list[float] = []

        def fake_run(argv, *a, **kw):
            calls.append(list(argv))
            return mock.Mock(returncode=codes[len(calls) - 1])

        with mock.patch.dict(os.environ, {"KINERARY_TEARDOWN": ""}, clear=False), \
                mock.patch.object(self.mod.subprocess, "run", fake_run), \
                mock.patch.object(self.mod.time, "sleep", sleeps.append):
            code = self.mod.stage_teardown({"trip_id": "trip_deadbeef"})
        self.assertTrue(all(call[-3:] == ["--trip", "trip_deadbeef", "--execute"] for call in calls),
                        "every attempt removes the same trip, by its id")
        return code, len(calls), sleeps

    def test_a_failure_then_a_success_passes(self) -> None:
        code, attempts, sleeps = self.run_with([1, 0])
        self.assertEqual((code, attempts), (0, 2))
        self.assertEqual(sleeps, [self.mod.TEARDOWN_RETRY_SECONDS])

    def test_it_gives_up_after_the_last_attempt_and_reports_the_failure(self) -> None:
        code, attempts, sleeps = self.run_with([1] * self.mod.TEARDOWN_ATTEMPTS)
        self.assertEqual((code, attempts), (1, self.mod.TEARDOWN_ATTEMPTS))
        self.assertEqual(len(sleeps), self.mod.TEARDOWN_ATTEMPTS - 1, "no pause after the last attempt")

    def test_a_clean_teardown_runs_once_with_no_pause(self) -> None:
        self.assertEqual(self.run_with([0]), (0, 1, []))

    def test_a_vm_container_trip_is_torn_down_through_the_same_script_by_its_id_and_nothing_pct(self) -> None:
        # teardown-trip.py dispatches on the topology's placement itself (AC-8); the harness must not add a second path
        # (a hand-run `pct` or a renamed topology, which is what had to be done by hand on 2026-11-27).
        calls: list[list[str]] = []

        def fake_run(argv, *a, **kw):
            calls.append(list(argv))
            return mock.Mock(returncode=0)

        with mock.patch.dict(os.environ, {"KINERARY_TEARDOWN": ""}, clear=False), \
                mock.patch.object(self.mod.subprocess, "run", fake_run):
            code = self.mod.stage_teardown({"trip_id": "trip_deadbeef", "placement": "vm-container", "vmid": None})
        self.assertEqual(0, code)
        self.assertEqual(1, len(calls))
        self.assertTrue(calls[0][1].endswith("teardown-trip.py"))
        self.assertEqual(["--trip", "trip_deadbeef", "--execute"], calls[0][-3:])
        self.assertFalse(any("pct" in word for call in calls for word in call))


if __name__ == "__main__":
    unittest.main()


class ApprovalAnswersThisDocument(unittest.TestCase):
    """The approval must answer the companion's question about the file.

    `approve_until` polls for what the bot has said and replies "Yes, go ahead"
    to anything new. It started every wait at sequence 0, and no chat is empty
    by then — the router posts and pins a welcome in a freshly bound group, and
    the companion has already spoken in the DM. So the first poll matched
    history and approved before anything had been asked. The site assertion
    still passed, which is the problem: the run stopped substantiating the
    "it asks before it writes" guarantee it exists to prove.
    """

    def setUp(self) -> None:
        self.mod = load()

    def _auto(self, messages: list[dict]):
        auto = self.mod.Auto.__new__(self.mod.Auto)
        auto.said = lambda chat, after=0: [m for m in messages if m["seq"] > after]
        return auto

    def test_seq_now_reports_where_the_chat_has_got_to(self) -> None:
        auto = self._auto([{"seq": 4, "kind": "send"}, {"seq": 9, "kind": "send"},
                           {"seq": 7, "kind": "send"}])
        self.assertEqual(auto.seq_now("-100123"), 9)

    def test_seq_now_is_zero_in_a_chat_nobody_has_spoken_in(self) -> None:
        self.assertEqual(self._auto([]).seq_now("-100123"), 0)

    def test_every_wait_starts_from_a_sequence_taken_before_the_document(self) -> None:
        import ast

        tree = ast.parse(SCRIPT.read_text())
        wait = next((n for n in ast.walk(tree)
                     if isinstance(n, ast.FunctionDef) and n.name == "approve_until"), None)
        self.assertIsNotNone(wait, "approve_until is gone — has the wait moved?")
        self.assertIn("since", [a.arg for a in wait.args.args],
                      "approve_until must be told where the chat stood before the document")

        # `seen` is that argument, not a constant: `seen, deadline = since, ...`
        seeds = [t for n in ast.walk(wait) if isinstance(n, ast.Assign)
                 for t in ([n.value] if not isinstance(n.value, ast.Tuple) else n.value.elts)
                 if any(getattr(x, "id", None) == "seen"
                        for tgt in n.targets
                        for x in (tgt.elts if isinstance(tgt, ast.Tuple) else [tgt]))]
        self.assertTrue(seeds, "nothing initializes `seen`")
        self.assertTrue(
            any(isinstance(s, ast.Name) and s.id == "since" for s in seeds),
            "`seen` must start at `since`; a constant makes the first poll match history",
        )

        for call in [n for n in ast.walk(tree)
                     if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "approve_until"]:
            last = call.args[-1]
            self.assertIsInstance(
                last, ast.Name,
                "pass the sequence captured before the document, not a literal",
            )


class VerificationEvidenceTests(unittest.TestCase):
    """The six checks every build records, plus site_to_bridge when the trip is built on the
    shared trip-mcp bridge (TRIP_MCP_BRIDGE=shared). Found on the VM e2e of 2026-11-26: a
    correct shared-bridge build failed here because it recorded seven rows."""

    BASE = {"backup_checkpoint": "skipped", "mcp_isolation": "skipped", "messaging_binding": "skipped",
            "release_compatibility": "passed", "rendered_data": "passed", "runtime_health": "passed"}

    def setUp(self) -> None:
        self.mod = load()

    def test_the_six_base_checks_pass(self) -> None:
        self.assertEqual(self.mod.evidence_problems(dict(self.BASE)), [])

    def test_a_passed_site_to_bridge_is_accepted(self) -> None:
        self.assertEqual(self.mod.evidence_problems({**self.BASE, "site_to_bridge": "passed"}), [])

    def test_a_failed_site_to_bridge_is_a_problem(self) -> None:
        problems = self.mod.evidence_problems({**self.BASE, "site_to_bridge": "failed"})
        self.assertEqual(len(problems), 1)
        self.assertIn("site_to_bridge", problems[0])

    def test_a_missing_base_check_is_a_problem(self) -> None:
        evidence = dict(self.BASE); del evidence["mcp_isolation"]
        self.assertTrue(any("mcp_isolation" in p for p in self.mod.evidence_problems(evidence)))

    def test_an_unknown_check_is_a_problem(self) -> None:
        self.assertTrue(any("surprise" in p for p in self.mod.evidence_problems({**self.BASE, "surprise": "passed"})))


class VmContainerPlacementTests(unittest.TestCase):
    """The harness reads a trip's own files where its placement keeps them (spec x-trip-vm-container-placement.md,
    AC-10): a vm-container trip has no container id to `pct exec` into, so its `.env` and config come from the trip's
    directory on the document store, and its evidence names stay what a build records."""

    TRIP = "trip_0123456789abcdef0123456789abcdef"
    CONTAINER_TOPOLOGY = (
        "version: 1\nname: alsace-2026\nplacement: vm-container\nrouting: wildcard\ncontainer:\n"
        "  name: trip-alsace-2026\n  ipv4: 10.250.0.10\n  forward_port: 8080\n"
        "  public_hostname: alsace-2026.trips.example.invalid\n"
        f"  nfs_host_dir: /srv/kinerary-nfs/{TRIP}\n  nfs_mount_path: /trip-store\n  image: trip-site:{'ab' * 32}\n")
    LXC_TOPOLOGY = (
        "version: 1\nname: alsace-2026\nproxmox:\n  node: pve\n  vmid: '205'\n  lxc:\n    ipv4: 192.0.2.210/24\n"
        "    nfs_host_dir: /mnt/pve/nfs/trip_9f2c11aa4d\n")

    def setUp(self) -> None:
        import shutil
        self.mod = load()
        self.tmp = Path(tempfile.mkdtemp(prefix="e2e-placement-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = self.tmp / "nfs"
        (self.root / self.TRIP / "trip").mkdir(parents=True)
        (self.root / self.TRIP / "trip" / "trip.config.json").write_text('{"meta": {"title": "Alsace"}}')
        (self.root / self.TRIP / ".env").write_text("SEED_PASSWORD=k7mq-x3ra-pw9d-hn4t\nJWT_SECRET=x\n")

    def topology(self, text: str) -> Path:
        path = self.tmp / "topology.yaml"
        path.write_text(text)
        return path

    def test_the_placement_is_read_off_the_topology_and_absent_means_lxc(self) -> None:
        self.assertEqual("vm-container", self.mod.topology_placement(self.topology(self.CONTAINER_TOPOLOGY)))
        self.assertEqual("lxc", self.mod.topology_placement(self.topology(self.LXC_TOPOLOGY)))

    def test_the_stores_directory_is_the_hosts_root_and_the_trip_id_and_never_the_workers_path(self) -> None:
        got = self.mod.trip_store_dir(self.topology(self.CONTAINER_TOPOLOGY), str(self.root))
        self.assertEqual(self.root / self.TRIP, got)

    def test_without_the_roots_setting_it_fails_loudly_naming_it(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(self.mod.Failed, "KINERARY_NFS_ROOT"):
            self.mod.trip_store_dir(self.topology(self.CONTAINER_TOPOLOGY))

    def test_a_topology_that_names_no_trip_id_directory_is_refused(self) -> None:
        text = self.CONTAINER_TOPOLOGY.replace(self.TRIP, "../../etc")
        with self.assertRaisesRegex(self.mod.Failed, "trip-id directory"):
            self.mod.trip_store_dir(self.topology(text), str(self.root))

    def test_a_container_trips_files_come_from_its_directory_and_no_pct_is_run(self) -> None:
        ctx = {"slug": "alsace-2026", "placement": "vm-container", "vmid": None, "store": self.root / self.TRIP}
        calls = []
        env = self.mod.read_site_file(ctx, ".env", run=lambda *a, **k: calls.append(a))
        config = self.mod.read_site_file(ctx, "trip.config.json", run=lambda *a, **k: calls.append(a))
        self.assertIn("SEED_PASSWORD=k7mq-x3ra-pw9d-hn4t", env)
        self.assertIn("Alsace", config)
        self.assertEqual([], calls)

    def test_an_lxc_trips_files_are_still_read_with_pct_exec_in_its_own_container(self) -> None:
        import subprocess
        ctx = {"slug": "alsace-2026", "placement": "lxc", "vmid": "205"}
        seen = []

        def run(argv, **kw):
            seen.append(argv[-1])
            return subprocess.CompletedProcess(argv, 0, stdout="X", stderr="")
        self.assertEqual("X", self.mod.read_site_file(ctx, ".env", run=run))
        self.assertEqual("X", self.mod.read_site_file(ctx, "trip.config.json", run=run))
        self.assertEqual(["pct exec 205 -- cat /opt/kinerary/.env",
                          "pct exec 205 -- cat /opt/kinerary/trips/alsace-2026/trip.config.json"], seen)

    def test_a_file_the_site_does_not_hold_is_not_a_file_to_ask_for(self) -> None:
        with self.assertRaises(ValueError):
            self.mod.read_site_file({"placement": "vm-container", "store": self.root / self.TRIP}, "../../etc/passwd")

    def test_a_container_trip_must_have_recorded_site_to_bridge_and_an_lxc_need_not(self) -> None:
        base = VerificationEvidenceTests.BASE
        self.assertEqual([], self.mod.evidence_problems(dict(base)))
        problems = self.mod.evidence_problems(dict(base), shared_bridge_required=True)
        self.assertEqual(1, len(problems))
        self.assertIn("site_to_bridge missing", problems[0])
        self.assertEqual([], self.mod.evidence_problems({**base, "site_to_bridge": "passed"}, shared_bridge_required=True))
        self.assertTrue(self.mod.evidence_problems({**base, "site_to_bridge": "failed"}, shared_bridge_required=True))

    def test_the_per_trip_bridge_restart_is_not_a_container_trips_business(self) -> None:
        ctx = {"slug": "alsace-2026", "placement": "vm-container", "vmid": None}
        ran = self.mod.stage_bridge_reach(ctx, system="Darwin", run=lambda *a, **k: self.fail("nothing is run"))
        self.assertFalse(ran)

    def test_only_read_site_file_may_pct_exec_into_a_trips_container(self) -> None:
        # every read of a site's own file goes through read_site_file, the one place that branches on placement
        self.assertEqual(1, SCRIPT.read_text().count("pct exec {ctx['vmid']}"))
