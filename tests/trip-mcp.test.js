/**
 * The trip site's own MCP endpoint (server/trip-mcp): an organizer connects
 * Claude or ChatGPT with one URL and their site login.
 *
 * Walks the path those clients take — discovery, dynamic registration,
 * authorize with consent, PKCE code exchange, MCP calls, refresh, revoke — and
 * the refusals that make it safe to publish: off by default, members cannot
 * consent, codes and refresh tokens are single-use, a site session is not an
 * MCP token and an MCP token is not a site session, and the assistant acts as
 * the organizer rather than as the agent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startTestServer, stopTestServer, loginAsAlice, api, testTripDir } from './helpers/server.js';
import { PORTS } from './helpers/ports.js';
import { makeConfirmationPdf } from './connected-assistants/confirmation-fixtures.mjs';

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

describe('trip MCP — off unless the trip turns it on', () => {
  const base = `http://localhost:${PORTS.tripMcpDisabled}`;
  before(() => startTestServer({ PORT: String(PORTS.tripMcpDisabled) }));
  after(() => stopTestServer());

  it('serves no discovery, registration or MCP endpoint', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/oauth/authorize']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) })).status, 404);
  });

  it('tells the organizer UI it is off', async () => {
    const token = await loginAsAlice();
    const r = await api('/api/mcp/connection', { token });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { enabled: false });
  });
});

describe('trip MCP — an organizer connects an assistant', () => {
  const port = PORTS.tripMcpEnabled;
  const base = `http://localhost:${port}`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let aliceSession, bobSession, client, tokens;

  const json = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const tokenRequest = params => fetch(base + '/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  });
  const authParams = (extra = {}) => ({
    client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', resource: `${base}/mcp`, ...extra,
  });
  // The consent page's fetch() always carries Origin; the endpoint requires this trip's own.
  const decide = (session, extra = {}, headers = { origin: base }) => json('/oauth/authorize/decision', { ...authParams(), decision: 'allow', ...extra }, { ...headers, ...(session ? { authorization: `Bearer ${session}` } : {}) });
  let rpcId = 0;
  const rpc = (accessToken, method, params = {}) => fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  async function connect(session = aliceSession) {
    const d = await decide(session);
    assert.equal(d.status, 200);
    const code = new URL((await d.json()).redirect_to).searchParams.get('code');
    const t = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK });
    assert.equal(t.status, 200);
    return t.json();
  }

  before(async () => {
    await startTestServer({ PORT: String(port), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: base });
    aliceSession = await loginAsAlice();
    bobSession = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
  });
  after(() => stopTestServer());

  it('an unauthenticated MCP call points the client at the sign-in metadata', async () => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
  });

  it('explains itself to a person who opens the address in a browser', async () => {
    for (const path of ['/mcp', '/modern/mcp']) {
      const r = await fetch(base + path, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
      assert.equal(r.status, 200, path);
      const html = await r.text();
      assert.match(html, /Claude/);
      assert.ok(html.includes(`${base}/mcp`), path);
      assert.doesNotMatch(html, /Test Trip 2027/, 'no trip data before sign-in');
    }
    assert.equal((await fetch(base + '/mcp', { headers: { accept: 'application/json' } })).status, 405, 'a client still gets the protocol answer');
  });

  it('publishes resource and authorization-server metadata for this trip', async () => {
    const pr = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(pr.resource, `${base}/mcp`);
    assert.deepEqual(pr.authorization_servers, [base]);
    assert.equal(pr.resource_name, undefined, 'no trip config value is served unauthenticated');
    const as = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(as.issuer, base);
    assert.equal(as.registration_endpoint, `${base}/oauth/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  });

  it('refuses to register a client whose callback is not a known assistant or loopback', async () => {
    for (const uri of ['https://evil.example/cb', 'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.example/cb', 'javascript:alert(1)',
      // Exact callbacks, not whole hosts: another path or port on a trusted host is not the assistant's callback.
      'https://claude.ai/somewhere-else', 'https://claude.ai:8443/api/mcp/auth_callback', 'http://2130706433/cb', 'https://claude.ai/api/mcp/auth_callback#x']) {
      const r = await json('/oauth/register', { redirect_uris: [uri], token_endpoint_auth_method: 'none' });
      assert.equal(r.status, 400, uri);
    }
  });

  it('registers Claude\'s callback as a public client', async () => {
    const r = await json('/oauth/register', { client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    assert.equal(r.status, 201);
    client = await r.json();
    assert.match(client.client_id, /^mcp_/);
    assert.equal(client.client_secret, undefined);
  });

  it('shows a consent page that cannot be framed, and never redirects for an unknown client', async () => {
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authParams())}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await page.text();
    assert.match(html, /claude\.ai/);
    assert.doesNotMatch(html, /Test Trip 2027/, 'the trip\'s name is not shown before sign-in');

    const unknown = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authParams({ client_id: 'mcp_nope' }))}`, { redirect: 'manual' });
    assert.equal(unknown.status, 400);
    const otherCallback = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authParams({ redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect' }))}`, { redirect: 'manual' });
    assert.equal(otherCallback.status, 400, 'a callback the client did not register is never used');
    const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authParams({ code_challenge: '' }))}`, { redirect: 'manual' });
    assert.equal(noPkce.status, 302);
    assert.equal(new URL(noPkce.headers.get('location')).searchParams.get('error'), 'invalid_request');
  });

  it('anyone on the trip can consent; nobody else can', async () => {
    assert.equal((await decide(null)).status, 401);
    assert.equal((await decide('not-a-jwt')).status, 401);
    // A validly signed session for someone who is not on this trip.
    const { createRequire } = await import('node:module');
    const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
    const outsider = jwt.sign({ username: 'zed' }, 'test-secret-000', { expiresIn: 60 });
    assert.equal((await decide(outsider)).status, 403);
    assert.equal((await decide(bobSession)).status, 200, 'a member may connect (read only)');
  });

  it('a denial goes back to the assistant as access_denied', async () => {
    const r = await decide(aliceSession, { decision: 'deny' });
    const back = new URL((await r.json()).redirect_to);
    assert.equal(back.origin + back.pathname, CLAUDE_CALLBACK);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'st-123');
  });

  it('exchanges a code once, and only with the right PKCE verifier', async () => {
    const d = await decide(aliceSession);
    const back = new URL((await d.json()).redirect_to);
    assert.equal(back.searchParams.get('state'), 'st-123');
    assert.equal(back.searchParams.get('iss'), base);
    const code = back.searchParams.get('code');

    const wrong = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: randomBytes(32).toString('base64url'), client_id: client.client_id });
    assert.equal(wrong.status, 400);
    // A failed attempt spends the code, so a guessed verifier gets one try.
    const after = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    assert.equal(after.status, 400);

    tokens = await connect();
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.access_token && tokens.refresh_token);
  });

  it('a code presented twice ends the connection it produced', async () => {
    const d = await decide(aliceSession);
    const code = new URL((await d.json()).redirect_to).searchParams.get('code');
    const params = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id };
    const first = await (await tokenRequest(params)).json();
    assert.equal((await rpc(first.access_token, 'tools/list')).status, 200);
    assert.equal((await tokenRequest(params)).status, 400);
    assert.equal((await rpc(first.access_token, 'tools/list')).status, 401);
  });

  it('an MCP token is not a website session, and a website session is not an MCP token', async () => {
    assert.equal((await api('/api/config', { token: tokens.access_token })).status, 401);
    assert.equal((await rpc(aliceSession, 'tools/list')).status, 401);
  });

  it('speaks MCP: instructions for this trip, and the organizer tool set', async () => {
    const init = await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.status, 200);
    const { result } = await init.json();
    assert.match(result.instructions, /Test Trip 2027/);
    assert.match(result.instructions, /get_trip_briefing/);

    const list = await (await rpc(tokens.access_token, 'tools/list')).json();
    const names = list.result.tools.map(t => t.name);
    for (const n of ['get_trip_briefing', 'get_bookings', 'add_booking', 'get_phase_plan', 'swap_plan_days', 'add_participant']) assert.ok(names.includes(n), n);
    for (const n of ['reset_participant_password', 'bind_participant_telegram', 'publish_companion_reply', 'add_photo']) assert.ok(!names.includes(n), n);
    const del = list.result.tools.find(t => t.name === 'delete_booking');
    assert.equal(del.annotations.destructiveHint, true);
  });

  it('offers a pending booking upload link only to an organizer with an existing booking', async () => {
    const created = await (await api('/api/bookings', { method: 'POST', token: aliceSession, body: {
      phase: 'intl_flights', type: 'flight', name: 'Synthetic flight',
    } })).json();
    assert.equal(created.ok, true);
    const call = await (await rpc(tokens.access_token, 'tools/call', {
      name: 'get_booking_confirmation_upload_link', arguments: { booking_id: created.id },
    })).json();
    assert.ok(!call.result.isError, JSON.stringify(call));
    const result = JSON.parse(call.result.content[0].text);
    assert.equal(result.status, 'pending_upload');
    assert.equal(result.booking_id, created.id);
    assert.equal(result.url, base + '/mcp/upload-confirmation/' + created.id);
    assert.doesNotMatch(JSON.stringify(result), /access_token|Bearer|test-hermes-key|trip-token|tripToken/);
    const missing = await (await rpc(tokens.access_token, 'tools/call', {
      name: 'get_booking_confirmation_upload_link', arguments: { booking_id: 999999 },
    })).json();
    assert.equal(missing.result.isError, true);
    const member = await connect(bobSession);
    const names = (await (await rpc(member.access_token, 'tools/list')).json()).result.tools.map(t => t.name);
    assert.ok(!names.includes('get_booking_confirmation_upload_link'));
    await fetch(base + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: member.refresh_token, client_id: client.client_id }).toString() });
  });

  it('the browser page checks session and booking, uploads a PDF, and verifies exact stored bytes', async () => {
    const created = await (await api('/api/bookings', { method: 'POST', token: aliceSession, body: {
      phase: 'intl_flights', type: 'flight', name: 'Synthetic document booking',
    } })).json();
    const page = await fetch(base + '/mcp/upload-confirmation/' + created.id);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await page.text();
    assert.doesNotMatch(html, new RegExp(aliceSession));
    const scriptStart = html.indexOf('<script nonce=');
    const script = html.slice(html.indexOf('>', scriptStart) + 1, html.indexOf('</script>', scriptStart));
    assert.ok(script, 'the actual browser script is served');

    async function browser(session, bookingId = created.id, intercept = () => null) {
      const elements = Object.fromEntries(['status', 'file', 'submit', 'upload-form', 'booking-name'].map(id => [id, {
        textContent: '', disabled: true, files: [], addEventListener(event, fn) { this[event] = fn; },
      }]));
      const requests = [];
      const context = {
        document: { documentElement: { dataset: { bookingId: String(bookingId) } }, getElementById: id => elements[id] },
        localStorage: { getItem: () => session },
        fetch: (path, options = {}) => { requests.push({ path, method: options.method || 'GET' }); return intercept(path, options) || fetch(new URL(path, base), options); },
        FormData, Uint8Array, Promise,
      };
      await runInNewContext(script, context);
      return { elements, requests };
    }
    const confDir = join(dirname(testTripDir()), 'confirmations');
    const fileCount = () => readdirSync(confDir).length;
    const initialFiles = fileCount();
    const noSession = await browser(null);
    assert.equal(noSession.elements.submit.disabled, true);
    assert.equal(noSession.requests.length, 0);
    const member = await browser(bobSession);
    assert.equal(member.elements.submit.disabled, true);
    assert.ok(!member.requests.some(r => r.method === 'POST'));
    const missing = await browser(aliceSession, 999999);
    assert.equal(missing.elements.submit.disabled, true);
    assert.ok(!missing.requests.some(r => r.method === 'POST'));

    const before = (await (await api('/api/bookings', { token: aliceSession })).json()).find(b => b.id === created.id);
    assert.equal(before.conf_file, null, 'denial and absent booking created no file link');
    assert.equal(fileCount(), initialFiles, 'denied page states wrote no file');
    const rejected = await browser(aliceSession);
    rejected.elements.file.files = [{ type: 'application/pdf', size: 50 * 1024 * 1024 + 1 }];
    await rejected.elements['upload-form'].submit({ preventDefault() {} });
    assert.match(rejected.elements.status.textContent, /smaller than 50 MB/);
    assert.ok(!rejected.requests.some(r => r.method === 'POST'));
    const failedPost = await browser(aliceSession, created.id, (path, options) =>
      options.method === 'POST' ? Promise.resolve(new Response('failed', { status: 503 })) : null);
    const failureFile = new Blob([makeConfirmationPdf('Panel Test', 'FAILED-POST')], { type: 'application/pdf' });
    failureFile.name = 'failed.pdf';
    failedPost.elements.file.files = [failureFile];
    await failedPost.elements['upload-form'].submit({ preventDefault() {} });
    assert.match(failedPost.elements.status.textContent, /Upload failed \(503\)/);
    assert.equal((await (await api('/api/bookings', { token: aliceSession })).json()).find(b => b.id === created.id).conf_file, null);
    assert.equal(fileCount(), initialFiles, 'failed POST wrote no file');

    const working = await browser(aliceSession);
    assert.equal(working.elements.submit.disabled, false);
    const pdf = makeConfirmationPdf('Panel Test', 'PANEL-01');
    const file = new Blob([pdf], { type: 'application/pdf' });
    file.name = 'synthetic.pdf';
    working.elements.file.files = [file];
    await working.elements['upload-form'].submit({ preventDefault() {} });
    assert.match(working.elements.status.textContent, /PDF uploaded, linked/);
    const booking = (await (await api('/api/bookings', { token: aliceSession })).json()).find(b => b.id === created.id);
    assert.ok(booking.conf_file);
    const original = await api('/api/bookings/confirmation/' + encodeURIComponent(booking.conf_file), { token: aliceSession });
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), pdf);
    assert.ok(working.requests.some(r => r.method === 'POST'));

    const revised = makeConfirmationPdf('Panel Test', 'PANEL-02');
    const replacement = new Blob([revised], { type: 'application/pdf' });
    replacement.name = 'replacement.pdf';
    const verifyFailure = await browser(aliceSession, created.id, path =>
      path.startsWith('/api/bookings/confirmation/') ? Promise.resolve(new Response('missing', { status: 404 })) : null);
    verifyFailure.elements.file.files = [replacement];
    await verifyFailure.elements['upload-form'].submit({ preventDefault() {} });
    assert.match(verifyFailure.elements.status.textContent, /Cannot read back/);
    assert.doesNotMatch(verifyFailure.elements.status.textContent, /PDF uploaded, linked/);
    const current = (await (await api('/api/bookings', { token: aliceSession })).json()).find(b => b.id === created.id);
    assert.notEqual(current.conf_file, booking.conf_file);
    const prior = await api('/api/bookings/confirmation/' + encodeURIComponent(booking.conf_file), { token: aliceSession });
    assert.deepEqual(Buffer.from(await prior.arrayBuffer()), pdf, 'replacing a PDF preserves the prior original');
    const storedReplacement = await api('/api/bookings/confirmation/' + encodeURIComponent(current.conf_file), { token: aliceSession });
    assert.deepEqual(Buffer.from(await storedReplacement.arrayBuffer()), revised);
  });

  it('retrieves only an organizer booking PDF as exact bytes with a digest', async () => {
    const own = await connect();
    const created = await (await api('/api/bookings', { method: 'POST', token: aliceSession, body: {
      phase: 'intl_flights', type: 'flight', name: 'Readback synthetic booking',
    } })).json();
    const call = async arguments_ => (await (await rpc(own.access_token, 'tools/call', {
      name: 'get_booking_confirmation', arguments: arguments_,
    })).json());
    const absent = await call({ booking_id: created.id });
    assert.equal(absent.result?.isError, true);
    assert.match(absent.result.content[0].text, /no linked confirmation/i);
    const pdf = makeConfirmationPdf('Readback Test', 'READBACK-01');
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'readback.pdf');
    const uploaded = await fetch(base + '/api/bookings/' + created.id + '/confirmation', {
      method: 'POST', headers: { authorization: `Bearer ${aliceSession}` }, body: form,
    });
    assert.equal(uploaded.status, 200);
    const r = await call({ booking_id: created.id });
    assert.ok(!r.result?.isError, JSON.stringify(r));
    const resource = r.result.content.find(c => c.type === 'resource').resource;
    assert.equal(resource.mimeType, 'application/pdf');
    assert.deepEqual(Buffer.from(resource.blob, 'base64'), pdf);
    assert.deepEqual(JSON.parse(r.result.content.find(c => c.type === 'text').text), {
      booking_id: created.id, byte_count: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'),
    });
    assert.doesNotMatch(JSON.stringify(r), /Bearer |test-secret|trip-test-/);
    for (const args of [{ booking_id: 999999 }, { booking_id: 0 }, { booking_id: 1.5 },
      { booking_id: Number.MAX_SAFE_INTEGER + 1 }, { booking_id: '../private-guide.docx' },
      { booking_id: created.id, url: 'https://evil.example/file.pdf' }, { booking_id: created.id, path: '../file.pdf' }]) {
      const denied = await call(args);
      assert.ok(denied.error || denied.result?.isError, JSON.stringify(args));
    }
    const Database = (await import('node:module')).createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
    const db = new Database(join(dirname(testTripDir()), 'trip.db'));
    const original = db.prepare('SELECT conf_file FROM bookings WHERE id = ?').get(created.id).conf_file;
    const safeLegacyName = 'אישור הזמנה מקורי.pdf';
    writeFileSync(join(dirname(testTripDir()), 'confirmations', safeLegacyName), pdf);
    db.prepare('UPDATE bookings SET conf_file = ? WHERE id = ?').run(safeLegacyName, created.id);
    const legacy = await call({ booking_id: created.id });
    assert.ok(!legacy.result?.isError, JSON.stringify(legacy));
    const legacyResource = legacy.result.content.find(c => c.type === 'resource').resource;
    assert.deepEqual(Buffer.from(legacyResource.blob, 'base64'), pdf);
    assert.deepEqual(JSON.parse(legacy.result.content.find(c => c.type === 'text').text), {
      booking_id: created.id, byte_count: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'),
    });
    for (const [file, expected] of [['../private-guide.docx', /unsafe/i], ['missing.pdf', /unavailable/i], ['private-guide.docx', /PDF/i]]) {
      if (file === 'private-guide.docx') writeFileSync(join(dirname(testTripDir()), 'confirmations', file), 'unsupported');
      db.prepare('UPDATE bookings SET conf_file = ? WHERE id = ?').run(file, created.id);
      const denied = await call({ booking_id: created.id });
      assert.equal(denied.result?.isError, true);
      assert.match(denied.result.content[0].text, expected);
    }
    db.prepare('UPDATE bookings SET conf_file = ? WHERE id = ?').run(original, created.id);
    db.close();
    const member = await connect(bobSession);
    const names = (await (await rpc(member.access_token, 'tools/list')).json()).result.tools.map(t => t.name);
    assert.ok(!names.includes('get_booking_confirmation'));
    const denied = await (await rpc(member.access_token, 'tools/call', { name: 'get_booking_confirmation', arguments: { booking_id: created.id } })).json();
    assert.ok(denied.error || denied.result?.isError);
    await fetch(base + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: member.access_token, client_id: client.client_id }) });
    await fetch(base + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: own.access_token, client_id: client.client_id }) });
    assert.equal((await rpc(own.access_token, 'tools/call', { name: 'get_booking_confirmation', arguments: { booking_id: created.id } })).status, 401);
  });

  it('acts as the organizer, not as the agent', async () => {
    const call = await (await rpc(tokens.access_token, 'tools/call', {
      name: 'add_budget_item', arguments: { phase: 'general', category: 'food', description: 'MCP test dinner', amount: 42 },
    })).json();
    assert.ok(!call.result.isError, JSON.stringify(call));
    assert.match(JSON.stringify(await (await api('/api/budget', { token: aliceSession })).json()), /MCP test dinner/);

    // A comment records its author: it must be alice, never the agent account.
    const comment = await (await rpc(tokens.access_token, 'tools/call', {
      name: 'post_venue_comment', arguments: { venueId: 'mcp-test-venue', body: 'Booked for 7pm' },
    })).json();
    assert.ok(!comment.result.isError, JSON.stringify(comment));
    const posted = JSON.parse(comment.result.content[0].text);
    assert.equal(posted.username, 'alice');

    // The briefing carries the organizer-only view the agent key would get.
    const brief = await (await rpc(tokens.access_token, 'tools/call', { name: 'get_trip_briefing', arguments: {} })).json();
    assert.ok(!brief.result.isError, JSON.stringify(brief));
    assert.match(brief.result.content[0].text, /standing_instructions/);
  });

  // Issue #173: budget_items has no owner column and PATCH/DELETE were gated
  // by authRequired alone — any authenticated member, not just the organizer,
  // could rewrite or erase ANY other member's (including the organizer's)
  // budget line. Owner decision 2026-09-25: row ownership (option b) — a
  // member may only touch their own line; the organizer and the agent key may
  // touch any line; a line with no recorded creator (seeded, or agent-authored
  // with nobody named) is organizer/agent-only.
  it('a plain member cannot rewrite or erase another member\'s budget line, including the organizer\'s', async () => {
    const created = await (await api('/api/budget', {
      method: 'POST', token: aliceSession, body: { phase: 'general', category: 'lodging', description: 'alice line', amount: 10 },
    })).json();
    assert.ok(created.ok, JSON.stringify(created));

    const patch = await api(`/api/budget/${created.id}`, { method: 'PATCH', token: bobSession, body: { description: 'bob was here' } });
    assert.equal(patch.status, 403, JSON.stringify(await patch.json()));

    const stillAlices = await (await api('/api/budget', { token: aliceSession })).json();
    assert.equal(stillAlices.find(r => r.id === created.id).description, 'alice line', 'bob\'s PATCH must not have changed the row');

    const del = await api(`/api/budget/${created.id}`, { method: 'DELETE', token: bobSession });
    assert.equal(del.status, 403, JSON.stringify(await del.json()));

    const stillThere = await (await api('/api/budget', { token: aliceSession })).json();
    assert.ok(stillThere.some(r => r.id === created.id), 'bob\'s DELETE must not have removed the row');
  });

  it('a member may edit and delete their OWN budget line', async () => {
    const created = await (await api('/api/budget', {
      method: 'POST', token: bobSession, body: { phase: 'general', category: 'food', description: 'bob\'s own line', amount: 5 },
    })).json();
    assert.ok(created.ok, JSON.stringify(created));

    const patch = await api(`/api/budget/${created.id}`, { method: 'PATCH', token: bobSession, body: { description: 'bob updated it' } });
    assert.equal(patch.status, 200, JSON.stringify(await patch.json()));
    const rows = await (await api('/api/budget', { token: aliceSession })).json();
    assert.equal(rows.find(r => r.id === created.id).description, 'bob updated it');

    const del = await api(`/api/budget/${created.id}`, { method: 'DELETE', token: bobSession });
    assert.equal(del.status, 200, JSON.stringify(await del.json()));
    const after = await (await api('/api/budget', { token: aliceSession })).json();
    assert.ok(!after.some(r => r.id === created.id), 'bob\'s own DELETE must succeed');
  });

  it('the organizer may edit and delete ANY member\'s budget line', async () => {
    const created = await (await api('/api/budget', {
      method: 'POST', token: bobSession, body: { phase: 'general', category: 'food', description: 'bob line for organizer', amount: 7 },
    })).json();
    assert.ok(created.ok, JSON.stringify(created));

    const patch = await api(`/api/budget/${created.id}`, { method: 'PATCH', token: aliceSession, body: { description: 'organizer corrected it' } });
    assert.equal(patch.status, 200, JSON.stringify(await patch.json()));

    const del = await api(`/api/budget/${created.id}`, { method: 'DELETE', token: aliceSession });
    assert.equal(del.status, 200, JSON.stringify(await del.json()));
  });

  it('the agent key may edit and delete ANY member\'s budget line', async () => {
    const created = await (await api('/api/budget', {
      method: 'POST', token: bobSession, body: { phase: 'general', category: 'food', description: 'bob line for agent', amount: 3 },
    })).json();
    assert.ok(created.ok, JSON.stringify(created));

    const patch = await api(`/api/budget/${created.id}`, { method: 'PATCH', apiKey: 'test-hermes-key', body: { description: 'agent corrected it' } });
    assert.equal(patch.status, 200, JSON.stringify(await patch.json()));

    const del = await api(`/api/budget/${created.id}`, { method: 'DELETE', apiKey: 'test-hermes-key' });
    assert.equal(del.status, 200, JSON.stringify(await del.json()));
  });

  it('a line with no recorded creator (seeded, or agent-authored with nobody named) is organizer/agent-only', async () => {
    // The agent key's own POST — mcp/mcp.js's add_budget_item never names a
    // requesting member today, so it lands with no creator, same as a seeded
    // row: a member cannot touch it, only the organizer or the agent key can.
    const created = await (await api('/api/budget', {
      method: 'POST', apiKey: 'test-hermes-key', body: { phase: 'general', category: 'food', description: 'agent-authored, nobody named', amount: 1 },
    })).json();
    assert.ok(created.ok, JSON.stringify(created));

    const memberPatch = await api(`/api/budget/${created.id}`, { method: 'PATCH', token: bobSession, body: { description: 'bob tries anyway' } });
    assert.equal(memberPatch.status, 403);

    const memberDelete = await api(`/api/budget/${created.id}`, { method: 'DELETE', token: bobSession });
    assert.equal(memberDelete.status, 403);

    const organizerPatch = await api(`/api/budget/${created.id}`, { method: 'PATCH', token: aliceSession, body: { description: 'organizer may still touch it' } });
    assert.equal(organizerPatch.status, 200);

    await api(`/api/budget/${created.id}`, { method: 'DELETE', apiKey: 'test-hermes-key' });
  });

  it('GET /api/budget stays trip-wide readable, and marks per-row whether THIS caller may edit it', async () => {
    const aliceOwned = await (await api('/api/budget', {
      method: 'POST', token: aliceSession, body: { phase: 'general', category: 'food', description: 'can_edit fixture: alice', amount: 1 },
    })).json();
    const bobOwned = await (await api('/api/budget', {
      method: 'POST', token: bobSession, body: { phase: 'general', category: 'food', description: 'can_edit fixture: bob', amount: 1 },
    })).json();

    // Every family member — organizer or not — can still read every line:
    // the fix is about who may WRITE a line, not who may see the budget.
    const asBob = await (await api('/api/budget', { token: bobSession })).json();
    assert.ok(asBob.some(r => r.id === aliceOwned.id), 'bob must still be able to read alice\'s line');
    assert.equal(asBob.find(r => r.id === aliceOwned.id).can_edit, false, 'bob may not edit alice\'s line');
    assert.equal(asBob.find(r => r.id === bobOwned.id).can_edit, true, 'bob may edit his own line');

    const asAlice = await (await api('/api/budget', { token: aliceSession })).json();
    assert.equal(asAlice.find(r => r.id === bobOwned.id).can_edit, true, 'the organizer may edit anyone\'s line');
  });

  it('a route\'s own refusal comes back as a tool error, not a crash', async () => {
    const r = await (await rpc(tokens.access_token, 'tools/call', { name: 'delete_booking', arguments: { id: 999999 } })).json();
    assert.equal(r.result.isError, true);
  });

  it('rotates refresh tokens, and a reused one ends the connection', async () => {
    const first = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json();
    assert.ok(first.access_token);
    assert.equal((await rpc(first.access_token, 'tools/list')).status, 200);
    assert.equal((await rpc(tokens.access_token, 'tools/list')).status, 401, 'a refresh ends the access token it replaced');
    const replay = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(replay.status, 400);
    assert.equal((await rpc(first.access_token, 'tools/list')).status, 401, 'reuse revokes the whole grant');
  });

  it('the organizer sees connected assistants and can disconnect one', async () => {
    tokens = await connect();
    const view = await (await api('/api/mcp/connection', { token: aliceSession })).json();
    assert.equal(view.enabled, true);
    assert.equal(view.url, `${base}/mcp`);
    const conn = view.connections.find(c => c.client === 'Claude');
    assert.ok(conn);
    assert.equal(conn.username, 'alice');
    const bobView = await (await api('/api/mcp/connection', { token: bobSession })).json();
    assert.equal(bobView.access, 'read');
    assert.ok(!bobView.connections.some(c => c.username === 'alice'), 'a member sees only their own connections');
    assert.equal((await api(`/api/mcp/connections/${conn.id}`, { method: 'DELETE', token: bobSession })).status, 404, 'nor can they end someone else\'s');

    const del = await api(`/api/mcp/connections/${conn.id}`, { method: 'DELETE', token: aliceSession });
    assert.equal(del.status, 200);
    assert.equal((await rpc(tokens.access_token, 'tools/list')).status, 401);
  });

  it('a member connects read-only: no write tools, no organizer briefing', async () => {
    const t = await connect(bobSession);
    assert.equal(t.scope, 'trip:read');
    const init = await (await rpc(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
    assert.match(init.result.instructions, /READ-ONLY/);
    const names = (await (await rpc(t.access_token, 'tools/list')).json()).result.tools.map(x => x.name);
    for (const n of ['get_config', 'get_today', 'get_bookings', 'get_phase_plan', 'get_budget', 'get_rsvps']) assert.ok(names.includes(n), n);
    for (const n of ['add_booking', 'delete_booking', 'add_plan_item', 'add_budget_item', 'post_venue_comment', 'add_participant', 'get_trip_briefing', 'publish_daily_message']) {
      assert.ok(!names.includes(n), `${n} must not be offered to a member`);
    }
    const call = await (await rpc(t.access_token, 'tools/call', { name: 'add_budget_item', arguments: { phase: 'general', category: 'x', description: 'nope', amount: 1 } })).json();
    assert.ok(call.error || call.result?.isError, 'calling a write tool anyway fails');
    assert.doesNotMatch(JSON.stringify(await (await api('/api/budget', { token: aliceSession })).json()), /nope/);

    // The member manages their own connection.
    const mine = (await (await api('/api/mcp/connection', { token: bobSession })).json()).connections;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].access, 'read');
    assert.equal((await api(`/api/mcp/connections/${mine[0].id}`, { method: 'DELETE', token: bobSession })).status, 200);
    assert.equal((await rpc(t.access_token, 'tools/list')).status, 401);
  });

  it('other people reach the assistant as a name, never a Telegram id, age or email', async () => {
    await api('/api/rsvps/mcp-rsvp', { method: 'POST', token: aliceSession, body: { status: 'yes' } });
    await api('/api/comments/venue/mcp-venue', { method: 'POST', token: aliceSession, body: { body: 'lovely' } });
    for (const session of [aliceSession, bobSession]) {
      const t = await connect(session);
      for (const [name, args] of [['get_rsvps', { activityId: 'mcp-rsvp' }], ['get_venue_comments', { venueId: 'mcp-venue' }]]) {
        const r = await (await rpc(t.access_token, 'tools/call', { name, arguments: args })).json();
        const rows = JSON.parse(r.result.content[0].text);
        assert.ok(rows.length, `${name} returned rows`);
        for (const row of rows) assert.deepEqual(Object.keys(row.user).sort().filter(k => !['username', 'name', 'name_en', 'color'].includes(k)), [], `${name}: ${JSON.stringify(row.user)}`);
      }
    }
  });

  it('the assistant can revoke its own connection', async () => {
    tokens = await connect();
    const r = await fetch(base + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh_token, client_id: client.client_id }).toString() });
    assert.equal(r.status, 200);
    assert.equal((await rpc(tokens.access_token, 'tools/list')).status, 401);
  });

  it('consent requires this trip\'s own Origin', async () => {
    assert.equal((await decide(aliceSession, {}, { origin: 'https://evil.example' })).status, 401);
    assert.equal((await decide(aliceSession, {}, {})).status, 401);
  });

  it('refuses anything that arrives through the managed gateway', async () => {
    // The gateway turns its cookie into an Authorization header on every path.
    const gw = { 'x-forwarded-prefix': '/t/trip_A' };
    assert.equal((await fetch(base + '/.well-known/oauth-protected-resource', { headers: gw })).status, 404);
    assert.equal((await decide(aliceSession, {}, { origin: base, ...gw })).status, 404);
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { ...gw, 'content-type': 'application/json' }, body: '{}' })).status, 404);
  });

  it('the agent key can neither see nor disconnect an organizer\'s assistant', async () => {
    const view = await api('/api/mcp/connection', { apiKey: 'test-hermes-key' });
    assert.equal(view.status, 403);
    assert.equal((await api('/api/mcp/connections/grant_anything', { method: 'DELETE', apiKey: 'test-hermes-key' })).status, 403);
  });

  it('adding a participant never hands the assistant a login link', async () => {
    tokens = await connect();
    const r = await (await rpc(tokens.access_token, 'tools/call', { name: 'add_participant', arguments: { username: 'mcpguest', name: 'Guest' } })).json();
    assert.ok(!r.result.isError, JSON.stringify(r));
    assert.doesNotMatch(r.result.content[0].text, /enrollment_token|#enroll=/);
    assert.match(r.result.content[0].text, /More → Signing in/);
  });

  it('only the client a token was issued to can revoke it, and a bad Basic header is a 401', async () => {
    tokens = await connect();
    const other = await (await json('/oauth/register', { client_name: 'Other', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' })).json();
    const r = await fetch(base + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.access_token, client_id: other.client_id }).toString() });
    assert.equal(r.status, 200);
    assert.equal((await rpc(tokens.access_token, 'tools/list')).status, 200, 'another client cannot end this connection');
    const bad = await fetch(base + '/oauth/token', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('%E0%A4%A:x').toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=x' });
    assert.equal(bad.status, 401);
  });

  it('a flood of registrations cannot lock organizers out or drop a live connection', async () => {
    tokens = await connect();
    // Behind the ingress every caller shares one address, so nothing here may
    // refuse by address; at the cap the oldest unused client is evicted.
    for (let i = 0; i < 205; i++) {
      assert.equal((await json('/oauth/register', { redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' })).status, 201);
    }
    const real = await json('/oauth/register', { client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' });
    assert.equal(real.status, 201);
    assert.equal((await rpc(tokens.access_token, 'tools/list')).status, 200, 'a connected assistant survives eviction');
  });
});

describe('trip MCP — upgrading a trip that ran an earlier version', () => {
  it('adds columns an earlier table lacks instead of failing at boot', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../server/package.json', import.meta.url));
    const Database = require('better-sqlite3');
    const { createOAuthStore } = require('./trip-mcp/oauth.js');
    const db = new Database(':memory:');
    // mcp_oauth_codes as the first version of this code created it.
    db.exec(`CREATE TABLE mcp_oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, username TEXT NOT NULL,
      redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL, used_at INTEGER)`);
    assert.doesNotThrow(() => createOAuthStore(db));
    assert.ok(db.prepare('PRAGMA table_info(mcp_oauth_codes)').all().some(c => c.name === 'grant_id'));
    db.close();
  });

  it('a connection\'s scope only ever narrows', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../server/package.json', import.meta.url));
    const Database = require('better-sqlite3');
    const { createOAuthStore } = require('./trip-mcp/oauth.js');
    const db = new Database(':memory:');
    const store = createOAuthStore(db);
    const { grantId, tokens } = store.startGrant({ clientId: 'c', username: 'alice', scope: 'trip' });
    assert.equal(tokens.scope, 'trip');
    store.narrowToRead(grantId);
    assert.equal(store.grant(grantId).scope, 'trip:read');
    assert.equal(store.verifyAccess(tokens.access_token).scope, 'trip:read');
    db.close();
  });
});

// The configuration a real trip runs: a public https origin. The other suites
// use a loopback origin, where the development-secret guard deliberately does
// not apply, so these are the only tests of the guards a live trip relies on.
describe('trip MCP — on a public origin', () => {
  const port = PORTS.tripMcpPublicOrigin;
  const base = `http://localhost:${port}`;
  after(() => stopTestServer());

  it('stays off on the built-in development JWT secret', async () => {
    await startTestServer({ PORT: String(port), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: 'https://trip.example.com', JWT_SECRET: 'trip-dev-secret-change-me' });
    assert.equal((await fetch(base + '/.well-known/oauth-authorization-server')).status, 404);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    stopTestServer();
  });

  it('comes on with a real secret, and publishes that origin as its issuer', async () => {
    await startTestServer({ PORT: String(port), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: 'https://trip.example.com' });
    const as = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(as.issuer, 'https://trip.example.com');
  });
});

describe('trip MCP — the site survives a missing MCP SDK', () => {
  const port = PORTS.tripMcpNoSdk;
  const base = `http://localhost:${port}`;
  before(() => startTestServer({
    PORT: String(port), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: base,
    NODE_OPTIONS: `--require ${new URL('./helpers/without-mcp-sdk.cjs', import.meta.url).pathname}`,
  }));
  after(() => stopTestServer());

  it('boots and serves members, with the connector simply absent', async () => {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    const token = await loginAsAlice();
    assert.equal((await api('/api/config', { token })).status, 200);
    assert.equal((await fetch(base + '/.well-known/oauth-authorization-server')).status, 404);
  });
});
