/**
 * plan-changes-limits.test.js — the group line's route answers INSIDE the poller's limits, however the plan was
 * written (video Release 1C, regression plan round 3: "one long title must not wedge a trip").
 *
 * The control plane's poller validates the route's body (control-plane/api/src/plan-change-poller.ts:
 * planChangesSchema). Before this, one 5,000-character title made the whole body invalid, and an invalid body means no
 * line for the trip, with nothing to say why, until the plan changes again. So the route itself cuts free text to 400
 * characters, leaves out a day or time that is not in the schema's shape, sends at most 200 changes (nearest day first)
 * and reports the rest as `changes_omitted`.
 *
 * The route is mounted for real (server/living-journey.js on an express app, `internal` replaced by a pass-through: its
 * gate is covered by plan-changes-route.test.js). Its responses are written to a fixture that the control plane's
 * contract test (control-plane/api/test/plan-changes-contract.test.ts) parses with the poller's schema, so the two
 * halves cannot drift apart without a test failing on one side. A route change that alters the fixture fails here until
 * the fixture is regenerated on purpose:
 *
 *     UPDATE_PLAN_CHANGES_FIXTURE=1 node --test tests/plan-changes-limits.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test, { describe, before, after } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const express = require('../server/node_modules/express');
const { create } = require('../server/living-journey.js');
const FIXTURE_PATH = join(HERE, '..', 'control-plane', 'api', 'test', 'fixtures', 'plan-changes-site-response.json');

const SINCE_TEXT = 'Visit Central Park';

function trip() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trip_config_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, content TEXT, hash TEXT);
    CREATE TABLE phase_plan_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT, date TEXT, time TEXT, text_he TEXT, text_en TEXT, location_url TEXT, booking_id INTEGER, status TEXT, sort_order REAL, created_by TEXT, created_at TEXT, waze_url TEXT, website_url TEXT, ticket_url TEXT, enrichment_status TEXT, time_sort INTEGER, config_ref TEXT, extra_links TEXT, itinerary_item_uid TEXT, keep_both_with TEXT);
    CREATE UNIQUE INDEX phase_plan_items_uid ON phase_plan_items(itinerary_item_uid) WHERE itinerary_item_uid IS NOT NULL;
    CREATE TABLE phase_plan_days (phase_id TEXT, date TEXT, label_he TEXT, label_en TEXT, enrichment_status TEXT, itinerary_day_key TEXT, PRIMARY KEY (phase_id, date));
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, date_from TEXT, date_to TEXT, confirmation TEXT, conf_file TEXT, location_url TEXT, google_wallet_url TEXT, apple_wallet_url TEXT, pkpass_file TEXT, review_status TEXT DEFAULT 'approved');
  `);
  const config = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
  const journey = create({ db, config, raw: JSON.stringify(config), mediaDir: tmpdir(), fetchImpl: fetch });
  return { db, journey };
}

let server;
let base;
let t;
before(async () => {
  t = trip();
  const app = express();
  const pass = (_req, _res, next) => next();
  t.journey.registerRoutes(app, { authRequired: pass, organizerOrAgentRequired: pass, internal: pass });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const activeId = () => t.db.prepare('SELECT active_version_id AS id FROM trip_itinerary_state WHERE id = 1').get().id;
const read = async (since) => (await fetch(`${base}/api/internal/control-plane/plan-changes?since=${since}`)).json();
const addItems = (rows, specs) => {
  for (const [i, spec] of specs.entries()) {
    rows.items.push({ ...rows.items[0], item_uid: `item_lim_${spec.id ?? i}`, source_ref: `item_lim_${spec.id ?? i}`, created_by: 'someone-private', ...spec.row });
  }
};
// The poller's limits (control-plane/api/src/plan-change-poller.ts), restated here on purpose: this file fails if the
// route stops fitting them, and the contract test fails if the schema stops matching these.
const LIMITS = { text: 400, changes: 200 };
const FUTURE = '2099-03-10';

describe('free text is cut to the schema\'s limit', () => {
  test('a 5,000-character title (and a previous title) is cut to 400 characters and ends in an ellipsis, in both languages', async () => {
    const since = activeId();
    const long = 'ארוחת ערב '.repeat(500);
    t.journey.applyChange('hermes', 'note', (rows) => addItems(rows, [{ id: 'long', row: { date: FUTURE, time: '19:00', text_he: long, text_en: 'x'.repeat(5000) } }]));
    const body = await read(since);
    const [entry] = body.changes;
    assert.equal(body.changes.length, 1);
    for (const key of ['text_he', 'text_en']) {
      assert.ok(entry[key].length <= LIMITS.text, `${key} is ${entry[key].length}`);
      assert.ok(entry[key].endsWith('…'), key);
    }
    assert.equal(body.changes_omitted, 0);
  });

  test('a rename carries a clipped previous title too', async () => {
    const since = activeId();
    t.journey.applyChange('hermes', 'note', (rows) => { rows.items.find((i) => i.item_uid === 'item_lim_long').text_en = 'y'.repeat(5000); });
    t.journey.applyChange('hermes', 'note', (rows) => { rows.items.find((i) => i.item_uid === 'item_lim_long').text_en = 'short'; });
    const body = await read(since);
    const renamed = body.changes.find((c) => c.kind === 'updated');
    assert.ok(renamed, JSON.stringify(body.changes.map((c) => c.kind)));
    assert.ok(renamed.previous_text_en.length <= LIMITS.text);
    assert.equal(renamed.text_en, 'short');
  });

  test('a clipped title never ends in half of an emoji', async () => {
    const since = activeId();
    // 399 code units of text, then an emoji (two code units) straddling the cut.
    t.journey.applyChange('hermes', 'note', (rows) => addItems(rows, [{ id: 'emoji', row: { date: FUTURE, time: '20:00', text_en: `${'a'.repeat(398)}😀😀`, text_he: 'x' } }]));
    const entry = (await read(since)).changes.find((c) => c.text_he === 'x');
    assert.ok(entry.text_en.length <= LIMITS.text);
    assert.doesNotMatch(entry.text_en, /[\ud800-\udbff]…?$/);
    assert.equal([...entry.text_en].every((ch) => ch.codePointAt(0) < 0xd800 || ch.codePointAt(0) > 0xdfff), true, 'no lone surrogate');
  });
});

describe('a day or time that is not in the schema\'s shape is left out, not sent', () => {
  test('a time that is neither HH:MM nor a rough word is null', async () => {
    const since = activeId();
    t.journey.applyChange('hermes', 'note', (rows) => addItems(rows, [{ id: 'oddtime', row: { date: FUTURE, time: '7pm', text_en: 'Odd time', text_he: 'שעה' } }]));
    const entry = (await read(since)).changes.find((c) => c.text_en === 'Odd time');
    assert.equal(entry.time, null);
  });
});

describe('at most 200 changes, nearest day first, the rest counted', () => {
  test('250 new items: 200 are sent, the 50 furthest are changes_omitted, and the order is by day then time', async () => {
    const since = activeId();
    const specs = Array.from({ length: 250 }, (_, i) => ({
      id: `bulk${i}`,
      row: { date: `2099-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`, time: `${String(8 + (i % 12)).padStart(2, '0')}:00`, text_en: `Thing ${i}`, text_he: `דבר ${i}` },
    }));
    t.journey.applyChange('hermes', 'note', (rows) => addItems(rows, specs));
    const body = await read(since);
    assert.equal(body.changes.length, LIMITS.changes);
    assert.equal(body.changes_omitted, 50);
    const keys = body.changes.map((c) => `${c.date} ${c.time}`);
    assert.deepEqual(keys, [...keys].sort());
    const sentDays = new Set(body.changes.map((c) => c.date));
    const lastSent = body.changes.at(-1).date;
    // Nothing left out is nearer than the furthest thing sent.
    const all = specs.map((s) => s.row.date).sort();
    assert.ok(all.slice(0, LIMITS.changes).every((d) => d <= lastSent));
    assert.ok(sentDays.size > 1);
  });

  test('a response under the cap reports changes_omitted 0', async () => {
    const body = await read('rev_unknown_so_nothing');
    assert.equal(body.changes_omitted, 0);
    assert.deepEqual(body.changes, []);
  });
});

describe('the fixture the control plane parses is what the real route answers', () => {
  // Fixed by hand: the values that depend on the clock or on a generated id.
  const normalise = (body) => ({ ...body, active_revision_id: 'rev_fixture', active_created_at: '2026-01-01T00:00:00Z', today: '2026-01-01', now_local: '12:00' });

  test('two worst cases (a clipped title with odd values; the 200 cap) equal the committed fixture', async () => {
    const fresh = trip();
    const app = express();
    const pass = (_req, _res, next) => next();
    fresh.journey.registerRoutes(app, { authRequired: pass, organizerOrAgentRequired: pass, internal: pass });
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const url = `http://127.0.0.1:${srv.address().port}/api/internal/control-plane/plan-changes`;
      const id = () => fresh.db.prepare('SELECT active_version_id AS id FROM trip_itinerary_state WHERE id = 1').get().id;
      const add = (specs) => fresh.journey.applyChange('hermes', 'note', (rows) => addItems(rows, specs));

      let since = id();
      add([
        { id: 'a', row: { date: FUTURE, time: '19:00', text_he: 'ארוחת ערב '.repeat(500), text_en: 'x'.repeat(5000) } },
        { id: 'b', row: { date: FUTURE, time: '7pm', text_en: 'Odd time', text_he: 'שעה' } },
      ]);
      fresh.journey.applyChange('hermes', 'note', (rows) => { const r = rows.items.find((i) => i.item_uid === 'item_lim_a'); r.time = '20:30'; });
      const clipped = normalise(await (await fetch(`${url}?since=${since}`)).json());

      since = id();
      add(Array.from({ length: 230 }, (_, i) => ({ id: `cap${i}`, row: { date: `2099-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, '0')}`, time: `${String(8 + (i % 12)).padStart(2, '0')}:00`, text_en: `Thing ${i}`, text_he: `דבר ${i}` } })));
      const capped = normalise(await (await fetch(`${url}?since=${since}`)).json());

      assert.equal(clipped.changes.every((c) => (c.text_en ?? '').length <= LIMITS.text && (c.text_he ?? '').length <= LIMITS.text), true);
      assert.equal(capped.changes.length, LIMITS.changes);
      assert.equal(capped.changes_omitted, 30);
      const fixture = { _comment: 'Generated by tests/plan-changes-limits.test.js from the real route (UPDATE_PLAN_CHANGES_FIXTURE=1). Parsed by control-plane/api/test/plan-changes-contract.test.ts.', clipped, capped };
      if (process.env.UPDATE_PLAN_CHANGES_FIXTURE === '1') writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 1)}\n`);
      assert.deepEqual(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')), fixture, 'the route\'s answer changed: regenerate the fixture on purpose (see the header of this file)');
    } finally { srv.close(); }
  });
});
