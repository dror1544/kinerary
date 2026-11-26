/**
 * mcp-shared-bridge.test.js — ONE trip-mcp process serving every trip
 * (docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md, AC-B1.1 .. B1.9).
 *
 * The danger in a shared bridge is one the per-trip bridge could not have: a
 * companion reading another trip's data, or writing to it, because a request
 * was resolved against the wrong trip. Everything here that matters is
 * therefore proved with TWO fake trip sites that record the key each call
 * arrived with, and two tokens open at the same time.
 *
 * The bridge is a real child process (`node mcp/mcp.js`) driven over HTTP; the
 * MCP client is hand-rolled so the tests can hold a session open, POST to it
 * with somebody else's token, and watch its stream end when the route goes.
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/port-guard.js';

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const MCP_JS = path.join(HERE, '..', 'mcp', 'mcp.js');
const MCP_CWD = path.join(HERE, '..', 'mcp');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake trip site ───────────────────────────────────────────────────────────
/** A trip site that records every x-api-key it is called with. */
async function startSite(brand, { delayMs = 0, hang = false } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'] || null });
    if (hang) return; // never answers: a slow trip
    const answer = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/bookings') return res.end('[]');
      res.end(JSON.stringify({ meta: { brand }, phases: [], participants: [] }));
    };
    if (delayMs) setTimeout(answer, delayMs); else answer();
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port, seen, brand,
    url: `http://127.0.0.1:${port}`,
    keys: () => [...new Set(seen.map((s) => s.key))],
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

// ── route files ──────────────────────────────────────────────────────────────
function routeDoc(slug, over = {}) {
  return {
    schema_version: 1, trip: slug, api_base_url: 'http://127.0.0.1:9',
    trip_api_key: `key-for-${slug}-0123456789`, token_sha256: sha256hex(`token-${slug}`),
    ...over,
  };
}
function writeRoute(dir, slug, over = {}, { mode = 0o600, name = `${slug}.json` } = {}) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(routeDoc(slug, over)), { mode });
  fs.chmodSync(file, mode);
  return file;
}
/** Replace atomically, as companion-install-host.sh does. */
function replaceRoute(dir, slug, over = {}) {
  const tmp = path.join(dir, `.${slug}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(routeDoc(slug, over)), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, `${slug}.json`));
}

// ── the bridge under test ────────────────────────────────────────────────────
async function startBridge(env = {}) {
  const port = await freePort();
  const child = spawn('node', [MCP_JS], {
    cwd: MCP_CWD,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      MCP_PORT: String(port), ...env,
    },
  });
  let log = '';
  let ready = false;
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge did not start: ${log}`)), 10_000);
    child.stdout.on('data', (c) => { log += c; if (!ready && log.includes('listening on')) { ready = true; clearTimeout(t); resolve(); } });
    child.stderr.on('data', (c) => { log += c; });
    child.on('exit', (code) => { if (!ready) { clearTimeout(t); reject(new Error(`bridge exited ${code}: ${log}`)); } });
  });
  return {
    port, base: `http://127.0.0.1:${port}`, log: () => log, exited,
    stop: () => { child.kill('SIGTERM'); return exited; },
  };
}

/** A bridge in shared mode over `dir`, started the way an operator would. */
const startShared = (dir, env = {}) => startBridge({ MCP_ROUTES_DIR: dir, ...env });

// ── a hand-rolled MCP/SSE client ─────────────────────────────────────────────
async function openSession(base, token, { via = 'x-api-key' } = {}) {
  const ctrl = new AbortController();
  const headers = { Accept: 'text/event-stream' };
  if (via === 'x-api-key') headers['X-API-Key'] = token;
  const res = await fetch(`${base}/sse${via === 'query' ? `?key=${token}` : ''}`, { headers, signal: ctrl.signal });
  if (!res.ok) { ctrl.abort(); return { status: res.status }; }

  const messages = [];
  let endpoint = null;
  let ended = false;
  let endedAt = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + buf.slice(i).match(/^\r?\n\r?\n/)[0].length);
          let event = 'message'; const data = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          const payload = data.join('\n');
          if (event === 'endpoint') endpoint = payload;
          else if (payload) { try { messages.push(JSON.parse(payload)); } catch { /* keepalive */ } }
        }
      }
    } catch { /* aborted */ }
    ended = true; endedAt = Date.now();
  })();

  const waitFor = async (pred, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = pred(); if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(15);
    }
  };
  await waitFor(() => endpoint, 'endpoint event');

  let nextId = 1;
  const post = (msg, { token: postToken = token, noToken = false, url = endpoint } = {}) => {
    const h = { 'Content-Type': 'application/json' };
    if (!noToken) h['X-API-Key'] = postToken;
    return fetch(`${base}${url}`, { method: 'POST', headers: h, body: JSON.stringify(msg) });
  };
  const rpc = async (method, params, opts) => {
    const id = nextId++;
    const r = await post({ jsonrpc: '2.0', id, method, params }, opts);
    if (!r.ok) return { httpStatus: r.status };
    return (await waitFor(() => messages.find((m) => m.id === id), `${method} result`));
  };
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shared-bridge-test', version: '1' } });
  assert.ok(init.result, `initialize failed: ${JSON.stringify(init)}`);
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    status: 200, endpoint, post, rpc,
    callTool: async (name, args = {}, opts) => rpc('tools/call', { name, arguments: args }, opts),
    isEnded: () => ended, endedAt: () => endedAt,
    waitEnded: (ms) => waitFor(() => ended, 'the stream to end', ms),
    close: () => ctrl.abort(),
  };
}

const toolText = (r) => r?.result?.content?.[0]?.text || '';
const brandOf = (r) => { try { return JSON.parse(toolText(r)).meta.brand; } catch { return null; } };

// ═════════════════════════════════════════════════════════════════════════════

describe('AC-B1.1 opt-in', () => {
  let dir, bridge, canary;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    canary = await startSite('canary');
    // Everything a single-trip bridge reads is set, and must be ignored.
    bridge = await startShared(dir, {
      API_BASE_URL: canary.url, TRIP_PUBLIC_URL: canary.url,
      TRIP_API_KEY: 'single-mode-trip-key-0000', MCP_API_KEY: 'single-mode-agent-key-0000',
    });
  });
  after(async () => { await bridge.stop(); await canary.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('starts without MCP_API_KEY and does not take the single-trip key as a credential', async () => {
    const r = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'single-mode-agent-key-0000' } });
    assert.equal(r.status, 401);
    const r2 = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'single-mode-trip-key-0000' } });
    assert.equal(r2.status, 401);
  });

  test('API_BASE_URL / TRIP_PUBLIC_URL / TRIP_API_KEY are ignored (the canary site is never called)', async () => {
    writeRoute(dir, 'alpha', { api_base_url: 'http://127.0.0.1:9' });
    await sleep(1300);
    const s = await openSession(bridge.base, 'token-alpha');
    assert.equal(s.status, 200);
    const r = await s.callTool('get_config');
    assert.match(toolText(r), /trip site request failed/);
    assert.equal(canary.seen.length, 0, 'a single-mode variable leaked into shared mode');
    s.close();
  });

  test('says which inherited variables it ignored, by name only', () => {
    assert.match(bridge.log(), /API_BASE_URL is set and ignored in shared mode/);
    assert.ok(!bridge.log().includes('single-mode-trip-key-0000'));
  });
});

describe('AC-B1.1 a misconfigured MCP_ROUTES_DIR refuses to start', () => {
  test('a path that is not a directory exits non-zero and says why', async () => {
    await assert.rejects(startBridge({ MCP_ROUTES_DIR: path.join(os.tmpdir(), 'no-such-dir-for-routes') }), /MCP_ROUTES_DIR is not an existing directory/);
  });
});

describe('AC-B1.2 route files', () => {
  let dir, bridge;
  beforeEach(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-')); });
  afterEach(async () => { await bridge?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  const status = async (slug) => (await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': `token-${slug}` } })).status;

  test('a valid file routes; each way of being invalid is ignored, once, with a reason and no contents', async () => {
    const secretKey = 'SECRET-TRIP-KEY-should-never-be-logged-1';
    writeRoute(dir, 'good', { trip_api_key: secretKey });
    writeRoute(dir, 'groupread', {}, { mode: 0o640 });
    writeRoute(dir, 'otherwrite', {}, { mode: 0o602 });
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{ not json SECRET-BODY', { mode: 0o600 });
    writeRoute(dir, 'badschema', { schema_version: 2 });
    writeRoute(dir, 'mismatch', { trip: 'someone-else' });
    writeRoute(dir, 'pathbase', { api_base_url: 'http://127.0.0.1:9/some/path' });
    writeRoute(dir, 'credbase', { api_base_url: 'http://user:pw@127.0.0.1:9' });
    writeRoute(dir, 'ftpbase', { api_base_url: 'ftp://127.0.0.1:9' });
    writeRoute(dir, 'upperhash', { token_sha256: sha256hex('token-upperhash').toUpperCase() });
    writeRoute(dir, 'shorthash', { token_sha256: 'abc' });
    writeRoute(dir, 'badpublic', { public_url: 'https://x.example/path' });
    writeRoute(dir, 'shortkey', { trip_api_key: 'short' });
    const real = writeRoute(dir, 'realfile');
    fs.symlinkSync(real, path.join(dir, 'linked.json'));
    // The link's own contents are a valid route for "linked" — it must still be refused.
    fs.writeFileSync(real, JSON.stringify(routeDoc('linked')), { mode: 0o600 });
    bridge = await startShared(dir);

    assert.equal(await status('good'), 503, 'the valid route authenticates (503 = known token, site unreachable)');
    for (const slug of ['groupread', 'otherwrite', 'badschema', 'mismatch', 'pathbase', 'credbase', 'ftpbase', 'upperhash', 'shorthash', 'badpublic', 'shortkey', 'linked']) {
      assert.equal(await status(slug), 401, `${slug} must not route`);
    }
    assert.equal(await status('garbage'), 401);

    const log = bridge.log();
    for (const [file, why] of [
      ['groupread.json', /accessible to group or others/], ['otherwrite.json', /accessible to group or others/],
      ['garbage.json', /not valid JSON/], ['badschema.json', /unknown schema_version/],
      ['mismatch.json', /different trip than its file name/], ['pathbase.json', /api_base_url/],
      ['credbase.json', /api_base_url/], ['ftpbase.json', /api_base_url/],
      ['upperhash.json', /token_sha256/], ['shorthash.json', /token_sha256/],
      ['badpublic.json', /public_url/], ['shortkey.json', /trip_api_key/], ['linked.json', /is a symlink/],
    ]) {
      const line = log.split('\n').find((l) => l.includes(`route file ${file} ignored`));
      assert.ok(line, `a log line for ${file}:\n${log}`);
      assert.match(line, why);
    }
    assert.ok(!log.includes(secretKey), 'a key reached the log');
    assert.ok(!log.includes('SECRET-BODY'), 'file contents reached the log');
    assert.ok(!/127\.0\.0\.1:9\b/.test(log), 'an address reached the log');
    assert.ok(!log.includes(sha256hex('token-good')), 'a token hash reached the log');
    assert.equal(log.split('\n').filter((l) => l.includes('groupread.json')).length, 1, 'logged once, not on every rescan');
  });

  test('two files with the same token_sha256 are BOTH ignored', async () => {
    const same = sha256hex('shared-token');
    writeRoute(dir, 'twin-a', { token_sha256: same });
    writeRoute(dir, 'twin-b', { token_sha256: same });
    bridge = await startShared(dir);
    const r = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'shared-token' } });
    assert.equal(r.status, 401);
    assert.match(bridge.log(), /twin-a\.json ignored: shares its token/);
    assert.match(bridge.log(), /twin-b\.json ignored: shares its token/);
  });

  test('a file without public_url is valid (public_url is optional)', async () => {
    writeRoute(dir, 'nopublic');
    bridge = await startShared(dir);
    assert.equal(await status('nopublic'), 503);
  });
});

describe('AC-B1.3 / B1.4 the token picks the trip, and nothing else can', () => {
  let dir, bridge, siteA, siteB;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    siteA = await startSite('Trip A', { delayMs: 40 });
    siteB = await startSite('Trip B', { delayMs: 15 });
    writeRoute(dir, 'trip-a', { api_base_url: siteA.url });
    writeRoute(dir, 'trip-b', { api_base_url: siteB.url });
    bridge = await startShared(dir);
  });
  after(async () => { await bridge.stop(); await siteA.close(); await siteB.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const keyA = 'key-for-trip-a-0123456789';
  const keyB = 'key-for-trip-b-0123456789';

  test('B1.3: two sessions open at once each read their own trip, with their own key', async () => {
    const a = await openSession(bridge.base, 'token-trip-a');
    const b = await openSession(bridge.base, 'token-trip-b');
    const [ra, rb] = await Promise.all([a.callTool('get_config'), b.callTool('get_config')]);
    assert.equal(brandOf(ra), 'Trip A');
    assert.equal(brandOf(rb), 'Trip B');
    // Interleave many calls so a context that leaked between awaits would show.
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? b : a).callTool('get_config')));
    many.forEach((r, i) => assert.equal(brandOf(r), i % 2 ? 'Trip B' : 'Trip A'));
    assert.deepEqual(siteA.keys(), [keyA], 'site A saw only its own key');
    assert.deepEqual(siteB.keys(), [keyB], 'site B saw only its own key');
    a.close(); b.close();
  });

  test('B1.3: an unknown token is 401 on /sse and /health; no token is 401', async () => {
    for (const p of ['/sse', '/health']) {
      assert.equal((await fetch(`${bridge.base}${p}`, { headers: { 'X-API-Key': 'token-nobody' } })).status, 401);
      assert.equal((await fetch(`${bridge.base}${p}`)).status, 401);
    }
  });

  test('B1.3: the bearer and ?key= forms a Hermes profile may use resolve the same way', async () => {
    const r = await fetch(`${bridge.base}/health`, { headers: { Authorization: 'Bearer token-trip-b' } });
    assert.equal(r.status, 200);
    const q = await openSession(bridge.base, 'token-trip-a', { via: 'query' });
    assert.equal(brandOf(await q.callTool('get_config')), 'Trip A');
    q.close();
  });

  test('B1.4: a POST to A\'s session with B\'s token is refused, and B\'s site is never called', async () => {
    const a = await openSession(bridge.base, 'token-trip-a');
    const before = siteB.seen.length;
    const r = await a.rpc('tools/call', { name: 'get_config', arguments: {} }, { token: 'token-trip-b' });
    assert.equal(r.httpStatus, 401);
    assert.equal(siteB.seen.length, before, 'trip B was reached by trip A\'s session');
    a.close();
  });

  test('B1.4: a POST that presents no token still runs as the session\'s own trip', async () => {
    const b = await openSession(bridge.base, 'token-trip-b');
    const beforeA = siteA.seen.length;
    const r = await b.callTool('get_config', {}, { noToken: true });
    assert.equal(brandOf(r), 'Trip B');
    assert.equal(siteA.seen.length, beforeA, 'trip A was reached by trip B\'s session');
    b.close();
  });

  test('B1.4: no header or query parameter names a trip', async () => {
    const a = await openSession(bridge.base, 'token-trip-a');
    const beforeB = siteB.seen.length;
    const url = `${a.endpoint}&trip=trip-b&slug=trip-b&tripId=trip-b`;
    const id = 777;
    const res = await fetch(`${bridge.base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'token-trip-a', 'X-Trip': 'trip-b', 'X-Trip-Slug': 'trip-b', 'X-Forwarded-Host': 'trip-b.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_config', arguments: { trip: 'trip-b', slug: 'trip-b', trip_id: 'trip-b' } } }),
    });
    assert.ok(res.ok);
    await sleep(500); // the POST is accepted at once; the tool call runs after
    assert.equal(siteB.seen.length, beforeB, 'a header/query/argument named another trip and was obeyed');
    a.close();
  });

  test('B1.4: a session id from one trip cannot be used with another trip\'s token', async () => {
    const a = await openSession(bridge.base, 'token-trip-a');
    const res = await fetch(`${bridge.base}${a.endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'token-trip-b' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
    a.close();
  });
});

describe('AC-B1.2 public_url is the route\'s own fallback, never another trip\'s', () => {
  let dir, bridge, live, other;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    live = await startSite('Fallback of A');
    other = await startSite('Other');
    writeRoute(dir, 'fb-a', { api_base_url: 'http://127.0.0.1:9', public_url: live.url });
    writeRoute(dir, 'fb-b', { api_base_url: 'http://127.0.0.1:9', public_url: other.url });
    bridge = await startShared(dir);
  });
  after(async () => { await bridge.stop(); await live.close(); await other.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('when api_base_url is down the route\'s own public_url answers, with the route\'s own key', async () => {
    const s = await openSession(bridge.base, 'token-fb-a');
    assert.equal(brandOf(await s.callTool('get_config')), 'Fallback of A');
    assert.equal(other.seen.length, 0);
    assert.deepEqual(live.keys(), ['key-for-fb-a-0123456789']);
    s.close();
  });
  test('the retry is logged by slug, with no address', () => {
    const line = bridge.log().split('\n').find((l) => l.includes('retrying via the public url'));
    assert.ok(line, bridge.log());
    assert.match(line, /trip=fb-a/);
    assert.ok(!/127\.0\.0\.1|http:/.test(line), line);
  });
});

describe('AC-B1.5 revocation and addition within 2 seconds, without a restart', () => {
  let dir, bridge, site;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    site = await startSite('Revocable');
    bridge = await startShared(dir);
  });
  after(async () => { await bridge.stop(); await site.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const code = async (token) => (await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': token } })).status;
  const untilCode = async (token, want, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 <= ms) { if (await code(token) === want) return Date.now() - t0; await sleep(50); }
    return null;
  };

  test('adding a file takes effect within 2 s', async () => {
    assert.equal(await code('token-late'), 401);
    writeRoute(dir, 'late', { api_base_url: site.url });
    const took = await untilCode('token-late', 200);
    assert.ok(took !== null, 'route not live within 2 s of being added');
  });

  test('deleting a file closes its open session and refuses the token, within 2 s', async () => {
    writeRoute(dir, 'gone', { api_base_url: site.url });
    assert.ok(await untilCode('token-gone', 200) !== null);
    const s = await openSession(bridge.base, 'token-gone');
    assert.equal(brandOf(await s.callTool('get_config')), 'Revocable');
    const t0 = Date.now();
    fs.unlinkSync(path.join(dir, 'gone.json'));
    await s.waitEnded(2000);
    const closedAfter = s.endedAt() - t0;
    assert.ok(closedAfter <= 2000, `session closed after ${closedAfter} ms`);
    assert.equal(await code('token-gone'), 401);
    console.log(`  evidence: delete -> SSE stream closed after ${closedAfter} ms; new connection 401`);
  });

  test('replacing token_sha256 refuses the old token, accepts the new, and closes the old session', async () => {
    writeRoute(dir, 'rotate', { api_base_url: site.url });
    assert.ok(await untilCode('token-rotate', 200) !== null);
    const s = await openSession(bridge.base, 'token-rotate');
    const t0 = Date.now();
    replaceRoute(dir, 'rotate', { api_base_url: site.url, token_sha256: sha256hex('rotated-token') });
    await s.waitEnded(2000);
    const closedAfter = s.endedAt() - t0;
    assert.ok(closedAfter <= 2000, `session closed after ${closedAfter} ms`);
    assert.equal(await code('token-rotate'), 401);
    assert.equal(await code('rotated-token'), 200);
    console.log(`  evidence: token replaced -> old session closed after ${closedAfter} ms; old token 401, new token 200`);
  });

  test('re-writing an identical file does not disturb an open session', async () => {
    writeRoute(dir, 'steady', { api_base_url: site.url });
    assert.ok(await untilCode('token-steady', 200) !== null);
    const s = await openSession(bridge.base, 'token-steady');
    replaceRoute(dir, 'steady', { api_base_url: site.url });
    await sleep(2300);
    assert.equal(s.isEnded(), false, 'an idempotent re-wire closed a live session');
    assert.equal(brandOf(await s.callTool('get_config')), 'Revocable');
    s.close();
  });

  test('a file that becomes invalid (loosened mode) stops routing within 2 s', async () => {
    const f = writeRoute(dir, 'loosen', { api_base_url: site.url });
    assert.ok(await untilCode('token-loosen', 200) !== null);
    fs.chmodSync(f, 0o644);
    assert.ok(await untilCode('token-loosen', 401) !== null, 'a world-readable route kept routing');
  });
});

describe('AC-B1.6 /health and /ready', () => {
  let dir, bridge, site;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    site = await startSite('Healthy');
    writeRoute(dir, 'up', { api_base_url: site.url });
    writeRoute(dir, 'down', { api_base_url: 'http://127.0.0.1:1' });
    bridge = await startShared(dir);
  });
  after(async () => { await bridge.stop(); await site.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('/health answers for the token\'s own trip with today\'s shapes', async () => {
    const up = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'token-up' } });
    assert.equal(up.status, 200);
    assert.deepEqual(await up.json(), { ok: true, site: 'reachable' });
    const down = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'token-down' } });
    assert.equal(down.status, 503);
    const body = await down.json();
    assert.equal(body.ok, false); assert.equal(body.site, 'unreachable'); assert.ok(body.code);
    assert.ok(!/127\.0\.0\.1|http:/.test(JSON.stringify(body)), 'health must not name an address');
  });

  test('/health without a valid token is 401', async () => {
    assert.equal((await fetch(`${bridge.base}/health`)).status, 401);
    assert.equal((await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'nope' } })).status, 401);
  });

  test('/ready needs no key and says only { ok: true }', async () => {
    const r = await fetch(`${bridge.base}/ready`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });

  // F3 (owner review of #599): the trip's container calls this bridge with the key its own site holds.
  test("AC-B2.9: /health also answers a request that carries the trip SITE's key, for that trip only", async () => {
    const up = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'key-for-up-0123456789' } });
    assert.equal(up.status, 200);
    assert.deepEqual(await up.json(), { ok: true, site: 'reachable' });
    // The same route, but the site behind it is down: the bridge says so with its own code, naming nothing.
    const down = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'key-for-down-0123456789' } });
    assert.equal(down.status, 503);
    const body = await down.json();
    assert.equal(body.site, 'unreachable');
    assert.ok(!/127\.0\.0\.1|http:/.test(JSON.stringify(body)));
    // A key that no route holds is as refused as a bad token, however it is presented.
    assert.equal((await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'key-for-nobody-0123456789' } })).status, 401);
    assert.equal((await fetch(`${bridge.base}/health`, { headers: { Authorization: 'Bearer key-for-nobody-0123456789' } })).status, 401);
    assert.equal((await fetch(`${bridge.base}/health`)).status, 401);
  });
});

describe('AC-B2.9 a site key two routes share names no trip, so /health refuses it', () => {
  let dir, bridge, site;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    site = await startSite('Twin');
    writeRoute(dir, 'twin-a', { api_base_url: site.url, trip_api_key: 'one-key-held-by-two-routes-0123' });
    writeRoute(dir, 'twin-b', { api_base_url: site.url, trip_api_key: 'one-key-held-by-two-routes-0123' });
    bridge = await startShared(dir);
  });
  after(async () => { await bridge.stop(); await site.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('401, and the site is never asked', async () => {
    const r = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'one-key-held-by-two-routes-0123' } });
    assert.equal(r.status, 401);
    assert.deepEqual(site.seen, []);
  });
});

describe('AC-B2.9 a bridge bound beyond loopback still says nothing without a key', () => {
  let dir, bridge, site;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    site = await startSite('Beyond');
    writeRoute(dir, 'beyond', { api_base_url: site.url });
    bridge = await startShared(dir, { MCP_BIND_HOST: '0.0.0.0' });
  });
  after(async () => { await bridge.stop(); await site.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('/ready is exactly { ok: true } on a non-loopback address, and every other route wants a key', async () => {
    const other = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    const base = other ? `http://${other.address}:${bridge.port}` : bridge.base;
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200);
    assert.equal(await ready.text(), '{"ok":true}', 'the whole body: no count, no name, no version');
    for (const [method, p] of [['GET', '/health'], ['GET', '/sse'], ['POST', '/extract'], ['POST', '/enrich'], ['POST', '/messages?sessionId=x']]) {
      const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.ok([401, 404].includes(r.status), `${method} ${p} without a key answers ${r.status}`);
    }
    assert.deepEqual(site.seen, [], 'nothing reached a trip site without a key');
  });
});

describe('single-trip mode is unchanged', () => {
  let bridge;
  before(async () => { bridge = await startBridge({ MCP_API_KEY: 'single-agent-key-0123', API_BASE_URL: 'http://127.0.0.1:1' }); });
  after(() => bridge.stop());
  test('has no /ready route and binds as before', async () => {
    assert.equal((await fetch(`${bridge.base}/ready`)).status, 404);
    assert.match(bridge.log(), /listening on 0\.0\.0\.0:\d+/);
  });
  test('still refuses to start with no key', async () => {
    await assert.rejects(startBridge({}), /MCP_API_KEY is not set/);
  });
});

describe('AC-B1.7 one slow trip does not stall the rest', () => {
  let dir, bridge, slow, fast;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    slow = await startSite('Slow', { hang: true });
    fast = await startSite('Fast');
    writeRoute(dir, 'slow', { api_base_url: slow.url });
    writeRoute(dir, 'fast', { api_base_url: fast.url });
    bridge = await startShared(dir, { MCP_TRIP_TIMEOUT_MS: '400' });
  });
  after(async () => { await bridge.stop(); await slow.close(); await fast.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('a hanging trip site times out with a code and no address, while another trip answers at once', async () => {
    const s = await openSession(bridge.base, 'token-slow');
    const f = await openSession(bridge.base, 'token-fast');
    const t0 = Date.now();
    const slowCall = s.callTool('get_config');
    const fastRes = await f.callTool('get_config');
    assert.equal(brandOf(fastRes), 'Fast');
    assert.ok(Date.now() - t0 < 300, 'the fast trip waited on the slow one');
    const slowRes = await slowCall;
    const took = Date.now() - t0;
    assert.ok(took >= 350 && took < 3000, `timeout fired after ${took} ms`);
    assert.match(toolText(slowRes), /trip site request failed \(ETIMEDOUT\)/);
    assert.ok(!/127\.0\.0\.1|http:/.test(toolText(slowRes)), 'the tool error named an address');
    s.close(); f.close();
  });

  test('/health keeps its own 5 s signal (the default timeout is not applied over it)', async () => {
    const t0 = Date.now();
    const r = await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'token-slow' } });
    const took = Date.now() - t0;
    assert.equal(r.status, 503);
    assert.ok(took >= 4500, `health used the default timeout (${took} ms) instead of its own 5 s`);
  });
});

describe('AC-B1.7 extraction concurrency', () => {
  let dir, bridge, site, doc, tmp, this_log;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-'));
    dir = path.join(tmp, 'routes'); fs.mkdirSync(dir);
    const log = path.join(tmp, 'hermes.log');
    const bin = path.join(tmp, 'hermes');
    // Records start/end of each run, takes 400 ms, answers with a name.
    fs.writeFileSync(bin, `#!/bin/sh\necho "start $(date +%s%N)" >> "${log}"\nsleep 0.4\necho "end $(date +%s%N)" >> "${log}"\necho '{"name":"Booked thing"}'\n`, { mode: 0o755 });
    site = await startSite('Extractor');
    doc = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>a confirmation</html>'); });
    const dp = await freePort();
    await new Promise((r) => doc.listen(dp, '127.0.0.1', r));
    doc.url = `http://127.0.0.1:${dp}/`;
    writeRoute(dir, 'ex', { api_base_url: site.url });
    bridge = await startShared(dir, { HERMES_EXTRACT_PROFILE: 'p', HERMES_BIN: bin, MCP_EXTRACT_CONCURRENCY: '2' });
    this_log = log;
  });
  after(async () => { await bridge.stop(); await site.close(); await new Promise((r) => doc.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('five at once: all succeed, never more than 2 running, authenticated by the trip\'s own site key', async () => {
    const calls = Array.from({ length: 5 }, () => fetch(`${bridge.base}/extract`, {
      method: 'POST',
      headers: { 'X-API-Key': 'key-for-ex-0123456789', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: doc.url }),
    }));
    const rs = await Promise.all(calls);
    for (const r of rs) { assert.equal(r.status, 200, await r.text()); }
    const events = fs.readFileSync(this_log, 'utf8').trim().split('\n').map((l) => l.split(' '));
    assert.equal(events.filter((e) => e[0] === 'start').length, 5);
    let cur = 0, max = 0;
    for (const [kind] of events.sort((a, b) => (BigInt(a[1]) < BigInt(b[1]) ? -1 : BigInt(a[1]) > BigInt(b[1]) ? 1 : 0))) {
      cur += kind === 'start' ? 1 : -1; max = Math.max(max, cur);
    }
    assert.equal(max, 2, `concurrent extractions peaked at ${max}`);
    // The extraction read THIS trip's bookings with THIS trip's key — the queued
    // jobs started from other requests' async contexts, so this is the check
    // that the context is applied when a job starts, not when it was queued.
    assert.deepEqual(site.keys(), ['key-for-ex-0123456789']);
  });

  test('/extract and /enrich refuse an unknown key', async () => {
    for (const p of ['/extract', '/enrich']) {
      const r = await fetch(`${bridge.base}${p}`, { method: 'POST', headers: { 'X-API-Key': 'who', 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 401);
    }
  });
});

describe('AC-B1.8 bind address', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('shared mode defaults to loopback: not reachable on a non-loopback address', async () => {
    const bridge = await startShared(dir);
    try {
      assert.match(bridge.log(), /listening on 127\.0\.0\.1:\d+/);
      const other = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      if (other) {
        await assert.rejects(fetch(`http://${other.address}:${bridge.port}/ready`, { signal: AbortSignal.timeout(2000) }), 'reachable beyond loopback');
      }
    } finally { await bridge.stop(); }
  });

  test('MCP_BIND_HOST overrides it', async () => {
    const bridge = await startShared(dir, { MCP_BIND_HOST: '0.0.0.0' });
    try { assert.match(bridge.log(), /listening on 0\.0\.0\.0:\d+/); } finally { await bridge.stop(); }
  });
});

describe('AC-B1.9 nothing about a trip reaches the log', () => {
  let dir, bridge, site;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    site = await startSite('Logged');
    writeRoute(dir, 'logged', { api_base_url: site.url, public_url: 'http://127.0.0.1:2', trip_api_key: 'LOGKEY-should-never-appear-9' });
    writeRoute(dir, 'broken', { api_base_url: 'http://127.0.0.1:3', public_url: 'http://127.0.0.1:4', trip_api_key: 'BROKENKEY-never-appear-99' });
    bridge = await startShared(dir);
  });
  after(async () => { await bridge.stop(); await site.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('after traffic, failures and a revocation the log holds slugs and reasons only', async () => {
    const ok = await openSession(bridge.base, 'token-logged');
    await ok.callTool('get_config');
    const bad = await openSession(bridge.base, 'token-broken');
    const r = await bad.callTool('get_config');
    assert.match(toolText(r), /trip site request failed/);
    await fetch(`${bridge.base}/health`, { headers: { 'X-API-Key': 'token-wrong' } });
    fs.unlinkSync(path.join(dir, 'broken.json'));
    await bad.waitEnded(2500);
    ok.close();
    await sleep(100);

    const log = bridge.log();
    assert.match(log, /trip=broken/);
    assert.match(log, /route broken removed/);
    for (const secret of ['LOGKEY-should-never-appear-9', 'BROKENKEY-never-appear-99', 'token-logged', 'token-broken', 'token-wrong',
      sha256hex('token-logged'), sha256hex('token-broken'), `127.0.0.1:${site.port}`]) {
      assert.ok(!log.includes(secret), `the log carries ${secret.slice(0, 12)}…:\n${log}`);
    }
    // The routes' own addresses (ports 2-4; \b so the bridge's own listen port is not a hit).
    assert.ok(!/127\.0\.0\.1:[234]\b/.test(log), `a trip address reached the log:\n${log}`);
  });
});

// Boundary review 2026-11-26 (F1): the filePath tools read a file on the bridge's host and send it to the
// trip, where get_booking_confirmation hands it back. On a shared bridge MCP_ROUTES_DIR holds every trip's key,
// so a path is accepted only inside MCP_UPLOAD_ROOTS, and with none set, not at all.
describe('filePath tools read only inside MCP_UPLOAD_ROOTS', () => {
  let dir, inbound, outside, site, bridge, bare, s, sBare;
  const uploads = () => site.seen.filter((x) => x.url.startsWith('/api/photos/upload') || x.url.includes('/confirmation'));
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    inbound = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    site = await startSite('upload');
    writeRoute(dir, 'alpha', { api_base_url: site.url });
    fs.writeFileSync(path.join(inbound, 'ok.jpg'), 'jpeg-bytes');
    fs.writeFileSync(path.join(outside, 'secret.env'), 'TRIP_API_KEY=do-not-read');
    fs.symlinkSync(path.join(outside, 'secret.env'), path.join(inbound, 'link.jpg'));
    fs.writeFileSync(path.join(inbound, '..', path.basename(inbound) + '-sibling.jpg'), 'sibling');
    bridge = await startShared(dir, { MCP_UPLOAD_ROOTS: inbound });
    bare = await startShared(dir);
    s = await openSession(bridge.base, 'token-alpha');
    sBare = await openSession(bare.base, 'token-alpha');
  });
  after(async () => {
    s.close(); sBare.close(); await bridge.stop(); await bare.stop(); await site.close();
    for (const d of [dir, inbound, outside]) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(inbound + '-sibling.jpg', { force: true });
  });

  test('a file inside the root is uploaded', async () => {
    const before = uploads().length;
    const r = await s.callTool('add_photo', { filePath: path.join(inbound, 'ok.jpg') });
    assert.ok(!r.result?.isError, toolText(r));
    assert.equal(uploads().length, before + 1);
  });

  for (const [what, p] of [
    ['a file outside every root', () => path.join(outside, 'secret.env')],
    ['a symlink inside the root pointing out', () => path.join(inbound, 'link.jpg')],
    ['a path that climbs out with ..', () => path.join(inbound, '..', path.basename(outside), 'secret.env')],
    ['a sibling whose name only starts with the root', () => inbound + '-sibling.jpg'],
    ['a relative path', () => 'secret.env'],
    ['a file that does not exist', () => path.join(outside, 'nope.pdf')],
  ]) {
    test(`refused, with nothing sent to the trip: ${what}`, async () => {
      const before = uploads().length;
      for (const [tool, args] of [['add_photo', {}], ['upload_booking_confirmation', { id: 1 }], ['set_participant_avatar', { username: 'a' }]]) {  // upload_trip_logo: off on this fake trip, it returns before any path

        const r = await s.callTool(tool, { ...args, filePath: p() });
        const text = JSON.stringify(r);
        assert.ok(r.result?.isError || r.error, `${tool} accepted ${what}: ${text}`);
        assert.ok(!text.includes('do-not-read'), `${tool} leaked the file`);
      }
      assert.equal(uploads().length, before, `${what} reached the trip site`);
    });
  }

  test('the refusal is the same whether or not the file exists', async () => {
    const a = toolText(await s.callTool('add_photo', { filePath: path.join(outside, 'secret.env') }));
    const b = toolText(await s.callTool('add_photo', { filePath: path.join(outside, 'nope.png') }));
    assert.equal(a, b);
  });

  test('a shared bridge with no MCP_UPLOAD_ROOTS accepts no path at all', async () => {
    const before = uploads().length;
    const r = await sBare.callTool('add_photo', { filePath: path.join(inbound, 'ok.jpg') });
    assert.ok(r.result?.isError || r.error, JSON.stringify(r));
    assert.equal(uploads().length, before);
  });
});
