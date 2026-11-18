/**
 * settings-nav-app.test.js — the per-trip "Navigation app: Google Maps | Waze" setting
 * (video Release 1 look polish). It rides /api/settings like the timezone and the group line:
 * members read it, only an organizer (or the agent key) changes it, and anything that is not
 * exactly "google" or "waze" is refused on write and read as Google Maps on read.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, loginAsAlice, api } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

let token;
before(async () => { await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() }); token = await loginAsAlice(); });
after(stopTestServer);

const patch = (body, extra = { token }) => api('/api/settings', { method: 'PATCH', body, ...extra });
const read = async (extra = { token }) => (await api('/api/settings', extra)).json();
const memberToken = async () => (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;

test('a fresh site reads nav_app "google" (the default)', async () => {
  assert.equal((await read()).nav_app, 'google');
});

test('an organizer sets Waze, it is stored and read back, and the other settings are left alone', async () => {
  const before = await read();
  const res = await patch({ nav_app: 'waze' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.nav_app, 'waze');
  assert.equal(body.group_change_line, before.group_change_line);
  assert.equal(body.timezone, before.timezone);
  assert.equal(body.updated_by, 'alice');
  assert.equal((await read()).nav_app, 'waze');
});

test('a body with only the timezone leaves nav_app as it was', async () => {
  assert.equal((await patch({ nav_app: 'waze' })).status, 200);
  assert.equal((await patch({ timezone: 'Asia/Tokyo' })).status, 200);
  assert.equal((await read()).nav_app, 'waze');
  assert.equal((await patch({ nav_app: 'google' })).status, 200);
  assert.equal((await read()).nav_app, 'google');
});

test('anything but "google" or "waze" is 400 and changes nothing', async () => {
  const before = await read();
  for (const value of ['Waze', 'apple', '', null, true, 1, [], {}]) {
    const res = await patch({ nav_app: value });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.match((await res.json()).error, /nav_app/);
  }
  assert.deepEqual(await read(), before);
});

test('a member can read the setting but cannot change it (organizerOrAgentRequired): 403 and nothing stored', async () => {
  const member = await memberToken();
  const before = await read();
  const res = await patch({ nav_app: before.nav_app === 'waze' ? 'google' : 'waze' }, { token: member });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'organizer_only' });
  assert.deepEqual(await read({ token: member }), before);
});

test('no token at all is 401, and nothing is stored', async () => {
  const before = await read();
  const res = await patch({ nav_app: 'waze' }, { token: undefined });
  assert.equal(res.status, 401);
  assert.deepEqual(await read(), before);
});
