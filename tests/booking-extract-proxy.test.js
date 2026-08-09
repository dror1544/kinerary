/**
 * booking-extract-proxy.test.js — POST /api/bookings/extract.
 *
 * Real-world bug: the site's own "Extract Details with AI" upload
 * (site/app.js) sends { pdf_base64, pdf_name } as a JSON body — never
 * multipart — but the route only ever read req.file (multipart) or
 * req.body.url, never req.body.pdf_base64. Every real upload hit the
 * "Provide a file or url" 400 at best. Worse, the global JSON body limit
 * (Express's 100kb default) was smaller than a base64-encoded PDF, so most
 * real uploads never even reached the route — they died in body-parser with
 * a PayloadTooLargeError, which Express renders as an HTML page. The
 * client's fetch().then(r => r.json()) then crashed on the '<' of
 * "<!DOCTYPE ...", surfacing as "Unexpected token '<' ... is not valid
 * JSON" — not the actual problem.
 *
 * Spins up a tiny local HTTP server standing in for trip-mcp's own
 * /extract, so this proves server.js's proxy contract without depending on
 * a real Hermes call.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

let token;
let mockHermes;
let lastMockRequest;
const MOCK_PORT = 3103; // 3095-3102 already claimed by other test files

before(async () => {
  mockHermes = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      lastMockRequest = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'Mock Hotel', type: 'hotel' }));
    });
  });
  await new Promise(resolve => mockHermes.listen(MOCK_PORT, resolve));

  // Dedicated port — every other test file shares one hardcoded default,
  // and node:test runs files concurrently by default (see helpers/server.js).
  await startTestServer({ HERMES_URL: `http://127.0.0.1:${MOCK_PORT}`, PORT: '3104' });
  token = await loginAsAlice();
});

after(() => {
  stopTestServer();
  mockHermes.close();
});

describe('POST /api/bookings/extract', () => {
  test('forwards a pdf_base64 JSON body (the real browser flow) to trip-mcp', async () => {
    const res = await api('/api/bookings/extract', {
      method: 'POST',
      token,
      body: { pdf_base64: 'ZmFrZS1wZGYtYnl0ZXM=', pdf_name: 'confirmation.pdf' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'Mock Hotel');
    assert.equal(lastMockRequest.body.pdf_base64, 'ZmFrZS1wZGYtYnl0ZXM=');
    assert.equal(lastMockRequest.body.pdf_name, 'confirmation.pdf');
  });

  test('forwards a url JSON body too', async () => {
    const res = await api('/api/bookings/extract', {
      method: 'POST',
      token,
      body: { url: 'https://example.com/confirmation' },
    });
    assert.equal(res.status, 200);
    assert.equal(lastMockRequest.body.url, 'https://example.com/confirmation');
  });

  test('rejects a body with neither pdf_base64 nor url', async () => {
    const res = await api('/api/bookings/extract', { method: 'POST', token, body: {} });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /provide a file or url/i);
  });

  test('accepts a base64 payload well over the old 100kb default without erroring', async () => {
    // ~8MB of base64 text — comfortably under the new 30mb limit, and far
    // past Express's old 100kb default that used to reject this outright.
    const bigBase64 = 'A'.repeat(8 * 1024 * 1024);
    const res = await api('/api/bookings/extract', {
      method: 'POST',
      token,
      body: { pdf_base64: bigBase64, pdf_name: 'big.pdf' },
    });
    assert.equal(res.status, 200);
  });

  test('a too-large body still gets a JSON error, never an HTML page', async () => {
    // Comfortably over the 30mb limit — must fail via the error-handling
    // middleware with real JSON, not Express's default HTML error page
    // (which is exactly what made the client crash on "Unexpected token '<'").
    const hugeBase64 = 'A'.repeat(31 * 1024 * 1024);
    const res = await api('/api/bookings/extract', {
      method: 'POST',
      token,
      body: { pdf_base64: hugeBase64, pdf_name: 'huge.pdf' },
    });
    assert.equal(res.status, 413);
    const contentType = res.headers.get('content-type') || '';
    assert.match(contentType, /application\/json/);
    const data = await res.json(); // throws if this is HTML, proving the fix
    assert.ok(data.error);
  });
});
