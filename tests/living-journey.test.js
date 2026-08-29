import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { create } = require('../server/living-journey.js');

function fixtureConfig() {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
}

test('living journey seeds immutable original and active itinerary versions once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'living-journey-'));
  try {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE trip_config_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, content TEXT, hash TEXT);
      CREATE TABLE phase_plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT, date TEXT, time TEXT, text_he TEXT, text_en TEXT,
        location_url TEXT, booking_id INTEGER, status TEXT, sort_order REAL, created_by TEXT, created_at TEXT,
        waze_url TEXT, website_url TEXT, ticket_url TEXT, enrichment_status TEXT, time_sort INTEGER, config_ref TEXT,
        extra_links TEXT
      );
      CREATE TABLE phase_plan_days (phase_id TEXT, date TEXT, label_he TEXT, label_en TEXT, PRIMARY KEY (phase_id, date));
      CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, date_from TEXT, date_to TEXT, confirmation TEXT, conf_file TEXT, location_url TEXT, google_wallet_url TEXT, apple_wallet_url TEXT, pkpass_file TEXT);
    `);
    const config = fixtureConfig();
    const raw = JSON.stringify(config);
    create({ db, config, raw, mediaDir: dir, fetchImpl: fetch });
    create({ db, config, raw, mediaDir: dir, fetchImpl: fetch });

    const state = db.prepare('SELECT * FROM trip_itinerary_state').all();
    const versions = db.prepare('SELECT * FROM itinerary_plan_versions ORDER BY created_at ASC').all();
    assert.equal(state.length, 1);
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map((row) => row.kind), ['original', 'active']);
    assert.throws(
      () => db.prepare('UPDATE itinerary_plan_versions SET note = ? WHERE revision_id = ?').run('changed', versions[0].revision_id),
      /immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM itinerary_plan_items WHERE revision_id = ?').run(versions[0].revision_id),
      /immutable/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
