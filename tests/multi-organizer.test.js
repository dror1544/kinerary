/**
 * multi-organizer.test.js — agent.organizers (list) support, on top of the
 * legacy single agent.organizer string. Self-contained (own port, own temp
 * trip dir with a modified fixture) rather than reusing helpers/server.js's
 * fixed port and stock fixture, since `node --test` runs test files in
 * parallel and the stock fixture only has one organizer (alice).
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
const PORT         = 3096;

function bootOnce(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_JS], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(port), JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: 'test-hermes-key', ...env },
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
// before listen) aren't synchronized, so retry briefly rather than assuming
// the seed users exist the instant the port is up.
async function login(port, username) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: '1234' }),
    });
    if (res.ok) {
      const { token } = await res.json();
      if (token) return token;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`login as ${username} never succeeded`);
}

describe('agent.organizers (multi-organizer)', () => {
  let dataDir, tripDir, proc;
  let aliceToken, bobToken, eveToken;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-test-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'trip-test-trip-'));
    cpSync(FIXTURES_DIR, tripDir, { recursive: true });

    const cfgPath = join(tripDir, 'trip.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    delete cfg.agent.organizer;
    cfg.agent.organizers = ['alice', 'bob'];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    proc = await bootOnce(PORT, { TRIP_DIR: tripDir, DATA_DIR: dataDir });
    [aliceToken, bobToken, eveToken] = await Promise.all([
      login(PORT, 'alice'), login(PORT, 'bob'), login(PORT, 'eve'),
    ]);
  });

  after(async () => {
    await stop(proc);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tripDir, { recursive: true, force: true });
  });

  test('both listed organizers get 200 on /api/agent/brief', async () => {
    for (const [name, token] of [['alice', aliceToken], ['bob', bobToken]]) {
      const res = await fetch(`http://localhost:${PORT}/api/agent/brief`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200, `expected ${name} (a listed organizer) to be admitted`);
    }
  });

  test('a third participant not in the organizers list gets 403', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/agent/brief`, { headers: { Authorization: `Bearer ${eveToken}` } });
    assert.equal(res.status, 403);
  });

  test('brief reports the full organizers array, not just the caller', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/agent/brief`, { headers: { Authorization: `Bearer ${bobToken}` } });
    const brief = await res.json();
    assert.deepEqual(brief.organizers, ['alice', 'bob']);
  });
});
