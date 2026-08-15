from __future__ import annotations

import unittest

from control_plane_worker.fakes import FakeAdapter, MemoryJobRepository
from control_plane_worker.worker import Job, Worker


def job(**changes: object) -> Job:
    values = {
        "id": "job_abcdefgh",
        "request_id": "req_abcdefgh",
        "correlation_id": "corr_abcdefgh",
        "idempotency_key": "provision-japan-v1",
        "adapter": "fake_compute",
        "operation": "inspect",
        "payload": {"resource_ref": "prv_abcdefgh"},
        "test_run_id": "tr_abcdefgh",
    }
    values.update(changes)
    return Job(**values)  # type: ignore[arg-type]


class WorkerTests(unittest.TestCase):
    def test_propagates_contract_identities_to_adapter_and_result(self) -> None:
        repository = MemoryJobRepository([job()])
        adapter = FakeAdapter()
        self.assertTrue(Worker(repository, {"fake_compute": adapter}).run_once())
        self.assertEqual("corr_abcdefgh", adapter.requests[0].correlation_id)
        self.assertEqual("provision-japan-v1", repository.completed["job_abcdefgh"].idempotency_key)

    def test_invalid_contract_fails_durably_without_calling_adapter(self) -> None:
        repository = MemoryJobRepository([job(request_id="raw-provider-id")])
        adapter = FakeAdapter()
        Worker(repository, {"fake_compute": adapter}).run_once()
        self.assertEqual([], adapter.requests)
        self.assertEqual("INVALID_JOB_CONTRACT", repository.failed["job_abcdefgh"].safe_error_code)

    def test_controlled_provider_failure_is_recorded_without_change(self) -> None:
        repository = MemoryJobRepository([job()])
        adapter = FakeAdapter(fail=True)
        Worker(repository, {"fake_compute": adapter}).run_once()
        result = repository.failed["job_abcdefgh"]
        self.assertFalse(result.changed)
        self.assertEqual("FAKE_CONTROLLED_FAILURE", result.safe_error_code)


if __name__ == "__main__":
    unittest.main()
