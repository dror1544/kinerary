/**
 * mcp-trip-moments.test.js — the companion's MCP bridge (mcp/mcp.js) for trip photos and moments
 * (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part A: AC-4 and AC-7).
 *
 * Against the REAL trip site, with the agent key: the bridge is started with API_BASE_URL at a running test site, so what is proved is
 * the whole path (tool -> request -> site's checks -> stored row), not only the shape of a request.
 *   - AC-7: add_photo with `source` and `uploaded_for` lists the participant as the photo's author; an unknown participant is a tool error.
 *   - AC-4: add_moment (photo_ids, caption, body, author, source 'chat') creates the moment in the visibility asked for; list_moments,
 *     update_moment and delete_moment work through the agent key. A tool with the trip's switch off changes and reads nothing and says so.
 *   - get_photo_settings reads the organizer's two choices and the two switches (never gated).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, stopTestServer, loginAsAlice, api } from './helpers/server.js';
import { startTestMcp, stopTestMcp, mcpCallTool, mcpListTools } from './helpers/mcp.js';
import { freePort } from './helpers/port-guard.js';

const AGENT = { apiKey: 'test-hermes-key' };
const PIXEL = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const NONE = { changed: false, message: 'This trip does not have trip moments.' };
const json = (result) => { assert.notEqual(result.isError, true, `expected success: ${result.content?.[0]?.text}`); return JSON.parse(result.content[0].text); };

async function boot(features) {
  const sitePort = await freePort();
  await startTestServer({ HOST: '127.0.0.1', PORT: String(sitePort) }, features ? { features } : {});
  await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${sitePort}`, TRIP_API_KEY: 'test-hermes-key', MCP_PORT: String(await freePort()) });
  const alice = await loginAsAlice();
  const bob = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
  const dir = mkdtempSync(join(tmpdir(), 'moments-mcp-'));
  const file = join(dir, 'sunset.jpg');
  writeFileSync(file, PIXEL);
  return { alice, bob, file, dir };
}

describe('switch ON: the moment tools work through the agent key, against the real site', () => {
  let ctx;
  before(async () => { ctx = await boot({ trip_moments_capture: true, chat_photos_to_album: true }); });
  after(() => { stopTestMcp(); stopTestServer(); rmSync(ctx.dir, { recursive: true, force: true }); });

  test('the bridge lists the five new tools', async () => {
    const tools = await mcpListTools();
    for (const name of ['get_photo_settings', 'list_moments', 'add_moment', 'update_moment', 'delete_moment']) assert.ok(tools[name], name);
    assert.ok(tools.add_photo.inputSchema.properties.source);
    assert.ok(tools.add_photo.inputSchema.properties.uploaded_for);
  });

  test('AC-7: add_photo with source and uploaded_for makes the participant the photo\'s author in the album', async () => {
    const saved = json(await mcpCallTool('add_photo', { filePath: ctx.file, caption: 'Sunset', source: 'chat', uploaded_for: 'bob' }));
    assert.equal(saved.photo.username, 'bob');
    assert.equal(saved.photo.source, 'chat');
    const listed = (await (await api('/api/photos', { token: ctx.alice })).json()).find((p) => p.id === saved.photo.id);
    assert.equal(listed.username, 'bob');
    assert.equal(listed.user.username, 'bob', 'the album shows the participant, not the bot');
    assert.equal(listed.source, 'chat');
  });

  test('AC-7: add_photo with no uploaded_for is still the agent\'s; an unknown participant is a tool error and stores nothing', async () => {
    const own = json(await mcpCallTool('add_photo', { filePath: ctx.file }));
    assert.equal(own.photo.username, 'hermes');
    const before = (await (await api('/api/photos', { token: ctx.alice })).json()).length;
    const bad = await mcpCallTool('add_photo', { filePath: ctx.file, uploaded_for: 'nobody' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /400/);
    assert.equal((await (await api('/api/photos', { token: ctx.alice })).json()).length, before);
  });

  test('AC-4: add_moment with photo_ids, caption, body, author and source chat creates it in the visibility asked for', async () => {
    const published = json(await mcpCallTool('add_moment', { caption: 'The bet', body: 'Dad lost it', photo_ids: ['r1', 'r2'], author: 'bob', source: 'chat', visibility: 'published' }));
    assert.equal(published.author, 'bob');
    assert.equal(published.source, 'chat');
    assert.equal(published.visibility, 'published');
    assert.deepEqual(published.photo_ids, ['r1', 'r2']);
    const seen = (await (await api('/api/moments', { token: ctx.alice })).json()).find((m) => m.id === published.id);
    assert.equal(seen.caption, 'The bet', 'a published moment is served to the others');
    const draft = json(await mcpCallTool('add_moment', { caption: 'Draft', author: 'bob', source: 'chat' }));
    assert.equal(draft.visibility, 'draft', 'draft is the default');
    assert.ok((await (await api('/api/moments', { token: ctx.alice })).json()).some((m) => m.id === draft.id), 'an organizer sees the draft');
    assert.ok(json(await mcpCallTool('list_moments', {})).some((m) => m.id === draft.id), 'the agent key sees it too');
    assert.ok((await (await api('/api/moments', { token: ctx.bob })).json()).some((m) => m.id === draft.id), 'the draft is bob\'s');
  });

  test('AC-4: an author that is not a participant is refused by the site and nothing is stored', async () => {
    const bad = await mcpCallTool('add_moment', { caption: 'Who?', author: 'nobody' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /400/);
    assert.ok(!json(await mcpCallTool('list_moments', {})).some((m) => m.caption === 'Who?'));
  });

  test('AC-4: list_moments, update_moment and delete_moment work through the agent key', async () => {
    const made = json(await mcpCallTool('add_moment', { caption: 'Edit me', author: 'bob', visibility: 'published', photo_ids: ['a'] }));
    assert.ok(json(await mcpCallTool('list_moments', {})).some((m) => m.id === made.id), 'a published moment is listed');
    const updated = json(await mcpCallTool('update_moment', { id: made.id, caption: 'Edited', photo_ids: ['b', 'a'] }));
    assert.equal(updated.caption, 'Edited');
    assert.deepEqual(updated.photo_ids, ['b', 'a']);
    assert.equal(updated.author, 'bob', 'editing does not change whose moment it is');
    assert.deepEqual(json(await mcpCallTool('delete_moment', { id: made.id })), { ok: true });
    assert.ok(!(await (await api('/api/moments', { token: ctx.alice })).json()).some((m) => m.id === made.id));
    const missing = await mcpCallTool('delete_moment', { id: made.id });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /404/);
  });

  test('F1 (R4) through the real mcp.js: in organizer_draft mode every way for the agent to publish — or to relabel itself to dodge the review — is refused', async () => {
    const mode = async (m) => assert.equal((await api('/api/settings', { method: 'PATCH', body: { moment_capture_mode: m }, token: ctx.alice })).status, 200);
    await mode('organizer_draft');
    try {
      const stored = async () => (await (await api('/api/moments', { token: ctx.alice })).json());
      const before = (await stored()).length;
      // A: published straight away, as chat / relabelled site / relabelled connector (the tool only knows "chat").
      for (const source of ['chat', 'site', 'connector']) {
        const r = await mcpCallTool('add_moment', { caption: `probe ${source}`, author: 'bob', source, visibility: 'published' });
        assert.equal(r.isError, true, source);
      }
      assert.equal((await stored()).length, before, 'nothing was stored by any of them');
      // B: a draft first, then update_moment to published.
      const draft = json(await mcpCallTool('add_moment', { caption: 'draft then publish', author: 'bob', source: 'chat' }));
      assert.equal(draft.source, 'chat');
      assert.equal(draft.visibility, 'draft');
      const publish = await mcpCallTool('update_moment', { id: draft.id, visibility: 'published' });
      assert.equal(publish.isError, true);
      assert.match(publish.content[0].text, /403/);
      assert.match(publish.content[0].text, /organizer_review_required/);
      // C: a member's own moment (site or connector) is not the agent's to publish in this mode either.
      for (const source of ['site', 'connector']) {
        const m = await (await api('/api/moments', { method: 'POST', token: ctx.bob, body: { caption: `bob ${source}`, source } })).json();
        const r = await mcpCallTool('update_moment', { id: m.id, visibility: 'published' });
        assert.equal(r.isError, true, source);
      }
      assert.ok((await stored()).filter((m) => m.caption.startsWith('probe') || m.caption === 'draft then publish' || m.caption.startsWith('bob ')).every((m) => m.visibility === 'draft'), 'everything is still a draft');
      // Raw HTTP, the same refusals.
      const post = await api('/api/moments', { method: 'POST', apiKey: 'test-hermes-key', body: { caption: 'raw', author: 'bob', source: 'connector', visibility: 'published' } });
      assert.equal(post.status, 400);
      const rawPost = await api('/api/moments', { method: 'POST', apiKey: 'test-hermes-key', body: { caption: 'raw', author: 'bob', visibility: 'published' } });
      assert.equal(rawPost.status, 403);
    } finally { await mode('ask_in_chat'); }
  });

  test('F2: through the agent key the moment mode and the photo saving cannot be changed; the timezone still can', async () => {
    for (const body of [{ moment_capture_mode: 'publish' }, { group_photo_autosave: false }]) {
      const r = await api('/api/settings', { method: 'PATCH', apiKey: 'test-hermes-key', body });
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: 'organizer_only_setting' });
    }
    const tz = json(await mcpCallTool('set_trip_timezone', { timezone: 'Europe/Paris' }));
    assert.equal(tz.timezone, 'Europe/Paris');
  });

  test('get_photo_settings reads the two choices and the two switches', async () => {
    assert.deepEqual(json(await mcpCallTool('get_photo_settings', {})), {
      group_photo_autosave: true, moment_capture_mode: 'ask_in_chat', switches: { chat_photos_to_album: true, trip_moments_capture: true },
    });
    assert.equal((await api('/api/settings', { method: 'PATCH', body: { moment_capture_mode: 'publish', group_photo_autosave: false }, token: ctx.alice })).status, 200);
    assert.deepEqual(json(await mcpCallTool('get_photo_settings', {})), {
      group_photo_autosave: false, moment_capture_mode: 'publish', switches: { chat_photos_to_album: true, trip_moments_capture: true },
    });
  });
});

describe('switch OFF (the default): the moment tools change and read nothing, and say so', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(() => { stopTestMcp(); stopTestServer(); rmSync(ctx.dir, { recursive: true, force: true }); });

  test('add_moment, update_moment, delete_moment and list_moments answer plainly and store nothing', async () => {
    for (const [name, args] of [['add_moment', { caption: 'Nope', author: 'bob' }], ['update_moment', { id: 'x', caption: 'Nope' }], ['delete_moment', { id: 'x' }], ['list_moments', {}]]) {
      assert.deepEqual(json(await mcpCallTool(name, args)), NONE, name);
    }
    assert.deepEqual(await (await api('/api/moments', { token: ctx.bob })).json(), []);
    assert.deepEqual(await (await api('/api/moments', { token: ctx.alice })).json(), []);
  });

  test('get_photo_settings still reads, and says both switches are off', async () => {
    assert.deepEqual(json(await mcpCallTool('get_photo_settings', {})), {
      group_photo_autosave: true, moment_capture_mode: 'ask_in_chat', switches: { chat_photos_to_album: false, trip_moments_capture: false },
    });
  });

  test('F2: with chat_photos_to_album off the agent\'s uploaded_for is not part of the API: the photo is the agent\'s, as before', async () => {
    const saved = json(await mcpCallTool('add_photo', { filePath: ctx.file, uploaded_for: 'bob', source: 'chat' }));
    assert.equal(saved.photo.username, 'hermes');
    assert.equal(saved.photo.source, 'chat', 'the source label itself is just a label and is kept');
  });

  test('F2: with trip_moments_capture off nobody gets another person\'s drafts, whatever their source: exactly as before the feature', async () => {
    const draft = await (await api('/api/moments', { method: 'POST', token: ctx.bob, body: { caption: 'Bob connector draft, switch off', source: 'connector' } })).json();
    assert.ok(!(await (await api('/api/moments', { token: ctx.alice })).json()).some((m) => m.id === draft.id), 'organizer');
    assert.ok(!(await (await api('/api/moments', { apiKey: 'test-hermes-key' })).json()).some((m) => m.id === draft.id), 'agent key');
    assert.ok((await (await api('/api/moments', { token: ctx.bob })).json()).some((m) => m.id === draft.id), 'its author');
  });

  test('F2: with trip_moments_capture off the agent\'s author is ignored too (the tool answers first; the site route does the same)', async () => {
    const res = await api('/api/moments', { method: 'POST', apiKey: 'test-hermes-key', body: { caption: 'Off', author: 'bob', source: 'chat' } });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).author, 'hermes');
  });
});
