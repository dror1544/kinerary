"""Test-resource selection. Sprint 0 supports dry-run only."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable


class UnsafeCleanupError(ValueError):
    pass


_TEST_RUN_ID = re.compile(r"^tr_[a-z0-9]{8,64}$")
_TEST_NAME_PREFIX = re.compile(r"^kinerary-test-[a-z0-9-]+$")


def load_test_resource_name_prefix(architecture_profile: str) -> str:
    raw = json.loads(Path(architecture_profile).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise UnsafeCleanupError("architecture profile must be a JSON object")
    if raw.get("environment") == "production":
        raise UnsafeCleanupError("test resource selection is disabled in production")
    test_resources = raw.get("test_resources")
    if not isinstance(test_resources, dict) or test_resources.get("enabled") is not True:
        raise UnsafeCleanupError("test resource selection is disabled by the architecture profile")
    if test_resources.get("label_key") != "kinerary.test_run_id":
        raise UnsafeCleanupError("architecture profile has no safe test resource label key")
    prefix = test_resources.get("allowed_name_prefix")
    if not isinstance(prefix, str) or not _TEST_NAME_PREFIX.fullmatch(prefix):
        raise UnsafeCleanupError("architecture profile has no safe test resource name prefix")
    return prefix


def select_test_resources(
    resources: Iterable[dict[str, Any]], test_run_id: str, allowed_name_prefix: str
) -> list[dict[str, Any]]:
    if not _TEST_RUN_ID.fullmatch(test_run_id):
        raise UnsafeCleanupError("a concrete test run ID is required")
    selected: list[dict[str, Any]] = []
    for resource in resources:
        if resource.get("test_run_id") != test_run_id:
            continue
        if resource.get("environment") != "test":
            raise UnsafeCleanupError("refusing a non-test resource carrying a test label")
        if not str(resource.get("name", "")).startswith(allowed_name_prefix):
            raise UnsafeCleanupError("refusing a labelled resource outside the test name allocation")
        selected.append(resource)
    return selected
