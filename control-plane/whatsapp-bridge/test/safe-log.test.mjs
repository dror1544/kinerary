import assert from "node:assert/strict";
import { test } from "node:test";
import { createSafeLogger, errorCode, safeValue } from "../src/safe-log.js";
import { ALICE } from "./helpers.mjs";

test("a log line keeps states and counts and redacts everything else", () => {
  const lines = [];
  const { log } = createSafeLogger((l) => lines.push(l));
  log("disconnected", { code: 515, attempt: 2, connected: false, state: "restart_required" });
  log("oops", {
    id: ALICE.lid,
    phone: ALICE.phone,
    name: "Alice Fixture",
    text: "a message a person wrote",
    digits: "123456789",
    "bad key!": "x",
  });
  const first = JSON.parse(lines[0]);
  assert.deepEqual(first, { event: "disconnected", code: 515, attempt: 2, connected: false, state: "restart_required" });
  const second = JSON.parse(lines[1]);
  assert.equal(second.id, "[redacted]");
  assert.equal(second.phone, "[redacted]");
  assert.equal(second.name, "[redacted]");
  assert.equal(second.text, "[redacted]");
  assert.equal(second.digits, "[redacted]");
  assert.ok(!("bad key!" in second));
  assert.ok(!lines[1].includes("100000000000001"));
  assert.ok(!lines[1].includes("Alice"));
});

test("an error is reduced to a status or short code, never its message", () => {
  assert.equal(errorCode({ output: { statusCode: 428 }, message: `quotes ${ALICE.lid}` }), 428);
  assert.equal(errorCode({ code: "ECONNRESET" }), "econnreset");
  assert.equal(errorCode(new Error(`message with ${ALICE.phone}`)), "error");
  assert.equal(errorCode(undefined), "error");
});

test("safeValue refuses a token that is shaped like an id", () => {
  assert.equal(safeValue("connected"), "connected");
  assert.equal(safeValue("restart_required"), "restart_required");
  assert.equal(safeValue("abc12345678"), "[redacted]");
  assert.equal(safeValue(Number.NaN), "[redacted]");
});

test("a number shaped like a phone number or an id is redacted; counts and codes are kept", () => {
  assert.equal(safeValue(200000000001), "[redacted]");
  assert.equal(safeValue(1795380942), "[redacted]");
  assert.equal(safeValue(515), 515);
  assert.equal(safeValue(60587), 60587);
});

test("a sink that throws does not take the caller down", () => {
  const { log } = createSafeLogger(() => {
    throw new Error("disk full");
  });
  assert.doesNotThrow(() => log("event", { a: 1 }));
});
