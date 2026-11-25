/**
 * trip-moments-old-schema.test.js — the current server boots over a trip.db made by the PREVIOUS schema
 * (docs/specs/sprint-9/x-trip-photos-and-moments.md; regression finding R5, "silent schema").
 *
 * Part A adds columns to live trips' SQLite files (trip_settings, trip_moments, photos). A trip that already has data must keep it:
 * the new columns appear, the old rows read as before, every route Part A touched still works, and a member's existing
 * `trip:read` connection keeps exactly its nine tools. The old tables below are the ones main had before Part A, as DDL plus rows a
 * live trip would hold (the settings row has non-default values, so a default silently overwriting them would show).
 * And the ALTERs only forgive "duplicate column name": any other failure stops the boot loudly.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startTestServer, stopTestServer, loginAsAlice, api } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { create } = require('../server/living-journey.js');
const HERE = dirname(fileURLToPath(import.meta.url));

const PIXEL = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const TODAY_MEMBER = ['get_config', 'get_today', 'get_bookings', 'get_phase_plan', 'get_budget', 'get_rsvps', 'get_ratings', 'get_venue_comments', 'get_lost_found'];
const OLD_TOKEN = 'old-access-token-from-before-part-a';
const sha = (v) => createHash('sha256').update(v).digest('hex');

// The tables as main had them before Part A (3e24152c), filled the way a live trip would be.
function makeOldDb(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE trip_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), timezone TEXT, updated_by TEXT, updated_at TEXT,
      group_change_line INTEGER NOT NULL DEFAULT 1 CHECK (group_change_line IN (0,1)),
      nav_app TEXT NOT NULL DEFAULT 'google' CHECK (nav_app IN ('google','waze'))
    );
    CREATE TABLE trip_moments (
      id TEXT PRIMARY KEY, date TEXT, phase_id TEXT, item_uid TEXT, author TEXT NOT NULL, caption TEXT NOT NULL, body TEXT, photo_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'draft' CHECK(visibility IN ('draft','published')),
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, original_name TEXT, phase TEXT, caption TEXT, username TEXT NOT NULL,
      uploaded_at TEXT DEFAULT (datetime('now')), immich_id TEXT
    );
    CREATE TABLE mcp_oauth_clients (client_id TEXT PRIMARY KEY, client_secret_hash TEXT, client_name TEXT, redirect_uris TEXT NOT NULL, token_endpoint_auth_method TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE mcp_oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, username TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL, used_at INTEGER, grant_id TEXT, scope TEXT NOT NULL DEFAULT 'trip');
    CREATE TABLE mcp_oauth_grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, username TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER, scope TEXT NOT NULL DEFAULT 'trip');
    CREATE TABLE mcp_oauth_tokens (token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), expires_at INTEGER NOT NULL, revoked_at INTEGER);
  `);
  db.prepare("INSERT INTO trip_settings (id, timezone, updated_by, updated_at, group_change_line, nav_app) VALUES (1, 'Europe/Paris', 'alice', '2026-11-01 10:00:00', 0, 'waze')").run();
  db.prepare("INSERT INTO trip_moments (id, date, author, caption, body, photo_id, visibility) VALUES ('moment_old_pub', '2026-11-02', 'alice', 'Old published', 'from before', '1700000000001', 'published')").run();
  db.prepare("INSERT INTO trip_moments (id, author, caption, photo_id, visibility) VALUES ('moment_old_draft', 'bob', 'Old draft of bob', NULL, 'draft')").run();
  db.prepare("INSERT INTO photos (id, filename, original_name, phase, caption, username, immich_id) VALUES ('1700000000001', 'old-1.jpg', 'old-1.jpg', 'general', 'before', 'alice', 'immich-1')").run();
  db.prepare("INSERT INTO photos (id, filename, original_name, phase, caption, username) VALUES ('1700000000002', 'old-2.jpg', 'old-2.jpg', 'general', '', 'bob')").run();
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO mcp_oauth_clients VALUES ('mcp_old', NULL, 'Claude', '[\"https://claude.ai/api/mcp/auth_callback\"]', 'none', ?)").run(now);
  db.prepare("INSERT INTO mcp_oauth_grants (id, client_id, username, created_at, scope) VALUES ('grant_old_bob', 'mcp_old', 'bob', ?, 'trip:read')").run(now);
  db.prepare("INSERT INTO mcp_oauth_tokens VALUES (?, 'grant_old_bob', 'access', ?, NULL)").run(sha(OLD_TOKEN), now + 3600);
  db.close();
}

describe('the current server over a trip.db from before Part A', () => {
  let alice, bob, base, dbFile;
  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    await startTestServer({ PORT: String(port), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: base }, {
      configure(config, tripDir) {
        dbFile = join(dirname(tripDir), 'trip.db');
        makeOldDb(dbFile);
        config.features = { chat_photos_to_album: true, trip_moments_capture: true };
      },
    });
    alice = await loginAsAlice();
    bob = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
  });
  after(() => stopTestServer());

  it('the new columns exist', () => {
    const db = new Database(dbFile, { readonly: true });
    try {
      const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      assert.ok(cols('trip_settings').includes('group_photo_autosave') && cols('trip_settings').includes('moment_capture_mode'));
      assert.ok(cols('trip_moments').includes('source') && cols('trip_moments').includes('photo_ids'));
      assert.ok(cols('photos').includes('source'));
      assert.ok(cols('photos').includes('immich_id'), 'and the old ones are still there');
    } finally { db.close(); }
  });

  it('GET /api/settings: the old values are kept, the new ones take their defaults', async () => {
    const s = await (await api('/api/settings', { token: bob })).json();
    assert.equal(s.timezone, 'Europe/Paris');
    assert.equal(s.group_change_line, false, 'the organizer\'s earlier "off" was not overwritten by a default');
    assert.equal(s.nav_app, 'waze');
    assert.equal(s.group_photo_autosave, true);
    assert.equal(s.moment_capture_mode, 'ask_in_chat');
  });

  it('PATCH /api/settings changes the new settings and leaves the old ones alone', async () => {
    const res = await api('/api/settings', { method: 'PATCH', token: alice, body: { moment_capture_mode: 'organizer_draft', group_photo_autosave: false } });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.moment_capture_mode, 'organizer_draft');
    assert.equal(s.group_photo_autosave, false);
    assert.equal(s.timezone, 'Europe/Paris');
    assert.equal(s.group_change_line, false);
    assert.equal(s.nav_app, 'waze');
    assert.equal((await api('/api/settings', { method: 'PATCH', token: alice, body: { timezone: 'Asia/Tokyo' } })).status, 200, 'and the old PATCH still works');
  });

  it('GET /api/moments: old rows read as before, with photo_id as the one photo and the site as the source', async () => {
    const rows = await (await api('/api/moments', { token: bob })).json();
    const pub = rows.find((m) => m.id === 'moment_old_pub');
    assert.equal(pub.caption, 'Old published');
    assert.equal(pub.visibility, 'published');
    assert.deepEqual(pub.photo_ids, ['1700000000001']);
    assert.equal(pub.photo_id, '1700000000001');
    assert.equal(pub.source, 'site');
    const draft = rows.find((m) => m.id === 'moment_old_draft');
    assert.ok(draft, 'bob still sees his own old draft');
    assert.deepEqual(draft.photo_ids, []);
    assert.equal(draft.photo_id, null);
    const aliceRows = await (await api('/api/moments', { token: alice })).json();
    assert.ok(!aliceRows.some((m) => m.id === 'moment_old_draft'), 'and an organizer still does not get a draft written on the site');
  });

  it('a new moment, and an edit of an old one, work', async () => {
    const made = await api('/api/moments', { method: 'POST', token: bob, body: { caption: 'New on an old db', photo_ids: ['a', 'b'] } });
    assert.equal(made.status, 201);
    const edit = await api('/api/moments/moment_old_draft', { method: 'PATCH', token: bob, body: { caption: 'Old draft, renamed' } });
    assert.equal(edit.status, 200);
    assert.equal((await edit.json()).caption, 'Old draft, renamed');
  });

  it('GET /api/photos lists the old photos (source site, same owners); POST /api/photos/upload stores a new one', async () => {
    const listed = await (await api('/api/photos', { token: alice })).json();
    const old = listed.find((p) => p.id === '1700000000001');
    assert.equal(old.username, 'alice');
    assert.equal(old.source, 'site');
    assert.equal(listed.find((p) => p.id === '1700000000002').username, 'bob');
    const form = new FormData();
    form.append('photo', new Blob([PIXEL], { type: 'image/jpeg' }), 'new.jpg');
    form.append('source', 'connector');
    const up = await api('/api/photos/upload', { method: 'POST', token: bob, body: form });
    assert.equal(up.status, 200);
    const { photo } = await up.json();
    assert.equal(photo.username, 'bob');
    assert.equal(photo.source, 'connector');
    assert.equal((await api('/api/photos/1700000000002', { method: 'DELETE', token: bob })).status, 200, 'an old photo is still deletable by its owner');
  });

  it('a member\'s connection made before (trip:read) keeps exactly its nine tools, with the switch on', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${OLD_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).result.tools.map((t) => t.name), TODAY_MEMBER);
    const conn = await (await api('/api/mcp/connection', { token: bob })).json();
    assert.deepEqual(conn.connections.map((c) => ({ access: c.access, moments: c.moments })), [{ access: 'read', moments: false }]);
  });
});

describe('the new columns are added without hiding a real fault', () => {
  function trip(wrap) {
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE trip_config_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, content TEXT, hash TEXT);
      CREATE TABLE phase_plan_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase_id TEXT, date TEXT, time TEXT, text_he TEXT, text_en TEXT, location_url TEXT, booking_id INTEGER, status TEXT, sort_order REAL, created_by TEXT, created_at TEXT, waze_url TEXT, website_url TEXT, ticket_url TEXT, enrichment_status TEXT, time_sort INTEGER, config_ref TEXT, extra_links TEXT, itinerary_item_uid TEXT, keep_both_with TEXT);
      CREATE UNIQUE INDEX phase_plan_items_uid ON phase_plan_items(itinerary_item_uid) WHERE itinerary_item_uid IS NOT NULL;
      CREATE TABLE phase_plan_days (phase_id TEXT, date TEXT, label_he TEXT, label_en TEXT, enrichment_status TEXT, itinerary_day_key TEXT, PRIMARY KEY (phase_id, date));
      CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, date_from TEXT, date_to TEXT, confirmation TEXT, conf_file TEXT, location_url TEXT, google_wallet_url TEXT, apple_wallet_url TEXT, pkpass_file TEXT, review_status TEXT DEFAULT 'approved');
    `);
    const db = wrap ? new Proxy(raw, { get: (t, k) => (k === 'exec' ? wrap(t) : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) }) : raw;
    const config = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
    return () => create({ db, config, raw: JSON.stringify(config), mediaDir: tmpdir(), fetchImpl: fetch });
  }

  it('a duplicate column (a second boot) is fine', () => {
    const boot = trip();
    boot();
    assert.doesNotThrow(boot, 'booting twice over the same file');
  });

  it('any other failure of an ALTER stops the boot with its own message', () => {
    for (const column of ['group_photo_autosave', 'moment_capture_mode', 'photo_ids']) {
      const boot = trip((t) => (sql) => {
        if (String(sql).includes(`ADD COLUMN ${column}`)) throw new Error('attempt to write a readonly database');
        return t.exec(sql);
      });
      assert.throws(boot, /readonly database/, column);
    }
  });
});
