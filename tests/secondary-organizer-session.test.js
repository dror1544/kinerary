// #523 — a SECONDARY organizer on the trip site: an organizer of THIS trip's site only, vouched for by the control plane through
// the same session exchange as any member, with no dashboard and no power over people.
//
// Every assertion is a request against the real server (server/server.js) and its real exchange route; the gateway is not
// needed because the exchange is the whole of the site's half. The cases are the ones AC-6 and AC-7 name: organizer-only routes
// accept the secondary organizer for this trip; the routes that manage PEOPLE do not; a session for another trip is nothing;
// and a plain token for the secondary organizer's local name is nothing either.
import { freePort } from './helpers/port-guard.js';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const jwt = require('jsonwebtoken');

const tripId = 'trip_secondarytest1', ownerId = 'user_secondaryowner', secondaryId = 'user_secondaryorg01', otherSecondaryId = 'user_secondaryorg02';
const key = 'test-dedicated-exchange-key-523';
const dashboardUrl = `https://portal.example.test/trips/${tripId}/setup`;
let temp, aliceToken, secondaryToken, secondaryName;
const exchange = (body, apiKey = key) => api('/api/internal/control-plane/session', { method: 'POST', apiKey, body });
const secondaryBody = (extra = {}) => ({ tripId, userId: secondaryId, role: 'organizer', runtimeUsername: null, ...extra });

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'secondary-organizer-test-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
  const port = await freePort();
  await startTestServer({ PORT: port, CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest });
  aliceToken = await loginAsAlice();
});
after(() => { stopTestServer(); rmSync(temp, { recursive: true, force: true }); });

test('the exchange gives a secondary organizer a session for THIS trip, and only the key holder can ask', async () => {
  for (const options of [{ apiKey: null }, { apiKey: 'wrong' }, { apiKey: 'test-hermes-key' }]) {
    const r = await exchange(secondaryBody(), options.apiKey);
    assert.equal(r.status, 401);
  }
  const r = await exchange(secondaryBody({ dashboardUrl }));
  assert.equal(r.status, 200);
  secondaryToken = (await r.json()).token;
  secondaryName = jwt.verify(secondaryToken, 'test-secret-000').username;
  assert.match(secondaryName, /^org-[0-9a-f]{12}$/);
  // Idempotent: the same person gets the same local name every time.
  assert.equal(jwt.verify((await (await exchange(secondaryBody())).json()).token, 'test-secret-000').username, secondaryName);
  // Another trip's id is refused outright.
  assert.equal((await exchange(secondaryBody({ tripId: 'trip_anothertrip' }))).status, 403);
});

test('AC-6: the secondary organizer gets the organizer view for this trip, and no dashboard', async () => {
  const me = await (await api('/api/auth/me', { token: secondaryToken })).json();
  assert.equal(me.username, secondaryName);
  assert.equal(me.is_organizer, true);
  assert.equal(me.is_secondary_organizer, true);
  assert.equal('dashboard_url' in me, false, 'no way back to a dashboard they cannot open, even though the exchange was offered one');
  assert.equal(me.password, undefined);
  // The organizer-only reads and writes accept them (organizerOrAgentRequired).
  assert.equal((await api('/api/agent/brief', { token: secondaryToken })).status, 200);
  assert.equal((await api('/api/stops', { token: secondaryToken })).status, 200);
  assert.equal((await api('/api/config', { token: secondaryToken })).status, 200);
  // ...and see the same trip config a member does: the allow-list is untouched (no organizer-only field appears).
  const config = await (await api('/api/config', { token: secondaryToken })).json();
  const memberView = await (await api('/api/config', { token: aliceToken })).json();
  assert.deepEqual(Object.keys(config).sort(), Object.keys(memberView).sort());
  // Draft bookings are the organizer's workbench: the secondary organizer reviews them like the main one.
  assert.equal((await api('/api/bookings', { token: secondaryToken })).status, 200);
});

test('AC-7 (site half): the routes that manage PEOPLE refuse the secondary organizer, and none of them changed state', async () => {
  const refused = async (path, options) => {
    const r = await api(path, { token: secondaryToken, ...options });
    assert.equal(r.status, 403, `${options?.method || 'GET'} ${path}`);
    assert.deepEqual(await r.json(), { error: 'organizer_only' });
  };
  // Cannot add organizers or participants...
  await refused('/api/agent/participants', { method: 'POST', body: { username: 'mallory', name: 'Mallory' } });
  // ...cannot take over the main organizer (reset their password, rebind their Telegram, remove them)...
  await refused('/api/agent/participants/alice/reset-password', { method: 'POST' });
  await refused('/api/agent/participants/alice/telegram', { method: 'PATCH', body: { telegram_id: '123456' } });
  await refused('/api/agent/participants/bob', { method: 'DELETE' });
  // ...cannot rebind the trip's Telegram group.
  await refused('/api/agent/telegram-group', { method: 'POST', body: { chat_id: '-100123' } });
  // Nothing was created: mallory cannot log in, and alice's password still works.
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'mallory', password: '1234' } })).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'alice', password: '1234' } })).status, 200);
  // The main organizer's token still manages people (the route is not simply closed).
  assert.notEqual((await api('/api/agent/participants/alice/reset-password', { method: 'POST', token: aliceToken })).status, 403);
});

test('a secondary organizer is not a member and cannot be made one, or an owner', async () => {
  // Escalation to the owner, or demotion to a member, through the exchange.
  assert.equal((await exchange(secondaryBody({ role: 'owner' }))).status, 403);
  assert.equal((await exchange(secondaryBody({ role: 'member' }))).status, 403);
  // A named runtime username is a participant binding, which this role never has.
  assert.equal((await exchange(secondaryBody({ userId: otherSecondaryId, runtimeUsername: 'bob' }))).status, 403);
  // The participants route will not bind a member to the secondary organizer's local name.
  const r = await api('/api/internal/control-plane/participants', { method: 'POST', apiKey: key, body: { tripId, userId: 'user_someonenew01', runtimeUsername: secondaryName, inviteId: 'invite_secondaryx1' } });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'ORGANIZER_BINDING_FORBIDDEN' });
});

test('a plain token for the secondary organizer\'s local name is nothing: only a managed session counts', async () => {
  // They have no password, so a login is impossible...
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: secondaryName, password: '1234' } })).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: secondaryName, password: '' } })).status, 400);
  // ...and a token signed for that name WITHOUT the control-plane claim (the legacy shape) is not an organizer.
  const plain = jwt.sign({ username: secondaryName }, 'test-secret-000', { expiresIn: '1h' });
  const r = await api('/api/agent/brief', { token: plain });
  assert.equal(r.status, 403);
  assert.equal((await api('/api/auth/me', { token: plain })).status, 200, 'the legacy shape still authenticates as before');
  assert.equal((await (await api('/api/auth/me', { token: plain })).json()).is_organizer, false);
});

test('a session minted for another trip, or for a binding this site never made, is nothing', async () => {
  const forgedForOtherTrip = jwt.sign({ username: secondaryName, controlPlane: { userId: secondaryId, tripId: 'trip_anothertrip', role: 'organizer' } }, 'test-secret-000', { expiresIn: '1h' });
  assert.equal((await api('/api/agent/brief', { token: forgedForOtherTrip })).status, 401);
  const unknownUser = jwt.sign({ username: secondaryName, controlPlane: { userId: 'user_neverbound001', tripId, role: 'organizer' } }, 'test-secret-000', { expiresIn: '1h' });
  assert.equal((await api('/api/agent/brief', { token: unknownUser })).status, 401);
  const asOwner = jwt.sign({ username: secondaryName, controlPlane: { userId: secondaryId, tripId, role: 'owner' } }, 'test-secret-000', { expiresIn: '1h' });
  assert.equal((await api('/api/agent/brief', { token: asOwner })).status, 401);
  const asMember = jwt.sign({ username: secondaryName, controlPlane: { userId: secondaryId, tripId, role: 'member' } }, 'test-secret-000', { expiresIn: '1h' });
  assert.equal((await api('/api/agent/brief', { token: asMember })).status, 401);
});

test('the main organizer keeps every organizer power, and a member still gets none', async () => {
  assert.equal((await api('/api/agent/brief', { token: aliceToken })).status, 200);
  const me = await (await api('/api/auth/me', { token: aliceToken })).json();
  assert.equal(me.is_organizer, true);
  assert.equal(me.is_secondary_organizer, undefined);
  const bob = await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json();
  assert.equal((await api('/api/agent/brief', { token: bob.token })).status, 403);
});
