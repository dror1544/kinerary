/**
 * itinerary-plan-layer.test.js — regression cover for the itinerary-edit
 * propagation bug.
 *
 * Vocabulary (see FRAMEWORK.md): the ORIGINAL PLAN is the schedule authored in
 * trip.config.json; the ACTIVE PLAN is the live one — original promoted in,
 * plus enrichment and the organizer's edits — and it is what the site renders.
 * Every itinerary change edits the active plan. A correction written to a
 * booking instead succeeds, reports success, and changes nothing anyone sees.
 *
 * The scenario throughout is the real one: Honolulu, 13/8 was Diamond Head +
 * Waikiki and 14/8 was Southeast Oahu + beach, and the organizer asked for
 * them the other way round.
 *
 *   A. routing    — what the agent is told about which plan an edit goes to
 *   B. data/API   — the swap moves items AND headlines, atomically
 *   C. rendering  — the swapped active plan is what renderDays() puts on the page
 *   D. semantics  — a booking write is not evidence the active plan changed
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startTestServer, stopTestServer, api } from './helpers/server.js';
import { startTestMcp, stopTestMcp, mcpListTools } from './helpers/mcp.js';
import { createRenderContext } from './helpers/dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Matches HERMES_API_KEY in startTestServer() — the companion agent's service
// account, which is the identity that actually made the bad edit in the field.
const AGENT_KEY = 'test-hermes-key';
const PHASE     = 'honolulu';
const DAY_13    = '2026-08-13';
const DAY_14    = '2026-08-14';

const DIAMOND_HEAD = [
  { time: '08:00', text_he: 'דיאמונד הד — מסלול הליכה',   text_en: 'Diamond Head — hike' },
  { time: '12:00', text_he: 'ואיקיקי — צהריים על החוף',   text_en: 'Waikiki — lunch on the beach' },
  { time: '16:00', text_he: 'אלה מואנה — קניות',          text_en: 'Ala Moana — shopping' },
];
const SOUTHEAST_OAHU = [
  { time: '09:00', text_he: 'הלונה בלוהול',                text_en: 'Halona Blowhole Lookout' },
  { time: '10:30', text_he: 'מקאפואו לוקאאוט',             text_en: 'Makapuʻu Lookout' },
  { time: '12:00', text_he: 'סנדי ביץ׳',                   text_en: 'Sandy Beach' },
  { time: '15:00', text_he: 'דיוק קהנמוקו — חוף ולגונה',  text_en: 'Duke Kahanamoku Beach & Lagoon' },
];
const LABEL_13 = { label_he: 'דיאמונד הד + ואיקיקי', label_en: 'Diamond Head + Waikiki / Ala Moana' };
const LABEL_14 = { label_he: 'דרום-מזרח אואהו + חוף',  label_en: 'Southeast Oahu + beach' };

// The ORIGINAL PLAN, in the pre-swap arrangement. It stays as it is —
// seeding/swapping never rewrites trip.config.json — so it is exactly the
// stale copy that must not reach a participant once the active plan diverges.
const HONOLULU_PHASE = {
  id: PHASE,
  short_id: 'hnl',
  tabLabel: 'HONOLULU',
  emoji: '🌺',
  title: { he: 'הונולולו', en: 'Honolulu' },
  dates: { start: '2026-08-11', end: '2026-08-18' },
  hero: { photo: '', label: { he: 'הונולולו', en: 'Honolulu' }, sub: { he: '', en: '' }, badge: { he: '', en: '' } },
  days: [
    {
      date: DAY_13,
      label: { he: 'ה׳ 13/8 — דיאמונד הד', en: 'Thu 13/8 — Diamond Head' },
      items: DIAMOND_HEAD.map(i => ({ time: i.time, text: { he: i.text_he, en: i.text_en } })),
    },
    {
      date: DAY_14,
      label: { he: 'ו׳ 14/8 — דרום-מזרח אואהו', en: 'Fri 14/8 — Southeast Oahu' },
      items: SOUTHEAST_OAHU.map(i => ({ time: i.time, text: { he: i.text_he, en: i.text_en } })),
    },
  ],
};

let tripDir = null;

/** A trip config that has a Honolulu phase, built from the shared fixture. */
function makeTripDir() {
  const dir = mkdtempSync(join(tmpdir(), 'trip-plan-layer-'));
  cpSync(join(HERE, 'fixtures'), dir, { recursive: true });
  const cfgPath = join(dir, 'trip.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.phases = [...(cfg.phases || []), HONOLULU_PHASE];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return dir;
}

const planItems = async () => (await api(`/api/phases/${PHASE}/plan`, { apiKey: AGENT_KEY })).json();
const planDays  = async () => (await api(`/api/phases/${PHASE}/plan/days`, { apiKey: AGENT_KEY })).json();

async function addItem(date, item, sort_order) {
  const res = await api(`/api/phases/${PHASE}/plan`, {
    method: 'POST', apiKey: AGENT_KEY,
    body: { date, sort_order, ...item },
  });
  assert.equal(res.status, 201, `seeding ${item.text_en} failed`);
  return res.json();
}

async function setLabel(date, label) {
  const res = await api(`/api/phases/${PHASE}/plan/days/${date}`, {
    method: 'PATCH', apiKey: AGENT_KEY, body: label,
  });
  assert.equal(res.status, 200, `labelling ${date} failed`);
  return res.json();
}

/** Wipe and re-seed the phase so each block starts from the pre-swap state. */
async function seedHonolulu() {
  for (const item of await planItems()) {
    await api(`/api/phases/${PHASE}/plan/${item.id}`, { method: 'DELETE', apiKey: AGENT_KEY });
  }
  for (const [i, item] of DIAMOND_HEAD.entries())   await addItem(DAY_13, item, i);
  for (const [i, item] of SOUTHEAST_OAHU.entries()) await addItem(DAY_14, item, i);
  await setLabel(DAY_13, LABEL_13);
  await setLabel(DAY_14, LABEL_14);
}

const textsOn = (items, date) =>
  items.filter(i => i.date === date).map(i => i.text_en).sort();
const sorted  = (arr) => [...arr].sort();

const PLAN_STRINGS = {
  he: { plan_unscheduled: 'ללא תאריך', plan_original_sched: 'המסלול המקורי', plan_enriching: 'מעדכן…' },
  en: { plan_unscheduled: 'Unscheduled', plan_original_sched: 'Original schedule', plan_enriching: 'Updating…' },
};

/** Render the phase exactly as site/app.js would, from real API payloads. */
function renderFor(plan, days, { isOrganizer }) {
  const { document, ctx } = createRenderContext(
    `<div id="sched-${PHASE}"></div>`,
    { phases: [HONOLULU_PHASE] },
    'en',
    {
      isOrganizer,
      PHASE_PLAN:      { [PHASE]: plan },
      PHASE_PLAN_DAYS: { [PHASE]: Object.fromEntries(days.map(d => [d.date, d])) },
      T: PLAN_STRINGS,
    }
  );
  ctx.renderDays(HONOLULU_PHASE);
  return document.getElementById(`sched-${PHASE}`);
}

// One server for the whole file. The three data-facing blocks below each
// re-seed rather than starting their own — rebinding the same port back-to-back
// is exactly the race helpers/server.js warns about.
before(async () => {
  tripDir = makeTripDir();
  await startTestServer({ PORT: '3107', TRIP_DIR: tripDir });
});
after(() => {
  stopTestServer();
  if (tripDir) { try { rmSync(tripDir, { recursive: true, force: true }); } catch {} tripDir = null; }
});

// ── A. Routing: which plan an itinerary edit is told to go to ───────────────
// The bot reached for update_booking because nothing it could read said the
// active plan was the thing to edit. These assert the advertised contract
// an MCP client actually receives — the real tools/list payload on the wire.
describe('A. Itinerary-change routing guidance (MCP tool contract)', () => {
  let tools;

  before(async () => {
    await startTestMcp({ MCP_PORT: '3108' });
    tools = await mcpListTools();
  });
  after(() => stopTestMcp());

  test('the active plan exposes every operation an itinerary edit needs', () => {
    for (const name of ['get_phase_plan', 'add_plan_item', 'update_plan_item',
                        'delete_plan_item', 'swap_plan_days', 'set_plan_day_label']) {
      assert.ok(tools[name], `missing plan tool: ${name}`);
    }
  });

  test('update_booking disclaims the itinerary and names the active-plan tools', () => {
    const d = tools.update_booking.description;
    // Tool names are the stable tokens here — a reword survives, a silent
    // removal of the routing rule does not.
    for (const pointer of ['get_phase_plan', 'swap_plan_days', 'update_plan_item', 'add_plan_item']) {
      assert.match(d, new RegExp(pointer), `update_booking should route itinerary edits to ${pointer}`);
    }
    assert.match(d, /NOT how the itinerary is changed/i,
      'update_booking must say plainly that it does not change the itinerary');
    assert.match(d, /preference/i,
      'update_booking should state that the site renders the active plan over bookings');
  });

  // The two plans have agreed names. Descriptions that drift back to "the
  // schedule" or "the plan" are how the ambiguity got in to begin with.
  test('the tool descriptions use the agreed original-plan / active-plan vocabulary', () => {
    for (const name of ['get_phase_plan', 'swap_plan_days', 'set_plan_day_label',
                        'add_plan_item', 'update_plan_item', 'delete_plan_item']) {
      assert.match(tools[name].description, /active plan/i,
        `${name} should say which plan it edits, in the agreed vocabulary`);
    }
    for (const name of ['get_phase_plan', 'update_booking']) {
      assert.match(tools[name].description, /original plan/i,
        `${name} should name the original plan as the read-only reference`);
    }
  });

  // renderDays() flips a phase to the active plan on its first item, not per
  // day — so a one-item edit against an empty active plan silently hides the
  // rest of that phase from participants.
  test('add_plan_item warns that a phase with an empty active plan must be seeded wholesale', () => {
    const d = tools.add_plan_item.description;
    assert.match(d, /empty/i);
    assert.match(d, /original plan/i);
    assert.match(d, /get_phase_plan/, 'should tell the agent to check the active plan first');
  });

  test('the swap request shapes the organizer actually uses are named somewhere in the plan tools', () => {
    const planText = ['swap_plan_days', 'update_plan_item', 'set_plan_day_label', 'get_phase_plan']
      .map(n => tools[n].description).join(' \n ');
    // "swap two days", "move a day", "today/tomorrow", "a day's route".
    for (const phrase of [/swap/i, /move/i, /today/i, /tomorrow/i, /route/i]) {
      assert.match(planText, phrase, `no plan tool mentions ${phrase}`);
    }
  });

  test('swap_plan_days is advertised as atomic, and preferred over per-item date edits', () => {
    const d = tools.swap_plan_days.description;
    assert.match(d, /atomic/i);
    assert.match(d, /update_plan_item/,
      'swap_plan_days should say why it beats a sequence of update_plan_item calls');
    assert.match(d, /headline/i, 'swap_plan_days should state that it moves the day headlines too');
  });

  test('get_phase_plan is advertised as the active plan and the read-back tool', () => {
    const d = tools.get_phase_plan.description;
    assert.match(d, /preference/i, 'get_phase_plan should state the active plan\'s precedence');
    assert.match(d, /headline/i,   'get_phase_plan should expose day headlines for verification');
    assert.match(d, /read.?back|verif/i, 'get_phase_plan should be named as the verification read');
  });

  test('update_plan_item points a two-day exchange at swap_plan_days', () => {
    assert.match(tools.update_plan_item.description, /swap_plan_days/);
  });
});

// ── B. The data layer: a swap moves items and headlines together ─────────────
describe('B. Swapping two days of the active plan', () => {
  before(async () => { await seedHonolulu(); });

  test('seed is the pre-swap arrangement Shiran was looking at', async () => {
    const items = await planItems();
    assert.deepEqual(textsOn(items, DAY_13), sorted(DIAMOND_HEAD.map(i => i.text_en)));
    assert.deepEqual(textsOn(items, DAY_14), sorted(SOUTHEAST_OAHU.map(i => i.text_en)));
  });

  test('POST /plan/swap-days exchanges every item on both dates', async () => {
    const before = await planItems();
    const res = await api(`/api/phases/${PHASE}/plan/swap-days`, {
      method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: DAY_14 },
    });
    assert.equal(res.status, 200);

    const items = await planItems();
    assert.deepEqual(textsOn(items, DAY_13), sorted(SOUTHEAST_OAHU.map(i => i.text_en)),
      '13/8 should now be Southeast Oahu + beach');
    assert.deepEqual(textsOn(items, DAY_14), sorted(DIAMOND_HEAD.map(i => i.text_en)),
      '14/8 should now be Diamond Head + Waikiki / Ala Moana');
    // Same rows moved — not copies left behind, not rows dropped.
    assert.equal(items.length, before.length, 'item count changed during the swap');
    assert.deepEqual(sorted(items.map(i => i.id)), sorted(before.map(i => i.id)),
      'swap should move the existing rows, not recreate them');
  });

  test('the day headlines travel with the items', async () => {
    const days = await planDays();
    const byDate = Object.fromEntries(days.map(d => [d.date, d]));
    assert.equal(byDate[DAY_13].label_en, LABEL_14.label_en,
      '13/8 must not still announce Diamond Head');
    assert.equal(byDate[DAY_13].label_he, LABEL_14.label_he);
    assert.equal(byDate[DAY_14].label_en, LABEL_13.label_en);
    assert.equal(byDate[DAY_14].label_he, LABEL_13.label_he);
  });

  test('no duplicate day rows for either date', async () => {
    const days = await planDays();
    for (const date of [DAY_13, DAY_14]) {
      assert.equal(days.filter(d => d.date === date).length, 1,
        `expected exactly one day row for ${date}`);
    }
  });

  test('the response carries the read-back, so verifying costs no extra call', async () => {
    await seedHonolulu();
    const res = await api(`/api/phases/${PHASE}/plan/swap-days`, {
      method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: DAY_14 },
    });
    const body = await res.json();
    assert.deepEqual(body.swapped, [DAY_13, DAY_14]);
    assert.deepEqual(textsOn(body.items, DAY_13), sorted(SOUTHEAST_OAHU.map(i => i.text_en)));
    assert.deepEqual(textsOn(body.items, DAY_14), sorted(DIAMOND_HEAD.map(i => i.text_en)));
    assert.equal(body.days.find(d => d.date === DAY_13).label_en, LABEL_14.label_en);
  });

  test('swapping twice returns the plan exactly where it started', async () => {
    await seedHonolulu();
    const before = await planItems();
    const swap = () => api(`/api/phases/${PHASE}/plan/swap-days`, {
      method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: DAY_14 },
    });
    await swap();
    await swap();
    const after = await planItems();
    assert.deepEqual(
      after.map(i => [i.id, i.date, i.text_en]),
      before.map(i => [i.id, i.date, i.text_en]),
      'a double swap should be a no-op'
    );
    const days = await planDays();
    assert.equal(days.find(d => d.date === DAY_13).label_en, LABEL_13.label_en);
  });

  test('a date with no items is a move, not a merge', async () => {
    await seedHonolulu();
    const empty = '2026-08-17';
    await api(`/api/phases/${PHASE}/plan/swap-days`, {
      method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: empty },
    });
    const items = await planItems();
    assert.deepEqual(textsOn(items, empty), sorted(DIAMOND_HEAD.map(i => i.text_en)));
    assert.equal(textsOn(items, DAY_13).length, 0, '13/8 should be empty after moving its plan away');
    const days = await planDays();
    assert.equal(days.find(d => d.date === empty).label_en, LABEL_13.label_en,
      'the headline should follow the items to the new date');
  });

  // Bookings are a confirmation-document store, organised by phase so the right
  // voucher is easy to find. A plan item may REFERENCE one (booking_id) to show
  // a ticket or reservation confirmation inline. Moving a day must therefore
  // carry the reference along with its item and leave every booking row exactly
  // where it is — a booking is not part of the schedule and never moves with it.
  test('a swap moves plan items only — every booking row is left untouched', async () => {
    await seedHonolulu();
    const made = await api('/api/bookings', {
      method: 'POST', apiKey: AGENT_KEY,
      body: {
        phase: PHASE, type: 'attraction', name: 'Diamond Head entry ticket',
        date_from: DAY_13, confirmation: 'DH-4417',
      },
    });
    const { id: bookingId } = await made.json();

    // Link it to a Diamond Head item, the way a real ticket is attached.
    const items = await planItems();
    const hike = items.find(i => i.text_en === 'Diamond Head — hike');
    await api(`/api/phases/${PHASE}/plan/${hike.id}`, {
      method: 'PATCH', apiKey: AGENT_KEY, body: { booking_id: bookingId },
    });

    const bookingsBefore = await (await api('/api/bookings', { apiKey: AGENT_KEY })).json();

    await api(`/api/phases/${PHASE}/plan/swap-days`, {
      method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: DAY_14 },
    });

    assert.deepEqual(await (await api('/api/bookings', { apiKey: AGENT_KEY })).json(), bookingsBefore,
      'a day swap must not touch any booking — not its date, name, or notes');

    // The reference survives the move, so the ticket still shows on the item.
    const moved = (await planItems()).find(i => i.id === hike.id);
    assert.equal(moved.date, DAY_14, 'the item itself moved');
    assert.equal(moved.booking_id, bookingId, 'its confirmation link moved with it');
    assert.equal(moved.booking?.confirmation, 'DH-4417',
      'the linked confirmation should still resolve after the swap');

    await api(`/api/bookings/${bookingId}`, { method: 'DELETE', apiKey: AGENT_KEY });
    await seedHonolulu();
  });

  test('rejects a malformed or degenerate swap', async () => {
    for (const body of [
      { date_a: DAY_13, date_b: DAY_13 },
      { date_a: '13/8/2026', date_b: DAY_14 },
      { date_a: DAY_13 },
      {},
    ]) {
      const res = await api(`/api/phases/${PHASE}/plan/swap-days`, {
        method: 'POST', apiKey: AGENT_KEY, body,
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    const unknown = await api('/api/phases/atlantis/plan/swap-days', {
      method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: DAY_14 },
    });
    assert.equal(unknown.status, 400);
  });

  test('a family member cannot swap days or rewrite a headline', async () => {
    const loginRes = await api('/api/auth/login', {
      method: 'POST', body: { username: 'bob', password: '1234' },
    });
    const { token } = await loginRes.json();
    const swap = await api(`/api/phases/${PHASE}/plan/swap-days`, {
      method: 'POST', token, body: { date_a: DAY_13, date_b: DAY_14 },
    });
    assert.equal(swap.status, 403);
    const label = await api(`/api/phases/${PHASE}/plan/days/${DAY_13}`, {
      method: 'PATCH', token, body: { label_en: 'nope' },
    });
    assert.equal(label.status, 403);
  });

  // The headline was previously written through COALESCE everywhere, which
  // made it write-once: set it and no API call could ever change it again.
  test('a day headline can be corrected after it already has one', async () => {
    await setLabel(DAY_13, { label_en: 'First name', label_he: 'שם ראשון' });
    const updated = await setLabel(DAY_13, { label_en: 'Corrected name' });
    assert.equal(updated.label_en, 'Corrected name');
    assert.equal(updated.label_he, 'שם ראשון', 'an omitted language should be left alone');
  });

  test('clearing a headline re-queues the day for an AI-written one', async () => {
    await setLabel(DAY_14, { label_he: 'משהו', label_en: 'Something' });
    const cleared = await setLabel(DAY_14, { label_he: '', label_en: '' });
    assert.equal(cleared.label_he, null);
    assert.equal(cleared.enrichment_status, 'pending');
  });
});

// ── C. Rendering: the swapped plan is what a participant sees ────────────────
describe('C. renderDays() after a swap', () => {
  let plan, days;

  before(async () => {
    await seedHonolulu();
    await api(`/api/phases/${PHASE}/plan/swap-days`, {
      method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: DAY_14 },
    });
    // Exactly what site/app.js loads into PHASE_PLAN / PHASE_PLAN_DAYS.
    plan = await planItems();
    days = await planDays();
  });

  const render = ({ isOrganizer }) => renderFor(plan, days, { isOrganizer });

  test('a participant sees one block per date, each holding the swapped plan', () => {
    const el = render({ isOrganizer: false });
    const blocks = [...el.querySelectorAll('.day-block')];
    assert.equal(blocks.length, 2, 'expected exactly two day blocks, one per date');

    const [first, second] = blocks;
    // Dates render as formatted labels, so identify the blocks by their content.
    assert.match(first.textContent, /Southeast Oahu \+ beach/,
      '13/8 should carry the Southeast Oahu headline');
    for (const i of SOUTHEAST_OAHU) assert.ok(first.textContent.includes(i.text_en), `13/8 missing ${i.text_en}`);
    assert.match(second.textContent, /Diamond Head \+ Waikiki/,
      '14/8 should carry the Diamond Head headline');
    for (const i of DIAMOND_HEAD) assert.ok(second.textContent.includes(i.text_en), `14/8 missing ${i.text_en}`);
  });

  test('no item appears twice, and none appears under both dates', () => {
    const el = render({ isOrganizer: false });
    const rows = [...el.querySelectorAll('li.plan-item')].map(li => li.textContent.trim());
    assert.equal(rows.length, DIAMOND_HEAD.length + SOUTHEAST_OAHU.length);
    for (const i of [...DIAMOND_HEAD, ...SOUTHEAST_OAHU]) {
      assert.equal(rows.filter(r => r.includes(i.text_en)).length, 1, `${i.text_en} rendered more than once`);
    }
  });

  test('the original plan is not shown to a participant at all', () => {
    const el = render({ isOrganizer: false });
    assert.equal(el.querySelectorAll('.plan-orig-panel').length, 0);
    // The config still describes the pre-swap arrangement under its own labels;
    // none of it may reach someone who is just checking today's plan.
    assert.ok(!el.textContent.includes('Thu 13/8 — Diamond Head'),
      'config day label leaked into the participant view');
    assert.ok(!el.textContent.includes('Fri 14/8 — Southeast Oahu'));
  });

  test('the organizer additionally gets the original schedule, collapsed and labelled as a comparison', () => {
    const el = render({ isOrganizer: true });
    const panel = el.querySelector('.plan-orig-panel');
    assert.ok(panel, 'organizer should still be able to compare against the config schedule');
    assert.match(panel.textContent, /Original schedule/,
      'the comparison view must be labelled as the original, not shown as the live plan');
    // Still exactly two live day blocks; the comparison lives inside the panel.
    const live = [...el.querySelectorAll('.day-block')].filter(b => !panel.contains(b));
    assert.equal(live.length, 2);
  });
});

// ── D. Verification semantics: a booking write proves nothing ────────────────
describe('D. A booking update is not evidence the active plan changed', () => {
  before(async () => { await seedHonolulu(); });

  test('rewriting a booking to the new route leaves the visible schedule untouched', async () => {
    const created = await api('/api/bookings', {
      method: 'POST', apiKey: AGENT_KEY,
      body: {
        phase: PHASE, type: 'attraction', name: 'Diamond Head',
        date_from: DAY_13, notes: 'Diamond Head + Waikiki',
      },
    });
    assert.equal(created.status, 200);
    const booking = await created.json();

    const planBefore = await planItems();
    const daysBefore = await planDays();

    // Exactly what the bot did: update_booking with the day's new route.
    const patched = await api(`/api/bookings/${booking.id}`, {
      method: 'PATCH', apiKey: AGENT_KEY,
      body: {
        name: 'Southeast Oahu + beach',
        notes: 'Halona Blowhole Lookout, Makapuʻu Lookout, Sandy Beach, Duke Kahanamoku Beach & Lagoon',
      },
    });
    assert.equal(patched.status, 200, 'the booking write itself succeeds — that is the trap');

    assert.deepEqual(await planItems(), planBefore,
      'a booking write must not be able to look like an active-plan change');
    assert.deepEqual(await planDays(), daysBefore);
  });

  test('and the rendered schedule still shows the pre-swap plan', async () => {
    const el = renderFor(await planItems(), await planDays(), { isOrganizer: false });
    const blocks = [...el.querySelectorAll('.day-block')];
    // 13/8 is still Diamond Head: the booking edit changed nothing here, which
    // is precisely why "updated on the site" was a false claim.
    assert.match(blocks[0].textContent, /Diamond Head \+ Waikiki/);
    assert.ok(blocks[0].textContent.includes('Diamond Head — hike'));
    assert.ok(!blocks[0].textContent.includes('Halona Blowhole Lookout'),
      'the booking notes must not surface as the day plan');
  });

  test('the plan layer is what changes it — same request, right tool', async () => {
    await api(`/api/phases/${PHASE}/plan/swap-days`, {
      method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: DAY_14 },
    });
    const items = await planItems();
    assert.deepEqual(textsOn(items, DAY_13), sorted(SOUTHEAST_OAHU.map(i => i.text_en)));
    const days = await planDays();
    assert.equal(days.find(d => d.date === DAY_13).label_en, LABEL_14.label_en);
  });
});
