// The REAL trip site (adopt/release routes of server/control-plane-auth.js) held to the one shared case table
// tests/fixtures/site-binding-cases.json. control-plane/api/test/site-binding-cases.test.ts runs the SAME file against the
// control-plane tests' fake site, so the fake cannot drift from the site without one of the two runs failing.
import { freePort } from './helpers/port-guard.js';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, stopTestServer, api } from './helpers/server.js';

const table = JSON.parse(readFileSync(new URL('./fixtures/site-binding-cases.json', import.meta.url), 'utf8'));
const tripId = 'trip_bindingcases1', ownerId = 'user_casesowner001';
const key = 'test-dedicated-exchange-key';
const [ACTOR, PREVIOUS, OTHER, INVITED] = ['user_actor000001', 'user_previous0001', 'user_unused0000001', 'user_invited00001'];
// The previous holder: an invite binds a user of its own, which no later case may reuse (an account stands for one participant).
const previousOf = (participant) => (participant === 'member2' ? INVITED : PREVIOUS);
const USERNAME = { member: 'bob', member2: 'eve', organizer: 'alice', unknown: 'nobody' };
let temp;
const call = (action, userId, runtimeUsername) => api(`/api/internal/control-plane/participants/${action}`, { method: 'POST', apiKey: key, body: { tripId, userId, runtimeUsername } });
const canOpen = async (userId, runtimeUsername) => (await api('/api/internal/control-plane/session', { method: 'POST', apiKey: key, body: { tripId, userId, runtimeUsername, role: 'member' } })).status === 200;
const holderOf = async (participant) => {
  const name = USERNAME[participant];
  if (await canOpen(ACTOR, name)) return 'actor';
  if (await canOpen(previousOf(participant), name)) return 'previous';
  return 'nobody';
};
async function arrange(existing, participant) {
  const name = USERNAME[participant];
  if (existing === 'actor') await call('adopt', ACTOR, name);
  if (existing === 'other_user') await call('adopt', PREVIOUS, name);
  if (existing === 'invite') assert.equal((await api('/api/internal/control-plane/participants', { method: 'POST', apiKey: key, body: { tripId, userId: INVITED, runtimeUsername: name, inviteId: 'invite_bindingcases01' } })).status, 200);
  if (existing === 'actor_on_other_participant') assert.equal((await call('adopt', ACTOR, 'eve')).status, 200);
}
// Between cases the actor and the previous account are released everywhere they could be bound (invites are never released: that is the point).
async function reset() { for (const user of [ACTOR, PREVIOUS, OTHER]) for (const name of ['bob', 'eve']) await call('release', user, name); }

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'binding-cases-test-'));
  const manifest = join(temp, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: 'alice' }, portalOrigin: 'https://portal.example.test' }));
  const port = await freePort();
  await startTestServer({ PORT: port, CONTROL_PLANE_EXCHANGE_KEY: key, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: fileURLToPath(new URL('../site', import.meta.url)) });
});
after(() => { stopTestServer(); rmSync(temp, { recursive: true, force: true }); });

const STATUS = { ok: 200, refused: [403, 404], conflict: 409 };
test('the real site answers every ADOPT case of the shared table', async () => {
  for (const c of table.adopt) {
    await reset();
    await arrange(c.existing, c.participant);
    const r = await call('adopt', ACTOR, USERNAME[c.participant]);
    const expected = STATUS[c.result];
    assert.ok(Array.isArray(expected) ? expected.includes(r.status) : r.status === expected, `${c.name}: got ${r.status}`);
    assert.equal(await holderOf(c.participant), c.holder, `${c.name}: who holds it afterwards`);
  }
});

test('the real site answers every RELEASE case of the shared table', async () => {
  for (const c of table.release) {
    await reset();
    await arrange(c.existing, c.participant);
    const r = await call('release', c.as === 'actor' ? ACTOR : previousOf(c.participant), USERNAME[c.participant]);
    assert.equal(r.status, 200, c.name);
    assert.equal((await r.json()).released, c.released, c.name);
    assert.equal(await holderOf(c.participant), c.holder, `${c.name}: who holds it afterwards`);
  }
});
