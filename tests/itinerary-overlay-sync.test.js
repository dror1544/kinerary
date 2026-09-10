/**
 * itinerary-overlay-sync.test.js — where Classic's plan overlay meets the
 * Modern itinerary.
 *
 * Two real bugs, both in the seam between the compatibility tables
 * (phase_plan_items/phase_plan_days, which Classic edits) and the versioned
 * itinerary revisions (which Modern renders):
 *
 *   A. Classic treats its plan tables as an overlay that supersedes the config
 *      schedule the moment they are non-empty — one added row therefore looks
 *      exactly like a complete plan. syncFromLegacy() believed it, and the
 *      first Classic edit wrote that single row over an itinerary that still
 *      held the config schedule. Three items became one.
 *
 *   B. PATCH /api/itinerary/items moved an item's date without creating the
 *      day it was moving to. The write returned 200 and the item vanished:
 *      itinerary.days is what drives Modern's day picker, and the destination
 *      was not in it.
 *
 * The fixture's `ny` phase carries three config items on a single day, which
 * is the shape both bugs need.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PORTS } from './helpers/ports.js';
import { startTestServer, stopTestServer, api } from './helpers/server.js';

// Matches HERMES_API_KEY in startTestServer() — the service-account path, so
// these tests don't depend on which fixture user happens to be an organizer.
const AGENT_KEY = 'test-hermes-key';
const PHASE     = 'ny';
const CONFIG_DAY = '2027-03-11';

const active = async () => (await api('/api/itinerary/active', { apiKey: AGENT_KEY })).json();

before(async () => { await startTestServer({ PORT: String(PORTS.itineraryOverlaySync) }); });
after(() => stopTestServer());

describe('A. A Classic edit adds to the itinerary instead of replacing it', () => {
  let configItemCount;

  test('the itinerary starts as the config schedule', async () => {
    const itinerary = await active();
    configItemCount = itinerary.items.length;
    assert.ok(configItemCount >= 3,
      `fixture should seed the itinerary from config, got ${configItemCount} items`);
    assert.ok(itinerary.items.every(item => item.source_ref),
      'config-imported items should carry the source_ref they are adopted by');
  });

  test('adding one Classic plan item keeps every config item', async () => {
    const res = await api(`/api/phases/${PHASE}/plan`, {
      method: 'POST', apiKey: AGENT_KEY,
      body: { date: CONFIG_DAY, text_he: 'תוספת מהמסך הקלאסי', text_en: 'Added from Classic' },
    });
    assert.equal(res.status, 201);

    const itinerary = await active();
    assert.equal(itinerary.items.length, configItemCount + 1,
      'the config schedule must survive the first Classic write, not be replaced by it');
    assert.ok(itinerary.items.some(item => item.text_en === 'Added from Classic'),
      'the new Classic item should reach the itinerary');
    assert.ok(itinerary.days.some(day => day.date === CONFIG_DAY),
      'the config day must still be there to render the items on');
  });

  test('a second Classic write does not truncate it either', async () => {
    const res = await api(`/api/phases/${PHASE}/plan`, {
      method: 'POST', apiKey: AGENT_KEY,
      body: { date: CONFIG_DAY, text_he: 'תוספת שנייה', text_en: 'Second Classic addition' },
    });
    assert.equal(res.status, 201);
    const itinerary = await active();
    assert.equal(itinerary.items.length, configItemCount + 2,
      'carrying the config schedule forward has to be a standing rule, not a one-off');
  });

  test('deleting a Classic item removes only that item', async () => {
    const rows = await (await api(`/api/phases/${PHASE}/plan`, { apiKey: AGENT_KEY })).json();
    const second = rows.find(row => row.text_en === 'Second Classic addition');
    assert.ok(second, 'the item just added should be in the Classic plan');

    const res = await api(`/api/phases/${PHASE}/plan/${second.id}`, { method: 'DELETE', apiKey: AGENT_KEY });
    assert.equal(res.status, 200);

    const itinerary = await active();
    assert.equal(itinerary.items.length, configItemCount + 1);
    assert.ok(!itinerary.items.some(item => item.text_en === 'Second Classic addition'),
      'a deleted item must stay deleted');
    assert.ok(itinerary.items.some(item => item.text_en === 'Added from Classic'),
      'and the other Classic addition must not go with it');
  });

  test('once the config schedule is promoted, the overlay is the whole plan', async () => {
    // promote-config-days is what actually moves the config items into the
    // compatibility tables. From then on those tables really are the plan, so
    // a delete there has to be a delete here — the carry-forward must not
    // resurrect a promoted item the organizer removed.
    const promote = await api('/api/phase-plan/promote-config-days', { method: 'POST', apiKey: AGENT_KEY });
    assert.equal(promote.status, 200);

    const rows = await (await api(`/api/phases/${PHASE}/plan`, { apiKey: AGENT_KEY })).json();
    const promoted = rows.find(row => row.config_ref);
    assert.ok(promoted, 'promotion should write rows carrying a config_ref');

    const before = (await active()).items.length;
    const res = await api(`/api/phases/${PHASE}/plan/${promoted.id}`, { method: 'DELETE', apiKey: AGENT_KEY });
    assert.equal(res.status, 200);

    const itinerary = await active();
    assert.equal(itinerary.items.length, before - 1,
      'a promoted item the organizer deleted must not be carried forward again');
    assert.ok(!itinerary.items.some(item => item.source_ref === promoted.config_ref),
      `${promoted.config_ref} was deleted in Classic and came back`);
  });
});

describe('B. Moving an itinerary item to a day that does not exist yet', () => {
  const DESTINATION = '2027-03-19';
  let uid;

  test('an item can be added to the itinerary', async () => {
    const res = await api('/api/itinerary/items', {
      method: 'POST', apiKey: AGENT_KEY,
      body: { phase_id: PHASE, date: CONFIG_DAY, text_he: 'פריט להזזה', text_en: 'Item to move' },
    });
    assert.equal(res.status, 201);
    ({ item_uid: uid } = await res.json());
  });

  test('moving it to an unused date creates the day it lands on', async () => {
    const res = await api(`/api/itinerary/items/${uid}`, {
      method: 'PATCH', apiKey: AGENT_KEY, body: { date: DESTINATION },
    });
    assert.equal(res.status, 200);

    const itinerary = await active();
    const moved = itinerary.items.find(item => item.item_uid === uid);
    assert.ok(moved, 'the moved item should still be in the itinerary');
    assert.equal(moved.date, DESTINATION);
    assert.ok(itinerary.days.some(day => day.date === DESTINATION && day.phase_id === PHASE),
      'itinerary.days drives the day picker — without the destination the item is invisible');
  });

  test('the destination day is created once, not on every later edit', async () => {
    const res = await api(`/api/itinerary/items/${uid}`, {
      method: 'PATCH', apiKey: AGENT_KEY, body: { text_en: 'Item to move, retitled' },
    });
    assert.equal(res.status, 200);
    const itinerary = await active();
    assert.equal(itinerary.days.filter(day => day.date === DESTINATION && day.phase_id === PHASE).length, 1,
      'a text edit is not a move and must not add a duplicate day row');
  });

  test('a move back to an existing day adds no duplicate either', async () => {
    const res = await api(`/api/itinerary/items/${uid}`, {
      method: 'PATCH', apiKey: AGENT_KEY, body: { date: CONFIG_DAY },
    });
    assert.equal(res.status, 200);
    const itinerary = await active();
    assert.equal(itinerary.days.filter(day => day.date === CONFIG_DAY && day.phase_id === PHASE).length, 1);
    assert.equal(itinerary.items.find(item => item.item_uid === uid).date, CONFIG_DAY);
  });
});
