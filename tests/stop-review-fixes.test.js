/**
 * stop-review-fixes.test.js — the four P2 findings of the automated review of
 * PR #362 (stop editing), each reproduced as the reviewer described it.
 *
 * (1) CLEARING A LEGACY STOP'S DATES. A hand-authored phase may carry its
 *     dates as top-level `start`/`end`. Clearing them (`dates: null`) set both
 *     keys to null; /api/config served the nulls, and the Modern site's config
 *     schema (trip-web/src/api.ts: `start: z.string().optional()`) rejects a
 *     null, so the next refetch failed. The keys are now deleted.
 *
 * (2) A COMPUTED OPEN-DAYS ID THAT ROWS STILL USE. Dating a stop in the middle
 *     of the trip's open days splits them into open-days-1 / open-days-2; a
 *     plan row filed under open-days-2 keeps that id. Extending the stop to the
 *     trip's end recomputes the gap as plain `open-days`, and open-days-2 was
 *     no longer a phase at all: every Classic/MCP plan route and move-day
 *     refused it, and the row could not be reached. An open-days id that a
 *     plan row, a day row or a booking still names stays reachable as a SOURCE
 *     (derived from the rows at read time, no new table), stays non-editable as
 *     a stop, and is not served as a phase by /api/config.
 *
 * (3) RESTORING LINKED HISTORY. A history snapshot carries booking_id, and the
 *     restore wrote it back without the ownership checks from-booking makes —
 *     so two stops could both be linked to one hotel. A restore whose booking is
 *     now linked to (or filed under) another stop is refused with the same 409
 *     and changes nothing; one whose booking no longer exists is restored
 *     without the link.
 *
 * (4) CALENDAR OVERFLOW. Date.parse('2027-02-30') is a valid time (it rolls
 *     over to March 2), so February 30 passed and was stored. Every date the
 *     stop layer takes must now survive a YYYY-MM-DD round trip.
 *
 * Then the second boundary re-check of PR #373 (2026-10-12):
 *
 * (5) RESTORING A SNAPSHOT TODAY'S RULES REFUSE. A history snapshot written by
 *     an older server (a title with U+2063, a tab label of U+3164, February 30)
 *     was written back unchecked by a revert. Every restored field now goes
 *     through the same validation a PATCH does, and a refused one is 400
 *     history_entry_invalid naming the field and the underlying refusal — no
 *     override written, no history row, no new revision. history_id is a
 *     positive whole number or a string of digits, nothing looser.
 *
 * (6) THE REFERENCED-ID LOOKUP IS CHEAP. An open-days-N lookup re-read every
 *     plan row and ran three queries, on every call. The set of open-days ids
 *     anything names is computed once per state of the data and cached; a
 *     second lookup does no row scan at all, and the set still lapses the moment
 *     the last row moves away.
 *
 * Unit tests on createTripStructure, then each scenario over HTTP on a real
 * trip server.
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

function make(config, journey = fakeJourney()) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT, type TEXT, name TEXT, date_from TEXT,
      date_to TEXT, confirmation TEXT, pin TEXT, notes TEXT, location_url TEXT, review_status TEXT DEFAULT 'approved');
    CREATE TABLE budget_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT);
    CREATE TABLE photos (id TEXT PRIMARY KEY, phase TEXT);
  `);
  const base = clone(config);
  const structure = createTripStructure({ db, baseConfig: () => base, journey: () => journey, queuePhaseReview: () => {} });
  const booking = (row) => {
    const full = { phase: 'general', type: 'hotel', name: 'Hotel', date_from: '2027-03-02', date_to: '2027-03-04', ...row };
    const cols = Object.keys(full);
    return Number(db.prepare(`INSERT INTO bookings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(full)).lastInsertRowid);
  };
  const historyCount = () => db.prepare('SELECT COUNT(*) n FROM trip_stop_history').get().n;
  const override = (id) => db.prepare('SELECT * FROM trip_stop_overrides WHERE phase_id = ?').get(id) || null;
  const phase = (id) => (structure.effectiveConfig().phases || []).find(p => p.id === id) || null;
  return { db, structure, journey, booking, historyCount, override, phase };
}

// ── (1) clearing a legacy stop's dates ──────────────────────────────────────
const legacyConfig = () => ({
  meta: { title: 'Legacy', departure: '2027-03-01', returnDate: '2027-03-10' },
  phases: [
    { id: 'rome', title: { he: 'רומא', en: 'Rome' }, tabLabel: 'ROME', start: '2027-03-01', end: '2027-03-05' },
    { id: 'florence', title: { he: 'פירנצה', en: 'Florence' }, tabLabel: 'FLORENCE', start: '2027-03-05', end: '2027-03-10' },
  ],
});

describe('(1) clearing a legacy stop\'s dates deletes start/end instead of serving null', () => {
  test('dates: null on a phase with top-level start/end leaves no start, end or dates key', () => {
    const { structure, phase } = make(legacyConfig());
    const r = structure.ops.update('rome', { dates: null }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = phase('rome');
    for (const key of ['start', 'end', 'dates']) assert.equal(Object.hasOwn(p, key), false, `${key} is absent, not null`);
    assert.equal(p.title.en, 'Rome', 'the rest of the stop is kept');
  });

  test('setting dates again on a cleared legacy stop works, and the untouched stop keeps its legacy keys', () => {
    const { structure, phase } = make(legacyConfig());
    assert.equal(structure.ops.update('rome', { dates: null }, 'alice').status, 200);
    const r = structure.ops.update('rome', { dates: { start: '2027-03-01', end: '2027-03-04' } }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(phase('rome').dates, { start: '2027-03-01', end: '2027-03-04' });
    assert.deepEqual([phase('florence').start, phase('florence').end], ['2027-03-05', '2027-03-10']);
  });
});

// ── (2) a computed open-days id that rows still use ─────────────────────────
// Rome is dated at the start; Florence has no dates, so the base config carries
// one `open-days` block for 03-04..03-10 (the provisioner's convention).
const openDaysConfig = () => ({
  meta: { title: 'Italy', departure: '2027-03-01', returnDate: '2027-03-10' },
  phases: [
    { id: 'rome', title: { he: 'רומא', en: 'Rome' }, tabLabel: 'ROME', dates: { start: '2027-03-01', end: '2027-03-03' } },
    { id: 'florence', title: { he: 'פירנצה', en: 'Florence' }, tabLabel: 'FLORENCE' },
    { id: 'open-days', unplanned: true, title: { he: 'ימים שעוד לא תוכננו', en: 'Days not planned yet' }, tabLabel: '?',
      dates: { start: '2027-03-04', end: '2027-03-10' }, note: { he: '7', en: '7' } },
  ],
});
const planItem = (phase_id, date, uid) => ({ item_uid: uid, phase_id, date, time: null, text_he: 'פריט', text_en: 'Item' });

// The reviewer's sequence up to the point where open-days-2 is orphaned.
function orphanOpenDays2({ rowsUnder = true } = {}) {
  const ctx = make(openDaysConfig());
  const { structure, journey, phase } = ctx;
  const mid = structure.ops.update('florence', { dates: { start: '2027-03-06', end: '2027-03-07' } }, 'alice');
  assert.equal(mid.status, 200, JSON.stringify(mid.body));
  assert.deepEqual(phase('open-days-2')?.dates, { start: '2027-03-08', end: '2027-03-10' }, 'the gap after Florence is open-days-2');
  if (rowsUnder) {
    journey.rows.items.push(planItem('open-days-2', '2027-03-09', 'item-od2'));
    journey.rows.days.push({ phase_id: 'open-days-2', date: '2027-03-09', label_he: null, label_en: null });
    journey.changes++;
  }
  const extend = structure.ops.update('florence', { dates: { start: '2027-03-06', end: '2027-03-10' } }, 'alice');
  assert.equal(extend.status, 200, JSON.stringify(extend.body));
  return ctx;
}

describe('(2) a computed open-days id still named by rows stays reachable as a source', () => {
  test('after the gap recomputes to open-days, open-days-2 is still a phase while a plan row uses it', () => {
    const { structure } = orphanOpenDays2();
    const ids = structure.effectiveConfig().phases.map(p => p.id);
    assert.ok(ids.includes('open-days'), 'the remaining gap is open-days');
    assert.ok(!ids.includes('open-days-2'), 'no phantom open-days-2 phase is served');
    assert.equal(structure.isPhase('open-days-2'), true, 'saved rows still reach it');
    assert.equal(structure.isStop('open-days-2'), false, 'it is not a stop');
  });

  test('it stays non-editable: PATCH, split, from-booking, revert and DELETE answer 400 unplanned_stop_is_computed', () => {
    const { structure, booking } = orphanOpenDays2();
    const hotel = booking({});
    const answers = [
      structure.ops.update('open-days-2', { title: 'x' }, 'alice'),
      structure.ops.split('open-days-2', { at: '2027-03-09', new_stop: { title: 'x' } }, 'alice'),
      structure.ops.fromBooking('open-days-2', { booking_id: hotel }, 'alice'),
      structure.ops.revert('open-days-2', {}, 'alice'),
      structure.ops.remove('open-days-2', 'alice'),
    ].map(r => [r.status, r.body.error]);
    for (const a of answers) assert.deepEqual(a, [400, 'unplanned_stop_is_computed']);
  });

  test('a booking filed under it keeps it reachable too; with nothing naming it, it is gone', () => {
    const withBooking = orphanOpenDays2({ rowsUnder: false });
    assert.equal(withBooking.structure.isPhase('open-days-2'), false, 'no row, no booking: not a phase');
    withBooking.booking({ phase: 'open-days-2', type: 'other' });
    assert.equal(withBooking.structure.isPhase('open-days-2'), true, 'a booking filed under it');
    assert.equal(withBooking.structure.isPhase('open-days-7'), false, 'an open-days id nothing names is not a phase');
  });

  test('a day headline keeps it reachable; an empty day row (what a moved item leaves) does not', () => {
    const { structure, journey } = orphanOpenDays2({ rowsUnder: false });
    journey.rows.days.push({ phase_id: 'open-days-2', date: '2027-03-09', label_he: null, label_en: null });
    journey.changes++;
    assert.equal(structure.isPhase('open-days-2'), false, 'an empty day row names nothing');
    journey.rows.days[0].label_en = 'Day trip';
    journey.changes++;
    assert.equal(structure.isPhase('open-days-2'), true, 'a headline is a plan');
  });

  test('once its rows move away it stops being reachable', () => {
    const { structure, journey } = orphanOpenDays2();
    journey.rows.items = journey.rows.items.map(i => ({ ...i, phase_id: 'florence' }));
    journey.rows.days = journey.rows.days.map(d => ({ ...d, phase_id: 'florence' }));
    journey.changes++;
    assert.equal(structure.isPhase('open-days-2'), false);
  });

  test('a config without the open-days convention does not adopt an open-days-* id from rows', () => {
    const cfg = openDaysConfig();
    cfg.phases = cfg.phases.filter(p => !p.unplanned);
    const { structure, journey } = make(cfg);
    journey.rows.items.push(planItem('open-days-2', '2027-03-09', 'x'));
    journey.changes++;
    assert.equal(structure.isPhase('open-days-2'), false);
  });
});

// ── (3) restoring linked history ────────────────────────────────────────────
const twoStops = () => ({
  meta: { title: 'Two', departure: '2027-03-01', returnDate: '2027-03-10' },
  phases: [
    { id: 'a', title: { he: 'א', en: 'A' }, tabLabel: 'A', dates: { start: '2027-03-01', end: '2027-03-05' } },
    { id: 'b', title: { he: 'ב', en: 'B' }, tabLabel: 'B', dates: { start: '2027-03-05', end: '2027-03-10' } },
  ],
});
const lastHistoryId = (structure, id, action) => structure.historyOf(id).filter(h => h.action === action).at(-1).id;

describe('(3) restoring a linked history snapshot checks the booking\'s current owner', () => {
  test('the reviewer\'s repro: link to A, revert A, link to B, restore A\'s link → 409, nothing written', () => {
    const { structure, booking, historyCount, override } = make(twoStops());
    const hotel = booking({ phase: 'general', date_from: '2027-03-02', date_to: '2027-03-04' });
    assert.equal(structure.ops.fromBooking('a', { booking_id: hotel, create_items: false }, 'alice').status, 200);
    const linkedRow = lastHistoryId(structure, 'a', 'from_booking');
    assert.equal(structure.ops.revert('a', {}, 'alice').status, 200);
    const toB = structure.ops.fromBooking('b', { booking_id: hotel, create_items: false, on_outside: 'keep' }, 'alice');
    assert.equal(toB.status, 200, JSON.stringify(toB.body));

    const before = historyCount();
    const r = structure.ops.revert('a', { history_id: linkedRow, on_outside: 'keep' }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.stop], [409, 'booking_linked_to_another_stop', 'b']);
    assert.equal(historyCount(), before, 'no history row');
    assert.equal(override('a'), null, 'A is still the config');
    assert.equal(override('b').booking_id, hotel, 'B keeps its link');
  });

  test('a booking now filed under another stop is refused the same way from-booking refuses it', () => {
    const { db, structure, booking, historyCount, override } = make(twoStops());
    const hotel = booking({ phase: 'general', date_from: '2027-03-02', date_to: '2027-03-04' });
    assert.equal(structure.ops.fromBooking('a', { booking_id: hotel, create_items: false }, 'alice').status, 200);
    const linkedRow = lastHistoryId(structure, 'a', 'from_booking');
    assert.equal(structure.ops.revert('a', {}, 'alice').status, 200);
    db.prepare('UPDATE bookings SET phase = ? WHERE id = ?').run('b', hotel);
    const before = historyCount();
    const r = structure.ops.revert('a', { history_id: linkedRow }, 'alice');
    assert.deepEqual([r.status, r.body.error, r.body.stop], [409, 'booking_belongs_to_another_stop', 'b']);
    assert.equal(historyCount(), before);
    assert.equal(override('a'), null);
  });

  test('a deleted booking: the snapshot is restored without the link', () => {
    const { db, structure, booking, override, phase } = make(twoStops());
    const hotel = booking({ phase: 'general', name: 'Gone Hotel', date_from: '2027-03-02', date_to: '2027-03-04' });
    assert.equal(structure.ops.fromBooking('a', { booking_id: hotel, create_items: false }, 'alice').status, 200);
    const linkedRow = lastHistoryId(structure, 'a', 'from_booking');
    assert.equal(structure.ops.revert('a', {}, 'alice').status, 200);
    db.prepare('DELETE FROM bookings WHERE id = ?').run(hotel);
    const r = structure.ops.revert('a', { history_id: linkedRow }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(override('a').booking_id, null, 'no link to a booking that does not exist');
    assert.equal(phase('a').accommodation.name, 'Gone Hotel', 'the rest of the snapshot is restored');
    assert.equal(structure.historyOf('a').at(-1).after.booking_id, null, 'history records what was written');
  });

  test('restoring a link nobody else holds still works', () => {
    const { structure, booking, override } = make(twoStops());
    const hotel = booking({ phase: 'a', date_from: '2027-03-02', date_to: '2027-03-04' });
    assert.equal(structure.ops.fromBooking('a', { booking_id: hotel, create_items: false }, 'alice').status, 200);
    const linkedRow = lastHistoryId(structure, 'a', 'from_booking');
    assert.equal(structure.ops.revert('a', {}, 'alice').status, 200);
    const r = structure.ops.revert('a', { history_id: linkedRow }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(override('a').booking_id, hotel);
  });
});

// ── (4) calendar overflow ───────────────────────────────────────────────────
const febConfig = () => ({
  meta: { title: 'Feb', departure: '2027-02-01', returnDate: '2027-03-10' },
  phases: [
    { id: 'oslo', title: { he: 'אוסלו', en: 'Oslo' }, tabLabel: 'OSLO', dates: { start: '2027-02-01', end: '2027-02-20' } },
    { id: 'bergen', title: { he: 'ברגן', en: 'Bergen' }, tabLabel: 'BERGEN', dates: { start: '2027-02-20', end: '2027-03-10' } },
  ],
});

describe('(4) a date that is not on the calendar is refused, not stored', () => {
  test('the reviewer\'s repro: 2027-02-30..2027-03-02 → 400 invalid_dates, nothing written', () => {
    const { structure, historyCount, override } = make(febConfig());
    const r = structure.ops.update('bergen', { dates: { start: '2027-02-30', end: '2027-03-02' } }, 'alice');
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_dates']);
    assert.equal(historyCount(), 0);
    assert.equal(override('bergen'), null);
  });

  test('each overflow shape is refused; real days, leap day included, are accepted', () => {
    const { structure } = make(febConfig());
    for (const bad of ['2027-02-29', '2027-04-31', '2027-13-01', '2027-00-10', '2027-02-00', '2027-02-32']) {
      const r = structure.ops.update('bergen', { dates: { start: '2027-02-21', end: bad } }, 'alice');
      assert.deepEqual([r.status, r.body.error], [400, 'invalid_dates'], bad);
    }
    const ok = structure.ops.update('bergen', { dates: { start: '2027-02-21', end: '2027-02-28' } }, 'alice');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // A real leap day passes the validator (and is then measured against the trip).
    const leap = structure.ops.update('bergen', { dates: { start: '2028-02-29', end: '2028-02-29' } }, 'alice');
    assert.equal(leap.body.error, 'dates_outside_trip');
  });

  test('split at an overflow date → 400 invalid_split_date', () => {
    const { structure, historyCount } = make(febConfig());
    const r = structure.ops.split('bergen', { at: '2027-02-30', new_stop: { title: 'X' } }, 'alice');
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_split_date']);
    assert.equal(historyCount(), 0);
  });

  test('a booking dated on an overflow day does not shape a stop (booking_has_no_dates)', () => {
    const { structure, booking } = make(febConfig());
    const hotel = booking({ phase: 'bergen', date_from: '2027-02-30', date_to: '2027-03-02' });
    const r = structure.ops.fromBooking('bergen', { booking_id: hotel }, 'alice');
    assert.deepEqual([r.status, r.body.error], [400, 'booking_has_no_dates']);
  });
});

// ── (5) restoring a snapshot today's rules refuse ───────────────────────────
const ch = (cp) => String.fromCodePoint(cp);
const INVISIBLE_DETAIL = 'text may not contain invisible or blank-looking characters (zero-width, bidi, filler, tag or variation characters); LRM, RLM, ALM, ZWNJ, ZWJ and U+FE0F are allowed';
const CODE_DETAIL = 'a confirmation number or PIN may not contain invisible characters, not even LRM, RLM, ALM, ZWNJ, ZWJ or U+FE0F';

// What a pre-PR server left behind: the override it stored and the history
// row it wrote for it. Returns the history id.
function plantOldWrite(db, phaseId, fields) {
  db.prepare(`INSERT INTO trip_stop_overrides (phase_id, kind, fields, base_digest, updated_by) VALUES (?, 'config', ?, '{}', 'old-server')
    ON CONFLICT(phase_id) DO UPDATE SET fields = excluded.fields`).run(phaseId, JSON.stringify(fields));
  return Number(db.prepare("INSERT INTO trip_stop_history (phase_id, action, before_state, after_state, actor) VALUES (?, 'update', NULL, ?, 'old-server')")
    .run(phaseId, JSON.stringify({ kind: 'config', fields, after_phase_id: null, booking_id: null })).lastInsertRowid);
}

describe('(5) a restored snapshot goes through today\'s rules before it is written', () => {
  const cases = [
    ['a title with U+2063', { title: `Bergen${ch(0x2063)}` }, 'title', 'invalid_text', INVISIBLE_DETAIL],
    ['a tab label of U+3164', { tabLabel: ch(0x3164) }, 'tabLabel', 'invalid_text', INVISIBLE_DETAIL],
    ['an accommodation name with U+2800', { accommodation: { name: `Hotel${ch(0x2800)}` } }, 'accommodation.name', 'invalid_text', INVISIBLE_DETAIL],
    ['a note with U+00AD', { accommodation: { name: 'H', note: `late${ch(0x00AD)} check-in` } }, 'accommodation.note', 'invalid_text', INVISIBLE_DETAIL],
    ['dates ending on February 30', { dates: { start: '2027-02-21', end: '2027-02-30' } }, 'dates', 'invalid_dates', undefined],
    ['a title of a lone RLM', { title: ch(0x200F) }, 'title', 'invalid_title', undefined],
    ['a confirmation with an RLM', { accommodation: { name: 'H', confirmation: `123${ch(0x200F)}456` } }, 'accommodation.confirmation', 'invalid_text', CODE_DETAIL],
  ];
  for (const [what, fields, field, cause, detail] of cases) {
    test(`${what} → 400 history_entry_invalid (field ${field}, cause ${cause}); no override change, no history row, same revision`, () => {
      const { db, structure, historyCount, override } = make(febConfig());
      const hid = plantOldWrite(db, 'bergen', fields);
      // The organizer has since PATCHed a clean value; the bad snapshot is history.
      assert.equal(structure.ops.update('bergen', { title: 'Bergen' }, 'alice').status, 200);
      const before = { history: historyCount(), override: override('bergen'), revision: structure.revision() };
      const r = structure.ops.revert('bergen', { history_id: hid, on_outside: 'keep' }, 'alice');
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.deepEqual([r.body.error, r.body.history_id, r.body.field, r.body.cause], ['history_entry_invalid', hid, field, cause], JSON.stringify(r.body));
      if (detail) assert.equal(r.body.detail, detail);
      assert.deepEqual({ history: historyCount(), override: override('bergen'), revision: structure.revision() }, before);
    });
  }

  test('the reviewer\'s repro, all at once — refused, and the way out still works: back to the config, or PATCH a fixed value', () => {
    const { db, structure, historyCount, override, phase } = make(febConfig());
    const hid = plantOldWrite(db, 'bergen', {
      title: `Bergen${ch(0x2063)}`, tabLabel: ch(0x3164),
      accommodation: { name: `Hotel${ch(0x2800)}`, note: `a${ch(0x00AD)}b` }, dates: { start: '2027-02-21', end: '2027-02-30' },
    });
    const n = historyCount();
    const r = structure.ops.revert('bergen', { history_id: hid, on_outside: 'keep' }, 'alice');
    assert.deepEqual([r.status, r.body.error], [400, 'history_entry_invalid']);
    assert.equal(historyCount(), n);
    const toConfig = structure.ops.revert('bergen', {}, 'alice');
    assert.equal(toConfig.status, 200, JSON.stringify(toConfig.body));
    assert.equal(override('bergen'), null);
    assert.equal(phase('bergen').title.en, 'Bergen');
    assert.equal(structure.ops.update('bergen', { title: 'Bergen centre' }, 'alice').status, 200);
  });

  test('a clean snapshot still restores, with every field', () => {
    const { db, structure, phase } = make(febConfig());
    const fields = { title: { he: `ברגן${ch(0x200F)}`, en: 'Bergen' }, tabLabel: 'BGO', accommodation: { name: 'Hotel Bryggen', confirmation: 'AB-12' },
      dates: { start: '2027-02-21', end: '2027-02-28' } };
    const hid = plantOldWrite(db, 'bergen', fields);
    assert.equal(structure.ops.update('bergen', { title: 'Other', dates: { start: '2027-02-20', end: '2027-03-10' } }, 'alice').status, 200);
    const r = structure.ops.revert('bergen', { history_id: hid, on_outside: 'keep' }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = phase('bergen');
    assert.deepEqual([b.title, b.tabLabel, b.accommodation, b.dates], [fields.title, fields.tabLabel, fields.accommodation, fields.dates]);
  });

  test('history_id: only a positive whole number or a string of digits; everything looser → 400 invalid_history_id, nothing written', () => {
    const { db, structure, historyCount } = make(febConfig());
    const hid = plantOldWrite(db, 'bergen', { title: 'Bergen old' });
    assert.equal(hid, 1);
    const n = historyCount();
    for (const bad of [true, false, [1], ['1'], '0x1', ' 1 ', '1 ', '+1', '-1', '1.0', '1e0', '', 0, -1, 1.5, NaN, null, {}, { id: 1 }, '٣', Number.MAX_SAFE_INTEGER + 2]) {
      const r = structure.ops.revert('bergen', { history_id: bad }, 'alice');
      assert.deepEqual([r.status, r.body.error], [400, 'invalid_history_id'], `${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(historyCount(), n);
    assert.equal(structure.ops.revert('bergen', { history_id: 999 }, 'alice').body.error, 'history_entry_not_found');
    assert.equal(structure.ops.revert('bergen', { history_id: '1' }, 'alice').status, 200);
    assert.equal(structure.ops.revert('bergen', { history_id: 1 }, 'alice').status, 200);
    assert.equal(structure.ops.revert('bergen', { history_id: '0001' }, 'alice').status, 200, 'ASCII digits, leading zeros included');
  });
});

// ── (6) the referenced-id lookup does not re-read the plan on every call ────
function makeCounted(config) {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT, type TEXT, name TEXT, date_from TEXT,
      date_to TEXT, confirmation TEXT, pin TEXT, notes TEXT, location_url TEXT, review_status TEXT DEFAULT 'approved');
    CREATE TABLE phase_plan_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT, date TEXT, text_he TEXT);
    CREATE TABLE phase_plan_days (phase_id TEXT, date TEXT, label_he TEXT, label_en TEXT, PRIMARY KEY (phase_id, date));
  `);
  const scans = { rows: 0, sql: 0 };
  // Every statement that reads a row table the lookup consults is counted when it runs.
  const counting = (stmt) => new Proxy(stmt, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== 'function') return v;
      if (['get', 'all', 'iterate'].includes(key)) return (...args) => { scans.sql++; return v.apply(target, args); };
      return v.bind(target);
    },
  });
  const db = new Proxy(raw, {
    get(target, key) {
      if (key === 'prepare') return (sql) => { const st = target.prepare(sql); return /phase_plan_items|phase_plan_days|\bbookings\b/.test(sql) ? counting(st) : st; };
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const journey = fakeJourney();
  const activeRows = journey.activeRows.bind(journey);
  journey.activeRows = () => { scans.rows++; return activeRows(); };
  const base = clone(config);
  const structure = createTripStructure({ db, baseConfig: () => base, journey: () => journey, queuePhaseReview: () => {} });
  const reset = () => { scans.rows = 0; scans.sql = 0; };
  return { raw, structure, journey, scans, reset };
}

describe('(6) an open-days-N lookup is answered from a cached set, not a scan per call', () => {
  function orphaned() {
    const ctx = makeCounted(openDaysConfig());
    const { structure, journey } = ctx;
    assert.equal(structure.ops.update('florence', { dates: { start: '2027-03-06', end: '2027-03-07' } }, 'alice').status, 200);
    journey.rows.items.push(planItem('open-days-2', '2027-03-09', 'item-od2'));
    journey.changes++;
    assert.equal(structure.ops.update('florence', { dates: { start: '2027-03-06', end: '2027-03-10' } }, 'alice').status, 200);
    return ctx;
  }

  test('after one lookup, lookups of ids nothing names (open-days-9999, -1000.., -3) and of the referenced one do ZERO row scans', () => {
    const { structure, scans, reset } = orphaned();
    assert.equal(structure.isPhase('open-days-9999'), false, 'warm-up');
    reset();
    for (let i = 0; i < 50; i++) {
      assert.equal(structure.isPhase('open-days-9999'), false);
      assert.equal(structure.isPhase(`open-days-${1000 + i}`), false);
      assert.equal(structure.isPhase('open-days-3'), false);
      assert.equal(structure.isPhase('open-days-2'), true);
    }
    assert.deepEqual(scans, { rows: 0, sql: 0 }, 'no plan read and no row query on a warm lookup');
  });

  test('the first lookup after a change reads once, for every id — not once per id', () => {
    const { structure, journey, scans, reset } = orphaned();
    journey.changes++;
    reset();
    for (const id of ['open-days-9999', 'open-days-7', 'open-days-2', 'open-days-12']) structure.isPhase(id);
    assert.ok(scans.rows <= 2, `plan read ${scans.rows} times`);
    assert.ok(scans.sql <= 3, `row queries: ${scans.sql}`);
  });

  test('still correct: the id lapses right after its last row moves away, and a booking or a Classic row filed under it brings it back', () => {
    const { raw, structure, journey } = orphaned();
    assert.equal(structure.isPhase('open-days-2'), true);
    journey.rows.items = journey.rows.items.map(i => ({ ...i, phase_id: 'florence' }));
    journey.changes++;
    assert.equal(structure.isPhase('open-days-2'), false, 'nothing names it any more');
    raw.prepare("INSERT INTO bookings (phase, type, name) VALUES ('open-days-2', 'other', 'Ferry')").run();
    assert.equal(structure.isPhase('open-days-2'), true, 'a booking filed under it (no journey change)');
    raw.prepare('DELETE FROM bookings').run();
    assert.equal(structure.isPhase('open-days-2'), false);
    raw.prepare("INSERT INTO phase_plan_items (phase_id, date, text_he) VALUES ('open-days-2', '2027-03-09', 'x')").run();
    assert.equal(structure.isPhase('open-days-2'), true, 'a Classic plan row');
    raw.prepare('DELETE FROM phase_plan_items').run();
    raw.prepare("INSERT INTO phase_plan_days (phase_id, date, label_he, label_en) VALUES ('open-days-2', '2027-03-09', NULL, NULL)").run();
    assert.equal(structure.isPhase('open-days-2'), false, 'an empty Classic day row names nothing');
    raw.prepare("UPDATE phase_plan_days SET label_en = 'Day trip'").run();
    assert.equal(structure.isPhase('open-days-2'), true, 'a Classic headline does');
  });
});

// ── over HTTP ───────────────────────────────────────────────────────────────
const AGENT_KEY = 'agent-key-review-fixes';

function httpConfig() {
  return {
    meta: { title: 'Review fixes', brand: 'REVIEW', departure: '2027-02-01', returnDate: '2027-03-10', totalDays: 38, deploymentNonce: 'stop-review-fixes', defaultLang: 'he' },
    participants: [{ username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' }],
    phases: [
      // (1): a hand-authored phase with top-level start/end.
      { id: 'legacy', title: { he: 'ישן', en: 'Legacy' }, tabLabel: 'LEGACY', start: '2027-02-01', end: '2027-02-05' },
      { id: 'a', title: { he: 'א', en: 'A' }, tabLabel: 'A', dates: { start: '2027-02-05', end: '2027-02-10' } },
      { id: 'b', title: { he: 'ב', en: 'B' }, tabLabel: 'B', dates: { start: '2027-02-10', end: '2027-02-15' } },
      { id: 'mid', title: { he: 'אמצע', en: 'Mid' }, tabLabel: 'MID' },
      { id: 'open-days', unplanned: true, title: { he: 'ימים שעוד לא תוכננו', en: 'Days not planned yet' }, tabLabel: '?',
        dates: { start: '2027-02-16', end: '2027-03-10' }, note: { he: '23', en: '23' } },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

async function boot(port) {
  const dataDir = mkdtempSync(join(tmpdir(), 'stop-review-fixes-'));
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
    dataDir,
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

describe('over HTTP: the four review scenarios on a real trip server', () => {
  let server, alice;
  const config = async () => (await server.call('/api/config', { token: alice })).body;
  const phaseOf = async (id) => (await config()).phases.find(p => p.id === id);

  before(async () => {
    server = await boot(PORTS.stopReviewFixes);
    alice = await server.login('alice');
  });
  after(async () => { await server?.stop(); });

  // First: the open-days numbering depends on which days the other stops cover.
  test('(2) a plan row under open-days-2 stays reachable after the gap recomputes to open-days', async () => {
    // Date `mid` inside the open days: 02-16..02-19 | mid 02-20..02-22 | 02-23..03-10.
    const mid = await server.call('/api/stops/mid', { method: 'PATCH', token: alice, body: { dates: { start: '2027-02-20', end: '2027-02-22' } } });
    assert.equal(mid.status, 200, mid.text);
    assert.deepEqual((await phaseOf('open-days-2'))?.dates, { start: '2027-02-23', end: '2027-03-10' });
    // A Classic plan row and an itinerary item under open-days-2.
    const classic = await server.call('/api/phases/open-days-2/plan', { method: 'POST', token: alice,
      body: { date: '2027-02-25', text_he: 'שוק', text_en: 'Market' } });
    assert.equal(classic.status, 201, classic.text);
    const item = await server.call('/api/itinerary/items', { method: 'POST', token: alice,
      body: { phase_id: 'open-days-2', date: '2027-02-26', text_he: 'מוזיאון', text_en: 'Museum' } });
    assert.equal(item.status, 201, item.text);

    // Extend `mid` to the trip's end: the only gap left is 02-16..02-19 → open-days.
    const extend = await server.call('/api/stops/mid', { method: 'PATCH', token: alice, body: { dates: { start: '2027-02-20', end: '2027-03-10' } } });
    assert.equal(extend.status, 200, extend.text);
    const ids = (await config()).phases.map(p => p.id);
    assert.ok(ids.includes('open-days') && !ids.includes('open-days-2'), `no phantom phase: ${ids}`);

    const plan = await server.call('/api/phases/open-days-2/plan', { token: alice });
    assert.equal(plan.status, 200, plan.text);
    assert.ok(plan.body.some(r => r.text_en === 'Market'));
    const patch = await server.call(`/api/phases/open-days-2/plan/${classic.body.id}`, { method: 'PATCH', token: alice, body: { text_en: 'Old market' } });
    assert.equal(patch.status, 200, patch.text);
    const del = await server.call(`/api/phases/open-days-2/plan/${classic.body.id}`, { method: 'DELETE', token: alice });
    assert.equal(del.status, 200, del.text);

    // Still non-editable as a stop.
    const edit = await server.call('/api/stops/open-days-2', { method: 'PATCH', token: alice, body: { title: 'x' } });
    assert.deepEqual([edit.status, edit.body.error], [400, 'unplanned_stop_is_computed']);

    // move-day from it to a real stop works, and then it is gone.
    const move = await server.call('/api/itinerary/move-day', { method: 'POST', token: alice,
      body: { from_phase_id: 'open-days-2', to_phase_id: 'mid', date: '2027-02-26' } });
    assert.equal(move.status, 200, move.text);
    const after = await server.call('/api/phases/open-days-2/plan', { token: alice });
    assert.deepEqual([after.status, after.body.error], [400, 'unknown phase'], 'nothing names it any more');
  });

  test('(1) PATCH dates:null on a legacy stop → /api/config serves no start/end keys', async () => {
    const r = await server.call('/api/stops/legacy', { method: 'PATCH', token: alice, body: { dates: null } });
    assert.equal(r.status, 200, r.text);
    const p = await phaseOf('legacy');
    for (const key of ['start', 'end', 'dates']) assert.equal(Object.hasOwn(p, key), false, `${key} absent (was ${JSON.stringify(p[key])})`);
  });

  test('(4) PATCH 2027-02-30..2027-03-02 → 400 invalid_dates, February 30 never stored', async () => {
    const r = await server.call('/api/stops/b', { method: 'PATCH', token: alice, body: { dates: { start: '2027-02-30', end: '2027-03-02' } } });
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_dates'], r.text);
    assert.deepEqual((await phaseOf('b')).dates, { start: '2027-02-10', end: '2027-02-15' });
    const split = await server.call('/api/stops/b/split', { method: 'POST', token: alice, body: { at: '2027-02-30', new_stop: { title: 'X' } } });
    assert.deepEqual([split.status, split.body.error], [400, 'invalid_split_date']);
  });

  test('(3) link to A, revert A, link to B, restore A\'s link → 409 booking_linked_to_another_stop, no mutation', async () => {
    const add = await server.call('/api/bookings', { method: 'POST', token: alice,
      body: { type: 'hotel', phase: 'general', name: 'Trip-wide Hotel', date_from: '2027-02-06', date_to: '2027-02-09' } });
    assert.equal(add.status, 200, add.text);
    const hotel = add.body.id;
    assert.equal((await server.call('/api/stops/a/from-booking', { method: 'POST', token: alice, body: { booking_id: hotel, create_items: false } })).status, 200);
    const linkedRow = (await server.call('/api/stops/a/history', { token: alice })).body.history.filter(h => h.action === 'from_booking').at(-1).id;
    assert.equal((await server.call('/api/stops/a/revert', { method: 'POST', token: alice, body: {} })).status, 200);
    const toB = await server.call('/api/stops/b/from-booking', { method: 'POST', token: alice, body: { booking_id: hotel, create_items: false, on_outside: 'keep' } });
    assert.equal(toB.status, 200, toB.text);

    const revBefore = (await server.call('/api/stops', { token: alice })).body.revision;
    const r = await server.call('/api/stops/a/revert', { method: 'POST', token: alice, body: { history_id: linkedRow, on_outside: 'keep' } });
    assert.deepEqual([r.status, r.body.error, r.body.stop], [409, 'booking_linked_to_another_stop', 'b'], r.text);
    const stops = (await server.call('/api/stops', { token: alice })).body;
    assert.equal(stops.revision, revBefore, 'no history row, no new revision');
    assert.equal(stops.stops.find(s => s.id === 'a').override, null);
    assert.equal(stops.stops.find(s => s.id === 'b').override.booking_id, hotel);
    // Re-linking A from the booking agrees with the refusal.
    const relink = await server.call('/api/stops/a/from-booking', { method: 'POST', token: alice, body: { booking_id: hotel } });
    assert.deepEqual([relink.status, relink.body.error], [409, 'booking_linked_to_another_stop']);
  });

  test('(5) a snapshot a pre-PR server stored (U+2063, U+3164, U+2800, U+00AD, Feb 30) → restore 400 history_entry_invalid; members see nothing of it', async () => {
    // Planted as the old server would have left them: the override and its history row.
    const db = new Database(join(server.dataDir, 'trip.db'));
    let hid;
    try {
      hid = plantOldWrite(db, 'legacy', { title: `Legacy${ch(0x2063)}`, tabLabel: ch(0x3164),
        accommodation: { name: `Hotel${ch(0x2800)}`, note: `a${ch(0x00AD)}b` }, dates: { start: '2027-02-11', end: '2027-02-30' } });
    } finally { db.close(); }
    // The organizer cleans the stop up from today's server.
    assert.equal((await server.call('/api/stops/legacy/revert', { method: 'POST', token: alice, body: {} })).status, 200);
    const stopsBefore = (await server.call('/api/stops', { token: alice })).body;
    const configBefore = (await server.call('/api/config', { token: alice })).text;

    const r = await server.call('/api/stops/legacy/revert', { method: 'POST', token: alice, body: { history_id: hid, on_outside: 'keep' } });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.error, 'history_entry_invalid');
    assert.equal(r.body.history_id, hid);
    assert.ok(['title', 'tabLabel', 'dates', 'accommodation.name', 'accommodation.note'].includes(r.body.field), r.text);
    const stopsAfter = (await server.call('/api/stops', { token: alice })).body;
    assert.equal(stopsAfter.revision, stopsBefore.revision, 'no history row, no new revision');
    assert.equal((await server.call('/api/config', { token: alice })).text, configBefore, 'the served config is unchanged');

    const loose = await server.call('/api/stops/legacy/revert', { method: 'POST', token: alice, body: { history_id: true } });
    assert.deepEqual([loose.status, loose.body.error], [400, 'invalid_history_id'], loose.text);
  });

});
