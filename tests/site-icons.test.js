import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
