// The organizer's way back to the dashboard rides the signed managed session.
// control-plane-session.test.js covers the owner end to end through the real
// server and gateway; an organizer who is not the owner cannot be minted through
// any public route yet, so this file drives the identity module itself with a
// real express app, a real SQLite database and a real signed token — only the
// organizer binding row is written directly.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const requireFromServer = createRequire(new URL('../server/server.js', import.meta.url));
const express = requireFromServer('express');
const Database = requireFromServer('better-sqlite3');
const jwt = requireFromServer('jsonwebtoken');

const tripId = 'trip_dashboardurl1', KEY = 'dashboard-url-exchange-key', SECRET = 'dashboard-url-jwt-secret';
const DASHBOARD = `https://portal.example.test/trips/${tripId}/setup`;
const ids = { owner: 'user_dashowner01', organizer: 'user_dashorganizer', member: 'user_dashmember01' };
let temp, server, origin, auth, config, previousEnv;

before(async () => {
  previousEnv = { key: process.env.CONTROL_PLANE_EXCHANGE_KEY, file: process.env.CONTROL_PLANE_IDENTITY_FILE };
  temp = mkdtempSync(join(tmpdir(), 'dashboard-url-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ids.owner, username: 'alice' } }));
  process.env.CONTROL_PLANE_EXCHANGE_KEY = KEY;
  process.env.CONTROL_PLANE_IDENTITY_FILE = manifest;
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (username TEXT PRIMARY KEY)');
  for (const name of ['alice', 'carol', 'bob']) db.prepare('INSERT INTO users(username) VALUES (?)').run(name);
  config = { agent: { organizers: ['alice', 'carol'] }, participants: [{ username: 'alice' }, { username: 'carol' }, { username: 'bob' }] };
  const { createControlPlaneAuth } = requireFromServer('./control-plane-auth.js');
  const app = express(); app.use(express.json());
  auth = createControlPlaneAuth({ app, db, tripDir: temp, config: () => config, ready: Promise.resolve(), jwtSecret: SECRET });
  db.prepare("INSERT INTO control_plane_identities(user_id, trip_id, username, role, invite_id) VALUES (?, ?, 'carol', 'organizer', NULL)").run(ids.organizer, tripId);
  db.prepare("INSERT INTO control_plane_identities(user_id, trip_id, username, role, invite_id) VALUES (?, ?, 'bob', 'member', 'invite_dashurl01')").run(ids.member, tripId);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections(); server.close();
  for (const [name, value] of [['CONTROL_PLANE_EXCHANGE_KEY', previousEnv.key], ['CONTROL_PLANE_IDENTITY_FILE', previousEnv.file]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(temp, { recursive: true, force: true });
});

async function mint(userId, role, extra = {}) {
  const r = await fetch(`${origin}/api/internal/control-plane/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ tripId, userId, role, runtimeUsername: null, ...extra }),
  });
  assert.equal(r.status, 200);
  return jwt.verify((await r.json()).token, SECRET);
}
// What authRequired does on every request, then what /api/auth/me does with the claim.
const dashboardFor = payload => auth.validManagedPayload(payload) ? auth.dashboardUrlFor(payload.controlPlane, payload.username) : 'SESSION_REFUSED';

test('an organizer who is not the owner carries the dashboard URL', async () => {
  const payload = await mint(ids.organizer, 'organizer', { dashboardUrl: DASHBOARD, runtimeUsername: 'carol' });
  assert.equal(payload.controlPlane.dashboardUrl, DASHBOARD);
  assert.equal(dashboardFor(payload), DASHBOARD);
});

test('a member never carries it, even if the exchange is handed one', async () => {
  const payload = await mint(ids.member, 'member', { dashboardUrl: DASHBOARD, runtimeUsername: 'bob' });
  assert.equal(payload.controlPlane.dashboardUrl, undefined);
  assert.equal(dashboardFor(payload), null);
  // A forged claim on a member's own token is refused at read time too.
  assert.equal(auth.dashboardUrlFor({ userId: ids.member, tripId, role: 'member', dashboardUrl: DASHBOARD }, 'bob'), null);
});

test('a demoted organizer loses the session, and with it the link', async () => {
  const payload = await mint(ids.organizer, 'organizer', { dashboardUrl: DASHBOARD });
  assert.equal(dashboardFor(payload), DASHBOARD);
  config.agent.organizers = ['alice'];
  try {
    assert.equal(dashboardFor(payload), 'SESSION_REFUSED');
    // Even a caller that skipped validManagedPayload would get nothing: the local role is checked again.
    assert.equal(auth.dashboardUrlFor(payload.controlPlane, payload.username), null);
  } finally { config.agent.organizers = ['alice', 'carol']; }
});

test('direct logins and the agent key have no claim and so no link', () => {
  assert.equal(auth.dashboardUrlFor(undefined, 'alice'), null);
  assert.equal(auth.dashboardUrlFor(null, 'alice'), null);
  assert.equal(auth.validManagedPayload({ username: 'alice' }), true);
});

test('a hostile href is rejected at mint and again at read', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<b>x', 'vbscript:x', 'file:///etc/passwd', 'ftp://portal.example.test/', 'https://u:p@portal.example.test/']) {
    assert.equal((await mint(ids.owner, 'owner', { dashboardUrl: url })).controlPlane.dashboardUrl, undefined, url);
    assert.equal(auth.dashboardUrlFor({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: url }, 'alice'), null, url);
  }
  const loopback = `http://127.0.0.1:5173/trips/${tripId}/setup`;
  assert.equal(auth.dashboardUrlFor({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: loopback }, 'alice'), loopback);
  assert.equal(auth.dashboardUrlFor({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: `http://portal.example.test/trips/${tripId}/setup` }, 'alice'), null);
  // Pinned to this trip: another trip's setup page, a query or a fragment is not the way back.
  for (const other of ['https://portal.example.test/trips/trip_somebodyelse/setup', `${DASHBOARD}?x=1`, `${DASHBOARD}#x`, `https://portal.example.test/trips/${tripId}/app`]) {
    assert.equal((await mint(ids.owner, 'owner', { dashboardUrl: other })).controlPlane.dashboardUrl, undefined, other);
    assert.equal(auth.dashboardUrlFor({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: other }, 'alice'), null, other);
  }
});

test('an owner or organizer minted without the link is logged, with the reason and never the value; a member is not', async () => {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    await mint(ids.owner, 'owner');                                                    // gateway sent nothing
    await mint(ids.organizer, 'organizer', { dashboardUrl: 'https://evil.example/x' }); // sent, refused
    await mint(ids.owner, 'owner', { dashboardUrl: DASHBOARD });                       // fine: silent
    await mint(ids.member, 'member', { runtimeUsername: 'bob' });                      // members never have one: silent
  } finally { console.warn = original; }
  assert.deepEqual(lines, [
    'control_plane.session_without_dashboard_url: role=owner reason=not_sent',
    'control_plane.session_without_dashboard_url: role=organizer reason=rejected',
  ]);
  assert.ok(!lines.join('').includes('evil.example'));
});

// ── An organizer who did not come through the gateway ───────────────────────
// A direct login on the trip's own hostname (or the installed app) has no managed
// claim. The address then comes from configuration alone: the identity sidecar's
// portalOrigin (written by the worker from the control plane's web.public_origin)
// plus THIS trip's id. Built per case: createControlPlaneAuth reads the sidecar once.
function authWith(portalOrigin, warnings = []) {
  const file = join(temp, `identity-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, tripId, owner: { userId: ids.owner, username: 'alice' }, ...(portalOrigin === undefined ? {} : { portalOrigin }) }));
  const previous = process.env.CONTROL_PLANE_IDENTITY_FILE;
  process.env.CONTROL_PLANE_IDENTITY_FILE = file;
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (username TEXT PRIMARY KEY)');
  for (const name of ['alice', 'carol', 'bob']) db.prepare('INSERT INTO users(username) VALUES (?)').run(name);
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { createControlPlaneAuth } = requireFromServer('./control-plane-auth.js');
    return createControlPlaneAuth({ app: express(), db, tripDir: temp, config: () => config, ready: Promise.resolve(), jwtSecret: SECRET });
  } finally { console.warn = original; process.env.CONTROL_PLANE_IDENTITY_FILE = previous; }
}

test('a direct-login organizer gets the configured dashboard address of THIS trip; members, demoted organizers and strangers do not', () => {
  const direct = authWith('https://portal.example.test');
  assert.equal(direct.dashboardUrlForOrganizer(null, 'alice'), DASHBOARD);
  assert.equal(direct.dashboardUrlForOrganizer(undefined, 'carol'), DASHBOARD, 'any organizer, not only the owner');
  assert.equal(direct.dashboardUrlForOrganizer(null, 'bob'), null, 'a member');
  assert.equal(direct.dashboardUrlForOrganizer(null, 'hermes'), null, 'not a participant (the agent key)');
  assert.equal(direct.dashboardUrlForOrganizer(null, 'mallory'), null, 'not a user at all');
  config.agent.organizers = ['alice'];
  try { assert.equal(direct.dashboardUrlForOrganizer(null, 'carol'), null, 'a demoted organizer'); }
  finally { config.agent.organizers = ['alice', 'carol']; }
  // A trailing slash and a loopback http origin (development) are plain origins too.
  assert.equal(authWith('https://portal.example.test/').dashboardUrlForOrganizer(null, 'alice'), DASHBOARD);
  assert.equal(authWith('http://localhost:5173').dashboardUrlForOrganizer(null, 'alice'), `http://localhost:5173/trips/${tripId}/setup`);
});

test('no portalOrigin configured means no direct-login link, and says nothing is wrong', () => {
  const warnings = [];
  assert.equal(authWith(undefined, warnings).dashboardUrlForOrganizer(null, 'alice'), null);
  assert.equal(authWith(null, warnings).dashboardUrlForOrganizer(null, 'alice'), null);
  assert.deepEqual(warnings, [], 'an unconfigured portal origin is the older-trip state, not an error');
});

test('a bad configured portalOrigin yields no link, and is logged once at start', () => {
  for (const bad of ['javascript:alert(1)', 'http://portal.example.test', 'https://u:p@portal.example.test', 'https://portal.example.test/path',
    'https://portal.example.test/?x=1', 'https://portal.example.test/#x', 'https://portal.example.test/trips/trip_other/setup', 'portal.example.test',
    '', 42, { origin: 'https://portal.example.test' }, ['https://portal.example.test'], 'https://portal.example.test\n@evil.example', `https://${'a'.repeat(2100)}.test`]) {
    const warnings = [];
    const auth = authWith(bad, warnings);
    assert.equal(auth.dashboardUrlForOrganizer(null, 'alice'), null, JSON.stringify(bad).slice(0, 50));
    assert.equal(warnings.length, 1, `logged: ${JSON.stringify(bad).slice(0, 50)}`);
    assert.match(warnings[0], /^control_plane\.portal_origin_invalid:/);
    assert.ok(!warnings[0].includes('evil.example'), 'never echoes the value');
  }
});

test('a managed claim and the configured address agree; where they differ the configured one wins, and a member gets none', () => {
  const auth = authWith('https://portal.example.test');
  assert.equal(auth.dashboardUrlForOrganizer({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: DASHBOARD }, 'alice'), DASHBOARD);
  // A claim naming another origin (a gateway pinned to a different portal, or a hostile one) never overrides configuration.
  assert.equal(auth.dashboardUrlForOrganizer({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: `https://evil.example/trips/${tripId}/setup` }, 'alice'), DASHBOARD);
  assert.equal(auth.dashboardUrlForOrganizer({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: `http://127.0.0.1:5173/trips/${tripId}/setup` }, 'alice'), DASHBOARD);
  assert.equal(auth.dashboardUrlForOrganizer({ userId: ids.member, tripId, role: 'member', dashboardUrl: DASHBOARD }, 'bob'), null);
  // With nothing configured the managed path is exactly what it was.
  const unconfigured = authWith(undefined);
  const pinned = `http://127.0.0.1:5173/trips/${tripId}/setup`;
  assert.equal(unconfigured.dashboardUrlForOrganizer({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: pinned }, 'alice'), pinned);
  assert.equal(unconfigured.dashboardUrlForOrganizer({ userId: ids.owner, tripId, role: 'owner', dashboardUrl: 'javascript:1' }, 'alice'), null);
});
