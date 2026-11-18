/**
 * settings-group-line.test.js — the organizer's "tell the group when the plan changes" setting
 * (video Release 1C, docs/specs/sprint-9/x-video-r1-group-line.md: AC-22, AC-23, AC-25).
 *
 * Over the real running server: GET/PATCH /api/settings, the partial update (a body with only one
 * setting leaves the other alone), the organizer-only write, and the on-by-default read.
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

test('AC-25: a fresh site reads group_change_line true (on by default)', async () => {
  const body = await read();
  assert.equal(body.group_change_line, true);
  assert.equal(body.timezone, null);
});

test('AC-22: an organizer turns it off; it is stored, GET returns it, and the timezone is unchanged', async () => {
  const tz = await patch({ timezone: 'Europe/Paris' });
  assert.equal(tz.status, 200);
  const res = await patch({ group_change_line: false });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.group_change_line, false);
  assert.equal(body.timezone, 'Europe/Paris', 'a body with only the setting leaves the timezone alone');
  assert.equal(body.updated_by, 'alice');
  assert.equal((await read()).group_change_line, false);
});

test('AC-22: a body with only the timezone leaves group_change_line as it was', async () => {
  assert.equal((await patch({ group_change_line: false })).status, 200);
  const res = await patch({ timezone: 'Asia/Tokyo' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.timezone, 'Asia/Tokyo');
  assert.equal(body.group_change_line, false);
  assert.equal((await patch({ group_change_line: true })).status, 200);
  assert.equal((await patch({ timezone: 'Asia/Tokyo' })).status, 200);
  assert.equal((await read()).group_change_line, true);
});

test('AC-22: a non-boolean is 400 and changes nothing', async () => {
  const before = await read();
  for (const value of ['false', 0, 1, null, 'yes', [], {}]) {
    const res = await patch({ group_change_line: value });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.match((await res.json()).error, /group_change_line/);
  }
  assert.deepEqual(await read(), before);
});

test('a PATCH with neither setting is still the timezone\'s 400, and a bad zone beside a good setting still refuses the whole write', async () => {
  assert.equal((await patch({})).status, 400);
  const before = await read();
  const res = await patch({ timezone: 'Vietnam', group_change_line: !before.group_change_line });
  assert.equal(res.status, 400);
  assert.deepEqual(await read(), before, 'nothing was half-written');
});

test('AC-23: a member cannot change it (organizerOrAgentRequired, as today) but can read it', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } });
  const { token: memberToken } = await login.json();
  const before = await read();
  const res = await patch({ group_change_line: !before.group_change_line }, { token: memberToken });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'organizer_only' });
  assert.deepEqual(await read({ token: memberToken }), before);
});

test('the agent key may set it, like the timezone (the companion works through it)', async () => {
  const res = await patch({ group_change_line: true }, { apiKey: 'test-hermes-key' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).group_change_line, true);
});
