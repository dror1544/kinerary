"""scripts/process-metrics.py — counting the hook's decision log."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "process_metrics", Path(__file__).resolve().parents[2] / "scripts" / "process-metrics.py")
pm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pm)

LOG = [
    "2026-09-26T08:00:00Z\ts1\tlead\tcommit\tallow",
    "2026-09-26T08:01:00Z\ts1\tlead\tmerge\task",
    "2026-09-26T08:02:00Z\ts2\tdeveloper\tcommit\tdeny",
    "2026-09-27T09:00:00Z\ts1\tlead\tmerge\task",
    "not a row",
]


class Counting(unittest.TestCase):
    def test_counts_by_kind_and_decision(self):
        c = pm.count_decisions(LOG)
        self.assertEqual(c[("merge", "ask")], 2)
        self.assertEqual(c[("commit", "allow")], 1)
        self.assertEqual(c[("commit", "deny")], 1)

    def test_the_window_is_half_open(self):
        c = pm.count_decisions(LOG, since=pm.when("2026-09-26T08:01:00Z"), until=pm.when("2026-09-27T09:00:00Z"))
        self.assertEqual(dict(c), {("merge", "ask"): 1, ("commit", "deny"): 1})


if __name__ == "__main__":
    unittest.main()
