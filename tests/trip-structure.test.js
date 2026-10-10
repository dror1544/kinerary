/**
 * trip-structure.test.js — the stop override layer (server/trip-structure.js),
 * without HTTP.
 *
 * The provisioner rewrites trip.config.json on every rebuild, so the trip's
 * structure — which stops exist, their dates, where the family sleeps — can
 * only be edited after the interview in the site's own SQLite, which survives
 * a rebuild. effectiveConfig() merges that layer over the config BEFORE
 * sanitizeConfig() sees it, so the allow-list is applied to the result exactly
 * as it always was.
 *
 * Three properties carry the design and are pinned here:
 *   1. empty layer = the config, unchanged (identity for a hand-authored trip,
 *      JSON-identical for a provisioned one);
 *   2. the unplanned "open-days" phases are COMPUTED from the stops and the
 *      planned days, never read from text baked at provisioning (F8);
 *   3. a write is all-or-nothing, and its history can only be appended to.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { projectConfig } from '../shared/config-visibility.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { createTripStructure } = require('../server/trip-structure.js');

const JAPAN = JSON.parse(readFileSync(join(HERE, '..', 'trips', 'japan-2025', 'trip.config.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

// The shape the 2026-10-10 manual run produced (run notes F3/F8): a base stop
// and two gateway stops, all undated, and the provisioner's open-days phase
// over the whole trip with its count written into the note.
function colmarConfig() {
  return {
    meta: { title: 'Alsace 2026', brand: 'ALSACE', departure: '2026-12-02T00:00:00+00:00', returnDate: '2026-12-07', totalDays: 6, defaultLang: 'he' },
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

// A journey stand-in: just the itinerary rows and a change hook.
function fakeJourney(rows = { days: [], items: [] }, { failChange = false } = {}) {
  return {
    rows,
    changes: 0,
    activeRows() { return clone(this.rows); },
    activeRevision() { return `rev-${this.changes}`; },
    applyChange(_author, _note, transform) {
      if (failChange) throw new Error('itinerary write failed mid-operation');
      const next = clone(this.rows);
      transform(next);
      this.rows = next;
      this.changes++;
      return `rev-${this.changes}`;
    },
    dayContext() { return { lodging_context: null, pickup_context: null }; },
  };
}

function make(config, journey = fakeJourney(), extra = {}) {
  const db = new Database(':memory:');
  // trip-structure checks references against these tables before removing a stop.
  db.exec(`
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT, type TEXT, name TEXT, date_from TEXT,
      date_to TEXT, confirmation TEXT, pin TEXT, notes TEXT, location_url TEXT, review_status TEXT DEFAULT 'approved');
    CREATE TABLE budget_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT);
    CREATE TABLE photos (id TEXT PRIMARY KEY, phase TEXT);
  `);
  let base = config;
  const reviewed = [];
  const structure = createTripStructure({
    db,
    baseConfig: () => base,
    journey: () => journey,
    queuePhaseReview: (id) => reviewed.push(id),
    ...extra,
  });
  return { db, structure, journey, reviewed, setBase: (next) => { base = next; } };
}

describe('empty override layer = the config, unchanged', () => {
  test('a hand-authored trip (no unplanned phase) is served as the very same object', () => {
    const { structure } = make(JAPAN);
    assert.equal(structure.effectiveConfig(), JAPAN);
  });

  test('a provisioned trip is JSON-identical, open-days phases included (both interview paths)', () => {
    const run = spawnSync('python3', [join(HERE, 'helpers', 'provisioned-config.py')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    for (const [name, cfg] of Object.entries(JSON.parse(run.stdout))) {
      assert.ok(cfg.phases.some(p => p.unplanned), `${name}: fixture should carry open-days phases`);
      // The provisioner's own day plan, as the boot-time import makes it the active plan.
      const days = cfg.phases.flatMap(p => (p.days || []).map(d => ({ phase_id: p.id, date: d.date })));
      const { structure } = make(cfg, fakeJourney({ days, items: [] }));
      assert.equal(JSON.stringify(structure.effectiveConfig()), JSON.stringify(cfg), name);
    }
  });

  test('the colmar shape is JSON-identical while nothing covers its days', () => {
    const cfg = colmarConfig();
    const { structure } = make(cfg);
    assert.equal(JSON.stringify(structure.effectiveConfig()), JSON.stringify(cfg));
  });
});

describe('open-days is computed from stops AND planned days (F8)', () => {
  const unplanned = (cfg) => cfg.phases.filter(p => p.unplanned);

  test('a plan on every day of the trip removes the "not assigned" phase entirely', () => {
    // Headlined days, no items: a headline is a plan for the day.
    const days = ['02', '03', '04', '05', '06', '07'].map(d => ({ phase_id: 'colmar', date: `2026-12-${d}`, label_en: `Day ${d}` }));
    const { structure } = make(colmarConfig(), fakeJourney({ days, items: [] }));
    assert.deepEqual(unplanned(structure.effectiveConfig()), []);
  });

  test('an empty day row — no item, no headline — is not a plan', () => {
    const days = [{ phase_id: 'colmar', date: '2026-12-04', label_he: null, label_en: null }];
    const { structure } = make(colmarConfig(), fakeJourney({ days, items: [] }));
    assert.match(unplanned(structure.effectiveConfig())[0].note.en, /^6 day\(s\) /);
  });

  test('a partial plan splits the gap, and each note counts its own days', () => {
    const items = [{ item_uid: 'i1', phase_id: 'colmar', date: '2026-12-04', text_he: 'שוק' }];
    const { structure } = make(colmarConfig(), fakeJourney({ days: [], items }));
    const gaps = unplanned(structure.effectiveConfig());
    assert.deepEqual(gaps.map(g => [g.id, g.dates.start, g.dates.end]),
      [['open-days-1', '2026-12-02', '2026-12-03'], ['open-days-2', '2026-12-05', '2026-12-07']]);
    assert.match(gaps[0].note.en, /^2 day\(s\) /);
    assert.match(gaps[1].note.en, /^3 day\(s\) /);
    assert.match(gaps[1].note.he, /^3 ימים /);
  });

  test('days planned on an unplanned phase are still unassigned — only a real stop covers a day', () => {
    const items = [{ item_uid: 'i1', phase_id: 'open-days', date: '2026-12-04', text_he: 'x' }];
    const { structure } = make(colmarConfig(), fakeJourney({ days: [], items }));
    const gaps = unplanned(structure.effectiveConfig());
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].note.en, /^6 day\(s\) /);
  });

  test('a config with no unplanned phase never sprouts one — open days are the provisioner\'s convention', () => {
    // japan-2025 departs on the evening of 5 Sep; a computed gap would call
    // the flight day "not assigned". Hand-authored trips are served as written.
    const { structure } = make(clone(JAPAN));
    assert.equal(structure.ops.update('tokyo', { dates: { start: '2026-09-07', end: '2026-09-10' } }, 'alice').status, 200);
    assert.deepEqual(structure.effectiveConfig().phases.filter(p => p.unplanned), []);
  });

  test('stop dates from an override cover their days', () => {
    const { structure } = make(colmarConfig());
    const r = structure.ops.update('colmar', { dates: { start: '2026-12-02', end: '2026-12-06' } }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const gaps = unplanned(structure.effectiveConfig());
    assert.deepEqual(gaps.map(g => [g.id, g.dates.start, g.dates.end]), [['open-days', '2026-12-07', '2026-12-07']]);
    assert.match(gaps[0].note.en, /^1 day\(s\) /);
  });
});

describe('merge', () => {
  test('dates and accommodation replace the base; stale display text and the base PIN do not survive', () => {
    const cfg = clone(JAPAN);
    cfg.phases[0].accommodation.pin = '4321';
    const { structure } = make(cfg);
    const r = structure.ops.update('tokyo', {
      dates: { start: '2026-09-06', end: '2026-09-09' },
      accommodation: { type: 'hotel', name: 'New Hotel', confirmation: 'NH-1' },
    }, 'alice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tokyo = structure.effectiveConfig().phases.find(p => p.id === 'tokyo');
    assert.deepEqual(tokyo.dates, { start: '2026-09-06', end: '2026-09-09' });
    assert.deepEqual(tokyo.accommodation, { type: 'hotel', name: 'New Hotel', confirmation: 'NH-1' });
    // Key order kept: the served JSON differs only where the override says.
    assert.deepEqual(Object.keys(tokyo), Object.keys(cfg.phases[0]));
    // The base object is never mutated.
    assert.equal(cfg.phases[0].accommodation.pin, '4321');
  });

  test('the override writes only allow-listed fields: projecting the effective config drops nothing new', () => {
    const cfg = colmarConfig();
    const { structure } = make(cfg);
    structure.ops.update('colmar', {
      dates: { start: '2026-12-02', end: '2026-12-06' },
      accommodation: { type: 'hotel', name: { he: 'מלון', en: 'Hotel' }, address: '1 Rue', location_url: 'https://maps.example/x' },
      title: { he: 'קולמר', en: 'Colmar (base)' },
    }, 'alice');
    structure.ops.split('colmar', { at: '2026-12-05', new_stop: { title: { he: 'שדה', en: 'Airport' }, tabLabel: 'AIRPORT', emoji: '✈️' } }, 'alice');
    assert.deepEqual(projectConfig(structure.effectiveConfig()).dropped, projectConfig(cfg).dropped);
  });

  test('an added stop is placed right after the stop it was split from, in chronological order', () => {
    const { structure } = make(colmarConfig());
    structure.ops.update('colmar', { dates: { start: '2026-12-02', end: '2026-12-07' } }, 'alice');
    assert.equal(structure.ops.split('colmar', { at: '2026-12-06', new_stop: { id: 'airport', title: 'Airport' } }, 'alice').status, 201);
    assert.equal(structure.ops.split('colmar', { at: '2026-12-04', new_stop: { id: 'riquewihr', title: 'Riquewihr' } }, 'alice').status, 201);
    const ids = structure.effectiveConfig().phases.map(p => p.id);
    assert.deepEqual(ids.slice(0, 5), ['frankfurt', 'colmar', 'riquewihr', 'airport', 'frankfurt2']);
    const byId = Object.fromEntries(structure.effectiveConfig().phases.map(p => [p.id, p.dates]));
    assert.deepEqual(byId.colmar, { start: '2026-12-02', end: '2026-12-04' });
    assert.deepEqual(byId.riquewihr, { start: '2026-12-04', end: '2026-12-06' });
    assert.deepEqual(byId.airport, { start: '2026-12-06', end: '2026-12-07' });
  });
});

describe('a re-provision that changes the base under an override (decision 2)', () => {
  test('the override wins and the conflict is reported to the organizer view only', () => {
    const cfg = colmarConfig();
    const ctx = make(cfg);
    ctx.structure.ops.update('colmar', { dates: { start: '2026-12-02', end: '2026-12-06' } }, 'alice');
    assert.equal(ctx.structure.listStops().stops.find(s => s.id === 'colmar').conflict, null);

    const rebuilt = clone(cfg);
    rebuilt.phases[1].dates = { start: '2026-12-03', end: '2026-12-05' };
    ctx.setBase(rebuilt);
    const colmar = ctx.structure.effectiveConfig().phases.find(p => p.id === 'colmar');
    assert.deepEqual(colmar.dates, { start: '2026-12-02', end: '2026-12-06' }, 'override wins');
    const listed = ctx.structure.listStops().stops.find(s => s.id === 'colmar');
    assert.deepEqual(listed.conflict.fields, ['dates']);
    assert.deepEqual(listed.conflict.base.dates, { start: '2026-12-03', end: '2026-12-05' });
    assert.ok(!JSON.stringify(ctx.structure.effectiveConfig()).includes('conflict'));

    // A rebuild that drops the stop leaves the override with nothing to apply
    // to: not served, and reported rather than silently gone.
    const dropped = clone(cfg);
    dropped.phases = dropped.phases.filter(p => p.id !== 'colmar');
    ctx.setBase(dropped);
    assert.ok(!ctx.structure.effectiveConfig().phases.some(p => p.id === 'colmar'));
    assert.deepEqual(ctx.structure.orphanedOverrides(), ['colmar']);
    assert.deepEqual(ctx.structure.listStops().orphaned_overrides, ['colmar']);

    // A rebuild that agrees with the override is not a conflict.
    const agreeing = clone(cfg);
    agreeing.phases[1].dates = { start: '2026-12-02', end: '2026-12-06' };
    ctx.setBase(agreeing);
    assert.equal(ctx.structure.listStops().stops.find(s => s.id === 'colmar').conflict, null);
  });
});

describe('writes are all-or-nothing, history is append-only', () => {
  test('a split whose itinerary half fails leaves no override and no history behind', () => {
    // An item after the split date, so the split has itinerary rows to move.
    const journey = fakeJourney({ days: [], items: [{ item_uid: 'fly', phase_id: 'colmar', date: '2026-12-07', text_he: 'טיסה' }] });
    const ctx = make(colmarConfig(), journey);
    ctx.structure.ops.update('colmar', { dates: { start: '2026-12-02', end: '2026-12-07' } }, 'alice');
    const before = ctx.db.prepare('SELECT COUNT(*) n FROM trip_stop_history').get().n;
    const overridesBefore = ctx.db.prepare('SELECT * FROM trip_stop_overrides ORDER BY phase_id').all();
    journey.applyChange = () => { throw new Error('boom'); };
    assert.throws(() => ctx.structure.ops.split('colmar', { at: '2026-12-06', new_stop: { title: 'Airport' } }, 'alice'), /boom/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM trip_stop_history').get().n, before);
    assert.deepEqual(ctx.db.prepare('SELECT * FROM trip_stop_overrides ORDER BY phase_id').all(), overridesBefore);
    assert.deepEqual(ctx.reviewed, []);
  });

  test('history rows cannot be updated or deleted', () => {
    const ctx = make(colmarConfig());
    ctx.structure.ops.update('colmar', { title: 'Colmar' }, 'alice');
    assert.throws(() => ctx.db.prepare("UPDATE trip_stop_history SET actor = 'mallory'").run(), /append-only/);
    assert.throws(() => ctx.db.prepare('DELETE FROM trip_stop_history').run(), /append-only/);
  });

  test('every write advances the revision, and a stale If-Match is refused with 409', () => {
    const ctx = make(colmarConfig());
    const r0 = ctx.structure.revision();
    assert.equal(ctx.structure.ops.update('colmar', { title: 'A' }, 'alice', r0).status, 200);
    const r1 = ctx.structure.revision();
    assert.notEqual(r0, r1);
    const stale = ctx.structure.ops.update('colmar', { title: 'B' }, 'alice', r0);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'stops_changed_reload_before_retry');
    assert.equal(ctx.structure.ops.update('colmar', { title: 'B' }, 'alice', `"${r1}"`).status, 200);
  });
});

describe('validation', () => {
  const { structure } = make(colmarConfig());
  const cases = [
    ['a PIN is never accepted', { accommodation: { name: 'H', pin: '1234' } }, 400, 'pin_not_accepted'],
    ['an unknown accommodation field is refused, not dropped', { accommodation: { name: 'H', door_code: 'x' } }, 400, 'unknown_accommodation_field'],
    ['an unknown body field is refused', { colour: 'red' }, 400, 'unknown_field'],
    ['a non-http link is refused', { accommodation: { name: 'H', location_url: 'javascript:alert(1)' } }, 400, 'invalid_accommodation'],
    ['reversed dates are refused', { dates: { start: '2026-12-05', end: '2026-12-03' } }, 400, 'invalid_dates'],
    ['dates outside the trip are refused (decision 4)', { dates: { start: '2026-12-01', end: '2026-12-03' } }, 400, 'dates_outside_trip'],
    ['an empty body is refused', {}, 400, 'no_fields'],
  ];
  for (const [name, body, status, error] of cases) {
    test(name, () => {
      const r = structure.ops.update('colmar', body, 'alice');
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.equal(r.body.error, error);
    });
  }
  test('an unplanned phase is computed, not editable', () => {
    const r = structure.ops.update('open-days', { title: 'x' }, 'alice');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'unplanned_stop_is_computed');
  });
  test('an unknown stop is 404', () => {
    assert.equal(structure.ops.update('nowhere', { title: 'x' }, 'alice').status, 404);
  });
});
