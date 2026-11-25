/**
 * settings-moments-unreadable.test.js — a photo/moment setting nobody can read fails SAFE
 * (docs/specs/sprint-9/x-trip-photos-and-moments.md, AC-2 storage half).
 *
 * `moment_capture_mode` has three modes; an unknown value in storage must read as `organizer_draft` (the most restrictive: nothing
 * reaches the chat or the site without an organizer), never as `publish` or `ask_in_chat`. `group_photo_autosave` is on by default
 * (the column's DEFAULT) but a READ that finds no value reads as off. The column CHECK stops a normal write of an unknown value, so
 * the table is pre-created WITHOUT the checks, which is what a damaged or hand-edited row looks like.
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

describe('photo and moment settings that cannot be read fail safe', () => {
  let warnings;
  const realWarn = console.warn;
  before(() => { warnings = []; console.warn = (...args) => { warnings.push(args.join(' ')); }; });
  after(() => { console.warn = realWarn; });
  const LOOSE = 'CREATE TABLE trip_settings (id INTEGER PRIMARY KEY CHECK (id = 1), timezone TEXT, updated_by TEXT, updated_at TEXT, group_photo_autosave INTEGER, moment_capture_mode TEXT)';
  const read = async (base) => (await fetch(`${base}/api/settings`)).json();

  test('an unknown stored mode reads as organizer_draft, never publish, and a NULL autosave reads as off; each says so once', async () => {
    const { db, journey } = trip({ preCreate: LOOSE });
    db.prepare("UPDATE trip_settings SET moment_capture_mode = 'publish ', group_photo_autosave = NULL WHERE id = 1").run();
    const { base, close } = await serve(journey);
    try {
      for (let i = 0; i < 2; i++) {
        const body = await read(base);
        assert.equal(body.moment_capture_mode, 'organizer_draft');
        assert.equal(body.group_photo_autosave, false);
      }
      assert.equal(warnings.filter((w) => w.includes('moment_capture_mode_unreadable')).length, 1);
      assert.equal(warnings.filter((w) => w.includes('group_photo_autosave_unreadable')).length, 1);
    } finally { await close(); }
  });

  test('every spelling that is not exactly a mode reads as organizer_draft; the three modes read as themselves', async () => {
    const { db, journey } = trip({ preCreate: LOOSE });
    const { base, close } = await serve(journey);
    try {
      for (const value of ['PUBLISH', 'Ask_In_Chat', 'ask', '', ' publish', 'published', null, 7]) {
        db.prepare('UPDATE trip_settings SET moment_capture_mode = ? WHERE id = 1').run(value);
        assert.equal((await read(base)).moment_capture_mode, 'organizer_draft', JSON.stringify(value));
      }
      for (const value of ['ask_in_chat', 'organizer_draft', 'publish']) {
        db.prepare('UPDATE trip_settings SET moment_capture_mode = ? WHERE id = 1').run(value);
        assert.equal((await read(base)).moment_capture_mode, value);
      }
    } finally { await close(); }
  });

  test('a row that is not there at all reads as organizer_draft and autosave off', async () => {
    const { db, journey } = trip({});
    db.prepare('DELETE FROM trip_settings').run();
    const { base, close } = await serve(journey);
    try {
      const body = await read(base);
      assert.equal(body.moment_capture_mode, 'organizer_draft');
      assert.equal(body.group_photo_autosave, false);
    } finally { await close(); }
  });

  test('the defaults for a new row are ask_in_chat and on, and they come from the columns, not from the read', async () => {
    const { db, journey } = trip({});
    const row = db.prepare('SELECT group_photo_autosave AS a, moment_capture_mode AS m FROM trip_settings WHERE id = 1').get();
    assert.deepEqual(row, { a: 1, m: 'ask_in_chat' });
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trip_settings'").get().sql;
    assert.match(sql, /group_photo_autosave INTEGER NOT NULL DEFAULT 1/);
    assert.match(sql, /moment_capture_mode TEXT NOT NULL DEFAULT 'ask_in_chat' CHECK/);
    const { base, close } = await serve(journey);
    try {
      const body = await read(base);
      assert.equal(body.moment_capture_mode, 'ask_in_chat');
      assert.equal(body.group_photo_autosave, true);
    } finally { await close(); }
  });
});
