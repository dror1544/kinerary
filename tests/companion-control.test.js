import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';
import { PORTS } from './helpers/ports.js';
let owner, member, sidecar, requests = [], unavailable = false;
const state = { scheduler_running: true, tasks: [{ id: 'trip-task', label: { he: 'עדכון בוקר', en: 'Morning update' }, audience: 'group', enabled: true, schedule: 'Daily at 08:00', timezone: 'Asia/Tokyo', next_run: '2026-09-14T08:00:00+09:00', prompt: 'must never reach browser' }] };
before(async () => {
  sidecar = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-control-token');
    if (unavailable) { res.writeHead(500); res.end('secret internal failure'); return; }
    let body = ''; for await (const part of req) body += part;
    if (body) {
      const command = JSON.parse(body); requests.push(command);
      if (command.id !== 'trip-task') { res.writeHead(404); res.end(); return; }
      state.tasks[0].enabled = command.action !== 'pause';
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state));
  });
  await new Promise(resolve => sidecar.listen(0, '127.0.0.1', resolve));
  await startTestServer({ PORT: PORTS.companionControl, COMPANION_CONTROL_URL: `http://127.0.0.1:${sidecar.address().port}`, COMPANION_CONTROL_TOKEN: 'test-control-token' });
  owner = await loginAsAlice();
  member = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
});
after(async () => { stopTestServer(); await new Promise(resolve => sidecar.close(resolve)); });
test('only the organizer or agent can read or control this trip’s tasks', async () => {
  for (const [token, status] of [[undefined, 401], [member, 403]]) {
    assert.equal((await api('/api/companion/tasks', { token })).status, status);
    assert.equal((await api('/api/companion/tasks/trip-task', { method: 'POST', token, body: { action: 'pause' } })).status, status);
  }
  assert.equal(requests.length, 0);
  const response = await api('/api/companion/tasks', { token: owner });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.tasks[0].enabled, true);
  assert.ok(!JSON.stringify(data).includes('prompt'));
});
test('pause/resume return confirmed state; unknown tasks and actions fail', async () => {
  for (const action of ['pause', 'resume']) {
    const response = await api('/api/companion/tasks/trip-task', { method: 'POST', token: owner, body: { action, profile: 'someone-else' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tasks[0].enabled, action === 'resume');
    assert.deepEqual(requests.at(-1), { id: 'trip-task', action });
  }
  assert.equal((await api('/api/companion/tasks/foreign-task', { method: 'POST', token: owner, body: { action: 'pause' } })).status, 404);
  assert.equal((await api('/api/companion/tasks/trip-task', { method: 'POST', token: owner, body: { action: 'delete' } })).status, 400);
});
test('adapter failures fail closed without leaking upstream errors', async () => {
  unavailable = true;
  const response = await api('/api/companion/tasks', { token: owner });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'companion_unavailable' });
});
