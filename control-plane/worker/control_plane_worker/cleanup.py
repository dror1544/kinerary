"""Test-resource selection. Sprint 0 supports dry-run only."""
from __future__ import annotations

from typing import Any, Iterable


class UnsafeCleanupError(ValueError):
    pass


def select_test_resources(resources: Iterable[dict[str, Any]], test_run_id: str) -> list[dict[str, Any]]:
    if not test_run_id.startswith("tr_") or len(test_run_id) < 11:
        raise UnsafeCleanupError("a concrete test run ID is required")
    selected: list[dict[str, Any]] = []
    for resource in resources:
        if resource.get("test_run_id") != test_run_id:
            continue
        if resource.get("environment") != "test":
            raise UnsafeCleanupError("refusing a non-test resource carrying a test label")
        if not str(resource.get("name", "")).startswith("kinerary-test-"):
            raise UnsafeCleanupError("refusing a labelled resource outside the test name allocation")
        selected.append(resource)
    return selected
