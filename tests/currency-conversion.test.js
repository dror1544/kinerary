/**
 * currency-conversion.test.js — resolveCost() in mcp/mcp.js.
 *
 * PR #7 review: converting currency by asking the model for "a reasonable
 * current exchange rate" can hallucinate. Fixed by having the model report
 * only the raw amount + ISO currency code, and doing the actual conversion
 * here against a real, free, keyless exchange-rate API (frankfurter.dev).
 *
 * These tests no longer call that API: a third party being down failed the
 * nightly preflight (2026-11-23), and the claim under test is that the number
 * comes from a rate lookup and the code's arithmetic, not from the model. They
 * run against a local stand-in with ballpark-real rates (helpers/rates-stand-in.js)
 * that answers the same URL shape — and the fetch handed to resolveCost()
 * asserts it is still asked for the real service's URL before redirecting it
 * there, so the production request is still pinned. mcp/mcp.js is untouched.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRatesStandIn } from './helpers/rates-stand-in.js';
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

const REAL_BASE = 'https://api.frankfurter.dev';
let standIn;
before(async () => { standIn = await startRatesStandIn(); });
after(() => standIn.close());

// resolveCost() calls the global `fetch` of the context it runs in; this one
// refuses any URL that is not the real service's, and serves it from the stand-in.
function standInFetch(url, opts) {
  assert.ok(String(url).startsWith(`${REAL_BASE}/v1/latest?`), `resolveCost() called an unexpected URL: ${url}`);
  return fetch(standIn.url + String(url).slice(REAL_BASE.length), opts);
}

function makeContext() {
  const ctx = vm.createContext({ fetch: standInFetch, console });
  vm.runInContext(extractResolveCost(), ctx, { filename: 'mcp.js (resolveCost)' });
  return ctx;
}

describe('resolveCost()', () => {
  test('a rate-service failure leaves cost unset with an explanatory note, never a guess', async () => {
    standIn.setMode('error');
    try {
      const ctx = makeContext();
      const parsed = { name: 'Some hotel', cost_amount: 500, cost_currency: 'EUR' };
      await ctx.resolveCost(parsed);
      assert.equal(parsed.cost, undefined);
      assert.match(parsed.notes, /⚠️.*500 EUR.*rate lookup → 502.*enter the USD cost manually/);
    } finally {
      standIn.setMode('ok');
    }
  });

  test('converts a foreign amount via the exchange-rate lookup, and strips the raw fields', async () => {
    const ctx = makeContext();
    const parsed = { name: 'Park Hyatt Tokyo', cost_amount: 145000, cost_currency: 'JPY' };
    await ctx.resolveCost(parsed);

    assert.ok(!('cost_amount' in parsed), 'internal cost_amount must not leak into the response');
    assert.ok(!('cost_currency' in parsed), 'internal cost_currency must not leak into the response');
    assert.equal(typeof parsed.cost, 'number');
    // A sane ballpark (JPY/USD hasn't been outside roughly 100-200 in recent
    // history), plus the exact figure the stand-in's rate (150.25/USD) implies:
    // the rounding to cents is resolveCost()'s own arithmetic.
    assert.ok(parsed.cost > 500 && parsed.cost < 2000, `¥145,000 should land well under $2000, got ${parsed.cost}`);
    assert.equal(parsed.cost, 965.06);
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
