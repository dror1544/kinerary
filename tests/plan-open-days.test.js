/**
 * plan-open-days.test.js — planning the days no stop covers, in ONE action
 * (issue #133, owner decision of 2026-09-20).
 *
 *   "Once the user approves the proposed plan/change, the phase rename and the
 *    associated itinerary update should execute immediately as one completed
 *    action from the user's perspective ... the important requirement is the
 *    final user-visible result."
 *
 * Before this, "plan these open days" was extend-then-split plus one
 * add_plan_item call per activity: any failure between two calls left a trip
 * with a stop and half its plan. POST /api/stops (server/trip-structure.js
 * ops.create) takes the gap's dates, the stop and its plan items together,
 * validates ALL of it against the trip's structure, and applies it in one
 * SQLite transaction through the override layer.
 *
 *   1. unit  — the operation against a stand-in journey: the stop and its
 *              items land together; a failure mid-write leaves NOTHING.
 *   2. http  — the real trip server on a trip with a gap: the gap is shown as
 *              open days; every refusal changes nothing (config, itinerary and
 *              stop revisions byte-identical); the success shows the stop AND
 *              its plan to Modern (/api/itinerary/active), Classic
 *              (/api/phases/:id/plan, home cards) and the config; the auth
 *              matrix is organizer-or-agent only.
 *   3. a trip whose every day was covered at provisioning (no open-days
 *      marker): a stop shrunk later frees days that can be planned all the same.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PORTS } from './helpers/ports.js';
import { createRenderContext } from './helpers/dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { createTripStructure } = require('../server/trip-structure.js');
const AGENT_KEY = 'test-hermes-key';
const clone = (v) => JSON.parse(JSON.stringify(v));

const OPEN_NOTE = (n) => ({
  he: `${n} ימים בטיול שעוד לא שויכו לתחנה. אפשר לדבר עם העוזר כדי לשבץ אותם לתחנה קיימת או לפתוח תחנה חדשה.`,
  en: `${n} day(s) of this trip do not belong to a stop yet. Talk to your assistant to add them to one, or open a new stop.`,
});

// A trip with a hole in the middle: Frankfurt 2–3 Dec, Colmar 6–7 Dec, and the
// provisioner's open-days phase over the 4th and 5th.
function gapConfig() {
  return {
    meta: { title: 'Alsace 2026', brand: 'ALSACE', departure: '2026-12-02T00:00:00+00:00', returnDate: '2026-12-07', totalDays: 6, deploymentNonce: 'open-days-test', defaultLang: 'he' },
    participants: [
      { username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' },
      { username: 'bob', name: 'בוב', name_en: 'Bob', family: 'a', color: '#10B981' },
    ],
    phases: [
      { id: 'frankfurt', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT', dates: { start: '2026-12-02', end: '2026-12-03' } },
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR', dates: { start: '2026-12-06', end: '2026-12-07' } },
      {
        id: 'open-days', unplanned: true, title: { he: 'ימים שעוד לא תוכננו', en: 'Days not planned yet' }, tabLabel: '?',
        dates: { start: '2026-12-04', end: '2026-12-05' }, note: OPEN_NOTE(2),
      },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

const PLAN = {
  dates: { start: '2026-12-04', end: '2026-12-05' },
  title: { he: 'שטרסבורג', en: 'Strasbourg' },
  tabLabel: 'STRASBOURG',
  emoji: '🏰',
  accommodation: { name: 'Hotel Strasbourg Centre', type: 'hotel' },
  days: [{ date: '2026-12-04', label_he: 'העיר העתיקה', label_en: 'The old town' }],
  items: [
    { date: '2026-12-04', time: '10:00', text_he: 'קתדרלת שטרסבורג', text_en: 'Strasbourg Cathedral', location_url: 'https://maps.example/cathedral' },
    { date: '2026-12-04', time: '19:00', text_he: 'ארוחת ערב בפטיט פראנס', text_en: 'Dinner in Petite France', item_type: 'meal' },
    { date: '2026-12-05', time: 'morning', text_he: 'שוק חג המולד', text_en: 'Christmas market' },
  ],
};

// ── 1. unit: the operation against a stand-in journey ───────────────────────
function fakeJourney(rows = { days: [], items: [] }, { failChange = false } = {}) {
  return {
    rows, changes: 0,
    activeRows() { return clone(this.rows); },
    activeRevision() { return `rev-${this.changes}`; },
    applyChange(_author, _note, transform) {
      const next = clone(this.rows);
      transform(next);
      if (failChange) throw new Error('itinerary write failed mid-operation');
      this.rows = next;
      this.changes++;
      return `rev-${this.changes}`;
    },
    dayContext() { return { lodging_context: null, pickup_context: null }; },
  };
}
function make(config, journey = fakeJourney()) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT, type TEXT, name TEXT, date_from TEXT,
      date_to TEXT, confirmation TEXT, pin TEXT, notes TEXT, location_url TEXT, review_status TEXT DEFAULT 'approved');
    CREATE TABLE budget_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT);
    CREATE TABLE photos (id TEXT PRIMARY KEY, phase TEXT);
  `);
  const reviewed = [];
  const structure = createTripStructure({ db, baseConfig: () => config, journey: () => journey, queuePhaseReview: (id) => reviewed.push(id) });
  return { db, structure, journey, reviewed };
}
const overrideCount = (db) => db.prepare('SELECT COUNT(*) n FROM trip_stop_overrides').get().n;
const historyCount = (db) => db.prepare('SELECT COUNT(*) n FROM trip_stop_history').get().n;

describe('ops.create — the operation itself', () => {
  test('the stop and its plan land together: dates, title, hotel, items, headline, and the open days are gone', () => {
    const { structure, journey, db } = make(gapConfig());
    assert.deepEqual(structure.effectiveConfig().phases.filter(p => p.unplanned).map(p => p.id), ['open-days']);
    const r = structure.ops.create(clone(PLAN), 'alice');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.stop.id;
    assert.equal(id, 'strasbourg');
    const phases = structure.effectiveConfig().phases;
    assert.deepEqual(phases.map(p => p.id), ['frankfurt', 'strasbourg', 'colmar'], 'chronological, between its neighbours');
    assert.deepEqual(phases.find(p => p.id === id).dates, { start: '2026-12-04', end: '2026-12-05' });
    assert.equal(phases.find(p => p.id === id).accommodation.name, 'Hotel Strasbourg Centre');
    assert.ok(!phases.some(p => p.unplanned), 'no days are left open');
    assert.deepEqual(journey.rows.items.map(i => [i.phase_id, i.date, i.time, i.item_type, i.text_en]), [
      [id, '2026-12-04', '10:00', 'activity', 'Strasbourg Cathedral'],
      [id, '2026-12-04', '19:00', 'meal', 'Dinner in Petite France'],
      [id, '2026-12-05', 'morning', 'activity', 'Christmas market'],
    ]);
    assert.equal(r.body.items.length, 3);
    assert.ok(journey.rows.items.every(i => i.confirmation_state === 'verified' && i.created_by === 'alice'));
    assert.deepEqual(journey.rows.days.map(d => [d.phase_id, d.date, d.label_en]), [[id, '2026-12-04', 'The old town'], [id, '2026-12-05', null]]);
    assert.equal(historyCount(db), 1, 'one history row for the stop');
    assert.equal(db.prepare('SELECT action, actor FROM trip_stop_history').get().action, 'create');
  });

  test('a stop with no items is just a stop in the gap (the first gap in the brief: no extend-then-split)', () => {
    const { structure, journey } = make(gapConfig());
    const r = structure.ops.create({ dates: { start: '2026-12-04', end: '2026-12-04' }, title: 'Basel' }, 'alice');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(journey.changes, 0, 'no itinerary revision when there is nothing to write');
    assert.deepEqual(structure.effectiveConfig().phases.filter(p => p.unplanned).map(p => [p.id, p.dates.start, p.dates.end]), [['open-days', '2026-12-05', '2026-12-05']]);
  });

  test('items already filed under the open days on those dates go with the new stop — none is orphaned', () => {
    const rows = {
      days: [{ phase_id: 'open-days', date: '2026-12-05', label_he: 'יום חופשי', label_en: 'Free day' }],
      items: [{ item_uid: 'old1', phase_id: 'open-days', date: '2026-12-05', text_he: 'ישן', text_en: 'old', time: null }],
    };
    const { structure, journey } = make(gapConfig(), fakeJourney(rows));
    const r = structure.ops.create(clone(PLAN), 'alice');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.stop.id;
    assert.equal(journey.rows.items.find(i => i.item_uid === 'old1').phase_id, id);
    assert.ok(!journey.rows.days.some(d => d.phase_id === 'open-days'), 'the open-days day row moved with it');
    assert.deepEqual(r.body.moved_from_open_days.items, ['old1']);
    assert.equal(journey.rows.days.find(d => d.phase_id === id && d.date === '2026-12-05').label_en, 'Free day');
  });

  test('ATOMIC: a failure while the itinerary is written leaves no stop, no history, no override', () => {
    const { structure, db } = make(gapConfig(), fakeJourney({ days: [], items: [] }, { failChange: true }));
    const before = JSON.stringify(structure.effectiveConfig());
    const rev = structure.revision();
    assert.throws(() => structure.ops.create(clone(PLAN), 'alice'), /itinerary write failed/);
    assert.equal(overrideCount(db), 0);
    assert.equal(historyCount(db), 0);
    assert.equal(structure.revision(), rev, 'the revision did not move');
    assert.equal(JSON.stringify(structure.effectiveConfig()), before, 'the served trip is unchanged');
  });

  const REFUSALS = [
    ['dates are required', { title: 'X', items: [] }, 400, 'dates_required'],
    ['a title is required', { dates: PLAN.dates }, 400, 'title_required'],
    ['an unknown field is refused, not ignored', { ...PLAN, colour: 'red' }, 400, 'unknown_field'],
    ['a range running past the end of the trip',{ ...PLAN, dates: { start: '2026-12-04', end: '2026-12-31' } }, 400, 'dates_outside_trip'],
    ['dates outside the trip', { ...PLAN, dates: { start: '2026-12-04', end: '2026-12-09' } }, 400, 'dates_outside_trip'],
    ['an impossible calendar day', { ...PLAN, dates: { start: '2026-02-30', end: '2026-12-05' } }, 400, 'invalid_dates'],
    ['overlapping an existing stop', { ...PLAN, dates: { start: '2026-12-03', end: '2026-12-05' } }, 409, 'dates_overlap_stop'],
    ['covering an existing stop whole', { ...PLAN, dates: { start: '2026-12-04', end: '2026-12-06' } }, 409, 'dates_overlap_stop'],
    ['an item outside the stop', { ...PLAN, items: [...PLAN.items, { date: '2026-12-06', text_he: 'x' }] }, 400, 'item_outside_stop'],
    ['an item with no date', { ...PLAN, items: [{ text_he: 'x' }] }, 400, 'invalid_item'],
    ['an item with markup', { ...PLAN, items: [{ date: '2026-12-04', text_he: '<img src=x onerror=alert(1)>' }] }, 400, 'invalid_text'],
    ['an item with a bad time', { ...PLAN, items: [{ date: '2026-12-04', text_he: 'x', time: '25:99' }] }, 400, 'invalid_item'],
    ['an item with an unknown type', { ...PLAN, items: [{ date: '2026-12-04', text_he: 'x', item_type: 'rave' }] }, 400, 'invalid_item'],
    ['an item with a javascript: link', { ...PLAN, items: [{ date: '2026-12-04', text_he: 'x', location_url: 'javascript:alert(1)' }] }, 400, 'invalid_link'],
    ['an unknown item field', { ...PLAN, items: [{ date: '2026-12-04', text_he: 'x', bogus: 1 }] }, 400, 'unknown_field'],
    ['items that are not a list', { ...PLAN, items: 'x' }, 400, 'invalid_items'],
    ['a headline outside the stop', { ...PLAN, days: [{ date: '2026-12-09', label_he: 'x' }] }, 400, 'invalid_day'],
    ['a door code on the hotel', { ...PLAN, accommodation: { name: 'H', pin: '1234' } }, 400, 'pin_not_accepted'],
    ['a stop id that is an open-days id', { ...PLAN, id: 'open-days-2' }, 400, 'invalid_stop_id'],
    ['a stop id that is taken', { ...PLAN, id: 'colmar' }, 409, 'stop_id_taken'],
  ];
  for (const [name, body, status, error] of REFUSALS) {
    test(`refused, and NOTHING changes: ${name}`, () => {
      const { structure, journey, db } = make(gapConfig());
      const before = JSON.stringify(structure.effectiveConfig());
      const r = structure.ops.create(clone(body), 'alice');
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.equal(r.body.error, error, JSON.stringify(r.body));
      assert.equal(overrideCount(db), 0);
      assert.equal(historyCount(db), 0);
      assert.equal(journey.changes, 0);
      assert.equal(JSON.stringify(structure.effectiveConfig()), before);
    });
  }

  test('overlap says which stop and which days are free, so the caller can re-plan', () => {
    const { structure } = make(gapConfig());
    const r = structure.ops.create({ ...clone(PLAN), dates: { start: '2026-12-03', end: '2026-12-05' } }, 'alice');
    assert.equal(r.body.stop, 'frankfurt');
    assert.deepEqual(r.body.open_days, [{ start: '2026-12-04', end: '2026-12-05' }]);
  });

  test('If-Match: a stale revision is refused with the current one, nothing written', () => {
    const { structure, db } = make(gapConfig());
    const r = structure.ops.create(clone(PLAN), 'alice', '"st-99"');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'stops_changed_reload_before_retry');
    assert.equal(overrideCount(db), 0);
    assert.equal(structure.ops.create(clone(PLAN), 'alice', `"${structure.revision()}"`).status, 201);
  });

  test('a second identical call is refused (the days are no longer open), not duplicated', () => {
    const { structure, journey } = make(gapConfig());
    assert.equal(structure.ops.create(clone(PLAN), 'alice').status, 201);
    const items = journey.rows.items.length;
    const again = structure.ops.create(clone(PLAN), 'alice');
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'dates_overlap_stop');
    assert.equal(journey.rows.items.length, items);
  });

  test('a gap at the start of the trip puts the new stop first; ids stay unique for a title with no letters', () => {
    const cfg = gapConfig();
    cfg.phases[0].dates = { start: '2026-12-04', end: '2026-12-05' };
    cfg.phases[2].dates = { start: '2026-12-02', end: '2026-12-03' };
    const { structure } = make(cfg);
    const r = structure.ops.create({ dates: { start: '2026-12-02', end: '2026-12-03' }, title: { he: 'בזל' } }, 'alice');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.stop.id, 'stop-2026-12-02');
    assert.deepEqual(structure.effectiveConfig().phases.map(p => p.id), ['stop-2026-12-02', 'frankfurt', 'colmar']);
  });
});

// ── 2. http ─────────────────────────────────────────────────────────────────
async function boot(config, port) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plan-open-days-'));
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
    proc, dataDir, base,
    async call(path, { method = 'GET', token, apiKey, body, ifMatch } = {}) {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (apiKey) headers['X-API-Key'] = apiKey;
      if (ifMatch) headers['If-Match'] = ifMatch;
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

describe('POST /api/stops — plan the open days, over HTTP, on a trip with a gap', () => {
  let server, alice, bob;
  const agent = { apiKey: AGENT_KEY };
  const config = async () => (await server.call('/api/config', { token: bob })).body;
  const snapshot = async () => ({
    config: (await server.call('/api/config', { token: bob })).text,
    itinerary: (await server.call('/api/itinerary/active', agent)).text,
    stops: (await server.call('/api/stops', agent)).body.revision,
  });
  const post = (body, who = { token: alice }, extra = {}) => server.call('/api/stops', { method: 'POST', body, ...who, ...extra });
  const planned = (id) => server.call(`/api/phases/${id}/plan`, { token: bob });

  before(async () => {
    server = await boot(gapConfig(), PORTS.planOpenDays);
    alice = await server.login('alice');
    bob = await server.login('bob');
    // A day somebody had already started planning under the open days.
    const add = await server.call('/api/itinerary/items', { method: 'POST', ...agent,
      body: { phase_id: 'open-days', date: '2026-12-05', text_he: 'רעיון ישן', text_en: 'An old idea' } });
    assert.equal(add.status, 201, add.text);
  });
  after(async () => { await server?.stop(); });

  test('the gap is SHOWN: the members see 2 days not planned yet, between the two stops', async () => {
    const phases = (await config()).phases;
    assert.deepEqual(phases.map(p => p.id), ['frankfurt', 'open-days', 'colmar']);
    const gap = phases.find(p => p.id === 'open-days');
    assert.equal(gap.unplanned, true);
    assert.deepEqual(gap.dates, { start: '2026-12-04', end: '2026-12-05' });
    assert.match(gap.note.en, /^2 day\(s\) /);
  });

  test('auth matrix: no auth 401, a member 403 — and nothing is written by the refused calls', async () => {
    const before = await snapshot();
    assert.equal((await post(PLAN, {})).status, 401);
    assert.equal((await post(PLAN, { token: 'garbage.token.x' })).status, 401);
    const asMember = await post(PLAN, { token: bob });
    assert.equal(asMember.status, 403, asMember.text);
    assert.deepEqual(await snapshot(), before);
  });

  test('every refusal leaves the trip byte-identical (config, itinerary and stop revision)', async () => {
    const before = await snapshot();
    const cases = [
      [{ ...PLAN, dates: { start: '2026-12-03', end: '2026-12-05' } }, 409, 'dates_overlap_stop'],
      [{ ...PLAN, dates: { start: '2026-12-04', end: '2026-12-09' } }, 400, 'dates_outside_trip'],
      // The LAST item is the bad one: the first three must not have been written.
      [{ ...PLAN, items: [...PLAN.items, { date: '2026-12-04', text_he: '<b>x</b>' }] }, 400, 'invalid_text'],
      [{ ...PLAN, items: [...PLAN.items, { date: '2026-12-07', text_he: 'x' }] }, 400, 'item_outside_stop'],
      [{ ...PLAN, id: 'colmar' }, 409, 'stop_id_taken'],
    ];
    for (const [body, status, error] of cases) {
      const r = await post(body);
      assert.equal(r.status, status, r.text);
      assert.equal(r.body.error, error, r.text);
      assert.deepEqual(await snapshot(), before, error);
    }
    const stale = await post(PLAN, { token: alice }, { ifMatch: '"st-999"' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'stops_changed_reload_before_retry');
    assert.deepEqual(await snapshot(), before, 'stale revision');
  });

  test('the organizer plans the open days: ONE call, and the stop AND its plan are on the site together', async () => {
    const rev = (await server.call('/api/stops', agent)).body.revision;
    const r = await post(PLAN, { token: alice }, { ifMatch: `"${rev}"` });
    assert.equal(r.status, 201, r.text);
    const id = r.body.stop.id;
    assert.equal(id, 'strasbourg');
    assert.match(r.body.revision, /^st-\d+$/);
    assert.ok(r.body.itinerary_revision, 'an itinerary revision was made in the same action');
    assert.equal(r.body.items.length, 3);

    // The config every client reads: the stop is there, in order, the gap is gone.
    const phases = (await config()).phases;
    assert.deepEqual(phases.map(p => p.id), ['frankfurt', 'strasbourg', 'colmar']);
    const stop = phases.find(p => p.id === id);
    assert.deepEqual(stop.dates, { start: '2026-12-04', end: '2026-12-05' });
    assert.equal(stop.tabLabel, 'STRASBOURG');
    assert.equal(stop.accommodation.name, 'Hotel Strasbourg Centre');
    assert.ok(!phases.some(p => p.unplanned), 'the open-days placeholder is gone for the covered days');

    // Modern reads the active itinerary: the items AND the one that was waiting under open-days.
    const active = (await server.call('/api/itinerary/active', { token: bob })).body;
    const mine = active.items.filter(i => i.phase_id === id);
    assert.deepEqual(mine.map(i => i.text_en).sort(), ['An old idea', 'Christmas market', 'Dinner in Petite France', 'Strasbourg Cathedral']);
    assert.ok(!active.items.some(i => i.phase_id === 'open-days'), 'nothing is left orphaned under open-days');
    assert.equal(active.days.find(d => d.phase_id === id && d.date === '2026-12-04').label_en, 'The old town');

    // Classic reads the phase's plan table.
    const plan = (await planned(id)).body;
    assert.equal(plan.length, 4);
    assert.ok(plan.some(i => i.text_en === 'Strasbourg Cathedral' && i.location_url === 'https://maps.example/cathedral'));
  });

  test('Classic renders the stop and not the placeholder (home cards from the served config)', async () => {
    const cfg = await config();
    const { document, ctx } = createRenderContext('<div id="home-phases"></div>', cfg, 'en');
    ctx.renderHomePhases(cfg);
    const text = document.getElementById('home-phases').textContent;
    assert.match(text, /Strasbourg/);
    assert.ok(!/Days not planned yet/.test(text), text);
  });

  test('the history of the new stop says who created it', async () => {
    const h = await server.call('/api/stops/strasbourg/history', { token: alice });
    assert.equal(h.status, 200);
    assert.deepEqual(h.body.history.map(e => [e.action, e.actor]), [['create', 'alice']]);
  });

  test('the same days cannot be planned twice, and the plan is not duplicated by the retry', async () => {
    const before = await snapshot();
    const again = await post(PLAN, agent);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'dates_overlap_stop');
    assert.deepEqual(await snapshot(), before);
  });

  test('the agent key may plan too (that is how the companion calls it)', async () => {
    const cfg = gapConfig();
    const s = await boot(cfg, PORTS.planOpenDaysFresh);
    try {
      const r = await s.call('/api/stops', { method: 'POST', apiKey: AGENT_KEY, body: { dates: { start: '2026-12-04', end: '2026-12-05' }, title: 'Basel' } });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.stop.id, 'basel');
    } finally { await s.stop(); }
  });
});

// ── 3. a trip with no open-days marker ──────────────────────────────────────
describe('a trip whose every day was covered at provisioning (issue #365 item a)', () => {
  test('shrinking a stop frees days that can still be planned, in one action', async () => {
    const cfg = gapConfig();
    cfg.phases = [
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR', dates: { start: '2026-12-02', end: '2026-12-07' } },
    ];
    const s = await boot(cfg, PORTS.planOpenDaysFresh);
    try {
      const keyed = { apiKey: AGENT_KEY };
      const shrink = await s.call('/api/stops/colmar', { method: 'PATCH', ...keyed, body: { dates: { start: '2026-12-02', end: '2026-12-04' } } });
      assert.equal(shrink.status, 200, shrink.text);
      const r = await s.call('/api/stops', { method: 'POST', ...keyed, body: {
        dates: { start: '2026-12-05', end: '2026-12-07' }, title: { en: 'Basel', he: 'בזל' },
        items: [{ date: '2026-12-06', text_he: 'מוזיאון', text_en: 'Museum' }],
      } });
      assert.equal(r.status, 201, r.text);
      const phases = (await s.call('/api/config', keyed)).body.phases;
      assert.deepEqual(phases.map(p => [p.id, p.dates.start, p.dates.end]), [['colmar', '2026-12-02', '2026-12-04'], ['basel', '2026-12-05', '2026-12-07']]);
      const overlap = await s.call('/api/stops', { method: 'POST', ...keyed, body: { dates: { start: '2026-12-04', end: '2026-12-05' }, title: 'X' } });
      assert.equal(overlap.status, 409, 'a covered day is refused even with no marker to show it');
    } finally { await s.stop(); }
  });
});
