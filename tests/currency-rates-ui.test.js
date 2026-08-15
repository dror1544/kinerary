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

  // A domestic-US trip (destination currency USD): the server never fetches
  // a USD rate (frankfurter.dev can't convert USD to itself), so rates
  // never has a USD entry. The home-currency line must still show — only
  // the meaningless "1 USD ≈ 1 USD" line is skipped.
  test('a USD destination shows the home-currency line, not a blank one', async () => {
    const usaCfg = {
      travel_info: {
        countries: {
          'United States of America': {
            flag: '🇺🇸',
            currency: { code: 'USD', name: 'United States dollar', symbol: '$' },
          },
        },
      },
    };
    const { document, ctx } = createRenderContext(HTML, usaCfg, 'he', {
      localStorage: { getItem: () => 'fake-token' },
      fetch: async () => ({
        ok: true,
        json: async () => ({ base: 'USD', home: 'ILS', rates: { ILS: 3.7 }, date: '2026-08-10' }),
      }),
    });
    ctx.window.TRIP_CONFIG = usaCfg;
    await ctx.loadCurrencyRates();
    const html = document.getElementById('info-countries').innerHTML;
    // Dollar-anchored like every other line here, not inverted to "1 ILS ≈ ... USD"
    assert.match(html, /1 USD ≈ 3\.7 ILS/);
  });

  test('a USD destination with no home currency shows no rate line at all', async () => {
    const usaCfg = {
      travel_info: {
        countries: {
          'United States of America': {
            flag: '🇺🇸',
            currency: { code: 'USD', name: 'United States dollar', symbol: '$' },
          },
        },
      },
    };
    const { document, ctx } = createRenderContext(HTML, usaCfg, 'he', {
      localStorage: { getItem: () => 'fake-token' },
      fetch: async () => ({
        ok: true,
        json: async () => ({ base: 'USD', home: null, rates: {}, date: '2026-08-10' }),
      }),
    });
    ctx.window.TRIP_CONFIG = usaCfg;
    await ctx.loadCurrencyRates();
    const html = document.getElementById('info-countries').innerHTML;
    assert.ok(html.includes('United States dollar'));
    assert.ok(!html.includes('≈'));
  });
});
