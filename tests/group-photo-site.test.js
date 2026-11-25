/**
 * group-photo-site.test.js — the trip site's half of "the bot sets the trip group's Telegram photo from the trip logo"
 * (docs/specs/sprint-9/x-trip-group-photo.md): AC-1 (the request reaches `done` here), AC-3 (`no_logo`), AC-4 (member 403,
 * switch off 409), AC-7 (only the newest logo is sent; a request older than 24 hours that never ran is `expired`) and the
 * two internal routes the control plane reaches through the runtime gateway.
 *
 * The REAL trip server, over HTTP. The control plane's half (the poller, the outbox, Telegram) is in
 * control-plane/api/test/group-photo-*.test.ts, and the gateway's in control-plane/runtime-gateway/test/group-photo.test.js.
 *
 * Every image is generated here with sharp; no binary is committed.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, stopTestServer, api, loginAsAlice, testDataDir } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

const require = createRequire(new URL('../server/site-icons.js', import.meta.url));
const sharp = require('sharp');
const Database = require('better-sqlite3');

const APIKEY = 'test-hermes-key';
const EXCHANGE_KEY = 'test-group-photo-exchange-key';
const TRIP_ID = 'trip_groupphoto01';
const INTERNAL = '/api/internal/control-plane/group-photo';
const solid = (w, h, background) => ({ create: { width: w, height: h, channels: 3, background } });
const png = (w = 64, h = 64, color = '#ff0000') => sharp(solid(w, h, color)).png().toBuffer();
const putLogo = async (token, bytes) => {
  const body = new FormData();
  body.set('logo', new Blob([bytes], { type: 'image/png' }), 'logo.png');
  const res = await api('/api/ui-settings/logo', { method: 'POST', body, token });
  assert.equal(res.status, 200);
};
const memberToken = async () => (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
// `api()` cannot send the exchange key's headers, so the internal routes are called directly.
let base;
// POST routes carry the trip id in the body, as the gateway's participant route does (server/control-plane-auth.js `internal`).
const internal = (path, { key = EXCHANGE_KEY, trip = TRIP_ID, body = {} } = {}) => fetch(`${base}${INTERNAL}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
  body: JSON.stringify({ ...(trip ? { tripId: trip } : {}), ...body }),
});
const requestPhoto = (token, extra = {}) => api('/api/group-photo', { method: 'POST', token, body: {}, ...extra });
const status = async (token) => (await api('/api/group-photo', { token })).json();
let db;
const rows = () => db.prepare('SELECT * FROM trip_group_photo_requests ORDER BY id').all();
const pixel = async (bytes, x, y) => {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [...data.subarray(at, at + 3)];
};

describe('the group photo, switch on', () => {
  let token, member, manifestDir;
  before(async () => {
    manifestDir = mkdtempSync(join(tmpdir(), 'group-photo-id-'));
    const manifest = join(manifestDir, 'identity.json');
    writeFileSync(manifest, JSON.stringify({ version: 1, tripId: TRIP_ID, owner: { userId: 'user_groupphoto1', username: 'alice' } }));
    const port = await freePort();
    base = `http://localhost:${port}`;
    await startTestServer(
      { HOST: '127.0.0.1', PORT: port, CONTROL_PLANE_EXCHANGE_KEY: EXCHANGE_KEY, CONTROL_PLANE_IDENTITY_FILE: manifest },
      { configure: (config) => { config.features = { trip_logo: true, trip_group_photo: true }; } },
    );
    token = await loginAsAlice();
    member = await memberToken();
    db = new Database(join(testDataDir(), 'trip.db'));
  });
  after(() => { db?.close(); stopTestServer(); rmSync(manifestDir, { recursive: true, force: true }); });

  test('AC-3: with no logo at all the request is refused at once with no_logo, and nothing is stored', async () => {
    const res = await requestPhoto(token);
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: 'no_logo', status: 'no_logo', message: 'This trip has no logo yet. Add one first, then ask again.' });
    assert.deepEqual(rows(), []);
    assert.deepEqual(await status(token), { status: 'none', request: null, message: null });
  });

  test('AC-4: a member\'s session is refused (403) on both routes, and an anonymous caller (401); nothing is stored', async () => {
    await putLogo(token, await png(80, 80, '#ff0000'));
    assert.equal((await requestPhoto(member)).status, 403);
    assert.equal((await api('/api/group-photo', { token: member })).status, 403);
    assert.equal((await requestPhoto(undefined)).status, 401);
    assert.equal((await api('/api/group-photo')).status, 401);
    assert.deepEqual(rows(), []);
  });

  test('AC-1: an organizer\'s request is pending, and the status says so in words', async () => {
    const res = await requestPhoto(token);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, 'pending');
    assert.equal(body.request.status, 'pending');
    assert.equal(body.request.requested_by, 'alice');
    assert.match(body.message, /on its way/i);
    assert.deepEqual(await status(token), body);
  });

  test('AC-1: the agent key (the companion) may ask and read, too', async () => {
    assert.equal((await api('/api/group-photo', { apiKey: APIKEY })).status, 200);
    assert.equal((await requestPhoto(undefined, { apiKey: APIKEY })).status, 202);
    assert.equal(rows().length, 1, 'a second request while one is waiting is the same request');
  });

  test('the internal routes: no key, a wrong key, the agent key, a member\'s session and the wrong trip all get nothing', async () => {
    for (const [label, call] of [
      ['no key', () => internal('/claim', { key: null })],
      ['a wrong key', () => internal('/claim', { key: 'nope' })],
      ['the agent key', () => internal('/claim', { key: APIKEY })],
    ]) {
      const res = await call();
      assert.equal(res.status, 401, label);
      assert.doesNotMatch(await res.text(), /base64|request/, label);
    }
    const asMember = await fetch(`${base}${INTERNAL}/claim`, { method: 'POST', headers: { authorization: `Bearer ${member}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(asMember.status, 401);
    const wrongTrip = await internal('/claim', { trip: 'trip_someoneelse01' });
    assert.equal(wrongTrip.status, 403);
    assert.equal(rows()[0].status, 'pending', 'none of those moved the request');
  });

  test('AC-1: claim hands the control plane a 640x640 PNG of the current logo and moves the request to sending', async () => {
    const res = await internal('/claim');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    // The keys the control plane's poller takes (control-plane/api/src/group-photo-poller.ts claimSchema; pinned there too).
    assert.deepEqual(Object.keys(body).sort(), ['photo', 'request']);
    assert.deepEqual(Object.keys(body.request).sort(), ['attempt', 'id', 'logo_hash', 'requested_at']);
    assert.deepEqual(Object.keys(body.photo).sort(), ['base64', 'content_type']);
    assert.ok(!Number.isNaN(Date.parse(body.request.requested_at)));
    assert.equal(body.request.id, rows()[0].id);
    assert.equal(body.request.attempt, 1);
    assert.match(body.request.logo_hash, /^[0-9a-f]{16}$/);
    assert.equal(body.photo.content_type, 'image/png');
    const bytes = Buffer.from(body.photo.base64, 'base64');
    const meta = await sharp(bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 640, 640]);
    assert.deepEqual(await pixel(bytes, 320, 320), [255, 0, 0], 'it is the logo');
    assert.equal(rows()[0].status, 'sending');
    assert.equal((await status(token)).status, 'sending');
    // Nothing else to hand over while this one is out.
    assert.deepEqual(await (await internal('/claim')).json(), { request: null });
  });

  test('a result: the control plane\'s answer is only taken for a request that is out, from a closed set, and detail is clipped', async () => {
    const id = rows()[0].id;
    for (const bad of [{ request_id: id, status: 'pending' }, { request_id: id, status: 'sending' }, { request_id: id, status: 'expired' }, { request_id: id, status: 'surprise' }, { request_id: 'x', status: 'done' }, { status: 'done' }]) {
      assert.equal((await internal('/result', { body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await internal('/result', { body: { request_id: id + 100, status: 'done' } })).status, 404);
    assert.equal((await internal('/result', { key: 'nope', body: { request_id: id, status: 'done' } })).status, 401);
    assert.equal(rows()[0].status, 'sending');
    const long = `${'x'.repeat(400)}\u0007\n`;
    const res = await internal('/result', { body: { request_id: id, status: 'failed', detail: long } });
    assert.equal(res.status, 200);
    const seen = await status(token);
    assert.equal(seen.status, 'failed');
    assert.equal(seen.request.detail.length, 300);
    assert.doesNotMatch(seen.request.detail, /[\u0000-\u001f]/);
    // The same word again is harmless; a different one for a finished request is refused.
    assert.equal((await internal('/result', { body: { request_id: id, status: 'failed' } })).status, 200);
    assert.equal((await internal('/result', { body: { request_id: id, status: 'done' } })).status, 409);
    assert.equal((await status(token)).status, 'failed');
  });

  test('AC-2 (words): bot_lacks_rights reads with the instruction a person can act on', async () => {
    await requestPhoto(token);
    const claimed = await (await internal('/claim')).json();
    assert.equal((await internal('/result', { body: { request_id: claimed.request.id, status: 'bot_lacks_rights', detail: 'administrator without can_change_info' } })).status, 200);
    const seen = await status(token);
    assert.equal(seen.status, 'bot_lacks_rights');
    assert.equal(seen.message, 'Make the bot an admin with "Change group info", then ask again.');
  });

  test('AC-3: no_group reads as such, and AC-1: done reads as done', async () => {
    await requestPhoto(token);
    let claimed = await (await internal('/claim')).json();
    await internal('/result', { body: { request_id: claimed.request.id, status: 'no_group' } });
    assert.equal((await status(token)).status, 'no_group');
    assert.match((await status(token)).message, /no telegram group/i);
    await requestPhoto(token);
    claimed = await (await internal('/claim')).json();
    await internal('/result', { body: { request_id: claimed.request.id, status: 'done' } });
    const seen = await status(token);
    assert.equal(seen.status, 'done');
    assert.match(seen.message, /group's photo is now the trip logo/i);
  });

  test('AC-7: two requests in a row are one: only the newest logo is sent', async () => {
    const before = rows().length;
    await putLogo(token, await png(80, 80, '#ff0000'));
    assert.equal((await requestPhoto(token)).status, 202);
    await putLogo(token, await png(80, 80, '#0000ff'));
    assert.equal((await requestPhoto(token)).status, 202);
    assert.equal(rows().length, before + 1, 'the second request replaced the first, which had not run');
    const claimed = await (await internal('/claim')).json();
    assert.deepEqual(await pixel(Buffer.from(claimed.photo.base64, 'base64'), 320, 320), [0, 0, 255]);
    await internal('/result', { body: { request_id: claimed.request.id, status: 'done' } });
  });

  test('AC-7: a logo replaced AFTER the request and before it is taken is the one sent (the old file is gone), and the request records the hash actually sent', async () => {
    await putLogo(token, await png(80, 80, '#ff0000'));
    await requestPhoto(token);
    const askedWith = rows().at(-1).logo_hash;
    await putLogo(token, await png(80, 80, '#00ff00'));
    const claimed = await (await internal('/claim')).json();
    assert.deepEqual(await pixel(Buffer.from(claimed.photo.base64, 'base64'), 320, 320), [0, 255, 0]);
    assert.notEqual(claimed.request.logo_hash, askedWith);
    assert.equal(rows().at(-1).logo_hash, claimed.request.logo_hash);
    await internal('/result', { body: { request_id: claimed.request.id, status: 'done' } });
  });

  test('AC-7: a request made while another is already out waits its turn: one at a time, and the newest logo is the last one sent', async () => {
    await putLogo(token, await png(80, 80, '#ff0000'));
    await requestPhoto(token);
    const first = await (await internal('/claim')).json();
    assert.deepEqual(await pixel(Buffer.from(first.photo.base64, 'base64'), 320, 320), [255, 0, 0]);
    await putLogo(token, await png(80, 80, '#0000ff'));
    const second = await (await requestPhoto(token)).json();
    assert.equal(second.status, 'pending');
    assert.notEqual(second.request.id, first.request.id, 'the one in flight cannot be taken back, so this is a new request');
    assert.deepEqual(await (await internal('/claim')).json(), { request: null }, 'not while the first is out');
    await internal('/result', { body: { request_id: first.request.id, status: 'done' } });
    const next = await (await internal('/claim')).json();
    assert.equal(next.request.id, second.request.id);
    assert.deepEqual(await pixel(Buffer.from(next.photo.base64, 'base64'), 320, 320), [0, 0, 255], 'the newest logo goes last, so it is the group\'s photo in the end');
    await internal('/result', { body: { request_id: next.request.id, status: 'done' } });
  });

  test('AC-7: a request older than 24 hours that never ran is expired, and is never sent', async () => {
    await requestPhoto(token);
    db.prepare("UPDATE trip_group_photo_requests SET requested_at = datetime('now', '-25 hours') WHERE status = 'pending'").run();
    assert.deepEqual(await (await internal('/claim')).json(), { request: null });
    const seen = await status(token);
    assert.equal(seen.status, 'expired');
    assert.match(seen.message, /ask again/i);
  });

  test('a request out for more than ten minutes goes back to pending, at most three times, then fails; it is never a loop', async () => {
    await requestPhoto(token);
    const id = (await (await internal('/claim')).json()).request.id;
    for (const attempt of [2, 3]) {
      db.prepare("UPDATE trip_group_photo_requests SET claimed_at = datetime('now', '-11 minutes') WHERE id = ?").run(id);
      const again = await (await internal('/claim')).json();
      assert.equal(again.request.id, id);
      assert.equal(again.request.attempt, attempt);
    }
    db.prepare("UPDATE trip_group_photo_requests SET claimed_at = datetime('now', '-11 minutes') WHERE id = ?").run(id);
    assert.deepEqual(await (await internal('/claim')).json(), { request: null });
    const seen = await status(token);
    assert.equal(seen.status, 'failed');
    assert.match(seen.request.detail, /no result/i);
  });

  test('a logo removed after the request: the claim answers no_logo and sends nothing', async () => {
    await requestPhoto(token);
    assert.equal((await api('/api/ui-settings/logo', { method: 'DELETE', token })).status, 200);
    assert.deepEqual(await (await internal('/claim')).json(), { request: null });
    assert.equal((await status(token)).status, 'no_logo');
  });
});

describe('the group photo, switch off', () => {
  let token, member, manifestDir;
  before(async () => {
    manifestDir = mkdtempSync(join(tmpdir(), 'group-photo-id-'));
    const manifest = join(manifestDir, 'identity.json');
    writeFileSync(manifest, JSON.stringify({ version: 1, tripId: TRIP_ID, owner: { userId: 'user_groupphoto1', username: 'alice' } }));
    const port = await freePort();
    base = `http://localhost:${port}`;
    await startTestServer(
      { HOST: '127.0.0.1', PORT: port, CONTROL_PLANE_EXCHANGE_KEY: EXCHANGE_KEY, CONTROL_PLANE_IDENTITY_FILE: manifest },
      { configure: (config) => { config.features = { trip_logo: true }; } },
    );
    token = await loginAsAlice();
    member = await memberToken();
    await putLogo(token, await png());
  });
  after(() => { stopTestServer(); rmSync(manifestDir, { recursive: true, force: true }); });

  test('AC-4: an organizer\'s request and read are 409 feature_off; a member is still 403 first; nothing is stored', async () => {
    const asked = await requestPhoto(token);
    assert.equal(asked.status, 409);
    assert.deepEqual(await asked.json(), { error: 'feature_off' });
    const read = await api('/api/group-photo', { token });
    assert.equal(read.status, 409);
    assert.deepEqual(await read.json(), { error: 'feature_off' });
    assert.equal((await requestPhoto(member)).status, 403, 'who may is answered before whether it is on');
    const db = new Database(join(testDataDir(), 'trip.db'), { readonly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM trip_group_photo_requests').get().n, 0); } finally { db.close(); }
  });

  test('AC-4: the control plane\'s claim finds nothing to send either, and no feature name leaks to a member', async () => {
    assert.deepEqual(await (await internal('/claim')).json(), { request: null });
    const config = await (await api('/api/config', { token: member })).json();
    assert.notEqual(config.features?.trip_group_photo, true);
  });
});
