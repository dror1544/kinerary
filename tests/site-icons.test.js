import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../server/site-icons.js', import.meta.url));
const express = require('express');
const sharp = require('sharp');
const { registerSiteIcons } = require('./site-icons');
let root, server, origin, logo;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kinerary-icons-'));
  const app = express();
  registerSiteIcons(app, {
    tripDir: root, siteDir: fileURLToPath(new URL('../site', import.meta.url)), getLogo: () => logo,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
async function icon(size) {
  const response = await fetch(`${origin}/api/trip/icon/${size}.png`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/png/);
  return Buffer.from(await response.arrayBuffer());
}
test('unauthenticated tab and shortcut requests receive correctly sized brand PNGs', async () => {
  logo = undefined;
  for (const size of [32, 180, 192, 512]) {
    const metadata = await sharp(await icon(size)).metadata();
    assert.equal(metadata.width, size); assert.equal(metadata.height, size);
  }
});
test('supplied logo overrides the brand and an updated file refreshes the icon', async () => {
  logo = 'custom.svg';
  await writeFile(join(root, logo), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><path fill="red" d="M0 0h80v40H0z"/></svg>');
  const first = await icon(192);
  const { data, info } = await sharp(first).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray((96 * 192 + 96) * info.channels, (96 * 192 + 96) * info.channels + 3)], [255, 0, 0]);
  await writeFile(join(root, logo), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><path fill="blue" d="M0 0h80v40H0z"/></svg>');
  assert.notDeepEqual(await icon(192), first);
});
test('missing, invalid and outside-trip logos safely fall back to Kinerary', async () => {
  logo = undefined; const fallback = await icon(180);
  await writeFile(join(root, 'invalid.png'), 'not an image');
  for (logo of ['missing.png', 'invalid.png', '../outside.png', '/etc/passwd']) {
    assert.deepEqual(await icon(180), fallback);
  }
});
test('unsupported sizes are rejected', async () => {
  assert.equal((await fetch(`${origin}/api/trip/icon/99999.png`)).status, 404);
});
test('manifest icons and launch URL remain inside the trip gateway prefix', async () => {
  const response = await fetch(`${origin}/api/trip/manifest.webmanifest`);
  assert.match(response.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await response.json();
  const url = `${origin}/t/example/api/trip/manifest.webmanifest`;
  assert.equal(new URL(manifest.start_url, url).pathname, '/t/example/modern/');
  assert.equal(new URL(manifest.scope, url).pathname, '/t/example/');
  for (const entry of manifest.icons) {
    assert.match(new URL(entry.src, url).pathname, /^\/t\/example\/api\/trip\/icon\/(192|512)\.png$/);
  }
  assert.equal(JSON.stringify(manifest).includes(root), false);
});

// ── The trip logo resolver (docs/specs/sprint-9/x-trip-logo.md) ───────────────
const { createEffectiveLogo, appNames, normalizeLogoUpload } = require('./site-icons');

async function resolverFixture() {
  const trip = await mkdtemp(join(tmpdir(), 'kinerary-logo-trip-'));
  const media = await mkdtemp(join(tmpdir(), 'kinerary-logo-media-'));
  const outside = await mkdtemp(join(tmpdir(), 'kinerary-logo-outside-'));
  const state = { upload: null, config: undefined };
  const resolve = createEffectiveLogo({
    tripDir: trip, mediaDir: media, getUpload: () => state.upload, getConfigLogo: () => state.config, log: { warn() {} },
  });
  const cleanup = () => Promise.all([trip, media, outside].map(dir => rm(dir, { recursive: true, force: true })));
  return { trip, media, outside, state, resolve, cleanup };
}
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPg62/7DwAD9QIjIm2vNAAAAABJRU5ErkJggg==', 'base64');

test('resolver: an upload, then meta.logo, then none', async () => {
  const f = await resolverFixture();
  try {
    assert.deepEqual(f.resolve(), { file: null, hash: null, source: 'none' });
    await writeFile(join(f.trip, 'Logo.png'), PNG_1PX);
    f.state.config = 'Logo.png';
    assert.equal(f.resolve().source, 'config');
    await writeFile(join(f.media, 'logo-0123456789abcdef.png'), PNG_1PX);
    f.state.upload = { file: 'logo-0123456789abcdef.png', hash: '0123456789abcdef' };
    const upload = f.resolve();
    assert.equal(upload.source, 'upload');
    assert.equal(upload.hash, '0123456789abcdef');
    f.state.upload = null;
    assert.equal(f.resolve().source, 'config');
  } finally { await f.cleanup(); }
});

test('resolver: containment is per source — an upload must be inside the media directory, meta.logo inside the trip directory', async () => {
  const f = await resolverFixture();
  try {
    await writeFile(join(f.outside, 'secret.png'), PNG_1PX);
    // An upload name that is a symlink out of the media directory is not served.
    await symlink(join(f.outside, 'secret.png'), join(f.media, 'logo-aaaaaaaaaaaaaaaa.png'));
    f.state.upload = { file: 'logo-aaaaaaaaaaaaaaaa.png', hash: 'aaaaaaaaaaaaaaaa' };
    assert.equal(f.resolve().source, 'none');
    // A name that is not ours (a hero, a path, a traversal) is never an upload, even if the file exists.
    await writeFile(join(f.media, 'hero-1-x.png'), PNG_1PX);
    for (const file of ['hero-1-x.png', '../x.png', 'logo-short.png', 'logo-0123456789abcdef.svg', 'logo-0123456789abcdef.png/..']) {
      f.state.upload = { file, hash: '0123456789abcdef' };
      assert.equal(f.resolve().source, 'none', file);
    }
    f.state.upload = null;
    // meta.logo: a media-directory file is not inside the trip directory, so it is not a config source.
    await writeFile(join(f.media, 'logo-bbbbbbbbbbbbbbbb.png'), PNG_1PX);
    for (const config of [join(f.media, 'logo-bbbbbbbbbbbbbbbb.png'), '../outside.png', '/etc/passwd', 'nope.png']) {
      f.state.config = config;
      assert.equal(f.resolve().source, 'none', config);
    }
    // A trip-directory file that is not an image by extension is not a logo.
    await writeFile(join(f.trip, 'trip.config.json'), '{}');
    f.state.config = 'trip.config.json';
    assert.equal(f.resolve().source, 'none');
    // A symlink inside the trip directory that leaves it is refused too.
    await mkdir(join(f.trip, 'sub'));
    await symlink(join(f.outside, 'secret.png'), join(f.trip, 'sub', 'link.png'));
    f.state.config = 'sub/link.png';
    assert.equal(f.resolve().source, 'none');
  } finally { await f.cleanup(); }
});

test('resolver: a stored upload whose file is gone falls back instead of failing', async () => {
  const f = await resolverFixture();
  try {
    await writeFile(join(f.trip, 'Logo.png'), PNG_1PX);
    f.state.config = 'Logo.png';
    f.state.upload = { file: 'logo-cccccccccccccccc.png', hash: 'cccccccccccccccc' };
    assert.equal(f.resolve().source, 'config');
  } finally { await f.cleanup(); }
});

test('resolver: a changed config logo is a new hash', async () => {
  const f = await resolverFixture();
  try {
    f.state.config = 'Logo.png';
    await writeFile(join(f.trip, 'Logo.png'), PNG_1PX);
    const first = f.resolve().hash;
    await writeFile(join(f.trip, 'Logo.png'), Buffer.concat([PNG_1PX, Buffer.from('x')]));
    assert.notEqual(f.resolve().hash, first);
    assert.match(first, /^[0-9a-f]{16}$/);
  } finally { await f.cleanup(); }
});

test('normalizeLogoUpload: only PNG, JPEG, WebP and GIF; SVG, PDF, garbage and over 40 megapixels are invalid_image', async () => {
  for (const bytes of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    Buffer.from('%PDF-1.4\n%%EOF'), Buffer.from('plain text'), Buffer.alloc(0), undefined,
    await sharp({ create: { width: 7000, height: 6000, channels: 3, background: '#fff' } }).png().toBuffer(),
  ]) {
    await assert.rejects(normalizeLogoUpload(bytes), { code: 'invalid_image' });
  }
  const png = await normalizeLogoUpload(await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#fff' } }).jpeg().toBuffer());
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 1024, 512]);
});

test('AC-14: the app is named for the trip; short_name is the first 12 characters by code point; no title is Kinerary', () => {
  assert.deepEqual(appNames('Alsace 2026 — Couple'), { name: 'Alsace 2026 — Couple', short_name: 'Alsace 2026' });
  assert.deepEqual(appNames('  Alsace  '), { name: 'Alsace', short_name: 'Alsace' });
  assert.equal(appNames('1234567890ab-cdef').short_name, '1234567890ab');
  assert.equal(appNames('12345678901 abcdef').short_name, '12345678901', 'trimmed after the cut');
  // An emoji outside the BMP counts once, and is not cut in half.
  assert.equal(appNames('😀'.repeat(13)).short_name, '😀'.repeat(12));
  for (const none of [undefined, null, '', '   ', 42, {}]) assert.deepEqual(appNames(none), { name: 'Kinerary', short_name: 'Kinerary' });
});

test('AC-5/14: the manifest carries the title and the icon version (?v=hash) of the effective logo', async () => {
  const f = await resolverFixture();
  const app = express();
  let title = 'Trip to the Alps and beyond';
  registerSiteIcons(app, {
    tripDir: f.trip, siteDir: fileURLToPath(new URL('../site', import.meta.url)), effectiveLogo: f.resolve, getTitle: () => title,
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(resolve => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let manifest = await (await fetch(`${base}/api/trip/manifest.webmanifest`)).json();
    assert.equal(manifest.name, 'Trip to the Alps and beyond');
    assert.equal(manifest.short_name, 'Trip to the');
    assert.deepEqual(manifest.icons.map(i => i.src), ['icon/192.png', 'icon/512.png'], 'no logo, no version');
    await writeFile(join(f.media, 'logo-0123456789abcdef.png'), PNG_1PX);
    f.state.upload = { file: 'logo-0123456789abcdef.png', hash: '0123456789abcdef' };
    title = undefined;
    manifest = await (await fetch(`${base}/api/trip/manifest.webmanifest`)).json();
    assert.deepEqual([manifest.name, manifest.short_name], ['Kinerary', 'Kinerary']);
    assert.deepEqual(manifest.icons.map(i => i.src), ['icon/192.png?v=0123456789abcdef', 'icon/512.png?v=0123456789abcdef']);
  } finally { await new Promise(resolve => srv.close(resolve)); await f.cleanup(); }
});
