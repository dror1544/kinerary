/**
 * trip-mcp-group-line.test.js — the trip tool `set_group_change_line`
 * (video Release 1C, docs/specs/sprint-9/x-video-r1-group-line.md: AC-24, plus the regression plan's round 3).
 *
 * Two surfaces carry the same tool, as they carry the stop tools: server/trip-mcp/tools.js (an
 * organizer's own Claude or ChatGPT; a read-only connection never lists a write tool) and mcp/mcp.js
 * (the bridge the trip's companion works through). Both check the trip's `plan_change_group_line` switch
 * first (the literal true in /api/config's `features`):
 *   - on:  PATCH /api/settings with only { group_change_line } and hand back what the site stored;
 *   - off, absent, or anything but true: change NOTHING and answer plainly that this trip does not have
 *     plan-change lines;
 *   - a config that cannot be read: a tool error, and nothing changed.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { MCP_API_KEY, TRIP_API_KEY, startTestMcp, stopTestMcp, mcpCallTool } from './helpers/mcp.js';
import { freePort } from './helpers/port-guard.js';

const require = createRequire(import.meta.url);
const NONE = { changed: false, message: 'This trip does not have plan-change lines.' };
// What /api/config says in each state: only a literal true is "on".
const STATES = {
  on: { features: { plan_change_group_line: true } },
  off: { features: {} },
  absent: {},
  'a string true': { features: { plan_change_group_line: 'true' } },
  'a number': { features: { plan_change_group_line: 1 } },
};

describe('server/trip-mcp/tools.js', () => {
  const { McpServer } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js');
  const { Client } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
  const { InMemoryTransport } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js');
  const { registerTools } = require('../server/trip-mcp/tools.js');

  async function connect(write, config = STATES.on, { configFails = false } = {}) {
    const calls = [];
    const site = {
      get: async (path) => { calls.push({ method: 'GET', path }); if (configFails) throw new Error('GET /api/config → 503'); return config; },
      post: async () => ({}),
      del: async () => ({}),
      patch: async (path, body) => { calls.push({ method: 'PATCH', path, body }); return { timezone: null, group_change_line: body.group_change_line, updated_by: 'alice', updated_at: null }; },
    };
    const server = new McpServer({ name: 'test', version: '1' });
    registerTools(server, site, { write });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { calls, client, close: () => client.close() };
  }
  const patches = (calls) => calls.filter((c) => c.method === 'PATCH');

  test('AC-24, switch on: enabled:false turns the setting off and the tool returns the stored value', async () => {
    const { calls, client, close } = await connect(true, STATES.on);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'set_group_change_line');
      assert.ok(tool, 'the tool is listed on a write connection');
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.match(tool.description, /organizer/i);
      assert.match(tool.description, /own private chat/i, 'it says this is a setting the organizer changes in their own chat');
      assert.match(tool.description, /does not have/i, 'it says what happens on a trip without the lines');
      assert.ok(!/group gets|telegram group/i.test(tool.description), 'it does not promise that a group is told');
      const result = await client.callTool({ name: 'set_group_change_line', arguments: { enabled: false } });
      assert.notEqual(result.isError, true);
      assert.deepEqual(patches(calls), [{ method: 'PATCH', path: '/api/settings', body: { group_change_line: false } }]);
      assert.equal(JSON.parse(result.content[0].text).group_change_line, false);
      await client.callTool({ name: 'set_group_change_line', arguments: { enabled: true } });
      assert.deepEqual(patches(calls).at(-1), { method: 'PATCH', path: '/api/settings', body: { group_change_line: true } });
    } finally { await close(); }
  });

  for (const [label, config] of Object.entries(STATES)) {
    if (label === 'on') continue;
    test(`switch ${label}: nothing is changed and the answer is plain`, async () => {
      const { calls, client, close } = await connect(true, config);
      try {
        const result = await client.callTool({ name: 'set_group_change_line', arguments: { enabled: false } });
        assert.notEqual(result.isError, true);
        assert.deepEqual(JSON.parse(result.content[0].text), NONE);
        assert.deepEqual(patches(calls), [], 'no write reached the site');
      } finally { await close(); }
    });
  }

  test('a config that cannot be read is a tool error and changes nothing', async () => {
    const { calls, client, close } = await connect(true, STATES.on, { configFails: true });
    try {
      const result = await client.callTool({ name: 'set_group_change_line', arguments: { enabled: false } });
      assert.equal(result.isError, true);
      assert.deepEqual(patches(calls), []);
    } finally { await close(); }
  });

  test('AC-24: a read-only connection does not list the tool, and calling it reaches nothing', async () => {
    const { calls, client, close } = await connect(false);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('get_config'));
      assert.ok(!names.includes('set_group_change_line'));
      const call = await client.callTool({ name: 'set_group_change_line', arguments: { enabled: false } }).catch((err) => ({ isError: true, err }));
      assert.equal(call.isError, true);
      assert.deepEqual(calls, []);
    } finally { await close(); }
  });

  test('a non-boolean is refused before it reaches the site', async () => {
    const { calls, client, close } = await connect(true);
    try {
      const call = await client.callTool({ name: 'set_group_change_line', arguments: { enabled: 'false' } }).catch((err) => ({ isError: true, err }));
      assert.equal(call.isError, true);
      assert.deepEqual(calls, []);
    } finally { await close(); }
  });
});

describe('mcp/mcp.js (the companion\'s bridge)', () => {
  let apiServer;
  const requests = [];
  let stored = true;
  let config = STATES.on;
  let configStatus = 200;

  before(async () => {
    apiServer = createServer(async (req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], body });
      if (req.method === 'GET' && req.url === '/api/config') {
        res.writeHead(configStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(configStatus === 200 ? config : { error: 'unavailable' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'PATCH' && req.url === '/api/settings') {
        stored = body.group_change_line;
        return res.end(JSON.stringify({ timezone: null, group_change_line: stored, updated_by: 'hermes', updated_at: null }));
      }
      res.end('{}');
    });
    await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(0, '127.0.0.1', resolve); });
    await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${apiServer.address().port}`, MCP_PORT: String(await freePort()), MCP_API_KEY });
  });
  after(async () => {
    stopTestMcp();
    await new Promise((resolve) => apiServer.close(resolve));
  });
  const writes = () => requests.filter((r) => r.method === 'PATCH');

  test('AC-24, switch on: set_group_change_line patches only group_change_line and returns the stored value', async () => {
    config = STATES.on; configStatus = 200;
    const result = await mcpCallTool('set_group_change_line', { enabled: false });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).group_change_line, false);
    assert.deepEqual(requests.at(-1), { method: 'PATCH', url: '/api/settings', apiKey: TRIP_API_KEY, body: { group_change_line: false } });
    const on = await mcpCallTool('set_group_change_line', { enabled: true });
    assert.equal(JSON.parse(on.content[0].text).group_change_line, true);
  });

  for (const [label, state] of Object.entries(STATES)) {
    if (label === 'on') continue;
    test(`switch ${label}: nothing is changed and the answer is plain`, async () => {
      config = state; configStatus = 200;
      const before = writes().length;
      const result = await mcpCallTool('set_group_change_line', { enabled: false });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      assert.deepEqual(JSON.parse(result.content[0].text), NONE);
      assert.equal(writes().length, before, 'no write reached the site');
    });
  }

  test('a config that cannot be read is a tool error and changes nothing', async () => {
    config = STATES.on; configStatus = 503;
    const before = writes().length;
    const result = await mcpCallTool('set_group_change_line', { enabled: false }).catch((err) => ({ isError: true, err }));
    configStatus = 200;
    assert.equal(result.isError, true);
    assert.equal(writes().length, before);
  });

  test('a non-boolean is refused and nothing is sent to the site', async () => {
    config = STATES.on; configStatus = 200;
    const before = requests.length;
    const result = await mcpCallTool('set_group_change_line', { enabled: 'no' }).catch((err) => ({ isError: true, err }));
    assert.equal(result.isError, true);
    assert.equal(requests.length, before);
  });
});
