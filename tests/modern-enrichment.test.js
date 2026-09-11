import { PORTS } from './helpers/ports.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { before, after, test } from 'node:test';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

let service;
let heldResponse;
const key = 'test-hermes-key';
before(async () => {
  service = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const respond = () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text_en: `${input.text_he} EN`, maps_url: `https://example.com/${encodeURIComponent(input.text_he)}`, website_url: 'https://example.com/website' }));
    };
    if (input.text_he === 'ישן ממתין') heldResponse = respond;
    else respond();
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  await startTestServer({ PORT: PORTS.modernEnrichment, HERMES_URL: `http://127.0.0.1:${service.address().port}` });
  await loginAsAlice();
});
after(() => { heldResponse?.(); stopTestServer(); service?.closeAllConnections(); service?.close(); });
async function write(path, body, method = 'POST') {
  const response = await api(path, { method, body, apiKey: key });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
const itinerary = async () => (await api('/api/itinerary/active', { auth: true })).json();
const item = async uid => (await itinerary()).items.find(row => row.item_uid === uid);
async function until(read, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('enrichment did not reach the expected state');
}
const createItem = values => write('/api/itinerary/items', { phase_id: 'ny', date: '2026-08-01', text_he: 'ארוחה', ...values });

test('enrichment preserves item metadata, unrelated items and day context', async () => {
  const before = await itinerary();
  const created = await createItem({ item_type: 'meal', duration_minutes: 90, confirmation_state: 'verified' });
  const result = await until(() => item(created.item_uid), row => !!row.text_en);
  assert.equal(result.item_type, 'meal');
  assert.equal(result.duration_minutes, 90);
  assert.equal(result.confirmation_state, 'verified');
  const after = await itinerary();
  assert.deepEqual(after.days.filter(day => before.days.some(old => old.date === day.date && old.phase_id === day.phase_id)).map(({ revision_id, ...day }) => day), before.days.map(({ revision_id, ...day }) => day));
  for (const old of before.items) {
    const { revision_id: oldRevision, ...expected } = old;
    const { revision_id: newRevision, ...actual } = after.items.find(row => row.item_uid === old.item_uid);
    assert.deepEqual(actual, expected);
  }
});

test('title edits requeue generated values but retain authored translations and links', async () => {
  const created = await createItem({ text_he: 'מוזיאון' });
  const enriched = await until(() => item(created.item_uid), row => !!row.text_en);
  // The editor submits the current translation and location along with its edited title.
  const saved = await write(`/api/itinerary/items/${created.item_uid}`, { text_he: 'מסעדה', text_en: enriched.text_en, location_url: enriched.location_url }, 'PATCH');
  assert.deepEqual(saved.enrichment, { configured: true, queued: true });
  const pending = await item(created.item_uid);
  assert.equal(pending.text_en, null);
  assert.equal(pending.location_url, null);
  const updated = await until(() => item(created.item_uid), row => row.text_en === 'מסעדה EN');
  assert.equal(updated.location_url, `https://example.com/${encodeURIComponent('מסעדה')}`);
  const manual = await createItem({ text_he: 'פארק', text_en: 'My translation', location_url: 'https://example.org/manual' });
  await until(() => item(manual.item_uid), row => !!row.website_url);
  await write(`/api/itinerary/items/${manual.item_uid}`, { text_he: 'גן אחר', text_en: 'My translation', location_url: 'https://example.org/manual' }, 'PATCH');
  const kept = await until(() => item(manual.item_uid), row => !!row.website_url);
  assert.equal(kept.text_en, 'My translation');
  assert.equal(kept.location_url, 'https://example.org/manual');
});

test('a late enrichment response cannot overwrite a newer title edit', async () => {
  const created = await createItem({ text_he: 'ישן ממתין' });
  await until(() => heldResponse, Boolean);
  await write(`/api/itinerary/items/${created.item_uid}`, { text_he: 'חדש' }, 'PATCH');
  heldResponse(); heldResponse = undefined;
  // Queue another pass after the old one has returned.
  await new Promise(resolve => setTimeout(resolve, 100));
  await write('/api/phase-plan/enrich-pending', {});
  const current = await until(() => item(created.item_uid), row => row.text_en === 'חדש EN');
  assert.equal(current.text_he, 'חדש');
  assert.ok(!current.location_url.includes(encodeURIComponent('ישן ממתין')));
});
