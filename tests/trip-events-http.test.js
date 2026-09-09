import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';
const require = createRequire(import.meta.url);
const jwt = require('../server/node_modules/jsonwebtoken');
let token;
before(async () => { await startTestServer({ PORT: 3198 }); token = await loginAsAlice(); });
after(stopTestServer);

async function stream() {
  const controller = new AbortController();
  const response = await fetch('http://localhost:3198/api/events', {
    headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  let buffer = '';
  async function next() {
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        assert.ok(!done, 'stream stays open'); buffer += new TextDecoder().decode(value);
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      return frame;
    } finally { clearTimeout(timeout); }
  }
  return { next, close: () => controller.abort() };
}

test('unauthenticated and other-trip tokens receive 401, not event data', async () => {
  for (const foreign of [undefined, jwt.sign({ username: 'alice' }, 'a-different-trip-secret')]) {
    const response = await api('/api/events', { token: foreign });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: foreign ? 'invalid_token' : 'unauthorized' });
  }
});

test('two open clients see persisted agent writes; reconnect catches up without content leaks', async () => {
  const a = await stream(); const b = await stream();
  try {
    assert.match(await a.next(), /event: ready/); await b.next();
    const response = await api('/api/budget', { method: 'POST', apiKey: 'test-hermes-key',
      body: { phase: 'ny', category: 'food', description: 'private budget text', amount: 42 } });
    assert.equal(response.status, 200);
    const frames = await Promise.all([a.next(), b.next()]);
    for (const frame of frames) {
      assert.match(frame, /event: change/); assert.match(frame, /"budget":\d+/);
      assert.doesNotMatch(frame, /private budget|alice|description|amount/);
    }
    const rows = await (await api('/api/budget', { token })).json();
    assert.ok(rows.some(row => row.description === 'private budget text'));
    const c = await stream();
    try { assert.match(await c.next(), /"budget":[1-9]/); } finally { c.close(); }
  } finally { a.close(); b.close(); }
});

test('a rejected write does not advance resource revisions', async () => {
  const a = await stream();
  try {
    const first = await a.next();
    const denied = await api('/api/bookings', { method: 'POST', token: 'invalid', body: { name: 'denied' } });
    assert.equal(denied.status, 401);
    const b = await stream();
    try { assert.equal(await b.next(), first); } finally { b.close(); }
  } finally { a.close(); }
});

test('itinerary, attached documents, photos, reactions and comments notify both clients', async () => {
  const a = await stream(); const b = await stream();
  try {
    await a.next(); await b.next();
    async function write(path, body, resource, method = 'POST') {
      const response = await api(path, { method, body, apiKey: 'test-hermes-key' });
      assert.equal(response.ok, true, `${path}: ${response.status}`);
      const result = await response.json();
      for (const frame of await Promise.all([a.next(), b.next()])) {
        assert.match(frame, /event: change/);
        const payload = JSON.parse(frame.split('data: ')[1]);
        assert.ok(payload.revisions[resource] > 0, `${resource}: ${frame}`);
        assert.deepEqual(Object.keys(payload), ['revisions']);
      }
      return result;
    }
    await write('/api/itinerary/items', { phase_id: 'ny', date: '2026-08-01', text_he: 'Visit', text_en: 'Visit', item_type: 'activity' }, 'itinerary');
    const booking = await write('/api/bookings', { phase: 'ny', type: 'hotel', name: 'Private hotel' }, 'bookings');
    const form = new FormData(); form.set('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'confirmation.pdf');
    const before = await (await api('/api/itinerary/active', { token })).json();
    await write(`/api/bookings/${booking.id}/confirmation`, form, 'bookings');
    const after = await (await api('/api/itinerary/active', { token })).json();
    assert.equal(after.items.length, before.items.length, 'attaching a document does not create itinerary items');
    const photoForm = new FormData(); photoForm.set('photo', new Blob(['test photo'], { type: 'image/png' }), 'test.png');
    const { photo } = await write('/api/photos/upload', photoForm, 'photos');
    await write(`/api/reactions/${photo.id}`, { emoji: '❤️' }, 'photo-reactions');
    await write(`/api/comments/photo/${photo.id}`, { body: 'private comment' }, 'photo-comments');
    await write(`/api/photos/${photo.id}`, undefined, 'photos', 'DELETE');
  } finally { a.close(); b.close(); }
});
