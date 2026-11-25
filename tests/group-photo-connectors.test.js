/**
 * group-photo-connectors.test.js — the trip group's Telegram photo through the two assistant surfaces
 * (docs/specs/sprint-9/x-trip-group-photo.md): `set_group_photo_from_logo` and `get_group_photo_status` on the trip
 * connector (server/trip-mcp/tools.js, an organizer's own Claude or ChatGPT) and on the companion's bridge (mcp/mcp.js).
 *
 *   - AC-4: on the trip connector (built per request, from the public config) the tools are NOT LISTED for a trip without the
 *     switch. On the companion's bridge (mcp/mcp.js: one long-lived server that serves every trip it is configured for, so no
 *     trip is known when the list is made) they stay listed and answer `feature_off`, requesting nothing, as the trip_logo
 *     tools do (x-trip-logo.md AC-9). Both are backed by the call-time check on /api/config.
 *   - organizer only on the connector: a read-only connection lists neither tool;
 *   - never a chat id: neither tool takes an argument at all;
 *   - the honest answer: "requested" is not "done"; only get_group_photo_status says what happened.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startTestMcp, stopTestMcp, mcpCallTool, mcpListTools, MCP_API_KEY } from './helpers/mcp.js';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

const require = createRequire(import.meta.url);
const sharp = require('../server/node_modules/sharp');
const NONE = { changed: false, status: 'feature_off', message: 'The Telegram group photo is not turned on for this trip.' };
const png = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer();
const STATES = { off: { features: {} }, absent: {}, 'a string true': { features: { trip_group_photo: 'true' } }, 'a number': { features: { trip_group_photo: 1 } } };

describe('server/trip-mcp/tools.js (an organizer\'s own Claude or ChatGPT)', () => {
  const { McpServer } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js');
  const { Client } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
  const { InMemoryTransport } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js');
  const { registerTools } = require('../server/trip-mcp/tools.js');

  async function connect(write, config = { features: { trip_group_photo: true } }, { postError = null, statusBody = { status: 'none', request: null, message: null }, features } = {}) {
    const calls = [];
    const site = {
      get: async (path) => { calls.push({ method: 'GET', path }); return path === '/api/config' ? config : statusBody; },
      post: async (path, body) => {
        calls.push({ method: 'POST', path, body });
        if (postError) throw postError;
        return { status: 'pending', request: { id: 1, status: 'pending' }, message: 'The request is on its way to the group. This usually takes a minute or two.' };
      },
      patch: async () => ({}), del: async () => ({}),
    };
    const server = new McpServer({ name: 'test', version: '1' });
    registerTools(server, site, { write, origin: 'https://trip.example', ...(features === undefined ? {} : { features }) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { calls, client, close: () => client.close() };
  }
  const writes = (calls) => calls.filter((c) => c.method !== 'GET');

  test('organizer only: a write connection lists both, a read-only one lists neither, and neither takes a chat id', async () => {
    const full = await connect(true);
    try {
      const tools = (await full.client.listTools()).tools;
      const set = tools.find((t) => t.name === 'set_group_photo_from_logo');
      const get = tools.find((t) => t.name === 'get_group_photo_status');
      assert.ok(set && get);
      assert.equal(set.annotations.readOnlyHint, false, 'asking is a WRITE tool');
      assert.deepEqual(Object.keys(set.inputSchema.properties ?? {}), [], 'no argument: nobody names a chat');
      assert.deepEqual(Object.keys(get.inputSchema.properties ?? {}), []);
      assert.match(set.description, /never as a side effect/i);
      assert.match(set.description, /never "done" before/i);
    } finally { await full.close(); }
    const readOnly = await connect(false);
    try {
      const names = (await readOnly.client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('get_config'));
      assert.ok(!names.includes('set_group_photo_from_logo'));
      assert.ok(!names.includes('get_group_photo_status'));
      for (const name of ['set_group_photo_from_logo', 'get_group_photo_status']) {
        assert.equal((await readOnly.client.callTool({ name, arguments: {} }).catch((err) => ({ isError: true, err }))).isError, true);
      }
      assert.deepEqual(readOnly.calls, []);
    } finally { await readOnly.close(); }
  });

  test('AC-1: with the switch on, set_group_photo_from_logo POSTs /api/group-photo (as the person, no body) and says "requested", not "done"', async () => {
    const { calls, client, close } = await connect(true);
    try {
      const result = await client.callTool({ name: 'set_group_photo_from_logo', arguments: {} });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const answer = JSON.parse(result.content[0].text);
      assert.equal(answer.requested, true);
      assert.equal(answer.status, 'pending');
      assert.deepEqual(writes(calls), [{ method: 'POST', path: '/api/group-photo', body: {} }]);
    } finally { await close(); }
  });

  test('AC-3: a site that refuses at once with no_logo is an answer, not an error, and says what to do', async () => {
    const err = Object.assign(new Error('POST /api/group-photo → 422 {"error":"no_logo"}'), {});
    const { client, close } = await connect(true, undefined, { postError: err });
    try {
      const result = await client.callTool({ name: 'set_group_photo_from_logo', arguments: {} });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      assert.deepEqual(JSON.parse(result.content[0].text), { requested: false, status: 'no_logo', message: 'This trip has no logo yet. Add one first, then ask again.' });
    } finally { await close(); }
  });

  test('a refusal that is not no_logo (a member\'s 403) is a tool error, never a success', async () => {
    const err = new Error('POST /api/group-photo → 403 {"error":"Organizer access required"}');
    const { client, close } = await connect(true, undefined, { postError: err });
    try {
      assert.equal((await client.callTool({ name: 'set_group_photo_from_logo', arguments: {} })).isError, true);
    } finally { await close(); }
  });

  test('get_group_photo_status reads GET /api/group-photo and hands the site\'s answer on unchanged', async () => {
    const body = { status: 'bot_lacks_rights', request: { id: 3, status: 'bot_lacks_rights' }, message: 'Make the bot an admin with "Change group info", then ask again.' };
    const { calls, client, close } = await connect(true, undefined, { statusBody: body });
    try {
      const result = await client.callTool({ name: 'get_group_photo_status', arguments: {} });
      assert.deepEqual(JSON.parse(result.content[0].text), body);
      assert.deepEqual(writes(calls), []);
    } finally { await close(); }
  });

  test('AC-4: for a trip without the switch the connector does not list either tool (it lists them only on features.trip_group_photo === true)', async () => {
    for (const [label, features] of [['off', {}], ['a string true', { trip_group_photo: 'true' }], ['a number', { trip_group_photo: 1 }], ['another switch', { trip_logo: true }]]) {
      const { client, close } = await connect(true, { features }, { features });
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        assert.ok(names.includes('get_config'), label);
        assert.ok(!names.includes('set_group_photo_from_logo') && !names.includes('get_group_photo_status'), `${label}: not listed`);
      } finally { await close(); }
    }
    const { client, close } = await connect(true, { features: { trip_group_photo: true } }, { features: { trip_group_photo: true } });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('set_group_photo_from_logo') && names.includes('get_group_photo_status'));
    } finally { await close(); }
  });

  for (const [label, config] of Object.entries(STATES)) {
    test(`AC-4, switch ${label}, a list made before the switch changed: nothing is requested or read, and the answer is plain`, async () => {
      const { calls, client, close } = await connect(true, config);
      try {
        for (const name of ['set_group_photo_from_logo', 'get_group_photo_status']) {
          const result = await client.callTool({ name, arguments: {} });
          assert.notEqual(result.isError, true);
          assert.deepEqual(JSON.parse(result.content[0].text), NONE, name);
        }
        assert.deepEqual(calls.filter((c) => c.path !== '/api/config'), [], 'nothing but the switch was read');
      } finally { await close(); }
    });
  }
});

describe('mcp/mcp.js (the companion) against the real site, switch on', () => {
  let alice;
  before(async () => {
    const port = await freePort();
    await startTestServer({ PORT: String(port) }, { configure: (config) => { config.features = { trip_logo: true, trip_group_photo: true }; } });
    alice = await loginAsAlice();
    await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${port}`, TRIP_API_KEY: 'test-hermes-key', MCP_PORT: String(await freePort()), MCP_API_KEY });
  });
  after(() => { stopTestMcp(); stopTestServer(); });
  const text = (result) => JSON.parse(result.content[0].text);

  test('both tools are listed, take no argument, and say who may ask', async () => {
    const tools = await mcpListTools();
    assert.ok(tools.set_group_photo_from_logo && tools.get_group_photo_status);
    assert.deepEqual(Object.keys(tools.set_group_photo_from_logo.inputSchema.properties ?? {}), []);
    assert.match(tools.set_group_photo_from_logo.description, /organizer/i);
    assert.match(tools.set_group_photo_from_logo.description, /never as a side effect/i);
  });

  test('AC-3: no logo yet: requested false, no_logo, and nothing is stored on the site', async () => {
    const answer = text(await mcpCallTool('set_group_photo_from_logo', {}));
    assert.deepEqual(answer, { requested: false, status: 'no_logo', message: 'This trip has no logo yet. Add one first, then ask again.' });
    assert.deepEqual(text(await mcpCallTool('get_group_photo_status', {})), { status: 'none', request: null, message: null });
  });

  test('AC-1: with a logo, the request is stored as pending, and the status tool says pending, never done', async () => {
    const body = new FormData();
    body.set('logo', new Blob([await png()], { type: 'image/png' }), 'logo.png');
    assert.equal((await api('/api/ui-settings/logo', { method: 'POST', body, token: alice })).status, 200);
    const asked = text(await mcpCallTool('set_group_photo_from_logo', {}));
    assert.equal(asked.requested, true);
    assert.equal(asked.status, 'pending');
    const seen = text(await mcpCallTool('get_group_photo_status', {}));
    assert.equal(seen.status, 'pending');
    assert.match(seen.message, /on its way/i);
    assert.equal((await (await api('/api/group-photo', { token: alice })).json()).status, 'pending', 'the site and the tool agree');
  });
});

describe('mcp/mcp.js (the companion) against the real site, switch off', () => {
  before(async () => {
    const port = await freePort();
    await startTestServer({ PORT: String(port) }, { configure: (config) => { config.features = { trip_logo: true }; } });
    await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${port}`, TRIP_API_KEY: 'test-hermes-key', MCP_PORT: String(await freePort()), MCP_API_KEY });
  });
  after(() => { stopTestMcp(); stopTestServer(); });

  test('AC-4: both tools answer feature_off and the site has no request', async () => {
    for (const name of ['set_group_photo_from_logo', 'get_group_photo_status']) {
      const result = await mcpCallTool(name, {});
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      assert.deepEqual(JSON.parse(result.content[0].text), NONE, name);
    }
    const alice = await loginAsAlice();
    assert.equal((await api('/api/group-photo', { token: alice })).status, 409);
  });
});
