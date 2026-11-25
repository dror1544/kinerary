/**
 * recent-changes.test.js — "what changed in the last 24 hours" for the plan
 * (video Release 1B; docs/specs/sprint-9/x-video-r1-site-look.md, AC-14..AC-18,
 * AC-22's expiry, AC-24, AC-3).
 *
 * server/recent-changes.js derives the marker from itinerary_plan_versions with no
 * new table. These tests build real plan versions through the same path every plan
 * write takes (journey.applyChange -> cloneWith), then place each version in time
 * by rewriting its created_at — the immutability trigger is dropped in the test db
 * only, which is also how a clock is injected without waiting a day.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test, { describe } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { create } = require('../server/living-journey.js');
const { recentChanges, diffPlanVersions, DIFF_ITEM_KEYS, RECENT_CHANGE_KEYS, WINDOW_MS } = require('../server/recent-changes.js');
const { FEATURE_SWITCHES, SURFACES, findSwitch } =require('../shared/feature-switches.js');

const NOW = Date.parse('2026-11-16T12:00:00Z');
const H = 3600_000;
const sqliteTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function fixtureConfig() {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
}

// A trip whose original + first active version are `ageMs` old, then one edit per call.
function trip({ ageMs = 30 * 24 * H } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trip_config_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, content TEXT, hash TEXT);
    CREATE TABLE phase_plan_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT, date TEXT, time TEXT, text_he TEXT, text_en TEXT, location_url TEXT, booking_id INTEGER, status TEXT, sort_order REAL, created_by TEXT, created_at TEXT, waze_url TEXT, website_url TEXT, ticket_url TEXT, enrichment_status TEXT, time_sort INTEGER, config_ref TEXT, extra_links TEXT, itinerary_item_uid TEXT, keep_both_with TEXT);
    CREATE UNIQUE INDEX phase_plan_items_uid ON phase_plan_items(itinerary_item_uid) WHERE itinerary_item_uid IS NOT NULL;
    CREATE TABLE phase_plan_days (phase_id TEXT, date TEXT, label_he TEXT, label_en TEXT, enrichment_status TEXT, itinerary_day_key TEXT, PRIMARY KEY (phase_id, date));
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, date_from TEXT, date_to TEXT, confirmation TEXT, conf_file TEXT, location_url TEXT, google_wallet_url TEXT, apple_wallet_url TEXT, pkpass_file TEXT, review_status TEXT DEFAULT 'approved');
  `);
  const config = fixtureConfig();
  const journey = create({ db, config, raw: JSON.stringify(config), mediaDir: tmpdir(), fetchImpl: fetch });
  db.exec('DROP TRIGGER itinerary_versions_no_update');
  const stamp = db.prepare('UPDATE itinerary_plan_versions SET created_at = ? WHERE revision_id = ?');
  for (const v of db.prepare('SELECT revision_id FROM itinerary_plan_versions').all()) stamp.run(sqliteTime(NOW - ageMs), v.revision_id);
  const edit = (agoMs, transform, author = 'organizer-secret-name') => {
    const id = journey.applyChange(author, 'a private note', transform);
    stamp.run(sqliteTime(NOW - agoMs), id);
    return id;
  };
  const item = (needle) => journey.activeRows().items.find((i) => i.text_en === needle);
  const marks = (opts = {}) => recentChanges(db, { now: NOW, ...opts });
  return { db, journey, edit, item, marks };
}

const setTime = (needle, time) => (rows) => {
  const row = rows.items.find((i) => i.text_en === needle);
  row.time = time;
  row.time_sort = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
};

describe('the marker (AC-14, AC-15)', () => {
  test('AC-14: 20:00 -> 19:00 one hour ago is an updated item with previous_time, and nothing else is marked', () => {
    const t = trip();
    t.edit(30 * H, setTime('Visit Central Park', '20:00')); // outside the window: becomes the baseline
    const park = t.item('Visit Central Park').item_uid;
    t.edit(H, setTime('Visit Central Park', '19:00'));
    const marks = t.marks();
    assert.deepEqual([...marks.keys()], [park]);
    assert.deepEqual(marks.get(park), {
      kind: 'updated',
      at: new Date(NOW - H).toISOString().slice(0, 19) + 'Z',
      fields: ['time'],
      previous_time: '20:00',
    });
  });

  test('AC-15: an item added an hour ago is {kind: added, at, fields: []}', () => {
    const t = trip();
    t.edit(H, (rows) => {
      rows.items.push({ ...rows.items[0], item_uid: 'item_new', source_ref: 'item_new', text_en: 'Rooftop drinks', text_he: 'ברכה', created_by: 'organizer-secret-name' });
    });
    assert.deepEqual(t.marks().get('item_new'), { kind: 'added', at: new Date(NOW - H).toISOString().slice(0, 19) + 'Z', fields: [] });
  });

  test('AC-15: a change made 25 hours ago and not since carries no marker', () => {
    const t = trip();
    t.edit(25 * H, setTime('Visit Central Park', '19:00'));
    assert.equal(t.marks().size, 0);
  });

  test('AC-15: changed and changed back inside the window carries no marker', () => {
    const t = trip();
    const original = t.item('Visit Central Park').time;
    t.edit(3 * H, setTime('Visit Central Park', '19:00'));
    t.edit(H, setTime('Visit Central Park', original));
    assert.equal(t.marks().size, 0);
  });

  test('a later edit inside the window keeps the earliest previous value and stamps the newest change', () => {
    const t = trip();
    t.edit(30 * H, setTime('Visit Central Park', '20:00'));
    t.edit(5 * H, setTime('Visit Central Park', '19:30'));
    t.edit(2 * H, setTime('Visit Central Park', '19:00'));
    const m = t.marks().get(t.item('Visit Central Park').item_uid);
    assert.equal(m.previous_time, '20:00');
    assert.equal(m.at, new Date(NOW - 2 * H).toISOString().slice(0, 19) + 'Z');
  });

  test('an item added and then edited inside the window is still added, stamped at the edit', () => {
    const t = trip();
    t.edit(5 * H, (rows) => { rows.items.push({ ...rows.items[0], item_uid: 'item_new', source_ref: 'item_new', text_en: 'Rooftop drinks' }); });
    t.edit(2 * H, (rows) => { rows.items.find((i) => i.item_uid === 'item_new').text_en = 'Rooftop drinks, late'; });
    const m = t.marks().get('item_new');
    assert.equal(m.kind, 'added');
    assert.deepEqual(m.fields, []);
    assert.equal(m.at, new Date(NOW - 2 * H).toISOString().slice(0, 19) + 'Z');
  });

  test('the key set is closed: kind, at, fields, previous_time, previous_date', () => {
    assert.deepEqual([...RECENT_CHANGE_KEYS].sort(), ['at', 'fields', 'kind', 'previous_date', 'previous_time']);
  });
});

describe('tracked fields (AC-17, AC-18)', () => {
  test('title, place and type are tracked, in a stable order', () => {
    const t = trip();
    t.edit(H, (rows) => {
      const r = rows.items.find((i) => i.text_en === 'Visit Central Park');
      r.text_en = 'Central Park walk'; r.location_url = 'https://maps.example/park'; r.item_type = 'meal';
    });
    const m = t.marks().get(t.item('Central Park walk').item_uid);
    assert.deepEqual(m.fields, ['title', 'place', 'type']);
    assert.ok(!('previous_time' in m) && !('previous_date' in m));
  });

  test('AC-17: an item moved to another day carries date and previous_date', () => {
    const t = trip();
    const before = t.item('Visit Central Park').date;
    t.edit(H, (rows) => { rows.items.find((i) => i.text_en === 'Visit Central Park').date = '2027-03-12'; });
    const m = t.marks().get(t.item('Visit Central Park').item_uid);
    assert.deepEqual(m.fields, ['date']);
    assert.equal(m.previous_date, before);
    assert.equal(m.kind, 'updated');
  });

  test('AC-18: website, ticket, booking, confirmation, duration, order and extra links never mark an item', () => {
    const t = trip();
    t.edit(H, (rows) => {
      const r = rows.items.find((i) => i.text_en === 'Visit Central Park');
      r.website_url = 'https://example.com'; r.ticket_url = 'https://example.com/t'; r.booking_id = 7;
      r.confirmation_state = 'verified'; r.duration_minutes = 90; r.sort_order = 99;
      r.extra_links = JSON.stringify([{ label: 'x', url: 'https://example.com/x' }]);
    });
    assert.equal(t.marks().size, 0);
  });
});

describe('the baseline and the window (AC-16, AC-22)', () => {
  test('AC-16: a trip whose whole history is younger than the window marks none of the original items', () => {
    const t = trip({ ageMs: 10 * 60_000 });
    assert.equal(t.marks().size, 0);
  });

  test('AC-16: ...but an edit on that young trip still marks the edited item against the original plan', () => {
    const t = trip({ ageMs: 3 * H });
    t.edit(H, setTime('Visit Central Park', '19:00'));
    const m = t.marks().get(t.item('Visit Central Park').item_uid);
    assert.equal(m.kind, 'updated');
    assert.equal(m.previous_time, '11:00');
    assert.equal(t.marks().size, 1);
  });

  test('AC-16: the first-boot rewrite (written by the system, seconds after the original) is the plan as built, not an edit', () => {
    const t = trip({ ageMs: 3 * H });
    t.edit(3 * H - 1000, (rows) => { rows.items.find((i) => i.text_en === 'Early departure').text_en = '06:30–07:00 — Early departure'; }, 'legacy-promote-config-days');
    assert.equal(t.marks().size, 0);
    // ...and a person editing seconds after the build is still marked: nothing about timing hides them.
    t.edit(3 * H - 2000, setTime('Visit Central Park', '19:00'), 'organizer-secret-name');
    assert.deepEqual([...t.marks().keys()], [t.item('Visit Central Park').item_uid]);
  });

  test('AC-22: a marker leaves at the next read once its version is past the window, with no write', () => {
    const t = trip();
    t.edit(23 * H + 50 * 60_000, setTime('Visit Central Park', '19:00'));
    assert.equal(t.marks({ now: NOW }).size, 1);
    assert.equal(t.marks({ now: NOW + 20 * 60_000 }).size, 0);
  });

  test('a window can be narrowed (the argument is real, the default is 24 hours)', () => {
    assert.equal(WINDOW_MS, 24 * H);
    const t = trip();
    t.edit(2 * H, setTime('Visit Central Park', '19:00'));
    assert.equal(t.marks({ windowMs: H }).size, 0);
    assert.equal(t.marks({ windowMs: 3 * H }).size, 1);
  });

  test('the result is memoised per (active revision, minute) and recomputed after a new revision', () => {
    const t = trip();
    t.edit(H, setTime('Visit Central Park', '19:00'));
    const first = t.marks();
    assert.equal(t.marks(), first, 'same revision and minute: the same Map');
    t.edit(60_000, setTime('Breakfast', '08:00'));
    assert.notEqual(t.marks(), first);
    assert.equal(t.marks().size, 2);
  });

  test('the walk is bounded at 200 versions and still answers', () => {
    const t = trip({ ageMs: 5 * H });
    for (let i = 0; i < 205; i++) t.edit(4 * H - i * 1000, setTime('Visit Central Park', i % 2 ? '10:00' : '10:30'));
    const m = t.marks();
    assert.ok(m instanceof Map);
  });
});

describe('what the marker must never carry (AC-23, AC-24)', () => {
  test('no author, note or revision id anywhere in the result', () => {
    const t = trip();
    t.edit(H, setTime('Visit Central Park', '19:00'), 'organizer-secret-name');
    const body = JSON.stringify([...t.marks().values()]);
    assert.doesNotMatch(body, /organizer-secret-name|a private note|active_|original_|rev_/);
  });

  test('author is read only to classify a version as system or person; note and created_by are never read', () => {
    const src = readFileSync(join(HERE, '..', 'server', 'recent-changes.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, /\bnote\b|created_by/);
    const lines = src.split('\n').filter((line) => /\bauthor\b/.test(line));
    // the select, the classifier call, and the classifier's own parameter — nothing builds output from it
    assert.ok(lines.length > 0 && lines.every((line) => /SELECT .*author|isSystemAuthor|\(author\)|has\(author\)|typeof author/.test(line)), lines.join('\n'));
    assert.doesNotMatch(src, /\bauthor\s*[:,]\s*(row|version)|\.author\b[^)]*\bresult\b/);
  });

  test('AC-24: attaching an unapproved booking to an item produces no marker', () => {
    const t = trip();
    t.db.prepare("INSERT INTO bookings (type, name, review_status) VALUES ('hotel', 'Draft hotel', 'draft')").run();
    const bookingId = t.db.prepare('SELECT id FROM bookings').get().id;
    t.edit(H, (rows) => { rows.items.find((i) => i.text_en === 'Visit Central Park').booking_id = bookingId; });
    assert.equal(t.marks().size, 0);
  });

  test('a database with no itinerary state answers with no markers', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE trip_itinerary_state (id INTEGER PRIMARY KEY, original_version_id TEXT, active_version_id TEXT); CREATE TABLE itinerary_plan_versions (revision_id TEXT PRIMARY KEY, parent_revision_id TEXT, created_at TEXT); CREATE TABLE itinerary_plan_items (revision_id TEXT, item_uid TEXT)');
    assert.equal(recentChanges(db, { now: NOW }).size, 0);
  });
});

describe('system writers do not mark (Dror, 2026-11-16)', () => {
  const enrich = (needle) => (rows) => {
    const r = rows.items.find((i) => i.text_en === needle);
    r.location_url = 'https://maps.example/enriched';
    r.text_he = `${r.text_he} (מועשר)`;
  };

  test('an enrichment-only change in the first 24 hours marks nothing', () => {
    const t = trip({ ageMs: 5 * H });
    t.edit(2 * H, enrich('Visit Central Park'), 'enrichment');
    t.edit(H, (rows) => { rows.items.find((i) => i.text_en === 'Breakfast').waze_url = 'https://waze.com/ul?q=b'; }, 'enrichment');
    assert.equal(t.marks().size, 0);
  });

  test('every automatic writer in the closed set is skipped', () => {
    const { SYSTEM_AUTHORS } = require('../server/recent-changes.js');
    assert.deepEqual([...SYSTEM_AUTHORS].sort(), ['config', 'config-reconcile', 'enrichment', 'legacy-plan', 'legacy-promote-config-days']);
    for (const author of SYSTEM_AUTHORS) {
      const t = trip({ ageMs: 5 * H });
      t.edit(H, setTime('Visit Central Park', '19:00'), author);
      assert.equal(t.marks().size, 0, author);
    }
  });

  test('a person\'s change after enrichment still marks, with only the person\'s field and the value before it', () => {
    const t = trip({ ageMs: 5 * H });
    t.edit(3 * H, enrich('Visit Central Park'), 'enrichment');
    t.edit(H, setTime('Visit Central Park', '19:00'), 'organizer-secret-name');
    const m = t.marks().get(t.item('Visit Central Park').item_uid);
    assert.deepEqual(m, { kind: 'updated', at: new Date(NOW - H).toISOString().slice(0, 19) + 'Z', fields: ['time'], previous_time: '11:00' });
  });

  test('enrichment after a person\'s change leaves that marker as it was (same at, same fields)', () => {
    const t = trip({ ageMs: 5 * H });
    t.edit(3 * H, setTime('Visit Central Park', '19:00'), 'hermes');
    const first = t.marks().get(t.item('Visit Central Park').item_uid);
    t.edit(H, enrich('Visit Central Park'), 'enrichment');
    assert.deepEqual(t.marks().get(t.item('Visit Central Park').item_uid), first);
  });

  test('a person adding an item is New even when enrichment then fills it in', () => {
    const t = trip({ ageMs: 5 * H });
    t.edit(3 * H, (rows) => { rows.items.push({ ...rows.items[0], item_uid: 'item_new', source_ref: 'item_new', text_en: 'Rooftop drinks' }); }, 'hermes');
    t.edit(H, (rows) => { rows.items.find((i) => i.item_uid === 'item_new').location_url = 'https://maps.example/roof'; }, 'enrichment');
    const m = t.marks().get('item_new');
    assert.deepEqual({ kind: m.kind, fields: m.fields, at: m.at }, { kind: 'added', fields: [], at: new Date(NOW - 3 * H).toISOString().slice(0, 19) + 'Z' });
  });

  test('a Classic-site edit (legacy-plan-update) and the agent key are people: they mark', () => {
    for (const author of ['legacy-plan-update', 'hermes', 'config-accept-seed']) {
      const t = trip({ ageMs: 5 * H });
      t.edit(H, setTime('Visit Central Park', '19:00'), author);
      assert.equal(t.marks().size, 1, author);
    }
  });
});

describe('the registry (AC-3)', () => {
  for (const name of ['plan_change_marks']) {
    test(`${name}: site surface, member-visible, with a one-line summary`, () => {
      const entry = findSwitch(name);
      assert.ok(entry, `${name} is not registered`);
      assert.deepEqual([...entry.surfaces], ['site']);
      assert.equal(entry.memberVisible, true);
      assert.ok(entry.summary.length > 10 && !entry.summary.includes('\n'));
    });
  }
  test('site_video_layout is retired (2026-11-21): not registered, so it is off everywhere and cannot be set', () => {
    assert.equal(findSwitch('site_video_layout'), null);
  });
  test('plan_change_group_line (1C): control_plane, site and companion surfaces, member-visible for the organizer toggle', () => {
    const entry = findSwitch('plan_change_group_line');
    assert.ok(entry, 'plan_change_group_line is not registered');
    assert.deepEqual([...entry.surfaces], ['control_plane', 'site', 'companion']);
    assert.equal(entry.memberVisible, true);
    assert.ok(entry.summary.length > 10 && !entry.summary.includes('\n'));
    assert.ok(SURFACES.includes('control_plane'));
  });
  test('the registry still loads (its shape check ran at require time) and keeps delivery_probe first', () => {
    assert.equal(FEATURE_SWITCHES[0].name, 'delivery_probe');
    assert.deepEqual(FEATURE_SWITCHES.map((s) => s.name), ['delivery_probe', 'plan_change_marks', 'plan_change_group_line', 'whatsapp']);
  });
});

// ── diffPlanVersions: the one function a mark and the group line both come from ─────────
// (video Release 1C, x-video-r1-group-line.md AC-21, AC-18, AC-13, and the closed shape of AC-27)
describe('diffPlanVersions (1C)', () => {
  const activeId = (t) => t.db.prepare('SELECT active_version_id AS id FROM trip_itinerary_state WHERE id = 1').get().id;
  const uidOf = (t, needle) => t.item(needle).item_uid;
  const NONE = { known: true, updated: [], added: [], removed: [] };

  test('AC-21: the updated and added sets equal the site\'s marks between the same two revisions', () => {
    const t = trip();
    const base = activeId(t);
    t.edit(5 * H, setTime('Visit Central Park', '19:00'));
    t.edit(4 * H, (rows) => { rows.items.push({ ...rows.items[0], item_uid: 'item_new', source_ref: 'item_new', text_en: 'Rooftop drinks' }); });
    t.edit(3 * H, (rows) => { rows.items.find((i) => i.text_en === 'Breakfast').text_en = 'Late breakfast'; });
    const diff = diffPlanVersions(t.db, base, activeId(t));
    // The trip is younger than the window, so the marks' baseline is the original plan: `base`.
    const marks = t.marks();
    assert.equal(diff.known, true);
    assert.deepEqual(new Set(diff.updated.map((i) => i.item_uid)), new Set([...marks].filter(([, m]) => m.kind === 'updated').map(([uid]) => uid)));
    assert.deepEqual(new Set(diff.added.map((i) => i.item_uid)), new Set([...marks].filter(([, m]) => m.kind === 'added').map(([uid]) => uid)));
    assert.equal(diff.updated.length, 2);
    assert.equal(diff.added.length, 1);
  });

  test('a time change carries the new and the previous time and the title in both languages', () => {
    const t = trip();
    const base = activeId(t);
    t.edit(H, setTime('Visit Central Park', '19:00'));
    const diff = diffPlanVersions(t.db, base, activeId(t));
    assert.equal(diff.updated.length, 1);
    const [park] = diff.updated;
    assert.equal(park.item_uid, uidOf(t, 'Visit Central Park'));
    assert.deepEqual(park.fields, ['time']);
    assert.equal(park.time, '19:00');
    assert.equal(park.previous_time, '11:00');
    assert.equal(park.text_en, 'Visit Central Park');
    assert.ok(park.text_he);
  });

  test('a renamed and moved item carries the previous title and the previous date', () => {
    const t = trip();
    const base = activeId(t);
    const parkDate = t.item('Visit Central Park').date;
    t.edit(H, (rows) => {
      const r = rows.items.find((i) => i.text_en === 'Visit Central Park');
      r.text_en = 'Central Park walk';
      r.date = '2027-03-12';
    });
    const [park] = diffPlanVersions(t.db, base, activeId(t)).updated;
    assert.deepEqual(park.fields, ['date', 'title']);
    assert.equal(park.previous_date, parkDate);
    assert.equal(park.previous_text_en, 'Visit Central Park');
    assert.equal(park.text_en, 'Central Park walk');
  });

  test('AC-13: an item changed and changed back is in no list', () => {
    const t = trip();
    const base = activeId(t);
    const original = t.item('Visit Central Park').time;
    t.edit(3 * H, setTime('Visit Central Park', '19:00'));
    t.edit(2 * H, setTime('Visit Central Park', original));
    assert.deepEqual(diffPlanVersions(t.db, base, activeId(t)), NONE);
  });

  test('three edits to one time are one change, from the value the group last heard', () => {
    const t = trip();
    t.edit(5 * H, setTime('Visit Central Park', '20:00'));
    const heard = activeId(t);
    t.edit(3 * H, setTime('Visit Central Park', '19:30'));
    t.edit(2 * H, setTime('Visit Central Park', '19:00'));
    const diff = diffPlanVersions(t.db, heard, activeId(t));
    assert.equal(diff.updated.length, 1);
    assert.equal(diff.updated[0].previous_time, '20:00');
    assert.equal(diff.updated[0].time, '19:00');
  });

  test('AC-18: a removed item is in `removed` with its last text, date and time', () => {
    const t = trip();
    const base = activeId(t);
    const park = t.item('Visit Central Park');
    t.edit(H, (rows) => { rows.items = rows.items.filter((i) => i.text_en !== 'Visit Central Park'); });
    const diff = diffPlanVersions(t.db, base, activeId(t));
    assert.deepEqual(diff.updated, []);
    assert.equal(diff.removed.length, 1);
    assert.deepEqual(
      { uid: diff.removed[0].item_uid, text: diff.removed[0].text_en, date: diff.removed[0].date, time: diff.removed[0].time },
      { uid: park.item_uid, text: 'Visit Central Park', date: park.date, time: park.time },
    );
  });

  test('an item added and then removed, and one removed and put back unchanged, are in no list', () => {
    const t = trip();
    const base = activeId(t);
    t.edit(4 * H, (rows) => { rows.items.push({ ...rows.items[0], item_uid: 'item_new', source_ref: 'item_new', text_en: 'Rooftop drinks' }); });
    t.edit(3 * H, (rows) => { rows.items = rows.items.filter((i) => i.item_uid !== 'item_new'); });
    let removedRow;
    t.edit(2 * H, (rows) => { removedRow = rows.items.find((i) => i.text_en === 'Breakfast'); rows.items = rows.items.filter((i) => i.text_en !== 'Breakfast'); });
    t.edit(H, (rows) => { rows.items.push({ ...removedRow }); });
    assert.deepEqual(diffPlanVersions(t.db, base, activeId(t)), NONE);
  });

  test('system writers never produce a change (the same closed set as the marks)', () => {
    const t = trip();
    const base = activeId(t);
    for (const author of ['config', 'legacy-plan', 'legacy-promote-config-days', 'config-reconcile', 'enrichment']) {
      t.edit(H, setTime('Visit Central Park', author.length > 8 ? '18:00' : '17:00'), author);
    }
    assert.deepEqual(diffPlanVersions(t.db, base, activeId(t)), NONE);
  });

  test('a revision that is not in the active plan\'s chain is unknown, and describes nothing', () => {
    const t = trip();
    t.edit(H, setTime('Visit Central Park', '19:00'));
    const unknown = { known: false, updated: [], added: [], removed: [] };
    assert.deepEqual(diffPlanVersions(t.db, 'rev_does_not_exist', activeId(t)), unknown);
    assert.deepEqual(diffPlanVersions(t.db, activeId(t), null), unknown);
    assert.deepEqual(diffPlanVersions(t.db, activeId(t), activeId(t)), NONE);
  });

  test('AC-27: every entry carries only DIFF_ITEM_KEYS, and no author, note or created_by', () => {
    const t = trip();
    const base = activeId(t);
    t.edit(2 * H, setTime('Visit Central Park', '19:00'), 'organizer-secret-name');
    t.edit(H, (rows) => { rows.items.push({ ...rows.items[0], item_uid: 'item_new', source_ref: 'item_new', text_en: 'Rooftop drinks', created_by: 'organizer-secret-name' }); }, 'organizer-secret-name');
    const diff = diffPlanVersions(t.db, base, activeId(t));
    for (const entry of [...diff.updated, ...diff.added, ...diff.removed]) {
      for (const key of Object.keys(entry)) assert.ok(DIFF_ITEM_KEYS.includes(key), key);
    }
    const wire = JSON.stringify(diff);
    assert.ok(!/organizer-secret-name|a private note|created_by|author/.test(wire), wire);
    assert.deepEqual([...DIFF_ITEM_KEYS].sort(), ['at', 'date', 'fields', 'item_uid', 'previous_date', 'previous_text_en', 'previous_text_he', 'previous_time', 'text_en', 'text_he', 'time']);
  });
});
