import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PORTS,
  BASE_PORTS,
  PORT_OFFSET,
  PORT_STRIDE,
  MAX_PORT_OFFSET,
  portOffsetFor,
  applyOffset,
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

// Issue #366: ~60 fixed ports with no per-worktree offset, so two worktrees
// running the suite at once collided.
const allSlots = () => Array.from({ length: MAX_PORT_OFFSET / PORT_STRIDE + 1 }, (_, i) => i * PORT_STRIDE);

test('the offset is a multiple of the stride and PORTS is the base shifted by it', () => {
  assert.equal(PORT_OFFSET % PORT_STRIDE, 0);
  assert.ok(PORT_OFFSET >= 0 && PORT_OFFSET <= MAX_PORT_OFFSET);
  for (const [name, base] of Object.entries(BASE_PORTS)) assert.equal(PORTS[name], base + PORT_OFFSET, name);
});

test('every possible offset keeps the whole table unique, below the ephemeral range and clear of the bridges', () => {
  assert.ok(allSlots().length >= 10, 'enough slots for several concurrent worktrees');
  for (const offset of allSlots()) {
    const table = applyOffset(BASE_PORTS, offset);
    assert.doesNotThrow(() => assertUnique(table), `offset ${offset}`);
    assert.doesNotThrow(() => assertClearOfTripBridges(table), `offset ${offset}`);
    assert.doesNotThrow(() => assertBelowEphemeralRange(table), `offset ${offset}`);
  }
  // ...and one step more would break the ceiling, so the cap is the real limit.
  assert.throws(() => assertBelowEphemeralRange(applyOffset(BASE_PORTS, MAX_PORT_OFFSET + PORT_STRIDE)), /ephemeral/);
});

test('two different offsets never share a port (the stride is at least the table\'s width)', () => {
  const slots = allSlots();
  for (const a of slots) {
    const mine = new Set(Object.values(applyOffset(BASE_PORTS, a)));
    for (const b of slots) {
      if (b <= a) continue;
      const clash = Object.values(applyOffset(BASE_PORTS, b)).find(p => mine.has(p));
      assert.equal(clash, undefined, `offsets ${a} and ${b} both bind ${clash}`);
    }
  }
});

test('the derived offset is stable for one checkout and differs between checkouts', () => {
  const env = {};
  assert.equal(portOffsetFor('/work/a', env), portOffsetFor('/work/a', env));
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const off = portOffsetFor(`/Users/x/kinerary/.claude/worktrees/agent-${i}`, env);
    assert.ok(allSlots().includes(off), `${off} is a slot`);
    seen.add(off);
  }
  assert.ok(seen.size >= 5, `forty checkouts spread over the slots, got ${seen.size} distinct`);
});

test('TEST_PORT_OFFSET overrides the derived offset, and a bad value is refused loudly', () => {
  assert.equal(portOffsetFor('/work/a', { TEST_PORT_OFFSET: '0' }), 0);
  assert.equal(portOffsetFor('/work/a', { TEST_PORT_OFFSET: String(PORT_STRIDE * 2) }), PORT_STRIDE * 2);
  assert.equal(portOffsetFor('/work/a', { TEST_PORT_OFFSET: '' }), portOffsetFor('/work/a', {}), 'empty means unset');
  for (const bad of ['abc', '-300', '1.5', String(PORT_STRIDE + 1), String(MAX_PORT_OFFSET + PORT_STRIDE), '100000']) {
    assert.throws(() => portOffsetFor('/work/a', { TEST_PORT_OFFSET: bad }), /TEST_PORT_OFFSET/, bad);
  }
});

test('the offset reaches every importer: a child with TEST_PORT_OFFSET set sees shifted ports', () => {
  const offset = PORT_STRIDE * 2;
  const ports = fileURLToPath(new URL('./helpers/ports.js', import.meta.url));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { PORTS } from ${JSON.stringify(ports)}; console.log(JSON.stringify([PORTS.serverDefault, PORTS.mcpDefault]));`],
  { env: { ...process.env, TEST_PORT_OFFSET: String(offset) }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [BASE_PORTS.serverDefault + offset, BASE_PORTS.mcpDefault + offset]);
});
