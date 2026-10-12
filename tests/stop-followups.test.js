/**
 * stop-followups.test.js — the second boundary review of stop editing
 * (2026-10-11), two follow-ups to the hardening in tests/stop-hardening.test.js.
 *
 * (A) SPLIT, THEN LINK. The hardening made from-booking refuse a booking filed
 *     under another stop (finding 3), for a good reason: linking it would move
 *     that stop's check-in and check-out. But an organizer naturally files the
 *     airport hotel under the stop being split ("the last night near the
 *     airport" is still Colmar when the booking is added), so split_stop with
 *     booking_id was refused every time. Now a booking filed under the stop the
 *     new stop was SPLIT FROM links, and is re-filed under the new stop; one
 *     filed under an unrelated stop, or already linked to another stop, is still
 *     refused — and the parent's own check-in/check-out items are not touched.
 *
 * (B) A QUOTE IS TEXT (owner decision, 2026-10-11). The write used to refuse
 *     `"` (defence in depth: it is what it takes to leave an attribute), which
 *     also refused ordinary Hebrew typed with an ASCII quote: ארה"ב, ת"א, בע"מ,
 *     and `55" TV`. A follow-up rewrote such a `"` to ״ in the clients; the
 *     owner rejected both — text is stored exactly as typed. `<`, `>` and
 *     control characters are still refused, and links still refuse quotes.
 *     That a stored `"` cannot leave an attribute is the renderers' job, and
 *     tests/stop-xss-render.test.js proves it sink by sink.
 *
 * Unit tests on createTripStructure (no HTTP), then the same flow over HTTP on
 * a real trip server.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { createTripStructure } = require('../server/trip-structure.js');

const clone = (v) => JSON.parse(JSON.stringify(v));

function colmarConfig() {
  return {
    meta: { title: 'Alsace 2026', departure: '2026-12-02', returnDate: '2026-12-07' },
    phases: [
      { id: 'frankfurt', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT' },
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR', dates: { start: '2026-12-02', end: '2026-12-07' } },
      { id: 'frankfurt2', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT' },
    ],
  };
}

function fakeJourney(rows = { days: [], items: [] }) {
  return {
    rows,
    changes: 0,
    activeRows() { return clone(this.rows); },
    activeRevision() { return `rev-${this.changes}`; },
    applyChange(_author, _note, transform) {
      const next = clone(this.rows);
      transform(next);
      this.rows = next;
      this.changes++;
      return `rev-${this.changes}`;
    },
    dayContext() { return { lodging_context: null, pickup_context: null }; },
  };
}

function make(journey = fakeJourney()) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT, type TEXT, name TEXT, date_from TEXT,
      date_to TEXT, confirmation TEXT, pin TEXT, notes TEXT, location_url TEXT, review_status TEXT DEFAULT 'approved');
    CREATE TABLE budget_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT);
    CREATE TABLE photos (id TEXT PRIMARY KEY, phase TEXT);
  `);
  const base = colmarConfig();
  const structure = createTripStructure({ db, baseConfig: () => base, journey: () => journey, queuePhaseReview: () => {} });
  const booking = (row) => {
    const full = { phase: 'colmar', type: 'hotel', name: 'Hotel Colmar Centre', date_from: '2026-12-02', date_to: '2026-12-07', ...row };
    const cols = Object.keys(full);
    return Number(db.prepare(`INSERT INTO bookings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(full)).lastInsertRowid);
  };
  const bookingPhase = (id) => db.prepare('SELECT phase FROM bookings WHERE id = ?').get(id).phase;
  const linkedTo = (id) => db.prepare('SELECT phase_id FROM trip_stop_overrides WHERE booking_id = ? ORDER BY rowid').all(id).map(r => r.phase_id);
  const item = (uid) => journey.rows.items.find(i => i.item_uid === uid) || null;
  return { db, structure, journey, booking, bookingPhase, linkedTo, item };
}

const AIRPORT = { title: { he: 'ליד שדה התעופה', en: 'Near the airport' } };
const splitColmar = (structure, at = '2026-12-06', newStop = AIRPORT) => {
  const r = structure.ops.split('colmar', { at, new_stop: newStop }, 'alice');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.stops[1].id;
};

// ── (A) split, then link ────────────────────────────────────────────────────
describe('(A) a booking filed under the stop a new stop was split from links to the new stop', () => {
  test('the airport hotel, filed under Colmar, links to "near the airport" after the split — and is re-filed there', () => {
    const { structure, booking, bookingPhase, linkedTo, item, db } = make();
    const airport = booking({ name: 'Airport Hotel', date_from: '2026-12-06', date_to: '2026-12-07' });
    const newId = splitColmar(structure);
    assert.equal(newId, 'near-the-airport');

    const r = structure.ops.fromBooking(newId, { booking_id: airport }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stop.accommodation.name, 'Airport Hotel');
    assert.deepEqual(r.body.stop.dates, { start: '2026-12-06', end: '2026-12-07' });
    assert.equal(bookingPhase(airport), newId, 'the booking now belongs to the stop it shapes');
    assert.deepEqual(linkedTo(airport), [newId]);
    assert.equal(item(`booking_${airport}_checkin`).phase_id, newId);
    assert.equal(item(`booking_${airport}_checkout`).phase_id, newId);
    // The re-filing is said where every stop change is said: the history.
    const last = structure.historyOf(newId).at(-1);
    assert.equal(last.action, 'from_booking');
    assert.match(last.note, /re-filed from colmar/);
    // Colmar itself is untouched by the link: its dates are the split's.
    assert.deepEqual(structure.effectiveConfig().phases.find(p => p.id === 'colmar').dates, { start: '2026-12-02', end: '2026-12-06' });
    assert.equal(db.prepare("SELECT booking_id FROM trip_stop_overrides WHERE phase_id = 'colmar'").get().booking_id, null);
  });

  test('re-running it is idempotent: the booking is now the new stop\'s own', () => {
    const { structure, booking, bookingPhase, journey } = make();
    const airport = booking({ name: 'Airport Hotel', date_from: '2026-12-06', date_to: '2026-12-07' });
    const newId = splitColmar(structure);
    assert.equal(structure.ops.fromBooking(newId, { booking_id: airport }, 'alice').status, 200);
    const again = structure.ops.fromBooking(newId, { booking_id: airport }, 'alice');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(bookingPhase(airport), newId);
    assert.equal(journey.rows.items.filter(i => i.booking_id === airport).length, 2, 'no duplicate check-in/out');
    // …and it no longer links back to Colmar: Colmar was not split from it.
    const back = structure.ops.fromBooking('colmar', { booking_id: airport }, 'alice');
    assert.equal(back.status, 409, JSON.stringify(back.body));
    assert.equal(back.body.error, 'booking_belongs_to_another_stop');
  });

  test('a booking filed under an UNRELATED stop is still refused (409 booking_belongs_to_another_stop), nothing written', () => {
    const { structure, booking, bookingPhase, journey } = make();
    const frankfurtHotel = booking({ phase: 'frankfurt', name: 'Frankfurt Hotel', date_from: '2026-12-06', date_to: '2026-12-07' });
    const newId = splitColmar(structure);
    const history = structure.historyOf(newId).length;
    const changes = journey.changes;
    const r = structure.ops.fromBooking(newId, { booking_id: frankfurtHotel }, 'alice');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'booking_belongs_to_another_stop');
    assert.equal(r.body.stop, 'frankfurt');
    assert.equal(bookingPhase(frankfurtHotel), 'frankfurt', 'not re-filed');
    assert.equal(structure.historyOf(newId).length, history);
    assert.equal(journey.changes, changes);
  });

  test('a parent-filed booking ALREADY LINKED to the parent is still refused (409 booking_linked_to_another_stop)', () => {
    const { structure, booking, bookingPhase, linkedTo, item } = make();
    const colmarHotel = booking({});
    assert.equal(structure.ops.fromBooking('colmar', { booking_id: colmarHotel }, 'alice').status, 200);
    const newId = splitColmar(structure);
    const checkin = clone(item(`booking_${colmarHotel}_checkin`));
    const r = structure.ops.fromBooking(newId, { booking_id: colmarHotel }, 'alice');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'booking_linked_to_another_stop');
    assert.equal(r.body.stop, 'colmar');
    assert.equal(bookingPhase(colmarHotel), 'colmar', 'not re-filed');
    assert.deepEqual(linkedTo(colmarHotel), ['colmar']);
    assert.deepEqual(item(`booking_${colmarHotel}_checkin`), checkin);
  });

  test('the parent\'s own hotel and its check-in/check-out items are not touched by linking the airport hotel', () => {
    const { structure, booking, bookingPhase, linkedTo, item, db } = make();
    const colmarHotel = booking({});
    assert.equal(structure.ops.fromBooking('colmar', { booking_id: colmarHotel }, 'alice').status, 200);
    const airport = booking({ name: 'Airport Hotel', date_from: '2026-12-06', date_to: '2026-12-07' });
    const newId = splitColmar(structure);
    const before = {
      checkin: clone(item(`booking_${colmarHotel}_checkin`)),
      checkout: clone(item(`booking_${colmarHotel}_checkout`)),
      colmar: clone(db.prepare("SELECT booking_id, fields FROM trip_stop_overrides WHERE phase_id = 'colmar'").get()),
      outOfSync: structure.listStops().stops.find(s => s.id === 'colmar').booking_out_of_sync,
    };
    assert.equal(before.checkin.phase_id, 'colmar', 'Colmar\'s check-in stays with Colmar through the split');

    const r = structure.ops.fromBooking(newId, { booking_id: airport }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(item(`booking_${colmarHotel}_checkin`), before.checkin, 'the parent hotel\'s check-in is as it was');
    assert.deepEqual(item(`booking_${colmarHotel}_checkout`), before.checkout, 'the parent hotel\'s check-out is as it was');
    assert.deepEqual(db.prepare("SELECT booking_id, fields FROM trip_stop_overrides WHERE phase_id = 'colmar'").get(), before.colmar);
    assert.equal(bookingPhase(colmarHotel), 'colmar', 'only the linked booking is re-filed');
    assert.deepEqual(linkedTo(colmarHotel), ['colmar']);
    assert.equal(structure.listStops().stops.find(s => s.id === 'colmar').booking_out_of_sync, before.outOfSync);
    // The airport hotel's own items are on the new stop, none left on Colmar.
    assert.deepEqual([item(`booking_${airport}_checkin`), item(`booking_${airport}_checkout`)].map(i => i.phase_id), [newId, newId]);
  });

  test('items a parent-filed booking already had on the parent move with it, even with create_items false — none stranded', () => {
    // A former link of this booking to Colmar, since replaced, left its
    // check-in on Colmar. Re-filed under the new stop, it must not stay
    // behind on a stop whose dates no longer hold it.
    const journey = fakeJourney({ days: [{ phase_id: 'colmar', date: '2026-12-06', label_he: null, label_en: null }], items: [
      { item_uid: 'booking_1_checkin', phase_id: 'colmar', date: '2026-12-06', booking_id: 1, text_he: 'צ׳ק-אין', text_en: 'Check-in' },
    ] });
    const { structure, booking, bookingPhase, item } = make(journey);
    const airport = booking({ name: 'Airport Hotel', date_from: '2026-12-06', date_to: '2026-12-07' });
    assert.equal(airport, 1);
    const newId = splitColmar(structure);
    assert.equal(item('booking_1_checkin').phase_id, 'colmar', 'the split day itself stays with Colmar');
    const r = structure.ops.fromBooking(newId, { booking_id: airport, create_items: false }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(bookingPhase(airport), newId);
    assert.equal(item('booking_1_checkin').phase_id, newId, 'the booking\'s own item followed it');
    assert.equal(item('booking_1_checkout'), null, 'create_items false still creates nothing');
    assert.ok(journey.rows.days.some(d => d.phase_id === newId && d.date === '2026-12-06'), 'the day it sits on exists on the new stop');
  });

  test('only the stop it was split FROM: a booking filed under a grandparent is refused', () => {
    const { structure, booking, bookingPhase } = make();
    const late = booking({ name: 'Last Hotel', date_from: '2026-12-06', date_to: '2026-12-07' });
    const middle = splitColmar(structure, '2026-12-04', { title: 'Middle' });
    const r1 = structure.ops.split(middle, { at: '2026-12-06', new_stop: { title: 'Last night' } }, 'alice');
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    const last = r1.body.stops[1].id;
    const r = structure.ops.fromBooking(last, { booking_id: late }, 'alice');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'booking_belongs_to_another_stop');
    assert.equal(bookingPhase(late), 'colmar');
  });

  test('a refusal after the ownership check (dates outside the new stop\'s plan) re-files nothing', () => {
    const journey = fakeJourney({ days: [], items: [
      { item_uid: 'x', phase_id: 'colmar', date: '2026-12-07', text_he: 'טיסה', text_en: 'Fly home' },
    ] });
    const { structure, booking, bookingPhase } = make(journey);
    // A one-night booking whose range leaves the moved "Fly home" outside.
    const airport = booking({ name: 'Airport Hotel', date_from: '2026-12-05', date_to: '2026-12-06' });
    const newId = splitColmar(structure, '2026-12-05');
    const r = structure.ops.fromBooking(newId, { booking_id: airport }, 'alice');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'items_outside_stop');
    assert.equal(bookingPhase(airport), 'colmar', 'refused, so not re-filed');
  });
});

// ── (B) a " is stored as typed ──────────────────────────────────────────────
describe('(B) Hebrew typed with an ASCII " is stored exactly as typed — never refused, never rewritten', () => {
  for (const [name, body] of [
    ['ארה"ב in a title', { title: { he: 'ארה"ב', en: 'USA' } }],
    ['ת"א as a plain string title', { title: 'ת"א' }],
    ['two abbreviations and a Latin quote', { title: { he: 'טיסה לארה"ב דרך חו"ל', en: 'say "hi"' } }],
    ['a tab label', { tabLabel: 'ת"א' }],
    ['an accommodation name, address and confirmation', { accommodation: { name: { he: 'מלון ת"א', en: 'Hotel "TLV"' }, address: 'רח\' הרצל 1, ראשל"צ', confirmation: 'אב"ג-1' } }],
    ['a multi-line description and a note', { accommodation: { name: 'Hotel', description: { he: 'קרוב לבע"מ\n55" TV', en: '55" TV' }, note: 'חו"ל' } }],
    ['the reviewer\'s quote-only bypass (inert: the renderers escape it)', { title: { he: 'ת"א onmouseover=alert(1)', en: 'x" onmouseover="alert(1)' } }],
  ]) {
    test(`PATCH ${name} → 200, stored and served as typed`, () => {
      const { structure } = make();
      const r = structure.ops.update('colmar', body, 'alice');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const colmar = structure.effectiveConfig().phases.find(p => p.id === 'colmar');
      for (const [k, v] of Object.entries(body)) assert.deepEqual(colmar[k], v, k);
    });
  }

  test('split: a new stop titled ת"א, its hotel מלון ת"א, are stored as typed', () => {
    const { structure } = make();
    const newId = splitColmar(structure, '2026-12-05', { title: { he: 'ת"א', en: 'TLV' }, accommodation: { name: 'מלון ת"א' } });
    const created = structure.effectiveConfig().phases.find(p => p.id === newId);
    assert.deepEqual(created.title, { he: 'ת"א', en: 'TLV' });
    assert.equal(created.accommodation.name, 'מלון ת"א');
  });

  test('the rewriting helper is gone from the module', () => {
    assert.equal(require('../server/trip-structure.js').hebrewGershayim, undefined);
  });
});

describe('(B) every other protection is unchanged: < > and control characters are refused, quote or no quote', () => {
  for (const [name, body, field] of [
    ['an element with a Hebrew abbreviation in front', { title: { he: 'ת"א<img src=x onerror=alert(1)>', en: 'x' } }, 'title.he'],
    ['the classic attribute-then-element break', { tabLabel: '"><svg onload=alert(1)>' }, 'tabLabel'],
    ['a < in a title', { title: 'Colmar < Strasbourg' }, 'title'],
    ['a > in a hotel name', { accommodation: { name: 'מלון ת"א >' } }, 'accommodation.name'],
    ['a control character next to a quote', { title: { he: 'ארה"ב\u0000', en: 'USA' } }, 'title.he'],
    ['a newline in a one-line field', { tabLabel: 'ת"א\nx' }, 'tabLabel'],
  ]) {
    test(`PATCH ${name} → 400 invalid_text, with no gershayim hint`, () => {
      const { structure, db } = make();
      const r = structure.ops.update('colmar', body, 'alice');
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.deepEqual([r.body.error, r.body.field], ['invalid_text', field]);
      assert.equal(r.body.detail, 'text may not contain < > or control characters');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM trip_stop_overrides').get().n, 0);
    });
  }
  test('split: an element in a new stop title → 400 invalid_text', () => {
    const { structure } = make();
    const r = structure.ops.split('colmar', { at: '2026-12-05', new_stop: { title: { he: '"><svg onload=alert(1)>' } } }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_text', 'new_stop.title.he']);
  });
  test('a link still refuses a " — links are unchanged', () => {
    const { structure } = make();
    const r = structure.ops.update('colmar', { accommodation: { name: 'מלון ת"א', location_url: 'https://maps.example/ת"א' } }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_link', 'accommodation.location_url']);
  });
});

describe('(B) from-booking copies a booking\'s name and confirmation as typed', () => {
  test('a booking named מלון ת"א links, stored as מלון ת"א; its Hebrew confirmation likewise', () => {
    const { structure, booking, db } = make();
    const id = booking({ name: 'מלון ת"א', confirmation: 'אב"ג-778' });
    const r = structure.ops.fromBooking('colmar', { booking_id: id }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const acc = structure.effectiveConfig().phases.find(p => p.id === 'colmar').accommodation;
    assert.equal(acc.name, 'מלון ת"א');
    assert.equal(acc.confirmation, 'אב"ג-778');
    assert.equal(db.prepare('SELECT name FROM bookings WHERE id = ?').get(id).name, 'מלון ת"א');
  });

  for (const [name, row, field, want] of [
    ['55" TV', { name: 'Hotel 55" TV' }, 'name', 'Hotel 55" TV'],
    ['a Latin attribute break (inert: the renderers escape it)', { name: 'x" onmouseover="alert(1)' }, 'name', 'x" onmouseover="alert(1)'],
    ['a Latin confirmation with a quote', { confirmation: 'AB"12' }, 'confirmation', 'AB"12'],
  ]) {
    test(`${name} → 200, stored as typed`, () => {
      const { structure, booking } = make();
      const id = booking(row);
      const r = structure.ops.fromBooking('colmar', { booking_id: id }, 'alice');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(structure.effectiveConfig().phases.find(p => p.id === 'colmar').accommodation[field], want);
    });
  }

  for (const [name, row, field] of [
    ['an element after the abbreviation', { name: 'מלון ת"א<img src=x onerror=alert(1)>' }, 'accommodation.name'],
    ['a > in the confirmation', { confirmation: 'AB">12' }, 'accommodation.confirmation'],
    ['a control character', { name: 'מלון ת"א\u0007' }, 'accommodation.name'],
  ]) {
    test(`${name} → 400 invalid_text, source booking, nothing written`, () => {
      const { structure, booking, db } = make();
      const id = booking(row);
      const r = structure.ops.fromBooking('colmar', { booking_id: id }, 'alice');
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.deepEqual([r.body.error, r.body.field, r.body.source], ['invalid_text', field, 'booking']);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM trip_stop_overrides').get().n, 0);
    });
  }
});

// ── the same over HTTP, on a real trip server ───────────────────────────────
const AGENT_KEY = 'test-hermes-key';

function httpConfig() {
  return {
    meta: { title: 'Alsace 2026', brand: 'ALSACE', departure: '2026-12-02', returnDate: '2026-12-07', totalDays: 6, deploymentNonce: 'stop-followups', defaultLang: 'he' },
    participants: [
      { username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' },
      { username: 'bob', name: 'בוב', name_en: 'Bob', family: 'a', color: '#10B981' },
    ],
    phases: [
      { id: 'frankfurt', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT' },
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR', dates: { start: '2026-12-02', end: '2026-12-07' } },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

async function boot(port) {
  const dataDir = mkdtempSync(join(tmpdir(), 'stop-followups-'));
  const tripDir = join(dataDir, 'trip');
  mkdirSync(tripDir, { recursive: true });
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(httpConfig(), null, 2));
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
  const call = async (path, { method = 'GET', token, body } = {}) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : { 'X-API-Key': AGENT_KEY };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, body: json };
  };
  return {
    call,
    async login(username) {
      for (let i = 0; i < 40; i++) {
        const r = await call('/api/auth/login', { method: 'POST', body: { username, password: '1234' } });
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
}

describe('over HTTP: split Colmar, then link the airport hotel filed under Colmar (the live 409 of the second review)', () => {
  let server, alice;
  const addHotel = async (body) => {
    const r = await server.call('/api/bookings', { method: 'POST', token: alice, body: { type: 'hotel', ...body } });
    assert.equal(r.status, 200, r.text);
    return r.body.id;
  };
  const bookingsUnder = async (phase) => (await server.call(`/api/bookings?phase=${phase}`, { token: alice })).body.map(b => b.id);

  before(async () => {
    server = await boot(PORTS.stopFollowups);
    alice = await server.login('alice');
  });
  after(async () => { await server?.stop(); });

  test('the reviewer\'s exact sequence: 201 split, then from-booking 200 (was 409 booking_belongs_to_another_stop)', async () => {
    const colmarHotel = await addHotel({ phase: 'colmar', name: 'Hotel Colmar Centre', date_from: '2026-12-02', date_to: '2026-12-07' });
    assert.equal((await server.call('/api/stops/colmar/from-booking', { method: 'POST', token: alice, body: { booking_id: colmarHotel } })).status, 200);
    const airport = await addHotel({ phase: 'colmar', name: 'Airport Hotel', date_from: '2026-12-06', date_to: '2026-12-07' });
    const frankfurtHotel = await addHotel({ phase: 'frankfurt', name: 'Frankfurt Hotel', date_from: '2026-12-06', date_to: '2026-12-07' });

    const split = await server.call('/api/stops/colmar/split', { method: 'POST', token: alice,
      body: { at: '2026-12-06', new_stop: { title: { he: 'ליד שדה התעופה', en: 'Near the airport' } } } });
    assert.equal(split.status, 201, split.text);
    const newId = split.body.stops[1].id;
    assert.equal(newId, 'near-the-airport');

    // Unrelated stop: still refused. Linked to the parent: still refused.
    const unrelated = await server.call(`/api/stops/${newId}/from-booking`, { method: 'POST', token: alice, body: { booking_id: frankfurtHotel } });
    assert.deepEqual([unrelated.status, unrelated.body.error, unrelated.body.stop], [409, 'booking_belongs_to_another_stop', 'frankfurt']);
    const linked = await server.call(`/api/stops/${newId}/from-booking`, { method: 'POST', token: alice, body: { booking_id: colmarHotel } });
    assert.deepEqual([linked.status, linked.body.error, linked.body.stop], [409, 'booking_linked_to_another_stop', 'colmar']);

    const before = (await server.call('/api/itinerary/active')).body.items.filter(i => i.booking_id === colmarHotel)
      .map(i => [i.item_uid, i.phase_id, i.date]);
    const r = await server.call(`/api/stops/${newId}/from-booking`, { method: 'POST', token: alice, body: { booking_id: airport } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.stop.accommodation.name, 'Airport Hotel');

    const cfg = (await server.call('/api/config', { token: alice })).body;
    assert.equal(cfg.phases.find(p => p.id === newId).accommodation.name, 'Airport Hotel');
    assert.equal(cfg.phases.find(p => p.id === 'colmar').accommodation.name, 'Hotel Colmar Centre', 'Colmar keeps its own hotel');
    assert.ok((await bookingsUnder(newId)).includes(airport), 'the airport hotel is listed under the new stop');
    assert.ok(!(await bookingsUnder('colmar')).includes(airport));
    assert.ok((await bookingsUnder('colmar')).includes(colmarHotel), 'Colmar\'s hotel stays filed under Colmar');

    const items = (await server.call('/api/itinerary/active')).body.items;
    assert.deepEqual(items.filter(i => i.booking_id === airport).map(i => i.phase_id), [newId, newId]);
    assert.deepEqual(items.filter(i => i.booking_id === colmarHotel).map(i => [i.item_uid, i.phase_id, i.date]), before,
      'Colmar\'s hotel check-in/check-out are exactly as they were before the link');
  });

  test('PATCH ארה"ב over HTTP → 200, and /api/config serves it as typed', async () => {
    const patch = await server.call('/api/stops/frankfurt', { method: 'PATCH', token: alice, body: { title: { he: 'ארה"ב', en: 'USA' }, tabLabel: 'ת"א' } });
    assert.equal(patch.status, 200, patch.text);
    const cfg = (await server.call('/api/config', { token: alice })).body;
    const f = cfg.phases.find(p => p.id === 'frankfurt');
    assert.deepEqual([f.title, f.tabLabel], [{ he: 'ארה"ב', en: 'USA' }, 'ת"א']);
  });

  test('an element, sent directly, is still refused: PATCH and split', async () => {
    const patch = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { title: { he: 'ת"א <img src=x onerror=alert(1)>', en: 'x' } } });
    assert.deepEqual([patch.status, patch.body.error, patch.body.field], [400, 'invalid_text', 'title.he']);
    const split = await server.call('/api/stops/colmar/split', { method: 'POST', body: { at: '2026-12-04', new_stop: { title: '"><svg onload=alert(1)>' } } });
    assert.deepEqual([split.status, split.body.error, split.body.field], [400, 'invalid_text', 'new_stop.title']);
    const text = (await server.call('/api/config', { token: alice })).text;
    for (const needle of ['onerror', '<svg', '<img']) assert.ok(!text.includes(needle), needle);
  });

  test('a booking named מלון ת"א links over HTTP, served as typed', async () => {
    const id = await addHotel({ phase: 'frankfurt', name: 'מלון ת"א', date_from: '2026-12-02', date_to: '2026-12-03' });
    const r = await server.call('/api/stops/frankfurt/from-booking', { method: 'POST', token: alice, body: { booking_id: id } });
    assert.equal(r.status, 200, r.text);
    const cfg = (await server.call('/api/config', { token: alice })).body;
    assert.equal(cfg.phases.find(p => p.id === 'frankfurt').accommodation.name, 'מלון ת"א');
  });
});
