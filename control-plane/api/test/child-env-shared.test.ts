/**
 * The reference model-runner.ts's hermesChildEnv/structuringChildEnv hold is
 * shared/child-env.js's own function (#284) — not a reimplementation that
 * happens to compute the same thing today. Reference equality is the
 * strongest form of "same source" there is: it cannot be faked by two copies
 * that merely behave alike, and it fails the moment either side stops
 * pointing at the shared module — including a future edit that reintroduces
 * a local redefinition in model-runner.ts under the same export names (which
 * a behavioural/keyset test alone would not catch, since a faithful copy
 * behaves identically to the real thing right up until it drifts).
 *
 * mcp/mcp.js's half of this is mechanical instead (it is plain CommonJS and
 * cannot be required in-process without starting its HTTP server via
 * `app.listen`) and lives in tests/mcp-shares-child-env.test.js.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hermesChildEnv, structuringChildEnv } from "../src/model-runner.js";
import * as sharedChildEnv from "../../../shared/child-env.js";

describe("model-runner.ts's child-env builders are shared/child-env.js's own, not a copy", () => {
  test("hermesChildEnv is the exact same function object", () => {
    assert.equal(hermesChildEnv, sharedChildEnv.hermesChildEnv);
  });

  test("structuringChildEnv is the exact same function object", () => {
    assert.equal(structuringChildEnv, sharedChildEnv.structuringChildEnv);
  });
});
