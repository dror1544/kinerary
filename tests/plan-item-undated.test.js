// An undated plan item is a legitimate thing (an idea with no day yet), but the companion used to file a
// NAMED day as "no day" and then report success: the create response looked the same either way.
//
//   C. the create/update response says so when the stored item is on no day
//   A. (server half) an undated item reaches the modern site's itinerary with date null, and the
//      organizer's own edit path (PATCH /api/itinerary/items/:uid) puts it on a day without
//      duplicating or orphaning the legacy row
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { freePort } from './helpers/port-guard.js';
import { startTestServer, stopTestServer, api } from './helpers/server.js';

const require = createRequire(import.meta.url);
const AGENT_KEY = 'test-hermes-key';
const PHASE = 'ny';
const DAY = '2027-03-12';

describe('plan item with no day', () => {
  let alice, bob;
  const plan = async () => (await (await api(`/api/phases/${PHASE}/plan`, { apiKey: AGENT_KEY })).json());
  const active = async () => (await (await api('/api/itinerary/active', { token: alice })).json());

  before(async () => {
    await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() });
    const login = async (username) => {
      for (let i = 0; i < 30; i++) {
        const r = await api('/api/auth/login', { method: 'POST', body: { username, password: '1234' } });
        if (r.ok) return (await r.json()).token;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`login ${username}`);
    };
    alice = await login('alice');
    bob = await login('bob');
  });
  after(() => stopTestServer());

  test('C: creating an item with no date says it is on no day, and keeps the item fields at top level', async () => {
    const res = await api(`/api/phases/${PHASE}/plan`, { method: 'POST', apiKey: AGENT_KEY, body: { time: '19:30', text_he: 'ארוחת ערב', text_en: 'Dinner' } });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.unscheduled, true);
    assert.match(body.note, /no day/i);
    assert.match(body.note, /Not on a day yet/);
    assert.match(body.note, /date/);
    // The shape callers read is unchanged.
    assert.equal(typeof body.id, 'number');
    assert.equal(body.date, null);
    assert.equal(body.text_en, 'Dinner');
    assert.equal(body.time, '19:30');
  });

  test('C: an item created with a date carries neither field', async () => {
    const res = await api(`/api/phases/${PHASE}/plan`, { method: 'POST', apiKey: AGENT_KEY, body: { date: DAY, text_he: 'פארק', text_en: 'Park' } });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.date, DAY);
    assert.equal('unscheduled' in body, false);
    assert.equal('note' in body, false);
  });

  test('C: PATCH that clears a date says so; PATCH that sets one does not; an organizer gets the same as the agent', async () => {
    const created = await (await api(`/api/phases/${PHASE}/plan`, { method: 'POST', token: alice, body: { date: DAY, text_he: 'מוזיאון', text_en: 'Museum' } })).json();
    assert.equal('unscheduled' in created, false);
    const cleared = await (await api(`/api/phases/${PHASE}/plan/${created.id}`, { method: 'PATCH', token: alice, body: { date: null } })).json();
    assert.equal(cleared.date, null);
    assert.equal(cleared.unscheduled, true);
    assert.match(cleared.note, /no day/i);
    const placed = await (await api(`/api/phases/${PHASE}/plan/${created.id}`, { method: 'PATCH', apiKey: AGENT_KEY, body: { date: DAY } })).json();
    assert.equal(placed.date, DAY);
    assert.equal('unscheduled' in placed, false);
    assert.equal('note' in placed, false);
  });

  test('C: a member still cannot create plan items', async () => {
    const res = await api(`/api/phases/${PHASE}/plan`, { method: 'POST', token: bob, body: { text_he: 'x', text_en: 'x' } });
    assert.ok([401, 403].includes(res.status), `member got ${res.status}`);
  });

  test('A: an undated item is served to the modern site with date null, and the organizer edit path puts it on a day', async () => {
    const created = await (await api(`/api/phases/${PHASE}/plan`, { method: 'POST', apiKey: AGENT_KEY, body: { text_he: 'קפה', text_en: 'Coffee idea' } })).json();
    const before = await active();
    const served = before.items.filter((item) => item.text_en === 'Coffee idea');
    assert.equal(served.length, 1, 'served once');
    assert.equal(served[0].date, null);
    assert.equal(served[0].phase_id, PHASE);
    // A member's payload carries it too (read-only there).
    const asMember = await (await api('/api/itinerary/active', { token: bob })).json();
    assert.equal(asMember.items.filter((item) => item.text_en === 'Coffee idea')[0]?.date, null);

    const patch = await api(`/api/itinerary/items/${encodeURIComponent(served[0].item_uid)}`, { method: 'PATCH', token: alice, body: { phase_id: PHASE, date: DAY } });
    assert.equal(patch.status, 200);

    const rows = (await plan()).filter((row) => row.text_en === 'Coffee idea');
    assert.equal(rows.length, 1, 'one legacy row, not duplicated or orphaned');
    assert.equal(rows[0].id, created.id);
    assert.equal(rows[0].date, DAY);
    const days = await (await api(`/api/phases/${PHASE}/plan/days`, { apiKey: AGENT_KEY })).json();
    assert.ok(days.some((day) => day.date === DAY), 'the day now exists');
    const after = (await active()).items.filter((item) => item.text_en === 'Coffee idea');
    assert.equal(after.length, 1);
    assert.equal(after[0].date, DAY);
  });
});

// B. What the companion is told. Two servers expose the same tools (mcp/mcp.js over stdio for the
// provisioned companion, server/trip-mcp/tools.js for the connector members' assistants use); the
// wording has to say the same thing in both.
describe('B. add_plan_item / update_plan_item tell the agent to pass the day', () => {
  const { registerTools } = require('../server/trip-mcp/tools.js');
  const registered = {};
  registerTools({ registerTool: (name, def) => { registered[name] = def; } }, {}, { write: true });

  test('the connector tool names the date rule, the unscheduled response and the read-back', () => {
    const d = registered.add_plan_item.description;
    assert.match(d, /names or implies a day/i);
    assert.match(d, /pass that day's `date`/);
    assert.match(d, /Omit `date` only for an idea with no day yet/);
    assert.match(d, /Not on a day yet/);
    assert.match(d, /unscheduled: true/);
    assert.match(d, /update_plan_item/);
    assert.match(registered.update_plan_item.description, /unscheduled: true/);
    assert.equal(registered.add_plan_item.inputSchema.date.isOptional(), true, 'date stays optional in the schema');
  });

  test('the same wording is in the companion tool source (mcp/mcp.js), and date stays optional there', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('../mcp/mcp.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf("mcp.tool('add_plan_item'"), src.indexOf("mcp.tool('delete_plan_item'"));
    for (const phrase of ["names or implies a day", "pass that day\\'s `date`", "Omit `date` only for an idea with no day yet", "Not on a day yet", "unscheduled: true", "update_plan_item"]) {
      assert.ok(block.includes(phrase), `mcp/mcp.js add_plan_item/update_plan_item text lacks: ${phrase}`);
    }
    assert.match(block, /date:\s+z\.string\(\)\.regex\([^\n]*\)\.optional\(\)/, 'date is still optional');
  });
});
