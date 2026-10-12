/**
 * calendar-routes.test.js — a plan date must be a day on the calendar, on
 * every plan route (second boundary re-check of PR #373, 2026-10-12).
 *
 * The stop layer already refused February 30 (review of #362, finding 4), but
 * the plan routes outside it checked only a date's SHAPE, so 2027-02-30,
 * 2027-13-01, 0000-00-00, 2027-04-31 and 9999-99-99 were accepted and filed
 * rows on days that do not exist — and a later narrowing of the stop was then
 * refused with a list of them. Every plan date input now goes through
 * server/calendar-day.js:
 *   the active plan (server/living-journey.js) —
 *     POST /api/itinerary/items, PATCH /api/itinerary/items/:uid,
 *     PATCH /api/itinerary/days, POST /api/itinerary/move-day,
 *     POST /api/itinerary/swap-days;
 *   the Classic plan (server/server.js) —
 *     POST /api/phases/:id/plan, PATCH /api/phases/:id/plan/:id,
 *     PATCH /api/phases/:id/plan/days/:date, POST /api/phases/:id/plan/swap-days.
 * A refusal keeps the route's own error shape and adds `field`; nothing is
 * written. Rows already stored on an impossible day are not rewritten, and
 * reading them never fails.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { PORTS } from './helpers/ports.js';
import { startTestServer, stopTestServer, api, loginAsAlice, testTripDir } from './helpers/server.js';

const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { isCalendarDay } = require('../server/calendar-day.js');

const AGENT_KEY = 'test-hermes-key';
const NY_DAY = '2027-03-11';   // the fixture's ny stop: 2027-03-11..2027-03-14
// Shape-valid strings that are not days: overflow, month 13, year 0, April 31,
// all nines, and a 29 February in a common year.
const NOT_DAYS = ['2027-02-30', '2027-13-01', '0000-00-00', '2027-04-31', '9999-99-99', '0000-01-01', '2027-02-29', '2027-00-10', '2027-03-00', '2027-03-32'];

let alice;
const call = async (path, opts = {}) => {
  const res = await api(path, { token: alice, ...opts });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, text, body };
};
// Everything a refused write could have touched: the active plan's revisions
// and payload, and the Classic plan's items and day headlines for both stops.
async function state() {
  const parts = await Promise.all([
    call('/api/itinerary/revisions'), call('/api/itinerary/active'),
    call('/api/phases/ny/plan'), call('/api/phases/ny/plan/days'),
    call('/api/phases/colorado/plan'), call('/api/phases/colorado/plan/days'),
  ]);
  return parts.map(p => `${p.status} ${p.text}`);
}

before(async () => {
  await startTestServer({ PORT: String(PORTS.calendarRoutes) });
  alice = await loginAsAlice();
});
after(() => stopTestServer());

describe('server/calendar-day.js', () => {
  test('a real day passes; every shape-valid non-day fails; so does anything that is not the exact shape', () => {
    for (const d of ['2027-03-11', '2028-02-29', '2000-02-29', '0001-01-01', '9999-12-31', '2027-12-31']) assert.equal(isCalendarDay(d), true, d);
    for (const d of [...NOT_DAYS, '1900-02-29', '2027-3-11', '2027-03-11T00:00', ' 2027-03-11', '20270311', '', null, undefined, 20270311, ['2027-03-11']]) {
      assert.equal(isCalendarDay(d), false, JSON.stringify(d));
    }
  });
});

describe('every plan route refuses a date that is not on the calendar — 400, the route\'s own error plus `field`, nothing written', () => {
  let uid, classicId;
  before(async () => {
    const item = await call('/api/itinerary/items', { method: 'POST', body: { phase_id: 'ny', date: NY_DAY, text_he: 'פריט', text_en: 'Item' } });
    assert.equal(item.status, 201, item.text);
    uid = item.body.item_uid;
    const classic = await call('/api/phases/ny/plan', { method: 'POST', body: { date: NY_DAY, text_he: 'שוק', text_en: 'Market' } });
    assert.equal(classic.status, 201, classic.text);
    classicId = classic.body.id;
  });

  const routes = (bad) => [
    ['POST /api/itinerary/items', 'date', 'date must be YYYY-MM-DD',
      () => call('/api/itinerary/items', { method: 'POST', body: { phase_id: 'ny', date: bad, text_he: 'x' } })],
    ['PATCH /api/itinerary/items/:uid', 'date', 'date must be YYYY-MM-DD',
      () => call(`/api/itinerary/items/${uid}`, { method: 'PATCH', body: { date: bad } })],
    ['PATCH /api/itinerary/days', 'date', 'invalid_day',
      () => call('/api/itinerary/days', { method: 'PATCH', body: { phase_id: 'ny', date: bad, label_he: 'יום', label_en: 'Day' } })],
    ['POST /api/itinerary/move-day', 'date', 'invalid_date',
      () => call('/api/itinerary/move-day', { method: 'POST', body: { from_phase_id: 'ny', to_phase_id: 'colorado', date: bad } })],
    ['POST /api/itinerary/swap-days (date_a)', 'date_a', 'phase_id, date_a and date_b are required',
      () => call('/api/itinerary/swap-days', { method: 'POST', body: { phase_id: 'ny', date_a: bad, date_b: NY_DAY } })],
    ['POST /api/itinerary/swap-days (date_b)', 'date_b', 'phase_id, date_a and date_b are required',
      () => call('/api/itinerary/swap-days', { method: 'POST', body: { phase_id: 'ny', date_a: NY_DAY, date_b: bad } })],
    ['POST /api/phases/:id/plan', 'date', 'date must be YYYY-MM-DD',
      () => call('/api/phases/ny/plan', { method: 'POST', body: { date: bad, text_he: 'x' } })],
    ['PATCH /api/phases/:id/plan/:id', 'date', 'date must be YYYY-MM-DD',
      () => call(`/api/phases/ny/plan/${classicId}`, { method: 'PATCH', body: { date: bad } })],
    ['PATCH /api/phases/:id/plan/days/:date', 'date', 'date must be YYYY-MM-DD',
      () => call(`/api/phases/ny/plan/days/${bad}`, { method: 'PATCH', body: { label_he: 'יום' } })],
    ['POST /api/phases/:id/plan/swap-days (date_a)', 'date_a', 'date_a must be YYYY-MM-DD',
      () => call('/api/phases/ny/plan/swap-days', { method: 'POST', body: { date_a: bad, date_b: NY_DAY } })],
    ['POST /api/phases/:id/plan/swap-days (date_b)', 'date_b', 'date_b must be YYYY-MM-DD',
      () => call('/api/phases/ny/plan/swap-days', { method: 'POST', body: { date_a: NY_DAY, date_b: bad } })],
  ];

  for (const bad of NOT_DAYS) {
    test(`${bad} → refused on all nine routes`, async () => {
      const before = await state();
      for (const [name, field, error, send] of routes(bad)) {
        const r = await send();
        assert.equal(r.status, 400, `${name} ${bad}: ${r.text}`);
        assert.deepEqual([r.body.error, r.body.field], [error, field], `${name} ${bad}: ${r.text}`);
      }
      assert.deepEqual(await state(), before, 'nothing was written');
    });
  }

  test('real days are still accepted on the same routes', async () => {
    const day2 = '2027-03-12';
    const results = [
      await call('/api/itinerary/items', { method: 'POST', body: { phase_id: 'ny', date: day2, text_he: 'עוד' } }),
      await call(`/api/itinerary/items/${uid}`, { method: 'PATCH', body: { date: day2 } }),
      await call('/api/itinerary/days', { method: 'PATCH', body: { phase_id: 'ny', date: day2, label_he: 'יום', label_en: 'Day' } }),
      await call('/api/itinerary/swap-days', { method: 'POST', body: { phase_id: 'ny', date_a: NY_DAY, date_b: day2 } }),
      await call('/api/phases/ny/plan', { method: 'POST', body: { date: day2, text_he: 'עוד' } }),
      await call(`/api/phases/ny/plan/${classicId}`, { method: 'PATCH', body: { date: day2 } }),
      await call(`/api/phases/ny/plan/days/${day2}`, { method: 'PATCH', body: { label_he: 'יום' } }),
      await call('/api/phases/ny/plan/swap-days', { method: 'POST', body: { date_a: NY_DAY, date_b: day2 } }),
      await call('/api/itinerary/move-day', { method: 'POST', body: { from_phase_id: 'ny', to_phase_id: 'colorado', date: day2 } }),
    ];
    for (const r of results) assert.ok(r.status === 200 || r.status === 201, r.text);
  });

  test('a shape error keeps its old answer, now with `field` too', async () => {
    const r = await call('/api/phases/ny/plan', { method: 'POST', body: { date: '11/3/2027', text_he: 'x' } });
    assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'date must be YYYY-MM-DD', 'date']);
    const m = await call('/api/itinerary/move-day', { method: 'POST', body: { from_phase_id: 'ny', to_phase_id: 'colorado', date: '11/3/2027' } });
    assert.deepEqual([m.status, m.body.error, m.body.field], [400, 'invalid_date', 'date']);
  });
});

describe('a row already stored on an impossible day is not rewritten, and reading it never fails', () => {
  test('Classic row on 2027-02-30 (written by an older server): GET /plan, /plan/days, /api/config and /api/itinerary/active are 200; a text edit keeps its date', async () => {
    const db = new Database(join(dirname(testTripDir()), 'trip.db'));
    let id;
    try {
      id = Number(db.prepare("INSERT INTO phase_plan_items (phase_id, date, text_he, created_by) VALUES ('colorado', '2027-02-30', 'ישן', 'old-server')").run().lastInsertRowid);
      db.prepare("INSERT OR IGNORE INTO phase_plan_days (phase_id, date, label_he) VALUES ('colorado', '2027-02-30', 'יום ישן')").run();
    } finally { db.close(); }
    const plan = await call('/api/phases/colorado/plan');
    assert.equal(plan.status, 200, plan.text);
    assert.equal(plan.body.find(r => r.id === id)?.date, '2027-02-30');
    assert.equal((await call('/api/phases/colorado/plan/days')).status, 200);
    assert.equal((await call('/api/config')).status, 200);
    assert.equal((await call('/api/itinerary/active', { apiKey: AGENT_KEY, token: undefined })).status, 200);
    const edit = await call(`/api/phases/colorado/plan/${id}`, { method: 'PATCH', body: { text_en: 'Old' } });
    assert.equal(edit.status, 200, edit.text);
    assert.equal(edit.body.date, '2027-02-30', 'the stored date is left as it is');
  });
});
