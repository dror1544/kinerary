"""Deterministic fakes shared by worker contract tests."""
from __future__ import annotations

from dataclasses import dataclass, field

from .contracts import AdapterRequest, AdapterResult
from .worker import Job


@dataclass
class FakeAdapter:
    fail: bool = False
    requests: list[AdapterRequest] = field(default_factory=list)

    def execute(self, request: AdapterRequest) -> AdapterResult:
        self.requests.append(request)
        return AdapterResult(
            request_id=request.request_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            adapter=request.adapter,
            operation=request.operation,
            status="failed" if self.fail else "succeeded",
            changed=False,
            safe_error_code="FAKE_CONTROLLED_FAILURE" if self.fail else None,
        )


@dataclass
class MemoryJobRepository:
    jobs: list[Job]
    completed: dict[str, AdapterResult] = field(default_factory=dict)
    failed: dict[str, AdapterResult] = field(default_factory=dict)

    def claim(self) -> Job | None:
        return self.jobs.pop(0) if self.jobs else None

    def complete(self, job_id: str, result: AdapterResult) -> None:
        self.completed[job_id] = result

    def fail(self, job_id: str, result: AdapterResult) -> None:
        self.failed[job_id] = result
