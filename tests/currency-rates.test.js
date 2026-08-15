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
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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

// An organizer explicitly setting homeCurrency to "USD" means the same
// thing as leaving it unset — both are "the organizer's home currency is
// the dollar". Needs its own trip dir/server since it patches
// meta.homeCurrency before boot, unlike the shared fixture above (ILS).
describe('GET /api/currency-rates — explicit homeCurrency: "USD"', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const FIXTURES_DIR = join(HERE, 'fixtures');
  const SERVER_JS = join(HERE, '..', 'server', 'server.js');
  const PORT = 3111; // 3095-3110 already claimed by other test files

  let dataDir, tripDir, proc, usdToken;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-currency-usd-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'trip-currency-usd-trip-'));
    cpSync(FIXTURES_DIR, tripDir, { recursive: true });
    const cfgPath = join(tripDir, 'trip.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.meta.homeCurrency = 'USD';
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    proc = spawn('node', [SERVER_JS], {
      cwd: join(HERE, '..', 'server'),
      env: {
        ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
        AVATARS_DIR: join(dataDir, 'avatars'), JWT_SECRET: 'test-secret-000',
        IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: 'test-hermes-key', SEED_PASSWORD: '1234',
      },
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('boot timeout')), 10_000);
      proc.stdout.on('data', chunk => {
        if (chunk.toString().includes('Trip server running on')) { clearTimeout(timeout); resolve(); }
      });
    });
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await fetch(`http://localhost:${PORT}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: '1234' }),
      });
      if (res.ok) { usdToken = (await res.json()).token; break; }
      await new Promise(r => setTimeout(r, 100));
    }
  });

  after(async () => {
    await new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGTERM'); });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tripDir, { recursive: true, force: true });
  });

  test('normalizes to no home currency, not a USD-vs-USD line', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/currency-rates`, {
      headers: { Authorization: `Bearer ${usdToken}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.home, null);
  });
});
