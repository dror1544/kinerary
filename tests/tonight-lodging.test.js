/**
 * tonight-lodging.test.js — the Journey tab's "Tonight:" line, computed when
 * the itinerary is SERVED, from the trip as it is now.
 *
 * Until 2026-10-11 each day's `lodging_context` was the copy written when the
 * plan was imported. Every Classic/MCP plan write re-derives the active rows
 * from phase_plan_* with `lodging_context: null` — which a booted server does
 * once at startup (importPlanOnce) — so the line silently disappeared; and
 * after a stop edit (a hotel set, a stop split) the stored copy was stale.
 *
 * GET /api/itinerary/active now picks each night's stop from the EFFECTIVE
 * config (the file with the stop layer merged over it) with the same rule as
 * trip-web/src/stops.ts `tonightLodging`: the night of date d belongs to the
 * stop with start <= d < end (a transfer day is the NEXT stop's night), else
 * the stop with start <= d <= end; the day's own stop wins a tie. The hotel is
 * then read with dayContextForPhase — `accommodation`, or the legacy `hotels`
 * array by date, with the same night rule inside the stop — and projected to
 * the same three public fields as before. The stored copy is served only when
 * no stop covers the date.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PORTS } from './helpers/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { create } = require('../server/living-journey.js');
const AGENT_KEY = 'test-hermes-key';
const clone = (v) => JSON.parse(JSON.stringify(v));

// Values that must never reach the itinerary payload, each unique so a leak is
// findable by substring. A PIN is withheld by the allow-list; the others are
// allow-listed for /api/config but are not part of the day context.
const SECRETS = ['PIN-PARIS-7777', 'DOOR-PARIS-SECRET', 'CONF-PARIS-001', 'PHONE-PARIS-555', 'PIN-LYON-A-4242', 'NOTE-LYON-SECRET'];

function rhoneConfig() {
  const item = (date, en) => ({ date, label: { he: en, en }, items: [{ time: '10:00', text: { he: en, en } }] });
  return {
    meta: { title: 'Rhone 2026', brand: 'RHONE', departure: '2026-12-01T00:00:00+00:00', returnDate: '2026-12-10', totalDays: 10, deploymentNonce: 'tonight-test', defaultLang: 'he' },
    participants: [
      { username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' },
      { username: 'bob', name: 'בוב', name_en: 'Bob', family: 'a', color: '#10B981' },
    ],
    phases: [
      {
        id: 'paris', title: { he: 'פריז', en: 'Paris' }, tabLabel: 'PARIS',
        dates: { start: '2026-12-01', end: '2026-12-04' },
        accommodation: {
          type: 'hotel', name: { he: 'מלון פריז', en: 'Hotel Paris' }, address: '1 Rue Example',
          location_url: 'https://maps.example/paris', confirmation: 'CONF-PARIS-001', phone: 'PHONE-PARIS-555',
          pin: 'PIN-PARIS-7777', door_code: 'DOOR-PARIS-SECRET',
        },
        // 12-04 is the transfer day, filed under Paris: its night is Lyon's.
        days: [item('2026-12-01', 'Arrive'), item('2026-12-02', 'Louvre'), item('2026-12-03', 'Montmartre'), item('2026-12-04', 'Train to Lyon')],
      },
      {
        // A legacy multi-hotel stop: no `accommodation`, two hotels by date,
        // changing over on 12-06.
        id: 'lyon', title: { he: 'ליון', en: 'Lyon' }, tabLabel: 'LYON',
        dates: { start: '2026-12-04', end: '2026-12-08' },
        hotels: [
          { name: 'Lyon Hotel A', check_in: '2026-12-04', check_out: '2026-12-06', pin: 'PIN-LYON-A-4242', note: 'NOTE-LYON-SECRET-not-served' },
          { name: 'Lyon Hotel B', check_in: '2026-12-06', check_out: '2026-12-08', address: '9 Quai Example' },
        ],
        days: [item('2026-12-05', 'Old town'), item('2026-12-06', 'Change hotels'), item('2026-12-07', 'Food market'), item('2026-12-08', 'Drive to Nice')],
      },
      {
        // No hotel at all: its nights must not inherit Lyon's.
        id: 'nice', title: { he: 'ניס', en: 'Nice' }, tabLabel: 'NICE',
        dates: { start: '2026-12-08', end: '2026-12-10' },
        days: [item('2026-12-09', 'Beach'), item('2026-12-10', 'Fly home')],
      },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

// ── a trip server of our own (the trip-stops-http.test.js pattern) ──────────
async function boot(config, port) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tonight-lodging-'));
  const tripDir = join(dataDir, 'trip');
  mkdirSync(tripDir, { recursive: true });
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(tripDir, 'bookings.json'), '[]');
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  const proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(port), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_URL: '',
      HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234' },
  });
  let log = '';
  proc.stdout.on('data', c => { log += c; });
  proc.stderr.on('data', c => { log += c; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
    proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log.slice(-600)}`)); });
    setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log.slice(-600)}`)); }, 10_000);
  });
  const base = `http://localhost:${port}`;
  const server = {
    dataDir,
    async call(path, { method = 'GET', token, apiKey, body, headers: extra = {} } = {}) {
      const headers = { ...extra };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (apiKey) headers['X-API-Key'] = apiKey;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, headers: res.headers, text, body: json };
    },
    async login(username) {
      for (let i = 0; i < 40; i++) {
        const r = await server.call('/api/auth/login', { method: 'POST', body: { username, password: '1234' } });
        if (r.status === 200) return r.body.token;
        await new Promise(res => setTimeout(res, 100));
      }
      throw new Error(`login ${username} failed`);
    },
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise(res => proc.once('exit', res));
        proc.kill('SIGTERM');
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return server;
}

// The served "Tonight" name of the day row for (phase, date), as a plain string.
function tonight(payload, phaseId, date) {
  const day = payload.days.find(d => d.phase_id === phaseId && d.date === date);
  assert.ok(day, `a day row for ${phaseId} ${date}`);
  const name = day.lodging_context?.name;
  if (name == null) return null;
  return typeof name === 'string' ? name : name.en;
}

describe('GET /api/itinerary/active: "Tonight" is computed from the effective config at serve time', () => {
  let server, alice, bob;
  const agent = { apiKey: AGENT_KEY };
  const active = async () => {
    const r = await server.call('/api/itinerary/active', { token: bob });
    assert.equal(r.status, 200, r.text);
    return r;
  };

  before(async () => {
    server = await boot(rhoneConfig(), PORTS.tonightLodging);
    alice = await server.login('alice');
    bob = await server.login('bob');
  });
  after(async () => { await server?.stop(); });

  test('a stop with stored copies: transfer night is the next stop\'s, legacy hotels by night, a stop with no hotel inherits nothing', async () => {
    // Put the imported rows — each carrying the stored copy written for its
    // OWN stop — back in the active plan, so every case below has a stored
    // value that serve time must override.
    assert.equal((await server.call('/api/itinerary/restore-original', { method: 'POST', token: alice })).status, 200);
    const db = new Database(join(server.dataDir, 'trip.db'), { readonly: true });
    const { active_version_id: rev } = db.prepare('SELECT active_version_id FROM trip_itinerary_state WHERE id = 1').get();
    const stored = (phase, date) => JSON.parse(db.prepare('SELECT lodging_context FROM itinerary_plan_days WHERE revision_id = ? AND phase_id = ? AND date = ?').get(rev, phase, date)?.lodging_context || 'null');
    assert.deepEqual(stored('paris', '2026-12-04')?.name, { he: 'מלון פריז', en: 'Hotel Paris' }, 'precondition: the transfer day stored Paris\'s hotel');
    assert.ok(stored('lyon', '2026-12-08')?.name, 'precondition: Lyon\'s transfer day stored a Lyon hotel');
    db.close();

    const { body } = await active();
    assert.equal(tonight(body, 'paris', '2026-12-01'), 'Hotel Paris');
    assert.equal(tonight(body, 'paris', '2026-12-03'), 'Hotel Paris');
    assert.equal(tonight(body, 'paris', '2026-12-04'), 'Lyon Hotel A', 'the transfer day sleeps at the NEXT stop');
    assert.equal(tonight(body, 'lyon', '2026-12-05'), 'Lyon Hotel A');
    assert.equal(tonight(body, 'lyon', '2026-12-06'), 'Lyon Hotel B', 'the changeover night is the hotel checked into that day');
    assert.equal(tonight(body, 'lyon', '2026-12-07'), 'Lyon Hotel B');
    assert.equal(tonight(body, 'lyon', '2026-12-08'), null, 'Lyon\'s transfer day sleeps in Nice, which has no hotel — never Lyon\'s stored one');
    assert.equal(tonight(body, 'nice', '2026-12-09'), null);
    assert.equal(tonight(body, 'nice', '2026-12-10'), null);
    // The same three fields as before, nothing more.
    const day = body.days.find(d => d.phase_id === 'paris' && d.date === '2026-12-02');
    assert.deepEqual(day.lodging_context, { name: { he: 'מלון פריז', en: 'Hotel Paris' }, address: '1 Rue Example', location_url: 'https://maps.example/paris' });
    assert.deepEqual(body.days.find(d => d.phase_id === 'lyon' && d.date === '2026-12-07').lodging_context,
      { name: 'Lyon Hotel B', address: '9 Quai Example', location_url: null });
    assert.ok(body.days.every(d => d.pickup_context === null));
  });

  test('a Classic/MCP plan write (rows re-derived with lodging_context null) does not take the line away', async () => {
    const r = await server.call('/api/phases/paris/plan', { method: 'POST', ...agent, body: { date: '2026-12-02', time: '15:00', text_he: 'קפה', text_en: 'Cafe' } });
    assert.equal(r.status, 201, r.text);
    const db = new Database(join(server.dataDir, 'trip.db'), { readonly: true });
    const { active_version_id: rev } = db.prepare('SELECT active_version_id FROM trip_itinerary_state WHERE id = 1').get();
    const storedNull = db.prepare('SELECT COUNT(*) AS n FROM itinerary_plan_days WHERE revision_id = ? AND lodging_context IS NOT NULL').get(rev).n;
    db.close();
    assert.equal(storedNull, 0, 'precondition: the legacy re-derive stored no lodging at all');
    const { body } = await active();
    assert.equal(tonight(body, 'paris', '2026-12-02'), 'Hotel Paris');
    assert.equal(tonight(body, 'paris', '2026-12-04'), 'Lyon Hotel A');
    assert.equal(tonight(body, 'lyon', '2026-12-06'), 'Lyon Hotel B');
  });

  test('no PIN, door code, confirmation, phone or hotel note reaches the itinerary payload or /api/today', async () => {
    const { text } = await active();
    for (const s of SECRETS) assert.ok(!text.includes(s), `itinerary payload leaks ${s}`);
    const today = await server.call('/api/today', { token: bob });
    assert.equal(today.status, 200);
    for (const s of SECRETS) assert.ok(!today.text.includes(s), `/api/today leaks ${s}`);
  });

  test('a hotel set through the stop routes shows at once, replaces the base hotel whole, and changes the ETag', async () => {
    const before = await active();
    const etag = before.headers.get('etag');
    const r = await server.call('/api/stops/paris', { method: 'PATCH', token: alice,
      body: { accommodation: { name: 'Hotel Override', address: '2 Rue Override', location_url: 'https://maps.example/override', confirmation: 'CONF-OVERRIDE-SECRET' } } });
    assert.equal(r.status, 200, r.text);
    const cached = await server.call('/api/itinerary/active', { token: bob, headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 200, 'a stop edit is a new payload, never a 304 on the old one');
    const { body, text } = await active();
    assert.equal(tonight(body, 'paris', '2026-12-01'), 'Hotel Override');
    assert.equal(tonight(body, 'paris', '2026-12-02'), 'Hotel Override');
    assert.deepEqual(body.days.find(d => d.phase_id === 'paris' && d.date === '2026-12-02').lodging_context,
      { name: 'Hotel Override', address: '2 Rue Override', location_url: 'https://maps.example/override' });
    assert.ok(!text.includes('Hotel Paris') && !text.includes('1 Rue Example'), 'nothing of the replaced hotel rides along');
    assert.ok(!text.includes('CONF-OVERRIDE-SECRET'), 'only the three day-context fields are served');
    assert.equal(tonight(body, 'paris', '2026-12-04'), 'Lyon Hotel A', 'the transfer day is still Lyon\'s night');
  });

  test('a split: the transfer night shows the NEW stop\'s hotel', async () => {
    const r = await server.call('/api/stops/lyon/split', { method: 'POST', token: alice,
      body: { at: '2026-12-06', new_stop: { title: { he: 'ליון דרום', en: 'Lyon South' }, tabLabel: 'SOUTH', accommodation: { name: 'Hotel South' } } } });
    assert.equal(r.status, 201, r.text);
    const newId = r.body.stops[1].id;
    const { body } = await active();
    assert.equal(tonight(body, 'lyon', '2026-12-05'), 'Lyon Hotel A');
    assert.equal(body.days.find(d => d.date === '2026-12-06' && d.label_en === 'Change hotels')?.phase_id, 'lyon', 'precondition: the split day stays with the stop it ends');
    assert.equal(tonight(body, 'lyon', '2026-12-06'), 'Hotel South', 'the split day\'s night is the new stop\'s');
    assert.equal(tonight(body, newId, '2026-12-07'), 'Hotel South');
  });

  test('a split into a stop with no hotel: the transfer night is empty, not the old stop\'s hotel', async () => {
    const r = await server.call('/api/stops/paris/split', { method: 'POST', token: alice,
      body: { at: '2026-12-03', new_stop: { title: { he: 'ורסאי', en: 'Versailles' }, tabLabel: 'VERSAILLES' } } });
    assert.equal(r.status, 201, r.text);
    const { body } = await active();
    assert.equal(tonight(body, 'paris', '2026-12-02'), 'Hotel Override');
    assert.equal(body.days.find(d => d.date === '2026-12-03' && d.label_en === 'Montmartre')?.phase_id, 'paris');
    assert.equal(tonight(body, 'paris', '2026-12-03'), null, 'the new stop has no hotel; Paris\'s must not be inherited');
  });
});

// ── in process: the golden, and the fallback ────────────────────────────────
function journeyFor(config) {
  const dir = mkdtempSync(join(tmpdir(), 'tonight-lodging-unit-'));
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trip_config_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, content TEXT, hash TEXT);
    CREATE TABLE phase_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT, date TEXT, time TEXT, text_he TEXT, text_en TEXT,
      location_url TEXT, booking_id INTEGER, status TEXT, sort_order REAL, created_by TEXT, created_at TEXT,
      waze_url TEXT, website_url TEXT, ticket_url TEXT, enrichment_status TEXT, time_sort INTEGER, config_ref TEXT,
      extra_links TEXT
    );
    CREATE TABLE phase_plan_days (phase_id TEXT, date TEXT, label_he TEXT, label_en TEXT, PRIMARY KEY (phase_id, date));
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, date_from TEXT, date_to TEXT, confirmation TEXT, conf_file TEXT, location_url TEXT, google_wallet_url TEXT, apple_wallet_url TEXT, pkpass_file TEXT, review_status TEXT DEFAULT 'approved');
  `);
  let current = config;
  const journey = create({ db, config, getConfig: () => current, raw: JSON.stringify(config), mediaDir: dir, fetchImpl: fetch });
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) =>
    [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))]));
  journey.registerRoutes(app, { authRequired() {}, organizerOrAgentRequired() {} });
  return {
    db,
    setConfig(next) { current = next; },
    active() {
      let out;
      routes.get('get /api/itinerary/active')({ headers: {} }, { setHeader() {}, status() { return this; }, end() {}, json(v) { out = v; } });
      return out;
    },
    storedDays() {
      const { active_version_id: rev } = db.prepare('SELECT active_version_id FROM trip_itinerary_state WHERE id = 1').get();
      return db.prepare('SELECT phase_id, date, lodging_context FROM itinerary_plan_days WHERE revision_id = ? ORDER BY date ASC, sort_order ASC').all(rev)
        .map(d => ({ phase_id: d.phase_id, date: d.date, lodging_context: JSON.parse(d.lodging_context || 'null') }));
    },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('golden: trips/japan-2025 with no overrides and the stored copy present serves exactly the stored copy', () => {
  const japan = JSON.parse(readFileSync(join(REPO, 'trips', 'japan-2025', 'trip.config.json'), 'utf8'));
  const j = journeyFor(japan);
  try {
    const stored = j.storedDays();
    assert.ok(stored.length > 5 && stored.every(d => d.lodging_context?.name), 'precondition: every imported day stored a hotel');
    const served = j.active().days.map(d => ({ phase_id: d.phase_id, date: d.date, lodging_context: d.lodging_context }));
    assert.deepEqual(served, stored);
  } finally { j.close(); }
});

test('the stored copy is the fallback only when no stop covers the date — still projected to the public fields', () => {
  const cfg = clone(rhoneConfig());
  const j = journeyFor(cfg);
  try {
    const storedParis = j.storedDays().find(d => d.phase_id === 'paris' && d.date === '2026-12-02').lodging_context;
    assert.deepEqual(storedParis.name, { he: 'מלון פריז', en: 'Hotel Paris' });
    // Stops lose their dates (the shape a freshly interviewed trip can have):
    // nothing covers any night, so every day serves what was stored for it.
    const undated = clone(cfg);
    for (const p of undated.phases) delete p.dates;
    j.setConfig(undated);
    const served = j.active();
    assert.deepEqual(served.days.find(d => d.phase_id === 'paris' && d.date === '2026-12-02').lodging_context, storedParis);
    assert.equal(tonight(served, 'paris', '2026-12-04'), 'Hotel Paris', 'with no dated stop the stored copy stands');
    // A stop covering the night, with no hotel, serves nothing — even though a
    // copy was stored for the day.
    const emptied = clone(cfg);
    delete emptied.phases[0].accommodation;
    j.setConfig(emptied);
    assert.equal(tonight(j.active(), 'paris', '2026-12-02'), null);
    for (const s of SECRETS) assert.ok(!JSON.stringify(j.active()).includes(s), s);
  } finally { j.close(); }
});

test('a stored row as the old import wrote it, on a night no stop covers, is still served only through the projection', () => {
  const j = journeyFor(clone(rhoneConfig()));
  try {
    const { active_version_id: rev } = j.db.prepare('SELECT active_version_id FROM trip_itinerary_state WHERE id = 1').get();
    // 2026-12-11 is after Nice ends: the fallback path.
    j.db.prepare('INSERT INTO itinerary_plan_days (revision_id, phase_id, date, label_he, label_en, lodging_context, pickup_context, sort_order) VALUES (?,?,?,?,?,?,?,?)')
      .run(rev, 'nice', '2026-12-11', null, null,
        JSON.stringify({ name: { he: 'x', en: 'y', internal: 'STORED-LODGING-SECRET' }, door: 'STORED-EXTRA-SECRET', pin: 'STORED-PIN-SECRET' }),
        JSON.stringify({ driver_phone: 'STORED-PICKUP-SECRET' }), 99);
    const served = j.active();
    const text = JSON.stringify(served);
    for (const s of ['STORED-LODGING-SECRET', 'STORED-EXTRA-SECRET', 'STORED-PIN-SECRET', 'STORED-PICKUP-SECRET']) assert.ok(!text.includes(s), s);
    const day = served.days.find(d => d.date === '2026-12-11');
    assert.deepEqual(day.lodging_context, { name: { he: 'x', en: 'y' }, address: null, location_url: null });
    assert.equal(day.pickup_context, null);
  } finally { j.close(); }
});
