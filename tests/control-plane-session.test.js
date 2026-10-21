import { freePort } from './helpers/port-guard.js';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startTestServer, stopTestServer, api, loginAsAlice, testTripDir } from './helpers/server.js';
import { startTestMcp, stopTestMcp, mcpCallTool } from './helpers/mcp.js';

const tripId = 'trip_sessiontest01', ownerId = 'user_sessionowner', memberId = 'user_sessionmember';
const key = 'test-dedicated-exchange-key';
const dashboardUrl = `https://portal.example.test/trips/${tripId}/setup`;
let portalSignedOut = false;
const signedOutSessions = new Set();
let controlPlaneRole = 'owner';
let temp, ownerToken, gateway, controlPlane, gatewayOrigin, tripPort, mcpPort;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const sessionBody = (extra = {}) => ({ tripId, userId: ownerId, role: 'owner', runtimeUsername: null, ...extra });
const exchange = (body = sessionBody(), apiKey = key) => api('/api/internal/control-plane/session', { method: 'POST', apiKey, body });
const enroll = body => api('/api/internal/control-plane/participants', { method: 'POST', apiKey: key, body: { tripId, userId: memberId, runtimeUsername: 'bob', inviteId: 'invite_sessiontest', ...body } });

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'runtime-identity-test-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
  // Ports the OS hands out, not fixed ones: a leaked server from another run cannot hold them.
  tripPort = await freePort(); do { mcpPort = await freePort(); } while (mcpPort === tripPort);
  await startTestServer({ PORT: tripPort, CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)) });
  await loginAsAlice();
  await startTestMcp({ MCP_PORT: String(mcpPort), API_BASE_URL: `http://127.0.0.1:${tripPort}`, TRIP_API_KEY: 'test-hermes-key' });
  controlPlane = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-api-key'], key);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/internal/runtime-launch/consume') {
      let body = ''; for await (const chunk of req) body += chunk;
      const token = JSON.parse(body).token;
      if (token !== 'owner-grant' && token !== 'owner-grant-b' && token !== 'member-grant' && token !== 'evil-grant') { res.writeHead(401); return res.end('{}'); }
      const member = token === 'member-grant';
      // Same shape the control plane returns: a dashboard link for owners/organizers, null for members.
      return res.end(JSON.stringify({ ...sessionBody(member ? { userId: memberId, role: 'member', runtimeUsername: 'bob' } : {}), dashboardUrl: member ? null : token === 'evil-grant' ? `https://evil.example/trips/${tripId}/setup` : dashboardUrl, sessionId: token === 'owner-grant-b' ? 'wsess_deviceb0001' : 'wsess_devicea0001', audience: 'runtime_gateway' }));
    }
    if (req.url === '/internal/runtime-sessions/check') {
      let body = ''; for await (const chunk of req) body += chunk;
      const asked = JSON.parse(body);
      if (portalSignedOut || signedOutSessions.has(asked.sessionId) || (asked.role && asked.role !== (asked.userId === memberId ? 'member' : controlPlaneRole))) { res.writeHead(401); return res.end('{}'); }
      return res.end(JSON.stringify({ live: asked.tripId === tripId }));
    }
    if (req.url === `/internal/runtime-routes/${tripId}`) return res.end(JSON.stringify({ routeRef: 'fixture', upstreamOrigin: `http://127.0.0.1:${tripPort}`, upstreamBasePath: '' }));
    res.writeHead(404); res.end('{}');
  });
  Object.assign(process.env, { NODE_ENV: 'test', CONTROL_PLANE_INTERNAL_ORIGIN: await listen(controlPlane),
    RUNTIME_SESSION_CHECK_TTL_MS: '0', RUNTIME_EXCHANGE_KEY: key, RUNTIME_COOKIE_SECRET: 'test-cookie-secret', PORTAL_ORIGIN: 'https://portal.example.test', RUNTIME_ORIGIN: 'http://runtime.example.test' });
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

// The portal's top-level form POST: token in the body, Origin set by the browser.
async function launch(token) {
  const r = await fetch(`${gatewayOrigin}/t/${tripId}/__launch`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://portal.example.test' }, body: new URLSearchParams({ token }).toString() });
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), `/t/${tripId}/`); return r.headers.get('set-cookie').split(';')[0];
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
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0/); assert.match(r.headers.get('set-cookie'), new RegExp(`^kit_rt_${tripId}=;`)); assert.match(r.headers.get('set-cookie'), /Path=\/;/); assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  assert.deepEqual(await r.json(), { portalUrl: 'https://portal.example.test' });
  assert.equal((await fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`)).status, 401);
});


test('dashboard_url reaches organizers (through the gateway or by direct login) and never members or the agent key', async () => {
  const meOf = async options => await (await api('/api/auth/me', options)).json();
  // Owner, launched from the dashboard: the control plane's URL rides the signed session.
  const ownerCookie = await launch('owner-grant');
  const owner = await (await fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`, { headers: { cookie: ownerCookie } })).json();
  assert.equal(owner.username, 'alice'); assert.equal(owner.dashboard_url, dashboardUrl);
  // Not part of the public config, which stays on its allow-list.
  const config = await (await fetch(`${gatewayOrigin}/t/${tripId}/api/config`, { headers: { cookie: ownerCookie } })).text();
  assert.ok(!config.includes('dashboard') && !config.includes('portal.example.test'));
  // A member launched the same way gets none, even if the exchange carries a URL for them.
  const memberToken = (await (await exchange(sessionBody({ userId: memberId, role: 'member', runtimeUsername: 'bob', dashboardUrl }))).json()).token;
  assert.equal((await meOf({ token: memberToken })).dashboard_url, undefined);
  // A direct login (password, on the trip's own hostname) by an organizer gets the CONFIGURED
  // address of this trip's dashboard page; a direct login by a member, and the agent key, never do.
  const direct = await meOf({ token: await loginAsAlice() });
  assert.equal(direct.username, 'alice'); assert.equal(direct.dashboard_url, dashboardUrl);
  const bobLogin = await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } });
  assert.equal(bobLogin.status, 200);
  const directMember = await meOf({ token: (await bobLogin.json()).token });
  assert.equal(directMember.username, 'bob'); assert.equal(directMember.dashboard_url, undefined);
  const agent = await api('/api/auth/me', { apiKey: 'test-hermes-key' });
  assert.equal((await agent.text()).includes('dashboard_url'), false);
});

test('the session exchange drops a dashboard URL that is not plain https or loopback http', async () => {
  const bad = ['javascript:alert(1)', 'data:text/html,x', 'http://portal.example.test/x', 'https://user:pw@portal.example.test/x', `https://portal.example.test/${'a'.repeat(2100)}`, 'https://portal.example.test/a b', '//portal.example.test/x', `https://portal.example.test/trips/trip_anothertrip/setup`, `${dashboardUrl}?next=https://evil.example`, `${dashboardUrl}#x`, 'https://portal.example.test/', 42, { toString: () => 'https://x.test' }];
  for (const candidate of bad) {
    const token = (await (await exchange(sessionBody({ dashboardUrl: candidate }))).json()).token;
    // The signed claim carries none of it; what /api/auth/me serves is the trip's own configured address.
    assert.equal(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).controlPlane.dashboardUrl, undefined, String(candidate).slice(0, 40));
    assert.equal((await (await api('/api/auth/me', { token })).json()).dashboard_url, dashboardUrl, String(candidate).slice(0, 40));
  }
  const loopback = (await (await exchange(sessionBody({ dashboardUrl: `http://localhost:5173/trips/${tripId}/setup` }))).json()).token;
  // The runtime accepts loopback http into the signed claim (development); /api/auth/me still serves the
  // address the trip's own configuration names, which wins wherever the two differ.
  assert.equal(JSON.parse(Buffer.from(loopback.split('.')[1], 'base64url')).controlPlane.dashboardUrl, `http://localhost:5173/trips/${tripId}/setup`);
  assert.equal((await (await api('/api/auth/me', { token: loopback })).json()).dashboard_url, dashboardUrl);
});

test('a stored .html or .svg opened under /t/<trip>/ is never served as something that runs', async () => {
  // The runtime origin is shared by every trip now, so an executable upload would be script on that origin.
  const uploads = join(dirname(testTripDir()), 'uploads'); mkdirSync(uploads, { recursive: true });
  const payload = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>';
  for (const name of ['evil.svg', 'evil.html', 'evil.xhtml', 'evil.js']) writeFileSync(join(uploads, name), payload);
  const cookie = await launch('owner-grant');
  for (const name of ['evil.svg', 'evil.html', 'evil.xhtml', 'evil.js']) {
    const r = await fetch(`${gatewayOrigin}/t/${tripId}/api/photos/file/${name}`, { headers: { cookie } });
    assert.equal(r.status, 200, name);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream', name);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', name);
    assert.match(r.headers.get('content-security-policy'), /(^|;\s*)sandbox(;|$)/, name);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/, name);
  }
});

test('after the portal signs the person out, the trip session is refused', async () => {
  const cookie = await launch('owner-grant');
  const config = () => fetch(`${gatewayOrigin}/t/${tripId}/api/config`, { headers: { cookie } });
  assert.equal((await config()).status, 200);
  portalSignedOut = true;
  try { assert.equal((await config()).status, 401); assert.equal((await fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`, { headers: { cookie } })).status, 401); }
  finally { portalSignedOut = false; }
  assert.equal((await config()).status, 200);
});

test('signing out on one device ends only the trip session opened from it', async () => {
  const a = await launch('owner-grant'), b = await launch('owner-grant-b');
  const config = cookie => fetch(`${gatewayOrigin}/t/${tripId}/api/config`, { headers: { cookie } });
  assert.equal((await config(a)).status, 200); assert.equal((await config(b)).status, 200);
  signedOutSessions.add('wsess_devicea0001');
  try {
    assert.equal((await config(a)).status, 401, 'device A signed out of the portal');
    assert.equal((await config(b)).status, 200, 'device B is still signed in');
    assert.equal((await fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`, { headers: { cookie: b } })).status, 200);
  } finally { signedOutSessions.delete('wsess_devicea0001'); }
});

test('a dashboard link to any other origin never reaches the trip, even from the control plane', async () => {
  const cookie = await launch('evil-grant');
  const me = await (await fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`, { headers: { cookie } })).json();
  assert.equal(me.username, 'alice');
  // The foreign URL was dropped by the gateway; the organizer still gets the dashboard that
  // the trip's own configuration names, never the one the control plane sent.
  assert.equal(me.dashboard_url, dashboardUrl, 'https://evil.example/... was dropped by the gateway');
  assert.equal((await (await fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`, { headers: { cookie: await launch('owner-grant') } })).json()).dashboard_url, dashboardUrl);
});

test('demoting the owner at the control plane removes is_organizer and the dashboard link within the cache window', async () => {
  const cookie = await launch('owner-grant');
  const me = () => fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`, { headers: { cookie } });
  assert.equal((await (await me()).json()).dashboard_url, dashboardUrl);
  controlPlaneRole = 'member'; // the membership changed; the cookie was sealed with 'owner'
  try {
    const refused = await me();
    assert.equal(refused.status, 401, 'the owner-era session is refused, not served with stale organizer data');
    const relaunched = await launch('member-grant'); // what the person gets when they open the trip again
    const asMember = await (await fetch(`${gatewayOrigin}/t/${tripId}/api/auth/me`, { headers: { cookie: relaunched } })).json();
    assert.equal(asMember.is_organizer, false); assert.equal(asMember.dashboard_url, undefined);
  } finally { controlPlaneRole = 'owner'; }
});

test('removing a participant also refuses future gateway sessions and existing managed tokens', async () => {
  const response = await exchange(sessionBody({ userId: memberId, role: 'member', runtimeUsername: 'bob' }));
  const { token } = await response.json();
  assert.equal((await api('/api/agent/participants/bob', { method: 'DELETE', token: ownerToken })).status, 200);
  assert.equal((await exchange(sessionBody({ userId: memberId, role: 'member', runtimeUsername: 'bob' }))).status, 403);
  const me = await api('/api/auth/me', { token });
  assert.equal(me.status, 401); assert.deepEqual(await me.json(), { error: 'invalid_token' });
});
