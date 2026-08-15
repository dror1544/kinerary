import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contractsDir = fileURLToPath(new URL("../../contracts/v1/", import.meta.url));
const schemaFiles = ["adapter-request.schema.json", "adapter-result.schema.json", "records.schema.json"];

test("every v1 JSON schema compiles under draft 2020-12", async () => {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
  addFormats(ajv);
  for (const file of schemaFiles) {
    const schema = JSON.parse(await readFile(`${contractsDir}/${file}`, "utf8"));
    assert.doesNotThrow(() => ajv.compile(schema), file);
  }
});

test("the shared request/result schemas require propagation identities", async () => {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
  const requestSchema = JSON.parse(await readFile(`${contractsDir}/adapter-request.schema.json`, "utf8"));
  const resultSchema = JSON.parse(await readFile(`${contractsDir}/adapter-result.schema.json`, "utf8"));
  const validateRequest = ajv.compile(requestSchema);
  const validateResult = ajv.compile(resultSchema);
  assert.equal(validateRequest({ schema_version: 1, adapter: "fake", operation: "inspect", payload: {} }), false);
  assert.match(JSON.stringify(validateRequest.errors), /request_id|correlation_id|idempotency_key/);

  const twelveCharacterPrefix = "abcdefghijkl_abcdefgh";
  const thirteenCharacterPrefix = "abcdefghijklm_abcdefgh";
  const request = {
    schema_version: 1,
    request_id: twelveCharacterPrefix,
    correlation_id: "corr_abcdefgh",
    idempotency_key: "inspect-example",
    adapter: "fake",
    operation: "inspect",
    payload: {},
  };
  const result = {
    schema_version: 1,
    request_id: twelveCharacterPrefix,
    correlation_id: "corr_abcdefgh",
    idempotency_key: "inspect-example",
    adapter: "fake",
    operation: "inspect",
    status: "succeeded",
    changed: false,
  };
  assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors));
  assert.equal(validateRequest({ ...request, request_id: thirteenCharacterPrefix }), false);
  assert.equal(validateResult({ ...result, request_id: thirteenCharacterPrefix }), false);
});

test("canonical trip records reject unknown/provider-specific fields", async () => {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(await readFile(`${contractsDir}/records.schema.json`, "utf8"));
  const validate = ajv.compile(schema);
  const trip = {
    schema_version: 1,
    record_type: "trip",
    id: "trip_abcdefgh",
    created_at: "2026-08-15T10:00:00Z",
    slug: "japan-demo",
    lifecycle_state: "draft",
  };
  assert.equal(validate(trip), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...trip, vmid: 123 }), false);
});
