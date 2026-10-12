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
    ['title.he with a <', { title: { he: 'a<b', en: 'ok' } }, 'title.he'],
    ['tabLabel', { tabLabel: '"><svg onload=alert(1)>' }, 'tabLabel'],
    ['emoji', { emoji: '<b>' }, 'emoji'],
    ['title with a NUL', { title: 'Col\u0000mar' }, 'title'],
    ['tabLabel with a newline', { tabLabel: 'COL\nMAR' }, 'tabLabel'],
    ['title with a C1 control', { title: 'Col\u0085mar' }, 'title'],
    ['accommodation.name', { accommodation: { name: XSS } }, 'accommodation.name'],
    ['accommodation.name.he (nested)', { accommodation: { name: { he: XSS, en: 'Hotel' } } }, 'accommodation.name.he'],
    ['accommodation.name_en', { accommodation: { name: 'Hotel', name_en: '</span><script>alert(1)</script>' } }, 'accommodation.name_en'],
    ['accommodation.address', { accommodation: { name: 'Hotel', address: '1 Rue "x"><svg onload=alert(1)>' } }, 'accommodation.address'],
    ['accommodation.phone', { accommodation: { name: 'Hotel', phone: '"><img src=x onerror=alert(1)>' } }, 'accommodation.phone'],
    ['accommodation.confirmation', { accommodation: { name: 'Hotel', confirmation: '<i>X</i>' } }, 'accommodation.confirmation'],
    ['accommodation.type', { accommodation: { name: 'Hotel', type: 'hotel>' } }, 'accommodation.type'],
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
      assert.match(r.body.detail, /< >/);
      // A `"` is no longer refused (owner decision 2026-10-11), so the
      // refusal does not name it, nor point at a gershayim rewrite.
      assert.doesNotMatch(r.body.detail, /"|U\+05F4|\u05F4/);
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

  // Owner decision 2026-10-11: Hebrew typed with an ASCII `"` (ארה"ב, ת"א,
  // בע"מ) and `55" TV` are stored exactly as typed — never refused, never
  // rewritten. A quote alone opens no element; every renderer escapes it
  // (tests/stop-xss-render.test.js proves the Classic sinks, attributes too).
  test('a " in any free-text field is accepted and stored exactly as typed', () => {
    const { structure } = make();
    const acc = {
      name: { he: 'מלון ת"א', en: 'Hotel "TLV"' }, name_en: 'x" onmouseover="alert(1)', address: '1 Rue "x" onmouseover=alert(1)',
      phone: '+972 "3"', confirmation: 'אב"ג-778', type: 'hotel"', cost: '55" TV', guests: '4"', rooms: '"2"',
      dates: { he: 'ב"ה', en: '"2–7 Dec"' }, description: 'קרוב לבע"מ\n55" TV', note: "' autofocus onfocus='alert(1)",
    };
    const body = { title: { he: 'ארה"ב', en: 'say "hi"' }, tabLabel: 'ת"א', emoji: '"', accommodation: acc };
    const r = structure.ops.update('colmar', body, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const colmar = structure.effectiveConfig().phases.find(p => p.id === 'colmar');
    assert.deepEqual(colmar.title, body.title);
    assert.equal(colmar.tabLabel, 'ת"א');
    assert.equal(colmar.emoji, '"');
    assert.deepEqual(colmar.accommodation, acc);
  });

  test('split: a new stop titled ארה"ב is created with the title as typed', () => {
    const { structure } = make();
    const r = structure.ops.split('colmar', { at: '2026-12-05', new_stop: { title: { he: 'ארה"ב', en: 'USA' }, accommodation: { name: 'מלון ת"א' } } }, 'alice');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const created = structure.effectiveConfig().phases.find(p => p.id === r.body.stops[1].id);
    assert.deepEqual(created.title, { he: 'ארה"ב', en: 'USA' });
    assert.equal(created.accommodation.name, 'מלון ת"א');
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

// ── follow-ups of the fifth boundary review (PR #364), 2026-10-11 ───────────
// The stop layer is the twin of server/text-rules.js: the same regexes, the
// same safeLink(). Its refusals keep their shape ({ error, field, detail }, no
// bilingual message — the stop routes never carried one); an invisible
// character gets its own detail.
const INVISIBLE_DETAIL = 'text may not contain invisible or blank-looking characters (zero-width, bidi, filler, tag or variation characters); LRM, RLM, ALM, ZWNJ, ZWJ and U+FE0F are allowed';
// The base set, then one or more of every class the boundary re-check of PR
// #371 found accepted (the whole set is enumerated in invisible-text.test.js):
// soft hyphen, CGJ, Hangul fillers, Khmer inherent vowels, Mongolian
// selectors, U+2061-U+2064 (U+2063 INVISIBLE SEPARATOR), the deprecated format
// characters, variation selectors (not VS16), noncharacter-range ignorables,
// shorthand format controls, musical format controls, tag characters,
// supplementary variation selectors, braille blank, object replacement.
const INVISIBLE_CPS = [0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029, 0xFEFF, 0x200B, 0x2060,
  0x00AD, 0x034F, 0x115F, 0x1160, 0x3164, 0xFFA0, 0x17B4, 0x17B5, 0x180B, 0x180E, 0x2061, 0x2063, 0x2064, 0x2065, 0x206A, 0x206F,
  0xFE00, 0xFE0E, 0xFFF0, 0x1BCA0, 0x1D173, 0xE0001, 0xE0041, 0xE007F, 0xE0100, 0xE0FFF, 0x2800, 0xFFFC];

describe('follow-up 1 — invisible and direction-changing characters in stop text are refused (invalid_text, own detail)', () => {
  const at = (cp) => `Col${String.fromCodePoint(cp)}mar`;
  const bodies = (v) => [
    [{ title: v }, 'title'], [{ title: { he: 'קולמר', en: v } }, 'title.en'], [{ tabLabel: v }, 'tabLabel'], [{ emoji: v }, 'emoji'],
    [{ accommodation: { name: v } }, 'accommodation.name'], [{ accommodation: { name: 'H', address: v } }, 'accommodation.address'],
    [{ accommodation: { name: 'H', confirmation: v } }, 'accommodation.confirmation'],
    [{ accommodation: { name: 'H', description: v } }, 'accommodation.description'],
    [{ accommodation: { name: 'H', note: { he: v, en: 'x' } } }, 'accommodation.note.he'],
  ];
  for (const cp of INVISIBLE_CPS) {
    test(`U+${cp.toString(16).toUpperCase()} in every text field (multi-line ones too) → 400 invalid_text, nothing stored`, () => {
      const { structure, counts } = make();
      for (const [body, field] of bodies(at(cp))) {
        const r = structure.ops.update('colmar', body, 'alice');
        assert.equal(r.status, 400, `${field}: ${JSON.stringify(r.body)}`);
        assert.deepEqual([r.body.error, r.body.field, r.body.detail], ['invalid_text', field, INVISIBLE_DETAIL], field);
        assert.equal(r.body.message, undefined, 'the stop layer keeps its shape: no message');
      }
      assert.deepEqual(counts(), NOTHING);
    });
  }

  test('split and from-booking refuse it too', () => {
    const { structure, counts, booking } = make();
    let r = structure.ops.split('colmar', { at: '2026-12-05', new_stop: { title: 'Air\u202Eport' } }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field, r.body.detail], [400, 'invalid_text', 'new_stop.title', INVISIBLE_DETAIL]);
    const id = booking({ name: 'Hotel\u200B Colmar' });
    r = structure.ops.fromBooking('colmar', { booking_id: id }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field, r.body.source], [400, 'invalid_text', 'accommodation.name', 'booking']);
    assert.deepEqual(counts(), NOTHING);
  });

  test('< > and control characters keep their own detail', () => {
    const { structure } = make();
    assert.equal(structure.ops.update('colmar', { title: 'a<b\u202E' }, 'alice').body.detail, 'text may not contain < > or control characters');
    assert.equal(structure.ops.update('colmar', { tabLabel: 'a\nb' }, 'alice').body.detail, 'text may not contain < > or control characters');
  });

  test('Hebrew with RLM / LRM / ALM / ZWNJ, and a ZWJ emoji, are stored exactly as typed', () => {
    const { structure } = make();
    const acc = { name: { he: 'מלון\u200F Hilton\u200E', en: 'Hilton\u200E' }, address: 'רחוב הרצל\u200F 5', description: 'فندق\u061C\nمی\u200Cخواهم' };
    const body = { title: { he: 'קולמר\u200F (Colmar)\u200E', en: 'Colmar' }, tabLabel: 'קולמר\u200F', emoji: '👨\u200D👩\u200D👧', accommodation: acc };
    const r = structure.ops.update('colmar', body, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const colmar = structure.effectiveConfig().phases.find(p => p.id === 'colmar');
    assert.deepEqual([colmar.title, colmar.tabLabel, colmar.emoji], [body.title, body.tabLabel, body.emoji]);
    assert.deepEqual(colmar.accommodation, acc);
  });
});

describe('follow-up 3 — CRLF in a stop\'s description/note is normalised to \\n; one-line fields still refuse CR', () => {
  test('description and note, as a string and as { he, en }: \\r\\n and \\r are stored as \\n', () => {
    const { structure } = make();
    const r = structure.ops.update('colmar', { accommodation: { name: 'H', description: 'a\r\nb\rc', note: { he: 'שורה\r\nשנייה', en: 'one\rtwo' } } }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const acc = structure.effectiveConfig().phases.find(p => p.id === 'colmar').accommodation;
    assert.equal(acc.description, 'a\nb\nc');
    assert.deepEqual(acc.note, { he: 'שורה\nשנייה', en: 'one\ntwo' });
  });

  test('a CR in a one-line field is still refused', () => {
    const { structure, counts } = make();
    for (const [body, field] of [[{ title: 'a\rb' }, 'title'], [{ accommodation: { name: 'H', address: 'a\r\nb' } }, 'accommodation.address'], [{ tabLabel: 'A\rB' }, 'tabLabel']]) {
      const r = structure.ops.update('colmar', body, 'alice');
      assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_text', field]);
    }
    assert.deepEqual(counts(), NOTHING);
  });
});

describe('follow-up 4 — a stop link the URL parser would rewrite is refused; legitimate links stored as typed', () => {
  const bad = ['https:\\\\evil.example', 'https:evil.example', 'https:/evil.example', 'https:///evil.example', 'https://.', 'https://a..b',
    'https://.evil.example', 'https://exa\u200Bmple.com', 'https://exa\u00ADmple.com', 'https://%65vil.example', 'https://evil．．example'];
  const good = ['http://[::1]/', 'https://xn--bcher-kva.example/', 'https://bücher.example/x', 'https://user:pass@maps.example/x',
    'HTTPS://Maps.Example/x', 'https://maps.example./x'];
  for (const link of bad) {
    test(`accommodation.maps = ${JSON.stringify(link)} → 400 invalid_link, nothing stored`, () => {
      const { structure, counts } = make();
      const r = structure.ops.update('colmar', { accommodation: { name: 'H', maps: link } }, 'alice');
      assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_link', 'accommodation.maps'], JSON.stringify(r.body));
      assert.deepEqual(counts(), NOTHING);
    });
  }
  test('legitimate links are stored exactly as typed (trimmed), never rewritten to url.href', () => {
    for (const link of good) {
      const { structure } = make();
      const r = structure.ops.update('colmar', { accommodation: { name: 'H', location_url: ` ${link}  ` } }, 'alice');
      assert.equal(r.status, 200, `${link}: ${JSON.stringify(r.body)}`);
      assert.equal(structure.effectiveConfig().phases.find(p => p.id === 'colmar').accommodation.location_url, link);
    }
  });
  test('from-booking: a booking link stored before this change with a backslash is refused, said, not copied', () => {
    const { structure, counts, booking } = make();
    const id = booking({ location_url: 'https:\\\\evil.example' });
    const r = structure.ops.fromBooking('colmar', { booking_id: id }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field, r.body.source], [400, 'invalid_link', 'accommodation.location_url', 'booking']);
    assert.deepEqual(counts(), NOTHING);
  });
});

describe('the twins — server/text-rules.js and server/trip-structure.js carry the same rules, byte for byte', () => {
  const { readFileSync } = require('node:fs');
  const src = (f) => readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
  const textRules = src('text-rules.js');
  const stopLayer = src('trip-structure.js');
  const constant = (code, name) => {
    const m = new RegExp(`^const ${name} = .*;$`, 'm').exec(code);
    assert.ok(m, `const ${name} not found`);
    return m[0];
  };
  const fn = (code, name) => {
    const start = code.search(new RegExp(`^function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `function ${name} not found`);
    return code.slice(start, code.indexOf('\n}\n', start) + 2);
  };

  for (const name of ['INVISIBLE_SRC', 'UNSAFE_LINE_RE', 'UNSAFE_MULTILINE_RE', 'INVISIBLE_RE', 'TEXT_DETAIL', 'INVISIBLE_DETAIL', 'LINK_DETAIL', 'LINK_HOST_HIDDEN_RE', 'LINK_LABEL_DOT_RE', 'toLf']) {
    test(`const ${name} is identical in both files`, () => {
      assert.equal(constant(stopLayer, name), constant(textRules, name));
    });
  }
  for (const name of ['safeLink', 'textDetail']) {
    test(`function ${name}() is identical in both files`, () => {
      assert.equal(fn(stopLayer, name), fn(textRules, name));
    });
  }
  // Since the boundary re-check of PR #371 the invisible list is written ONCE
  // per file (INVISIBLE_SRC) and every regex is built from it — no second or
  // third copy of the list a twin comparison could miss.
  test('every text regex of both files is built from INVISIBLE_SRC, and the draft cleaners from the write\'s own regexes', () => {
    for (const code of [textRules, stopLayer]) {
      for (const name of ['UNSAFE_LINE_RE', 'UNSAFE_MULTILINE_RE', 'INVISIBLE_RE']) {
        assert.match(constant(code, name), /INVISIBLE_SRC/, `${name} is built from INVISIBLE_SRC`);
      }
      assert.equal((code.match(/Default_Ignorable_Code_Point}/g) || []).length, 1, 'the property is named once');
    }
    assert.equal(constant(textRules, 'STRIP_LINE_RE'), "const STRIP_LINE_RE = new RegExp(UNSAFE_LINE_RE.source, 'gu');");
    assert.equal(constant(textRules, 'STRIP_MULTILINE_RE'), "const STRIP_MULTILINE_RE = new RegExp(UNSAFE_MULTILINE_RE.source, 'gu');");
  });
});

describe('boundary re-check of PR #371 — the widened invisible set, in the stop layer', () => {
  const ch = (cp) => String.fromCodePoint(cp);
  test('a stop title of a lone U+3164 / U+2800 / U+200B is refused (invalid_text), not stored as a blank-looking title', () => {
    const { structure, counts } = make();
    for (const cp of [0x3164, 0x2800, 0x200B, 0xFFA0]) {
      for (const [body, field] of [[{ title: ch(cp) }, 'title'], [{ title: { he: ch(cp), en: ch(cp) } }, 'title.he'], [{ tabLabel: ch(cp) }, 'tabLabel'], [{ accommodation: { name: ch(cp) } }, 'accommodation.name']]) {
        const r = structure.ops.update('colmar', body, 'alice');
        assert.deepEqual([r.status, r.body.error, r.body.field, r.body.detail], [400, 'invalid_text', field, INVISIBLE_DETAIL], `${field}/U+${cp.toString(16)}`);
      }
    }
    assert.deepEqual(counts(), NOTHING);
  });

  test('a tag character (U+E0041) in a stop title is refused; so is a subdivision flag in the emoji field (it is built from tag characters)', () => {
    const { structure, counts } = make();
    let r = structure.ops.update('colmar', { title: `Col${ch(0xE0041)}mar` }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field, r.body.detail], [400, 'invalid_text', 'title', INVISIBLE_DETAIL]);
    const england = [0x1F3F4, 0xE0067, 0xE0062, 0xE0065, 0xE006E, 0xE0067, 0xE007F].map(ch).join('');
    r = structure.ops.update('colmar', { emoji: england }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_text', 'emoji']);
    assert.deepEqual(counts(), NOTHING);
  });

  test('VS16, flag and ZWJ emoji, and Hebrew with RLM/LRM, are stored exactly as typed', () => {
    for (const emoji of [ch(0x2764) + ch(0xFE0F), ch(0x1F1EE) + ch(0x1F1F1), [0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467].map(ch).join(''), '1' + ch(0xFE0F) + ch(0x20E3)]) {
      const { structure } = make();
      const title = { he: `קולמר${ch(0x200F)} (Colmar)${ch(0x200E)}`, en: `Colmar ${emoji}` };
      const r = structure.ops.update('colmar', { emoji, title, accommodation: { name: `מלון${ch(0x200F)} ${emoji}` } }, 'alice');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const colmar = structure.effectiveConfig().phases.find(p => p.id === 'colmar');
      assert.deepEqual([colmar.emoji, colmar.title, colmar.accommodation.name], [emoji, title, `מלון${ch(0x200F)} ${emoji}`]);
    }
  });
});

describe('safeLink refuses every character the URL parser deletes from a host (enumerated against this Node)', () => {
  test('for every code point c where new URL("https://a" + c + "b.com").hostname === "ab.com", safeLink refuses the link', () => {
    const { safeLink } = require('../server/text-rules.js');
    const deleted = [];
    for (let cp = 0x21; cp <= 0x10FFFF; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      const link = `https://a${String.fromCodePoint(cp)}b.com/`;
      let host;
      try { host = new URL(link).hostname; } catch { continue; }
      if (host === 'ab.com') {
        deleted.push(cp);
        assert.equal(safeLink(link), undefined, `U+${cp.toString(16).toUpperCase()} is deleted by the parser but the link was accepted`);
      }
    }
    assert.ok(deleted.length >= 10, `enumeration found ${deleted.length} deleted characters`);
    assert.ok(deleted.includes(0xAD) && deleted.includes(0x200B), 'soft hyphen and zero-width space are among them');
  });

  test('every code point the parser turns into a label dot counts as a dot for the empty-label rule', () => {
    const { safeLink } = require('../server/text-rules.js');
    let dots = 0;
    for (let cp = 0x21; cp <= 0x10FFFF; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      const c = String.fromCodePoint(cp);
      let host;
      try { host = new URL(`https://a${c}b.com/`).hostname; } catch { continue; }
      if (host === 'a.b.com') {
        dots++;
        assert.equal(safeLink(`https://a${c}${c}b.com/`), undefined, `U+${cp.toString(16).toUpperCase()} doubled makes an empty label`);
        assert.equal(safeLink(`https://${c}b.com/`), undefined, `U+${cp.toString(16).toUpperCase()} leading makes an empty label`);
      }
    }
    assert.ok(dots >= 4, `found ${dots} dot characters`);
  });
});
