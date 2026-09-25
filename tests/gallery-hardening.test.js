/**
 * gallery-hardening.test.js — round two of the boundary audit of #191/#194.
 *
 *  1. /api/trip/logo serves images only: `meta.logo = "trip.config.json"` used
 *     to return the raw config with no login.
 *  2. /photo/:id is a capability link (`?s=<hmac>`): a stranger cannot guess an
 *     id into somebody's photo, and only a member is ever handed the link.
 *  3. Photo upload accepts images only and stores a name the server built, and
 *     the file route says nosniff / sandbox / private, so one member's upload
 *     cannot run script in another member's browser.
 *  4. A bad or expired signed link no longer overrides valid authentication.
 *  5. The anonymous trivia stream carries no `family`.
 *
 * Synthetic values only.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PORTS } from './helpers/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const require = createRequire(import.meta.url);
const { createFileTokens } = require('../server/file-token.js');

const PORT = PORTS.galleryHardening;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-secret-000';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function startServer(mutate = () => {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'trip-gallery-hardening-'));
  const tripDir = join(dataDir, 'trip');
  cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  const cfgPath = join(tripDir, 'trip.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  mutate(cfg, tripDir);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: SECRET, HERMES_API_KEY: 'test-hermes-key', SEED_PASSWORD: '1234',
      IMMICH_URL: '', IMMICH_API_KEY: '' },
  });
  let log = '';
  proc.stderr.on('data', c => { log += c; });
  proc.stdout.on('data', c => { log += c; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
    proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log}`)); });
    setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log}`)); }, 10_000);
  });
  return {
    dataDir, tripDir,
    stop: async () => { proc.kill('SIGTERM'); await new Promise(r => setTimeout(r, 100)); rmSync(dataDir, { recursive: true, force: true }); },
  };
}
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
const upload = (token, name, type, bytes = PNG) => {
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type }), name);
  form.append('phase', 'ny'); form.append('caption', 'c');
  return fetch(`${BASE}/api/photos/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
};

describe('GET /api/trip/logo serves images, never config or code', () => {
  for (const logo of ['trip.config.json', '.env', 'server.js', 'page.html']) {
    test(`meta.logo = ${logo} -> 404, no body`, async () => {
      const srv = await startServer((cfg, tripDir) => {
        cfg.meta.logo = logo;
        if (logo !== 'trip.config.json') writeFileSync(join(tripDir, logo), 'LOGO-SECRET-CONTENT');
      });
      try {
        const res = await get('/api/trip/logo');
        const text = await res.text();
        assert.equal(res.status, 404);
        assert.equal(text, '');
      } finally { await srv.stop(); }
    });
  }

  test('a real image logo is served with nosniff; an svg is sandboxed', async () => {
    const srv = await startServer((cfg, tripDir) => {
      cfg.meta.logo = 'logo.svg';
      writeFileSync(join(tripDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    });
    try {
      const res = await get('/api/trip/logo');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
    } finally { await srv.stop(); }
  });
});

describe('the gallery, share links, uploads and trivia', () => {
  let srv, alice, bob, photoA, photoB, listing;
  before(async () => {
    srv = await startServer();
    alice = await login('alice');
    bob = await login('bob');
    photoA = (await (await upload(alice, 'a.png', 'image/png')).json()).photo;
    photoB = (await (await upload(alice, 'b.png', 'image/png')).json()).photo;
    listing = await (await get('/api/photos', bob)).json();
  });
  after(async () => { await srv?.stop(); });

  describe('/photo/:id is a capability link', () => {
    const sharePath = (photo) => listing.find(p => p.id === photo.id).shareUrl;

    test('a member\'s listing and the upload reply carry shareUrl', () => {
      assert.match(sharePath(photoA), new RegExp(`^/photo/${photoA.id}\\?s=[0-9a-f]{64}$`));
      assert.match(photoA.shareUrl, new RegExp(`^/photo/${photoA.id}\\?s=[0-9a-f]{64}$`));
    });
    test('with the signature: 200, and the page mints a signed image link', async () => {
      const res = await get(sharePath(photoA));
      assert.equal(res.status, 200);
      assert.match(await res.text(), /\/api\/photos\/file\/[^"?]+\?exp=\d+&amp;sig=[0-9a-f]{64}/);
    });
    test('no signature, empty, wrong, or another photo\'s signature: 404', async () => {
      const sigB = new URL(sharePath(photoB), BASE).searchParams.get('s');
      for (const q of ['', '?s=', `?s=${'0'.repeat(64)}`, '?s=zz', `?s=${sigB}`]) {
        const res = await get(`/photo/${photoA.id}${q}`);
        assert.equal(res.status, 404, `served ${q}`);
        assert.ok(!(await res.text()).includes('og:image'));
      }
    });
    test('an unknown id with any signature is the same 404', async () => {
      assert.equal((await get(`/photo/1${'0'.repeat(12)}?s=${'a'.repeat(64)}`)).status, 404);
    });
    test('an anonymous caller never obtains a shareUrl', async () => {
      assert.equal((await get('/api/photos')).status, 401);
    });
  });

  describe('uploads are images, stored under a server-built name', () => {
    const cases = [
      ['x.html', 'text/html'], ['x.html', 'image/jpeg'], ['x.svg', 'image/svg+xml'],
      ['x.jpg', 'text/html'], ['x.js', 'application/javascript'],
    ];
    for (const [name, type] of cases) {
      test(`${name} as ${type} is refused`, async () => {
        const res = await upload(alice, name, type);
        assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`);
      });
    }
    test("a filename that is an inline-JS payload is refused or stored under a safe name", async () => {
      const res = await upload(alice, "a.')+alert(1)+('", 'image/jpeg');
      if (res.ok) {
        const { photo } = await res.json();
        assert.match(photo.filename, /^[A-Za-z0-9-]+\.(jpe?g|png|gif|webp|heic|heif)$/);
      } else assert.ok(res.status >= 400 && res.status < 500);
    });
    test('an accepted upload is stored as <id>-<random>.<safe ext>, never a fragment of originalname', async () => {
      const res = await upload(alice, 'Holiday Photo (1).JPG', 'image/jpeg');
      assert.equal(res.status, 200);
      const { photo } = await res.json();
      assert.match(photo.filename, /^[A-Za-z0-9-]+\.jpg$/);
      assert.ok(!photo.filename.toLowerCase().includes('holiday'));
    });
    test('refused uploads leave nothing in the uploads directory', () => {
      const files = readdirSync(join(srv.dataDir, 'uploads'));
      for (const f of files) assert.match(f, /^[A-Za-z0-9-]+\.(jpe?g|png|gif|webp|heic|heif)$/);
    });
  });

  describe('the file route', () => {
    test('says nosniff, sandbox, inline with a safe name, and private', async () => {
      const res = await get(listing[0].url);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
      assert.match(res.headers.get('content-disposition') || '', /^inline; filename="[A-Za-z0-9._-]+"$/);
      assert.match(res.headers.get('cache-control') || '', /private/);
      assert.ok(!/public/.test(res.headers.get('cache-control') || ''));
    });

    test('a forged or expired link does not override valid authentication', async () => {
      const { filename } = listing[0];
      const expired = createFileTokens(SECRET).sign(filename, Date.now() - 2 * 3600 * 1000);
      for (const q of [`?exp=${expired.exp}&sig=${expired.sig}`, `?exp=4102444800&sig=${'0'.repeat(64)}`]) {
        assert.equal((await get(`/api/photos/file/${filename}${q}`, bob)).status, 200, 'member with a stale link');
        assert.equal((await get(`/api/photos/file/${filename}${q}`, null, { 'X-API-Key': 'test-hermes-key' })).status, 200, 'agent with a stale link');
      }
    });
    test('a forged link with no authentication is still refused', async () => {
      const res = await get(`/api/photos/file/${listing[0].filename}?exp=4102444800&sig=${'0'.repeat(64)}`);
      assert.ok([401, 403].includes(res.status));
    });
  });

  describe('the anonymous trivia stream', () => {
    test('carries no family', async () => {
      const start = await fetch(`${BASE}/api/trivia/control`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice}` }, body: JSON.stringify({ action: 'start' }) });
      assert.equal(start.status, 200);
      const ctl = new AbortController();
      const res = await fetch(`${BASE}/api/trivia/public-events`, { signal: ctl.signal });
      const reader = res.body.getReader();
      const { value } = await reader.read();
      ctl.abort();
      const text = Buffer.from(value).toString('utf8');
      assert.match(text, /"players":\{[^}]*"alice"/, 'the player should be on the TV screen');
      assert.ok(!/family/.test(text), `family reached an anonymous caller: ${text.slice(0, 300)}`);
    });
  });
});
