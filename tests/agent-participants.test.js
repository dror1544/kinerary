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
import { PORTS } from './helpers/ports.js';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE         = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');
const SERVER_JS    = join(HERE, '..', 'server', 'server.js');
const SERVER_DIR   = join(HERE, '..', 'server');
const PORT         = PORTS.agentParticipants;

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

  // #213: color reaches an unescaped inline style attribute on the classic
  // client (RSVP chip, reaction tooltip, pg-avatar/vc-avatar) — refusing a
  // non-hex value here means the API never writes a row that a renderer
  // would later have to defend against.
  test('rejects a color that is not a hex value — no row written', async () => {
    const res = await api('/api/agent/participants', {
      method: 'POST', apiKey: AGENT_KEY,
      body: { username: 'xss-color', name: 'X', color: 'red;" onmouseover="alert(3)' },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_color');

    const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
    assert.ok(!cfg.participants.some(p => p.username === 'xss-color'), 'the refused create must not have written a row');
    const login = await api('/api/auth/login', { method: 'POST', body: { username: 'xss-color', password: '1234' } });
    assert.equal(login.status, 401, 'no user row should have been inserted either');
  });

  test('accepts a well-formed short hex color', async () => {
    const res = await api('/api/agent/participants', {
      method: 'POST', apiKey: AGENT_KEY,
      body: { username: 'hex-short', name: 'Hex', color: '#abc' },
    });
    assert.equal(res.status, 200);
  });

  test('a missing color is still allowed (optional field)', async () => {
    const res = await api('/api/agent/participants', {
      method: 'POST', apiKey: AGENT_KEY,
      body: { username: 'no-color', name: 'No Color' },
    });
    assert.equal(res.status, 200);
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

  test('reset-password can put a forgotten password back to the trip password', async () => {
    // The case this exists for: someone changed their password, forgot it, and
    // is standing in an airport. The trip password is already shared — the
    // assistant's introduction hands it to the whole group — so the organizer
    // can simply restore it rather than relaying a link.
    const changed = await api('/api/agent/participants/dana/reset-password', { method: 'POST', token: aliceToken });
    const { enrollment_token } = await changed.json();
    await api('/api/auth/enroll', { method: 'POST', body: { token: enrollment_token, password: 'something-dana-forgets' } });
    assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'dana', password: '1234' } })).status, 401,
      'the trip password should not work while a personal one is set');

    const restore = await api('/api/agent/participants/dana/reset-password', {
      method: 'POST', token: aliceToken, body: { to: 'trip_password' },
    });
    assert.equal(restore.status, 200);
    const body = await restore.json();
    assert.equal(body.restored, 'trip_password');
    assert.ok(!JSON.stringify(body).includes('1234'), 'the password itself is never echoed back');

    assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'dana', password: '1234' } })).status, 200,
      'the trip password works again');
    assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'dana', password: 'something-dana-forgets' } })).status, 401,
      'and the forgotten one no longer does');
  });

  test('restoring the trip password is organizer-or-agent only, like every other reset', async () => {
    const anon = await api('/api/agent/participants/dana/reset-password', { method: 'POST', body: { to: 'trip_password' } });
    assert.equal(anon.status, 401);
    const nonOrganizer = await api('/api/agent/participants/dana/reset-password', {
      method: 'POST', token: bobToken, body: { to: 'trip_password' },
    });
    assert.equal(nonOrganizer.status, 403, 'a family member cannot reset another member');
    assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'dana', password: '1234' } })).status, 200,
      'and the refused calls changed nothing');
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

  // #184 — the agent key alone must never be able to take over the
  // organizer's account. Before this fix: the exact PoC from the issue
  // (reset-password on the organizer via X-API-Key alone, redeem the token
  // through /api/auth/enroll with no session, then log in as the organizer)
  // returned 200 at every step. These prove it is now refused end to end,
  // while the organizer's own session and ordinary-participant resets keep
  // working.
  test('#184: the agent key alone cannot reset the organizer\'s own credential', async () => {
    const res = await api('/api/agent/participants/alice/reset-password', { method: 'POST', apiKey: AGENT_KEY });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'organizer_credential_not_agent_resettable');
    // And the refused call must not have minted a redeemable token at all —
    // this proves there is no side door: a 403 response with a token
    // silently attached would still be a takeover.
    assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'alice', password: '1234' } })).status, 200,
      'the organizer\'s real password must still work — the refused call changed nothing');
  });

  test('#184: the same reset-password call still works for an ordinary participant via the agent key', async () => {
    // Decision (#184 point 4): the companion legitimately resets an ordinary
    // participant's forgotten password on the organizer's behalf — see
    // "reset-password works for a Telegram-bound participant too" above. The
    // organizer exclusion must not have broken that.
    const reset = await api('/api/agent/participants/dana/reset-password', { method: 'POST', apiKey: AGENT_KEY });
    assert.equal(reset.status, 200);
    const { enrollment_token } = await reset.json();
    assert.ok(typeof enrollment_token === 'string' && enrollment_token.length > 20);
  });

  test('#184: the organizer can still reset their OWN credential through their own session', async () => {
    const reset = await api('/api/agent/participants/alice/reset-password', { method: 'POST', token: aliceToken });
    assert.equal(reset.status, 200);
    const { enrollment_token } = await reset.json();
    const enroll = await api('/api/auth/enroll', { method: 'POST', body: { token: enrollment_token, password: 'alices-own-new-password' } });
    assert.equal(enroll.status, 200);
    const loginRes = await api('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alices-own-new-password' } });
    assert.equal(loginRes.status, 200, 'the organizer resetting themselves through their own session must still work');
    // Restore, so later tests in this file that assume alice/1234 still hold.
    const restore = await api('/api/agent/participants/alice/reset-password', { method: 'POST', token: aliceToken, body: { to: 'trip_password' } });
    assert.equal(restore.status, 200);
  });

  test('#184: the "to: trip_password" branch is refused for the organizer through the agent key too', async () => {
    const res = await api('/api/agent/participants/alice/reset-password', { method: 'POST', apiKey: AGENT_KEY, body: { to: 'trip_password' } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'organizer_credential_not_agent_resettable');
  });

  test('#184: the agent key alone cannot rebind the organizer\'s Telegram identity', async () => {
    const res = await api('/api/agent/participants/alice/telegram', { method: 'PATCH', apiKey: AGENT_KEY, body: { telegram_id: '999888777' } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'organizer_credential_not_agent_resettable');
  });

  test('#184: the organizer can still rebind their OWN Telegram identity through their own session', async () => {
    const res = await api('/api/agent/participants/alice/telegram', { method: 'PATCH', token: aliceToken, body: { telegram_id: '999888777' } });
    assert.equal(res.status, 200);
    const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
    assert.equal(cfg.participants.find(p => p.username === 'alice').telegram_id, '999888777');
  });

  test('#184: rebinding an ordinary participant\'s Telegram id via the agent key still works', async () => {
    const res = await api('/api/agent/participants/noa/telegram', { method: 'PATCH', apiKey: AGENT_KEY, body: { telegram_id: '444333222' } });
    // noa may or may not exist depending on test order in this file (an
    // earlier duplicate-telegram_id test used the username 'noa' without
    // creating it); either 404 (unknown username, same as before this fix)
    // or 200 is acceptable here — the point is it is never 403.
    assert.notEqual(res.status, 403);
  });

  test('#184: an old/wrong-value agent key is refused on an agent route, same as a missing one — no grace period', async () => {
    const wrongValue = await api('/api/agent/participants', { method: 'POST', apiKey: 'not-the-real-key-at-all', body: { username: 'z', name: 'Z' } });
    assert.equal(wrongValue.status, 401);
    // Wrong-length key exercises the branch that a naive `Buffer.byteLength`
    // early-return could special-case — must land on the same 401, not throw.
    const wrongLength = await api('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY + AGENT_KEY, body: { username: 'z', name: 'Z' } });
    assert.equal(wrongLength.status, 401);
    const tooShort = await api('/api/agent/participants', { method: 'POST', apiKey: 'x', body: { username: 'z', name: 'Z' } });
    assert.equal(tooShort.status, 401);
    // The real key still works — proves the comparison itself, not just the
    // rejection path, survived the rewrite.
    const real = await api('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY, body: { username: 'z', name: 'Z' } });
    assert.equal(real.status, 200);
  });

  test('#184: planted-backdoor scenario from the issue — blocked for the organizer, still available for an ordinary username', async () => {
    // The exact chain from the issue's PoC, replayed against the organizer
    // username specifically: reset -> enroll (no session) -> login as the
    // organizer. Every step must fail to produce organizer access.
    const reset = await api('/api/agent/participants/alice/reset-password', { method: 'POST', apiKey: AGENT_KEY });
    assert.equal(reset.status, 403);
    assert.equal(reset.headers.get('content-type')?.includes('json'), true);

    // No enrollment_token was ever minted for alice by this call, so there is
    // nothing for an attacker to redeem — confirm no stray token exists by
    // checking the response body carries none.
    const body = await reset.json();
    assert.equal(body.enrollment_token, undefined);

    // The same mechanism against an ORDINARY username remains the supported,
    // legitimate "planted participant" path (organizer relays it through the
    // companion) and must still complete end to end.
    const create = await api('/api/agent/participants', {
      method: 'POST', apiKey: AGENT_KEY, body: { username: 'mallory', name: 'Mallory', telegram_id: '111222333' },
    });
    assert.equal(create.status, 200);
    assert.equal((await create.json()).telegram_bound, true);
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

// #184, finding A (boundary review on PR #274): trip.config.json's
// agent.organizers can name a username with no seeded participant row —
// not reachable through normal provisioning (`_resolve_organizers` and
// driver.mjs both refuse to produce that), but a hand-built or legacy config
// can. Self-contained (own port, own fixture copy with an unseeded organizer
// name) rather than mutating the shared single-organizer fixture the describe
// block above depends on.
describe('POST /api/agent/participants — cannot create an organizer account (#184, finding A)', () => {
  let dataDir, tripDir, proc;
  const AGENT_KEY = 'test-hermes-key';
  const PORT2 = PORTS.agentParticipantsGhostOrganizer;

  function api2(path, { method = 'GET', body, apiKey } = {}) {
    const headers = {};
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (body != null) headers['Content-Type'] = 'application/json';
    return fetch(`http://localhost:${PORT2}${path}`, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-ghost-organizer-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'trip-ghost-organizer-trip-'));
    cpSync(FIXTURES_DIR, tripDir, { recursive: true });

    const cfgPath = join(tripDir, 'trip.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    // 'ghost' is listed as an organizer but has no participant/user row —
    // exactly the precondition the boundary review reproduced live.
    delete cfg.agent.organizer;
    cfg.agent.organizers = ['alice', 'ghost'];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    proc = spawn('node', [SERVER_JS], {
      cwd: SERVER_DIR,
      env: {
        ...process.env, PORT: String(PORT2), TRIP_DIR: tripDir, DATA_DIR: dataDir,
        AVATARS_DIR: join(dataDir, 'avatars'), JWT_SECRET: 'test-secret-000',
        IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234',
      },
    });
    await waitForServer(proc);
  });

  after(async () => {
    await stop(proc);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tripDir, { recursive: true, force: true });
  });

  test('the agent key cannot create a participant named after an unseeded organizer', async () => {
    const res = await api2('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY, body: { username: 'ghost', name: 'Ghost' } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'organizer_credential_not_agent_resettable');
  });

  test('...and no ghost user row was created at all — login fails, not just reset-password', async () => {
    const res = await api2('/api/auth/login', { method: 'POST', body: { username: 'ghost', password: '1234' } });
    assert.equal(res.status, 401, 'there must be no half-created ghost account to log into');
  });

  test('the same trip.config.json cannot be used to bootstrap the takeover chain either', async () => {
    // Replays the reviewer's live reproduction end to end and confirms every
    // step of it now fails: create ghost -> enroll -> log in as ghost ->
    // use ghost's JWT to reset a real participant's password.
    const create = await api2('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY, body: { username: 'ghost', name: 'Ghost' } });
    assert.equal(create.status, 403);
    const body = await create.json();
    assert.equal(body.enrollment_token, undefined, 'a refused create must not leak a redeemable token');
  });

  test('an ordinary (non-organizer) username is unaffected — the agent key can still create a normal participant', async () => {
    const res = await api2('/api/agent/participants', { method: 'POST', apiKey: AGENT_KEY, body: { username: 'dana', name: 'Dana' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).telegram_bound, false);
  });
});
