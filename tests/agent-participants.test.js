/**
 * agent-participants.test.js — POST /api/agent/participants and
 * POST /api/auth/enroll: the only runtime writer of trip.config.json in this
 * codebase, so it gets its own isolated trip dir rather than reusing
 * helpers/server.js's shared fixture (which server.test.js and others read
 * directly, unmodified — writing into it here would corrupt every other
 * test's fixture on disk).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE         = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');
const SERVER_JS    = join(HERE, '..', 'server', 'server.js');
const SERVER_DIR   = join(HERE, '..', 'server');
const PORT         = 3101; // 3095-3100 already claimed by other test files

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => { if (!ready) reject(new Error('boot timeout')); }, 10_000);
    proc.stdout.on('data', chunk => {
      if (!ready && chunk.toString().includes('Trip server running on')) { ready = true; clearTimeout(timeout); resolve(); }
    });
    proc.stderr.on('data', chunk => process.stderr.write(chunk));
    proc.on('exit', code => { if (!ready) reject(new Error(`exited with ${code}`)); });
  });
}
function stop(proc) {
  return new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGTERM'); });
}
function api(path, { method = 'GET', body, token, apiKey } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (body != null) headers['Content-Type'] = 'application/json';
  return fetch(`http://localhost:${PORT}${path}`, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
}
// Server readiness (the HTTP listener) and user-seeding (async, unawaited
// before listen — see server.js initData()) aren't synchronized, so retry
// briefly rather than assuming the seed users exist the instant the port is up.
async function login(username, password) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    if (res.ok) return (await res.json()).token;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`login as ${username} never succeeded`);
}

describe('POST /api/agent/participants + POST /api/auth/enroll', () => {
  let dataDir, tripDir, proc, aliceToken, bobToken;
  const AGENT_KEY = 'test-hermes-key';

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-enroll-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'trip-enroll-trip-'));
    cpSync(FIXTURES_DIR, tripDir, { recursive: true });
    proc = spawn('node', [SERVER_JS], {
      cwd: SERVER_DIR,
      env: {
        ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
        AVATARS_DIR: join(dataDir, 'avatars'), JWT_SECRET: 'test-secret-000',
        IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234',
      },
    });
    await waitForServer(proc);
    aliceToken = await login('alice', '1234'); // fixture's organizer
    bobToken = await login('bob', '1234');     // a regular family member
  });

  after(async () => {
    await stop(proc);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tripDir, { recursive: true, force: true });
  });

  test('rejects an unauthenticated request', async () => {
    const res = await api('/api/agent/participants', { method: 'POST', body: { username: 'dana', name: 'Dana' } });
    assert.equal(res.status, 401);
  });

  test('rejects a non-organizer family member — same boundary as /api/agent/brief', async () => {
    const res = await api('/api/agent/participants', { method: 'POST', token: bobToken, body: { username: 'dana', name: 'Dana' } });
    assert.equal(res.status, 403);
  });

  test('rejects missing required fields', async () => {
    const res = await api('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY, body: { username: 'dana' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'missing_fields');
  });

  test('organizer JWT adds a password-only participant and returns an enrollment token', async () => {
    const res = await api('/api/agent/participants', {
      method: 'POST', token: aliceToken,
      body: { username: 'dana', name: 'דנה', name_en: 'Dana', color: '#22C55E' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.telegram_bound, false);
    assert.ok(typeof data.enrollment_token === 'string' && data.enrollment_token.length > 20);
  });

  test('the new participant is written to trip.config.json on disk', () => {
    const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
    const dana = cfg.participants.find(p => p.username === 'dana');
    assert.ok(dana, 'dana should be in trip.config.json');
    assert.equal(dana.name_en, 'Dana');
  });

  test('the write is snapshotted into trip_config_versions', async () => {
    const res = await api('/api/config/versions', { token: aliceToken });
    const rows = await res.json();
    assert.ok(rows.length >= 2, 'expected at least the boot snapshot plus the participant-add snapshot');
  });

  test('the new participant appears in the public roster with no restart', async () => {
    const res = await api('/api/config/roster');
    const { participants } = await res.json();
    assert.ok(participants.some(p => p.username === 'dana'), 'roster should reflect the in-memory config update immediately');
  });

  test('rejects a duplicate username', async () => {
    const res = await api('/api/agent/participants', {
      method: 'POST', apiKey: AGENT_KEY,
      body: { username: 'dana', name: 'Someone Else' },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'username_taken');
  });

  test('agent key adds a Telegram-bound participant — no enrollment token', async () => {
    const res = await api('/api/agent/participants', {
      method: 'POST', apiKey: AGENT_KEY,
      body: { username: 'guy', name: 'גיא', telegram_id: '555000111' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.telegram_bound, true);
    assert.equal(data.enrollment_token, undefined);
  });

  test('rejects a duplicate telegram_id', async () => {
    const res = await api('/api/agent/participants', {
      method: 'POST', apiKey: AGENT_KEY,
      body: { username: 'noa', name: 'נועה', telegram_id: '555000111' },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'telegram_id_taken');
  });

  test('POST /api/auth/enroll rejects an unknown token', async () => {
    const res = await api('/api/auth/enroll', { method: 'POST', body: { token: 'not-a-real-token', password: 'longenough' } });
    assert.equal(res.status, 404);
  });

  test('POST /api/auth/enroll rejects a too-short password', async () => {
    const res = await api('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY, body: { username: 'short-pw-test', name: 'X' } });
    const { enrollment_token } = await res.json();
    const enroll = await api('/api/auth/enroll', { method: 'POST', body: { token: enrollment_token, password: 'abc' } });
    assert.equal(enroll.status, 400);
  });

  test('a valid enrollment token sets a working password, once', async () => {
    const create = await api('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY, body: { username: 'eitan-jr', name: 'איתן' } });
    const { enrollment_token } = await create.json();

    const enroll = await api('/api/auth/enroll', { method: 'POST', body: { token: enrollment_token, password: 'a-real-password' } });
    assert.equal(enroll.status, 200);

    const loginRes = await api('/api/auth/login', { method: 'POST', body: { username: 'eitan-jr', password: 'a-real-password' } });
    assert.equal(loginRes.status, 200, 'the participant should be able to log in with the password they just set');

    const reuse = await api('/api/auth/enroll', { method: 'POST', body: { token: enrollment_token, password: 'a-different-password' } });
    assert.equal(reuse.status, 404, 'the same token must not be redeemable twice');
  });

  test('POST /api/agent/participants/:username/reset-password rejects unauthenticated and non-organizer callers', async () => {
    const anon = await api('/api/agent/participants/dana/reset-password', { method: 'POST' });
    assert.equal(anon.status, 401);
    const nonOrganizer = await api('/api/agent/participants/dana/reset-password', { method: 'POST', token: bobToken });
    assert.equal(nonOrganizer.status, 403);
  });

  test('reset-password rejects an unknown username', async () => {
    const res = await api('/api/agent/participants/does-not-exist/reset-password', { method: 'POST', apiKey: AGENT_KEY });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'user_not_found');
  });

  test('organizer-triggered reset mints a token that sets a new password for an EXISTING participant', async () => {
    // dana already exists (added earlier in this file) with whatever password
    // her original enrollment token set — this proves reset-password works
    // for an already-enrolled user, not just a brand-new one.
    const reset = await api('/api/agent/participants/dana/reset-password', { method: 'POST', token: aliceToken });
    assert.equal(reset.status, 200);
    const { enrollment_token } = await reset.json();

    const enroll = await api('/api/auth/enroll', { method: 'POST', body: { token: enrollment_token, password: 'danas-new-password' } });
    assert.equal(enroll.status, 200);

    const loginRes = await api('/api/auth/login', { method: 'POST', body: { username: 'dana', password: 'danas-new-password' } });
    assert.equal(loginRes.status, 200);
  });

  test('reset-password works for a Telegram-bound participant too', async () => {
    // guy was added earlier in this file with telegram_id set and no
    // enrollment token at all — reset-password should still work for them,
    // since Telegram-bound participants may still want a password fallback.
    const reset = await api('/api/agent/participants/guy/reset-password', { method: 'POST', apiKey: AGENT_KEY });
    assert.equal(reset.status, 200);
    const { enrollment_token } = await reset.json();

    const enroll = await api('/api/auth/enroll', { method: 'POST', body: { token: enrollment_token, password: 'guys-fallback-password' } });
    assert.equal(enroll.status, 200);

    const loginRes = await api('/api/auth/login', { method: 'POST', body: { username: 'guy', password: 'guys-fallback-password' } });
    assert.equal(loginRes.status, 200);
  });

  test('PATCH .../telegram rejects unauthenticated and non-organizer callers', async () => {
    const anon = await api('/api/agent/participants/dana/telegram', { method: 'PATCH', body: { telegram_id: '111' } });
    assert.equal(anon.status, 401);
    const nonOrganizer = await api('/api/agent/participants/dana/telegram', { method: 'PATCH', token: bobToken, body: { telegram_id: '111' } });
    assert.equal(nonOrganizer.status, 403);
  });

  test('PATCH .../telegram rejects a missing telegram_id and an unknown username', async () => {
    const missing = await api('/api/agent/participants/dana/telegram', { method: 'PATCH', apiKey: AGENT_KEY, body: {} });
    assert.equal(missing.status, 400);
    const unknown = await api('/api/agent/participants/does-not-exist/telegram', { method: 'PATCH', apiKey: AGENT_KEY, body: { telegram_id: '222' } });
    assert.equal(unknown.status, 404);
  });

  test('PATCH .../telegram rejects a telegram_id already bound to someone else', async () => {
    // guy already has telegram_id 555000111 from an earlier test in this file.
    const res = await api('/api/agent/participants/dana/telegram', { method: 'PATCH', token: aliceToken, body: { telegram_id: '555000111' } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'telegram_id_taken');
  });

  test('binding a Telegram id to an existing password-only participant enables Telegram login for them', async () => {
    // dana was added earlier as password-only (no telegram_id).
    const res = await api('/api/agent/participants/dana/telegram', { method: 'PATCH', token: aliceToken, body: { telegram_id: '777000999' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, username: 'dana', telegram_id: '777000999' });

    const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
    assert.equal(cfg.participants.find(p => p.username === 'dana').telegram_id, '777000999');
  });

  test('DELETE /api/agent/participants/:username rejects unauthenticated and non-organizer callers', async () => {
    const anon = await api('/api/agent/participants/dana', { method: 'DELETE' });
    assert.equal(anon.status, 401);
    const nonOrganizer = await api('/api/agent/participants/dana', { method: 'DELETE', token: bobToken });
    assert.equal(nonOrganizer.status, 403);
  });

  test('DELETE rejects an unknown username and refuses to remove the organizer', async () => {
    const unknown = await api('/api/agent/participants/does-not-exist', { method: 'DELETE', apiKey: AGENT_KEY });
    assert.equal(unknown.status, 404);
    const organizerRemoval = await api('/api/agent/participants/alice', { method: 'DELETE', apiKey: AGENT_KEY });
    assert.equal(organizerRemoval.status, 409);
    assert.equal((await organizerRemoval.json()).error, 'cannot_remove_organizer');
  });

  test('DELETE removes a participant from the roster and revokes their access', async () => {
    const created = await api('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY, body: { username: 'remove-me', name: 'Remove Me', telegram_id: '888000111' } });
    assert.equal(created.status, 200);

    let roster = await (await api('/api/config/roster')).json();
    assert.ok(roster.participants.some(p => p.username === 'remove-me'));

    const removed = await api('/api/agent/participants/remove-me', { method: 'DELETE', token: aliceToken });
    assert.equal(removed.status, 200);
    const body = await removed.json();
    assert.equal(body.username, 'remove-me');
    assert.ok(body.note.includes('session token'), 'response should surface the session-revocation caveat');

    roster = await (await api('/api/config/roster')).json();
    assert.ok(!roster.participants.some(p => p.username === 'remove-me'), 'removed participant must not still be in the roster');

    const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
    assert.ok(!cfg.participants.some(p => p.username === 'remove-me'), 'removed participant must not still be in trip.config.json');

    // Telegram login must no longer resolve for them — their id was cleared,
    // not reassigned, so it's now free for someone else to bind instead.
    const rebind = await api('/api/agent/participants/dana/telegram', { method: 'PATCH', apiKey: AGENT_KEY, body: { telegram_id: '888000111' } });
    assert.equal(rebind.status, 200, 'the removed participant\'s telegram_id should be free to rebind elsewhere');
  });
});
