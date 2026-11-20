// GET /api/internal/control-plane/participants: the trip site's participant list for the control plane's group sign-in
// (docs/specs/sprint-9/x-member-sign-in.md, slice S1). Internal-key only, never reachable with a family JWT, and a
// three-field projection that cannot carry anything else of a participant.
import { freePort } from './helpers/port-guard.js';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

const tripId = 'trip_participantlist01', ownerId = 'user_listowner';
const key = 'test-dedicated-exchange-key';
const path = '/api/internal/control-plane/participants';
let temp;
const list = (options = {}) => api(path, { apiKey: key, ...options });
// The gateway sends the trip id in a header on GET, as for the sibling participant lookup.
const asGateway = (headers = {}) => fetch(`${process.env.TEST_BASE_URL}${path}`, { headers: { 'x-api-key': key, 'x-control-plane-trip-id': tripId, ...headers } });

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'participants-list-test-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
  const port = await freePort();
  process.env.TEST_BASE_URL = `http://localhost:${port}`;
  await startTestServer({ PORT: port, CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)) });
});
after(() => { stopTestServer(); rmSync(temp, { recursive: true, force: true }); });

test('a browser login, the agent key, a wrong key and no credential at all are all refused with the same 401', async () => {
  const browserToken = await loginAsAlice();
  const bodies = new Set();
  for (const headers of [{ 'x-api-key': undefined }, { authorization: `Bearer ${browserToken}`, 'x-api-key': undefined }, { 'x-api-key': 'test-hermes-key' }, { 'x-api-key': 'wrong-key' }]) {
    const clean = Object.fromEntries(Object.entries({ 'x-control-plane-trip-id': tripId, ...headers }).filter(([, v]) => v !== undefined));
    const r = await fetch(`${process.env.TEST_BASE_URL}${path}`, { headers: clean });
    assert.equal(r.status, 401, JSON.stringify(Object.keys(clean)));
    bodies.add(await r.text());
  }
  assert.deepEqual([...bodies], ['{"error":"AUTHENTICATION_REQUIRED"}']);
});

test('the right key still needs this trip: another trip id, or none, is 403 TRIP_MISMATCH', async () => {
  for (const headers of [{ 'x-control-plane-trip-id': 'trip_anothertrip0001' }, { 'x-control-plane-trip-id': '' }]) {
    const r = await fetch(`${process.env.TEST_BASE_URL}${path}`, { headers: { 'x-api-key': key, ...headers } });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'TRIP_MISMATCH' });
  }
});

test('the list is username, display name and role, and nothing else of a participant', async () => {
  const r = await asGateway();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.deepEqual(Object.keys(body), ['participants']);
  assert.deepEqual(body.participants.map(p => Object.keys(p).sort()), body.participants.map(() => ['displayName', 'role', 'username']));
  const byName = Object.fromEntries(body.participants.map(p => [p.username, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['alice', 'bob', 'eve']);
  assert.equal(byName.alice.role, 'organizer', 'the configured organizer is not a member');
  assert.equal(byName.bob.role, 'member');
  assert.equal(byName.eve.role, 'member');
  assert.equal(byName.bob.displayName, 'בוב');
  // What the fixture holds and the list must never carry: needs (health data), age, family, colour, Telegram ids.
  const text = JSON.stringify(body);
  for (const leaked of ['peanut', 'אלרגיה', 'needs', 'age', 'family', 'color', '#3B82F6', 'telegram', 'password', 'name_en', 'Alice']) {
    assert.ok(!text.includes(leaked), `${leaked} is not in the list`);
  }
});

test('a participant who is removed from the trip drops off the list', async () => {
  const before = (await (await asGateway()).json()).participants.map(p => p.username);
  assert.ok(before.includes('eve'));
  const removed = await api('/api/agent/participants/eve', { method: 'DELETE', apiKey: 'test-hermes-key' });
  assert.equal(removed.status, 200);
  const after = (await (await asGateway()).json()).participants.map(p => p.username);
  assert.deepEqual(after.sort(), ['alice', 'bob']);
});

test('the sibling routes and the public config are unchanged by it: the list is not served to a family JWT or in /api/config', async () => {
  const token = await loginAsAlice();
  const config = await (await api('/api/config', { token })).text();
  assert.ok(!config.includes('control-plane/participants'));
  const r = await api(path, { token });
  assert.equal(r.status, 401);
  assert.equal((await list({ apiKey: key })).status, 403, 'without the trip header the exchange key alone is not enough');
});
