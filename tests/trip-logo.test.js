/**
 * trip-logo.test.js — the trip's own logo (docs/specs/sprint-9/x-trip-logo.md), server half: AC-1 … AC-5, AC-7 (the
 * resolver's fallback order), AC-8, AC-9, AC-12 and AC-14 over HTTP, against the real site. AC-10 (the companion MCP)
 * is in mcp-trip-logo.test.js, AC-11 (the connector) in trip-mcp.test.js, AC-6 and the header source in
 * trip-web/src/trip-logo.test.tsx, AC-13 in trip-logo-skill.test.js.
 *
 * Every image is generated here with sharp; no binary is committed.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, stopTestServer, stopTestServerKeepData, api, loginAsAlice, testDataDir } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

const require = createRequire(new URL('../server/site-icons.js', import.meta.url));
const sharp = require('sharp');

const APIKEY = 'test-hermes-key';
const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const solid = (w, h, background) => ({ create: { width: w, height: h, channels: 3, background } });
const png = (w = 64, h = 64, color = '#ff0000') => sharp(solid(w, h, color)).png().toBuffer();
const form = (bytes, { type = 'image/png', name = 'logo.png', field = 'logo' } = {}) => {
  const body = new FormData();
  body.set(field, new Blob([bytes], { type }), name);
  return body;
};
const post = (bytes, extra = {}, opts) => api('/api/ui-settings/logo', { method: 'POST', body: form(bytes, opts), ...extra });
const ui = async (token) => (await api('/api/ui-settings', { token })).json();
const mediaLogos = () => readdirSync(join(testDataDir(), 'media')).filter(name => name.startsWith('logo-')).sort();
const memberToken = async () => (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
const pixel = async (bytes, x, y) => {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [...data.subarray(at, at + 3)];
};

describe('the trip logo, switch on', () => {
  let token, member;
  before(async () => {
    await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() }, { configure: (config) => { config.features = { trip_logo: true }; } });
    token = await loginAsAlice();
    member = await memberToken();
  });
  after(stopTestServer);

  test('a fresh trip has no logo: ui-settings says none and the public route has nothing to serve', async () => {
    const settings = await ui(token);
    assert.deepEqual(settings.logo, { url: null, source: 'none', updated_at: null });
    assert.equal((await api('/api/trip/logo')).status, 404);
  });

  test('AC-1: an organizer uploads a PNG; ui-settings points at /api/trip/logo?v=<hash of the stored file>', async () => {
    // Stored uncompressed, so a re-encode cannot come out identical to what was sent.
    const sent = await sharp(solid(300, 200, '#ff0000')).png({ compressionLevel: 0 }).toBuffer();
    const res = await post(sent, { token });
    assert.equal(res.status, 200);
    const settings = await ui(token);
    assert.equal(settings.logo.source, 'upload');
    assert.match(settings.logo.url, /^\/api\/trip\/logo\?v=[0-9a-f]{16}$/);
    assert.ok(settings.logo.updated_at);
    assert.equal((await res.json()).logo.url, settings.logo.url, 'the POST answers with the same settings');
    const served = await api(settings.logo.url);
    assert.equal(served.status, 200);
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.equal(sha16(bytes), new URL(settings.logo.url, 'http://x').searchParams.get('v'), 'v is the hash of the stored file');
    assert.notDeepEqual(bytes, sent, 'the client\'s bytes are never served as sent');
  });

  test('AC-1: JPEG, WebP and GIF are accepted too', async () => {
    const color = '#00aa00';
    const formats = {
      jpeg: [await sharp(solid(80, 80, color)).jpeg().toBuffer(), 'image/jpeg', 'l.jpg'],
      webp: [await sharp(solid(80, 80, color)).webp().toBuffer(), 'image/webp', 'l.webp'],
      gif: [await sharp(solid(80, 80, color)).gif().toBuffer(), 'image/gif', 'l.gif'],
    };
    for (const [format, [bytes, type, name]] of Object.entries(formats)) {
      const res = await post(bytes, { token }, { type, name });
      assert.equal(res.status, 200, format);
      const served = Buffer.from(await (await api('/api/trip/logo')).arrayBuffer());
      assert.equal((await sharp(served).metadata()).format, 'png', format);
    }
  });

  test('AC-1: the agent key (the companion) can write it too', async () => {
    const res = await post(await png(40, 40, '#0000ff'), { apiKey: APIKEY });
    assert.equal(res.status, 200);
    assert.equal((await ui(token)).logo.source, 'upload');
  });

  test('no session at all is 401 and nothing is stored', async () => {
    const before = mediaLogos();
    assert.equal((await post(await png())).status, 401);
    assert.deepEqual(mediaLogos(), before);
  });

  test('AC-2: a member is refused with 403 and nothing is stored or changed', async () => {
    const before = { files: mediaLogos(), settings: await ui(token) };
    const res = await post(await png(50, 50, '#123456'), { token: member });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'organizer_only' });
    assert.deepEqual(mediaLogos(), before.files);
    assert.deepEqual(await ui(token), before.settings);
    const del = await api('/api/ui-settings/logo', { method: 'DELETE', token: member });
    assert.equal(del.status, 403);
    assert.deepEqual(await ui(token), before.settings);
  });

  describe('AC-3: what is not an image is refused, and nothing changes', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><path d="M0 0h10v10H0z"/></svg>';
    const refuse = async (bytes, opts, status = 400) => {
      const before = { files: mediaLogos(), settings: await ui(token) };
      const res = await post(bytes, { token }, opts);
      assert.equal(res.status, status);
      if (status === 400) assert.deepEqual(await res.json(), { error: 'invalid_image' });
      assert.deepEqual(mediaLogos(), before.files, 'no file written');
      assert.deepEqual(await ui(token), before.settings, 'the stored logo is unchanged');
    };

    test('an SVG, said to be a PNG and named .png, is refused (sharp can read SVG; the format allow-list refuses it)', async () => {
      await refuse(Buffer.from(SVG), { type: 'image/png', name: 'logo.png' });
      await refuse(Buffer.from(SVG), { type: 'image/svg+xml', name: 'logo.svg' });
    });
    test('a PDF is refused', async () => {
      await refuse(Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'), { type: 'application/pdf', name: 'logo.pdf' });
      await refuse(Buffer.from('%PDF-1.4\n%%EOF'), { type: 'image/png', name: 'logo.png' });
    });
    test('a file named .png whose bytes are not an image (script, HTML, a truncated PNG) is refused', async () => {
      await refuse(Buffer.from('<html><script>alert(1)</script></html>'), { type: 'image/png', name: 'logo.png' });
      await refuse(Buffer.from('not an image at all'), { type: 'image/png', name: 'logo.png' });
      const whole = await png(64, 64);
      await refuse(whole.subarray(0, 40), { type: 'image/png', name: 'logo.png' });
    });
    test('an empty file and a missing field are refused', async () => {
      await refuse(Buffer.alloc(0), { type: 'image/png', name: 'logo.png' });
      await refuse(await png(), { field: 'file' });
    });
    test('an image over 40 megapixels is refused', async () => {
      const huge = await sharp(solid(7000, 6000, '#ffffff')).png({ compressionLevel: 9 }).toBuffer();
      assert.ok(huge.length < 8 * 1024 * 1024, 'the fixture itself must be small enough to reach the pixel check');
      await refuse(huge, { type: 'image/png', name: 'logo.png' });
    });
    test('a file over 8 MB is 413', async () => {
      await refuse(Buffer.alloc(8 * 1024 * 1024 + 1024, 1), { type: 'image/png', name: 'logo.png' }, 413);
    });
  });

  test('AC-4: orientation is applied, metadata is stripped, the image is fitted inside 1024x1024', async () => {
    // 200 wide x 100 tall pixels, tagged "rotate 90° clockwise": it displays 100 x 200.
    const tagged = await sharp(solid(200, 100, '#336699')).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'someone' } } }).toBuffer();
    assert.equal((await sharp(tagged).metadata()).orientation, 6);
    assert.equal((await post(tagged, { token }, { type: 'image/jpeg', name: 'photo.jpg' })).status, 200);
    let served = Buffer.from(await (await api('/api/trip/logo')).arrayBuffer());
    let meta = await sharp(served).metadata();
    assert.equal(meta.format, 'png');
    assert.deepEqual([meta.width, meta.height], [100, 200], 'EXIF orientation applied');
    assert.equal(meta.exif, undefined, 'no EXIF kept');
    assert.ok([undefined, 1].includes(meta.orientation));
    // Larger than the box: scaled down to fit, aspect kept.
    assert.equal((await post(await png(3000, 1500), { token })).status, 200);
    served = Buffer.from(await (await api('/api/trip/logo')).arrayBuffer());
    meta = await sharp(served).metadata();
    assert.deepEqual([meta.width, meta.height], [1024, 512]);
    // Smaller than the box: not scaled up.
    assert.equal((await post(await png(30, 20), { token })).status, 200);
    meta = await sharp(Buffer.from(await (await api('/api/trip/logo')).arrayBuffer())).metadata();
    assert.deepEqual([meta.width, meta.height], [30, 20]);
  });

  test('AC-4: a PNG with a script appended is served without it (the payload is not in the bytes served)', async () => {
    const marker = '<script>alert("stored-xss-marker")</script>';
    const polyglot = Buffer.concat([await png(64, 64), Buffer.from(marker)]);
    assert.ok(polyglot.includes(marker));
    assert.equal((await post(polyglot, { token })).status, 200);
    const res = await api('/api/trip/logo');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.includes('stored-xss-marker'), false);
    assert.equal(bytes.includes('<script'), false);
    assert.match(res.headers.get('content-type'), /^image\/png/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('AC-4 / spec: the public route is cacheable for five minutes and ignores ?v=', async () => {
    const plain = await api('/api/trip/logo');
    assert.match(plain.headers.get('cache-control'), /public, max-age=300/);
    const bytes = Buffer.from(await plain.arrayBuffer());
    for (const v of ['0000000000000000', '../../etc/passwd', 'x'.repeat(500)]) {
      const other = await api(`/api/trip/logo?v=${encodeURIComponent(v)}`);
      assert.equal(other.status, 200);
      assert.deepEqual(Buffer.from(await other.arrayBuffer()), bytes, '?v= selects nothing');
    }
  });

  test('AC-5: with no session, the route, every icon size and the manifest all serve the uploaded logo', async () => {
    assert.equal((await post(await png(120, 120, '#ff0000'), { token })).status, 200);
    const { logo } = await ui(token);
    const v = new URL(logo.url, 'http://x').searchParams.get('v');
    const served = Buffer.from(await (await api('/api/trip/logo')).arrayBuffer());
    assert.equal(sha16(served), v);
    for (const size of [32, 180, 192, 512]) {
      const res = await api(`/api/trip/icon/${size}.png`);
      assert.equal(res.status, 200, String(size));
      const icon = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(icon).metadata();
      assert.deepEqual([meta.width, meta.height], [size, size]);
      const [r, g, b] = await pixel(icon, size >> 1, size >> 1);
      assert.ok(r > 200 && g < 60 && b < 60, `the ${size}px icon is the red logo, not the Kinerary mark (${r},${g},${b})`);
    }
    const manifest = await (await api('/api/trip/manifest.webmanifest')).json();
    assert.ok(manifest.icons.length >= 2);
    for (const entry of manifest.icons) assert.match(entry.src, new RegExp(`^icon/(192|512)\\.png\\?v=${v}$`));
  });

  test('AC-12: a change to the logo moves the "ui" resource revision, which open pages follow', async () => {
    const res = await api('/api/events', { token });
    assert.equal(res.status, 200);
    // The stream is a view of trip_resource_revisions; the trigger on trip_ui_settings bumps `ui`.
    const frames = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) { frames.push(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
        }
      } catch { /* closed */ }
    })();
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100; i++) { if (frames.some(predicate)) return; await new Promise(r => setTimeout(r, 30)); }
      assert.fail(`no matching frame in ${JSON.stringify(frames)}`);
    };
    await waitFor(f => /event: ready/.test(f));
    frames.length = 0;
    assert.equal((await post(await png(70, 70, '#abcdef'), { token })).status, 200);
    await waitFor(f => /event: change/.test(f) && /"ui":\d+/.test(f));
    frames.length = 0;
    assert.equal((await api('/api/ui-settings/logo', { method: 'DELETE', token })).status, 200);
    await waitFor(f => /event: change/.test(f) && /"ui":\d+/.test(f));
    await reader.cancel().catch(() => {});
    await pump;
  });

  test('AC-8: DELETE removes the upload and its file; the fallback order applies (nothing in the config: none)', async () => {
    assert.equal((await post(await png(90, 90, '#222222'), { token })).status, 200);
    assert.equal(mediaLogos().length, 1, 'only the current logo is kept in MEDIA_DIR');
    const res = await api('/api/ui-settings/logo', { method: 'DELETE', token });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).logo, { url: null, source: 'none', updated_at: null });
    assert.deepEqual(mediaLogos(), []);
    assert.equal((await api('/api/trip/logo')).status, 404);
    // Deleting when nothing is set is not an error.
    assert.equal((await api('/api/ui-settings/logo', { method: 'DELETE', token })).status, 200);
  });

  test('uploading the same image twice keeps one live file (the second upload must not delete the first\'s file)', async () => {
    const same = await png(77, 77, '#445566');
    assert.equal((await post(same, { token })).status, 200);
    assert.equal((await post(same, { token })).status, 200);
    assert.equal(mediaLogos().length, 1);
    assert.equal((await api('/api/trip/logo')).status, 200);
  });

  test('replacing the logo deletes the previous file', async () => {
    assert.equal((await post(await png(50, 50, '#010101'), { token })).status, 200);
    const first = mediaLogos();
    assert.equal((await post(await png(50, 50, '#020202'), { token })).status, 200);
    const second = mediaLogos();
    assert.equal(second.length, 1);
    assert.notDeepEqual(second, first);
  });

  test('a private hero in MEDIA_DIR is never served by the public logo route', async () => {
    writeFileSync(join(testDataDir(), 'media', 'hero-1-secret.png'), await png(10, 10));
    // Whatever is asked, the bytes are the logo's own.
    const served = Buffer.from(await (await api('/api/trip/logo?file=hero-1-secret.png')).arrayBuffer());
    const { logo } = await ui(token);
    assert.equal(sha16(served), new URL(logo.url, 'http://x').searchParams.get('v'));
  });

  test('AC-14: the manifest takes the trip title; short_name is its first 12 characters', async () => {
    const manifest = await (await api('/api/trip/manifest.webmanifest')).json();
    assert.equal(manifest.name, 'Test Trip 2027');
    assert.equal(manifest.short_name, 'Test Trip 20');
  });

  test('the manifest and the icon routes leak no path and no raw config', async () => {
    const text = await (await api('/api/trip/manifest.webmanifest')).text();
    assert.equal(text.includes(testDataDir()), false);
    assert.equal(/deploymentNonce|test-fixture-nonce/.test(text), false);
  });
});

describe('AC-7: the fallback order, uploaded logo then meta.logo in the trip directory then none', () => {
  let token;
  before(async () => {
    await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() }, {
      configure: (config) => {
        config.features = { trip_logo: true };
        config.meta.logo = 'Logo.png'; // what the scaffolder writes on every trip; the file is not there
      },
    });
    token = await loginAsAlice();
  });
  after(stopTestServer);

  test('meta.logo names a missing file: neither source, so none', async () => {
    assert.equal((await ui(token)).logo.source, 'none');
    assert.equal((await api('/api/trip/logo')).status, 404);
  });
});

describe('AC-7 and AC-8: meta.logo is the fallback under an upload', () => {
  let token, configured;
  before(async () => {
    configured = await sharp(solid(60, 60, '#00ff00')).png().toBuffer();
    await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() }, {
      configure: (config, tripDir) => {
        config.features = { trip_logo: true };
        config.meta.logo = 'Logo.png';
        writeFileSync(join(tripDir, 'Logo.png'), configured);
      },
    });
    token = await loginAsAlice();
  });
  after(stopTestServer);

  test('no upload and a trip-directory logo that passes today\'s checks: that file is the logo, hashed', async () => {
    const { logo } = await ui(token);
    assert.equal(logo.source, 'config');
    assert.equal(logo.updated_at, null);
    assert.match(logo.url, /^\/api\/trip\/logo\?v=[0-9a-f]{16}$/);
    const served = Buffer.from(await (await api('/api/trip/logo')).arrayBuffer());
    assert.deepEqual(served, configured);
    assert.equal(sha16(served), new URL(logo.url, 'http://x').searchParams.get('v'));
    const [r, g, b] = await pixel(Buffer.from(await (await api('/api/trip/icon/192.png')).arrayBuffer()), 96, 96);
    assert.ok(g > 200 && r < 60 && b < 60, 'the icon is the configured logo too');
  });

  test('an upload wins over meta.logo, and deleting it brings meta.logo back', async () => {
    assert.equal((await post(await png(60, 60, '#ff0000'), { token })).status, 200);
    assert.equal((await ui(token)).logo.source, 'upload');
    const [r] = await pixel(Buffer.from(await (await api('/api/trip/icon/192.png')).arrayBuffer()), 96, 96);
    assert.ok(r > 200);
    const res = await api('/api/ui-settings/logo', { method: 'DELETE', token });
    assert.equal((await res.json()).logo.source, 'config');
    assert.deepEqual(mediaLogos(), []);
    assert.deepEqual(Buffer.from(await (await api('/api/trip/logo')).arrayBuffer()), configured);
  });
});

describe('AC-9: the switch off', () => {
  let token;
  before(async () => {
    await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() }, { configure: (config) => { config.features = { trip_logo: true }; } });
    token = await loginAsAlice();
  });
  after(stopTestServer);

  test('on, then off over the same data: writes answer 409 feature_off, the stored logo still shows', async () => {
    assert.equal((await post(await png(80, 80, '#ff0000'), { token })).status, 200);
    const before = await ui(token);
    const config = await (await api('/api/config', { token })).json();
    assert.equal(config.features?.trip_logo, true, 'a member-visible switch the site serves while it is on');
    const kept = mediaLogos();

    await stopTestServerKeepData();
    await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() }, { reuseData: true, configure: (c) => { delete c.features; } });
    token = await loginAsAlice();
    const off = await (await api('/api/config', { token })).json();
    assert.equal(off.features?.trip_logo, undefined);

    const res = await post(await png(10, 10), { token });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'feature_off' });
    const del = await api('/api/ui-settings/logo', { method: 'DELETE', token });
    assert.equal(del.status, 409);
    assert.deepEqual(await del.json(), { error: 'feature_off' });
    assert.deepEqual(mediaLogos(), kept, 'nothing stored or removed');

    // Display of a stored logo does not depend on the switch.
    assert.deepEqual((await ui(token)).logo.source, 'upload');
    assert.equal((await ui(token)).logo.url, before.logo.url);
    assert.equal((await api('/api/trip/logo')).status, 200);
    assert.equal((await api('/api/trip/icon/192.png')).status, 200);
  });

  test('a member is told 403, not 409, when the switch is off (who asks decides first)', async () => {
    const member = await memberToken();
    assert.equal((await post(await png(10, 10), { token: member })).status, 403);
  });

  test('the feature switch is a registered, member-visible name', async () => {
    const { findSwitch } = require('../shared/feature-switches.js');
    assert.deepEqual(findSwitch('trip_logo'), {
      name: 'trip_logo',
      summary: findSwitch('trip_logo').summary,
      surfaces: ['site', 'companion'],
      memberVisible: true,
    });
  });
});
