/**
 * AC-6 (docs/specs/sprint-9/567-feature-switches.md): when the resolver's
 * database read fails, relay code asking `featureEnabled` takes the OFF branch
 * and the failure is logged as `feature_switch.read_failed` with the switch
 * name and no trip data. No database needed: the read is made to fail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { featureEnabled } from "../src/feature-switches.js";

const TRIP = "trip_secrettrip01";

function failingDb(error: unknown) {
  const calls: unknown[][] = [];
  return {
    calls,
    db: { query: async (...args: unknown[]) => { calls.push(args); throw error; } },
  };
}

test("AC-6: a failed read is off, and logs the switch name and no trip data", async () => {
  const lines: string[] = [];
  const { db } = failingDb(new Error(`connect ECONNREFUSED while reading ${TRIP}`));
  const on = await featureEnabled(db as never, TRIP, "delivery_probe", (line) => lines.push(line));
  assert.equal(on, false);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.event, "feature_switch.read_failed");
  assert.equal(entry.level, "warn");
  assert.equal(entry.switch, "delivery_probe");
  assert.doesNotMatch(lines[0]!, new RegExp(TRIP), "no trip id, not even through the error text");
  assert.doesNotMatch(lines[0]!, /ECONNREFUSED/, "the error text is not copied");
});

test("AC-6: a missing function or table is the same off branch", async () => {
  for (const code of ["42883", "42P01"]) {
    const lines: string[] = [];
    const { db } = failingDb(Object.assign(new Error("relation does not exist"), { code }));
    assert.equal(await featureEnabled(db as never, TRIP, "delivery_probe", (line) => lines.push(line)), false);
    assert.equal(JSON.parse(lines[0]!).event, "feature_switch.read_failed");
    assert.equal(JSON.parse(lines[0]!).sqlstate, code);
  }
});

test("AC-6: an answer that is not the boolean true is off", async () => {
  for (const value of ["t", "true", 1, null, undefined, {}]) {
    const db = { query: async () => ({ rows: [{ enabled: value }] }) };
    assert.equal(await featureEnabled(db as never, TRIP, "delivery_probe", () => {}), false, String(value));
  }
  const empty = { query: async () => ({ rows: [] }) };
  assert.equal(await featureEnabled(empty as never, TRIP, "delivery_probe", () => {}), false);
  const yes = { query: async () => ({ rows: [{ enabled: true }] }) };
  assert.equal(await featureEnabled(yes as never, TRIP, "delivery_probe", () => {}), true);
});

test("an unregistered name is off without reading the database or logging a failure", async () => {
  const lines: string[] = [];
  const { db, calls } = failingDb(new Error("must not be called"));
  assert.equal(await featureEnabled(db as never, TRIP, "no_such_switch", (line) => lines.push(line)), false);
  assert.equal(calls.length, 0);
  assert.equal(lines.length, 0);
});

test("a blank trip id is off without a read", async () => {
  const { db, calls } = failingDb(new Error("must not be called"));
  assert.equal(await featureEnabled(db as never, "", "delivery_probe", () => {}), false);
  assert.equal(calls.length, 0);
});
