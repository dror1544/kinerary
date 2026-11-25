/**
 * trip-logo-connectors.test.js — the trip logo through the two assistant surfaces
 * (docs/specs/sprint-9/x-trip-logo.md): AC-9 (the tools say the feature is off), AC-10 (the companion's mcp/mcp.js:
 * `upload_trip_logo { filePath }`, `clear_trip_logo`) and AC-11 (the trip connector, server/trip-mcp: the upload link,
 * and the page that link opens).
 *
 * Three layers, each proving something the others cannot:
 *   - tools.js over an in-memory MCP transport against a recording site: which tools exist for which access, what they
 *     send, what they answer with the switch off;
 *   - mcp/mcp.js against a recording stand-in site: the request the companion sends (the field name, the key, the order:
 *     the switch is read before any write);
 *   - mcp/mcp.js against the REAL trip site, and the REAL upload page's script run against it: "AC-1 holds through the
 *     agent key" and "the page refuses a member's session and verifies the saved logo" are properties of the two ends
 *     together, which a stand-in cannot show.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { startTestMcp, stopTestMcp, mcpCallTool, mcpListTools, MCP_API_KEY, TRIP_API_KEY } from './helpers/mcp.js';
import { startTestServer, stopTestServer, loginAsAlice, api, testDataDir } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

const require = createRequire(import.meta.url);
const sharp = require('../server/node_modules/sharp');
const NONE = { changed: false, message: 'The trip logo is not turned on for this trip.' };
const png = (color = '#ff0000', w = 64, h = 64) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
// What /api/config says in each state: only the literal true is "on".
const STATES = { on: { features: { trip_logo: true } }, off: { features: {} }, absent: {}, 'a string true': { features: { trip_logo: 'true' } }, 'a number': { features: { trip_logo: 1 } } };

describe('server/trip-mcp/tools.js (an organizer\'s own Claude or ChatGPT)', () => {
  const { McpServer } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js');
  const { Client } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
  const { InMemoryTransport } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js');
  const { registerTools } = require('../server/trip-mcp/tools.js');
  const ORIGIN = 'https://trip.example';

  async function connect(write, config = STATES.on, { configFails = false } = {}) {
    const calls = [];
    const site = {
      get: async (path) => { calls.push({ method: 'GET', path }); if (configFails) throw new Error('GET /api/config → 503'); return config; },
      post: async (path, body) => { calls.push({ method: 'POST', path, body }); return {}; },
      patch: async (path, body) => { calls.push({ method: 'PATCH', path, body }); return {}; },
      del: async (path) => { calls.push({ method: 'DELETE', path }); return { logo: { url: null, source: 'none', updated_at: null } }; },
    };
    const server = new McpServer({ name: 'test', version: '1' });
    registerTools(server, site, { write, origin: ORIGIN });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { calls, client, close: () => client.close() };
  }
  const writes = (calls) => calls.filter((c) => c.method !== 'GET');

  test('AC-11: with organizer access, get_trip_logo_upload_link returns { status: pending_upload, url } and holds nothing back for the link', async () => {
    const { calls, client, close } = await connect(true);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'get_trip_logo_upload_link');
      assert.ok(tool, 'listed on a write connection');
      assert.equal(tool.annotations.readOnlyHint, false, 'a WRITE tool');
      assert.match(tool.description, /pending/i);
      assert.match(tool.description, /verified/i, 'it tells the model to claim success only after the page verified the logo');
      const result = await client.callTool({ name: 'get_trip_logo_upload_link', arguments: {} });
      assert.notEqual(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), { status: 'pending_upload', url: `${ORIGIN}/mcp/upload-logo` });
      assert.deepEqual(writes(calls), [], 'the link itself writes nothing');
      assert.doesNotMatch(result.content[0].text, /token|Bearer|key/i);
    } finally { await close(); }
  });

  test('AC-11: with read-only access neither logo tool is listed, and calling them reaches nothing', async () => {
    const { calls, client, close } = await connect(false);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('get_config'));
      assert.ok(!names.includes('get_trip_logo_upload_link'));
      assert.ok(!names.includes('clear_trip_logo'));
      for (const name of ['get_trip_logo_upload_link', 'clear_trip_logo']) {
        const call = await client.callTool({ name, arguments: {} }).catch((err) => ({ isError: true, err }));
        assert.equal(call.isError, true);
      }
      assert.deepEqual(calls, []);
    } finally { await close(); }
  });

  for (const [label, config] of Object.entries(STATES)) {
    if (label === 'on') continue;
    test(`AC-9, switch ${label}: no link, nothing cleared, and the answer is plain`, async () => {
      const { calls, client, close } = await connect(true, config);
      try {
        for (const name of ['get_trip_logo_upload_link', 'clear_trip_logo']) {
          const result = await client.callTool({ name, arguments: {} });
          assert.notEqual(result.isError, true);
          assert.deepEqual(JSON.parse(result.content[0].text), NONE, name);
        }
        assert.deepEqual(writes(calls), [], 'no write reached the site');
      } finally { await close(); }
    });
  }

  test('a config that cannot be read is a tool error, offers no link and changes nothing', async () => {
    const { calls, client, close } = await connect(true, STATES.on, { configFails: true });
    try {
      for (const name of ['get_trip_logo_upload_link', 'clear_trip_logo']) {
        assert.equal((await client.callTool({ name, arguments: {} })).isError, true, name);
      }
      assert.deepEqual(writes(calls), []);
    } finally { await close(); }
  });

  test('clear_trip_logo deletes through the site (as the person) and hands back the stored logo', async () => {
    const { calls, client, close } = await connect(true);
    try {
      const result = await client.callTool({ name: 'clear_trip_logo', arguments: {} });
      assert.notEqual(result.isError, true);
      assert.deepEqual(writes(calls), [{ method: 'DELETE', path: '/api/ui-settings/logo' }]);
      assert.deepEqual(JSON.parse(result.content[0].text), { changed: true, logo: { url: null, source: 'none', updated_at: null } });
    } finally { await close(); }
  });
});

describe('mcp/mcp.js against a recording stand-in site (what the companion sends)', () => {
  let apiServer, tmp, config = STATES.on, uploadStatus = 200;
  const requests = [];
  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'logo-mcp-'));
    apiServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], type: String(req.headers['content-type'] || ''), body: Buffer.concat(chunks) });
      res.writeHead(req.method === 'GET' ? 200 : uploadStatus, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/api/config') return res.end(JSON.stringify(config));
      if (uploadStatus !== 200) return res.end(JSON.stringify({ error: 'invalid_image' }));
      res.end(JSON.stringify({ logo: { url: '/api/trip/logo?v=0123456789abcdef', source: 'upload', updated_at: '2026-11-24 10:00:00' } }));
    });
    await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(0, '127.0.0.1', resolve); });
    await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${apiServer.address().port}`, MCP_PORT: String(await freePort()), MCP_API_KEY });
  });
  after(async () => {
    stopTestMcp();
    await new Promise((resolve) => apiServer.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  });
  const posts = () => requests.filter((r) => r.method !== 'GET');

  test('both tools are listed, with the organizer rule in the description', async () => {
    const tools = await mcpListTools();
    assert.ok(tools.upload_trip_logo && tools.clear_trip_logo);
    assert.match(tools.upload_trip_logo.description, /organizer/i);
    assert.match(tools.upload_trip_logo.description, /approved/i);
    assert.deepEqual(tools.upload_trip_logo.inputSchema.required, ['filePath']);
  });

  test('AC-10: upload_trip_logo reads the switch, then posts the file as multipart field "logo" with the trip key', async () => {
    config = STATES.on; uploadStatus = 200;
    const file = join(tmp, 'logo.png');
    writeFileSync(file, await png());
    const before = requests.length;
    const result = await mcpCallTool('upload_trip_logo', { filePath: file });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.deepEqual(JSON.parse(result.content[0].text), { changed: true, logo: { url: '/api/trip/logo?v=0123456789abcdef', source: 'upload', updated_at: '2026-11-24 10:00:00' } });
    const sent = requests.slice(before);
    assert.deepEqual(sent.map((r) => `${r.method} ${r.url}`), ['GET /api/config', 'POST /api/ui-settings/logo']);
    assert.equal(sent[1].apiKey, TRIP_API_KEY);
    assert.match(sent[1].type, /^multipart\/form-data/);
    assert.match(sent[1].body.toString('latin1'), /name="logo"; filename="logo\.png"/);
  });

  test('AC-10: clear_trip_logo sends DELETE /api/ui-settings/logo', async () => {
    config = STATES.on; uploadStatus = 200;
    const before = requests.length;
    const result = await mcpCallTool('clear_trip_logo', {});
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).changed, true);
    assert.deepEqual(requests.slice(before).map((r) => `${r.method} ${r.url}`), ['GET /api/config', 'DELETE /api/ui-settings/logo']);
    assert.equal(requests.at(-1).apiKey, TRIP_API_KEY);
  });

  for (const [label, state] of Object.entries(STATES)) {
    if (label === 'on') continue;
    test(`AC-9, switch ${label}: nothing is uploaded or cleared, and the answer says so`, async () => {
      config = state; uploadStatus = 200;
      const file = join(tmp, 'again.png');
      writeFileSync(file, await png());
      const before = posts().length;
      for (const [name, args] of [['upload_trip_logo', { filePath: file }], ['clear_trip_logo', {}]]) {
        const result = await mcpCallTool(name, args);
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        assert.deepEqual(JSON.parse(result.content[0].text), NONE, name);
      }
      assert.equal(posts().length, before, 'no write reached the site');
    });
  }

  test('a path that is not a readable file is a tool error before anything is sent', async () => {
    config = STATES.on;
    const before = posts().length;
    const result = await mcpCallTool('upload_trip_logo', { filePath: join(tmp, 'missing.png') });
    assert.equal(result.isError, true);
    assert.equal(posts().length, before);
  });

  test('a refusal from the site (invalid_image) reaches the model as an error, not as success', async () => {
    config = STATES.on; uploadStatus = 400;
    const file = join(tmp, 'bad.png');
    writeFileSync(file, 'not an image');
    const result = await mcpCallTool('upload_trip_logo', { filePath: file });
    uploadStatus = 200;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /400/);
    assert.match(result.content[0].text, /invalid_image/);
  });
});

describe('the real site: the companion bridge (AC-10) and the upload page (AC-11)', () => {
  let port, base, alice, bob, tmp;
  before(async () => {
    port = await freePort();
    base = `http://localhost:${port}`;
    tmp = mkdtempSync(join(tmpdir(), 'logo-e2e-'));
    await startTestServer({ PORT: String(port), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: base }, { configure: (config) => { config.features = { trip_logo: true }; } });
    alice = await loginAsAlice();
    bob = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
    await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${port}`, TRIP_API_KEY: 'test-hermes-key', MCP_PORT: String(await freePort()), MCP_API_KEY });
  });
  after(async () => { stopTestMcp(); stopTestServer(); rmSync(tmp, { recursive: true, force: true }); });
  const stored = async () => (await (await api('/api/ui-settings', { token: alice })).json()).logo;
  const mediaLogos = () => readdirSync(join(testDataDir(), 'media')).filter((n) => n.startsWith('logo-'));

  test('AC-10: upload_trip_logo { filePath } stores the logo through the agent key, and the site now shows it; clear_trip_logo removes it', async () => {
    const file = join(tmp, 'mine.png');
    writeFileSync(file, await png('#ff0000', 300, 150));
    const result = await mcpCallTool('upload_trip_logo', { filePath: file });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const answer = JSON.parse(result.content[0].text);
    assert.equal(answer.changed, true);
    assert.equal(answer.logo.source, 'upload');
    // Read back through the site, as the companion is told to.
    assert.deepEqual((await stored()).url, answer.logo.url);
    const served = Buffer.from(await (await api(answer.logo.url)).arrayBuffer());
    assert.equal(sha16(served), new URL(answer.logo.url, 'http://x').searchParams.get('v'));

    const cleared = JSON.parse((await mcpCallTool('clear_trip_logo', {})).content[0].text);
    assert.deepEqual(cleared.logo, { url: null, source: 'none', updated_at: null });
    assert.deepEqual(mediaLogos(), []);
  });

  test('AC-10: a file that is not an image, over the bridge, changes nothing and says so', async () => {
    const file = join(tmp, 'not-an-image.png');
    writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const result = await mcpCallTool('upload_trip_logo', { filePath: file });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /400/);
    assert.equal((await stored()).source, 'none');
    assert.deepEqual(mediaLogos(), []);
  });

  describe('AC-11: the page /mcp/upload-logo', () => {
    let script;
    before(async () => {
      const page = await fetch(base + '/mcp/upload-logo');
      assert.equal(page.status, 200);
      const csp = page.headers.get('content-security-policy');
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'nonce-[^']+'/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      assert.match(page.headers.get('cache-control'), /no-store/);
      const html = await page.text();
      assert.doesNotMatch(html, new RegExp(alice));
      assert.doesNotMatch(html, /Test Trip 2027/, 'no trip data in the page');
      const start = html.indexOf('<script nonce=');
      script = html.slice(html.indexOf('>', start) + 1, html.indexOf('</script>', start));
      assert.ok(script, 'the actual browser script is served');
    });

    async function browser(session, intercept = () => null) {
      const elements = Object.fromEntries(['status', 'file', 'submit', 'upload-form', 'preview'].map((id) => [id, {
        textContent: '', disabled: true, hidden: true, files: [], src: '', addEventListener(event, fn) { this[event] = fn; },
      }]));
      const requests = [];
      const context = {
        document: { getElementById: (id) => elements[id] },
        localStorage: { getItem: () => session },
        fetch: (path, options = {}) => { requests.push({ path, method: options.method || 'GET' }); return intercept(path, options) || fetch(new URL(path, base), options); },
        FormData, Uint8Array, Promise, URL, Array, crypto: globalThis.crypto,
      };
      await runInNewContext(script, context);
      return { elements, requests };
    }
    const choose = async (b, bytes, type = 'image/png', name = 'logo.png') => {
      const file = new Blob([bytes], { type }); file.name = name;
      b.elements.file.files = [file];
      await b.elements['upload-form'].submit({ preventDefault() {} });
    };

    test('no session, or a member\'s session: the form stays disabled and no POST is made; nothing is stored', async () => {
      for (const [label, session] of [['no session', null], ['a member', bob]]) {
        const b = await browser(session);
        assert.equal(b.elements.submit.disabled, true, label);
        assert.equal(b.elements.file.disabled, true, label);
        assert.ok(!b.requests.some((r) => r.method === 'POST'), label);
        assert.match(b.elements.status.textContent, /Sign in|organizer/i, label);
      }
      assert.equal((await stored()).source, 'none');
    });

    test('even if a member forced the form, the site itself refuses (403) and the page says so', async () => {
      const b = await browser(alice);
      assert.equal(b.elements.submit.disabled, false);
      // The page believes the session it was loaded with; swap in the member's for the POST.
      const forced = await browser(alice, (path, options) => (options.method === 'POST'
        ? fetch(new URL(path, base), { ...options, headers: { authorization: 'Bearer ' + bob } }) : null));
      await choose(forced, await png());
      assert.match(forced.elements.status.textContent, /Only a trip organizer/);
      assert.equal((await stored()).source, 'none');
    });

    test('the organizer\'s page uploads an image and says "verified" only after reading the saved logo back (settings, then the bytes and their hash)', async () => {
      const b = await browser(alice);
      assert.equal(b.elements.submit.disabled, false);
      assert.match(b.elements.status.textContent, /Nothing has been uploaded yet/);
      await choose(b, await png('#0000ff', 200, 200));
      assert.match(b.elements.status.textContent, /Logo uploaded and verified/);
      const order = b.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);
      const post = order.indexOf('POST /api/ui-settings/logo');
      assert.ok(post >= 0);
      assert.ok(order.indexOf('GET /api/ui-settings', post) > post, 'GET /api/ui-settings is read after the upload');
      assert.ok(order.indexOf('GET /api/trip/logo', post) > post, 'and the saved bytes are fetched');
      assert.equal((await stored()).source, 'upload');
      assert.equal(b.elements.preview.hidden, false);
    });

    test('if the saved logo cannot be read back, the page does not say done', async () => {
      const b = await browser(alice, (path) => (path.startsWith('/api/trip/logo') ? Promise.resolve(new Response('gone', { status: 404 })) : null));
      await choose(b, await png('#00ff00'));
      assert.match(b.elements.status.textContent, /Cannot read back/);
      assert.doesNotMatch(b.elements.status.textContent, /verified\./);
    });

    test('if the site reports no uploaded logo after the POST, the page does not say done', async () => {
      const b = await browser(alice, (path, options) => (path === '/api/ui-settings' && !options.method
        ? Promise.resolve(new Response(JSON.stringify({ logo: { url: null, source: 'none', updated_at: null } }), { status: 200 })) : null));
      await choose(b, await png('#00ffff'));
      assert.match(b.elements.status.textContent, /did not save/);
    });

    test('the page refuses a wrong type or an oversize file before any request, and says why for a refused image', async () => {
      const b = await browser(alice);
      const posts = () => b.requests.filter((r) => r.method === 'POST').length;
      await choose(b, Buffer.from('<svg/>'), 'image/svg+xml', 'x.svg');
      assert.match(b.elements.status.textContent, /PNG, JPEG, WebP or GIF/);
      assert.equal(posts(), 0);
      await choose(b, Buffer.alloc(8 * 1024 * 1024 + 1), 'image/png');
      assert.equal(posts(), 0);
      await choose(b, Buffer.from('not an image'), 'image/png', 'fake.png');
      assert.match(b.elements.status.textContent, /not an image the site can use/);
    });

    test('with the switch off the page offers no file (and the site would answer 409 anyway)', async () => {
      const b = await browser(alice, (path) => (path === '/api/config'
        ? Promise.resolve(new Response(JSON.stringify({ features: {} }), { status: 200 })) : null));
      assert.equal(b.elements.submit.disabled, true);
      assert.match(b.elements.status.textContent, /not turned on/);
    });
  });
});
