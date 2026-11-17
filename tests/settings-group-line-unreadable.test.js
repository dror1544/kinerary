/**
 * settings-group-line-unreadable.test.js — a setting nobody can read is off, never on
 * (video Release 1C, boundary review of round 3).
 *
 * `group_change_line` is on by default, and that default lives in the column's DEFAULT (new rows, and the row an older
 * site already had, get 1 there; tests/settings-group-line.test.js covers AC-25 over the real server). A READ that finds
 * no value is not the default: it reads as off, and says so once, so a trip's group is never sent a line the organizer
 * did not choose because a row or column was missing.
 *
 * The table is pre-created WITHOUT the NOT NULL and the default, which is what a damaged or hand-edited row looks like;
 * schema()'s own ALTER then fails harmlessly (the column exists) and its INSERT OR IGNORE leaves the value NULL.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function trip({ preCreate }) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trip_config_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, content TEXT, hash TEXT);
    CREATE TABLE phase_plan_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT, date TEXT, time TEXT, text_he TEXT, text_en TEXT, location_url TEXT, booking_id INTEGER, status TEXT, sort_order REAL, created_by TEXT, created_at TEXT, waze_url TEXT, website_url TEXT, ticket_url TEXT, enrichment_status TEXT, time_sort INTEGER, config_ref TEXT, extra_links TEXT, itinerary_item_uid TEXT, keep_both_with TEXT);
    CREATE UNIQUE INDEX phase_plan_items_uid ON phase_plan_items(itinerary_item_uid) WHERE itinerary_item_uid IS NOT NULL;
    CREATE TABLE phase_plan_days (phase_id TEXT, date TEXT, label_he TEXT, label_en TEXT, enrichment_status TEXT, itinerary_day_key TEXT, PRIMARY KEY (phase_id, date));
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, date_from TEXT, date_to TEXT, confirmation TEXT, conf_file TEXT, location_url TEXT, google_wallet_url TEXT, apple_wallet_url TEXT, pkpass_file TEXT, review_status TEXT DEFAULT 'approved');
  `);
  if (preCreate) db.exec(preCreate);
  const config = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
  const journey = create({ db, config, raw: JSON.stringify(config), mediaDir: tmpdir(), fetchImpl: fetch });
  return { db, journey };
}

async function serve(journey) {
  const app = express();
  const pass = (_req, _res, next) => { _req.user = { username: 'alice' }; next(); };
  app.use(express.json());
  journey.registerRoutes(app, { authRequired: pass, organizerOrAgentRequired: pass, internal: pass });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

describe('a setting with no value reads as off', () => {
  let warnings;
  const realWarn = console.warn;
  before(() => { warnings = []; console.warn = (...args) => { warnings.push(args.join(' ')); }; });
  after(() => { console.warn = realWarn; });

  test('a row whose group_change_line is NULL reads as off in GET /api/settings and in the control plane\'s route, and says so once', async () => {
    const { db, journey } = trip({
      preCreate: 'CREATE TABLE trip_settings (id INTEGER PRIMARY KEY CHECK (id = 1), timezone TEXT, updated_by TEXT, updated_at TEXT, group_change_line INTEGER)',
    });
    assert.equal(db.prepare('SELECT group_change_line AS v FROM trip_settings WHERE id = 1').get().v, null, 'the fixture really has no value');
    const { base, close } = await serve(journey);
    try {
      assert.equal((await (await fetch(`${base}/api/settings`)).json()).group_change_line, false);
      assert.equal((await (await fetch(`${base}/api/settings`)).json()).group_change_line, false);
      assert.equal((await (await fetch(`${base}/api/internal/control-plane/plan-changes`)).json()).group_change_line, false);
      assert.equal(warnings.filter((w) => w.includes('group_change_line_unreadable')).length, 1, 'logged once, not on every read');
      // An organizer can still choose: the value written is the value read.
      const on = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ group_change_line: true }) });
      assert.equal((await on.json()).group_change_line, true);
    } finally { await close(); }
  });

  test('a row that is not there at all reads as off', async () => {
    const { db, journey } = trip({});
    db.prepare('DELETE FROM trip_settings').run();
    const { base, close } = await serve(journey);
    try {
      assert.equal((await (await fetch(`${base}/api/settings`)).json()).group_change_line, false);
    } finally { await close(); }
  });

  test('the default for a new row is still on, and it comes from the column, not from the read', async () => {
    const { db, journey } = trip({});
    assert.equal(db.prepare('SELECT group_change_line AS v FROM trip_settings WHERE id = 1').get().v, 1);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trip_settings'").get().sql, /group_change_line INTEGER NOT NULL DEFAULT 1/);
    const { base, close } = await serve(journey);
    try {
      assert.equal((await (await fetch(`${base}/api/settings`)).json()).group_change_line, true);
    } finally { await close(); }
  });

  test('a row written 0 reads as off, 1 as on', async () => {
    const { db, journey } = trip({});
    const { base, close } = await serve(journey);
    try {
      db.prepare('UPDATE trip_settings SET group_change_line = 0 WHERE id = 1').run();
      assert.equal((await (await fetch(`${base}/api/settings`)).json()).group_change_line, false);
      db.prepare('UPDATE trip_settings SET group_change_line = 1 WHERE id = 1').run();
      assert.equal((await (await fetch(`${base}/api/settings`)).json()).group_change_line, true);
    } finally { await close(); }
  });
});
