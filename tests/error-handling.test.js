/**
 * error-handling.test.js — the app-wide error-handling middleware in
 * server/server.js.
 *
 * PR #7 review: the middleware originally forwarded err.message to the
 * client for anything that wasn't the specific entity.too.large case it was
 * written for — a framework/driver-level error surfacing there for the
 * first time was never vetted for client exposure (could be a stack-trace
 * fragment, a file path, a DB error). Fixed to only ever expose a message
 * for that one vetted case; everything else gets a fixed generic message,
 * with the real error still logged server-side.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, api } from './helpers/server.js';

before(async () => { await startTestServer({ PORT: '3105' }); }); // 3095-3104 already claimed by other test files
after(() => stopTestServer());

describe('app-wide error-handling middleware', () => {
  test('a malformed JSON body gets a fixed generic message, not the raw parser error', async () => {
    const res = await fetch('http://localhost:3105/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'internal server error');
    assert.doesNotMatch(data.error, /Unexpected token|JSON|position \d/i, 'must not leak the raw parser error text');
  });

  test('the one vetted case (payload too large) still gets its specific message', async () => {
    const res = await api('/api/bookings/extract', {
      method: 'POST',
      apiKey: 'test-hermes-key',
      body: { pdf_base64: 'A'.repeat(31 * 1024 * 1024), pdf_name: 'huge.pdf' },
    });
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.error, 'file too large');
  });
});
