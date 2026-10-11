/**
 * stop-hardening.test.js — the stop writes after the 2026-10-11 boundary
 * review of the override layer (server/trip-structure.js), without HTTP.
 *
 * The review proved, with live requests, that PATCH /api/stops and split
 * stored `<img src=x onerror=…>` in a title and a `"` inside an https link,
 * that /api/config served them verbatim, and that the Classic site put them in
 * innerHTML. The agent key is enough to write a stop, and the companion that
 * holds it reads text travellers typed — so a prompt injection became script
 * in every member's browser. The fix refuses that text at the write; this file
 * pins every field it applies to, and the four smaller findings:
 *   - an accommodation key named after an Object.prototype member was accepted;
 *   - from-booking linked a booking to a stop it does not belong to;
 *   - revert with nothing to revert wrote a history row and bumped the revision;
 *   - a stop id like `constructor` was allowed.
 * Every refusal is checked for "nothing stored": no override, no history row,
 * no itinerary change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { createTripStructure } = require('../server/trip-structure.js');

const clone = (v) => JSON.parse(JSON.stringify(v));
const XSS = '<img src=x onerror=alert(document.cookie)>';

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
  const counts = () => ({
    overrides: db.prepare('SELECT COUNT(*) n FROM trip_stop_overrides').get().n,
    history: db.prepare('SELECT COUNT(*) n FROM trip_stop_history').get().n,
    itinerary: journey.changes,
  });
  const booking = (row) => {
    const full = { phase: 'colmar', type: 'hotel', name: 'Hotel Colmar Centre', date_from: '2026-12-02', date_to: '2026-12-07', ...row };
    const cols = Object.keys(full);
    return Number(db.prepare(`INSERT INTO bookings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(full)).lastInsertRowid);
  };
  return { db, structure, journey, counts, booking };
}

const NOTHING = { overrides: 0, history: 0, itinerary: 0 };

// ── finding 1: text that would be markup in a browser is refused ────────────
describe('finding 1 — stop text carrying markup or control characters is refused, naming the field', () => {
  const cases = [
    ['title (string)', { title: XSS }, 'title'],
    ['title.en', { title: { he: 'קולמר', en: XSS } }, 'title.en'],
    ['title.he with a quote', { title: { he: 'a"b', en: 'ok' } }, 'title.he'],
    ['tabLabel', { tabLabel: '"><svg onload=alert(1)>' }, 'tabLabel'],
    ['emoji', { emoji: '<b>' }, 'emoji'],
    ['title with a NUL', { title: 'Col\u0000mar' }, 'title'],
    ['tabLabel with a newline', { tabLabel: 'COL\nMAR' }, 'tabLabel'],
    ['title with a C1 control', { title: 'Col\u0085mar' }, 'title'],
    ['accommodation.name', { accommodation: { name: XSS } }, 'accommodation.name'],
    ['accommodation.name.he (nested)', { accommodation: { name: { he: XSS, en: 'Hotel' } } }, 'accommodation.name.he'],
    ['accommodation.name_en', { accommodation: { name: 'Hotel', name_en: '</span><script>alert(1)</script>' } }, 'accommodation.name_en'],
    ['accommodation.address', { accommodation: { name: 'Hotel', address: '1 Rue "x" onmouseover=alert(1)' } }, 'accommodation.address'],
    ['accommodation.phone', { accommodation: { name: 'Hotel', phone: '"><img src=x onerror=alert(1)>' } }, 'accommodation.phone'],
    ['accommodation.confirmation', { accommodation: { name: 'Hotel', confirmation: '<i>X</i>' } }, 'accommodation.confirmation'],
    ['accommodation.type', { accommodation: { name: 'Hotel', type: 'hotel"' } }, 'accommodation.type'],
    ['accommodation.cost', { accommodation: { name: 'Hotel', cost: '<b>100</b>' } }, 'accommodation.cost'],
    ['accommodation.guests', { accommodation: { name: 'Hotel', guests: '4>' } }, 'accommodation.guests'],
    ['accommodation.rooms', { accommodation: { name: 'Hotel', rooms: '<2' } }, 'accommodation.rooms'],
    ['accommodation.dates', { accommodation: { name: 'Hotel', dates: { he: 'x', en: '<u>2–7 Dec</u>' } } }, 'accommodation.dates.en'],
    ['accommodation.description', { accommodation: { name: 'Hotel', description: XSS } }, 'accommodation.description'],
    ['accommodation.note', { accommodation: { name: 'Hotel', note: 'bell\u0007' } }, 'accommodation.note'],
  ];
  for (const [name, body, field] of cases) {
    test(`PATCH ${name} → 400 invalid_text, nothing stored`, () => {
      const { structure, counts } = make();
      const r = structure.ops.update('colmar', body, 'alice');
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'invalid_text');
      assert.equal(r.body.field, field);
      assert.match(r.body.detail, /< > "/);
      assert.deepEqual(counts(), NOTHING);
    });
  }

  const links = [
    ['a quote breaking out of the href', 'https://maps.example/x"onmouseover="alert(1)'],
    ['a single quote', "https://maps.example/x'onmouseover='alert(1)"],
    ['angle brackets', 'https://maps.example/<script>'],
    ['whitespace', 'https://maps.example/a b'],
    ['a newline', 'https://maps.example/a\nb'],
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a data: scheme', 'data:text/html,<script>alert(1)</script>'],
    ['no host', 'https://'],
    ['not a URL', 'colmar centre'],
  ];
  for (const key of ['location_url', 'maps', 'waze', 'url']) {
    for (const [name, link] of links) {
      test(`PATCH accommodation.${key} with ${name} → 400 invalid_link, nothing stored`, () => {
        const { structure, counts } = make();
        const r = structure.ops.update('colmar', { accommodation: { name: 'Hotel', [key]: link } }, 'alice');
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body.error, 'invalid_link');
        assert.equal(r.body.field, `accommodation.${key}`);
        assert.deepEqual(counts(), NOTHING);
      });
    }
  }

  test('ordinary text and links are still accepted, stored as typed', () => {
    const { structure, structure: { effectiveConfig } } = make();
    const acc = {
      name: { he: "מלון ז'אן & בנו", en: "Jean & Son's Hotel" }, address: '12 Rue des Clefs, Colmar', phone: '+33 3 89 00 00 00',
      confirmation: 'HCC-778', location_url: 'https://maps.example/colmar?q=a&b=c#x', maps: 'http://maps.example/x',
      description: 'Two rooms.\nBreakfast included.', cost: 1200, guests: 4,
    };
    const r = structure.ops.update('colmar', { title: { he: 'קולמר & ריקוויר', en: "Colmar & Riquewihr's" }, tabLabel: 'COLMAR', emoji: '🏰', accommodation: acc }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const colmar = effectiveConfig().phases.find(p => p.id === 'colmar');
    assert.deepEqual(colmar.accommodation, acc);
    assert.equal(colmar.title.en, "Colmar & Riquewihr's");
  });

  test('split: a hostile new stop title or link is refused under new_stop.*, and nothing is split', () => {
    const { structure, counts } = make();
    let r = structure.ops.split('colmar', { at: '2026-12-05', new_stop: { title: XSS } }, 'alice');
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.deepEqual([r.body.error, r.body.field], ['invalid_text', 'new_stop.title']);
    r = structure.ops.split('colmar', { at: '2026-12-05', new_stop: { title: 'Airport', tabLabel: '<x>' } }, 'alice');
    assert.deepEqual([r.body.error, r.body.field], ['invalid_text', 'new_stop.tabLabel']);
    r = structure.ops.split('colmar', { at: '2026-12-05', new_stop: { title: 'Airport', accommodation: { name: 'H', maps: 'https://x.example/"><script>' } } }, 'alice');
    assert.deepEqual([r.body.error, r.body.field], ['invalid_link', 'new_stop.accommodation.maps']);
    assert.deepEqual(counts(), NOTHING);
  });

  test('from-booking: a hostile booking name is refused (400), not stored, no check-in item created', () => {
    const { structure, counts, booking } = make();
    const id = booking({ name: `Hotel ${XSS}` });
    const r = structure.ops.fromBooking('colmar', { booking_id: id }, 'alice');
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.deepEqual([r.body.error, r.body.field, r.body.source], ['invalid_text', 'accommodation.name', 'booking']);
    assert.deepEqual(counts(), NOTHING);
  });

  test('from-booking: a hostile confirmation or map link on the booking is refused too', () => {
    const { structure, counts, booking } = make();
    const conf = booking({ confirmation: '"><img src=x onerror=alert(1)>' });
    let r = structure.ops.fromBooking('colmar', { booking_id: conf }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_text', 'accommodation.confirmation']);
    const link = booking({ location_url: 'https://maps.example/"onmouseover="alert(1)' });
    r = structure.ops.fromBooking('colmar', { booking_id: link }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_link', 'accommodation.location_url']);
    // A non-http link used to be dropped without a word; now it is said.
    const js = booking({ location_url: 'javascript:alert(1)' });
    r = structure.ops.fromBooking('colmar', { booking_id: js }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_link', 'accommodation.location_url']);
    assert.deepEqual(counts(), NOTHING);
  });
});

// ── finding 2: prototype member names are not accommodation fields ───────────
describe('finding 2 — an accommodation key named after an Object.prototype member is refused', () => {
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    test(key, () => {
      const { structure, counts } = make();
      // JSON.parse, as express.json() does: `__proto__` arrives as an own key.
      const accommodation = JSON.parse(`{"name":"Hotel","${key}":"x"}`);
      const r = structure.ops.update('colmar', { accommodation }, 'alice');
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'unknown_accommodation_field');
      assert.equal(r.body.field, key);
      assert.deepEqual(counts(), NOTHING);
    });
  }

  test('a booking item uid named after a prototype member does not take a booking date', () => {
    const journey = fakeJourney({ days: [], items: [
      { item_uid: 'booking_1_checkin', phase_id: 'colmar', date: '2026-12-03' },
      { item_uid: 'constructor', phase_id: 'colmar', date: '2026-12-04' },
    ] });
    const { structure, booking } = make(journey);
    booking({});
    structure.onBookingChanged(1);
    const uid = (u) => journey.rows.items.find(i => i.item_uid === u);
    assert.equal(uid('booking_1_checkin').date, '2026-12-02');
    assert.equal(uid('constructor').date, '2026-12-04');
  });
});

// ── finding 3: a booking links only to its own stop ─────────────────────────
describe('finding 3 — from-booking refuses a booking that belongs to, or is linked to, another stop', () => {
  test('a booking filed under another stop → 409 booking_belongs_to_another_stop, nothing written', () => {
    const { structure, counts, booking } = make();
    const id = booking({ phase: 'frankfurt' });
    const r = structure.ops.fromBooking('colmar', { booking_id: id }, 'alice');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'booking_belongs_to_another_stop');
    assert.equal(r.body.stop, 'frankfurt');
    assert.deepEqual(counts(), NOTHING);
  });

  test('a booking already linked to another stop → 409 booking_linked_to_another_stop; the same stop again is idempotent', () => {
    const { structure, booking, db } = make();
    // Filed under a trip-wide bucket, so it names no stop of its own.
    const id = booking({ phase: 'general' });
    assert.equal(structure.ops.fromBooking('colmar', { booking_id: id }, 'alice').status, 200);
    const historyBefore = db.prepare('SELECT COUNT(*) n FROM trip_stop_history').get().n;
    const r = structure.ops.fromBooking('frankfurt', { booking_id: id }, 'alice');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'booking_linked_to_another_stop');
    assert.equal(r.body.stop, 'colmar');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM trip_stop_history').get().n, historyBefore, 'nothing written');
    assert.equal(db.prepare("SELECT booking_id FROM trip_stop_overrides WHERE phase_id = 'frankfurt'").get(), undefined);
    const again = structure.ops.fromBooking('colmar', { booking_id: id }, 'alice');
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });

  test('a booking on its own stop links as before', () => {
    const { structure, booking } = make();
    const r = structure.ops.fromBooking('colmar', { booking_id: booking({}) }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

// ── finding 4: revert with nothing to revert writes nothing ─────────────────
describe('finding 4 — revert on a stop with no override is a no-op', () => {
  test('200, unchanged: true, no history row, the revision does not move', () => {
    const { structure, counts } = make();
    const before = structure.revision();
    const r = structure.ops.revert('colmar', {}, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.unchanged, true);
    assert.equal(r.body.revision, before);
    assert.equal(structure.revision(), before);
    assert.deepEqual(counts(), NOTHING);
    assert.deepEqual(structure.historyOf('colmar'), []);
  });

  test('a revert that does undo something still writes and is recorded', () => {
    const { structure } = make();
    structure.ops.update('colmar', { tabLabel: 'X' }, 'alice');
    const r = structure.ops.revert('colmar', {}, 'alice');
    assert.equal(r.status, 200);
    assert.equal(r.body.unchanged, undefined);
    assert.deepEqual(structure.historyOf('colmar').map(h => h.action), ['update', 'revert']);
  });
});

// ── finding 5: reserved stop ids ────────────────────────────────────────────
describe('finding 5 — a stop id named after a prototype member is refused', () => {
  for (const id of ['constructor', 'prototype', '__proto__', 'toString', 'valueof', 'hasownproperty']) {
    test(`split new_stop.id = ${id} → 400 invalid_stop_id`, () => {
      const { structure, counts } = make();
      const r = structure.ops.split('colmar', { at: '2026-12-05', new_stop: { id, title: 'X' } }, 'alice');
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'invalid_stop_id');
      assert.deepEqual(counts(), NOTHING);
    });
  }

  test('a title that slugifies to a reserved name gets another id', () => {
    const { structure } = make();
    const r = structure.ops.split('colmar', { at: '2026-12-05', new_stop: { title: 'Constructor' } }, 'alice');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.notEqual(r.body.stops[1].id, 'constructor');
    assert.match(r.body.stops[1].id, /^[a-z0-9][a-z0-9-]*$/);
  });
});
