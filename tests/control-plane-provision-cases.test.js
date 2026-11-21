// The REAL trip site's INVITE binding (POST /api/internal/control-plane/participants: the personal invite for an existing
// traveller, docs/specs/sprint-9/x-member-sign-in.md, AC-10) held to the `provision` section of the shared case table
// tests/fixtures/site-binding-cases.json. control-plane/api/test/site-binding-cases.test.ts runs the SAME section against the
// control-plane tests' fake site, so the fake cannot drift from the site without one of the two runs failing.
//
// An invite binding is permanent (release refuses it, by design), so EVERY case runs against a freshly started site. The
// outcome that matters most is the one a person feels: after the redeem, the exchange gives a member token for THAT existing
// participant, and the participant's own record (name, role, password) is exactly what it was.
import { freePort } from './helpers/port-guard.js';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, stopTestServer, api } from './helpers/server.js';

const table = JSON.parse(readFileSync(new URL('./fixtures/site-binding-cases.json', import.meta.url), 'utf8'));
const tripId = 'trip_provisioncase1', ownerId = 'user_provowner0001';
const key = 'test-dedicated-exchange-key';
const [ACTOR, PREVIOUS] = ['user_actor000001', 'user_previous0001'];
const INVITE = 'invite_provisioncase01', OTHER_INVITE = 'invite_provisioncase02';
const USERNAME = { member: 'bob', organizer: 'alice', unknown: 'nobody' };
const provision = (userId, runtimeUsername, inviteId = INVITE) => api('/api/internal/control-plane/participants', { method: 'POST', apiKey: key, body: { tripId, userId, runtimeUsername, inviteId } });
const adopt = (userId, runtimeUsername) => api('/api/internal/control-plane/participants/adopt', { method: 'POST', apiKey: key, body: { tripId, userId, runtimeUsername } });
const exchange = (userId, runtimeUsername) => api('/api/internal/control-plane/session', { method: 'POST', apiKey: key, body: { tripId, userId, runtimeUsername, role: 'member' } });
const holderOf = async (name) => ((await exchange(ACTOR, name)).status === 200 ? 'actor' : (await exchange(PREVIOUS, name)).status === 200 ? 'previous' : 'nobody');
const STATUS = { ok: [200], refused: [403, 404], conflict: [409] };

async function arrange(existing, name) {
  if (existing === 'actor_invite') assert.equal((await provision(ACTOR, name)).status, 200);
  if (existing === 'other_user') assert.equal((await adopt(PREVIOUS, name)).status, 200);
  if (existing === 'invite') assert.equal((await provision(PREVIOUS, name, OTHER_INVITE)).status, 200);
  if (existing === 'actor_on_other_participant') assert.equal((await adopt(ACTOR, 'eve')).status, 200);
}

test('the real site answers every PROVISION case of the shared table', async () => {
  assert.ok(Array.isArray(table.provision) && table.provision.length >= 7, 'the table has a provision section');
  for (const c of table.provision) {
    const temp = mkdtempSync(join(tmpdir(), 'provision-cases-test-'));
    try {
      const manifest = join(temp, 'identity.json');
      writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
      await startTestServer({ PORT: await freePort(), CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)) });
      const name = USERNAME[c.participant];
      await arrange(c.existing, name);
      const r = await provision(ACTOR, name);
      assert.ok(STATUS[c.result].includes(r.status), `${c.name}: got ${r.status}`);
      assert.equal(await holderOf(name), c.holder, `${c.name}: who holds it afterwards`);
    } finally { stopTestServer(); rmSync(temp, { recursive: true, force: true }); }
  }
});

test('redeeming an invite for an existing traveller changes nothing about the traveller: same name, still a plain member, same password', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'provision-cases-test-'));
  try {
    const manifest = join(temp, 'identity.json');
    writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
    await startTestServer({ PORT: await freePort(), CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)) });
    assert.equal((await provision(ACTOR, 'bob')).status, 200);
    const ex = await exchange(ACTOR, 'bob');
    assert.equal(ex.status, 200);
    const { token } = await ex.json();
    const me = await (await api('/api/auth/me', { token })).json();
    assert.equal(me.username, 'bob');
    assert.equal(me.is_organizer, false);
    assert.equal((await api('/api/agent/brief', { token })).status, 403, 'a member, never an organizer');
    assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).status, 200, "bob's own password still works");
    // the exchange is pinned to the name the invite named, and to the role member
    assert.equal((await exchange(ACTOR, 'eve')).status, 403);
    assert.equal((await api('/api/internal/control-plane/session', { method: 'POST', apiKey: key, body: { tripId, userId: ACTOR, runtimeUsername: 'bob', role: 'owner' } })).status, 403);
    // an invite-bound member is NOT a claimed session: it may set its own password (what the join page offers it), and the
    // participant record is otherwise untouched
    const set = await api('/api/auth/password', { method: 'PUT', token, body: { password: 'bobs-own-new-password' } });
    assert.equal(set.status, 200, await set.clone().text());
    assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobs-own-new-password' } })).status, 200);
    const after = await (await api('/api/auth/me', { token: (await (await exchange(ACTOR, 'bob')).json()).token })).json();
    assert.equal(after.username, 'bob');
    assert.equal(after.name, me.name, 'the display name is the one it always was');
  } finally { stopTestServer(); rmSync(temp, { recursive: true, force: true }); }
});
