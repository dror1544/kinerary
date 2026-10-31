// Guarantee A (docs/reliability-guarantees.md), scenarios A1/A2/A4, issue #382:
// a re-provision rewrites bookings.json and trip.config.json in the trip dir and
// restarts the server on the SAME data dir. What the files now say must reach
// the tabs; what a person edited on the site must survive, flagged; what the
// file dropped must be retired, not deleted.
//
// Real server, restarted on the same DATA_DIR (the plan-single-source harness).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { freePort } from './helpers/port-guard.js';
import { MCP_API_KEY, TRIP_API_KEY, startTestMcp, stopTestMcp, mcpCallTool } from './helpers/mcp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server', 'server.js');
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const AGENT_KEY = 'test-hermes-key';
const PHASE = 'ny';
const DAY = '2027-03-11';

const flight = (date, over = {}) => ({
  phase: 'intl_flights', type: 'flight', name: 'LY008 TLV-JFK', date_from: date, date_to: date,
  passengers: 'Alice, Bob', confirmation: 'ABC123', pin: null, notes: null, cost: 2000, conf_file: null,
  location_url: null, seed_key: `flight_${date}`, ...over,
});
const hotel = (dateTo, over = {}) => ({
  phase: PHASE, type: 'hotel', name: 'Hotel Meridian NYC', date_from: '2027-03-11', date_to: dateTo,
  passengers: null, confirmation: 'TEST-001', pin: '9999', notes: null, cost: 1000, conf_file: null,
  location_url: null, seed_key: 'hotel_ny', ...over,
});
const car = (over = {}) => ({
  phase: 'colorado', type: 'car', name: 'Budget SUV', date_from: '2027-03-17', date_to: '2027-03-23',
  passengers: null, confirmation: 'CAR-1', pin: null, notes: null, cost: 500, conf_file: null,
  location_url: null, seed_key: 'car_co', ...over,
});

function boot(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_JS], {
      cwd: join(HERE, '..', 'server'),
      env: { ...process.env, PORT: String(port), JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
             HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234', HERMES_URL: '', ...env },
    });
    proc.log = '';
    let ready = false;
    proc.stdout.on('data', c => {
      proc.log += c;
      if (!ready && c.toString().includes('Trip server running on')) { ready = true; resolve(proc); }
    });
    proc.on('error', reject);
    proc.on('exit', code => { if (!ready) reject(new Error(`server exited with ${code} before ready\n${proc.log}`)); });
    setTimeout(() => { if (!ready) reject(new Error('boot timeout')); }, 10_000);
  });
}
const stop = (proc) => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });

describe('a re-provision reaches the tabs (#382)', () => {
  let port, dataDir, tripDir, proc;
  const env = (extra = {}) => ({ TRIP_DIR: tripDir, DATA_DIR: dataDir, SEED_RECONCILE: '1', ...extra });
  const writeBookings = (rows) => writeFileSync(join(tripDir, 'bookings.json'), JSON.stringify(rows, null, 2));
  const readConfig = () => JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
  const writeConfig = (cfg) => writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));

  let alice, bob;
  const call = async (path, { method = 'GET', body, token, key } = {}) => {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text };
  };
  const login = async (username) => {
    for (let i = 0; i < 50; i++) {
      const r = await call('/api/auth/login', { method: 'POST', body: { username, password: '1234' } });
      if (r.status === 200) return r.body.token;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`login ${username} never succeeded`);
  };
  // (Re)start on the same DATA_DIR and sign in again; wait for the seed, which on a brand-new DB
  // runs after the users are hashed.
  async function restart(extra = {}) {
    if (proc) await stop(proc);
    proc = await boot(port, env(extra));
    alice = await login('alice'); bob = await login('bob');
    for (let i = 0; i < 50 && !/Bookings (seeded|reconciled)/.test(proc.log); i++) await new Promise(r => setTimeout(r, 100));
    return proc;
  }
  const bookings = async (token = alice) => (await call('/api/bookings', { token })).body;
  const planOf = async (token = alice) => (await call(`/api/phases/${PHASE}/plan`, { token })).body;
  const active = async (token = alice) => (await call('/api/itinerary/active', { token })).body;
  const revisions = async () => (await call('/api/itinerary/revisions', { token: alice })).body;
  const db = (fn) => { const d = new Database(join(dataDir, 'trip.db')); try { return fn(d); } finally { d.close(); } };
  const byKey = (rows, key) => rows.filter(b => b.seed_key === key);

  before(async () => {
    port = await freePort();
    dataDir = mkdtempSync(join(tmpdir(), 'reprov-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'reprov-trip-'));
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  });
  after(async () => {
    if (proc) await stop(proc);
    for (const d of [dataDir, tripDir]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  test('a corrected flight date replaces the old row on the next boot', async () => {
    writeBookings([flight('2027-03-10'), hotel('2027-03-14'), car()]);
    const cfg = readConfig();
    cfg.bookings.flights[0].date = '2027-03-10';
    writeConfig(cfg);
    await restart();
    assert.equal(byKey(await bookings(), 'flight_2027-03-10').length, 1, 'seeded');

    // The re-provision: the flight moves a day, so its anchor key changes; the config says the same.
    writeBookings([flight('2027-03-11'), hotel('2027-03-14'), car()]);
    cfg.bookings.flights[0].date = '2027-03-11';
    writeConfig(cfg);
    await restart();

    const flights = (await bookings()).filter(b => b.type === 'flight');
    assert.deepEqual(flights.map(b => b.date_from), ['2027-03-11'], 'one flight, on the corrected date');
    // /api/config, mcp get_config and the bookings tab agree.
    const served = (await call('/api/config', { token: alice })).body;
    assert.deepEqual(served.bookings.flights.map(f => f.date), ['2027-03-11']);
    db(d => {
      const old = d.prepare("SELECT retired_at FROM bookings WHERE seed_key = 'flight_2027-03-10'").get();
      assert.ok(old.retired_at, 'the old row is retired, not deleted');
    });
  });

  test('get_config on the trip MCP shows only the corrected value, next to the bookings tab', async () => {
    await startTestMcp({ MCP_PORT: String(await freePort()), API_BASE_URL: `http://127.0.0.1:${port}`, TRIP_API_KEY: AGENT_KEY });
    try {
      const cfgResult = await mcpCallTool('get_config', {});
      const cfg = JSON.parse(cfgResult.content[0].text);
      assert.deepEqual(cfg.bookings.flights.map(f => f.date), ['2027-03-11']);
      const bk = JSON.parse((await mcpCallTool('get_bookings', { type: 'flight' })).content[0].text);
      assert.deepEqual(bk.map(b => b.date_from), ['2027-03-11']);
      assert.ok(!bk.some(b => b.date_from === '2027-03-10'));
    } finally { stopTestMcp(); }
  });

  test('an unedited hotel takes the corrected dates; a linked stop is flagged out of sync, not moved', async () => {
    const hotelRow = (await bookings()).find(b => b.seed_key === 'hotel_ny');
    const link = await call(`/api/stops/${PHASE}/from-booking`, { method: 'POST', token: alice, body: { booking_id: hotelRow.id } });
    assert.equal(link.status, 200, link.text);
    const stop = async () => (await call('/api/stops', { token: alice })).body.stops.find(s => s.id === PHASE);
    assert.equal((await stop()).booking_out_of_sync, false);
    const datesBefore = (await call('/api/config', { token: alice })).body.phases.find(p => p.id === PHASE).dates;

    writeBookings([flight('2027-03-11'), hotel('2027-03-13'), car()]);
    await restart();

    const after = (await bookings()).find(b => b.seed_key === 'hotel_ny');
    assert.equal(after.id, hotelRow.id, 'the same row');
    assert.equal(after.date_to, '2027-03-13');
    assert.equal((await stop()).booking_out_of_sync, true, 'the stop says it is out of sync');
    const datesAfter = (await call('/api/config', { token: alice })).body.phases.find(p => p.id === PHASE).dates;
    assert.deepEqual(datesAfter, datesBefore, 'the stop is never moved at boot');
  });

  test('an unchanged file changes nothing: no row, no revision, no flag', async () => {
    const snapshot = async () => ({
      bookings: JSON.stringify(await bookings()),
      plan: JSON.stringify(await planOf()),
      revisions: (await revisions()).length,
      activeRevision: (await active()).revision,
    });
    const before = await snapshot();
    await restart();
    const after = await snapshot();
    assert.deepEqual(after, before);
    assert.ok(!/"seed_(changed|removed)"/.test(after.bookings + after.plan));
  });

  test('a site edit survives a changed file and is flagged; use the new one applies it', async () => {
    const car0 = byKey(await bookings(), 'car_co')[0];
    const patched = await call(`/api/bookings/${car0.id}`, { method: 'PATCH', token: alice, body: { name: 'Budget SUV (my edit)', pin: '1111' } });
    assert.equal(patched.status, 200);

    // The file changes the same field, and another one.
    writeBookings([flight('2027-03-11'), hotel('2027-03-13'), car({ name: 'Budget Minivan', cost: 650, pin: '2222' })]);
    await restart();
    const car1 = byKey(await bookings(), 'car_co')[0];
    assert.equal(car1.name, 'Budget SUV (my edit)', 'the edit stands');
    assert.equal(car1.cost, 500, 'and so does every other field of an edited row');
    assert.deepEqual(Object.keys(car1.seed_changed).sort(), ['cost', 'name', 'pin']);
    assert.equal(car1.seed_changed.name, 'Budget Minivan');
    assert.equal(car1.seed_changed.cost, 650);
    assert.ok(!JSON.stringify(car1.seed_changed).includes('2222'), 'the flag never carries a PIN');
    assert.ok(!('seed_pending' in car1) && !('seed_hash' in car1), 'internals are not served');

    // Another restart with the same file: still flagged, still not applied.
    await restart();
    assert.ok(byKey(await bookings(), 'car_co')[0].seed_changed);

    // Choosing "use the new one" applies it.
    const accepted = await call(`/api/bookings/${car1.id}/accept-seed`, { method: 'POST', token: alice });
    assert.equal(accepted.status, 200, accepted.text);
    const car2 = byKey(await bookings(), 'car_co')[0];
    assert.equal(car2.name, 'Budget Minivan');
    assert.equal(car2.cost, 650);
    assert.ok(!car2.seed_changed, 'the flag is gone');
    await restart();
    assert.ok(!byKey(await bookings(), 'car_co')[0].seed_changed, 'and does not come back');
    assert.equal((await call(`/api/bookings/${car1.id}/accept-seed`, { method: 'POST', token: alice })).status, 409, 'nothing pending');
  });

  test('keep mine silences the flag for that file version and no longer', async () => {
    const car0 = byKey(await bookings(), 'car_co')[0];
    await call(`/api/bookings/${car0.id}`, { method: 'PATCH', token: alice, body: { name: 'Mine again' } });
    writeBookings([flight('2027-03-11'), hotel('2027-03-13'), car({ name: 'Budget Van v2', cost: 650, pin: '2222' })]);
    await restart();
    assert.ok(byKey(await bookings(), 'car_co')[0].seed_changed);
    assert.equal((await call(`/api/bookings/${car0.id}/keep-seed`, { method: 'POST', token: alice })).status, 200);
    assert.ok(!byKey(await bookings(), 'car_co')[0].seed_changed);
    await restart();
    const kept = byKey(await bookings(), 'car_co')[0];
    assert.ok(!kept.seed_changed, 'the same file does not re-flag');
    assert.equal(kept.name, 'Mine again');
    // A further correction in the file is a new question.
    writeBookings([flight('2027-03-11'), hotel('2027-03-13'), car({ name: 'Budget Van v3', cost: 650, pin: '2222' })]);
    await restart();
    assert.equal(byKey(await bookings(), 'car_co')[0].seed_changed.name, 'Budget Van v3');
  });

  test('a row gone from the file is retired, not deleted; an edited one is kept and flagged', async () => {
    // car_co was edited above, flight and hotel were not. Drop the flight and the car.
    writeBookings([hotel('2027-03-13')]);
    await restart();
    const rows = await bookings();
    assert.ok(!rows.some(b => b.type === 'flight'), 'the unedited flight is hidden from the tab');
    assert.equal(byKey(rows, 'car_co')[0].seed_removed, true, 'the edited car stays, flagged');
    db(d => {
      const f = d.prepare("SELECT retired_at FROM bookings WHERE seed_key = 'flight_2027-03-11'").get();
      assert.ok(f && f.retired_at, 'still in the table, with retired_at set');
    });
    // Members: not in /api/bookings either way for the retired one; never the flag.
    assert.ok(!(await bookings(bob)).some(b => b.type === 'flight'));
    // The organizer accepts the removal of the edited one.
    const car = byKey(rows, 'car_co')[0];
    assert.equal((await call(`/api/bookings/${car.id}/accept-seed`, { method: 'POST', token: alice })).status, 200);
    assert.ok(!(await bookings()).some(b => b.seed_key === 'car_co'));
  });

  test('a file that lists no bookings does not retire the whole trip', async () => {
    writeBookings([]);
    await restart();
    assert.ok((await bookings()).some(b => b.seed_key === 'hotel_ny'), 'a truncated file is refused, loudly');
    assert.match(proc.log, /REFUSED=bookings\.json lists no bookings/, 'and it says so in the log');
    writeBookings([hotel('2027-03-13')]);
    await restart();
  });

  test('an unedited plan item takes the corrected time in one revision', async () => {
    const before = await active();
    const revsBefore = (await revisions()).length;
    const cfg = readConfig();
    const items = cfg.phases.find(p => p.id === PHASE).days[0].items;
    assert.equal(items[0].time, '09:00');
    items[0].time = '09:30';
    writeConfig(cfg);
    await restart();

    const plan = await planOf();
    const breakfast = plan.find(r => r.text_en === 'Breakfast');
    assert.equal(breakfast.time, '09:30');
    assert.equal(breakfast.time_sort, 9 * 60 + 30);
    const modern = (await active()).items.find(i => i.phase_id === PHASE && i.text_en === 'Breakfast');
    assert.equal(modern.time, '09:30');
    assert.notEqual((await active()).revision, before.revision);
    assert.equal((await revisions()).length, revsBefore + 1, 'one new revision for the whole reconcile');
    assert.ok(!breakfast.seed_changed, 'taken, so nothing to flag');
    // Idempotent afterwards.
    const rev = (await active()).revision;
    await restart();
    assert.equal((await active()).revision, rev);
  });

  test('an edited plan item keeps its edit and is flagged', async () => {
    const plan = await planOf();
    const lunchSource = plan.find(r => r.text_en === 'Breakfast');
    const edited = await call(`/api/phases/${PHASE}/plan/${lunchSource.id}`, { method: 'PATCH', token: alice, body: { time: '10:15' } });
    assert.equal(edited.status, 200, edited.text);
    const cfg = readConfig();
    cfg.phases.find(p => p.id === PHASE).days[0].items[0].time = '08:00';
    writeConfig(cfg);
    await restart();
    const row = (await planOf()).find(r => r.text_en === 'Breakfast');
    assert.equal(row.time, '10:15', 'the edit stands');
    assert.deepEqual(row.seed_changed, { time: '08:00' });
    assert.equal((await planOf(bob)).find(r => r.text_en === 'Breakfast').seed_changed, undefined);
    // Organizer view of the modern itinerary carries it too.
    const modern = (await active()).items.find(i => i.text_en === 'Breakfast');
    assert.deepEqual(modern.seed_changed, { time: '08:00' });
    assert.equal((await active(bob)).items.find(i => i.text_en === 'Breakfast').seed_changed, undefined);

    assert.equal((await call(`/api/phases/${PHASE}/plan/${row.id}/accept-seed`, { method: 'POST', token: alice })).status, 200);
    const taken = (await planOf()).find(r => r.text_en === 'Breakfast');
    assert.equal(taken.time, '08:00');
    assert.equal(taken.time_sort, 480);
    assert.equal(taken.seed_changed, undefined);
    assert.equal((await active()).items.find(i => i.text_en === 'Breakfast').time, '08:00');
  });

  test('the Modern UI answers a plan flag by item_uid; a dropped config item is flagged, never removed', async () => {
    // Edited again, file moves again: answer through the itinerary's own address.
    const breakfast = (await planOf()).find(r => r.text_en === 'Breakfast');
    await call(`/api/phases/${PHASE}/plan/${breakfast.id}`, { method: 'PATCH', token: alice, body: { time: '10:30' } });
    const cfg = readConfig();
    const items = cfg.phases.find(p => p.id === PHASE).days[0].items;
    items[0].time = '07:30';
    const dropped = items.splice(2, 1)[0];          // "Early departure" is gone from the file
    assert.match(dropped.text.en, /Early departure/);
    writeConfig(cfg);
    await restart();
    const uid = (await active()).items.find(i => i.text_en === 'Breakfast').item_uid;
    assert.deepEqual((await active()).items.find(i => i.item_uid === uid).seed_changed, { time: '07:30' });
    const gone = (await planOf()).find(r => /Early departure/.test(r.text_en || ''));
    assert.ok(gone, 'the item stays in the plan');
    assert.equal(gone.seed_removed, true, 'flagged for the organizer');
    assert.equal((await planOf(bob)).find(r => /Early departure/.test(r.text_en || '')).seed_removed, undefined);
    assert.equal((await call(`/api/phases/${PHASE}/plan/${gone.id}/accept-seed`, { method: 'POST', token: alice })).status, 409, 'there is no new value to use');

    assert.equal((await call(`/api/itinerary/items/${encodeURIComponent(uid)}/accept-seed`, { method: 'POST', token: bob })).status, 403);
    assert.equal((await call(`/api/itinerary/items/${encodeURIComponent(uid)}/accept-seed`, { method: 'POST', token: alice })).status, 200);
    assert.equal((await planOf()).find(r => r.text_en === 'Breakfast').time, '07:30');
    assert.equal((await active()).items.find(i => i.item_uid === uid).time, '07:30');
    const goneUid = (await active()).items.find(i => /Early departure/.test(i.text_en || '')).item_uid;
    assert.equal((await call(`/api/itinerary/items/${encodeURIComponent(goneUid)}/keep-seed`, { method: 'POST', token: alice })).status, 200);
    await restart();
    assert.equal((await planOf()).find(r => /Early departure/.test(r.text_en || '')).seed_removed, undefined, 'kept, and quiet from then on');
  });

  test('a site-written config (export) is not mistaken for a re-provision', async () => {
    const exported = await call('/api/phase-plan/export-to-config', { method: 'POST', token: alice });
    assert.equal(exported.status, 200, exported.text);
    const before = JSON.stringify(await planOf());
    const rev = (await active()).revision;
    await restart();
    assert.equal(JSON.stringify(await planOf()), before, 'export folds link icons into the file text; the plan must not take that back');
    assert.equal((await active()).revision, rev);
  });

  test('members never see the seed flags, and cannot act on them', async () => {
    const car0 = (await bookings()).find(b => b.seed_key === 'hotel_ny');
    await call(`/api/bookings/${car0.id}`, { method: 'PATCH', token: alice, body: { notes: 'mine' } });
    writeBookings([hotel('2027-03-12', { notes: 'theirs' })]);
    await restart();
    const asOrganizer = (await bookings()).find(b => b.seed_key === 'hotel_ny');
    assert.ok(asOrganizer.seed_changed, 'the organizer sees it');
    assert.equal(asOrganizer.seed_changed.notes, '[changed]', 'but never the notes themselves');
    const asMember = await call('/api/bookings', { token: bob });
    assert.equal(asMember.status, 200);
    for (const key of ['seed_changed', 'seed_removed', 'seed_pending', 'seed_hash', 'seed_ack', 'retired_at']) {
      assert.ok(!asMember.text.includes(`"${key}"`), `member response carries ${key}`);
    }
    for (const r of [await call(`/api/phases/${PHASE}/plan`, { token: bob }), await call('/api/itinerary/active', { token: bob })]) {
      for (const key of ['seed_changed', 'seed_removed', 'config_hash', 'seed_pending', 'seed_ack']) assert.ok(!r.text.includes(`"${key}"`), key);
    }
    assert.equal((await call(`/api/bookings/${car0.id}/accept-seed`, { method: 'POST', token: bob })).status, 403);
    assert.equal((await call(`/api/bookings/${car0.id}/keep-seed`, { method: 'POST', token: bob })).status, 403);
    assert.equal((await call(`/api/bookings/${car0.id}/accept-seed`, { method: 'POST' })).status, 401);
    const asAgent = await call('/api/bookings', { key: AGENT_KEY });
    assert.ok(asAgent.body.find(b => b.seed_key === 'hotel_ny').seed_changed, 'the agent is organizer-scoped');
  });

  test('a stop whose linked hotel was retired is reported out of sync with a reason, and is not moved', async () => {
    const hotelRow = (await bookings()).find(b => b.seed_key === 'hotel_ny');
    const stop = async (token = alice) => (await call('/api/stops', { token })).body.stops.find(s => s.id === PHASE);
    // In sync to begin with: re-link the stop to the hotel as it is now.
    assert.equal((await call(`/api/stops/${PHASE}/from-booking`, { method: 'POST', token: alice, body: { booking_id: hotelRow.id } })).status, 200);
    const before = await stop();
    assert.equal(before.booking_out_of_sync, false);
    assert.equal(before.booking_out_of_sync_reason, undefined);
    const phaseBefore = (await call('/api/config', { token: alice })).body.phases.find(p => p.id === PHASE);

    // The re-provision books a different hotel; the linked one is no longer in the file and is retired
    // (it was edited on the site, so the organizer answers "use the new one").
    writeBookings([hotel('2027-03-13', { seed_key: 'hotel_ny_other', name: 'Hotel Other', confirmation: 'OTHER-1' })]);
    await restart();
    assert.equal((await call(`/api/bookings/${hotelRow.id}/accept-seed`, { method: 'POST', token: alice })).status, 200);
    assert.ok(!(await bookings()).some(b => b.id === hotelRow.id), 'the old hotel is off the bookings tab');

    const after = await stop();
    assert.equal(after.booking_out_of_sync, true, 'the organizer is asked');
    assert.equal(after.booking_out_of_sync_reason, 'booking_retired');
    assert.equal(after.override.booking_id, hotelRow.id, 'the stop is not rewritten');
    const phaseAfter = (await call('/api/config', { token: alice })).body.phases.find(p => p.id === PHASE);
    assert.deepEqual(phaseAfter.dates, phaseBefore.dates, 'nothing moved at boot or on accept');

    // A member never receives the stop layer's bookkeeping.
    const asMember = await call('/api/stops', { token: bob });
    assert.ok(!/booking_retired|booking_out_of_sync/.test(asMember.text), asMember.text.slice(0, 200));
    assert.ok(!(await call('/api/config', { token: bob })).text.includes('booking_retired'));
  });
});

describe('the rollout is gated per trip, and can be rehearsed on a copy (#382)', () => {
  let dataDir, tripDir, port;
  before(async () => {
    port = await freePort();
    dataDir = mkdtempSync(join(tmpdir(), 'reprov-gate-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'reprov-gate-trip-'));
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  });
  after(() => { for (const d of [dataDir, tripDir]) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
  const writeBookings = (rows) => writeFileSync(join(tripDir, 'bookings.json'), JSON.stringify(rows));
  const dump = (dir) => {
    const d = new Database(join(dir, 'trip.db'));
    try {
      return JSON.stringify({
        b: d.prepare('SELECT * FROM bookings ORDER BY id').all(),
        p: d.prepare('SELECT * FROM phase_plan_items ORDER BY id').all(),
        v: d.prepare('SELECT revision_id FROM itinerary_plan_versions ORDER BY revision_id').all(),
      });
    } finally { d.close(); }
  };

  test('with the flag unset the old rows stay and the log says what would change; dry-run changes nothing and exits', async () => {
    // A trip seeded under the old code: rows with no seed_hash, a stale hotel, a row the file no longer has.
    writeBookings([hotel('2027-03-14'), car()]);
    let proc = await boot(port, { TRIP_DIR: tripDir, DATA_DIR: dataDir, SEED_RECONCILE: '1' });
    for (let i = 0; i < 50 && !/Bookings (seeded|reconciled)/.test(proc.log); i++) await new Promise(r => setTimeout(r, 100));
    await stop(proc);
    const d = new Database(join(dataDir, 'trip.db'));
    d.prepare('UPDATE bookings SET seed_hash = NULL').run();   // what a trip booted before #382 looks like
    d.close();

    writeBookings([hotel('2027-03-13')]);   // corrected hotel; the car is gone
    const frozen = dump(dataDir);

    // Unset: boots as before (nothing applied) and says so in the log.
    proc = await boot(port, { TRIP_DIR: tripDir, DATA_DIR: dataDir });
    for (let i = 0; i < 20 && !/seed reconcile/.test(proc.log); i++) await new Promise(r => setTimeout(r, 100));
    const offLog = proc.log;
    await stop(proc);
    assert.match(offLog, /seed reconcile: OFF/);
    assert.match(offLog, /SEED_RECONCILE=1/);
    assert.equal(dump(dataDir), frozen, 'off means off: not one row differs');

    // Dry-run, on a COPY of the data dir: one JSON report, exit 0, no listener, rows identical.
    const copy = mkdtempSync(join(tmpdir(), 'reprov-copy-'));
    try {
      cpSync(dataDir, copy, { recursive: true });
      const before = dump(copy);
      const run = spawnSync('node', [SERVER_JS], {
        cwd: join(HERE, '..', 'server'), encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, PORT: String(port), TRIP_DIR: tripDir, DATA_DIR: copy, SEED_RECONCILE: 'dry-run',
               JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234', HERMES_URL: '' },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stdout, /Trip server running on/, 'a dry run never starts listening');
      const line = run.stdout.split('\n').find(l => l.startsWith('SEED_RECONCILE_REPORT '));
      assert.ok(line, run.stdout);
      const report = JSON.parse(line.slice('SEED_RECONCILE_REPORT '.length));
      // Legacy rows carry no hash, so a differing one is flagged, never overwritten; the missing car is flagged too.
      assert.deepEqual(report.bookings.flag.map(f => [f.seed_key, f.fields]), [['hotel_ny', ['date_to']]]);
      assert.deepEqual(report.bookings.flag_removed, ['car_co']);
      assert.deepEqual(report.bookings.update, []);
      assert.ok(!line.includes('Hotel Meridian'), 'the report carries keys and field names, never values');
      assert.equal(dump(copy), before, 'a dry run writes no booking, plan item or revision');
    } finally { rmSync(copy, { recursive: true, force: true }); }

    // On: the legacy rows are flagged, not overwritten (the data cannot prove they were never edited).
    proc = await boot(port, { TRIP_DIR: tripDir, DATA_DIR: dataDir, SEED_RECONCILE: '1' });
    for (let i = 0; i < 50 && !/Bookings reconciled/.test(proc.log); i++) await new Promise(r => setTimeout(r, 100));
    try {
      const login = await fetch(`http://localhost:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: '1234' }) });
      const { token } = await login.json();
      const rows = await (await fetch(`http://localhost:${port}/api/bookings`, { headers: { Authorization: `Bearer ${token}` } })).json();
      const h = rows.find(b => b.seed_key === 'hotel_ny');
      assert.equal(h.date_to, '2027-03-14');
      assert.deepEqual(h.seed_changed, { date_to: '2027-03-13' });
      assert.equal(rows.find(b => b.seed_key === 'car_co').seed_removed, true);
    } finally { await stop(proc); }
  });
});
