// #550 — an activity added at the same time as another raises a conflict the organizer can accept.
// Spec: docs/specs/sprint-8/550-plan-overlap-conflicts.md (AC-1 .. AC-9).
//
// Unit half: the pure rule. HTTP half: a real trip server, organizer (alice), member (bob) and the
// agent key, because "members never see it" is only proven by a member's own response.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { freePort } from './helpers/port-guard.js';
import { startTestServer, stopTestServer, api } from './helpers/server.js';

const require = createRequire(import.meta.url);
const AGENT_KEY = 'test-hermes-key';
const PHASE = 'ny';
const DAY = '2027-03-12';
const OTHER_DAY = '2027-03-13';

describe('findPlanConflicts (the rule)', () => {
  const { findPlanConflicts, conflictKey } = require('../server/plan-conflicts.js');
  const item = (uid, time, over = {}) => ({ item_uid: uid, phase_id: PHASE, date: DAY, time, time_sort: null, duration_minutes: null, booking_id: null, text_he: uid, text_en: uid, ...over });
  const pairs = (items) => [...findPlanConflicts(items).entries()].map(([uid, others]) => [uid, others.map(o => o.item_uid)]);

  test('two items at the same exact time conflict, each naming the other', () => {
    assert.deepEqual(pairs([item('a', '10:00'), item('b', '10:00')]), [['a', ['b']], ['b', ['a']]]);
  });
  test('a duration makes the ranges meet; touching ranges do not', () => {
    assert.equal(findPlanConflicts([item('a', '10:00', { duration_minutes: 60 }), item('b', '10:30')]).size, 2);
    assert.equal(findPlanConflicts([item('a', '10:00', { duration_minutes: 60 }), item('b', '11:00')]).size, 0, 'ends exactly as the next begins');
    assert.equal(findPlanConflicts([item('a', '10:00'), item('b', '10:30')]).size, 0, 'a point and a later point');
  });
  test('rough times, other days, other stops and one booking never conflict', () => {
    assert.equal(findPlanConflicts([item('a', 'morning'), item('b', 'morning')]).size, 0, 'a rough time is a sort position');
    assert.equal(findPlanConflicts([item('a', 'morning'), item('b', '09:00')]).size, 0);
    assert.equal(findPlanConflicts([item('a', '10:00'), item('b', '10:00', { date: OTHER_DAY })]).size, 0);
    assert.equal(findPlanConflicts([item('a', '10:00'), item('b', '10:00', { phase_id: 'colorado' })]).size, 0);
    assert.equal(findPlanConflicts([item('a', '10:00', { booking_id: 7 }), item('b', '10:00', { booking_id: 7 })]).size, 0, 'one reservation');
    assert.equal(findPlanConflicts([item('a', null), item('b', null)]).size, 0);
    assert.equal(findPlanConflicts([item('a', '10:00', { date: null }), item('b', '10:00', { date: null })]).size, 0, 'undated');
  });
  test('AC-11: two bookings of the same flight are one flight, not a conflict', () => {
    const flight = (uid, booking_id, over = {}) => item(uid, '08:00', { booking_id, text_en: 'SL 482 Harbortown → Gatecity', text_he: 'SL 482 הארבורטאון → גייטסיטי', item_type: 'booking', ...over });
    assert.equal(findPlanConflicts([flight('a', 1), flight('b', 2)]).size, 0, 'QX7P2M and ZT3K9D');
    assert.equal(findPlanConflicts([flight('a', 1), flight('b', 2, { text_en: '  sl 482   harbortown → GATECITY ' })]).size, 0, 'case and spacing aside');
    assert.equal(findPlanConflicts([flight('a', 1, { text_en: 'Flight SL 482 to Gatecity' }), flight('b', 2, { text_en: 'flight sl 482 to gatecity' })]).size, 0, 'the word "flight" and a lower-case designator are read');
    assert.equal(findPlanConflicts([flight('a', 1, { text_en: 'SL 482 Harbortown', booking: { type: 'flight' } }), flight('b', 2, { text_en: 'SL 482 Harbortown', booking: { type: 'flight' } })]).size, 0, 'a flight booking needs no arrow');
    // Not provably the same flight: still raised.
    assert.equal(findPlanConflicts([flight('a', 1), flight('b', 2, { text_en: 'SL 482 Gatecity → Capital', text_he: 'SL 482 גייטסיטי → בירה' })]).size, 2, 'two legs on one flight number');
    assert.equal(findPlanConflicts([flight('a', 1), flight('b', 2, { date: OTHER_DAY })]).size, 0, 'a different day is no conflict anyway');
  });
  test('AC-11: different flights at one time, and a flight with an activity, still conflict', () => {
    const flight = (uid, text_en, booking_id) => item(uid, '08:00', { booking_id, text_en, text_he: text_en, item_type: 'booking' });
    assert.equal(findPlanConflicts([flight('a', 'SL 482 Harbortown → Gatecity', 1), flight('b', 'LY 8801 Tel Aviv → Athens', 2)]).size, 2, 'two different flights');
    assert.equal(findPlanConflicts([flight('a', 'SL 482 Harbortown → Gatecity', 1), item('b', '08:00', { text_en: 'Breakfast' })]).size, 2, 'a flight and an activity');
  });
  test('AC-11: text that is not a flight number is never skipped', () => {
    const line = (uid) => item(uid, '08:00', { text_en: 'Museum 12 → café', text_he: 'Museum 12 → café', booking_id: uid === 'a' ? 1 : 2 });
    assert.equal(findPlanConflicts([line('a'), line('b')]).size, 2, '"Museum 12" is not a flight');
    const bare = (uid) => item(uid, '08:00', { text_en: 'Harbortown → Gatecity', text_he: 'Harbortown → Gatecity', booking_id: uid === 'a' ? 1 : 2 });
    assert.equal(findPlanConflicts([bare('a'), bare('b')]).size, 2, 'an unnumbered line is never grouped');
  });
  test('the key is the same whichever item is named first, and changes when a time changes', () => {
    const a = item('a', '10:00'), b = item('b', '10:00');
    assert.equal(conflictKey(a, b), conflictKey(b, a));
    assert.notEqual(conflictKey(a, b), conflictKey(a, item('b', '10:30')));
  });
});

describe('plan conflicts over HTTP (#550)', () => {
  let alice, bob;
  const as = (token) => ({ token });
  const active = async (token) => (await (await api('/api/itinerary/active', { token })).json());
  const byText = (payload, text) => payload.items.find(i => i.text_en === text);
  const addModern = async (text_en, time, extra = {}) => {
    const res = await api('/api/itinerary/items', { method: 'POST', token: alice, body: { phase_id: PHASE, date: DAY, time, text_he: text_en, text_en, ...extra } });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()).item_uid;
  };
  const keepBoth = (uid, withUid, who = alice) => api(`/api/itinerary/items/${encodeURIComponent(uid)}/keep-both`, { method: 'POST', ...(who === 'agent' ? { apiKey: AGENT_KEY } : { token: who }), body: withUid === undefined ? {} : { with: withUid } });

  before(async () => {
    await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() });
    const login = async (username) => {
      for (let i = 0; i < 30; i++) {
        const r = await api('/api/auth/login', { method: 'POST', body: { username, password: '1234' } });
        if (r.ok) return (await r.json()).token;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`login ${username}`);
    };
    alice = await login('alice');
    bob = await login('bob');
  });
  after(stopTestServer);

  test('AC-1/AC-3: an item added at an occupied time raises a conflict for the organizer, never for a member', async () => {
    const first = await addModern('Louvre visit', '10:00');
    const second = await addModern('Pottery class', '10:00');
    const organizer = await active(alice);
    const a = byText(organizer, 'Louvre visit'), b = byText(organizer, 'Pottery class');
    assert.deepEqual(a.plan_conflicts.map(c => c.item_uid), [second]);
    assert.deepEqual(b.plan_conflicts.map(c => c.item_uid), [first]);
    assert.equal(b.plan_conflicts[0].text_en, 'Louvre visit');
    assert.equal(b.plan_conflicts[0].time, '10:00');

    const memberRes = await api('/api/itinerary/active', { token: bob });
    const memberText = await memberRes.text();
    assert.equal(memberRes.status, 200);
    assert.ok(!memberText.includes('plan_conflicts'), 'the key is absent from a member payload, not merely empty');
    assert.ok(byText(JSON.parse(memberText), 'Pottery class'), 'the member still sees the plan itself');
  });

  test('AC-2: the Classic/agent route raises it too', async () => {
    const res = await api(`/api/phases/${PHASE}/plan`, { method: 'POST', apiKey: AGENT_KEY, body: { date: DAY, time: '15:00', text_he: 'Seine cruise', text_en: 'Seine cruise' } });
    assert.equal(res.status, 201);
    const res2 = await api(`/api/phases/${PHASE}/plan`, { method: 'POST', apiKey: AGENT_KEY, body: { date: DAY, time: '15:00', text_he: 'Wine tasting', text_en: 'Wine tasting' } });
    assert.equal(res2.status, 201);
    const organizer = await active(alice);
    assert.equal(byText(organizer, 'Seine cruise').plan_conflicts[0].text_en, 'Wine tasting');
    assert.equal(byText(organizer, 'Wine tasting').plan_conflicts[0].text_en, 'Seine cruise');
    const agent = await (await api('/api/itinerary/active', { apiKey: AGENT_KEY })).json();
    assert.ok(byText(agent, 'Seine cruise').plan_conflicts, 'the agent reads it as the organizer does');
  });

  test('AC-4/AC-9: a member cannot accept, an anonymous caller cannot, a non-conflict is refused', async () => {
    const organizer = await active(alice);
    const a = byText(organizer, 'Louvre visit'), b = byText(organizer, 'Pottery class');
    assert.equal((await keepBoth(a.item_uid, b.item_uid, bob)).status, 403);
    assert.equal((await api(`/api/itinerary/items/${a.item_uid}/keep-both`, { method: 'POST', body: { with: b.item_uid } })).status, 401);
    assert.ok(byText(await active(alice), 'Louvre visit').plan_conflicts, 'the refused calls recorded nothing');

    const lone = await addModern('Lunch', '12:00');
    const r409 = await keepBoth(lone, a.item_uid);
    assert.equal(r409.status, 409);
    assert.equal((await r409.json()).error, 'no_conflict');
    assert.equal((await keepBoth('no-such-item', a.item_uid)).status, 404);
    assert.equal((await keepBoth(a.item_uid, undefined)).status, 400);
    assert.equal((await keepBoth(a.item_uid, 42)).status, 400);
  });

  test('AC-5: keep both clears the conflict on both items, and it does not come back', async () => {
    const organizer = await active(alice);
    const a = byText(organizer, 'Louvre visit'), b = byText(organizer, 'Pottery class');
    const res = await keepBoth(a.item_uid, b.item_uid);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const after1 = await active(alice);
    assert.equal(byText(after1, 'Louvre visit').plan_conflicts, undefined);
    assert.equal(byText(after1, 'Pottery class').plan_conflicts, undefined);
    // Unrelated edits and a repeat of the answer leave it accepted.
    await api(`/api/itinerary/items/${b.item_uid}`, { method: 'PATCH', token: alice, body: { text_en: 'Pottery class (kids)' } });
    assert.equal(byText(await active(alice), 'Pottery class (kids)').plan_conflicts, undefined, 'a text edit is not a new conflict');
    assert.equal((await keepBoth(b.item_uid, a.item_uid)).status, 200, 'idempotent, from either side');
  });

  test('AC-5: the agent key may accept (organizerOrAgentRequired)', async () => {
    const organizer = await active(alice);
    const a = byText(organizer, 'Seine cruise'), b = byText(organizer, 'Wine tasting');
    assert.equal((await keepBoth(a.item_uid, b.item_uid, 'agent')).status, 200);
    assert.equal(byText(await active(alice), 'Seine cruise').plan_conflicts, undefined);
  });

  test('AC-6: a third item at the same time conflicts with each; the accepted pair stays accepted', async () => {
    const third = await addModern('Walking tour', '10:00');
    const organizer = await active(alice);
    const t = byText(organizer, 'Walking tour');
    assert.deepEqual(t.plan_conflicts.map(c => c.text_en).sort(), ['Louvre visit', 'Pottery class (kids)']);
    assert.equal(t.item_uid, third);
    assert.deepEqual(byText(organizer, 'Louvre visit').plan_conflicts.map(c => c.text_en), ['Walking tour'], 'only the new one; the old pair is accepted');
  });

  test('AC-7: moving to an overlap at different times is a new conflict; moving away clears it', async () => {
    const organizer = await active(alice);
    const a = byText(organizer, 'Louvre visit'), b = byText(organizer, 'Pottery class (kids)'), t = byText(organizer, 'Walking tour');
    await keepBoth(t.item_uid, a.item_uid); await keepBoth(t.item_uid, b.item_uid);
    assert.ok(!byText(await active(alice), 'Walking tour').plan_conflicts, 'all three accepted at 10:00');
    // Give the Louvre a duration, then put the pottery class inside it: a different pair-of-times.
    await api(`/api/itinerary/items/${a.item_uid}`, { method: 'PATCH', token: alice, body: { duration_minutes: 60 } });
    await api(`/api/itinerary/items/${b.item_uid}`, { method: 'PATCH', token: alice, body: { time: '10:30' } });
    const moved = await active(alice);
    assert.deepEqual(byText(moved, 'Louvre visit').plan_conflicts.map(c => c.text_en), ['Pottery class (kids)'], 'new times, new conflict');
    assert.equal(byText(moved, 'Walking tour').plan_conflicts, undefined, 'a 10:00 point is not inside 10:30, nothing else meets it');
    await api(`/api/itinerary/items/${b.item_uid}`, { method: 'PATCH', token: alice, body: { time: '16:00' } });
    assert.ok(!byText(await active(alice), 'Louvre visit').plan_conflicts, 'moved clear of it');
  });

  test('AC-11: two bookings of one flight raise nothing over HTTP; a different flight at that time does', async () => {
    const flight = (text_en, booking_id) => addModern(text_en, '06:00', { booking_id, item_type: 'booking' });
    await flight('SL 482 Harbortown → Gatecity', 101);
    await flight('SL 482 Harbortown → Gatecity', 102);
    let organizer = await active(alice);
    assert.ok(!organizer.items.filter(i => i.text_en === 'SL 482 Harbortown → Gatecity').some(i => i.plan_conflicts), 'the two SL 482 copies');
    await flight('LY 8801 Tel Aviv → Athens', 103);
    organizer = await active(alice);
    const ly = byText(organizer, 'LY 8801 Tel Aviv → Athens');
    assert.equal(ly.plan_conflicts.length, 2, 'a different flight conflicts with each SL 482 copy');
    const sl = organizer.items.find(i => i.text_en === 'SL 482 Harbortown → Gatecity');
    assert.deepEqual(sl.plan_conflicts.map(c => c.text_en), ['LY 8801 Tel Aviv → Athens']);
    // The accept route applies the same rule: the two SL 482 copies are not a pair to accept.
    const [c1, c2] = organizer.items.filter(i => i.text_en === 'SL 482 Harbortown → Gatecity');
    assert.equal((await keepBoth(c1.item_uid, c2.item_uid)).status, 409);
    assert.equal((await keepBoth(c1.item_uid, ly.item_uid)).status, 200);
  });

  test('AC-8: nothing is raised for different days or rough times', async () => {
    await addModern('Morning market', 'morning');
    await addModern('Morning walk', 'morning');
    await api('/api/itinerary/items', { method: 'POST', token: alice, body: { phase_id: PHASE, date: OTHER_DAY, time: '10:00', text_he: 'Next-day thing', text_en: 'Next-day thing' } });
    const organizer = await active(alice);
    assert.ok(!byText(organizer, 'Morning market').plan_conflicts);
    assert.ok(!byText(organizer, 'Next-day thing').plan_conflicts);
  });
});
