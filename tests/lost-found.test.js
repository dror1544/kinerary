/**
 * lost-found.test.js — POST /api/lost-found stays open with no login (owner
 * decision, 2026-09-27, issue #207) but must bound and validate its fields
 * and rate-limit per client address. GET/PATCH are unchanged (authRequired).
 *
 * The rate limiter keys on `req.ip`, and this server sets no `trust proxy`,
 * so `req.ip` is whatever Express derives from the raw socket — no
 * X-Forwarded-For involved. To get two addresses Express actually sees as
 * different without any proxy config, this file connects to the loopback
 * server over IPv4 (127.0.0.1) and over IPv6 (::1): Node reports those as
 * distinct `req.ip` values (`::ffff:127.0.0.1` vs `::1`), which is enough to
 * exercise per-address isolation without any real network topology. A third
 * loopback alias (127.0.0.2) was tried first and is NOT used: it does not
 * bind on every host this suite runs on (`EADDRNOTAVAIL` in this sandbox),
 * so the two-address approach is the portable one.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { PORTS } from './helpers/ports.js';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

const PORT = PORTS.lostFound;

/** POST JSON to /api/lost-found over a chosen loopback family, so the server
 *  sees a specific req.ip ('127.0.0.1' -> ::ffff:127.0.0.1, '::1' -> ::1). */
function postFrom(host, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host,
        port: PORT,
        path: '/api/lost-found',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

let token;

before(async () => {
  await startTestServer({ PORT: String(PORT) });
  token = await loginAsAlice();
});

after(() => stopTestServer());

describe('POST /api/lost-found (open, bounded, rate-limited — #207)', () => {
  test('valid fields, no token -> 200 and the row is readable by a member', async () => {
    const res = await postFrom('127.0.0.1', { name: 'Finder A', phone: '050-1234567', item: 'blue backpack', location: 'lobby' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.id);

    const listRes = await api('/api/lost-found', { token });
    assert.equal(listRes.status, 200);
    const rows = await listRes.json();
    assert.ok(rows.some(r => r.id === res.body.id && r.name === 'Finder A' && r.item === 'blue backpack'));
  });

  test('over-long item -> 400, no row written', async () => {
    const before = await (await api('/api/lost-found', { token })).json();
    const res = await postFrom('127.0.0.1', { name: 'Finder Long', phone: '', item: 'x'.repeat(201), location: '' });
    assert.equal(res.status, 400);
    const after = await (await api('/api/lost-found', { token })).json();
    assert.equal(after.length, before.length);
    assert.ok(!after.some(r => r.name === 'Finder Long'));
  });

  test('missing name -> 400, no row written', async () => {
    const before = await (await api('/api/lost-found', { token })).json();
    const res = await postFrom('127.0.0.1', { phone: '', item: 'unmarked umbrella', location: '' });
    assert.equal(res.status, 400);
    const after = await (await api('/api/lost-found', { token })).json();
    assert.equal(after.length, before.length);
  });

  test('non-string phone -> 400, no row written', async () => {
    const before = await (await api('/api/lost-found', { token })).json();
    const res = await postFrom('127.0.0.1', { name: 'Finder Weird', item: 'wallet', phone: 5012345 });
    assert.equal(res.status, 400);
    const after = await (await api('/api/lost-found', { token })).json();
    assert.equal(after.length, before.length);
  });

  test('oversized body -> 413 or 400, no row written', async () => {
    const before = await (await api('/api/lost-found', { token })).json();
    // Comfortably over any reasonable small cap while every individual field
    // still respects its own length bound.
    const res = await postFrom('127.0.0.1', { name: 'Finder Big', item: 'y'.repeat(200), location: 'z'.repeat(200) + ' '.repeat(4000) });
    assert.ok([400, 413].includes(res.status), `expected 400 or 413, got ${res.status}`);
    const after = await (await api('/api/lost-found', { token })).json();
    assert.equal(after.length, before.length);
  });

  test('rate limit: 5 accepted writes/hour per address, 6th -> 429 with Retry-After; a different address is not blocked', async () => {
    // A fresh address (IPv6 loopback) so earlier writes from the IPv4 tests
    // above do not count against this bucket.
    for (let i = 0; i < 5; i++) {
      const res = await postFrom('::1', { name: `Rate ${i}`, item: `item ${i}` });
      assert.equal(res.status, 200, `write ${i} should be accepted`);
    }
    const sixth = await postFrom('::1', { name: 'Rate 5', item: 'item 5' });
    assert.equal(sixth.status, 429);
    const retryAfter = Number(sixth.headers['retry-after']);
    assert.ok(Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 3600, `Retry-After was ${sixth.headers['retry-after']}`);

    const before = await (await api('/api/lost-found', { token })).json();
    assert.ok(!before.some(r => r.name === 'Rate 5'));

    // The IPv4 address used earlier in this file has had 1 accepted write so
    // far (well under its own quota) and is a different req.ip from '::1' —
    // it must not be affected by '::1' hitting its limit.
    const otherAddress = await postFrom('127.0.0.1', { name: 'Finder Other Address', item: 'sunglasses' });
    assert.equal(otherAddress.status, 200);
  });
});

describe('GET /api/lost-found and PATCH /api/lost-found/:id stay authRequired', () => {
  test('GET without a token -> 401', async () => {
    const res = await api('/api/lost-found');
    assert.equal(res.status, 401);
  });

  test('PATCH without a token -> 401', async () => {
    const res = await api('/api/lost-found/1', { method: 'PATCH', body: { resolved: true } });
    assert.equal(res.status, 401);
  });
});
