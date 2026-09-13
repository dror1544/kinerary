import { PORTS } from './helpers/ports.js';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';
import { startTestMcp, stopTestMcp, mcpCallTool } from './helpers/mcp.js';

const tripId = 'trip_sessiontest01', ownerId = 'user_sessionowner', memberId = 'user_sessionmember';
const key = 'test-dedicated-exchange-key';
let temp, ownerToken, gateway, controlPlane, gatewayOrigin;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const sessionBody = (extra = {}) => ({ tripId, userId: ownerId, role: 'owner', runtimeUsername: null, ...extra });
const exchange = (body = sessionBody(), apiKey = key) => api('/api/internal/control-plane/session', { method: 'POST', apiKey, body });
const enroll = body => api('/api/internal/control-plane/participants', { method: 'POST', apiKey: key, body: { tripId, userId: memberId, runtimeUsername: 'bob', inviteId: 'invite_sessiontest', ...body } });

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'runtime-identity-test-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' } }));
  await startTestServer({ PORT: PORTS.controlPlaneSession, CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)) });
  await loginAsAlice();
  await startTestMcp({ MCP_PORT: String(PORTS.controlPlaneSessionMcp), API_BASE_URL: `http://127.0.0.1:${PORTS.controlPlaneSession}`, TRIP_API_KEY: 'test-hermes-key' });
  controlPlane = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-api-key'], key);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/internal/runtime-launch/consume') {
      let body = ''; for await (const chunk of req) body += chunk;
      const token = JSON.parse(body).token;
      if (token !== 'owner-grant' && token !== 'member-grant') { res.writeHead(401); return res.end('{}'); }
      return res.end(JSON.stringify({ ...sessionBody(token === 'member-grant' ? { userId: memberId, role: 'member', runtimeUsername: 'bob' } : {}), audience: 'runtime_gateway' }));
    }
    if (req.url === `/internal/runtime-routes/${tripId}`) return res.end(JSON.stringify({ routeRef: 'fixture', upstreamOrigin: `http://127.0.0.1:${PORTS.controlPlaneSession}`, upstreamBasePath: '' }));
    res.writeHead(404); res.end('{}');
  });
  Object.assign(process.env, { NODE_ENV: 'test', CONTROL_PLANE_INTERNAL_ORIGIN: await listen(controlPlane),
    RUNTIME_EXCHANGE_KEY: key, RUNTIME_COOKIE_SECRET: 'test-cookie-secret', PORTAL_ORIGIN: 'http://portal.example.test', RUNTIME_ORIGIN: 'http://runtime.example.test' });
  const { createRuntimeGateway } = await import('../control-plane/runtime-gateway/server.js');
  gateway = createRuntimeGateway(); gatewayOrigin = await listen(gateway);
});
after(async () => { await Promise.all([close(gateway), close(controlPlane)]); stopTestMcp(); stopTestServer(); rmSync(temp, { recursive: true, force: true }); });

test('session minting rejects browser and agent credentials; a dedicated key is required', async () => {
  const browserToken = await loginAsAlice();
  for (const options of [{}, { token: browserToken }, { apiKey: 'test-hermes-key' }, { apiKey: 'wrong' }]) {
    const r = await api('/api/internal/control-plane/session', { method: 'POST', body: sessionBody(), ...options });
    assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'AUTHENTICATION_REQUIRED' });
  }
});

test('a seeded owner receives the same Classic identity and existing organizer permissions', async () => {
  const r = await exchange(); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  ownerToken = (await r.json()).token;
  const me = await (await api('/api/auth/me', { token: ownerToken })).json();
  assert.equal(me.username, 'alice'); assert.equal(me.is_organizer, true);
  assert.equal((await api('/api/agent/brief', { token: ownerToken })).status, 200);
  assert.equal((await api('/classic.html')).status, 200);
  assert.equal((await api('/modern/')).status, 200);
});

test('wrong trip, unknown identities, role escalation and mismatched local names fail closed', async () => {
  assert.equal((await exchange(sessionBody({ tripId: 'trip_anothertrip' }))).status, 403);
  for (const extra of [{ userId: 'user_unknownuser' }, { runtimeUsername: 'bob' }, { role: 'member' }]) {
    const r = await exchange(sessionBody(extra)); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'IDENTITY_MISMATCH' });
  }
  assert.equal((await exchange(sessionBody({ role: 'super_admin' }))).status, 400);
});

test('member enrollment is idempotent, never replaces Classic passwords, and cannot claim an organizer', async () => {
  assert.equal((await enroll()).status, 200);
  assert.equal((await enroll()).status, 200);
  assert.equal((await enroll({ userId: 'user_different01' })).status, 409);
  assert.equal((await enroll({ runtimeUsername: 'eve' })).status, 409);
  assert.equal((await enroll({ runtimeUsername: 'alice', userId: 'user_otherowner' })).status, 403);
  const r = await exchange(sessionBody({ userId: memberId, role: 'member', runtimeUsername: 'bob' }));
  assert.equal(r.status, 200); const { token } = await r.json();
  const me = await (await api('/api/auth/me', { token })).json();
  assert.equal(me.username, 'bob'); assert.equal(me.is_organizer, false);
  const denied = await api('/api/agent/brief', { token });
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'organizer_only' });
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).status, 200);
  assert.equal((await exchange(sessionBody({ userId: memberId, role: 'owner', runtimeUsername: 'bob' }))).status, 403);
});

async function launch(token) {
  const r = await fetch(`${gatewayOrigin}/t/${tripId}/__launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(r.status, 204); return r.headers.get('set-cookie').split(';')[0];
}

test('the real gateway exchanges a grant against the real runtime and serves Classic and Modern', async () => {
  const cookie = await launch('owner-grant');
  for (const path of ['/classic.html', '/modern/', '/modern/runtime-base.js', '/api/auth/me']) {
    const r = await fetch(`${gatewayOrigin}/t/${tripId}${path}`, { headers: { cookie } });
    assert.equal(r.status, 200, path);
    if (path === '/api/auth/me') assert.equal((await r.json()).username, 'alice');
  }
  assert.equal((await fetch(`${gatewayOrigin}/t/trip_anothertrip/api/auth/me`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${gatewayOrigin}/t/${tripId}/api/internal/control-plane/session`, { method: 'POST', headers: { cookie } })).status, 404);
  const memberCookie = await launch('member-grant');
  assert.equal((await fetch(`${gatewayOrigin}/t/${tripId}/api/agent/brief`, { headers: { cookie: memberCookie } })).status, 403);
});

test('two gateway streams observe a persisted real MCP write within two seconds and reconnect', async () => {
  const cookie = await launch('owner-grant');
  const controllers = [];
  async function stream() {
    const controller = new AbortController(); controllers.push(controller);
    const r = await fetch(`${gatewayOrigin}/t/${tripId}/api/events`, { headers: { cookie }, signal: controller.signal });
    assert.equal(r.status, 200); const reader = r.body.getReader(); let buffer = '';
    return async () => {
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        while (!buffer.includes('\n\n')) { const { value, done } = await reader.read(); assert.equal(done, false); buffer += new TextDecoder().decode(value); }
        const end = buffer.indexOf('\n\n'); const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); return frame;
      } finally { clearTimeout(timeout); }
    };
  }
  try {
    const a = await stream(), b = await stream(); await a(); await b();
    const result = await mcpCallTool('add_budget_item', { phase: 'ny', category: 'food', description: 'Gateway MCP fixture', amount: 42 });
    assert.notEqual(result.isError, true);
    for (const frame of await Promise.all([a(), b()])) { assert.match(frame, /event: change/); assert.match(frame, /"budget":/); assert.doesNotMatch(frame, /Gateway MCP fixture/); }
    const rows = await (await fetch(`${gatewayOrigin}/t/${tripId}/api/budget`, { headers: { cookie } })).json();
    assert.ok(rows.some(row => row.description === 'Gateway MCP fixture'));
    const c = await stream(); assert.match(await c(), /"budget":[1-9]/);
  } finally { controllers.forEach(c => c.abort()); }
});

test('gateway logout expires only this trip cookie and rejects cross-origin requests', async () => {
  const cookie = await launch('owner-grant');
  const url = `${gatewayOrigin}/t/${tripId}/__logout`;
  assert.equal((await fetch(url, { method: 'POST', headers: { cookie } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { cookie, 'x-kinerary-logout': '1', origin: 'http://evil.example' } })).status, 403);
  const r = await fetch(url, { method: 'POST', headers: { cookie, 'x-kinerary-logout': '1' } });
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0/); assert.match(r.headers.get('set-cookie'), new RegExp(`Path=/t/${tripId}/`));
  assert.deepEqual(await r.json(), { portalUrl: 'http://portal.example.test' });
  assert.equal((await fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`)).status, 401);
});


test('removing a participant also refuses future gateway sessions and existing managed tokens', async () => {
  const response = await exchange(sessionBody({ userId: memberId, role: 'member', runtimeUsername: 'bob' }));
  const { token } = await response.json();
  assert.equal((await api('/api/agent/participants/bob', { method: 'DELETE', token: ownerToken })).status, 200);
  assert.equal((await exchange(sessionBody({ userId: memberId, role: 'member', runtimeUsername: 'bob' }))).status, 403);
  const me = await api('/api/auth/me', { token });
  assert.equal(me.status, 401); assert.deepEqual(await me.json(), { error: 'invalid_token' });
});
