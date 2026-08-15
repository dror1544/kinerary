/**
 * currency-rates-ui.test.js — renderInfo()'s live currency-rate line in
 * site/app.js.
 *
 * loadCurrencyRates() fetches /api/currency-rates once and re-renders the
 * Info tab's country cards with it; renderInfo() itself must degrade
 * gracefully (no rate line, not a crash) whenever rates aren't in yet or
 * don't cover a given country's currency.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderContext } from './helpers/dom.js';

const HTML = `<div id="info-countries"></div>`;

const cfg = {
  travel_info: {
    countries: {
      Japan: {
        flag: '🇯🇵',
        currency: { code: 'JPY', name: 'Japanese yen', symbol: '¥' },
        callingCode: '+81',
        emergency: { general: '110' },
      },
    },
  },
};

describe('renderInfo() currency rate line', () => {
  test('shows no rate line before loadCurrencyRates() has resolved', () => {
    const { document, ctx } = createRenderContext(HTML, cfg);
    ctx.renderInfo(cfg);
    const html = document.getElementById('info-countries').innerHTML;
    assert.ok(html.includes('Japanese yen'), 'currency name/symbol should still render as before');
    assert.ok(!html.includes('USD'), 'no rate line should appear until rates have loaded');
  });

  test('shows USD and home-currency rates once loadCurrencyRates() resolves', async () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', {
      localStorage: { getItem: () => 'fake-token' },
      fetch: async () => ({
        ok: true,
        json: async () => ({ base: 'USD', home: 'ILS', rates: { JPY: 150.2, ILS: 3.7 }, date: '2026-08-10' }),
      }),
    });
    ctx.window.TRIP_CONFIG = cfg; // loadCurrencyRates() re-renders from window.TRIP_CONFIG, same as the real app
    await ctx.loadCurrencyRates();
    const html = document.getElementById('info-countries').innerHTML;
    assert.match(html, /1 USD ≈ 150\.2 JPY/);
    // Cross rate: 150.2 / 3.7 ≈ 40.59
    assert.match(html, /1 ILS ≈ 40\.\d\d? JPY/);
  });

  test('a currency with no rate in the response renders with no rate line, not a crash', async () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', {
      localStorage: { getItem: () => 'fake-token' },
      fetch: async () => ({ ok: true, json: async () => ({ base: 'USD', home: 'ILS', rates: {}, date: '2026-08-10' }) }),
    });
    ctx.window.TRIP_CONFIG = cfg;
    await ctx.loadCurrencyRates();
    const html = document.getElementById('info-countries').innerHTML;
    assert.ok(html.includes('Japanese yen'));
    assert.ok(!html.includes('USD'));
  });

  test('no token yet (not logged in) — skips the fetch entirely, no crash', async () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', {
      localStorage: { getItem: () => null },
      fetch: async () => { throw new Error('should not be called without a token'); },
    });
    await ctx.loadCurrencyRates();
  });
});
