import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotificationAdapter, FakeNotificationAdapter } from "../src/adapters/notification.js";

test("FakeNotificationAdapter records calls instead of sending anything", async () => {
  const adapter = new FakeNotificationAdapter();
  const params = {
    requestId: "sreq_abcdefgh",
    displayName: "Test Organizer",
    tripNameRequest: "Japan 2025",
    approveToken: "approve.token",
    rejectToken: "reject.token",
    expiresAt: new Date(),
  };
  await adapter.sendApprovalRequest(params);
  assert.deepEqual(adapter.calls, [params]);
});

test("createNotificationAdapter selects the fake adapter for adapters.messaging = fake", () => {
  const adapter = createNotificationAdapter("fake");
  assert.ok(adapter instanceof FakeNotificationAdapter);
});

test("createNotificationAdapter refuses telegram messaging without its deps", () => {
  assert.throws(() => createNotificationAdapter("telegram"), /requires telegram deps/);
});

test("createNotificationAdapter refuses an adapter it has no implementation for", () => {
  assert.throws(() => createNotificationAdapter("unknown-adapter"), /no notification adapter implementation yet/);
});
