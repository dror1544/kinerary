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
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startTestMcp, stopTestMcp, mcpApi, MCP_API_KEY, TRIP_API_KEY } from './helpers/mcp.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('POST /extract auth', () => {
  before(async () => { await startTestMcp(); });
  after(() => stopTestMcp());

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
    assert.equal(res.status, 503); // past auth — fails later only on HERMES_EXTRACT_PROFILE being unset
  });

  test('accepts TRIP_API_KEY (the site\'s own /api/bookings/extract proxy)', async () => {
    const res = await mcpApi('/extract', { method: 'POST', body: {}, apiKey: TRIP_API_KEY });
    assert.equal(res.status, 503);
  });
});

describe('POST /extract empty-result guard', () => {
  // A real, observed failure mode: an occasional cold-start hermes call
  // returns valid-but-empty JSON ("{}") instead of erroring — HTTP 200 with
  // nothing usable would silently show the family member a blank "success".
  // This mock hermes binary always returns "{}" so the guard is testable
  // without a real Hermes call.
  const mockHermes = join(HERE, 'fixtures', 'mock-hermes-empty.sh');

  before(async () => { await startTestMcp({ HERMES_EXTRACT_PROFILE: 'anything', HERMES_BIN: mockHermes }); });
  after(() => stopTestMcp());

  test('treats a nameless extraction result as a failure, not a success', async () => {
    const pdf_base64 = readFileSync(join(HERE, 'fixtures', 'sample-confirmation.pdf')).toString('base64');
    const res = await mcpApi('/extract', { method: 'POST', apiKey: TRIP_API_KEY, body: { pdf_base64, pdf_name: 'test.pdf' } });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /no usable data/i);
  });
});
