"""One-job worker loop. There is deliberately no public HTTP listener."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Protocol

from .contracts import AdapterRequest, AdapterResult


@dataclass(frozen=True)
class Job:
    id: str
    request_id: str
    correlation_id: str
    idempotency_key: str
    adapter: str
    operation: str
    payload: Mapping[str, object]
    test_run_id: str | None = None


class JobRepository(Protocol):
    def claim(self) -> Job | None: ...
    def complete(self, job_id: str, result: AdapterResult) -> None: ...
    def fail(self, job_id: str, result: AdapterResult) -> None: ...


class Adapter(Protocol):
    def execute(self, request: AdapterRequest) -> AdapterResult: ...


class Worker:
    def __init__(self, repository: JobRepository, adapters: Mapping[str, Adapter]) -> None:
        self.repository = repository
        self.adapters = adapters

    def run_once(self) -> bool:
        job = self.repository.claim()
        if job is None:
            return False
        try:
            request = AdapterRequest(
                request_id=job.request_id,
                correlation_id=job.correlation_id,
                idempotency_key=job.idempotency_key,
                adapter=job.adapter,
                operation=job.operation,
                payload=job.payload,
                test_run_id=job.test_run_id,
            )
        except ValueError:
            result = AdapterResult(
                request_id=job.request_id,
                correlation_id=job.correlation_id,
                idempotency_key=job.idempotency_key,
                adapter=job.adapter,
                operation=job.operation,
                status="failed",
                changed=False,
                safe_error_code="INVALID_JOB_CONTRACT",
            )
        else:
            adapter = self.adapters.get(job.adapter)
            if adapter is None:
                result = AdapterResult(
                    request_id=job.request_id,
                    correlation_id=job.correlation_id,
                    idempotency_key=job.idempotency_key,
                    adapter=job.adapter,
                    operation=job.operation,
                    status="failed",
                    changed=False,
                    safe_error_code="UNKNOWN_ADAPTER",
                )
            else:
                try:
                    result = adapter.execute(request)
                except Exception:
                    # Adapters must normally return a controlled AdapterResult.
                    # An unexpected provider/parser exception is durable but is
                    # never misreported as an invalid control-plane contract.
                    result = AdapterResult(
                        request_id=job.request_id,
                        correlation_id=job.correlation_id,
                        idempotency_key=job.idempotency_key,
                        adapter=job.adapter,
                        operation=job.operation,
                        status="failed",
                        changed=False,
                        safe_error_code="ADAPTER_EXECUTION_FAILED",
                    )
        if result.status == "failed":
            self.repository.fail(job.id, result)
        else:
            self.repository.complete(job.id, result)
        return True
