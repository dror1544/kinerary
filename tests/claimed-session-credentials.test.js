// A session that came from a GROUP CLAIM (docs/specs/sprint-9/x-member-sign-in.md, slice S1) opens the trip as the
// traveller and can mint no credential that outlives the binding. Real trip site, real routes. Everything that is not a
// claim behaves exactly as before, and that is proved here too.
import { freePort } from './helpers/port-guard.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, stopTestServer, api } from './helpers/server.js';

const tripId = 'trip_claimcreds0001', ownerId = 'user_credsowner01';
const key = 'test-dedicated-exchange-key';
const [claimant, invited] = ['user_credsclaimer1', 'user_credsinvited1'];
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
let temp, base;
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const internal = (path, body) => api(`/api/internal/control-plane/${path}`, { method: 'POST', apiKey: key, body: { tripId, ...body } });
const exchange = async (userId, runtimeUsername, role = 'member') => (await (await internal('session', { userId, runtimeUsername, role })).json()).token;
const setPassword = (token, password) => api('/api/auth/password', { method: 'PUT', token, body: { password } });
const login = (username, password) => api('/api/auth/login', { method: 'POST', body: { username, password } });

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'claimed-creds-test-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
  const port = await freePort();
  base = `http://localhost:${port}`;
  await startTestServer({ PORT: port, CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: base });
});
// The site seeds its users after it starts listening; under a loaded machine a login can arrive first and be refused.
before(async () => {
  let last;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await login('eve', '1234')).status === 200 && (await login('bob', '1234')).status === 200) return;
    } catch (error) { last = error.cause ?? error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`the site never finished seeding its users (${last ?? 'logins were refused'})`);
});
after(() => { stopTestServer(); rmSync(temp, { recursive: true, force: true }); });

test('every session that is not a claim keeps changing its own password exactly as before', async () => {
  // a plain password login (a real traveller, or an organizer)
  const plainLogin = await login('eve', '1234');
  assert.equal(plainLogin.status, 200, await plainLogin.clone().text());
  const plain = (await plainLogin.json()).token;
  assert.equal((await setPassword(plain, 'eves-new-password')).status, 200);
  assert.equal((await login('eve', 'eves-new-password')).status, 200);
  const organizer = (await (await login('alice', '1234')).json()).token;
  assert.equal((await setPassword(organizer, 'alices-new-password')).status, 200);
  // an owner's managed session
  assert.equal((await setPassword(await exchange(ownerId, null, 'owner'), 'alices-third-password')).status, 200);
  // an INVITE-bound managed member (the existing invite path binds with an invite id)
  assert.equal((await internal('participants', { userId: invited, runtimeUsername: 'eve', inviteId: 'invite_claimcreds01' })).status, 200);
  const inv = await exchange(invited, 'eve');
  assert.ok(inv);
  assert.equal((await setPassword(inv, 'eves-invited-password')).status, 200, 'an invite-bound managed member is a member like any other');
  assert.equal((await login('eve', 'eves-invited-password')).status, 200);
});

test('a session that came from a GROUP CLAIM cannot set a password, link or unlink Google, or approve an MCP connection', async () => {
  assert.equal((await internal('participants/adopt', { userId: claimant, runtimeUsername: 'bob' })).status, 200);
  const token = await exchange(claimant, 'bob');
  assert.equal((await api('/api/auth/me', { token })).status, 200, 'it still opens the trip as bob');
  for (const [name, request] of [
    ['PUT /api/auth/password', () => setPassword(token, 'claimants-own-password')],
    ['PUT /api/auth/google-link', () => api('/api/auth/google-link', { method: 'PUT', token, body: { idToken: 'x' } })],
    ['DELETE /api/auth/google-link', () => api('/api/auth/google-link', { method: 'DELETE', token })],
  ]) {
    const r = await request();
    assert.equal(r.status, 403, name);
    assert.deepEqual(await r.json(), { error: 'claimed_session_cannot_change_credentials' }, name);
  }
  // the traveller's own password is untouched: bob's seeded password still works, the claimant's never did
  assert.equal((await login('bob', '1234')).status, 200);
  assert.equal((await login('bob', 'claimants-own-password')).status, 401);
  // an MCP connection is a long-lived grant: the consent step does not accept this session
  const reg = await post('/oauth/register', { client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  const params = { client_id: client.client_id, redirect_uri: CALLBACK, response_type: 'code', code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'), code_challenge_method: 'S256', state: 's', resource: `${base}/mcp`, decision: 'allow' };
  const claimed = await post('/oauth/authorize/decision', params, { origin: base, authorization: `Bearer ${token}` });
  assert.equal(claimed.status, 401);
  // the same consent for a plain member still works (as before)
  const eve = (await (await login('eve', 'eves-invited-password')).json()).token;
  const plain = await post('/oauth/authorize/decision', params, { origin: base, authorization: `Bearer ${eve}` });
  assert.equal(plain.status, 200);
  assert.match((await plain.json()).redirect_to, /code=/);
});

test('after the claim is released the real traveller still logs in with their own password, and the claimant is out entirely', async () => {
  const token = await exchange(claimant, 'bob');
  assert.equal((await internal('participants/release', { userId: claimant, runtimeUsername: 'bob' })).status, 200);
  assert.equal((await api('/api/auth/me', { token })).status, 401);
  assert.equal((await setPassword(token, 'too-late')).status, 401);
  assert.equal((await login('bob', '1234')).status, 200, 'bob\'s own password works after the release');
  assert.equal((await login('bob', 'claimants-own-password')).status, 401);
  assert.equal((await login('bob', 'too-late')).status, 401);
});
