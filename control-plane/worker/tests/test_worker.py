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

    def test_unknown_adapter_is_distinct_from_an_invalid_contract(self) -> None:
        repository = MemoryJobRepository([job(adapter="missing_adapter")])
        Worker(repository, {}).run_once()
        self.assertEqual("UNKNOWN_ADAPTER", repository.failed["job_abcdefgh"].safe_error_code)

    def test_controlled_provider_failure_is_recorded_without_change(self) -> None:
        repository = MemoryJobRepository([job()])
        adapter = FakeAdapter(fail=True)
        Worker(repository, {"fake_compute": adapter}).run_once()
        result = repository.failed["job_abcdefgh"]
        self.assertFalse(result.changed)
        self.assertEqual("FAKE_CONTROLLED_FAILURE", result.safe_error_code)

    def test_adapter_value_and_key_errors_are_not_mislabelled_as_contract_errors(self) -> None:
        class BrokenAdapter:
            def execute(self, _request: object) -> object:
                raise ValueError("provider parser failed")

        repository = MemoryJobRepository([job()])
        Worker(repository, {"fake_compute": BrokenAdapter()}).run_once()  # type: ignore[arg-type]
        self.assertEqual("ADAPTER_EXECUTION_FAILED", repository.failed["job_abcdefgh"].safe_error_code)

        class MissingFieldAdapter:
            def execute(self, _request: object) -> object:
                raise KeyError("provider response field")

        repository = MemoryJobRepository([job()])
        Worker(repository, {"fake_compute": MissingFieldAdapter()}).run_once()  # type: ignore[arg-type]
        self.assertEqual("ADAPTER_EXECUTION_FAILED", repository.failed["job_abcdefgh"].safe_error_code)

    def test_opaque_id_prefix_length_matches_the_shared_contract(self) -> None:
        repository = MemoryJobRepository([job(request_id="abcdefghijkl_abcdefgh")])
        Worker(repository, {"fake_compute": FakeAdapter()}).run_once()
        self.assertIn("job_abcdefgh", repository.completed)

        repository = MemoryJobRepository([job(request_id="abcdefghijklm_abcdefgh")])
        Worker(repository, {"fake_compute": FakeAdapter()}).run_once()
        self.assertEqual("INVALID_JOB_CONTRACT", repository.failed["job_abcdefgh"].safe_error_code)


if __name__ == "__main__":
    unittest.main()
