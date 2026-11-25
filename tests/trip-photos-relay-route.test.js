/**
 * trip-photos-relay-route.test.js — the site half of Part B of "trip photos and moments"
 * (docs/specs/sprint-9/x-trip-photos-and-moments.md): the routes the control plane's relay reaches through the runtime gateway,
 * with the trip's own key, behind internal() like the participant and plan-changes routes.
 *
 *   POST /api/internal/control-plane/photos         one photo from the trip's group (AC-8, AC-9, AC-10 site half)
 *   GET  /api/internal/control-plane/photo-settings the two settings and whether the group was told (AC-12 site half)
 *   POST /api/internal/control-plane/photo-notice   the group was told
 *
 * The evidence the boundary review reads: a real server with a control-plane identity manifest and an exchange key. A wrong key,
 * no key, the agent key and a member session are 401 and save nothing; the right key for ANOTHER trip is 403 and saves nothing; with
 * the switch off the route is 409 and saves nothing; with automatic saving off an automatic save is 409 and saves nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/port-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
const AGENT_KEY = 'test-hermes-key';
const EXCHANGE_KEY = 'test-dedicated-exchange-key';
const TRIP_ID = 'trip_chatphotos001';
const BASE = '/api/internal/control-plane';
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function withServer(features, fn) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'trip-chat-photos-'));
  const tripDir = join(dataDir, 'trip');
  cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  const cfg = JSON.parse(JSON.stringify(FIXTURE));
  if (features !== undefined) cfg.features = features;
  // The first stop is happening around now, so a photo sent now has a stop to be filed under.
  cfg.phases[0].dates = { start: day(-2), end: day(2) };
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  const manifest = join(dataDir, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId: TRIP_ID, owner: { userId: 'user_chatowner001', username: 'alice' } }));
  const proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(port), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
      HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234',
      CONTROL_PLANE_EXCHANGE_KEY: EXCHANGE_KEY, CONTROL_PLANE_IDENTITY_FILE: manifest },
  });
  let log = '';
  proc.stderr.on('data', (c) => { log += c; });
  proc.stdout.on('data', (c) => { log += c; });
  try {
    await new Promise((resolve, reject) => {
      const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
      proc.on('exit', (code) => { clearInterval(t); reject(new Error(`server exited ${code}: ${log}`)); });
      setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log}`)); }, 15_000);
    });
    const tokenFor = async (username) => {
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: '1234' }) });
        if (r.ok) return (await r.json()).token;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error(`${username} could not log in`);
    };
    const member = { Authorization: `Bearer ${await tokenFor('bob')}` };
    const organizer = { Authorization: `Bearer ${await tokenFor('alice')}` };
    const agent = { 'X-API-Key': AGENT_KEY };
    const call = async (headers, path, init = {}) => {
      const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, body, headers: res.headers };
    };
    const internal = ({ key = EXCHANGE_KEY, trip = TRIP_ID } = {}) => ({ ...(key ? { 'x-api-key': key } : {}), ...(trip ? { 'x-control-plane-trip-id': trip } : {}) });
    const send = (fields = {}, { key = EXCHANGE_KEY, trip = TRIP_ID, bytes = JPEG } = {}) => call(
      internal({ key, trip: null }), `${BASE}/photos`,
      { method: 'POST', body: JSON.stringify({ tripId: trip, sender: null, messageKey: `-100:${Math.random().toString(36).slice(2)}`, mode: 'auto', sentAt: new Date().toISOString(), mime: 'image/jpeg', data: bytes.toString('base64'), ...fields }) },
    );
    const settings = (opts) => call(internal(opts), `${BASE}/photo-settings`);
    const notice = (trip = TRIP_ID) => call(internal({ trip: null }), `${BASE}/photo-notice`, { method: 'POST', body: JSON.stringify({ tripId: trip }) });
    const album = async () => (await call(organizer, '/api/photos')).body;
    const files = () => readdirSync(join(dataDir, 'uploads')).filter((f) => !f.startsWith('.'));
    const bindTelegram = (username, telegram_id) => call(agent, `/api/agent/participants/${username}/telegram`, { method: 'PATCH', body: JSON.stringify({ telegram_id }) });
    const setSettings = (body) => call(organizer, '/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
    return await fn({ member, organizer, agent, call, send, settings, notice, album, files, bindTelegram, setSettings });
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const ON = { chat_photos_to_album: true, trip_moments_capture: true };

describe('the routes are behind internal()', () => {
  test('no key, a wrong key, the agent key and a member session are 401; another trip is 403; nothing is saved', async () => {
    await withServer(ON, async ({ member, organizer, agent, call, send, settings, files, album }) => {
      const cases = [
        ['no key', await send({}, { key: null })],
        ['a wrong key', await send({}, { key: 'not-the-key' })],
        ['the agent key', await send({}, { key: AGENT_KEY })],
        ['a member session', await call(member, `${BASE}/photos`, { method: 'POST', body: JSON.stringify({ tripId: TRIP_ID, mode: 'auto', messageKey: 'a:b', data: JPEG.toString('base64') }) })],
        ['an organizer session', await call(organizer, `${BASE}/photos`, { method: 'POST', body: JSON.stringify({ tripId: TRIP_ID, mode: 'auto', messageKey: 'a:b', data: JPEG.toString('base64') }) })],
        ['the agent key on the settings read', await settings({ key: AGENT_KEY })],
        ['no key on the settings read', await settings({ key: null })],
        ['a member on the settings read', await call(member, `${BASE}/photo-settings`)],
      ];
      for (const [label, r] of cases) {
        assert.equal(r.status, 401, label);
        assert.deepEqual(r.body, { error: 'AUTHENTICATION_REQUIRED' }, label);
      }
      const wrongTrip = await send({}, { trip: 'trip_anothertrip01' });
      assert.equal(wrongTrip.status, 403);
      assert.deepEqual(wrongTrip.body, { error: 'TRIP_MISMATCH' });
      assert.equal((await settings({ trip: 'trip_anothertrip01' })).status, 403);
      assert.equal((await settings({ trip: null })).status, 403);
      // The agent key and a wrong key said no: the album and the disk hold nothing.
      assert.deepEqual(await album(), []);
      assert.deepEqual(files(), []);
      console.log(`wrong trip key / agent key / member: POST ${BASE}/photos -> ${cases.slice(0, 5).map(([, r]) => r.status).join(' ')}; another trip's id -> ${wrongTrip.status} ${JSON.stringify(wrongTrip.body)}; photos saved: 0`);
      void agent;
    });
  });

  test('with the switch off every route is 409 feature_off and nothing is saved; unlisted or false is off too', async () => {
    for (const features of [undefined, {}, { chat_photos_to_album: false }, { chat_photos_to_album: 'true' }, { chat_photos_to_album: 1 }]) {
      await withServer(features, async ({ send, notice, files, album }) => {
        const r = await send();
        assert.equal(r.status, 409, JSON.stringify(features));
        assert.deepEqual(r.body, { error: 'feature_off' });
        assert.equal((await notice()).status, 409);
        assert.deepEqual(await album(), []);
        assert.deepEqual(files(), []);
      });
    }
  });
});

describe('saving a photo', () => {
  test('AC-8: a participant\'s photo is in the album under their name, source chat, filed under the stop of the day it was sent', async () => {
    await withServer(ON, async ({ send, album, bindTelegram, files }) => {
      assert.equal((await bindTelegram('bob', '4242')).status, 200);
      const r = await send({ sender: '4242', messageKey: '-100:11' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.duplicate, false);
      assert.equal(r.body.photo.username, 'bob');
      assert.equal(r.body.photo.guest, false);
      assert.equal(r.body.photo.phase, 'ny');
      const photos = await album();
      assert.equal(photos.length, 1);
      assert.equal(photos[0].id, r.body.photo.id);
      assert.equal(photos[0].username, 'bob');
      assert.equal(photos[0].source, 'chat');
      assert.equal(photos[0].phase, 'ny');
      assert.equal(files().length, 1);
      assert.match(files()[0], /\.jpg$/);
    });
  });

  test('a photo sent on a day no stop covers is filed as general; a time in the future is read as now', async () => {
    await withServer(ON, async ({ send, album }) => {
      const old = await send({ sentAt: new Date(Date.now() - 60 * 86_400_000).toISOString(), messageKey: '-100:20' });
      assert.equal(old.body.photo.phase, 'general');
      const future = await send({ sentAt: new Date(Date.now() + 400 * 86_400_000).toISOString(), messageKey: '-100:21' });
      assert.equal(future.body.photo.phase, 'ny', 'a sent time years ahead is not believed: it is now');
      const photos = await album();
      assert.ok(photos.every((p) => Date.parse(p.uploadedAt) <= Date.now() + 1000));
    });
  });

  test('the same message again (a retry, an edited message) is the photo already saved, not a second one', async () => {
    await withServer(ON, async ({ send, album, files }) => {
      const first = await send({ messageKey: '-100:30' });
      const again = await send({ messageKey: '-100:30' });
      assert.equal(again.status, 200);
      assert.equal(again.body.duplicate, true);
      assert.equal(again.body.photo.id, first.body.photo.id);
      assert.equal((await album()).length, 1);
      assert.equal(files().length, 1);
    });
  });

  test('AC-10: a sender who is nobody on the trip is "a guest" with no name, saved only while automatic saving is on', async () => {
    await withServer(ON, async ({ send, album, setSettings, files }) => {
      const guest = await send({ sender: '999000111', messageKey: '-100:40' });
      assert.equal(guest.status, 200, guest.text);
      assert.equal(guest.body.photo.guest, true);
      const [photo] = await album();
      assert.equal(photo.user.guest, true);
      assert.equal(photo.user.name_en, 'A guest');
      assert.ok(!JSON.stringify(photo).includes('999000111'), 'the Telegram id is stored nowhere the album shows');
      // Automatic saving off: a guest is refused even when someone asked for the photo to be saved.
      assert.equal((await setSettings({ group_photo_autosave: false })).status, 200);
      const requested = await send({ sender: '999000111', messageKey: '-100:41', mode: 'requested' });
      assert.equal(requested.status, 403);
      assert.deepEqual(requested.body, { error: 'guest_requires_autosave' });
      assert.equal((await album()).length, 1);
      assert.equal(files().length, 1);
    });
  });

  test('AC-9: with automatic saving off an automatic save is refused and writes nothing; a requested save of a participant\'s photo is kept', async () => {
    await withServer(ON, async ({ send, album, setSettings, bindTelegram, files }) => {
      await bindTelegram('bob', '4242');
      assert.equal((await setSettings({ group_photo_autosave: false })).status, 200);
      const auto = await send({ sender: '4242', messageKey: '-100:50', mode: 'auto' });
      assert.equal(auto.status, 409);
      assert.deepEqual(auto.body, { error: 'autosave_off' });
      assert.deepEqual(await album(), []);
      assert.deepEqual(files(), []);
      const requested = await send({ sender: '4242', messageKey: '-100:50', mode: 'requested' });
      assert.equal(requested.status, 200, requested.text);
      assert.equal(requested.body.photo.username, 'bob');
      assert.equal((await album()).length, 1);
      console.log(`autosave off: auto save -> ${auto.status} ${JSON.stringify(auto.body)}; requested save -> ${requested.status}; photos in album: 1`);
    });
  });

  test('a removed participant is a guest: nothing is written in their name', async () => {
    await withServer(ON, async ({ send, bindTelegram, call, agent }) => {
      await bindTelegram('bob', '4242');
      const removed = await call(agent, '/api/agent/participants/bob', { method: 'DELETE' });
      assert.ok([200, 204].includes(removed.status), removed.text);
      const r = await send({ sender: '4242', messageKey: '-100:60' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.photo.username, '_guest');
      assert.equal(r.body.photo.guest, true);
    });
  });

  test('what is not a photo is refused whatever it claims: bytes decide, not the declared type', async () => {
    await withServer(ON, async ({ send, album, files }) => {
      for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), Buffer.from('%PDF-1.4 not a photo'), Buffer.from('<html></html>')]) {
        const r = await send({ messageKey: `-100:7${Math.floor(Math.random() * 1e6)}`, mime: 'image/jpeg' }, { bytes });
        assert.equal(r.status, 400);
        assert.deepEqual(r.body, { error: 'unsupported_file_type' });
      }
      assert.equal((await send({ data: '' })).status, 400);
      assert.equal((await send({ data: 12 })).status, 400);
      assert.equal((await send({ mode: 'whenever' })).status, 400);
      assert.equal((await send({ sender: 'bob' })).status, 400, 'a sender is a Telegram id, never a username');
      assert.equal((await send({ messageKey: '../etc/passwd' })).status, 400);
      assert.deepEqual(await album(), []);
      assert.deepEqual(files(), []);
    });
  });
});

describe('the settings read and the once-only notice', () => {
  test('AC-12: the read says the group has not been told; the acknowledgement says it has; off then on says it is due again', async () => {
    await withServer(ON, async ({ settings, notice, setSettings }) => {
      const first = await settings();
      assert.equal(first.status, 200, first.text);
      assert.deepEqual(first.body, { chat_photos_to_album: true, trip_moments_capture: true, group_photo_autosave: true, moment_capture_mode: 'ask_in_chat', autosave_notice_pending: true, participants: [] });
      assert.equal((await notice()).status, 200);
      assert.equal((await settings()).body.autosave_notice_pending, false, 'told once');
      assert.equal((await notice()).status, 200);
      // A mode change is not a toggle of the photo setting: the group is not told again.
      assert.equal((await setSettings({ moment_capture_mode: 'publish' })).status, 200);
      assert.equal((await settings()).body.autosave_notice_pending, false);
      // Off: nothing is pending (nothing is being saved); back on: the group is to be told again.
      assert.equal((await setSettings({ group_photo_autosave: false })).status, 200);
      const off = await settings();
      assert.equal(off.body.group_photo_autosave, false);
      assert.equal(off.body.autosave_notice_pending, false);
      await notice(); // acknowledging a notice for a setting that is off records nothing
      assert.equal((await setSettings({ group_photo_autosave: true })).status, 200);
      assert.equal((await settings()).body.autosave_notice_pending, true, 'off then on: the group is told again');
    });
  });

  test('the read names the participants the site maps by Telegram id, and only those: bound, not removed, nothing else about them', async () => {
    await withServer(ON, async ({ settings, bindTelegram, call, agent }) => {
      assert.deepEqual((await settings()).body.participants, []);
      await bindTelegram('bob', '4242');
      await bindTelegram('eve', '4343');
      const read = (await settings()).body.participants;
      assert.deepEqual(read.map((p) => [p.telegram_id, p.username]), [['4242', 'bob'], ['4343', 'eve']]);
      assert.deepEqual(Object.keys(read[0]).sort(), ['name', 'name_en', 'telegram_id', 'username'], 'no password, family, age, needs or colour');
      const removed = await call(agent, '/api/agent/participants/bob', { method: 'DELETE' });
      assert.ok([200, 204].includes(removed.status), removed.text);
      assert.deepEqual((await settings()).body.participants.map((p) => p.username), ['eve'], 'a removed participant is no longer one');
    });
  });

  test('with the switch off the read still answers, and says the switch is off and nothing is pending', async () => {
    await withServer(undefined, async ({ settings }) => {
      const r = await settings();
      assert.equal(r.status, 200);
      assert.equal(r.body.chat_photos_to_album, false);
      assert.equal(r.body.trip_moments_capture, false);
      assert.equal(r.body.autosave_notice_pending, false);
      assert.deepEqual(r.body.participants, [], 'with both switches off the roster is not served');
    });
  });
});
