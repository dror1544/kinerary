// What a person who came in through a PERSONAL INVITE can create on the trip site, and what removing them takes away
// (docs/specs/sprint-9/x-member-sign-in.md, slice S2c; owner's decision after the S2 boundary review, 2026-11-22).
//
//  1. A managed MEMBER session (a group claim, or an invite-bound binding) may not set a site password or link/unlink Google:
//     the person already has a portal login that removal ends, and a site password would let them (or whoever holds it) log in on
//     the trip's own hostname afterwards with a plain 30-day JWT that no removal reaches. One predicate, read from the stored
//     binding on every request, never from the token.
//  2. Removing an invited member ends the assistant (MCP) connections APPROVED UNDER THAT BINDING, and only those.
//  3. The review's own sequence, end to end against the real site.
//
// Real trip site, real routes, real OAuth endpoints. Every identity is a distinct control-plane user id.
import { freePort } from './helpers/port-guard.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { startTestServer, stopTestServer, api, testTripDir } from './helpers/server.js';

const tripId = 'trip_invitecreds001', ownerId = 'user_invcredsowner1';
const key = 'test-dedicated-exchange-key';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const P1 = 'user_invitedperson1', P2 = 'user_invitedperson2', P3 = 'user_invitedperson3', CLAIMANT = 'user_invclaimant001';
const INV1 = 'invite_invitecreds01', INV2 = 'invite_invitecreds02', INV3 = 'invite_invitecreds03';
// Each test that creates a grant uses its own invited account and invite, so a revoke assertion in one test can never be
// satisfied (or failed) by what another test left behind.
const PX = 'user_invitedpersonx1', INVX = 'invite_invitecredsx01'; // the "what stays as it was" test
const PA = 'user_invitedperson4', INVA = 'invite_invitecredsa01', INVB = 'invite_invitecredsb01'; // one account, two invites
const PE = 'user_invitedperson5', INVE = 'invite_invitecredse01'; // the atomicity test
const REFUSAL = { error: 'claimed_session_cannot_change_credentials' };
let temp, base;

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const form = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const internal = (path, body) => api(`/api/internal/control-plane/${path}`, { method: 'POST', apiKey: key, body: { tripId, ...body } });
const provision = (userId, runtimeUsername, inviteId, deadInviteIds) => internal('participants', { userId, runtimeUsername, inviteId, ...(deadInviteIds ? { deadInviteIds } : {}) });
const adopt = (userId, runtimeUsername, deadInviteIds) => internal('participants/adopt', { userId, runtimeUsername, ...(deadInviteIds ? { deadInviteIds } : {}) });
const release = (userId, runtimeUsername, inviteId) => internal('participants/release', { userId, runtimeUsername, ...(inviteId === undefined ? {} : { inviteId }) });
const exchange = async (userId, runtimeUsername, role = 'member') => (await (await internal('session', { userId, runtimeUsername, role })).json()).token;
const login = (username, password) => api('/api/auth/login', { method: 'POST', body: { username, password } });
const loginToken = async (username, password) => (await (await login(username, password)).json()).token;
const setPassword = (token, password) => api('/api/auth/password', { method: 'PUT', token, body: { password } });
const googleLink = (token) => api('/api/auth/google-link', { method: 'PUT', token, body: { idToken: 'x' } });
const googleUnlink = (token) => api('/api/auth/google-link', { method: 'DELETE', token });

// ── the assistant (MCP) connection flow, as an assistant's server would run it ─────────────────────────────────────────
const sha = (v) => createHash('sha256').update(v).digest('base64url');
async function consent(session) {
  const reg = await post('/oauth/register', { client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  const client = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const params = { client_id: client.client_id, redirect_uri: CALLBACK, response_type: 'code', code_challenge: sha(verifier), code_challenge_method: 'S256', state: 's', resource: `${base}/mcp`, decision: 'allow' };
  const r = await post('/oauth/authorize/decision', params, { origin: base, authorization: `Bearer ${session}` });
  return { status: r.status, client, verifier, async code() { return new URL((await r.json()).redirect_to).searchParams.get('code'); } };
}
const exchangeCode = (c, code) => form('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: c.verifier, client_id: c.client.client_id, redirect_uri: CALLBACK });
const refresh = (c, refreshToken) => form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: c.client.client_id });
// A finished connection: consent, then the code exchanged for tokens.
async function connect(session) {
  const c = await consent(session);
  assert.equal(c.status, 200, 'consent');
  const t = await exchangeCode(c, await c.code());
  assert.equal(t.status, 200, 'token');
  return { c, tokens: await t.json() };
}
const mcp = (accessToken) => fetch(base + '/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
const bindingColumns = () => {
  const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const sqlite = new Database(join(dirname(testTripDir()), 'trip.db'), { readonly: true });
  try { return sqlite.prepare('SELECT username, binding_user_id, binding_invite_id, revoked_at FROM mcp_oauth_grants').all(); } finally { sqlite.close(); }
};

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'invite-creds-test-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
  const port = await freePort();
  base = `http://localhost:${port}`;
  await startTestServer({ PORT: port, CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: base });
  // The site seeds its users after it starts listening; a login can arrive first and be refused.
  let last;
  for (let i = 0; i < 100; i++) {
    try { if ((await login('eve', '1234')).status === 200 && (await login('bob', '1234')).status === 200) return; } catch (error) { last = error.cause ?? error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`the site never finished seeding its users (${last ?? 'logins were refused'})`);
});
after(() => { stopTestServer(); rmSync(temp, { recursive: true, force: true }); });

// ── item 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a managed MEMBER session, invite-bound or a group claim, is refused on the password route and both Google routes; its own traveller\'s password is untouched', async () => {
  assert.equal((await provision(P1, 'eve', INV1)).status, 200);
  assert.equal((await adopt(CLAIMANT, 'bob')).status, 200);
  for (const [who, token] of [['invite-bound member', await exchange(P1, 'eve')], ['group-claim member', await exchange(CLAIMANT, 'bob')]]) {
    assert.equal((await api('/api/auth/me', { token })).status, 200, `${who} still opens the trip`);
    for (const [name, request] of [['PUT /api/auth/password', () => setPassword(token, 'invited-own-password')], ['PUT /api/auth/google-link', () => googleLink(token)], ['DELETE /api/auth/google-link', () => googleUnlink(token)]]) {
      const r = await request();
      assert.equal(r.status, 403, `${who}: ${name}`);
      assert.deepEqual(await r.json(), REFUSAL, `${who}: ${name}`);
    }
  }
  assert.equal((await login('eve', '1234')).status, 200, 'eve\'s own seeded password is untouched');
  assert.equal((await login('eve', 'invited-own-password')).status, 401);
  assert.equal((await login('bob', 'invited-own-password')).status, 401);
  assert.equal((await release(CLAIMANT, 'bob')).status, 200);
  assert.equal((await release(P1, 'eve', INV1)).status, 200);
});

test('UNCHANGED: a plain password-login session, an owner-managed session and a secondary organizer still set a password', async () => {
  // A plain login for a participant who ALSO has an invite binding (the real traveller, R, next to the invited person, P).
  assert.equal((await provision(P1, 'eve', INV1)).status, 200);
  const plain = await loginToken('eve', '1234');
  assert.equal((await setPassword(plain, 'eves-own-password')).status, 200, 'the real traveller changes their own password');
  assert.equal((await login('eve', 'eves-own-password')).status, 200);
  assert.equal((await setPassword(await loginToken('eve', 'eves-own-password'), '1234')).status, 200, 'and back, so no other test depends on this one');
  const organizer = await loginToken('alice', '1234');
  assert.equal((await setPassword(organizer, 'alices-own-password')).status, 200, 'a plain organizer');
  assert.equal((await setPassword(await exchange(ownerId, null, 'owner'), 'alices-managed-password')).status, 200, 'an owner-managed session');
  const secondary = await exchange('user_invcredssecondary', null, 'organizer');
  assert.ok(secondary);
  assert.equal((await setPassword(secondary, 'secondary-own-password')).status, 200, 'a secondary organizer');
  // and the Google routes still reach their handler for them: the link (not configured on the test site) and the unlink
  for (const [who, token] of [['plain login', plain], ['owner-managed', await exchange(ownerId, null, 'owner')], ['plain organizer', organizer], ['secondary organizer', secondary]]) {
    const g = await googleLink(token);
    assert.equal(g.status, 503, `${who}: PUT /api/auth/google-link`);
    assert.deepEqual(await g.json(), { error: 'google_not_configured' }, who);
    const u = await googleUnlink(token);
    assert.equal(u.status, 200, `${who}: DELETE /api/auth/google-link reaches its handler`);
    assert.deepEqual(await u.json(), { ok: true }, who);
  }
  assert.equal((await release(P1, 'eve', INV1)).status, 200);
});

test('what stays as it was: an invite-bound session uses the assistant and gets the full /api/auth/me; a claimed one gets neither', async () => {
  assert.equal((await provision(PX, 'eve', INVX)).status, 200);
  assert.equal((await adopt(CLAIMANT, 'bob')).status, 200);
  const invited = await exchange(PX, 'eve'), claimed = await exchange(CLAIMANT, 'bob');
  const { tokens } = await connect(invited);
  assert.equal((await mcp(tokens.access_token)).status, 200, 'an invite-bound member\'s own assistant works');
  const list = await api('/api/mcp/connection', { token: invited });
  assert.equal(list.status, 200);
  assert.ok(JSON.stringify(await list.json()).includes('Claude'), 'the invited person sees the connection they made');
  const invitedMe = await (await api('/api/auth/me', { token: invited })).json();
  for (const field of ['google_sub', 'google_email', 'google_picture', 'telegram_id', 'removed_at']) assert.equal(field in invitedMe, true, `${field}: the invite-bound view is unchanged`);
  // the claimed session: no consent, no list, no disconnect, the allow-listed me
  assert.equal((await consent(claimed)).status, 401);
  for (const r of [await api('/api/mcp/connection', { token: claimed }), await api('/api/mcp/connections/anything', { method: 'DELETE', token: claimed })]) {
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), REFUSAL);
  }
  assert.equal('google_sub' in (await (await api('/api/auth/me', { token: claimed })).json()), false);
  // the page is told, from the verified session, where this person's sign-in lives; nobody else is told anything
  const meOf = async (token) => (await api('/api/auth/me', { token })).json();
  assert.equal(invitedMe.sign_in_managed, true, 'invite-bound');
  assert.equal((await meOf(claimed)).sign_in_managed, true, 'claimed');
  for (const [who, token] of [['plain login', await loginToken('eve', '1234')], ['owner-managed', await exchange(ownerId, null, 'owner')], ['secondary organizer', await exchange('user_invcredssecondary', null, 'organizer')]]) {
    assert.equal('sign_in_managed' in await meOf(token), false, who);
  }
  // removal ends exactly the connection this test's invited member made, on this test's own evidence
  assert.equal((await release(PX, 'eve', INVX)).status, 200);
  assert.equal((await mcp(tokens.access_token)).status, 401, 'the invited member\'s connection ended with their removal');
  assert.equal((await release(CLAIMANT, 'bob')).status, 200);
});

// ── items 2 and 3: the review's own sequence ─────────────────────────────────────────────────────────────────────────

test('P (invited) redeems, cannot set a password, connects an assistant; the organizer removes P: P\'s session, grant, refresh and pending code all end; R\'s login and R\'s grant do not', async () => {
  // R, the real traveller of 'eve', has a plain login and an assistant connection approved the ordinary way, BEFORE the invite.
  const rToken = await loginToken('eve', '1234');
  const r = await connect(rToken);
  assert.equal((await mcp(r.tokens.access_token)).status, 200);

  // P redeems the personal invite (provision), and holds a managed member session.
  assert.equal((await provision(P1, 'eve', INV1)).status, 200);
  const pToken = await exchange(P1, 'eve');
  assert.equal((await api('/api/auth/me', { token: pToken })).status, 200);
  // ...tries to set a password: refused, and no site login for P exists afterwards.
  const attempt = await setPassword(pToken, 'p-wants-a-direct-login');
  console.log(`PUT /api/auth/password (invite-bound P) -> ${attempt.status} ${JSON.stringify(await attempt.clone().json())}`);
  assert.equal(attempt.status, 403);
  assert.equal((await login('eve', 'p-wants-a-direct-login')).status, 401);
  // ...approves an assistant grant: works.
  const p = await connect(pToken);
  assert.equal((await mcp(p.tokens.access_token)).status, 200, 'P\'s assistant works while P is a member');
  // A second consent that P has approved but whose code the assistant has not yet exchanged (pending).
  const pending = await consent(pToken);
  assert.equal(pending.status, 200);
  const pendingCode = await pending.code();

  // What each grant remembers about who approved it (site-local columns on mcp_oauth_grants): P's carries the binding, R's carries nothing.
  const rows = bindingColumns();
  assert.equal(rows.filter(g => g.binding_user_id === P1 && g.binding_invite_id === INV1 && g.revoked_at === null).length, 1, 'exactly P\'s live grant names the binding');
  assert.equal(rows.filter(g => g.binding_user_id === null && g.binding_invite_id === null).length, rows.filter(g => g.binding_user_id === null).length, 'a grant names both columns or neither');
  assert.ok(rows.some(g => g.username === 'eve' && g.binding_user_id === null && g.revoked_at === null), 'R\'s grant (a password login) names no binding');

  // The organizer removes P: the control plane's release, naming the invite.
  const gone = await release(P1, 'eve', INV1);
  const goneBody = await gone.json();
  console.log(`POST participants/release (account + name + invite) -> ${gone.status} ${JSON.stringify(goneBody)}`);
  assert.equal(gone.status, 200);
  assert.equal(goneBody.released, true);

  const me = await api('/api/auth/me', { token: pToken });
  console.log(`GET /api/auth/me (P's managed token, after removal) -> ${me.status}`);
  assert.equal(me.status, 401, 'P\'s managed session is out');
  assert.equal((await setPassword(pToken, 'too-late')).status, 401);
  const mcpAfter = await mcp(p.tokens.access_token);
  console.log(`POST /mcp (P's access token, after removal) -> ${mcpAfter.status}`);
  assert.equal(mcpAfter.status, 401, 'P\'s access token is dead');
  const refreshed = await refresh(p.c, p.tokens.refresh_token);
  console.log(`POST /oauth/token refresh (P's refresh token, after removal) -> ${refreshed.status} ${await refreshed.clone().text()}`);
  assert.equal(refreshed.status, 400, 'P\'s refresh token is refused');
  assert.equal((await exchangeCode(pending, pendingCode)).status, 400, 'a code P approved and nobody exchanged cannot be exchanged now');
  assert.equal(bindingColumns().filter(g => g.binding_user_id === P1 && g.revoked_at === null).length, 0, 'no live grant names the removed binding');

  // R is untouched.
  assert.equal((await login('eve', '1234')).status, 200, 'R still logs in with their own password');
  const rMcp = await mcp(r.tokens.access_token);
  console.log(`POST /mcp (R's access token, after P's removal) -> ${rMcp.status}`);
  assert.equal(rMcp.status, 200, 'R\'s assistant still works');
  assert.equal((await refresh(r.c, r.tokens.refresh_token)).status, 200, 'and R\'s refresh still works');
});

test('only the grants approved under THAT binding end: a later binding of another account for the same name, a release that names the wrong invite or account, and an idempotent repeat leave them alone', async () => {
  assert.equal((await provision(P2, 'eve', INV2)).status, 200);
  const p2 = await connect(await exchange(P2, 'eve'));
  assert.equal((await mcp(p2.tokens.access_token)).status, 200);
  // the earlier binding's removal arrives again, and a release naming the wrong invite or the wrong account: nothing here is theirs
  assert.equal((await (await release(P1, 'eve', INV1)).json()).released, false);
  assert.equal((await (await release(P2, 'eve', INV1)).json()).released, false, 'right account, another invite');
  assert.equal((await (await release(P3, 'eve', INV2)).json()).released, false, 'another account, right invite');
  assert.equal((await mcp(p2.tokens.access_token)).status, 200, 'P2\'s grant is still live');
  // a claim's release (no invite id) never ends an invite binding, and so ends none of its grants
  assert.equal((await (await release(P2, 'eve')).json()).released, false);
  assert.equal((await mcp(p2.tokens.access_token)).status, 200);
  // and its own removal does
  assert.equal((await (await release(P2, 'eve', INV2)).json()).released, true);
  assert.equal((await mcp(p2.tokens.access_token)).status, 401);
});

test('a lost release: the next provision that REPLACES the dead invite\'s binding (the dead-invite path) ends the replaced binding\'s grants in the same step', async () => {
  assert.equal((await provision(P1, 'bob', INV1)).status, 200);
  const old = await connect(await exchange(P1, 'bob'));
  assert.equal((await mcp(old.tokens.access_token)).status, 200);
  // the removal's release never reached the site; the invite is later named dead and the next person is bound
  assert.equal((await provision(P3, 'bob', INV3)).status, 409, 'not replaced without the control plane naming the invite dead');
  assert.equal((await mcp(old.tokens.access_token)).status, 200, 'a refused replacement ends nothing');
  assert.equal((await provision(P3, 'bob', INV3, [INV1])).status, 200, 'replaced when named dead');
  assert.equal((await mcp(old.tokens.access_token)).status, 401, 'the old binding\'s grant went with it');
  assert.equal((await refresh(old.c, old.tokens.refresh_token)).status, 400);
  // the new person starts with nothing inherited, and their own grant is theirs
  const fresh = await connect(await exchange(P3, 'bob'));
  assert.equal((await mcp(fresh.tokens.access_token)).status, 200);
  // adopt replacing a dead invite binding does the same
  assert.equal((await adopt(CLAIMANT, 'bob', [INV3])).status, 200);
  assert.equal((await mcp(fresh.tokens.access_token)).status, 401, 'adopt\'s replacement of a dead invite binding also ends its grants');
  assert.equal((await release(CLAIMANT, 'bob')).status, 200);
});

test('a group claim approves no grant, so its release needs nothing: the real traveller\'s grants survive it', async () => {
  const bobToken = await loginToken('bob', '1234');
  const b = await connect(bobToken);
  assert.equal((await adopt(CLAIMANT, 'bob')).status, 200);
  assert.equal((await consent(await exchange(CLAIMANT, 'bob'))).status, 401, 'a claimed session cannot approve a connection');
  assert.equal((await release(CLAIMANT, 'bob')).status, 200);
  assert.equal((await mcp(b.tokens.access_token)).status, 200, 'the traveller\'s own connection survived the claim');
});

// ── the same ACCOUNT under two invites ───────────────────────────────────────────────────────────────────────────────

test('one account bound first under invite A and then under invite B: a release naming A touches nothing of B\'s; naming B ends B\'s grant only', async () => {
  assert.equal((await provision(PA, 'bob', INVA)).status, 200);
  const ga = await connect(await exchange(PA, 'bob'));
  assert.equal((await mcp(ga.tokens.access_token)).status, 200);
  assert.equal((await (await release(PA, 'bob', INVA)).json()).released, true);
  assert.equal((await mcp(ga.tokens.access_token)).status, 401, 'A\'s release ended A\'s grant');
  assert.equal((await provision(PA, 'bob', INVB)).status, 200, 'the same account, a new invite');
  const gb = await connect(await exchange(PA, 'bob'));
  assert.equal((await mcp(gb.tokens.access_token)).status, 200);
  assert.equal((await (await release(PA, 'bob', INVA)).json()).released, false, 'A names a binding that is gone');
  assert.equal((await mcp(gb.tokens.access_token)).status, 200, 'B\'s grant is untouched by a release naming A');
  assert.equal((await (await release(PA, 'bob', INVB)).json()).released, true);
  assert.equal((await mcp(gb.tokens.access_token)).status, 401, 'B\'s own release ends B\'s grant');
});

// The states above are the only ones the routes can reach (an account holds one binding at a time), so on their own they cannot tell
// "user id AND invite id" from "user id alone". This pins the match directly, on a store holding every near-miss at once.
test('revokeBindingGrants matches the user id AND the invite id: the same account under another invite, another account under the same invite, and a grant with no binding all survive', () => {
  const require = createRequire(import.meta.url);
  const Database = require('../server/node_modules/better-sqlite3');
  const { createOAuthStore, revokeBindingGrants } = require('../server/trip-mcp/oauth.js');
  const db = new Database(':memory:');
  const store = createOAuthStore(db);
  const grant = (binding) => store.startGrant({ clientId: 'c', username: 'bob', scope: 'trip:read', binding });
  const target = grant({ userId: PA, inviteId: INVA });
  const sameAccountOtherInvite = grant({ userId: PA, inviteId: INVB });
  const otherAccountSameInvite = grant({ userId: P2, inviteId: INVA });
  const unbound = grant(null);
  const live = (g) => Boolean(store.verifyAccess(g.tokens.access_token));
  assert.equal(revokeBindingGrants(db, { userId: PA, inviteId: INVA }), 1);
  assert.equal(live(target), false);
  assert.equal(live(sameAccountOtherInvite), true, 'same account, another invite');
  assert.equal(live(otherAccountSameInvite), true, 'another account, same invite');
  assert.equal(live(unbound), true, 'no recorded binding');
  for (const bad of [{ userId: PA }, { inviteId: INVB }, { userId: '', inviteId: '' }, {}]) assert.equal(revokeBindingGrants(db, bad), 0, JSON.stringify(bad));
  assert.equal(live(sameAccountOtherInvite) && live(otherAccountSameInvite) && live(unbound), true, 'a malformed call revokes nothing');
  db.close();
});

// ── atomicity ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a revoke that fails leaves the binding AND the grant in place and the release answers an error; the retry then ends both', async () => {
  const require = createRequire(import.meta.url);
  const Database = require('../server/node_modules/better-sqlite3');
  assert.equal((await provision(PE, 'eve', INVE)).status, 200);
  const e = await connect(await exchange(PE, 'eve'));
  assert.equal((await mcp(e.tokens.access_token)).status, 200);
  const sqlite = new Database(join(dirname(testTripDir()), 'trip.db'));
  try {
    // The grant row is updated first and the tokens second: failing the second proves the first rolled back with the binding's removal.
    sqlite.exec("CREATE TRIGGER fail_token_revoke BEFORE UPDATE ON mcp_oauth_tokens BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    const failed = await release(PE, 'eve', INVE);
    const failedBody = await failed.json();
    console.log(`POST participants/release (revoke forced to fail) -> ${failed.status} ${JSON.stringify(failedBody)}`);
    assert.equal(failed.status, 500, 'the release says it failed, so the control plane can retry');
    assert.notEqual(failedBody.released, true);
    assert.equal((await api('/api/auth/me', { token: await exchange(PE, 'eve') })).status, 200, 'the binding survived');
    assert.equal((await mcp(e.tokens.access_token)).status, 200, 'the grant survived');
    assert.equal(bindingColumns().filter(g => g.binding_user_id === PE && g.revoked_at === null).length, 1, 'and its row is not half-revoked');
  } finally { sqlite.exec('DROP TRIGGER IF EXISTS fail_token_revoke'); sqlite.close(); }
  const retried = await release(PE, 'eve', INVE);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).released, true, 'the retry ends the binding');
  assert.equal((await mcp(e.tokens.access_token)).status, 401, 'and its grant');
});

// ── an upgrade revokes nothing ───────────────────────────────────────────────────────────────────────────────────────────

test('a site that ran the OLD schema (no binding columns) gets them added at boot, and its existing grant survives a release and both replacement paths', async () => {
  const require = createRequire(import.meta.url);
  const Database = require('../server/node_modules/better-sqlite3');
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'invite-creds-upgrade-'));
  const dataDir = join(dir, 'data'), tripDir = join(dataDir, 'trip'), siteDir = join(dataDir, 'site');
  mkdirSync(join(siteDir, 'confirmations'), { recursive: true });
  cpSync(join(here, 'fixtures'), tripDir, { recursive: true });
  const manifest = join(dir, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
  const boot = async () => {
    const port = await freePort();
    const child = spawn('node', [join(here, '..', 'server', 'server.js')], {
      cwd: join(here, '..', 'server'),
      env: { ...process.env, TRIP_DIR: tripDir, DATA_DIR: dataDir, SITE_DIR: siteDir, AVATARS_DIR: join(dataDir, 'avatars'), PORT: String(port), JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: 'test-hermes-key', SEED_PASSWORD: '1234', CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: `http://localhost:${port}` },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the site did not start within 15s')), 15_000);
      child.stdout.on('data', chunk => { if (chunk.toString().includes('Trip server running on')) { clearTimeout(timer); resolve(); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`the site exited (${code}) before it was ready`)); });
    });
    return { child, url: `http://localhost:${port}` };
  };
  const stop = (site) => new Promise(resolve => { site.child.removeAllListeners('exit'); site.child.once('exit', resolve); site.child.kill('SIGTERM'); });
  let site;
  try {
    // First boot (the current code) creates every table; then the two OAuth tables are put back the way an earlier release left them.
    site = await boot();
    await stop(site);
    const dbPath = join(dataDir, 'trip.db');
    const sqlite = new Database(dbPath);
    const ACCESS = 'old-access-token-0000000000000000000000000000', REFRESH = 'old-refresh-token-000000000000000000000000000';
    const sha256 = v => createHash('sha256').update(v).digest('hex');
    try {
      for (const table of ['mcp_oauth_codes', 'mcp_oauth_grants']) for (const column of ['binding_user_id', 'binding_invite_id']) sqlite.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      assert.equal(sqlite.prepare('PRAGMA table_info(mcp_oauth_grants)').all().some(c => c.name.startsWith('binding_')), false, 'the fixture really is the old schema');
      const t = Math.floor(Date.now() / 1000);
      sqlite.prepare("INSERT INTO mcp_oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at) VALUES ('mcp_old', NULL, 'Claude', ?, 'none', ?)").run(JSON.stringify([CALLBACK]), t);
      sqlite.prepare("INSERT INTO mcp_oauth_grants (id, client_id, username, created_at, scope) VALUES ('grant_old', 'mcp_old', 'eve', ?, 'trip:read')").run(t);
      sqlite.prepare("INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, 'grant_old', 'access', ?)").run(sha256(ACCESS), t + 3600);
      sqlite.prepare("INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, 'grant_old', 'refresh', ?)").run(sha256(REFRESH), t + 86400);
    } finally { sqlite.close(); }

    site = await boot();
    const call = (path, body) => fetch(`${site.url}/api/internal/control-plane/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ tripId, ...body }) });
    const alive = async () => (await fetch(`${site.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ACCESS}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).status;
    // "running" is logged before the site finishes loading its users; a request that lands first can be refused for a reason that
    // has nothing to do with the grant (and an MCP call from a name the site does not yet know ends that connection).
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${site.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'eve', password: '1234' }) }).catch(() => null);
      if (r?.status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const reopened = new Database(dbPath, { readonly: true });
    try { assert.ok(reopened.prepare('PRAGMA table_info(mcp_oauth_grants)').all().some(c => c.name === 'binding_user_id'), 'the boot added the columns'); } finally { reopened.close(); }
    assert.equal(await alive(), 200, 'the old grant works after the upgrade');
    // a release naming an invite
    assert.equal((await call('participants', { userId: P1, runtimeUsername: 'eve', inviteId: INV1 })).status, 200);
    assert.equal((await (await call('participants/release', { userId: P1, runtimeUsername: 'eve', inviteId: INV1 })).json()).released, true);
    assert.equal(await alive(), 200, 'survives a release');
    // replacement by provision (the dead-invite path): another account's binding on the name is replaced
    assert.equal((await call('participants', { userId: P1, runtimeUsername: 'eve', inviteId: INV1 })).status, 200);
    assert.equal((await call('participants', { userId: P2, runtimeUsername: 'eve', inviteId: INV2, deadInviteIds: [INV1] })).status, 200);
    assert.equal(await alive(), 200, 'survives a provision that replaces a dead invite\'s binding');
    // replacement by adopt
    assert.equal((await call('participants/adopt', { userId: CLAIMANT, runtimeUsername: 'eve', deadInviteIds: [INV2] })).status, 200);
    assert.equal(await alive(), 200, 'survives an adopt that replaces a dead invite\'s binding');
    const refreshed = await fetch(`${site.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH, client_id: 'mcp_old' }) });
    assert.equal(refreshed.status, 200, 'and its refresh token still works');
  } finally {
    if (site?.child && site.child.exitCode === null) site.child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});
