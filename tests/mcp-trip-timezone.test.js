/**
 * mcp-trip-timezone.test.js — set_trip_timezone (issue: trip-timezone).
 *
 * Same pattern PR #310's tests/mcp-phase-plan.test.js used: a real MCP tool
 * call over SSE against a stand-in trip-site API, asserting on exactly what
 * the tool passes through and returns. The stand-in validates the way the
 * real PATCH /api/settings route does (isValidTimeZone, from the real
 * server/living-journey.js — not a re-guessed copy of the rule), so a
 * garbage zone here behaves the way it would against the real trip site.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { MCP_API_KEY, TRIP_API_KEY, startTestMcp, stopTestMcp, mcpCallTool } from './helpers/mcp.js';
import { PORTS } from './helpers/ports.js';

const require = createRequire(import.meta.url);
const { isValidTimeZone } = require('../server/living-journey.js');

function parseToolJson(result) {
  assert.notEqual(result.isError, true, `expected success, got error: ${result.content?.[0]?.text}`);
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

function parseToolError(result) {
  assert.equal(result.isError, true, 'expected a tool error');
  assert.equal(result.content?.[0]?.type, 'text');
  return result.content[0].text;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
  });
}

describe('set_trip_timezone', () => {
  let apiServer;
  let apiBaseUrl;
  const requests = [];
  let stored = null;

  before(async () => {
    apiServer = createServer(async (req, res) => {
      const body = await parseBody(req);
      requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], body });
      if (req.headers['x-api-key'] !== TRIP_API_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      if (req.method === 'PATCH' && req.url === '/api/settings') {
        if (!isValidTimeZone(body?.timezone)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'timezone must be a valid IANA time zone identifier, e.g. "America/New_York"' }));
        }
        // Mirrors the real PATCH /api/settings: store Intl's canonical
        // spelling, never the caller's own.
        stored = new Intl.DateTimeFormat(undefined, { timeZone: body.timezone }).resolvedOptions().timeZone;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ timezone: stored, updated_by: 'hermes', updated_at: '2026-09-29T12:00:00.000Z' }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise((resolve, reject) => {
      apiServer.once('error', reject);
      apiServer.listen(0, '127.0.0.1', resolve);
    });
    apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
    await startTestMcp({ API_BASE_URL: apiBaseUrl, MCP_PORT: String(PORTS.mcpTripTimezone), MCP_API_KEY });
  });

  after(async () => {
    stopTestMcp();
    await new Promise((resolve) => apiServer.close(resolve));
  });

  test('a valid IANA zone round-trips through PATCH /api/settings', async () => {
    const result = parseToolJson(await mcpCallTool('set_trip_timezone', { timezone: 'America/New_York' }));
    assert.deepEqual(result, { timezone: 'America/New_York', updated_by: 'hermes', updated_at: '2026-09-29T12:00:00.000Z' });
    assert.deepEqual(requests.at(-1), {
      method: 'PATCH', url: '/api/settings', apiKey: TRIP_API_KEY, body: { timezone: 'America/New_York' },
    });
  });

  test('an invalid zone surfaces the server\'s rejection as a tool error, not a crash', async () => {
    const message = parseToolError(await mcpCallTool('set_trip_timezone', { timezone: 'Vietnam' }));
    assert.match(message, /valid IANA time zone/);
    // The rejected value must not have overwritten the last successful one.
    assert.equal(stored, 'America/New_York');
  });

  test('a second valid zone (correcting a wrong one) also round-trips', async () => {
    const result = parseToolJson(await mcpCallTool('set_trip_timezone', { timezone: 'Asia/Jerusalem' }));
    assert.equal(result.timezone, 'Asia/Jerusalem');
  });

  test('an unusual case/spelling round-trips as the canonical name, not the input spelling', async () => {
    const result = parseToolJson(await mcpCallTool('set_trip_timezone', { timezone: 'america/new_york' }));
    assert.equal(result.timezone, 'America/New_York');
  });
});
