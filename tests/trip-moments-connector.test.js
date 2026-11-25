/**
 * trip-moments-connector.test.js — the trip connector's third tool class, "member writes the site already allows"
 * (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part A: AC-5 and AC-6; security path).
 *
 * Over the real running server, the way Claude or ChatGPT reach it: OAuth consent, a member's grant, tools/list and tools/call, and the
 * photo upload page's own script run against the real site.
 *
 *   - switch OFF (the default): every tool list is EXACTLY what it was before this change — nothing to see, nothing to call, no page.
 *   - switch ON: a member's list is today's list plus exactly the five class tools (not one more), an organizer's is today's plus the
 *     same five and publish_moment. Authorization is the site's: a member's edit or delete of someone else's moment is refused by
 *     the site (403) and the refusal comes back as the tool's error.
 *   - the upload page: one to twenty images attributed to the member, an optional caption that makes a draft moment linking them, and
 *     "Done" only after reading everything back; with no session it says to sign in and sends nothing.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { startTestServer, stopTestServer, stopTestServerKeepData, loginAsAlice, api, testTripDir } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
import { dirname, join } from 'node:path';
const { MEMBER_WRITE_TOOLS } = require('../server/trip-mcp/tools.js');
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const PIXEL = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

// The tool lists of the tree BEFORE this change (84960ea6, plus the two trip-logo organizer tools that landed on main in 3e24152c): the baseline the new lists are diffed against.
const TODAY_MEMBER = ['get_config', 'get_today', 'get_bookings', 'get_phase_plan', 'get_budget', 'get_rsvps', 'get_ratings', 'get_venue_comments', 'get_lost_found'];
const TODAY_ORGANIZER = ['get_trip_briefing', 'get_config', 'get_today', 'get_bookings', 'get_booking_confirmation', 'add_booking', 'update_booking', 'get_booking_confirmation_upload_link', 'get_trip_logo_upload_link', 'clear_trip_logo', 'delete_booking', 'get_phase_plan', 'add_plan_item', 'update_plan_item', 'delete_plan_item', 'swap_plan_days', 'set_plan_day_label', 'set_group_change_line', 'get_stops', 'update_stop', 'split_stop', 'set_stop_from_booking', 'move_plan_day', 'get_budget', 'add_budget_item', 'update_budget_item', 'delete_budget_item', 'get_rsvps', 'get_ratings', 'get_venue_comments', 'post_venue_comment', 'get_lost_found', 'resolve_lost_found', 'publish_daily_message', 'add_participant', 'remove_participant'];
const CLASS = ['add_moment', 'delete_moment', 'get_photo_upload_link', 'list_moments', 'update_moment'];
const sorted = (list) => [...list].sort();

function harness(base) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let client;
  let rpcId = 0;
  const json = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const authParams = () => ({ client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st', resource: `${base}/mcp` });
  return {
    get clientId() { return client.client_id; },
    async register() {
      const r = await json('/oauth/register', { client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
      assert.equal(r.status, 201);
      client = await r.json();
    },
    async connect(session) {
      const d = await json('/oauth/authorize/decision', { ...authParams(), decision: 'allow' }, { origin: base, authorization: `Bearer ${session}` });
      assert.equal(d.status, 200);
      const code = new URL((await d.json()).redirect_to).searchParams.get('code');
      const t = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK }).toString() });
      assert.equal(t.status, 200);
      return t.json();
    },
    rpc: (accessToken, method, params = {}) => fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
  };
}
const names = async (h, token) => (await (await h.rpc(token, 'tools/list')).json()).result.tools.map((t) => t.name);
const call = async (h, token, name, args) => (await (await h.rpc(token, 'tools/call', { name, arguments: args })).json());
const text = (answer) => answer.result?.content?.[0]?.text ?? JSON.stringify(answer.error ?? answer);

async function boot(features) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  await startTestServer({ PORT: String(port), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: base }, features ? { features } : {});
  const alice = await loginAsAlice();
  const bob = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
  const h = harness(base);
  await h.register();
  return { base, alice, bob, h, get clientId() { return h.clientId; } };
}

describe('switch OFF (the default): the connector is exactly what it was', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(() => stopTestServer());

  it('a member\'s tool list equals today\'s, an organizer\'s equals today\'s, and the moment tools are not callable', async () => {
    const member = await ctx.h.connect(ctx.bob);
    const organizer = await ctx.h.connect(ctx.alice);
    assert.equal(member.scope, 'trip:read', 'with the switch off a member\'s connection is the plain read scope');
    assert.equal(organizer.scope, 'trip', 'an organizer\'s scope is unchanged');
    assert.deepEqual(await names(ctx.h, member.access_token), TODAY_MEMBER);
    assert.deepEqual(await names(ctx.h, organizer.access_token), TODAY_ORGANIZER);
    const answer = await call(ctx.h, member.access_token, 'add_moment', { caption: 'nope' });
    assert.ok(answer.error || answer.result?.isError, 'calling a tool that is not listed fails');
    assert.deepEqual((await (await api('/api/moments', { token: ctx.bob })).json()), [], 'nothing was stored');
  });

  it('the member\'s instructions still say read-only and mention no moments; the upload page is not there', async () => {
    const member = await ctx.h.connect(ctx.bob);
    const init = await (await ctx.h.rpc(member.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
    assert.match(init.result.instructions, /READ-ONLY\./);
    assert.doesNotMatch(init.result.instructions, /moment/i);
    assert.equal((await fetch(ctx.base + '/mcp/upload-photos')).status, 404);
  });
});

describe('AC-5: switch ON — the member-write class, and only it', () => {
  let ctx, member, organizer;
  before(async () => {
    ctx = await boot({ trip_moments_capture: true });
    member = await ctx.h.connect(ctx.bob);
    organizer = await ctx.h.connect(ctx.alice);
  });
  after(() => stopTestServer());

  it('the class is the frozen list of five, and a member\'s tool list differs from today\'s by exactly those', async () => {
    assert.deepEqual(sorted(MEMBER_WRITE_TOOLS), CLASS);
    assert.ok(Object.isFrozen(MEMBER_WRITE_TOOLS));
    assert.equal(member.scope, 'trip:moments', 'F3: the class is its own scope, granted at consent time while the switch is on');
    assert.equal(organizer.scope, 'trip', 'an organizer\'s scope is unchanged');
    assert.deepEqual(sorted(await names(ctx.h, member.access_token)), sorted([...TODAY_MEMBER, ...CLASS]));
    for (const forbidden of ['publish_moment', 'add_booking', 'delete_booking', 'add_plan_item', 'add_budget_item', 'post_venue_comment', 'add_participant', 'get_trip_briefing', 'publish_daily_message', 'set_group_change_line']) {
      assert.ok(!(await names(ctx.h, member.access_token)).includes(forbidden), `${forbidden} must not be offered to a member`);
    }
  });

  it('F3: a trip:read connection made before keeps exactly today\'s nine tools (and cannot call the class) until its owner reconnects', async () => {
    const old = await ctx.h.connect(ctx.bob);
    const db = new Database(join(dirname(testTripDir()), 'trip.db'));
    try { assert.equal(db.prepare("UPDATE mcp_oauth_grants SET scope = 'trip:read' WHERE rowid = (SELECT MAX(rowid) FROM mcp_oauth_grants WHERE username = 'bob')").run().changes === 1, true); } finally { db.close(); }
    assert.deepEqual(await names(ctx.h, old.access_token), TODAY_MEMBER, 'exactly the nine, with the switch on');
    const answer = await call(ctx.h, old.access_token, 'add_moment', { caption: 'old grant' });
    assert.ok(answer.error || answer.result?.isError);
    assert.ok(!(await (await api('/api/moments', { token: ctx.bob })).json()).some((m) => m.caption === 'old grant'));
    const init = await (await ctx.h.rpc(old.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
    assert.doesNotMatch(init.result.instructions, /moment/i);
    // The refresh path does not widen it either.
    const refreshed = await (await fetch(ctx.base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old.refresh_token, client_id: ctx.clientId }).toString() })).json();
    assert.equal(refreshed.scope, 'trip:read');
    assert.deepEqual(await names(ctx.h, refreshed.access_token), TODAY_MEMBER);
    // A new approval does get it.
    assert.deepEqual(sorted(await names(ctx.h, (await ctx.h.connect(ctx.bob)).access_token)), sorted([...TODAY_MEMBER, ...CLASS]));
  });

  it('F3: /api/mcp/connection says which connections can add moments (a member\'s moments scope: read access, moments true)', async () => {
    const fresh = await ctx.h.connect(ctx.bob);
    const mine = (await (await api('/api/mcp/connection', { token: ctx.bob })).json()).connections;
    assert.ok(mine.length >= 2);
    assert.ok(mine.every((c) => c.access === 'read'), 'still read access: no site change but moments');
    assert.ok(mine.some((c) => c.moments === true), 'the fresh moments connection says so');
    assert.ok(mine.some((c) => c.moments === false), 'the downgraded trip:read connection does not');
    const org = (await (await api('/api/mcp/connection', { token: ctx.alice })).json()).connections.filter((c) => c.username === 'alice');
    assert.ok(org.every((c) => c.access === 'read_write'));
    await fetch(ctx.base + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: fresh.refresh_token, client_id: ctx.clientId }).toString() });
  });

  it('an organizer\'s list is today\'s plus the class plus publish_moment', async () => {
    assert.deepEqual(sorted(await names(ctx.h, organizer.access_token)), sorted([...TODAY_ORGANIZER, ...CLASS, 'publish_moment']));
  });

  it('the member\'s instructions say what they may do and still say read-only', async () => {
    const init = await (await ctx.h.rpc(member.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
    assert.match(init.result.instructions, /READ-ONLY, except for the trip's moments and photos/);
    assert.match(init.result.instructions, /cannot change anything else/);
    assert.match(init.result.instructions, /DRAFT that only that person and the organizers see until it is published/);
  });

  it('a member adds a moment (a draft, under their own name, source connector) and lists it', async () => {
    const made = JSON.parse(text(await call(ctx.h, member.access_token, 'add_moment', { caption: 'Pool day', body: 'Splash', photo_ids: ['x1', 'x2'] })));
    assert.equal(made.author, 'bob');
    assert.equal(made.visibility, 'draft');
    assert.equal(made.source, 'connector');
    assert.deepEqual(made.photo_ids, ['x1', 'x2']);
    const listed = JSON.parse(text(await call(ctx.h, member.access_token, 'list_moments', {})));
    assert.ok(listed.some((m) => m.id === made.id));
    // The member cannot choose the visibility or the author through the tool: they are not in its input.
    const tools = (await (await ctx.h.rpc(member.access_token, 'tools/list')).json()).result.tools;
    const add = tools.find((t) => t.name === 'add_moment');
    assert.deepEqual(Object.keys(add.inputSchema.properties).sort(), ['body', 'caption', 'date', 'phase_id', 'photo_ids']);
    assert.equal(tools.find((t) => t.name === 'update_moment').inputSchema.properties.visibility, undefined);
  });

  it('a member cannot slip visibility, author or source into the tools: the stored row is a draft by them from the connector', async () => {
    const made = JSON.parse(text(await call(ctx.h, member.access_token, 'add_moment', { caption: 'Sneaky', visibility: 'published', author: 'alice', source: 'chat' })));
    assert.equal(made.visibility, 'draft');
    assert.equal(made.author, 'bob');
    assert.equal(made.source, 'connector');
    const after = JSON.parse(text(await call(ctx.h, member.access_token, 'update_moment', { id: made.id, caption: 'Still sneaky', visibility: 'published', author: 'alice', source: 'chat' })));
    assert.equal(after.caption, 'Still sneaky');
    assert.equal(after.visibility, 'draft', 'update_moment does not publish');
    assert.equal(after.author, 'bob');
    assert.equal(after.source, 'connector');
    const stored = (await (await api('/api/moments', { token: ctx.bob })).json()).find((m) => m.id === made.id);
    assert.equal(stored.visibility, 'draft');
    assert.ok((await (await api('/api/moments', { token: ctx.alice })).json()).some((m) => m.id === made.id), 'the organizer can see the draft');
  });

  it('a member changes and deletes their own moment, and the site refuses another person\'s — the refusal reaches the assistant', async () => {
    const mine = JSON.parse(text(await call(ctx.h, member.access_token, 'add_moment', { caption: 'Bob\'s' })));
    const theirs = JSON.parse(text(await call(ctx.h, organizer.access_token, 'add_moment', { caption: 'Alice\'s' })));
    const upd = await call(ctx.h, member.access_token, 'update_moment', { id: mine.id, caption: 'Bob\'s, renamed', photo_ids: ['p9'] });
    assert.notEqual(upd.result.isError, true);
    assert.equal(JSON.parse(text(upd)).caption, 'Bob\'s, renamed');
    const refusedEdit = await call(ctx.h, member.access_token, 'update_moment', { id: theirs.id, caption: 'hijack' });
    assert.equal(refusedEdit.result.isError, true);
    assert.match(text(refusedEdit), /403/);
    assert.match(text(refusedEdit), /forbidden/);
    const refusedDelete = await call(ctx.h, member.access_token, 'delete_moment', { id: theirs.id });
    assert.equal(refusedDelete.result.isError, true);
    assert.match(text(refusedDelete), /403/);
    const still = (await (await api('/api/moments', { token: ctx.alice })).json()).find((m) => m.id === theirs.id);
    assert.equal(still.caption, 'Alice\'s', 'nothing of theirs changed');
    const gone = await call(ctx.h, member.access_token, 'delete_moment', { id: mine.id });
    assert.notEqual(gone.result.isError, true);
    assert.ok(!(await (await api('/api/moments', { token: ctx.bob })).json()).some((m) => m.id === mine.id));
  });

  it('an organizer publishes a member\'s moment; a member cannot publish (no tool), and what they cannot see stays unseen', async () => {
    const draft = JSON.parse(text(await call(ctx.h, member.access_token, 'add_moment', { caption: 'To publish' })));
    const notPublished = await call(ctx.h, member.access_token, 'publish_moment', { id: draft.id });
    assert.ok(notPublished.error || notPublished.result?.isError);
    assert.equal((await (await api('/api/moments', { token: ctx.alice })).json()).some((m) => m.id === draft.id && m.visibility === 'draft'), true, 'the organizer sees bob\'s draft, and can publish it by id');
    const orgList = JSON.parse(text(await call(ctx.h, organizer.access_token, 'list_moments', {})));
    assert.ok(orgList.some((m) => m.id === draft.id && m.visibility === 'draft'), 'the organizer\'s list_moments shows the member\'s draft');
    const aliceDraft = JSON.parse(text(await call(ctx.h, organizer.access_token, 'add_moment', { caption: 'Alice draft' })));
    const memberList = JSON.parse(text(await call(ctx.h, member.access_token, 'list_moments', {})));
    assert.ok(!memberList.some((m) => m.id === aliceDraft.id), 'a member\'s list_moments never shows another member\'s draft');
    const published = await call(ctx.h, organizer.access_token, 'publish_moment', { id: draft.id });
    assert.notEqual(published.result.isError, true);
    assert.equal(JSON.parse(text(published)).visibility, 'published');
    assert.ok((await (await api('/api/moments', { token: ctx.alice })).json()).some((m) => m.id === draft.id));
    const edited = await call(ctx.h, organizer.access_token, 'update_moment', { id: draft.id, body: 'organizer edit' });
    assert.notEqual(edited.result.isError, true);
  });

  it('get_photo_upload_link hands back a link with nothing in it but the page: no token, no id, no model text', async () => {
    const answer = await call(ctx.h, member.access_token, 'get_photo_upload_link', {});
    assert.deepEqual(JSON.parse(text(answer)), { status: 'pending_upload', url: `${ctx.base}/mcp/upload-photos` });
    assert.doesNotMatch(text(answer), /access_token|Bearer|test-hermes-key|trip-token|tripToken/);
  });
});

describe('AC-6: the photo upload page', () => {
  let ctx, script;
  before(async () => {
    ctx = await boot({ trip_moments_capture: true });
    const page = await fetch(ctx.base + '/mcp/upload-photos');
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const html = await page.text();
    assert.doesNotMatch(html, new RegExp(ctx.alice));
    assert.doesNotMatch(html, new RegExp(ctx.bob));
    const start = html.indexOf('<script nonce=');
    script = html.slice(html.indexOf('>', start) + 1, html.indexOf('</script>', start));
    assert.ok(script, 'the actual browser script is served');
  });
  after(() => stopTestServer());

  const image = (name, type = 'image/jpeg') => new File([PIXEL], name, { type });

  async function browser(session, { files = [], caption = '', intercept = () => null } = {}) {
    const el = (extra = {}) => ({ textContent: '', disabled: true, value: '', files: [], addEventListener(event, fn) { this[event] = fn; }, ...extra });
    const elements = { status: el(), files: el({ files }), caption: el({ value: caption }), submit: el(), 'upload-form': el() };
    const requests = [];
    const context = {
      document: { documentElement: { lang: 'en' }, getElementById: (id) => elements[id] },
      localStorage: { getItem: () => session },
      fetch: (path, options = {}) => { requests.push({ path, method: options.method || 'GET' }); return intercept(path, options) || fetch(new URL(path, ctx.base), options); },
      FormData, Uint8Array, Promise, Array, JSON, String,
    };
    await runInNewContext(script, context);
    return { elements, requests, submit: () => elements['upload-form'].submit({ preventDefault() {} }) };
  }
  const album = async (token = ctx.alice) => (await api('/api/photos', { token })).json();
  const moments = async () => (await api('/api/moments', { token: ctx.bob })).json();
  const posts = (b) => b.requests.filter((r) => r.method === 'POST');

  it('with no site session it says to sign in and sends nothing', async () => {
    const b = await browser(null);
    assert.match(b.elements.status.textContent, /Sign in to this trip site/);
    assert.equal(b.elements.submit.disabled, true);
    assert.equal(b.requests.length, 0);
  });

  it('a session the site does not accept is not let in', async () => {
    const b = await browser('not-a-session');
    assert.match(b.elements.status.textContent, /Sign in/);
    assert.equal(b.elements.submit.disabled, true);
    assert.deepEqual(posts(b), []);
  });

  it('any signed-in member passes, not only an organizer', async () => {
    const b = await browser(ctx.bob);
    assert.equal(b.elements.submit.disabled, false);
    assert.match(b.elements.status.textContent, /Nothing has been uploaded yet/);
  });

  it('nothing, more than 20, an empty file or a non-image is refused before any request', async () => {
    for (const files of [[], Array.from({ length: 21 }, (_, i) => image(`p${i}.jpg`)), [new File([], 'empty.jpg', { type: 'image/jpeg' })], [new File([PIXEL], 'a.pdf', { type: 'application/pdf' })]]) {
      const b = await browser(ctx.bob, { files });
      await b.submit();
      assert.match(b.elements.status.textContent, /between 1 and 20 photos/);
      assert.deepEqual(posts(b), []);
    }
    assert.ok(!(await album()).some((p) => p.originalName === 'p0.jpg'));
  });

  it('twenty photos are accepted by the page (the first request is made); the 20th is within the limit', async () => {
    const b = await browser(ctx.bob, { files: Array.from({ length: 20 }, (_, i) => image(`p${i}.jpg`)), intercept: (path, o) => (o.method === 'POST' ? Promise.resolve(new Response('no', { status: 503 })) : null) });
    await b.submit();
    assert.match(b.elements.status.textContent, /Upload failed \(503\)/);
    assert.equal(posts(b).length, 1, 'it stopped at the first failure; nothing after it was sent');
    assert.doesNotMatch(b.elements.status.textContent, /Done/);
  });

  it('photos only: uploaded one by one, attributed to the member, source connector, read back, then "Done"; no moment is made', async () => {
    const before = (await moments()).length;
    const b = await browser(ctx.bob, { files: [image('lake-1.jpg'), image('lake-2.jpg')] });
    await b.submit();
    assert.match(b.elements.status.textContent, /^Done: 2 photo\(s\) saved to the album and checked\./);
    const saved = (await album()).filter((p) => /^lake-[12]\.jpg$/.test(p.originalName));
    assert.equal(saved.length, 2);
    for (const p of saved) { assert.equal(p.username, 'bob'); assert.equal(p.source, 'connector'); }
    assert.equal((await moments()).length, before, 'no caption, no moment');
    assert.deepEqual(posts(b).map((r) => r.path), ['/api/photos/upload', '/api/photos/upload']);
    assert.ok(b.requests.some((r) => r.path === '/api/photos' && r.method === 'GET'), 'it read the album back before saying done');
  });

  it('with a caption it also makes one draft moment linking exactly those photos in order, and reads it back', async () => {
    const b = await browser(ctx.bob, { files: [image('hike-a.jpg'), image('hike-b.jpg'), image('hike-c.jpg')], caption: '  The long hike  ' });
    await b.submit();
    assert.match(b.elements.status.textContent, /^Done: 3 photo\(s\) saved to the album, and a draft moment/);
    const photos = (await album()).filter((p) => /^hike-[abc]\.jpg$/.test(p.originalName)).sort((x, y) => x.originalName.localeCompare(y.originalName));
    const moment = (await moments()).find((m) => m.caption === 'The long hike');
    assert.ok(moment, 'the moment exists');
    assert.deepEqual(moment.photo_ids, photos.map((p) => p.id));
    assert.equal(moment.author, 'bob');
    assert.equal(moment.visibility, 'draft');
    assert.equal(moment.source, 'connector');
    assert.ok((await (await api('/api/moments', { token: ctx.alice })).json()).some((m) => m.id === moment.id), 'the organizer sees the draft');
  });

  it('it does not say "Done" when the album cannot be read back', async () => {
    const b = await browser(ctx.bob, { files: [image('ghost.jpg')], intercept: (path, o) => (path === '/api/photos' && !o.method ? Promise.resolve(new Response('[]', { status: 200 })) : null) });
    await b.submit();
    assert.doesNotMatch(b.elements.status.textContent, /Done/);
    assert.match(b.elements.status.textContent, /could not be read back/);
  });

  it('it does not say "Done" when the stored photo is not the one chosen, and it makes no moment', async () => {
    const before = (await moments()).length;
    const b = await browser(ctx.bob, { files: [image('swap.jpg')], caption: 'Should not exist', intercept: (path) => (/^\/api\/photos\/file\//.test(path) ? Promise.resolve(new Response(Buffer.from('different'), { status: 200, headers: { 'content-type': 'image/jpeg' } })) : null) });
    await b.submit();
    assert.doesNotMatch(b.elements.status.textContent, /Done/);
    assert.match(b.elements.status.textContent, /differs/);
    assert.equal((await moments()).length, before);
  });

  it('a moment the site refuses is reported, with the photos still saved, and is not "Done"', async () => {
    const b = await browser(ctx.bob, { files: [image('kept.jpg')], caption: 'Refused', intercept: (path, o) => (path === '/api/moments' && o.method === 'POST' ? Promise.resolve(new Response('no', { status: 400 })) : null) });
    await b.submit();
    assert.match(b.elements.status.textContent, /photos are saved, but the moment could not be created \(400\)/);
    assert.doesNotMatch(b.elements.status.textContent, /Done/);
  });
});

describe('F3: the consent page names exactly what a member\'s connection will be able to do', () => {
  // Runs the page's real script against a real site. `intercept(path, options)` may answer a request itself (to break one);
  // `click('allow')` calls the handler the page attached to a button. Returns what the page showed and what it did.
  async function consent(features, session, { intercept = () => null, press = false } = {}) {
    const ctx = await boot(features);
    try {
      const authParams = new URLSearchParams({ client_id: ctx.h.clientId, redirect_uri: CLAUDE_CALLBACK, response_type: 'code', code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', state: 's', resource: `${ctx.base}/mcp` });
      const html = await (await fetch(`${ctx.base}/oauth/authorize?${authParams}`)).text();
      const start = html.indexOf('<script nonce=');
      const script = html.slice(html.indexOf('>', start) + 1, html.indexOf('</script>', start));
      const handlers = {};
      const el = (id) => ({ textContent: '', hidden: false, disabled: false, value: '', addEventListener(e, f) { handlers[`${id}:${e}`] = f; }, appendChild() {} });
      const elements = {};
      const get = (id) => (elements[id] ||= el(id));
      const token = session === 'alice' ? ctx.alice : ctx.bob;
      const requests = [];
      let redirected = null;
      const context = {
        document: { documentElement: { lang: 'en' }, getElementById: get, head: { appendChild() {} }, createElement: () => el('x') },
        window: { location: { replace(u) { redirected = u; } } }, localStorage: { getItem: () => token },
        fetch: (path, options = {}) => { requests.push(`${options.method || 'GET'} ${path}`); return intercept(path, options) || fetch(new URL(path, ctx.base), { ...options, headers: { ...(options.headers || {}), origin: ctx.base } }); }, // a browser always sends Origin on a POST
        JSON, Promise, String, Object, Array,
      };
      runInNewContext(script, context);
      for (let i = 0; i < 100 && !get('wants').textContent && !get('error').textContent; i++) await new Promise((r) => setTimeout(r, 20));
      if (press) { await handlers['allow:click'](); await new Promise((r) => setTimeout(r, 200)); }
      let granted = null;
      if (redirected) {
        const code = new URL(redirected).searchParams.get('code');
        const t = await (await fetch(`${ctx.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'v'.repeat(43), client_id: ctx.h.clientId, redirect_uri: CLAUDE_CALLBACK }).toString() })).json();
        granted = t.scope;
      }
      return { wants: get('wants').textContent, can: get('can').textContent, error: get('error').textContent, allowDisabled: get('allow').disabled, requests, granted };
    } finally { stopTestServer(); }
  }
  const failing = (needle) => (path) => (path.includes(needle) ? Promise.resolve(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })) : null);

  it('switch on, a member is told it can add moments and photos, cannot change the plan or publish the assistant\'s text', async () => {
    const { wants, can } = await consent({ trip_moments_capture: true }, 'bob');
    assert.match(wants, /add your trip moments and photos/);
    assert.match(can, /add trip moments and photos in your name/);
    assert.match(can, /cannot change the plan, bookings or budget/);
    assert.match(can, /cannot publish what the trip assistant wrote/);
  });

  it('switch off, a member is told it is read-only, exactly as before', async () => {
    const { wants, can } = await consent(undefined, 'bob');
    assert.equal(wants, 'wants to read this trip as you');
    assert.match(can, /but not change anything/);
    assert.doesNotMatch(can, /moment/i);
  });

  it('an organizer\'s consent text is the organizer\'s, switch on or off', async () => {
    const { wants, can } = await consent({ trip_moments_capture: true }, 'alice');
    assert.equal(wants, 'wants to manage this trip as you');
    assert.match(can, /change bookings, the plan, the budget and participants/);
  });

  it('R3: what is shown is what is granted — approving with the switch on records trip:moments, and the text said so', async () => {
    const r = await consent({ trip_moments_capture: true }, 'bob', { press: true });
    assert.match(r.can, /add trip moments and photos in your name/);
    assert.equal(r.granted, 'trip:moments');
    const off = await consent(undefined, 'bob', { press: true });
    assert.match(off.can, /but not change anything/);
    assert.equal(off.granted, 'trip:read');
  });

  it('R3: /api/config unreadable cannot make the page show read-only text while the server grants trip:moments (the text does not depend on it)', async () => {
    const r = await consent({ trip_moments_capture: true }, 'bob', { intercept: failing('/api/config'), press: true });
    assert.match(r.can, /add trip moments and photos in your name/, 'the text still comes from the server\'s own scope answer');
    assert.equal(r.granted, 'trip:moments', 'and what was shown is what was granted');
  });

  it('R3: if the page cannot learn the scope it shows nothing misleading, keeps Allow off, and sends no approval', async () => {
    const r = await consent({ trip_moments_capture: true }, 'bob', { intercept: failing('/oauth/authorize/scope'), press: true });
    assert.equal(r.can, '');
    assert.equal(r.allowDisabled, true);
    assert.ok(r.error, 'it says something went wrong');
    assert.ok(!r.requests.some((q) => q.includes('/oauth/authorize/decision')), 'no decision was sent');
    assert.equal(r.granted, null, 'nothing was granted');
  });

  it('R3: if the scope request REJECTS (a network error) the page catches it: no text, Allow off, the error shown, no decision sent', async () => {
    const r = await consent({ trip_moments_capture: true }, 'bob', { intercept: (path) => (path.includes('/oauth/authorize/scope') ? Promise.reject(new Error('network down')) : null), press: true });
    assert.equal(r.can, '');
    assert.equal(r.wants, '');
    assert.equal(r.allowDisabled, true);
    assert.ok(r.error);
    assert.ok(!r.requests.some((q) => q.includes('/oauth/authorize/decision')));
    assert.equal(r.granted, null);
  });

  it('R3: after a 409 whose re-read fails, the stale text is cleared and Allow is off', async () => {
    let scopeCalls = 0;
    const intercept = (path) => {
      if (path.includes('/oauth/authorize/decision')) return Promise.resolve(new Response('{"error":"consent_changed","scope":"trip:read"}', { status: 409, headers: { 'content-type': 'application/json' } }));
      if (path.includes('/oauth/authorize/scope') && ++scopeCalls > 1) return Promise.reject(new Error('network down'));
      return null;
    };
    const r = await consent({ trip_moments_capture: true }, 'bob', { intercept, press: true });
    assert.equal(scopeCalls, 2, 'it asked again after the 409');
    assert.equal(r.can, '', 'the old moments text is not left on the page');
    assert.equal(r.allowDisabled, true);
    assert.ok(r.error);
    assert.equal(r.granted, null);
  });

  it('R3: after a 409 whose re-read works, the page shows the new text and Allow is on again', async () => {
    let scopeCalls = 0;
    const intercept = (path) => {
      if (path.includes('/oauth/authorize/decision')) return Promise.resolve(new Response('{"error":"consent_changed","scope":"trip:read"}', { status: 409, headers: { 'content-type': 'application/json' } }));
      if (path.includes('/oauth/authorize/scope') && ++scopeCalls > 1) return Promise.resolve(new Response('{"scope":"trip:read"}', { status: 200, headers: { 'content-type': 'application/json' } }));
      return null;
    };
    const r = await consent({ trip_moments_capture: true }, 'bob', { intercept, press: true });
    assert.match(r.can, /but not change anything/);
    assert.equal(r.allowDisabled, false);
  });

  it('R3: the decision refuses (409, no code) when the scope shown is not the scope that would be granted', async () => {
    const ctx = await boot({ trip_moments_capture: true });
    try {
      const params = { client_id: ctx.h.clientId, redirect_uri: CLAUDE_CALLBACK, response_type: 'code', code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', state: 's', resource: `${ctx.base}/mcp`, decision: 'allow' };
      const post = (extra) => fetch(`${ctx.base}/oauth/authorize/decision`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ctx.base, authorization: `Bearer ${ctx.bob}` }, body: JSON.stringify({ ...params, ...extra }) });
      const stale = await post({ consent_scope: 'trip:read' });
      assert.equal(stale.status, 409);
      assert.deepEqual(await stale.json(), { error: 'consent_changed', scope: 'trip:moments' });
      const fine = await post({ consent_scope: 'trip:moments' });
      assert.equal(fine.status, 200);
      assert.ok(new URL((await fine.json()).redirect_to).searchParams.get('code'));
      const scope = await fetch(`${ctx.base}/oauth/authorize/scope`, { method: 'POST', headers: { origin: ctx.base, authorization: `Bearer ${ctx.bob}` } });
      assert.deepEqual(await scope.json(), { scope: 'trip:moments' });
      assert.equal((await fetch(`${ctx.base}/oauth/authorize/scope`, { method: 'POST', headers: { origin: ctx.base } })).status, 401, 'no session, no answer');
      assert.equal((await fetch(`${ctx.base}/oauth/authorize/scope`, { method: 'POST', headers: { authorization: `Bearer ${ctx.bob}` } })).status, 401, 'no Origin, no answer');
    } finally { stopTestServer(); }
  });
});

describe('kill switch: on, a member approves trip:moments, off, on again', () => {
  it('turning the feature off removes the tools and the page and the extra draft visibility; the same grant gets them back when it is turned on', async () => {
    const port = await freePort();
    const base = `http://localhost:${port}`;
    const env = { PORT: String(port), TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: base };
    const on = { configure: (c) => { c.features = { trip_moments_capture: true }; } };
    const off = { reuseData: true, configure: (c) => { delete c.features; } };
    const again = { reuseData: true, configure: (c) => { c.features = { trip_moments_capture: true }; } };
    const session = async () => {
      const alice = await loginAsAlice();
      const bob = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
      return { alice, bob };
    };
    const rpcTools = async (token) => {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      assert.equal(r.status, 200, 'the grant itself stays valid');
      return (await r.json()).result.tools.map((t) => t.name);
    };

    // ON: approve, add a connector moment.
    await startTestServer(env, on);
    let { alice, bob } = await session();
    const h = harness(base);
    await h.register();
    const grant = await h.connect(bob);
    assert.equal(grant.scope, 'trip:moments');
    assert.deepEqual(sorted(await rpcTools(grant.access_token)), sorted([...TODAY_MEMBER, ...CLASS]));
    const made = JSON.parse(text(await call(h, grant.access_token, 'add_moment', { caption: 'Made while on' })));
    assert.equal((await fetch(`${base}/mcp/upload-photos`)).status, 200);
    assert.ok((await (await api('/api/moments', { token: alice })).json()).some((m) => m.id === made.id), 'on: the organizer can see the connector draft');

    // OFF (a restart without the switch): the same token, no tools, no page, no extra visibility; the data is kept.
    await stopTestServerKeepData();
    await startTestServer(env, off);
    ({ alice, bob } = await session());
    assert.deepEqual(await rpcTools(grant.access_token), TODAY_MEMBER, 'off: exactly the nine');
    const gone = await call(h, grant.access_token, 'add_moment', { caption: 'while off' });
    assert.ok(gone.error || gone.result?.isError);
    assert.equal((await fetch(`${base}/mcp/upload-photos`)).status, 404, 'off: the page is gone');
    assert.ok(!(await (await api('/api/moments', { token: alice })).json()).some((m) => m.id === made.id), 'off: the organizer no longer gets the draft');
    assert.ok((await (await api('/api/moments', { token: bob })).json()).some((m) => m.id === made.id), 'off: its author still has it');
    const conn = (await (await api('/api/mcp/connection', { token: bob })).json()).connections;
    assert.deepEqual(conn.map((c) => c.moments), [false], 'off: the connection list does not claim moments');

    // ON again: the grant the member approved gets its scope's tools back (intended: they consented to that scope).
    await stopTestServerKeepData();
    await startTestServer(env, again);
    ({ alice, bob } = await session());
    assert.deepEqual(sorted(await rpcTools(grant.access_token)), sorted([...TODAY_MEMBER, ...CLASS]), 'on again: the same grant has them again');
    assert.equal((await fetch(`${base}/mcp/upload-photos`)).status, 200);
    assert.ok((await (await api('/api/moments', { token: alice })).json()).some((m) => m.id === made.id));
    stopTestServer();
  });
});
