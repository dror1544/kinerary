import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTS,
  EPHEMERAL_RANGE_FIRST,
  assertUnique,
  assertClearOfTripBridges,
  assertBelowEphemeralRange,
} from './helpers/ports.js';

// Issue #223 cause 2: ports at 38000+ sit inside Linux's default ephemeral
// range (32768-60999), so CI could see a random EADDRINUSE.
test('every test port is below the Linux ephemeral range', () => {
  for (const [name, port] of Object.entries(PORTS)) {
    assert.ok(port < EPHEMERAL_RANGE_FIRST, `${name} = ${port} is in the ephemeral range`);
  }
  assert.equal(EPHEMERAL_RANGE_FIRST, 32768);
});

test('the table is unique and clear of the trip bridges (import already asserted it)', () => {
  assert.doesNotThrow(() => assertUnique(PORTS));
  assert.doesNotThrow(() => assertClearOfTripBridges(PORTS));
  assert.doesNotThrow(() => assertBelowEphemeralRange(PORTS));
});

test('the guard fails when an entry is put back in the ephemeral range', () => {
  assert.throws(() => assertBelowEphemeralRange({ ...PORTS, sneaky: 32768 }), /sneaky \(32768\)/);
  assert.throws(() => assertBelowEphemeralRange({ ...PORTS, old: 38202 }), /ephemeral/);
  assert.throws(() => assertBelowEphemeralRange({ ...PORTS, mac: 50000 }), /mac \(50000\)/);
  assert.doesNotThrow(() => assertBelowEphemeralRange({ ...PORTS, edge: 32767 }));
});
