/**
 * currency-conversion.test.js — resolveCost() in mcp/mcp.js.
 *
 * PR #7 review: converting currency by asking the model for "a reasonable
 * current exchange rate" can hallucinate. Fixed by having the model report
 * only the raw amount + ISO currency code, and doing the actual conversion
 * here against a real, free, keyless exchange-rate API (frankfurter.dev).
 * These tests hit that real API — no mocking — since the entire point is
 * proving the number is real, not reimplementing the same guess.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const HERE   = dirname(fileURLToPath(import.meta.url));
const MCP_JS = join(HERE, '..', 'mcp', 'mcp.js');

function extractResolveCost() {
  const src = readFileSync(MCP_JS, 'utf8');
  const start = src.indexOf('async function resolveCost');
  const end = src.indexOf("app.post('/extract'");
  if (start === -1 || end === -1) throw new Error('Could not locate resolveCost() in mcp.js');
  return src.slice(start, end);
}

function makeContext() {
  const ctx = vm.createContext({ fetch, console });
  vm.runInContext(extractResolveCost(), ctx, { filename: 'mcp.js (resolveCost)' });
  return ctx;
}

describe('resolveCost()', () => {
  test('converts a real foreign amount via a live exchange rate, and strips the raw fields', async () => {
    const ctx = makeContext();
    const parsed = { name: 'Park Hyatt Tokyo', cost_amount: 145000, cost_currency: 'JPY' };
    await ctx.resolveCost(parsed);

    assert.ok(!('cost_amount' in parsed), 'internal cost_amount must not leak into the response');
    assert.ok(!('cost_currency' in parsed), 'internal cost_currency must not leak into the response');
    assert.equal(typeof parsed.cost, 'number');
    // Real, live-rate conversion — assert a sane ballpark (JPY/USD hasn't
    // been outside roughly 100-200 in recent history), not an exact number.
    assert.ok(parsed.cost > 500 && parsed.cost < 2000, `¥145,000 should land well under $2000, got ${parsed.cost}`);
    assert.match(parsed.notes, /145000 JPY.*USD/);
  });

  test('USD needs no conversion and makes no network call', async () => {
    const ctx = makeContext();
    const parsed = { name: 'Some hotel', cost_amount: 980, cost_currency: 'USD' };
    await ctx.resolveCost(parsed);
    assert.equal(parsed.cost, 980);
    assert.equal(parsed.notes, undefined, 'no conversion happened, so no conversion note should be added');
  });

  test('missing currency is treated as already-USD', async () => {
    const ctx = makeContext();
    const parsed = { name: 'Some hotel', cost_amount: 500 };
    await ctx.resolveCost(parsed);
    assert.equal(parsed.cost, 500);
  });

  test('no cost_amount at all leaves cost unset, no crash', async () => {
    const ctx = makeContext();
    const parsed = { name: 'Some hotel' };
    await ctx.resolveCost(parsed);
    assert.equal(parsed.cost, undefined);
  });

  test('an invalid/unsupported currency code fails gracefully — never invents a number', async () => {
    const ctx = makeContext();
    const parsed = { name: 'Some hotel', cost_amount: 500, cost_currency: 'XYZ' };
    await ctx.resolveCost(parsed);
    assert.equal(parsed.cost, undefined, 'must not guess a cost when the real rate lookup fails');
    assert.match(parsed.notes, /⚠️.*500 XYZ.*enter the USD cost manually/);
  });

  test('preserves an existing notes value alongside the conversion note', async () => {
    const ctx = makeContext();
    const parsed = { name: 'Some hotel', notes: 'Non-refundable.', cost_amount: 100, cost_currency: 'EUR' };
    await ctx.resolveCost(parsed);
    assert.match(parsed.notes, /^Non-refundable\.\n100 EUR/);
  });
});
