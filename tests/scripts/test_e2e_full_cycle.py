"""scripts/e2e-full-cycle.py leaves nothing behind on a run that passed.

Every automated run used to add a loose /tmp/kinerary-e2e-fake-telegram-<port>.log
and regenerate /tmp/kinerary-e2e-<scenario>/ — five stand-in logs had piled up
by the evening of 2026-09-11, none of them from a run anyone needed to read.
"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

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
