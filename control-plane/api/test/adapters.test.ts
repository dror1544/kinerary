import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeAdapter } from "../src/adapters/fake.js";
import type { AdapterRequest } from "../src/contracts.js";

const request: AdapterRequest = {
  schema_version: 1,
  request_id: "req_abcdefgh",
  correlation_id: "corr_abcdefgh",
  idempotency_key: "provision-trip_abcdefgh-v1",
  adapter: "fake_compute",
  operation: "inspect",
  test_run_id: "tr_abcdefgh",
  payload: { resource_ref: "prv_abcdefgh" },
};

test("fake adapters propagate request, correlation and idempotency identities", async () => {
  const adapter = new FakeAdapter();
  const result = await adapter.execute(request);
  assert.equal(result.request_id, request.request_id);
  assert.equal(result.correlation_id, request.correlation_id);
  assert.equal(result.idempotency_key, request.idempotency_key);
  assert.deepEqual(adapter.requests, [request]);
});

test("controlled adapter failures return a safe code and no side effect", async () => {
  const adapter = new FakeAdapter("fail");
  const result = await adapter.execute(request);
  assert.equal(result.status, "failed");
  assert.equal(result.changed, false);
  assert.equal(result.safe_error_code, "FAKE_CONTROLLED_FAILURE");
});
