import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTripTransition, canTransitionTrip } from "../src/lifecycle.js";

test("trip lifecycle accepts only adjacent reviewed transitions", () => {
  assert.equal(canTransitionTrip("pending_signup_approval", "draft"), true);
  assert.equal(canTransitionTrip("provisioning", "ready_private"), true);
  assert.equal(canTransitionTrip("activation_approved", "active"), true);
});

test("skipped lifecycle states and direct activation are rejected", () => {
  assert.throws(() => assertTripTransition("draft", "active"), /invalid trip transition/);
  assert.throws(() => assertTripTransition("ready_private", "active"), /invalid trip transition/);
  assert.throws(() => assertTripTransition("pending_signup_approval", "intake_in_progress"));
});

test("sealed trips cannot transition back to a writable state", () => {
  assert.throws(() => assertTripTransition("sealed", "active"));
});
