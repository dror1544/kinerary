// One plan, in phase_plan_*: imported once at boot, saved back by export, restored from that save.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { PORTS } from './helpers/ports.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const AGENT_KEY = 'test-hermes-key';
const PHASE = 'ny';
const DAY = '2027-03-11';

const texts = (rows) => rows.map(r => r.text_en).sort();

// What the agent reads (get_phase_plan) next to what the site renders.
async function bothReads(get) {
  const plan = (await get(`/api/phases/${PHASE}/plan`)).filter(r => r.date === DAY);
  const active = (await get('/api/itinerary/active')).items.filter(i => i.phase_id === PHASE && i.date === DAY);
  return { plan, active };
}

function client(port) {
  const req = (path, { method = 'GET', body, headers = {}, key = AGENT_KEY, token } = {}) =>
    fetch(`http://localhost:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-API-Key': key } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { req, get: async (path) => (await req(path)).json() };
}

describe('a running trip has one plan', () => {
  const { req, get } = client(PORTS.planSingleSource);
  const add = (time, text_en) =>
    req(`/api/phases/${PHASE}/plan`, { method: 'POST', body: { date: DAY, time, text_he: text_en, text_en } });
  const idOf = async (text_en) => (await get(`/api/phases/${PHASE}/plan`)).find(r => r.text_en === text_en).id;

  // A Hermes URL is set so the boot import has an enrichment worker it could wrongly feed.
  before(() => startTestServer({ PORT: String(PORTS.planSingleSource), HERMES_URL: 'http://127.0.0.1:59999/hermes-stub' }));
  after(() => stopTestServer());

  test('boot imports the config day, so the agent read and the site read agree', async () => {
    const { plan, active } = await bothReads(get);
    assert.equal(plan.filter(r => r.config_ref).length, 3, 'the fixture day has 3 config items');
    assert.deepEqual(texts(plan), texts(active));
    assert.ok(plan.every(r => r.enrichment_status === 'none'),
      'a deploy must not queue model calls for every existing item');
  });

  test('a deleted config item leaves both reads and stays gone after another write', async () => {
    assert.equal((await req(`/api/phases/${PHASE}/plan/${await idOf('Breakfast')}`, { method: 'DELETE' })).status, 200);
    assert.equal((await add('12:00', 'Lunch')).status, 201);
    const { plan, active } = await bothReads(get);
    assert.ok(!plan.some(r => r.text_en === 'Breakfast'));
    assert.ok(!active.some(i => i.text_en === 'Breakfast'));
    assert.deepEqual(texts(plan), texts(active));
  });

  test('export saves a restore point that restore brings back', async () => {
    const exported = await req('/api/phase-plan/export-to-config', { method: 'POST' });
    assert.equal(exported.status, 200);
    assert.ok((await exported.json()).restore_point, 'export should report the restore point it set');
    const saved = texts((await bothReads(get)).active);

    assert.equal((await add('15:00', 'Unsaved addition')).status, 201);
    await req(`/api/phases/${PHASE}/plan/${await idOf('Lunch')}`, { method: 'DELETE' });

    const { revision } = await get('/api/itinerary/active');
    assert.equal((await req('/api/itinerary/restore-original', { method: 'POST', headers: { 'If-Match': revision } })).status, 200);
    const { plan, active } = await bothReads(get);
    assert.deepEqual(texts(active), saved);
    assert.deepEqual(texts(plan), saved);
  });

  test('a write after restore does not bring back what restore removed', async () => {
    assert.equal((await add('18:00', 'Evening walk')).status, 201);
    const { plan, active } = await bothReads(get);
    assert.ok(!active.some(i => i.text_en === 'Unsaved addition'), 'the restore must stay restored');
    assert.deepEqual(texts(plan), texts(active));
  });

  test('restore refuses a stale revision and a family member', async () => {
    assert.equal((await req('/api/itinerary/restore-original', { method: 'POST', headers: { 'If-Match': 'stale' } })).status, 409);
    const login = await req('/api/auth/login', { method: 'POST', key: null, body: { username: 'bob', password: '1234' } });
    const { token } = await login.json();
    assert.equal((await req('/api/itinerary/restore-original', { method: 'POST', key: null, token })).status, 403);
  });
});

function boot(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [join(HERE, '..', 'server', 'server.js')], {
      cwd: join(HERE, '..', 'server'),
      env: { ...process.env, PORT: String(port), JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
             HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234', HERMES_URL: '', ...env },
    });
    let ready = false;
    proc.stdout.on('data', c => { if (!ready && c.toString().includes('Trip server running on')) { ready = true; resolve(proc); } });
    proc.on('error', reject);
    proc.on('exit', code => { if (!ready) reject(new Error(`server exited with ${code} before ready`)); });
    setTimeout(() => { if (!ready) reject(new Error('boot timeout')); }, 10_000);
  });
}
const stop = (proc) => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });

describe('the import runs once, and a trip written before it keeps what it shows', () => {
  const PORT = PORTS.planSingleSourceBoot;
  const { req, get } = client(PORT);
  let dataDir, tripDir;
  const env = () => ({ TRIP_DIR: tripDir, DATA_DIR: dataDir });

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'plan-source-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'plan-source-trip-'));
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  });
  after(() => {
    for (const d of [dataDir, tripDir]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  test('a restart does not re-import a config item that was deleted', async () => {
    let proc = await boot(PORT, env());
    try {
      const breakfast = (await get(`/api/phases/${PHASE}/plan`)).find(r => r.text_en === 'Breakfast');
      assert.equal((await req(`/api/phases/${PHASE}/plan/${breakfast.id}`, { method: 'DELETE' })).status, 200);
    } finally { await stop(proc); }

    proc = await boot(PORT, env());
    try {
      const { plan, active } = await bothReads(get);
      assert.ok(!plan.some(r => r.text_en === 'Breakfast'));
      assert.ok(!active.some(i => i.text_en === 'Breakfast'));
    } finally { await stop(proc); }
  });

  test('a trip written before the import keeps exactly what it shows', async () => {
    // Rebuild japan-2026's pre-import shape: a fresh write in a config item's slot, the config copy already dropped.
    const db = new Database(join(dataDir, 'trip.db'));
    try {
      const { active_version_id: current } = db.prepare('SELECT active_version_id FROM trip_itinerary_state').get();
      db.exec('UPDATE trip_itinerary_state SET legacy_owns_config = 0; DELETE FROM phase_plan_items; DELETE FROM phase_plan_days;');
      db.prepare("INSERT INTO phase_plan_items (id, phase_id, date, time, time_sort, text_he, text_en, status, created_by) VALUES (900, ?, ?, '11:00', 660, 'כתיבה חדשה', 'Fresh write, same slot', 'confirmed', 'hermes')")
        .run(PHASE, DAY);
      db.prepare("INSERT INTO itinerary_plan_versions (revision_id, kind, source_config_digest, parent_revision_id, author, note) VALUES ('active_hybrid', 'active', 'test', ?, 'test', 'pre-import hybrid')")
        .run(current);
      db.prepare("INSERT INTO itinerary_plan_days SELECT 'active_hybrid', phase_id, date, label_he, label_en, lodging_context, pickup_context, sort_order FROM itinerary_plan_days WHERE revision_id = ?")
        .run(current);
      db.prepare(
        "INSERT INTO itinerary_plan_items (revision_id,item_uid,phase_id,date,time,time_sort,item_type,text_he,text_en,location_url,waze_url,website_url,ticket_url,booking_id,confirmation_state,duration_minutes,sort_order,source_ref,created_by,extra_links) " +
        "SELECT 'active_hybrid',item_uid,phase_id,date,time,time_sort,item_type,text_he,text_en,location_url,waze_url,website_url,ticket_url,booking_id,confirmation_state,duration_minutes,sort_order,source_ref,created_by,extra_links " +
        "FROM itinerary_plan_items WHERE revision_id = ? AND COALESCE(text_en, '') <> 'Visit Central Park'"
      ).run(current);
      db.prepare("INSERT INTO itinerary_plan_items (revision_id,item_uid,phase_id,date,time,time_sort,item_type,text_he,text_en,confirmation_state,sort_order,source_ref,created_by) VALUES ('active_hybrid','legacy_900',?,?,'11:00',660,'activity','כתיבה חדשה','Fresh write, same slot','verified',1,'legacy:900','hermes')")
        .run(PHASE, DAY);
      db.prepare("UPDATE trip_itinerary_state SET active_version_id = 'active_hybrid'").run();
    } finally { db.close(); }

    const proc = await boot(PORT, env());
    try {
      const { plan, active } = await bothReads(get);
      assert.equal(plan.filter(r => r.time === '11:00').length, 1, 'the slot holds the fresh write only');
      assert.ok(!plan.some(r => r.text_en === 'Visit Central Park'), 'the dropped config copy must not come back');
      assert.ok(plan.find(r => /Early departure/.test(r.text_en || ''))?.config_ref, 'config items are imported with their config_ref');
      assert.deepEqual(texts(plan), texts(active));
    } finally { await stop(proc); }
  });
});
