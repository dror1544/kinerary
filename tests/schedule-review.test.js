/**
 * schedule-review.test.js — the post-reorder wording review.
 *
 * Moving a day moves its items, but the prose written around them was authored
 * against the old order and quietly stops being true: a headline naming its own
 * date ("Fri 14/8 — …" now sitting on the 13th), "tomorrow we climb Diamond
 * Head" on the day before, "unlike Thursday, this beach is calm". None of it is
 * visible on the day that moved, which is exactly why it gets missed.
 *
 * A reorder therefore re-checks the WHOLE phase out of band, applies the
 * corrections, and keeps the superseded wording so the site can show it struck
 * through and the agent can tell the organizer what changed.
 *
 * Hermes is stood in for by a local HTTP server, the same way
 * booking-extract-proxy.test.js does — this proves server.js's contract
 * without depending on a real model call.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startTestServer, stopTestServer, api } from './helpers/server.js';
import { createRenderContext } from './helpers/dom.js';

const HERE      = dirname(fileURLToPath(import.meta.url));
const AGENT_KEY = 'test-hermes-key';
const PHASE     = 'honolulu';
const DAY_13    = '2026-08-13';
const DAY_14    = '2026-08-14';
const MOCK_PORT = 3110;

// What the reviewer will be told to "find". Keyed by the text it replaces, so
// the mock can answer against whatever the schedule actually looks like when
// the worker calls — rather than hardcoding ids the seed happens to produce.
let mockCorrections = [];
let lastReviewRequest = null;
let mockHermes;
let tripDir = null;

const PHASE_DAYS = [
  { date: DAY_13, label: { he: 'ה׳ 13/8 — דיאמונד הד', en: 'Thu 13/8 — Diamond Head' }, items: [] },
  { date: DAY_14, label: { he: 'ו׳ 14/8 — דרום־מזרח', en: 'Fri 14/8 — Southeast Oahu' }, items: [] },
];

const HONOLULU_PHASE = {
  id: PHASE, short_id: 'hnl', tabLabel: 'HONOLULU', emoji: '🌺',
  title: { he: 'הונולולו', en: 'Honolulu' },
  dates: { start: '2026-08-11', end: '2026-08-18' },
  hero: { photo: '', label: { he: '', en: '' }, sub: { he: '', en: '' }, badge: { he: '', en: '' } },
  days: PHASE_DAYS,
};

function makeTripDir() {
  const dir = mkdtempSync(join(tmpdir(), 'trip-review-'));
  cpSync(join(HERE, 'fixtures'), dir, { recursive: true });
  const p = join(dir, 'trip.config.json');
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.phases = [...(cfg.phases || []), HONOLULU_PHASE];
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return dir;
}

const planItems = async () => (await api(`/api/phases/${PHASE}/plan`, { apiKey: AGENT_KEY })).json();
const planDays  = async () => (await api(`/api/phases/${PHASE}/plan/days`, { apiKey: AGENT_KEY })).json();

async function addItem(date, text_he, text_en, sort_order) {
  const r = await api(`/api/phases/${PHASE}/plan`, {
    method: 'POST', apiKey: AGENT_KEY, body: { date, text_he, text_en, sort_order },
  });
  assert.equal(r.status, 201);
  return r.json();
}
const setLabel = (date, body) =>
  api(`/api/phases/${PHASE}/plan/days/${date}`, { method: 'PATCH', apiKey: AGENT_KEY, body });

const swap = () => api(`/api/phases/${PHASE}/plan/swap-days`, {
  method: 'POST', apiKey: AGENT_KEY, body: { date_a: DAY_13, date_b: DAY_14 },
});

/** Poll until `fn()` returns truthy — the worker runs out of band by design. */
async function eventually(fn, what, ms = 12000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 150));
  }
}

async function seed() {
  for (const i of await planItems()) {
    await api(`/api/phases/${PHASE}/plan/${i.id}`, { method: 'DELETE', apiKey: AGENT_KEY });
  }
  // 13/8 is Diamond Head; 14/8 refers BACK to it. After a swap that reference
  // is the thing that breaks, and it lives on neither of the moved items'
  // own text — it's the cross-day case.
  await addItem(DAY_13, 'עלייה לדיאמונד הד', 'Hike Diamond Head', 0);
  await addItem(DAY_13, 'ואיקיקי אחר כך', 'Waikiki afterwards', 1);
  await addItem(DAY_14, 'חוף רגוע אחרי הטיפוס של אתמול', 'A calm beach after yesterday\'s climb', 0);
  await setLabel(DAY_13, { label_he: 'ה׳ 13/8 — דיאמונד הד', label_en: 'Thu 13/8 — Diamond Head' });
  await setLabel(DAY_14, { label_he: 'ו׳ 14/8 — דרום־מזרח', label_en: 'Fri 14/8 — Southeast Oahu' });
}

before(async () => {
  mockHermes = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (body.kind === 'schedule_review') {
        lastReviewRequest = body;
        res.end(JSON.stringify({ corrections: mockCorrections }));
      } else {
        // Item/day enrichment shares this endpoint; answer harmlessly.
        res.end('{}');
      }
    });
  });
  await new Promise(r => mockHermes.listen(MOCK_PORT, r));
  tripDir = makeTripDir();
  await startTestServer({ PORT: '3109', TRIP_DIR: tripDir, HERMES_URL: `http://127.0.0.1:${MOCK_PORT}` });
});

after(() => {
  stopTestServer();
  mockHermes.close();
  if (tripDir) { try { rmSync(tripDir, { recursive: true, force: true }); } catch {} tripDir = null; }
});

describe('a reorder queues a whole-phase wording review', () => {
  before(async () => { mockCorrections = []; await seed(); });

  test('the swap response tells the caller a review is coming', async () => {
    const body = await (await swap()).json();
    assert.equal(body.review.status, 'queued');
    assert.equal(body.review.scope, 'phase');
    assert.match(body.review.detail, /get_phase_plan/,
      'the caller must be told where to read the corrections back from');
  });

  test('the reviewer is shown the whole phase, not just the moved days', async () => {
    const seen = await eventually(async () => lastReviewRequest, 'the review call');
    const dates = seen.days.map(d => d.date).sort();
    assert.deepEqual(dates, [DAY_13, DAY_14]);
    // Weekday is supplied: "is this the Thursday it claims to be" is
    // unanswerable from an ISO date alone.
    assert.ok(seen.days.every(d => d.weekday), 'each day should carry its weekday');
    assert.ok(seen.days.every(d => 'label_en' in d), 'headlines are part of what gets judged');
    assert.ok(seen.days.flatMap(d => d.items).every(i => Number.isInteger(i.id)),
      'items need ids so a correction can point at one');
  });

  test('moving a single item to another date queues the same review', async () => {
    const [first] = await planItems();
    const res = await api(`/api/phases/${PHASE}/plan/${first.id}`, {
      method: 'PATCH', apiKey: AGENT_KEY, body: { date: '2026-08-17' },
    });
    assert.equal((await res.json()).review.status, 'queued');
  });

  test('an edit that does not move a date does not trigger a review', async () => {
    const [first] = await planItems();
    const res = await api(`/api/phases/${PHASE}/plan/${first.id}`, {
      method: 'PATCH', apiKey: AGENT_KEY, body: { text_en: 'Renamed, same day' },
    });
    assert.equal((await res.json()).review, undefined);
  });
});

describe('corrections are applied, and the original is kept', () => {
  before(async () => {
    mockCorrections = [];
    await seed();
    const items = await planItems();
    const stale = items.find(i => i.text_en.includes('yesterday'));
    mockCorrections = [
      {
        kind: 'item', id: stale.id,
        text_he: 'חוף רגוע אחרי הטיפוס של מחר',
        text_en: 'A calm beach before tomorrow\'s climb',
        note: 'referred to the climb as yesterday, but it now comes after this day',
      },
      {
        kind: 'day', date: DAY_13,
        label_he: 'ה׳ 13/8 — דרום־מזרח', label_en: 'Thu 13/8 — Southeast Oahu',
        note: 'headline still named Friday 14/8',
      },
    ];
    await swap();
  });

  test('the item text is rewritten and the previous wording preserved', async () => {
    const item = await eventually(
      async () => (await planItems()).find(i => i.correction),
      'the item correction');
    assert.match(item.text_en, /before tomorrow's climb/);
    assert.equal(item.correction.previous.text_en, "A calm beach after yesterday's climb");
    assert.equal(item.correction.previous.text_he, 'חוף רגוע אחרי הטיפוס של אתמול');
    assert.match(item.correction.note, /yesterday/);
    // Flagged for the organizer: a machine rewrote a line a person wrote.
    assert.equal(item.status, 'needs_review');
  });

  test('a day headline is corrected the same way', async () => {
    const day = await eventually(
      async () => (await planDays()).find(d => d.date === DAY_13 && d.correction),
      'the day correction');
    assert.equal(day.label_en, 'Thu 13/8 — Southeast Oahu');
    assert.equal(day.correction.previous.label_en, 'Fri 14/8 — Southeast Oahu',
      'the headline that travelled with the swap is what it replaced');
    assert.match(day.correction.note, /Friday/);
  });

  test('untouched lines are left completely alone', async () => {
    const items = await planItems();
    const hike = items.find(i => i.text_en === 'Hike Diamond Head');
    assert.ok(hike, 'the unrelated item should still read exactly as authored');
    assert.equal(hike.correction, undefined);
    assert.equal(hike.status, 'confirmed');
  });

  test('a second reorder keeps the ORIGINAL wording, not the last rewrite', async () => {
    const before = (await planItems()).find(i => i.correction);
    mockCorrections = [{
      kind: 'item', id: before.id,
      text_en: 'A calm beach, the day after the climb',
      note: 'order changed again',
    }];
    await swap();
    const after = await eventually(
      async () => {
        const i = (await planItems()).find(x => x.id === before.id);
        return i.text_en.includes('the day after') ? i : null;
      },
      'the second correction');
    assert.equal(after.correction.previous.text_en, "A calm beach after yesterday's climb",
      'what the organizer actually wrote is what stays struck through');
  });
});

describe('the reviewer cannot be trusted blindly', () => {
  before(async () => { mockCorrections = []; await seed(); });

  test('a correction naming an unknown item changes nothing', async () => {
    const snapshot = await planItems();
    mockCorrections = [{ kind: 'item', id: 999999, text_en: 'nope', note: 'x' }];
    await swap();
    await eventually(async () => (await planItems()).every(i => i.review_status === 'done'),
      'the review pass to finish');
    const after = await planItems();
    assert.deepEqual(after.map(i => i.text_en).sort(), snapshot.map(i => i.text_en).sort());
    assert.ok(after.every(i => !i.correction));
  });

  test('a correction identical to the current text is not recorded as a change', async () => {
    await seed();
    const items = await planItems();
    const hike = items.find(i => i.text_en === 'Hike Diamond Head');
    mockCorrections = [{ kind: 'item', id: hike.id, text_en: 'Hike Diamond Head', note: 'no-op' }];
    await swap();
    await eventually(async () => (await planItems()).every(i => i.review_status === 'done'),
      'the review pass to finish');
    const after = (await planItems()).find(i => i.id === hike.id);
    assert.equal(after.correction, undefined, 'a no-op must not show up as "we changed this"');
    assert.equal(after.status, 'confirmed');
  });
});

describe('the site shows a correction rather than swapping words silently', () => {
  let items, days;

  before(async () => {
    mockCorrections = [];
    await seed();
    const seeded = await planItems();
    const stale = seeded.find(i => i.text_en.includes('yesterday'));
    mockCorrections = [{
      kind: 'item', id: stale.id,
      text_he: 'חוף רגוע לפני הטיפוס של מחר',
      text_en: 'A calm beach before tomorrow\'s climb',
      note: 'the climb moved to the following day',
    }];
    await swap();
    await eventually(async () => (await planItems()).find(i => i.correction), 'the correction');
    items = await planItems();
    days  = await planDays();
  });

  const render = () => {
    const { document, ctx } = createRenderContext(
      `<div id="sched-${PHASE}"></div>`, { phases: [HONOLULU_PHASE] }, 'en',
      {
        isOrganizer: false,
        PHASE_PLAN: { [PHASE]: items },
        PHASE_PLAN_DAYS: { [PHASE]: Object.fromEntries(days.map(d => [d.date, d])) },
        T: {
          he: { plan_unscheduled: 'ללא', plan_original_sched: 'מקורי', plan_enriching: '…', plan_corrected: 'עודכן' },
          en: { plan_unscheduled: 'Unscheduled', plan_original_sched: 'Original schedule', plan_enriching: '…', plan_corrected: 'Updated' },
        },
      }
    );
    ctx.renderDays(HONOLULU_PHASE);
    return document.getElementById(`sched-${PHASE}`);
  };

  test('the superseded wording is struck through, with the reason', () => {
    const el = render();
    const corr = el.querySelector('.plan-correction');
    assert.ok(corr, 'a corrected line must show that it was corrected');
    const struck = corr.querySelector('s.plan-correction-was');
    assert.ok(struck, 'the old wording belongs in a <s>');
    assert.match(struck.textContent, /after yesterday's climb/);
    assert.match(corr.querySelector('.plan-correction-note').textContent, /the climb moved/);
  });

  test('the corrected text is what the schedule now reads', () => {
    const el = render();
    const li = [...el.querySelectorAll('li.plan-item')]
      .find(x => x.textContent.includes('calm beach'));
    assert.match(li.textContent, /before tomorrow's climb/);
  });

  test('uncorrected items carry no correction furniture', () => {
    const el = render();
    const li = [...el.querySelectorAll('li.plan-item')]
      .find(x => x.textContent.includes('Hike Diamond Head'));
    assert.equal(li.querySelector('.plan-correction'), null);
  });
});
