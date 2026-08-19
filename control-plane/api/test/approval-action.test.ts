import assert from "node:assert/strict";
import { test } from "node:test";
import { signApprovalAction, verifyApprovalAction } from "../src/approval-action.js";

const SECRET = "test-action-secret-for-sprint-1";
const REQUEST_ID = "sreq_TestRequestId123";
const NOW_MS = 1_700_000_000_000;

test("signed approve token verifies correctly", () => {
  const { token } = signApprovalAction(REQUEST_ID, "approve", SECRET, { nowMs: NOW_MS });
  const result = verifyApprovalAction(token, SECRET, { nowMs: NOW_MS + 1000 });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.requestId, REQUEST_ID);
  assert.equal(result.action, "approve");
});

test("signed reject token verifies correctly", () => {
  const { token } = signApprovalAction(REQUEST_ID, "reject", SECRET, { nowMs: NOW_MS });
  const result = verifyApprovalAction(token, SECRET, { nowMs: NOW_MS + 1000 });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.action, "reject");
});

test("expired token is rejected", () => {
  const { token } = signApprovalAction(REQUEST_ID, "approve", SECRET, {
    nowMs: NOW_MS,
    ttlSeconds: 60,
  });
  const result = verifyApprovalAction(token, SECRET, { nowMs: NOW_MS + 120_000 }); // 2 min later
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "EXPIRED_TOKEN");
});

test("tampered token is rejected", () => {
  const { token } = signApprovalAction(REQUEST_ID, "approve", SECRET, { nowMs: NOW_MS });
  const tampered = token.slice(0, -4) + "XXXX";
  const result = verifyApprovalAction(tampered, SECRET, { nowMs: NOW_MS + 1000 });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "INVALID_SIGNATURE");
});

test("wrong secret produces invalid signature", () => {
  const { token } = signApprovalAction(REQUEST_ID, "approve", SECRET, { nowMs: NOW_MS });
  const result = verifyApprovalAction(token, "wrong-secret", { nowMs: NOW_MS + 1000 });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "INVALID_SIGNATURE");
});

test("truncated token (no dot) is rejected as invalid", () => {
  const result = verifyApprovalAction("notokendot", SECRET, { nowMs: NOW_MS });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "INVALID_TOKEN");
});

test("token for different requestId does not verify as another", () => {
  const { token } = signApprovalAction("sreq_OtherRequest00", "approve", SECRET, { nowMs: NOW_MS });
  const result = verifyApprovalAction(token, SECRET, { nowMs: NOW_MS + 1000 });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.requestId, "sreq_OtherRequest00");
  assert.notEqual(result.requestId, REQUEST_ID);
});

test("approve and reject tokens for the same request differ", () => {
  const { token: approveToken } = signApprovalAction(REQUEST_ID, "approve", SECRET, { nowMs: NOW_MS });
  const { token: rejectToken } = signApprovalAction(REQUEST_ID, "reject", SECRET, { nowMs: NOW_MS });
  assert.notEqual(approveToken, rejectToken);
  const ar = verifyApprovalAction(approveToken, SECRET, { nowMs: NOW_MS + 1000 });
  const rr = verifyApprovalAction(rejectToken, SECRET, { nowMs: NOW_MS + 1000 });
  assert.equal(ar.valid && ar.action, "approve");
  assert.equal(rr.valid && rr.action, "reject");
});

test("token digest is a sha256 prefix string", () => {
  const { digest } = signApprovalAction(REQUEST_ID, "approve", SECRET, { nowMs: NOW_MS });
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
});

test("token raw value does not contain requestId in plaintext", () => {
  const { token } = signApprovalAction(REQUEST_ID, "approve", SECRET, { nowMs: NOW_MS });
  // The base64url-encoded payload should not reveal the requestId as plain text in the token string
  assert.doesNotMatch(token, /sreq_TestRequestId123/);
});
