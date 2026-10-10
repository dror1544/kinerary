/**
 * trip-timezone.test.js — the DB-backed, live-mutable trip timezone override
 * (server/living-journey.js) and get_today's new `time` field.
 *
 * Amit, on orlando-florida-2026, asked the companion the time and got a stale
 * web-search answer, then a confidently wrong "UTC — the trip's own
 * timezone" — Orlando's trip.config.json never set a timezone anywhere
 * tripTimeZone() checks. This exercises the fix: GET/PATCH /api/settings
 * (following trip_ui_settings's own established shape), isValidTimeZone
 * (Node's equivalent of the worker's _is_iana_timezone), and the DB override
 * winning over the config's own fallback chain in buildTodayContext.
 */
import { PORTS } from './helpers/ports.js';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { isValidTimeZone } = require('../server/living-journey.js');

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── isValidTimeZone — the same shape as the worker's _is_iana_timezone ─────

test('isValidTimeZone accepts real IANA zones', () => {
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Asia/Jerusalem'), true);
  assert.equal(isValidTimeZone('UTC'), true);
});

test('isValidTimeZone rejects garbage, a country name, and empty/missing values', () => {
  assert.equal(isValidTimeZone('Vietnam'), false, 'a country name is not a zone identifier');
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone('not/a/zone'), false);
  assert.equal(isValidTimeZone(undefined), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone(42), false, 'a non-string must not reach Intl and throw');
});

// ── GET/PATCH /api/settings, over the real running server ──────────────────

let token;
before(async () => { await startTestServer({ HOST: '127.0.0.1', PORT: PORTS.tripTimezone }); token = await loginAsAlice(); });
after(stopTestServer);

test('GET /api/settings starts with no timezone override', async () => {
  const res = await api('/api/settings', { token });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.timezone, null);
  assert.equal(body.updated_by, null);
});

test('PATCH /api/settings (organizer) round-trips a valid IANA zone, and GET reflects it', async () => {
  const patched = await api('/api/settings', { method: 'PATCH', token, body: { timezone: 'America/New_York' } });
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json();
  assert.equal(patchedBody.timezone, 'America/New_York');
  assert.equal(patchedBody.updated_by, 'alice');
  assert.ok(patchedBody.updated_at);

  const get = await api('/api/settings', { token });
  assert.equal(get.status, 200);
  assert.equal((await get.json()).timezone, 'America/New_York');
});

test('PATCH /api/settings stores the canonical IANA spelling, not whatever case the caller sent', async () => {
  // Intl resolves this the same way regardless of case, but the raw config
  // spelling must never be the thing stored/served — same rule localClock
  // already follows for what /api/today serves (Intl's canonical name, never
  // the config's own spelling).
  const res = await api('/api/settings', { method: 'PATCH', token, body: { timezone: 'america/new_york' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.timezone, 'America/New_York', 'stored/returned value must be the canonical spelling, not the input');

  const get = await (await api('/api/settings', { token })).json();
  assert.equal(get.timezone, 'America/New_York');
});

test('PATCH /api/settings rejects an invalid zone with 400 and leaves the stored value unchanged', async () => {
  const priorSettings = await (await api('/api/settings', { token })).json();
  const res = await api('/api/settings', { method: 'PATCH', token, body: { timezone: 'Vietnam' } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /valid IANA/i);

  const afterSettings = await (await api('/api/settings', { token })).json();
  assert.equal(afterSettings.timezone, priorSettings.timezone, 'a rejected PATCH must not change the stored value');
});

test('PATCH /api/settings rejects an empty or missing timezone', async () => {
  for (const body of [{ timezone: '' }, {}]) {
    const res = await api('/api/settings', { method: 'PATCH', token, body });
    assert.equal(res.status, 400);
  }
});

test('PATCH /api/settings requires organizer/agent auth — a plain member is rejected, matching PATCH /api/ui-settings', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } });
  assert.equal(login.status, 200);
  const { token: memberToken } = await login.json();
  const res = await api('/api/settings', { method: 'PATCH', token: memberToken, body: { timezone: 'Asia/Tokyo' } });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'organizer_only' });

  // The member's own read access is untouched — only the write is scoped.
  const read = await api('/api/settings', { token: memberToken });
  assert.equal(read.status, 200);
});

test('PATCH /api/settings via the agent service-account key succeeds, matching organizerOrAgentRequired', async () => {
  const res = await api('/api/settings', { method: 'PATCH', apiKey: 'test-hermes-key', body: { timezone: 'Asia/Jerusalem' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).timezone, 'Asia/Jerusalem');
});

// ── The override reaches GET /api/today, and its new `time` field ──────────

test('the DB override wins over the config, and get_today answers "what time is it" from the same clock as `today`', async () => {
  // tests/fixtures/trip.config.json has no meta.timezone/config.timezone/phase
  // timezone at all, so with the override cleared this would fall through to
  // 'UTC' — exactly Orlando's bug. Set a distinctive override and confirm
  // /api/today reflects it rather than the config's (absent) chain.
  const patch = await api('/api/settings', { method: 'PATCH', token, body: { timezone: 'Pacific/Kiritimati' } });
  assert.equal(patch.status, 200);

  const today = await (await api('/api/today', { token })).json();
  assert.equal(today.time_zone, 'Pacific/Kiritimati');
  assert.match(today.time, HHMM_RE, 'time must be HH:MM');

  // Internal consistency: `time` must come from the exact same clock read as
  // `today` (the date) — not a second, independently-timed computation. Cross
  // -check against a fresh Intl read for the same zone, with a small
  // tolerance for the few milliseconds between the two reads (and a minute
  // boundary landing between them), never for the two fields disagreeing with
  // each other.
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (t) => parts.find((p) => p.type === t).value;
  const expectedDate = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const expectedMinutes = Number(pick('hour')) * 60 + Number(pick('minute'));
  const [hh, mm] = today.time.split(':').map(Number);
  const actualMinutes = hh * 60 + mm;
  assert.equal(today.today, expectedDate, 'today.today must be the trip-local date in the override zone');
  const diff = Math.min(Math.abs(actualMinutes - expectedMinutes), 1440 - Math.abs(actualMinutes - expectedMinutes));
  assert.ok(diff <= 2, `today.time (${today.time}) should be within 2 minutes of a fresh read for the same zone`);
});

test('clearing back to a resolvable config falls through to the documented order: meta, then config, then phase, then UTC', async () => {
  // PATCH only accepts a real zone, so there is no "unset" via the API by
  // design (mirrors PATCH /api/ui-settings, which has no clear-to-default
  // either) — this exercises the fallback chain at the DB layer directly, the
  // same way living-journey.test.js pokes trip_itinerary_state elsewhere.
  const { create } = require('../server/living-journey.js');
  const Database = require('../server/node_modules/better-sqlite3');
  const { mkdtempSync, rmSync, readFileSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');

  const dir = mkdtempSync(join(tmpdir(), 'trip-timezone-fallback-'));
  try {
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
      CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, date_from TEXT, date_to TEXT, confirmation TEXT, conf_file TEXT, location_url TEXT, google_wallet_url TEXT, apple_wallet_url TEXT, pkpass_file TEXT);
    `);
    const config = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
    delete config.meta.timezone;
    delete config.timezone;
    config.phases = [{ id: 'p1', dates: { start: '2000-01-01', end: '2000-01-02' } }];
    const raw = JSON.stringify(config);
    const journey = create({ db, config, raw, mediaDir: dir, fetchImpl: fetch });
    db.exec("ALTER TABLE bookings ADD COLUMN review_status TEXT DEFAULT 'approved'");
    db.exec('ALTER TABLE bookings ADD COLUMN notes TEXT');

    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) =>
      [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))]));
    journey.registerRoutes(app, { authRequired() {}, organizerOrAgentRequired() {} });
    const tripToday = routes.get('get /api/today');
    let result;
    const res = { setHeader() {}, json(value) { result = value; } };

    // 1. No override, no config timezone anywhere -> UTC.
    tripToday({}, res);
    assert.equal(result.time_zone, 'UTC');

    // 2. A phase timezone is the last config-level fallback.
    config.phases[0].timezone = 'Asia/Tokyo';
    tripToday({}, res);
    assert.equal(result.time_zone, 'Asia/Tokyo');

    // 3. config.timezone (top-level) wins over a phase timezone.
    config.timezone = 'Europe/London';
    tripToday({}, res);
    assert.equal(result.time_zone, 'Europe/London');

    // 4. config.meta.timezone wins over top-level config.timezone.
    config.meta.timezone = 'Asia/Jerusalem';
    tripToday({}, res);
    assert.equal(result.time_zone, 'Asia/Jerusalem');

    // 5. The DB override wins over everything in the config, even though
    // every config-level fallback is still set above.
    db.prepare("UPDATE trip_settings SET timezone = 'America/New_York', updated_by = 'alice', updated_at = datetime('now') WHERE id = 1").run();
    tripToday({}, res);
    assert.equal(result.time_zone, 'America/New_York');

    // 6. Clearing the override falls back to config.meta.timezone again —
    // proves the precedence is read live, not cached at construction time.
    db.prepare("UPDATE trip_settings SET timezone = NULL WHERE id = 1").run();
    tripToday({}, res);
    assert.equal(result.time_zone, 'Asia/Jerusalem');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
