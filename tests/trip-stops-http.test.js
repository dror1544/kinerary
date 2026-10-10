/**
 * trip-stops-http.test.js — stop editing after the interview, over HTTP.
 *
 * The 2026-10-10 manual run (run notes F3, F5b, F6, F8) built a trip whose base
 * stop, Colmar, had no dates and no hotel, with the whole trip filed under a
 * synthetic "6 days not assigned" phase. A hotel booking for 2–7 Dec changed
 * nothing on the site, nothing could move a day between stops, and the "not
 * assigned" block stayed after Colmar got a plan, because its count was text
 * written at provisioning.
 *
 * These tests drive the server routes that fix it, on that same trip shape:
 *   (a) set Colmar's dates and hotel from the approved booking — with one
 *       check-in and one check-out, idempotent, following a booking change;
 *   (b) split Colmar for "the last night near the airport" — later items move
 *       to the new stop atomically and both stops are queued for review;
 *   (c) move a day between stops;
 * and after each, GET /api/config says so immediately. Every refusal in the
 * design is asserted, as is the auth matrix (organizer or agent only), and the
 * served config is byte-identical to the old route while nothing is overridden.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PORTS } from './helpers/ports.js';
import { publicConfig } from '../shared/config-visibility.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
const AGENT_KEY = 'test-hermes-key';
const clone = (v) => JSON.parse(JSON.stringify(v));

function colmarConfig() {
  return {
    meta: { title: 'Alsace 2026', brand: 'ALSACE', departure: '2026-12-02T00:00:00+00:00', returnDate: '2026-12-07', totalDays: 6, deploymentNonce: 'stops-test', defaultLang: 'he' },
    participants: [
      { username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' },
      { username: 'bob', name: 'בוב', name_en: 'Bob', family: 'a', color: '#10B981' },
    ],
    phases: [
      { id: 'frankfurt', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT' },
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR' },
      { id: 'frankfurt2', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT' },
      {
        id: 'open-days', unplanned: true,
        title: { he: 'ימים שעוד לא תוכננו', en: 'Days not planned yet' }, tabLabel: '?',
        dates: { start: '2026-12-02', end: '2026-12-07' },
        note: {
          he: '6 ימים בטיול שעוד לא שויכו לתחנה. אפשר לדבר עם העוזר כדי לשבץ אותם לתחנה קיימת או לפתוח תחנה חדשה.',
          en: '6 day(s) of this trip do not belong to a stop yet. Talk to your assistant to add them to one, or open a new stop.',
        },
      },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

// ── a trip server of our own ────────────────────────────────────────────────
async function boot(config, port, { dataDir } = {}) {
  dataDir = dataDir || mkdtempSync(join(tmpdir(), 'trip-stops-'));
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
    proc, dataDir, tripDir, base, log: () => log,
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
    async stop({ keepData = false } = {}) {
      if (proc.exitCode === null) {
        const exited = new Promise(res => proc.once('exit', res));
        proc.kill('SIGTERM');
        await exited;
      }
      if (!keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return server;
}

// ── byte-identical while nothing is overridden ──────────────────────────────
describe('GET /api/config is byte-identical to the allow-listed config while the override table is empty', () => {
  const expected = (cfg) => JSON.stringify(Object.assign(publicConfig(cfg), { trivia_available: false }));
  const goldens = () => {
    const run = spawnSync('python3', [join(HERE, 'helpers', 'provisioned-config.py')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const provisioned = JSON.parse(run.stdout);
    return [
      ['trips/japan-2025', JSON.parse(readFileSync(join(REPO, 'trips', 'japan-2025', 'trip.config.json'), 'utf8'))],
      ['provisioned venues path', provisioned['venues-path']],
      ['provisioned planned path', provisioned['planned-path']],
      ['colmar shape (F3)', colmarConfig()],
    ];
  };
  for (const [name, cfg] of goldens()) {
    test(name, async () => {
      const server = await boot(cfg, PORTS.tripStopsGolden);
      try {
        const res = await server.call('/api/config', { apiKey: AGENT_KEY });
        assert.equal(res.status, 200);
        assert.equal(res.text, expected(cfg));
      } finally { await server.stop(); }
    });
  }
});

// ── the main flow, on the colmar trip ───────────────────────────────────────
describe('stop editing on the colmar trip', () => {
  let server, alice, bob;
  const agent = { apiKey: AGENT_KEY };
  const config = async () => (await server.call('/api/config', { token: bob })).body;
  const phase = async (id) => (await config()).phases.find(p => p.id === id);
  const unplanned = async () => (await config()).phases.filter(p => p.unplanned);
  const active = async () => (await server.call('/api/itinerary/active', agent)).body;
  const plantBooking = (row) => {
    const db = new Database(join(server.dataDir, 'trip.db'));
    try {
      const cols = Object.keys(row);
      return db.prepare(`INSERT INTO bookings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row)).lastInsertRowid;
    } finally { db.close(); }
  };
  let hotelId;

  before(async () => {
    server = await boot(colmarConfig(), PORTS.tripStops);
    alice = await server.login('alice');
    bob = await server.login('bob');
  });
  after(async () => { await server?.stop(); });

  test('auth matrix: no auth 401, a member 403, on every stop route and move-day', async () => {
    const routes = [
      ['GET', '/api/stops'], ['GET', '/api/stops/colmar/history'],
      ['PATCH', '/api/stops/colmar', { title: 'x' }],
      ['POST', '/api/stops/colmar/split', { at: '2026-12-05', new_stop: { title: 'x' } }],
      ['POST', '/api/stops/colmar/from-booking', { booking_id: 1 }],
      ['POST', '/api/stops/colmar/revert', {}],
      ['DELETE', '/api/stops/colmar'],
      ['POST', '/api/itinerary/move-day', { from_phase_id: 'colmar', date: '2026-12-03', to_phase_id: 'frankfurt' }],
    ];
    for (const [method, path, body] of routes) {
      assert.equal((await server.call(path, { method, body })).status, 401, `${method} ${path} without auth`);
      assert.equal((await server.call(path, { method, body, token: 'garbage.token.x' })).status, 401, `${method} ${path} bad token`);
      assert.equal((await server.call(path, { method, body, token: bob })).status, 403, `${method} ${path} as a member`);
    }
    assert.equal((await server.call('/api/stops', { token: alice })).status, 200, 'organizer');
    assert.equal((await server.call('/api/stops', agent)).status, 200, 'agent key');
  });

  test('GET /api/stops lists the stops with a revision ETag; open-days is marked computed', async () => {
    const res = await server.call('/api/stops', { token: alice });
    assert.equal(res.headers.get('etag'), `"${res.body.revision}"`);
    assert.deepEqual(res.body.stops.map(s => s.id), ['frankfurt', 'colmar', 'frankfurt2', 'open-days']);
    assert.equal(res.body.stops.find(s => s.id === 'open-days').unplanned, true);
    assert.deepEqual(res.body.trip, { start: '2026-12-02', end: '2026-12-07' });
  });

  test('(c) a day planned under open-days, moved onto Colmar, leaves the "not assigned" phase immediately (F8)', async () => {
    const add = await server.call('/api/itinerary/items', { method: 'POST', ...agent,
      body: { phase_id: 'open-days', date: '2026-12-04', text_he: 'שוק חג המולד', text_en: 'Christmas market' } });
    assert.equal(add.status, 201, add.text);
    // A day planned under the synthetic phase is still not assigned to a stop.
    assert.match((await unplanned())[0].note.en, /^6 day\(s\) /);
    const moved = await server.call('/api/itinerary/move-day', { method: 'POST', ...agent,
      body: { from_phase_id: 'open-days', date: '2026-12-04', to_phase_id: 'colmar' } });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.body.moved.items.length, 1);
    const gaps = await unplanned();
    assert.deepEqual(gaps.map(g => [g.id, g.dates.start, g.dates.end]),
      [['open-days-1', '2026-12-02', '2026-12-03'], ['open-days-2', '2026-12-05', '2026-12-07']]);
    assert.match(gaps[0].note.en, /^2 day\(s\) /);
    assert.match(gaps[1].note.en, /^3 day\(s\) /);
    const item = (await active()).items.find(i => i.text_en === 'Christmas market');
    assert.equal(item.phase_id, 'colmar');
  });

  test('from-booking refuses a draft, a non-hotel, an undated or a missing booking', async () => {
    const draft = plantBooking({ phase: 'colmar', type: 'hotel', name: 'Draft Hotel', date_from: '2026-12-02', date_to: '2026-12-07', created_by: 'alice', review_status: 'draft' });
    const car = (await server.call('/api/bookings', { method: 'POST', token: alice, body: { phase: 'colmar', type: 'car', name: 'Rental', date_from: '2026-12-02', date_to: '2026-12-07' } })).body.id;
    const undated = (await server.call('/api/bookings', { method: 'POST', token: alice, body: { phase: 'colmar', type: 'hotel', name: 'Some Hotel' } })).body.id;
    const outside = (await server.call('/api/bookings', { method: 'POST', token: alice, body: { phase: 'colmar', type: 'hotel', name: 'Too Early', date_from: '2026-11-30', date_to: '2026-12-03' } })).body.id;
    const cases = [
      [draft, 409, 'booking_is_draft'], [car, 400, 'booking_not_hotel'], [undated, 400, 'booking_has_no_dates'],
      [outside, 400, 'dates_outside_trip'], [999999, 404, 'booking_not_found'], ['x', 400, 'invalid_booking_id'],
    ];
    for (const [id, status, error] of cases) {
      const r = await server.call('/api/stops/colmar/from-booking', { method: 'POST', token: alice, body: { booking_id: id } });
      assert.equal(r.status, status, `${id}: ${r.text}`);
      assert.equal(r.body.error, error);
      assert.ok(!r.text.includes('Draft Hotel'), 'a refused draft is not echoed');
    }
    assert.equal((await phase('colmar')).dates, undefined, 'nothing was written');
  });

  test('(a) the approved hotel sets Colmar\'s dates and hotel; /api/config shows it at once; no unplanned days remain', async () => {
    hotelId = (await server.call('/api/bookings', { method: 'POST', token: alice, body: {
      phase: 'colmar', type: 'hotel', name: 'Hotel Colmar Centre', date_from: '2026-12-02', date_to: '2026-12-07',
      confirmation: 'HCC-778', pin: 'DOOR-PIN-5521', location_url: 'https://maps.example/colmar-centre', notes: 'private booking notes',
    } })).body.id;
    const r = await server.call('/api/stops/colmar/from-booking', { method: 'POST', token: alice, body: { booking_id: hotelId } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.items, { checkin: `booking_${hotelId}_checkin`, checkout: `booking_${hotelId}_checkout` });
    const colmar = await phase('colmar');
    assert.deepEqual(colmar.dates, { start: '2026-12-02', end: '2026-12-07' });
    assert.deepEqual(colmar.accommodation, { type: 'hotel', name: 'Hotel Colmar Centre', confirmation: 'HCC-778', location_url: 'https://maps.example/colmar-centre' });
    assert.deepEqual(await unplanned(), []);
    const text = JSON.stringify(await config());
    assert.ok(!text.includes('DOOR-PIN-5521') && !text.includes('private booking notes'));
    for (const key of ['booking_id', 'base_digest', 'updated_by', 'booking_out_of_sync', '"kind"']) assert.ok(!text.includes(key), key);
  });

  test('(d) one check-in on date_from and one check-out on date_to, linked to the booking, no duplicates on re-run', async () => {
    const again = await server.call('/api/stops/colmar/from-booking', { method: 'POST', ...agent, body: { booking_id: hotelId } });
    assert.equal(again.status, 200, again.text);
    const items = (await active()).items.filter(i => i.booking_id === hotelId);
    assert.deepEqual(items.map(i => [i.item_uid, i.phase_id, i.date]).sort(), [
      [`booking_${hotelId}_checkin`, 'colmar', '2026-12-02'], [`booking_${hotelId}_checkout`, 'colmar', '2026-12-07'],
    ]);
    // Members see them through the Classic plan too, booking attached.
    const plan = (await server.call('/api/phases/colmar/plan', { token: bob })).body;
    assert.equal(plan.filter(i => i.booking_id === hotelId).length, 2);
  });

  test('the check-out follows a change to the booking\'s dates; the stop reports it is out of sync until re-linked', async () => {
    const patched = await server.call(`/api/bookings/${hotelId}`, { method: 'PATCH', token: alice, body: { date_to: '2026-12-06' } });
    assert.equal(patched.status, 200);
    const checkout = (await active()).items.find(i => i.item_uid === `booking_${hotelId}_checkout`);
    assert.equal(checkout.date, '2026-12-06');
    const listed = (await server.call('/api/stops', { token: alice })).body.stops.find(s => s.id === 'colmar');
    assert.equal(listed.booking_out_of_sync, true);
    assert.equal(listed.override.booking_id, hotelId);
    const relinked = await server.call('/api/stops/colmar/from-booking', { method: 'POST', token: alice, body: { booking_id: hotelId } });
    assert.equal(relinked.status, 200, relinked.text);
    assert.deepEqual((await phase('colmar')).dates, { start: '2026-12-02', end: '2026-12-06' });
    // The 7th now belongs to no stop and has no plan: the count is computed.
    const gaps = await unplanned();
    assert.deepEqual(gaps.map(g => [g.id, g.dates.start, g.dates.end]), [['open-days', '2026-12-07', '2026-12-07']]);
    assert.match(gaps[0].note.en, /^1 day\(s\) /);
    assert.equal((await server.call('/api/stops', { token: alice })).body.stops.find(s => s.id === 'colmar').booking_out_of_sync, false);
  });

  test('a stop write with a stale If-Match is refused with 409 and changes nothing', async () => {
    const { body, headers } = await server.call('/api/stops', { token: alice });
    const stale = `"${body.revision}"`;
    assert.equal((await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, ifMatch: headers.get('etag'), body: { tabLabel: 'COLMAR' } })).status, 200);
    const r = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, ifMatch: stale, body: { tabLabel: 'STALE' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'stops_changed_reload_before_retry');
    assert.equal((await phase('colmar')).tabLabel, 'COLMAR');
  });

  test('dates outside the trip are refused (decision 4)', async () => {
    const r = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { dates: { start: '2026-12-02', end: '2026-12-09' } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'dates_outside_trip');
    assert.deepEqual(r.body.trip, { start: '2026-12-02', end: '2026-12-07' });
  });

  test('a PIN in the accommodation is never accepted', async () => {
    const r = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { accommodation: { name: 'X', pin: '0000' } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'pin_not_accepted');
  });

  test('(b) split Colmar for the last night near the airport: later items move atomically, both stops queued for review', async () => {
    assert.equal((await server.call('/api/stops/colmar', { method: 'PATCH', ...agent, body: { dates: { start: '2026-12-02', end: '2026-12-07' } } })).status, 200);
    for (const [date, en] of [['2026-12-03', 'Riquewihr'], ['2026-12-06', 'Last Colmar morning'], ['2026-12-07', 'Fly home']]) {
      assert.equal((await server.call('/api/itinerary/items', { method: 'POST', ...agent, body: { phase_id: 'colmar', date, text_he: en, text_en: en } })).status, 201);
    }
    assert.equal((await server.call('/api/itinerary/days', { method: 'PATCH', ...agent,
      body: { phase_id: 'colmar', date: '2026-12-07', label_he: 'הביתה', label_en: 'Home' } })).status, 200);

    const r = await server.call('/api/stops/colmar/split', { method: 'POST', token: alice,
      body: { at: '2026-12-06', new_stop: { title: { he: 'ליד שדה התעופה', en: 'Near the airport' }, tabLabel: 'AIRPORT', emoji: '✈️' } } });
    assert.equal(r.status, 201, r.text);
    const newId = r.body.stops[1].id;
    assert.equal(newId, 'near-the-airport');
    assert.deepEqual(r.body.review.phases, ['colmar', newId]);

    const cfg = await config();
    const ids = cfg.phases.map(p => p.id);
    assert.equal(ids[ids.indexOf('colmar') + 1], newId, 'the new stop sits right after Colmar');
    assert.deepEqual(cfg.phases.find(p => p.id === 'colmar').dates, { start: '2026-12-02', end: '2026-12-06' });
    assert.deepEqual(cfg.phases.find(p => p.id === newId).dates, { start: '2026-12-06', end: '2026-12-07' });
    assert.deepEqual(cfg.phases.find(p => p.id === newId).title, { he: 'ליד שדה התעופה', en: 'Near the airport' });

    const items = (await active()).items;
    const where = (en) => items.find(i => i.text_en === en)?.phase_id;
    assert.equal(where('Fly home'), newId);
    assert.equal(where('Riquewihr'), 'colmar');
    assert.equal(where('Last Colmar morning'), 'colmar', 'the split day itself stays with the stop it ends');
    assert.equal(items.find(i => i.item_uid === `booking_${hotelId}_checkin`).phase_id, 'colmar');
    const day = (await active()).days.find(d => d.date === '2026-12-07' && d.label_en === 'Home');
    assert.equal(day?.phase_id, newId, 'the headline travels with its day');

    for (const id of ['colmar', newId]) {
      const plan = (await server.call(`/api/phases/${id}/plan`, { token: alice }));
      assert.equal(plan.status, 200, `${id} is a known phase`);
      assert.ok(plan.body.length && plan.body.every(i => i.review_status === 'pending'), `${id} queued for review`);
    }
  });

  test('split refusals: undated stop, a date not strictly inside it, an id already taken', async () => {
    const cases = [
      ['frankfurt', { at: '2026-12-03', new_stop: { title: 'x' } }, 400, 'stop_has_no_dates'],
      ['colmar', { at: '2026-12-02', new_stop: { title: 'x' } }, 400, 'split_date_not_inside_stop'],
      ['colmar', { at: '2026-12-06', new_stop: { title: 'x' } }, 400, 'split_date_not_inside_stop'],
      ['colmar', { at: 'tomorrow', new_stop: { title: 'x' } }, 400, 'invalid_split_date'],
      ['colmar', { at: '2026-12-04', new_stop: { id: 'frankfurt', title: 'x' } }, 409, 'stop_id_taken'],
      ['colmar', { at: '2026-12-04', new_stop: {} }, 400, 'new_stop_title_required'],
      ['open-days', { at: '2026-12-04', new_stop: { title: 'x' } }, 400, 'unplanned_stop_is_computed'],
      ['nowhere', { at: '2026-12-04', new_stop: { title: 'x' } }, 404, 'unknown_stop'],
    ];
    for (const [id, body, status, error] of cases) {
      const r = await server.call(`/api/stops/${id}/split`, { method: 'POST', token: alice, body });
      assert.equal(r.status, status, `${id} ${JSON.stringify(body)}: ${r.text}`);
      assert.equal(r.body.error, error);
    }
  });

  test('shrinking a stop with items outside its new range is refused with the list, unless keep or move_to (decision 5)', async () => {
    // Colmar is 2–6 Dec now; Riquewihr sits on the 3rd, the check-in on the 2nd.
    const refused = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { dates: { start: '2026-12-04', end: '2026-12-06' } } });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.error, 'items_outside_stop');
    assert.deepEqual(refused.body.items.map(i => i.date).sort(), ['2026-12-02', '2026-12-03']);
    assert.deepEqual((await phase('colmar')).dates, { start: '2026-12-02', end: '2026-12-06' }, 'nothing changed');

    const badTarget = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { dates: { start: '2026-12-04', end: '2026-12-06' }, on_outside: 'move_to:nowhere' } });
    assert.equal(badTarget.status, 400);
    assert.equal(badTarget.body.error, 'invalid_on_outside');

    const moved = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { dates: { start: '2026-12-04', end: '2026-12-06' }, on_outside: 'move_to:frankfurt' } });
    assert.equal(moved.status, 200, moved.text);
    const items = (await active()).items;
    assert.equal(items.find(i => i.text_en === 'Riquewihr').phase_id, 'frankfurt');

    const kept = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { dates: { start: '2026-12-05', end: '2026-12-06' }, on_outside: 'keep' } });
    assert.equal(kept.status, 200, kept.text);
    assert.equal((await active()).items.find(i => i.text_en === 'Christmas market').phase_id, 'colmar', 'kept where it was');
  });

  test('history is append-only and a stop reverts to any recorded state, or to the config', async () => {
    const hist = await server.call('/api/stops/colmar/history', { token: alice });
    assert.equal(hist.status, 200);
    const rows = hist.body.history;
    assert.ok(rows.length >= 5, `history: ${rows.length}`);
    assert.ok(rows.every((r, i) => i === 0 || r.id > rows[i - 1].id));
    const fromBooking = rows.find(r => r.action === 'from_booking');
    const back = await server.call('/api/stops/colmar/revert', { method: 'POST', token: alice, body: { history_id: fromBooking.id, on_outside: 'keep' } });
    assert.equal(back.status, 200, back.text);
    assert.deepEqual((await phase('colmar')).dates, { start: '2026-12-02', end: '2026-12-07' });
    const after = (await server.call('/api/stops/colmar/history', { token: alice })).body.history;
    assert.equal(after.length, rows.length + 1, 'a revert is itself recorded, nothing is rewritten');
    assert.deepEqual(after.slice(0, rows.length), rows);

    assert.equal((await server.call('/api/stops/colmar/revert', { method: 'POST', token: alice, body: { history_id: 999999 } })).status, 404);
    const toConfig = await server.call('/api/stops/colmar/revert', { method: 'POST', token: alice, body: { on_outside: 'keep' } });
    assert.equal(toConfig.status, 200, toConfig.text);
    const colmar = await phase('colmar');
    assert.equal(colmar.dates, undefined);
    assert.equal(colmar.accommodation, undefined);
  });

  test('only an added stop with nothing referring to it may be removed (decision 8)', async () => {
    const configStop = await server.call('/api/stops/frankfurt', { method: 'DELETE', token: alice });
    assert.equal(configStop.status, 409);
    assert.equal(configStop.body.error, 'only_added_stops_can_be_removed');
    const referred = await server.call('/api/stops/near-the-airport', { method: 'DELETE', token: alice });
    assert.equal(referred.status, 409, referred.text);
    assert.equal(referred.body.error, 'stop_in_use');
    assert.ok(referred.body.references.plan_items >= 1);

    assert.equal((await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { dates: { start: '2026-12-02', end: '2026-12-07' } } })).status, 200);
    const split = await server.call('/api/stops/colmar/split', { method: 'POST', token: alice, body: { at: '2026-12-04', new_stop: { id: 'spare', title: 'Spare' } } });
    assert.equal(split.status, 201, split.text);
    // Move what the split carried over back, so nothing refers to the spare stop.
    for (const date of ['2026-12-05', '2026-12-06', '2026-12-07']) {
      const has = (await active()).items.some(i => i.phase_id === 'spare' && i.date === date) || (await active()).days.some(d => d.phase_id === 'spare' && d.date === date);
      if (has) assert.equal((await server.call('/api/itinerary/move-day', { method: 'POST', token: alice, body: { from_phase_id: 'spare', date, to_phase_id: 'colmar' } })).status, 200);
    }
    const removed = await server.call('/api/stops/spare', { method: 'DELETE', token: alice });
    assert.equal(removed.status, 200, removed.text);
    assert.ok(!(await config()).phases.some(p => p.id === 'spare'));
  });

  // LAST in this describe: it rewrites the trip's config file.
  test('export-to-config writes the EFFECTIVE phases — what the site shows, not the file it booted with', async () => {
    const before = await config();
    const exported = await server.call('/api/phase-plan/export-to-config', { method: 'POST', token: alice });
    assert.equal(exported.status, 200, exported.text);
    const file = JSON.parse(readFileSync(join(server.tripDir, 'trip.config.json'), 'utf8'));
    assert.deepEqual(file.phases.map(p => p.id), before.phases.map(p => p.id));
    assert.deepEqual(file.phases.find(p => p.id === 'colmar').dates, before.phases.find(p => p.id === 'colmar').dates);
    assert.ok(file.phases.some(p => p.id === 'near-the-airport'), 'the split-off stop is written');
    // The site keeps serving the same stops, and nothing now reads as a conflict.
    assert.deepEqual((await config()).phases.map(p => [p.id, p.dates]), before.phases.map(p => [p.id, p.dates]));
    const stops = (await server.call('/api/stops', { token: alice })).body.stops;
    assert.ok(stops.every(s => s.conflict === null), JSON.stringify(stops.filter(s => s.conflict)));
    // A stop that is now in the file is no longer "added": it cannot be removed.
    assert.equal((await server.call('/api/stops/near-the-airport', { method: 'DELETE', token: alice })).body.error, 'only_added_stops_can_be_removed');
  });

  test('the stop routes are recorded on the live-update channel as their own resource', async () => {
    const db = new Database(join(server.dataDir, 'trip.db'), { readonly: true });
    try {
      const row = db.prepare("SELECT revision FROM trip_resource_revisions WHERE resource = 'stops'").get();
      assert.ok(row && row.revision > 0, JSON.stringify(row));
    } finally { db.close(); }
  });
});

// ── a rebuild that changes the base under an override ───────────────────────
describe('re-provision under an override (decision 2): the override wins, the conflict is organizer-only', () => {
  test('restart on the same data with a rebuilt config', async () => {
    let server = await boot(colmarConfig(), PORTS.tripStopsGolden);
    const dataDir = server.dataDir;
    try {
      const set = await server.call('/api/stops/colmar', { method: 'PATCH', apiKey: AGENT_KEY, body: { dates: { start: '2026-12-02', end: '2026-12-06' } } });
      assert.equal(set.status, 200, set.text);
      await server.stop({ keepData: true });

      const rebuilt = colmarConfig();
      rebuilt.phases[1].dates = { start: '2026-12-03', end: '2026-12-05' };
      server = await boot(rebuilt, PORTS.tripStopsGolden, { dataDir });
      const bob = await server.login('bob');
      const served = await server.call('/api/config', { token: bob });
      assert.deepEqual(served.body.phases.find(p => p.id === 'colmar').dates, { start: '2026-12-02', end: '2026-12-06' });
      assert.ok(!served.text.includes('conflict'), 'a member is not told about the conflict');
      const stops = await server.call('/api/stops', { apiKey: AGENT_KEY });
      const colmar = stops.body.stops.find(s => s.id === 'colmar');
      assert.deepEqual(colmar.conflict.fields, ['dates']);
      assert.deepEqual(colmar.conflict.base.dates, { start: '2026-12-03', end: '2026-12-05' });
      await server.stop({ keepData: true });

      // A rebuild that drops the edited stop: the override is not served, and
      // that is loud — the id in the log, a count (no id) for members.
      const withoutColmar = colmarConfig();
      withoutColmar.phases = withoutColmar.phases.filter(p => p.id !== 'colmar');
      server = await boot(withoutColmar, PORTS.tripStopsGolden, { dataDir });
      assert.match(server.log(), /stop overrides: 1 refer to a stop trip\.config\.json no longer has — not served: colmar/);
      const member = await server.login('bob');
      const warnings = await server.call('/api/config/warnings', { token: member });
      assert.ok(warnings.body.some(w => w.scope === 'stops'), warnings.text);
      assert.ok(!warnings.text.includes('colmar'), 'a stop id is authored text: count only for members');
      assert.deepEqual((await server.call('/api/stops', { apiKey: AGENT_KEY })).body.orphaned_overrides, ['colmar']);
    } finally { await server.stop(); }
  });
});
