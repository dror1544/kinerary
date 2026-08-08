/**
 * mcp-extract.test.js — auth boundary for trip-mcp's POST /extract.
 *
 * /extract is called by the trip site's own /api/bookings/extract proxy
 * (server.js), which only ever holds TRIP_API_KEY (the secret it already
 * shares with trip-mcp), never trip-mcp's own MCP_API_KEY. It must also
 * keep working for an agent calling /extract directly with MCP_API_KEY.
 * No ANTHROPIC_API_KEY is set here — the auth check runs before that key is
 * ever read, so these tests prove the boundary without a real Anthropic call.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestMcp, stopTestMcp, mcpApi, MCP_API_KEY, TRIP_API_KEY } from './helpers/mcp.js';

before(async () => { await startTestMcp(); });
after(() => stopTestMcp());

describe('POST /extract auth', () => {
  test('rejects requests with no key', async () => {
    const res = await mcpApi('/extract', { method: 'POST', body: {} });
    assert.equal(res.status, 401);
  });

  test('rejects a wrong key', async () => {
    const res = await mcpApi('/extract', { method: 'POST', body: {}, apiKey: 'not-a-real-key' });
    assert.equal(res.status, 401);
  });

  test('accepts MCP_API_KEY (agent calling directly)', async () => {
    const res = await mcpApi('/extract', { method: 'POST', body: {}, apiKey: MCP_API_KEY });
    assert.equal(res.status, 503); // past auth — fails later only on missing ANTHROPIC_API_KEY
  });

  test('accepts TRIP_API_KEY (the site\'s own /api/bookings/extract proxy)', async () => {
    const res = await mcpApi('/extract', { method: 'POST', body: {}, apiKey: TRIP_API_KEY });
    assert.equal(res.status, 503);
  });
});
