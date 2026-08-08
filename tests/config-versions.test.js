/**
 * config-versions.test.js — trip_config_versions boot-time snapshotting and
 * the /api/config/versions read path (Stage 1 groundwork for config diffing).
 *
 * Self-contained (own ports, own temp dirs) rather than reusing
 * helpers/server.js's fixed port, since `node --test` runs test files in
 * parallel by default and would otherwise collide with server.test.js.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE         = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');
const SERVER_JS    = join(HERE, '..', 'server', 'server.js');
const SERVER_DIR   = join(HERE, '..', 'server');

function bootOnce(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_JS], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(port), JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: 'test-hermes-key', SEED_PASSWORD: '1234', ...env },
    });
    let ready = false;
    proc.stdout.on('data', chunk => {
      if (!ready && chunk.toString().includes('Trip server running on')) { ready = true; resolve(proc); }
    });
    proc.on('error', reject);
    proc.on('exit', code => { if (!ready) reject(new Error(`exited with ${code}`)); });
    setTimeout(() => { if (!ready) reject(new Error('boot timeout')); }, 10_000);
  });
}

function stop(proc) {
  return new Promise(resolve => {
    proc.on('exit', resolve);
    proc.kill('SIGTERM');
  });
}

// Server readiness (the HTTP listener) and user-seeding (async, unawaited
// before listen — see server.js initData()) are not synchronized, so retry
// briefly rather than assuming the seed user exists the instant the port is up.
async function login(port) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: '1234' }),
    });
    if (res.ok) {
      const { token } = await res.json();
      if (token) return token;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('login as alice never succeeded');
}

// ── GET /api/config/versions & /api/config/versions/:version ──────────────────
describe('GET /api/config/versions', () => {
  const PORT = 3097;
  let dataDir, proc, token;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-test-data-'));
    proc = await bootOnce(PORT, { TRIP_DIR: FIXTURES_DIR, DATA_DIR: dataDir });
    token = await login(PORT);
  });
  after(async () => {
    await stop(proc);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('requires auth', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/config/versions`);
    assert.equal(res.status, 401);
  });

  test('fresh boot records exactly one version', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/config/versions`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 1);
    assert.ok(rows[0].hash && rows[0].created_at);
  });

  test('GET /api/config/versions/:version returns full content matching the fixture', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/config/versions/1`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { version, content } = await res.json();
    assert.equal(version, 1);
    assert.equal(content.participants.length, 3);
    assert.ok(content.meta?.title);
  });

  test('strips pin fields from content, same as /api/config', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/config/versions/1`, { headers: { Authorization: `Bearer ${token}` } });
    const { content } = await res.json();
    for (const phase of content.phases) {
      assert.ok(!('pin' in (phase.accommodation ?? {})),
        `phase ${phase.id} accommodation still has pin field`);
    }
    for (const hotel of (content.bookings?.hotels ?? [])) {
      assert.ok(!('pin' in hotel), `hotel "${hotel.name}" still has pin field`);
    }
    for (const p of content.participants) {
      assert.ok(!('pin' in p), `participant ${p.username} still has pin field`);
    }
  });

  test('unknown version returns 404', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/config/versions/999`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 404);
  });
});

// ── Boot-time snapshot behavior across restarts ────────────────────────────────
describe('boot-time snapshot behavior', () => {
  const PORT = 3098;
  let dataDir, tripDir;

  async function fetchVersions() {
    const token = await login(PORT);
    const res = await fetch(`http://localhost:${PORT}/api/config/versions`, { headers: { Authorization: `Bearer ${token}` } });
    return res.json();
  }

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-test-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'trip-test-trip-'));
    cpSync(FIXTURES_DIR, tripDir, { recursive: true });
  });

  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tripDir, { recursive: true, force: true });
  });

  test('unchanged config across restarts does not create a new version', async () => {
    const env = { TRIP_DIR: tripDir, DATA_DIR: dataDir };

    let proc = await bootOnce(PORT, env);
    let rows = await fetchVersions();
    await stop(proc);
    assert.deepEqual(rows.map(r => r.version), [1]);

    proc = await bootOnce(PORT, env);
    rows = await fetchVersions();
    await stop(proc);
    assert.deepEqual(rows.map(r => r.version), [1]);
  });

  test('editing the config file creates a new version on next boot', async () => {
    const cfgPath = join(tripDir, 'trip.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.meta.title = cfg.meta.title + ' (edited)';
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const proc = await bootOnce(PORT, { TRIP_DIR: tripDir, DATA_DIR: dataDir });
    const rows = await fetchVersions();
    await stop(proc);

    // /api/config/versions is newest-first
    assert.deepEqual(rows.map(r => r.version), [2, 1]);
  });
});
