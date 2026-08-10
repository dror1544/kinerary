/**
 * currency-rates.test.js — GET /api/currency-rates.
 *
 * Per-trip Info tab feature: show each destination currency's live rate
 * against USD and the organizer's home currency (trip.config.json's new
 * meta.homeCurrency). Server-side cache refreshed at most once/day — a
 * dozen family members opening the Info tab shouldn't cost a dozen external
 * calls. Hits the real exchange-rate API (frankfurter.dev), same as
 * currency-conversion.test.js — the point is proving a real, live rate.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

let token;

before(async () => {
  await startTestServer({ PORT: '3107' }); // 3095-3106 already claimed by other test files
  token = await loginAsAlice();
});
after(() => stopTestServer());

describe('GET /api/currency-rates', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await api('/api/currency-rates', {});
    assert.equal(res.status, 401);
  });

  test('returns live rates for every destination currency plus the home currency', async () => {
    const res = await api('/api/currency-rates', { token });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.base, 'USD');
    assert.equal(data.home, 'ILS'); // fixture's meta.homeCurrency
    assert.equal(typeof data.rates.JPY, 'number'); // fixture's travel_info.countries.Japan
    assert.ok(data.rates.JPY > 0);
    assert.equal(typeof data.rates.ILS, 'number');
    assert.ok(data.date);
  });

  test('a second call within the cache window reuses the same fetch, not a fresh one', async () => {
    const first = await (await api('/api/currency-rates', { token })).json();
    const second = await (await api('/api/currency-rates', { token })).json();
    assert.equal(first.fetchedAt, second.fetchedAt, 'expected the cached value, not a re-fetch');
  });
});
