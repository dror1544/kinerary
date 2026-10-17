/**
 * gallery-boundary.test.js — the trip site's no-login routes stop serving the
 * family (issues #191 and #194).
 *
 * Until this, GET /api/photos, /api/comments/*, /api/rsvps/:id, /api/reactions,
 * /api/tasks/done, /api/ratings and /api/album-share/:phase answered without a
 * login; the first six attached the WHOLE users row (telegram_id, google_*,
 * age) to every author; the photo files were served by bare filename;
 * /api/album-share/:phase minted a public Immich link for anybody;
 * /api/trip/logo joined a config value onto the trip directory unchecked; and
 * the /photo/:id share page put meta.brand into HTML raw.
 *
 * All values planted here are synthetic. Two things are kept honest at once:
 * an anonymous caller gets nothing, and a signed-in member's site still works.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PORTS } from './helpers/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { createFileTokens } = require('../server/file-token.js');

const PORT = PORTS.galleryBoundary;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-secret-000';
const ALLOWED_USER_KEYS = ['username', 'name', 'name_en', 'color', 'avatar_file'];
const TELEGRAM_ID = '700000111';
const GOOGLE_EMAIL = 'alice.planted@example.invalid';
const OUTSIDE_SECRET = 'OUTSIDE-THE-TRIP-DIR-SECRET';
const PHOTO_BYTES = Buffer.from('not-really-a-jpeg-but-bytes-for-the-test');

let dataDir, proc, alice, bob, immich, immichCalls, photo;

const login = async (username) => {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: '1234' }) });
    if (r.ok) return (await r.json()).token;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error(`login ${username} failed`);
};
const get = (p, token, headers = {}) => fetch(`${BASE}${p}`, {
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
});
const send = (p, token, method, body) => fetch(`${BASE}${p}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const fileTokens = createFileTokens(SECRET);

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'trip-gallery-boundary-'));
  const tripDir = join(dataDir, 'trip');
  cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  writeFileSync(join(dataDir, 'outside-secret.txt'), OUTSIDE_SECRET);
  writeFileSync(join(tripDir, 'inside-logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
  cfg.participants.find(p => p.username === 'alice').telegram_id = TELEGRAM_ID;
  cfg.meta.brand = '<script>alert("brand")</script>';
  cfg.meta.logo = '../outside-secret.txt';
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));

  // A stand-in Immich that counts what it is asked to do.
  immichCalls = [];
  immich = http.createServer((req, res) => {
    immichCalls.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/albums') return res.end(JSON.stringify([{ id: 'alb1', albumName: 'TEST — x' }]));
    if (req.url === '/api/albums') return res.end(JSON.stringify({ id: 'alb1' }));
    if (req.method === 'GET') return res.end('[]');
    res.end(JSON.stringify({ key: 'sharekey123' }));
  });
  await new Promise(r => immich.listen(0, '127.0.0.1', r));

  proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: SECRET, HERMES_API_KEY: 'test-hermes-key', SEED_PASSWORD: '1234',
      IMMICH_URL: `http://127.0.0.1:${immich.address().port}`, IMMICH_API_KEY: 'stand-in-key' },
  });
  let log = '';
  proc.stderr.on('data', c => { log += c; });
  proc.stdout.on('data', c => { log += c; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
    proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log}`)); });
    setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log}`)); }, 10_000);
  });
  alice = await login('alice');
  bob = await login('bob');

  // Plant identity columns that must never leave the server.
  const db = new Database(join(dataDir, 'trip.db'));
  db.prepare('UPDATE users SET google_email = ?, google_sub = ?, google_picture = ? WHERE username = ?')
    .run(GOOGLE_EMAIL, 'google-sub-planted', 'https://pictures.invalid/a.png', 'alice');
  db.close();

  // Alice leaves a trace on every social surface, and uploads one photo.
  assert.equal((await send('/api/rsvps/ny-show', alice, 'POST', { status: 'yes' })).status, 200);
  assert.equal((await send('/api/comments/venue/v1', alice, 'POST', { body: 'venue words' })).status, 200);
  assert.equal((await send('/api/reactions/p1', alice, 'POST', { emoji: '❤️' })).status, 200);
  assert.equal((await send('/api/comments/photo/p1', alice, 'POST', { body: 'photo words' })).status, 200);
  assert.equal((await send('/api/tasks/t1/done', alice, 'POST', {})).status, 200);
  assert.equal((await send('/api/ratings', alice, 'POST', { venue: 'v1', rating: 4 })).status, 200);
  const form = new FormData();
  form.append('photo', new Blob([PHOTO_BYTES], { type: 'image/jpeg' }), 'kids-at-the-pool.jpg');
  form.append('phase', 'ny'); form.append('caption', 'kids at the hotel pool');
  const up = await fetch(`${BASE}/api/photos/upload`, { method: 'POST', headers: { Authorization: `Bearer ${alice}` }, body: form });
  assert.equal(up.status, 200);
  photo = (await up.json()).photo;
});

after(async () => {
  proc?.kill('SIGTERM');
  await new Promise(r => immich?.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

const GATED_GETS = [
  '/api/photos', '/api/photos?phase=ny', '/api/comments/venue/v1', '/api/rsvps/ny-show',
  '/api/reactions', '/api/reactions/p1', '/api/comments/photo', '/api/comments/photo/p1',
  '/api/tasks/done', '/api/ratings', '/api/album-share/ny',
];
const PLANTED = [TELEGRAM_ID, GOOGLE_EMAIL, 'google-sub-planted', 'pictures.invalid', 'kids at the hotel pool', 'kids-at-the-pool'];

describe('unauthenticated callers get nothing', () => {
  for (const route of GATED_GETS) {
    test(`GET ${route} -> 401, no body of substance`, async () => {
      const res = await get(route);
      const text = await res.text();
      assert.equal(res.status, 401, `${route} answered ${res.status}: ${text.slice(0, 200)}`);
      for (const v of PLANTED) assert.ok(!text.includes(v), `${route} leaked ${v}`);
    });
  }

  test('the anonymous album-share request never reached Immich', async () => {
    assert.deepEqual(immichCalls.filter(c => /^POST \/api\/(shared-links|albums)/.test(c)), [], 'a share link or album was created for a caller with no login');
  });

  test('a photo file with no signature and no login is refused', async () => {
    const res = await get(`/api/photos/file/${photo.filename}`);
    assert.ok([401, 403].includes(res.status), `served ${res.status}`);
    assert.ok(!(await res.text()).includes('not-really-a-jpeg'));
  });
});

describe('a signed-in member still gets the site', () => {
  test('every gated route answers 200 for a member', async () => {
    for (const route of GATED_GETS) {
      const res = await get(route, bob);
      assert.equal(res.status, 200, `${route} -> ${res.status}`);
    }
  });

  test('every "other member" attachment carries only allow-listed fields', async () => {
    const users = [];
    const collect = (node) => {
      if (Array.isArray(node)) return node.forEach(collect);
      if (node && typeof node === 'object') {
        if (node.user && typeof node.user === 'object') users.push(node.user);
        Object.values(node).forEach(collect);
      }
    };
    for (const route of GATED_GETS.filter(r => r !== '/api/album-share/ny')) {
      const body = await (await get(route, bob)).json();
      const text = JSON.stringify(body);
      for (const v of PLANTED.slice(0, 4)) assert.ok(!text.includes(v), `${route} leaked ${v}`);
      assert.ok(!/"(age|telegram_id|google_[a-z]+|family|password)"/.test(text), `${route} carries a non-allow-listed column`);
      collect(body);
    }
    assert.ok(users.length >= 5, `expected users on the social routes, saw ${users.length}`);
    for (const u of users) {
      assert.ok(Object.keys(u).every(k => ALLOWED_USER_KEYS.includes(k)), `unexpected user keys: ${Object.keys(u)}`);
      assert.equal(typeof u.username, 'string');
    }
  });

  test("the caller's own POST replies are allow-listed too", async () => {
    const c = await (await send('/api/comments/venue/v2', alice, 'POST', { body: 'again' })).json();
    assert.deepEqual(Object.keys(c.user).sort(), Object.keys(c.user).filter(k => ALLOWED_USER_KEYS.includes(k)).sort());
    assert.ok(!('telegram_id' in c.user) && !('google_email' in c.user));
  });

  test('/api/auth/me still returns the caller\'s OWN record (getUser stays for that)', async () => {
    const me = await (await get('/api/auth/me', alice)).json();
    assert.equal(me.google_email, GOOGLE_EMAIL);
  });

  test('the album share still works for a member', async () => {
    const res = await get('/api/album-share/ny', bob);
    // the fixture's first phase id; an unknown phase is a 404 by design
    assert.ok([200, 404].includes(res.status));
    if (res.status === 200) assert.match((await res.json()).url, /\/share\/sharekey123$/);
  });
});

describe('photo files sit behind a short-lived signed link', () => {
  test('the authenticated listing hands out a working url', async () => {
    const list = await (await get('/api/photos', bob)).json();
    const p = list.find(x => x.id === photo.id);
    assert.ok(p, 'uploaded photo missing from the listing');
    assert.equal(p.filename, photo.filename);
    assert.match(p.url, /^\/api\/photos\/file\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);
    const res = await get(p.url);           // no Authorization header: an <img> cannot send one
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PHOTO_BYTES);
  });

  test('a forged signature is refused', async () => {
    const { exp } = fileTokens.sign(photo.filename);
    const res = await get(`/api/photos/file/${photo.filename}?exp=${exp}&sig=${'0'.repeat(64)}`);
    assert.ok([401, 403].includes(res.status), `served ${res.status}`);
  });

  test('an expired signature is refused', async () => {
    const past = fileTokens.sign(photo.filename, Date.now() - 2 * 60 * 60 * 1000);
    const res = await get(`/api/photos/file/${photo.filename}?exp=${past.exp}&sig=${past.sig}`);
    assert.ok([401, 403].includes(res.status), `served ${res.status}`);
  });

  test('a signature for one file does not open another', async () => {
    const { exp, sig } = fileTokens.sign('some-other-file.jpg');
    const res = await get(`/api/photos/file/${photo.filename}?exp=${exp}&sig=${sig}`);
    assert.ok([401, 403].includes(res.status), `served ${res.status}`);
  });

  test('a signature made with a different secret is refused', async () => {
    const other = createFileTokens('some-other-secret').sign(photo.filename);
    const res = await get(`/api/photos/file/${photo.filename}?exp=${other.exp}&sig=${other.sig}`);
    assert.ok([401, 403].includes(res.status), `served ${res.status}`);
  });

  test('a filename is never trusted as a path, even with a valid signature for it', async () => {
    const traversal = '../../outside-secret.txt';
    const { exp, sig } = fileTokens.sign(traversal);
    for (const name of [encodeURIComponent(traversal), '..%2F..%2Foutside-secret.txt', '%2e%2e%2foutside-secret.txt']) {
      const res = await get(`/api/photos/file/${name}?exp=${exp}&sig=${sig}`);
      const text = await res.text();
      assert.notEqual(res.status, 200, `served ${name}`);
      assert.ok(!text.includes(OUTSIDE_SECRET));
    }
  });

  test('a normal authenticated request (agent key, gateway session) still fetches the file', async () => {
    assert.equal((await get(`/api/photos/file/${photo.filename}`, bob)).status, 200);
    assert.equal((await get(`/api/photos/file/${photo.filename}`, null, { 'X-API-Key': 'test-hermes-key' })).status, 200);
  });
});

describe('GET /api/trip/logo stays inside the trip directory', () => {
  test('a meta.logo that climbs out of the trip dir is not served', async () => {
    const res = await get('/api/trip/logo');
    const text = await res.text();
    assert.equal(res.status, 404);
    assert.ok(!text.includes(OUTSIDE_SECRET));
  });
});

describe('GET /photo/:id escapes what it interpolates', () => {
  test('meta.brand cannot inject markup', async () => {
    const res = await get(photo.shareUrl);   // the capability link the uploader was handed
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!html.includes('<script>alert("brand")</script>'), 'raw <script> reached the page');
    assert.ok(html.includes('&lt;script&gt;'), 'brand was not escaped');
    assert.ok(!/content="[^"]*"[^>]*"brand"/.test(html));
  });
});

describe('the routes that stay public, on purpose', () => {
  for (const [route, why] of [
    ['/api/health', 'liveness / feature flags for the login screen'],
    ['/api/config/roster', 'the login picker, shape-checked'],
    ['/api/trivia/public-events', 'the TV screen'],
  ]) {
    test(`GET ${route} is still reachable without a login (${why})`, async () => {
      assert.equal((await get(route)).status, 200);
    });
  }

  test('the roster carries no identity column', async () => {
    const text = await (await get('/api/config/roster')).text();
    for (const v of PLANTED.slice(0, 4)) assert.ok(!text.includes(v));
    assert.ok(!/"(age|telegram_id|family)"/.test(text));
  });
});
