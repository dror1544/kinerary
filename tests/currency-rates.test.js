/**
 * currency-rates.test.js — GET /api/currency-rates.
 *
 * Per-trip Info tab feature: show each destination currency's live rate
 * against USD and the organizer's home currency (trip.config.json's new
 * meta.homeCurrency). Server-side cache refreshed at most once/day — a
 * dozen family members opening the Info tab shouldn't cost a dozen external
 * calls.
 *
 * The upstream (frankfurter.dev) is a local stand-in
 * (helpers/rates-stand-in.js) reached through CURRENCY_RATES_BASE_URL, so a
 * third party being down can no longer fail this suite (nightly 2026-11-23:
 * the route answered 502 because the live service was unavailable). What is
 * asserted is the route's own behaviour — auth, one fetch per cache window,
 * USD handling, its failure answers. That the real service still speaks this
 * shape is not this suite's job.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PORTS } from './helpers/ports.js';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';
import { startRatesStandIn, RATES_PER_USD, RATES_DATE } from './helpers/rates-stand-in.js';
import { freePort } from './helpers/port-guard.js';

let token;
let standIn;

before(async () => {
  standIn = await startRatesStandIn();
  await startTestServer({ PORT: String(PORTS.currencyRates), CURRENCY_RATES_BASE_URL: standIn.url });
  token = await loginAsAlice();
});
after(async () => { stopTestServer(); await standIn.close(); });

describe('GET /api/currency-rates', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await api('/api/currency-rates', {});
    assert.equal(res.status, 401);
    assert.equal(standIn.hits, 0, 'an unauthenticated request must not reach the upstream');
  });

  test('returns rates for every destination currency plus the home currency', async () => {
    const res = await api('/api/currency-rates', { token });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.base, 'USD');
    assert.equal(data.home, 'ILS'); // fixture's meta.homeCurrency
    assert.equal(typeof data.rates.JPY, 'number'); // fixture's travel_info.countries.Japan
    assert.ok(data.rates.JPY > 0);
    assert.equal(typeof data.rates.ILS, 'number');
    assert.ok(data.date);
    // What the route asked the upstream for: USD as the base, the destination
    // currency and the home currency, and nothing else.
    assert.equal(standIn.hits, 1);
    const asked = new URL(standIn.requests[0], 'http://x');
    assert.equal(asked.pathname, '/v1/latest');
    assert.equal(asked.searchParams.get('from'), 'USD');
    assert.deepEqual(asked.searchParams.get('to').split(',').sort(), ['ILS', 'JPY']);
    // And it served what the upstream returned.
    assert.equal(data.rates.JPY, RATES_PER_USD.JPY);
    assert.equal(data.rates.ILS, RATES_PER_USD.ILS);
    assert.equal(data.date, RATES_DATE);
  });

  test('a second call within the cache window reuses the same fetch, not a fresh one', async () => {
    const hitsBefore = standIn.hits;
    const first = await (await api('/api/currency-rates', { token })).json();
    const second = await (await api('/api/currency-rates', { token })).json();
    assert.equal(first.fetchedAt, second.fetchedAt, 'expected the cached value, not a re-fetch');
    assert.equal(standIn.hits, hitsBefore, 'the upstream must not be called again inside the cache window');
  });
});

// The tests below each need a trip.config.json patched before boot
// (homeCurrency, travel_info.countries) — not possible against the shared
// fixture server above, which other test files also read unmodified. Each
// gets its own throwaway trip dir and port.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');
const SERVER_JS = join(HERE, '..', 'server', 'server.js');

async function spawnPatchedServer(port, mutateConfig, extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'trip-currency-data-'));
  const tripDir = mkdtempSync(join(tmpdir(), 'trip-currency-trip-'));
  cpSync(FIXTURES_DIR, tripDir, { recursive: true });
  const cfgPath = join(tripDir, 'trip.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  mutateConfig(cfg);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const proc = spawn('node', [SERVER_JS], {
    cwd: join(HERE, '..', 'server'),
    env: {
      ...process.env, PORT: String(port), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      AVATARS_DIR: join(dataDir, 'avatars'), JWT_SECRET: 'test-secret-000',
      IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: 'test-hermes-key', SEED_PASSWORD: '1234',
      ...extraEnv,
    },
  });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('boot timeout')), 10_000);
    proc.stdout.on('data', chunk => {
      if (chunk.toString().includes('Trip server running on')) { clearTimeout(timeout); resolve(); }
    });
  });
  let loginToken;
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: '1234' }),
    });
    if (res.ok) { loginToken = (await res.json()).token; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  return { proc, dataDir, tripDir, token: loginToken, port, stderr: () => stderr };
}

async function stopPatchedServer({ proc, dataDir, tripDir }) {
  await new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGTERM'); });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(tripDir, { recursive: true, force: true });
}

const getRates = (server, signal = AbortSignal.timeout(20_000)) =>
  fetch(`http://localhost:${server.port}/api/currency-rates`, {
    headers: { Authorization: `Bearer ${server.token}` }, signal,
  });

// An organizer explicitly setting homeCurrency to "USD" means the same
// thing as leaving it unset — both are "the organizer's home currency is
// the dollar".
describe('GET /api/currency-rates — explicit homeCurrency: "USD"', () => {
  const PORT = PORTS.currencyRatesUsdHome;
  let server, rates;

  before(async () => {
    rates = await startRatesStandIn();
    server = await spawnPatchedServer(PORT, cfg => { cfg.meta.homeCurrency = 'USD'; },
      { CURRENCY_RATES_BASE_URL: rates.url });
  });
  after(async () => { await stopPatchedServer(server); await rates.close(); });

  test('normalizes to no home currency, not a USD-vs-USD line', async () => {
    const res = await getRates(server);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.home, null);
    assert.equal(data.rates.JPY, RATES_PER_USD.JPY);
  });
});

// The upstream 422s on a request to convert USD to itself — the one
// pair it can't do. A domestic-US trip (destination currency USD, no
// distinct home currency) used to send exactly that request and get a 502
// on every single view, never able to populate its cache. USD must be
// filtered out before the request goes out, not just handled in the error path.
describe('GET /api/currency-rates — USD-only destination, no home currency', () => {
  const PORT = PORTS.currencyRatesUsdOnly;
  let server, rates;

  before(async () => {
    rates = await startRatesStandIn();
    server = await spawnPatchedServer(PORT, cfg => {
      delete cfg.meta.homeCurrency; // fixture default is 'ILS' — this test needs none set
      cfg.travel_info.countries = {
        'United States of America': { currency: { code: 'USD', name: 'United States dollar', symbol: '$' } },
      };
    }, { CURRENCY_RATES_BASE_URL: rates.url });
  });
  after(async () => { await stopPatchedServer(server); await rates.close(); });

  test('returns 200 with no rates instead of 502ing on a USD-to-USD request', async () => {
    const res = await getRates(server);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.rates, {});
    assert.equal(rates.hits, 0, 'a USD-only trip must not send the upstream a USD-to-USD request at all');
  });
});

// The upstream failing is the case that took the nightly down. The route's
// documented answers: a first-ever failure is a 502 with a JSON error, never a
// hang; a failure after a good fetch serves the stale cached rates.
describe('GET /api/currency-rates — upstream failing', () => {
  let server, rates;

  before(async () => {
    rates = await startRatesStandIn({ mode: 'error' });
    server = await spawnPatchedServer(await freePort(), () => {}, { CURRENCY_RATES_BASE_URL: rates.url });
  });
  after(async () => { await stopPatchedServer(server); await rates.close(); });

  test("an upstream 502 with nothing cached yields the route's 502, not a crash", async () => {
    const res = await getRates(server);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'currency rate lookup failed' });
  });

  test("an upstream that never answers is cut off by the route's own timeout, not left hanging", async () => {
    rates.setMode('hang');
    const started = Date.now();
    const res = await getRates(server, AbortSignal.timeout(25_000));
    assert.equal(res.status, 502);
    assert.ok(Date.now() - started < 20_000, 'expected the 8s upstream timeout to fire');
  });

  test('after a good fetch, a later upstream failure serves the stale cached rates', async () => {
    rates.setMode('ok');
    const good = await (await getRates(server)).json();
    assert.equal(good.rates.JPY, RATES_PER_USD.JPY);
    rates.setMode('error');
    const hitsBefore = rates.hits;
    const again = await getRates(server);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).fetchedAt, good.fetchedAt);
    // Inside the cache window the stale-serving path is not even reached.
    assert.equal(rates.hits, hitsBefore);
  });
});

// CURRENCY_RATES_BASE_URL is a server-side fetch target, so it must not let
// the server's traffic be pointed anywhere: only https, or http to loopback.
// 0.0.0.0 is not in the loopback list, yet a connect to it normally lands on
// this machine — so a wrongly accepted override shows up as a stand-in hit.
describe('GET /api/currency-rates — an override that is not https or loopback http is refused', () => {
  let rates;
  before(async () => { rates = await startRatesStandIn(); });
  after(() => rates.close());

  const cases = [
    ['http to a non-loopback address', () => `http://0.0.0.0:${rates.port}`],
    ['http to a hostname that merely starts like loopback', () => `http://127.0.0.1.evil.example:${rates.port}`],
    ['http to localhost with a lookalike suffix', () => `http://localhost.evil.example:${rates.port}`],
    ['loopback with credentials', () => `http://user:pw@127.0.0.1:${rates.port}`],
    ['loopback with a query string', () => `http://127.0.0.1:${rates.port}/?x=1`],
    ['a non-http scheme', () => `ftp://127.0.0.1:${rates.port}`],
    ['not a URL at all', () => 'not a url'],
  ];
  for (const [label, override] of cases) {
    test(`${label}: logged, never fetched, route answers 502`, async () => {
      const server = await spawnPatchedServer(await freePort(), () => {}, { CURRENCY_RATES_BASE_URL: override() });
      try {
        const res = await getRates(server);
        assert.equal(res.status, 502);
        assert.deepEqual(await res.json(), { error: 'currency rate lookup failed' });
        assert.equal(rates.hits, 0, 'the refused override must never be fetched');
        assert.match(server.stderr(), /CURRENCY_RATES_BASE_URL refused/);
      } finally {
        await stopPatchedServer(server);
      }
    });
  }
});
