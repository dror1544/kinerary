/**
 * itinerary-move-day.test.js — validated cross-stop moves (slice S1).
 *
 * Run notes F6 (2026-10-10): the plan editor could not move a day, or even an
 * item, from one stop to another. Plan items are keyed by phase_id; the
 * Classic PATCH did not accept phase_id at all, swap-days swaps two dates
 * inside ONE phase, and the Modern PATCH accepted any phase_id string without
 * checking it — a typo filed an item under a phase no route can reach.
 *
 * This file pins:
 *   - POST /api/itinerary/move-day: a whole day (items + headline) moves to
 *     another stop in one revision, both stops are queued for wording review;
 *   - the three latent validations: Modern item phase_id, Classic PATCH
 *     phase_id (now allowed, and checked), and a booking's phase.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PORTS } from './helpers/ports.js';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

const AGENT_KEY = 'test-hermes-key';
const PORT = PORTS.itineraryMoveDay;
const BASE = `http://localhost:${PORT}`;
const DAY = '2027-03-11';   // ny's config day: three items and a headline

let alice, bob;
const active = async () => (await api('/api/itinerary/active', { apiKey: AGENT_KEY })).json();
async function moveDay(body, { token = alice, ifMatch } = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (ifMatch) headers['If-Match'] = ifMatch;
  const res = await fetch(`${BASE}/api/itinerary/move-day`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  await startTestServer({ PORT: String(PORT) });
  alice = await loginAsAlice();
  const r = await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } });
  bob = (await r.json()).token;
});
after(() => stopTestServer());

describe('POST /api/itinerary/move-day', () => {
  test('organizer or agent only', async () => {
    const body = { from_phase_id: 'ny', date: DAY, to_phase_id: 'colorado' };
    const anon = await fetch(`${BASE}/api/itinerary/move-day`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(anon.status, 401);
    assert.equal((await moveDay(body, { token: bob })).status, 403);
  });

  test('refusals: unknown source, unknown target, same stop, bad date, empty day', async () => {
    const cases = [
      [{ from_phase_id: 'nowhere', date: DAY, to_phase_id: 'colorado' }, 400, 'unknown_phase'],
      [{ from_phase_id: 'ny', date: DAY, to_phase_id: 'nowhere' }, 400, 'unknown_stop'],
      [{ from_phase_id: 'ny', date: DAY, to_phase_id: 'ny' }, 400, 'same_phase'],
      [{ from_phase_id: 'ny', date: '11/3/2027', to_phase_id: 'colorado' }, 400, 'invalid_date'],
      [{ from_phase_id: 'ny', date: '2027-03-12', to_phase_id: 'colorado' }, 404, 'day_not_found'],
    ];
    for (const [body, status, error] of cases) {
      const r = await moveDay(body);
      assert.equal(r.status, status, JSON.stringify([body, r.body]));
      assert.equal(r.body.error, error);
    }
  });

  test('a stale If-Match is refused with 409', async () => {
    const r = await moveDay({ from_phase_id: 'ny', date: DAY, to_phase_id: 'colorado' }, { ifMatch: 'active_stale_revision' });
    assert.equal(r.status, 409);
  });

  test('the whole day — items and headline — moves to the other stop in one revision', async () => {
    const before = await active();
    const dayItems = before.items.filter(i => i.phase_id === 'ny' && i.date === DAY);
    assert.ok(dayItems.length >= 3, 'fixture day carries three items');
    const r = await moveDay({ from_phase_id: 'ny', date: DAY, to_phase_id: 'colorado' }, { ifMatch: before.revision });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.moved.items.sort(), dayItems.map(i => i.item_uid).sort());
    assert.equal(r.body.moved.headline, true);
    assert.deepEqual(r.body.review.phases, ['ny', 'colorado']);

    const after = await active();
    assert.notEqual(after.revision, before.revision);
    assert.ok(!after.items.some(i => i.phase_id === 'ny' && i.date === DAY));
    assert.equal(after.items.filter(i => i.phase_id === 'colorado' && i.date === DAY).length, dayItems.length);
    const headline = after.days.find(d => d.date === DAY && d.phase_id === 'colorado');
    assert.equal(headline?.label_en, 'Sun 11/3 — New York');
    assert.ok(!after.days.some(d => d.date === DAY && d.phase_id === 'ny'));

    // The Classic tables say the same, and both stops are queued for review.
    const colorado = await (await api('/api/phases/colorado/plan', { token: alice })).json();
    assert.equal(colorado.filter(i => i.date === DAY).length, dayItems.length);
    assert.ok(colorado.every(i => i.review_status === 'pending'));
    const days = await (await api('/api/phases/colorado/plan/days', { token: alice })).json();
    assert.equal(days.find(d => d.date === DAY)?.label_en, 'Sun 11/3 — New York');
    assert.ok(!(await (await api('/api/phases/ny/plan/days', { token: alice })).json()).some(d => d.date === DAY));
  });

  test('two headlines on one date are a conflict the caller resolves, never silently dropped', async () => {
    const set = await api('/api/itinerary/days', { method: 'PATCH', token: alice,
      body: { phase_id: 'ny', date: DAY, label_he: 'כותרת שנייה', label_en: 'Second headline' } });
    assert.equal(set.status, 200);
    await api('/api/itinerary/items', { method: 'POST', token: alice, body: { phase_id: 'ny', date: DAY, text_he: 'עוד', text_en: 'One more' } });
    const conflict = await moveDay({ from_phase_id: 'ny', date: DAY, to_phase_id: 'colorado' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'target_day_has_headline');
    const kept = await moveDay({ from_phase_id: 'ny', date: DAY, to_phase_id: 'colorado', headline: 'keep_target' });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    const day = (await active()).days.find(d => d.date === DAY && d.phase_id === 'colorado');
    assert.equal(day.label_en, 'Sun 11/3 — New York');
  });
});

describe('latent validation 1: the Modern item PATCH/POST checks phase_id', () => {
  test('an unknown phase is refused; a known one moves the item and creates its day', async () => {
    const created = await api('/api/itinerary/items', { method: 'POST', token: alice, body: { phase_id: 'ny', date: '2027-03-12', text_he: 'מוזיאון', text_en: 'Museum' } });
    assert.equal(created.status, 201);
    const { item_uid } = await created.json();
    const bad = await api(`/api/itinerary/items/${item_uid}`, { method: 'PATCH', token: alice, body: { phase_id: 'nyc-typo' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'unknown phase');
    assert.equal((await active()).items.find(i => i.item_uid === item_uid).phase_id, 'ny');
    const good = await api(`/api/itinerary/items/${item_uid}`, { method: 'PATCH', token: alice, body: { phase_id: 'colorado' } });
    assert.equal(good.status, 200);
    const after = await active();
    assert.equal(after.items.find(i => i.item_uid === item_uid).phase_id, 'colorado');
    assert.ok(after.days.some(d => d.phase_id === 'colorado' && d.date === '2027-03-12'));
    const post = await api('/api/itinerary/items', { method: 'POST', token: alice, body: { phase_id: 'nyc-typo', date: '2027-03-12', text_he: 'x' } });
    assert.equal(post.status, 400);
  });
});

describe('latent validation 2: the Classic PATCH accepts phase_id, and checks it', () => {
  test('an item moves between stops; an unknown target is refused; both stops are queued for review', async () => {
    const made = await api('/api/phases/ny/plan', { method: 'POST', token: alice, body: { date: '2027-03-13', text_he: 'ארוחה', text_en: 'Dinner out' } });
    assert.equal(made.status, 201);
    const { id } = await made.json();
    const bad = await api(`/api/phases/ny/plan/${id}`, { method: 'PATCH', token: alice, body: { phase_id: 'atlantis' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'unknown phase');
    const moved = await api(`/api/phases/ny/plan/${id}`, { method: 'PATCH', token: alice, body: { phase_id: 'colorado' } });
    assert.equal(moved.status, 200);
    const body = await moved.json();
    assert.equal(body.phase_id, 'colorado');
    assert.deepEqual(body.review?.phases, ['ny', 'colorado']);
    const colorado = await (await api('/api/phases/colorado/plan', { token: alice })).json();
    assert.ok(colorado.some(i => i.id === id && i.review_status === 'pending'));
    const ny = await (await api('/api/phases/ny/plan', { token: alice })).json();
    assert.ok(!ny.some(i => i.id === id));
    assert.ok((await active()).items.some(i => i.text_en === 'Dinner out' && i.phase_id === 'colorado'));
  });
});

describe('latent validation 3: a booking\'s phase must be a known stop, intl_flights or general', () => {
  test('POST and PATCH', async () => {
    const bad = await api('/api/bookings', { method: 'POST', token: alice, body: { phase: 'atlantis', type: 'other', name: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'unknown phase');
    for (const phase of ['ny', 'intl_flights', 'general']) {
      const ok = await api('/api/bookings', { method: 'POST', token: alice, body: { phase, type: 'other', name: `in ${phase}` } });
      assert.equal(ok.status, 200, phase);
    }
    const { id } = await (await api('/api/bookings', { method: 'POST', token: alice, body: { phase: 'ny', type: 'other', name: 'to patch' } })).json();
    const patchBad = await api(`/api/bookings/${id}`, { method: 'PATCH', token: alice, body: { phase: 'atlantis' } });
    assert.equal(patchBad.status, 400);
    assert.equal((await api(`/api/bookings/${id}`, { method: 'PATCH', token: alice, body: { phase: 'colorado' } })).status, 200);
  });
});
