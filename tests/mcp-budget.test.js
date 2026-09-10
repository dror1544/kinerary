/**
 * End-to-end MCP coverage for the writable trip budget.
 *
 * The Modern SPA and the trip companion must operate on the same budget
 * records. These calls exercise the real MCP tools over SSE and verify that
 * every write crosses the trip API boundary with the server-to-server key.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MCP_API_KEY, startTestMcp, stopTestMcp, mcpCallTool, TRIP_API_KEY } from './helpers/mcp.js';

let apiServer;
let apiBaseUrl;
const requests = [];

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
  });
}

function parseToolJson(result) {
  assert.notEqual(result.isError, true);
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

describe('writable budget MCP tools', () => {
  before(async () => {
    apiServer = createServer(async (req, res) => {
      const body = await parseBody(req);
      requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], body });
      if (req.headers['x-api-key'] !== TRIP_API_KEY) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'POST' && req.url === '/api/budget') return res.end(JSON.stringify({ ok: true, id: 41 }));
      if (req.method === 'PATCH' && req.url === '/api/budget/41') return res.end(JSON.stringify({ ok: true }));
      if (req.method === 'DELETE' && req.url === '/api/budget/41') return res.end(JSON.stringify({ ok: true }));
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise((resolve, reject) => {
      apiServer.once('error', reject);
      apiServer.listen(0, '127.0.0.1', resolve);
    });
    const address = apiServer.address();
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
    await startTestMcp({ API_BASE_URL: apiBaseUrl, MCP_PORT: '3113', MCP_API_KEY });
  });

  after(async () => {
    stopTestMcp();
    await new Promise(resolve => apiServer.close(resolve));
  });

  test('adds, updates, and deletes a budget item through the trip API', async () => {
    assert.deepEqual(parseToolJson(await mcpCallTool('add_budget_item', {
      phase: 'tokyo', category: 'food', description: 'Team dinner', amount: 90, is_estimate: true,
    })), { ok: true, id: 41 });
    assert.deepEqual(parseToolJson(await mcpCallTool('update_budget_item', {
      id: 41, description: 'Team dinner and dessert', amount: 105,
    })), { ok: true });
    assert.deepEqual(parseToolJson(await mcpCallTool('delete_budget_item', { id: 41 })), { ok: true });

    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ['POST', '/api/budget'],
      ['PATCH', '/api/budget/41'],
      ['DELETE', '/api/budget/41'],
    ]);
    assert.deepEqual(requests[0].body, { phase: 'tokyo', category: 'food', description: 'Team dinner', amount: 90, is_estimate: true });
    assert.deepEqual(requests[1].body, { description: 'Team dinner and dessert', amount: 105 });
    assert.ok(requests.every(({ apiKey }) => apiKey === TRIP_API_KEY));
  });
});
