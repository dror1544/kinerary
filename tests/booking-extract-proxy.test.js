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
      res.end(JSON.stringify({ phase: 'ny', name: 'Mock Hotel', type: 'hotel', confirmation: 'MOCK-42' }));
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

describe('POST /api/bookings/extract-draft', () => {
  test('creates a private organizer draft, then makes it visible only after approval', async () => {
    const created = await api('/api/bookings/extract-draft', {
      method: 'POST', token, body: { url: 'https://example.com/confirmation' },
    });
    assert.equal(created.status, 201);
    const { booking } = await created.json();
    assert.equal(booking.review_status, 'draft');
    assert.equal(booking.confirmation, 'MOCK-42');

    const bobLogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'bob', password: '1234' },
    });
    const { token: bobToken } = await bobLogin.json();
    const memberRows = await (await api('/api/bookings', { token: bobToken })).json();
    assert.equal(memberRows.some(row => row.id === booking.id), false, 'member must not see unapproved drafts');

    // A draft linked by an organizer must remain redacted in every Modern
    // participant projection, not only in the Classic bookings list.
    const itineraryWrite = await api('/api/itinerary/items', {
      method: 'POST', token,
      body: { phase_id: 'ny', date: '2027-03-11', text_he: 'טיוטת מלון פרטית', booking_id: booking.id },
    });
    assert.equal(itineraryWrite.status, 201);
    const itineraryCreated = await itineraryWrite.json();
    const active = await (await api('/api/itinerary/active', { token: bobToken })).json();
    assert.equal(active.items.find(item => item.item_uid === itineraryCreated.item_uid)?.booking, null);
    const confirmations = await (await api('/api/confirmations/summary', { token: bobToken })).json();
    assert.equal(confirmations.items.some(item => item.id === booking.id), false, 'draft confirmation leaked through Modern summary');

    const approved = await api(`/api/bookings/${booking.id}/approve`, { method: 'POST', token });
    assert.equal(approved.status, 200);
    const visibleRows = await (await api('/api/bookings', { token: bobToken })).json();
    assert.equal(visibleRows.some(row => row.id === booking.id), true, 'approved draft should be visible to members');
  });

  test('rejects a member attempting to create a draft', async () => {
    const bobLogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'bob', password: '1234' },
    });
    const { token: bobToken } = await bobLogin.json();
    const res = await api('/api/bookings/extract-draft', {
      method: 'POST', token: bobToken, body: { url: 'https://example.com/confirmation' },
    });
    assert.equal(res.status, 403);
  });

  test('an ignored quality issue remains ignored after the engine recomputes', async () => {
    const reported = await api('/api/issues/report', {
      method: 'POST', token, body: { title: 'Keep ignored', detail: 'organizer decision' },
    });
    assert.equal(reported.status, 201);
    const { id } = await reported.json();
    const ignored = await api(`/api/issues/${id}`, { method: 'PATCH', token, body: { status: 'ignored' } });
    assert.equal(ignored.status, 200);
    const issues = await (await api('/api/issues', { token })).json();
    assert.equal(issues.find(issue => issue.id === id)?.status, 'ignored');
  });
});

// PR-28 review regression: updateLegacyFromActive() used to DELETE every
// phase_plan_* row and re-insert, which destroyed Classic correction/enrichment
// history. The fix switched to a keyed upsert — but an upsert with no delete
// pass would instead let a Classic row survive after its Modern source was
// removed, and could duplicate a row on repeated edits. These pin the reconcile.
describe('Modern itinerary edits reconcile into the Classic plan', () => {
  const PHASE = 'ny';
  const DATE = '2027-03-11';
  const planRows = async () => (await api(`/api/phases/${PHASE}/plan`, { token })).json();
  const withText = (rows, text_en) => rows.filter((r) => r.text_en === text_en);

  let keptUid;
  let removedUid;

  test('a Modern item is projected into the Classic plan', async () => {
    const first = await api('/api/itinerary/items', {
      method: 'POST', token,
      body: { phase_id: PHASE, date: DATE, text_he: 'פריט מודרני ראשון', text_en: 'Reconcile item A' },
    });
    const second = await api('/api/itinerary/items', {
      method: 'POST', token,
      body: { phase_id: PHASE, date: DATE, text_he: 'פריט מודרני שני', text_en: 'Reconcile item B' },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    keptUid = (await first.json()).item_uid;
    removedUid = (await second.json()).item_uid;

    const rows = await planRows();
    assert.equal(withText(rows, 'Reconcile item A').length, 1);
    assert.equal(withText(rows, 'Reconcile item B').length, 1);
  });

  test('deleting the Modern item removes it from the Classic plan — no resurrection', async () => {
    const del = await api(`/api/itinerary/items/${removedUid}`, { method: 'DELETE', token });
    assert.equal(del.status, 200);

    const rows = await planRows();
    assert.equal(withText(rows, 'Reconcile item B').length, 0,
      'the deleted Modern item is still present in the Classic projection');
    assert.equal(withText(rows, 'Reconcile item A').length, 1,
      'the surviving item must not be dropped by the reconcile');
  });

  test('repeated Modern edits never duplicate the Classic row', async () => {
    for (const text_en of ['Reconcile item A v2', 'Reconcile item A v3', 'Reconcile item A v4']) {
      const res = await api(`/api/itinerary/items/${keptUid}`, { method: 'PATCH', token, body: { text_en } });
      assert.equal(res.status, 200);
    }
    const rows = await planRows();
    const mine = rows.filter((r) => (r.text_en || '').startsWith('Reconcile item A'));
    assert.equal(mine.length, 1, `expected exactly one Classic row for the edited item, got ${mine.length}`);
    assert.equal(mine[0].text_en, 'Reconcile item A v4');
  });
});
