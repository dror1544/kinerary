// Group sign-in's site half (docs/specs/sprint-9/x-member-sign-in.md, slice S1, rework 1): a traveller the control plane
// lets claim an EXISTING participant must be bound on the trip site, or the session exchange answers IDENTITY_MISMATCH and
// the person signs in to nothing. This runs the REAL trip site and the REAL runtime gateway (only the control plane is a
// stub, because the control plane is not under test here): adopt through the gateway, exchange, release, exchange,
// re-claim by another account, exchange. The control-plane half (order, compensation, the adapter's wire shape) is
// control-plane/api/test/member-claim-site-binding.test.ts.
import { freePort } from './helpers/port-guard.js';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

const tripId = 'trip_claimbinding01', ownerId = 'user_bindowner';
const key = 'test-dedicated-exchange-key';
const [userA, userB, userC, userInvited] = ['user_claimera0001', 'user_claimerb0001', 'user_claimerc0001', 'user_inviteduser1'];
let temp, controlPlane, gateway, gatewayOrigin, tripPort;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
// What the control plane's adapter sends, through the gateway the control plane really talks to.
const viaGateway = (action, body, apiKey = key) => fetch(`${gatewayOrigin}/internal/t/${tripId}/participants/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ tripId, ...body }),
});
// What the gateway sends the site at a launch: the session exchange.
const exchange = (userId, runtimeUsername = 'bob') => api('/api/internal/control-plane/session', { method: 'POST', apiKey: key, body: { tripId, userId, runtimeUsername, role: 'member' } });

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'claim-binding-test-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
  tripPort = await freePort();
  await startTestServer({ PORT: tripPort, CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)) });
  controlPlane = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === `/internal/runtime-routes/${tripId}`) return res.end(JSON.stringify({ routeRef: 'fixture', upstreamOrigin: `http://127.0.0.1:${tripPort}`, upstreamBasePath: '' }));
    res.writeHead(404); res.end('{}');
  });
  Object.assign(process.env, { NODE_ENV: 'test', CONTROL_PLANE_INTERNAL_ORIGIN: await listen(controlPlane), RUNTIME_SESSION_CHECK_TTL_MS: '0',
    RUNTIME_EXCHANGE_KEY: key, RUNTIME_COOKIE_SECRET: 'test-cookie-secret', PORTAL_ORIGIN: 'https://portal.example.test', RUNTIME_ORIGIN: 'http://runtime.example.test' });
  const { createRuntimeGateway } = await import('../control-plane/runtime-gateway/server.js');
  gateway = createRuntimeGateway(); gatewayOrigin = await listen(gateway);
});
after(async () => { await Promise.all([close(gateway), close(controlPlane)]); stopTestServer(); rmSync(temp, { recursive: true, force: true }); });

test('before any binding the site refuses the exchange: a claim that only wrote control-plane rows opens nothing', async () => {
  const r = await exchange(userA);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'IDENTITY_MISMATCH' });
});

test('adopt binds a NEW control-plane user to the EXISTING participant, and the exchange then gives a plain member token', async () => {
  const r = await viaGateway('adopt', { userId: userA, runtimeUsername: 'bob' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  const ex = await exchange(userA);
  assert.equal(ex.status, 200);
  const { token } = await ex.json();
  const me = await (await api('/api/auth/me', { token })).json();
  assert.equal(me.username, 'bob'); assert.equal(me.is_organizer, false);
  assert.equal((await api('/api/agent/brief', { token })).status, 403, 'a member, never an organizer');
  // never creates and never changes the participant: bob's own password still works, bob is still the one participant bob
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).status, 200);
  // idempotent for the same pair
  assert.equal((await viaGateway('adopt', { userId: userA, runtimeUsername: 'bob' })).status, 200);
  // the exchange is still pinned to the role and the name the claim named
  assert.equal((await exchange(userA, 'eve')).status, 403);
  assert.equal((await api('/api/internal/control-plane/session', { method: 'POST', apiKey: key, body: { tripId, userId: userA, runtimeUsername: 'bob', role: 'owner' } })).status, 403);
});

test('adopt refuses what it must: an organizer, a participant that does not exist, a bad shape; and only the exchange key may call it', async () => {
  const organizer = await viaGateway('adopt', { userId: 'user_wouldbeorg001', runtimeUsername: 'alice' });
  assert.equal(organizer.status, 403); assert.deepEqual(await organizer.json(), { error: 'ORGANIZER_BINDING_FORBIDDEN' });
  const missing = await viaGateway('adopt', { userId: 'user_wouldbeorg001', runtimeUsername: 'nobody' });
  assert.equal(missing.status, 404);
  assert.equal((await viaGateway('adopt', { userId: 'not-a-user', runtimeUsername: 'eve' })).status, 400);
  assert.equal((await viaGateway('adopt', { userId: userC, runtimeUsername: 'Bad Name' })).status, 400);
  // the gateway's own gate, then the site's: no key, a wrong key, and the agent key never get through; neither does a family JWT, direct
  assert.equal((await viaGateway('adopt', { userId: userC, runtimeUsername: 'eve' }, 'wrong')).status, 401);
  assert.equal((await viaGateway('release', { userId: userC, runtimeUsername: 'eve' }, 'wrong')).status, 401);
  const token = await loginAsAlice();
  for (const options of [{ token }, { apiKey: 'test-hermes-key' }, {}]) {
    const direct = await api('/api/internal/control-plane/participants/adopt', { method: 'POST', body: { tripId, userId: userC, runtimeUsername: 'eve' }, ...options });
    assert.equal(direct.status, 401, JSON.stringify(Object.keys(options)));
    const released = await api('/api/internal/control-plane/participants/release', { method: 'POST', body: { tripId, userId: userA, runtimeUsername: 'bob' }, ...options });
    assert.equal(released.status, 401);
  }
  assert.equal((await exchange(userA)).status, 200, 'none of that disturbed the binding that stood');
});

test('release retires the binding: the exchange is refused, a token already issued stops working, and another account can re-claim', async () => {
  const issued = (await (await exchange(userA)).json()).token;
  assert.equal((await api('/api/auth/me', { token: issued })).status, 200);
  // a release that names someone else, or another participant, changes nothing
  const wrong = await viaGateway('release', { userId: userB, runtimeUsername: 'bob' });
  assert.equal(wrong.status, 200); assert.deepEqual(await wrong.json(), { ok: true, released: false });
  assert.equal((await exchange(userA)).status, 200);
  const released = await viaGateway('release', { userId: userA, runtimeUsername: 'bob' });
  assert.equal(released.status, 200); assert.deepEqual(await released.json(), { ok: true, released: true });
  const refused = await exchange(userA);
  assert.equal(refused.status, 403); assert.deepEqual(await refused.json(), { error: 'IDENTITY_MISMATCH' });
  assert.equal((await api('/api/auth/me', { token: issued })).status, 401, 'the old account does not get back in with a token it already holds');
  // a different account claims the same participant: no IDENTITY_CONFLICT
  assert.equal((await viaGateway('adopt', { userId: userB, runtimeUsername: 'bob' })).status, 200);
  assert.equal((await exchange(userB)).status, 200);
  assert.equal((await exchange(userA)).status, 403);
  // releasing twice is not an error
  assert.deepEqual(await (await viaGateway('release', { userId: userA, runtimeUsername: 'bob' })).json(), { ok: true, released: false });
});

test('a binding left behind by a release that never arrived is replaced by the next adopt, so the participant is never stuck', async () => {
  // userB still holds bob (its release was "lost"); the control plane has since decided bob is free and claims him for userC
  assert.equal((await viaGateway('adopt', { userId: userC, runtimeUsername: 'bob' })).status, 200);
  assert.equal((await exchange(userC)).status, 200);
  assert.equal((await exchange(userB)).status, 403, 'the stale account is out');
});

test('an INVITE-bound identity is never displaced or released by this path', async () => {
  const enrolled = await api('/api/internal/control-plane/participants', { method: 'POST', apiKey: key, body: { tripId, userId: userInvited, runtimeUsername: 'eve', inviteId: 'invite_claimbinding1' } });
  assert.equal(enrolled.status, 200);
  const adopt = await viaGateway('adopt', { userId: userC, runtimeUsername: 'eve' });
  assert.equal(adopt.status, 409); assert.deepEqual(await adopt.json(), { error: 'IDENTITY_CONFLICT' });
  assert.deepEqual(await (await viaGateway('release', { userId: userInvited, runtimeUsername: 'eve' })).json(), { ok: true, released: false });
  assert.equal((await exchange(userInvited, 'eve')).status, 200, 'the invited member is untouched');
});
