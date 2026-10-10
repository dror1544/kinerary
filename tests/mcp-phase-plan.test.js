/**
 * mcp-phase-plan.test.js — get_phase_plan's date filter and its safety net
 * against Hermes's spillover threshold (issue #310).
 *
 * Hermes hands an mcp_-prefixed tool's result to the model inline only up to
 * DEFAULT_MCP_RESULT_SIZE_CHARS = 50,000 characters
 * (~/.hermes/hermes-agent/tools/budget_config.py — not part of this repo).
 * Past that it spills the result to a file and the companion has to read the
 * file itself. On a large trip the no-argument, no-date get_phase_plan call
 * crossed that threshold; the fix is at the source — the tool now takes an
 * optional `date`, so a caller can ask for one day (or one phase, or both)
 * instead of everything, and refuses cleanly rather than overflowing when
 * asked for everything on a trip too big for one answer.
 *
 * No existing fixture in this suite gets anywhere close to the 50,000-char
 * threshold (tests/fixtures/trip.config.json is ~7KB total, two phases, at
 * most one `days` entry each) — see the "safety net" describe block below,
 * which builds its own large synthetic plan for real, rather than reasoning
 * about the limit in the abstract.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestMcp, stopTestMcp, mcpCallTool } from './helpers/mcp.js';
import { PORTS } from './helpers/ports.js';

function parseToolJson(result) {
  assert.notEqual(result.isError, true, `expected success, got error: ${result.content?.[0]?.text}`);
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

function parseToolError(result) {
  assert.equal(result.isError, true, 'expected a tool error');
  assert.equal(result.content?.[0]?.type, 'text');
  return result.content[0].text;
}

/** A GET-only fake trip API serving /api/config, /api/phases/:id/plan and /api/phases/:id/plan/days from fixed tables. */
function makeApiServer({ phases, itemsByPhase, daysByPhase }) {
  return createServer((req, res) => {
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/api/config') return send({ phases });
    let m;
    if (req.method === 'GET' && (m = req.url.match(/^\/api\/phases\/([^/]+)\/plan$/))) {
      return send(itemsByPhase[m[1]] || []);
    }
    if (req.method === 'GET' && (m = req.url.match(/^\/api\/phases\/([^/]+)\/plan\/days$/))) {
      return send(daysByPhase[m[1]] || []);
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
  });
}

/** Binds an ephemeral port (0) and returns it — a stand-in server needs no entry in helpers/ports.js. */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// ── Small-trip fixture: two phases, a handful of items/days each ───────────

const TOKYO_ITEMS = [
  { id: 1, phase_id: 'tokyo', date: '2026-01-01', time: '09:00', text_he: 'סנסו-ג׳י', text_en: 'Senso-ji Temple', status: 'confirmed', sort_order: 1, booking_id: null },
  { id: 2, phase_id: 'tokyo', date: '2026-01-01', time: '14:00', text_he: 'שיבויה', text_en: 'Shibuya Crossing', status: 'confirmed', sort_order: 2, booking_id: null },
  { id: 3, phase_id: 'tokyo', date: '2026-01-02', time: '10:00', text_he: 'צוקיג׳י', text_en: 'Tsukiji Market', status: 'confirmed', sort_order: 1, booking_id: null },
];
const TOKYO_DAYS = [
  { phase_id: 'tokyo', date: '2026-01-01', label_he: 'אסאקוסה + שיבויה', label_en: 'Asakusa + Shibuya', enrichment_status: 'done' },
  { phase_id: 'tokyo', date: '2026-01-02', label_he: 'צוקיג׳י',          label_en: 'Tsukiji Market',    enrichment_status: 'done' },
];
const KYOTO_ITEMS = [
  { id: 4, phase_id: 'kyoto', date: '2026-01-03', time: '09:00', text_he: 'פושימי אינארי', text_en: 'Fushimi Inari', status: 'confirmed', sort_order: 1, booking_id: null },
];
const KYOTO_DAYS = [
  { phase_id: 'kyoto', date: '2026-01-03', label_he: 'פושימי אינארי טאישה', label_en: 'Fushimi Inari Shrine', enrichment_status: 'done' },
];

describe('get_phase_plan — date filtering (small trip)', () => {
  let apiServer;
  before(async () => {
    apiServer = makeApiServer({
      phases: [{ id: 'tokyo' }, { id: 'kyoto' }],
      itemsByPhase: { tokyo: TOKYO_ITEMS, kyoto: KYOTO_ITEMS },
      daysByPhase:  { tokyo: TOKYO_DAYS,  kyoto: KYOTO_DAYS },
    });
    const apiPort = await listen(apiServer);
    await startTestMcp({ MCP_PORT: String(PORTS.mcpPhasePlan), API_BASE_URL: `http://127.0.0.1:${apiPort}` });
  });
  after(async () => {
    stopTestMcp();
    await new Promise((r) => apiServer.close(r));
  });

  test('phase_id + date: only that date\'s items and day come back, other dates are absent', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', { phase_id: 'tokyo', date: '2026-01-01' }));
    assert.deepEqual(result, {
      phase_id: 'tokyo',
      days:  [TOKYO_DAYS[0]],
      items: [TOKYO_ITEMS[0], TOKYO_ITEMS[1]],
    });
    // The 2026-01-02 item and day must not leak through.
    assert.ok(!result.items.some(i => i.date === '2026-01-02'));
    assert.ok(!result.days.some(d => d.date === '2026-01-02'));
  });

  test('phase_id + date matching nothing in that phase: empty arrays, not an error', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', { phase_id: 'tokyo', date: '2099-12-31' }));
    assert.deepEqual(result, { phase_id: 'tokyo', days: [], items: [] });
  });

  test('date alone, multiple phases, date falls in only one: the result object contains only that phase\'s key', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', { date: '2026-01-03' }));
    assert.deepEqual(Object.keys(result), ['kyoto']);
    assert.deepEqual(result.kyoto, { phase_id: 'kyoto', days: KYOTO_DAYS, items: KYOTO_ITEMS });
  });

  // Chosen shape for "date alone, no match anywhere": an empty object, ok(),
  // not a tool error. A date that legitimately falls outside every phase (the
  // trip hasn't started that leg yet, or the caller mistyped it) is a normal,
  // answerable question — "nothing is scheduled that day" — not a failure
  // condition, so it gets the same "just tell me what's there" shape as a
  // phase_id+date miss (empty arrays) rather than throwing.
  test('date alone matching no items or day in any phase: empty result object, no crash', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', { date: '2099-12-31' }));
    assert.deepEqual(result, {});
  });

  test('regression: no phase_id, no date — output is byte-for-byte what it was before this change', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', {}));
    assert.deepEqual(result, {
      tokyo: { phase_id: 'tokyo', days: TOKYO_DAYS, items: TOKYO_ITEMS },
      kyoto: { phase_id: 'kyoto', days: KYOTO_DAYS, items: KYOTO_ITEMS },
    });
  });

  test('regression: phase_id alone, no date — still the whole phase, unfiltered', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', { phase_id: 'tokyo' }));
    assert.deepEqual(result, { phase_id: 'tokyo', days: TOKYO_DAYS, items: TOKYO_ITEMS });
  });
});

// ── Large-trip fixture: big enough to actually cross the safety threshold ──
//
// tests/fixtures/trip.config.json (the suite's only phase/day fixture) is
// ~7KB total across two phases with at most one `days` entry each — nowhere
// near the 50,000-char Hermes limit. Nothing else in the fixture set comes
// close either (checked: no fixture file under tests/fixtures or tests/
// matches phase_plan_items/phase_plan_days at any size). So this builds a
// synthetic large plan here, sized to actually cross PHASE_PLAN_SAFE_LIMIT
// (40,000 chars) — not just reasoned about — while keeping any single phase
// comfortably under it.

function bigItem(phaseId, i, date) {
  return {
    id: i,
    phase_id: phaseId,
    date,
    time: '09:00',
    time_sort: 540,
    text_he: `פעילות לדוגמה מספר ${i} בטיול הגדול כדי לבדוק את גודל התגובה שמוחזרת מהשרת`,
    text_en: `Sample activity number ${i} in the big trip fixture used to test response size handling end to end`,
    location_url: `https://maps.google.com/?q=Sample+Location+${i}`,
    status: 'confirmed',
    sort_order: i,
    booking_id: null,
  };
}
function bigDay(phaseId, date, i) {
  return { phase_id: phaseId, date, label_he: `כותרת יום לדוגמה ${i}`, label_en: `Sample day headline ${i}`, enrichment_status: 'done' };
}

const BIG_PHASE_IDS = ['big0', 'big1', 'big2', 'big3', 'big4'];
const BIG_ITEMS_BY_PHASE = {};
const BIG_DAYS_BY_PHASE = {};
for (const p of BIG_PHASE_IDS) {
  const dates = Array.from({ length: 9 }, (_, i) => `2026-02-0${i + 1}`);
  BIG_ITEMS_BY_PHASE[p] = Array.from({ length: 30 }, (_, i) => bigItem(p, i, dates[i % dates.length]));
  BIG_DAYS_BY_PHASE[p]  = dates.map((d, i) => bigDay(p, d, i));
}

describe('get_phase_plan — safety net against the Hermes spillover threshold (large trip)', () => {
  let apiServer;
  before(async () => {
    apiServer = makeApiServer({
      phases: BIG_PHASE_IDS.map(id => ({ id })),
      itemsByPhase: BIG_ITEMS_BY_PHASE,
      daysByPhase:  BIG_DAYS_BY_PHASE,
    });
    const apiPort = await listen(apiServer);
    await startTestMcp({ MCP_PORT: String(PORTS.mcpPhasePlanLarge), API_BASE_URL: `http://127.0.0.1:${apiPort}` });
  });
  after(async () => {
    stopTestMcp();
    await new Promise((r) => apiServer.close(r));
  });

  test('the full, no-argument plan for this fixture really does cross 40,000 chars (proves the fixture, not just the code)', () => {
    const full = {};
    for (const p of BIG_PHASE_IDS) full[p] = { phase_id: p, days: BIG_DAYS_BY_PHASE[p], items: BIG_ITEMS_BY_PHASE[p] };
    const size = JSON.stringify(full).length;
    assert.ok(size >= 40_000, `fixture should cross the 40,000-char safety threshold, got ${size}`);
    // ...and the real Hermes limit this whole mechanism exists to stay under.
    assert.ok(size >= 50_000, `fixture should also cross the real 50,000-char Hermes limit, got ${size}`);
  });

  test('no phase_id, no date: refuses with a clear message instead of returning an oversized payload', async () => {
    const result = await mcpCallTool('get_phase_plan', {});
    const message = parseToolError(result);
    assert.equal(message, "This trip's full plan is too large to return at once. Ask for one phase_id, or one phase_id plus a date, instead.");
  });

  test('phase_id alone against the same large fixture: succeeds and stays comfortably under the threshold', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', { phase_id: 'big0' }));
    assert.equal(result.phase_id, 'big0');
    assert.equal(result.items.length, 30);
    const size = JSON.stringify(result).length;
    assert.ok(size < 40_000, `single-phase result should stay under the safety threshold, got ${size}`);
  });

  test('phase_id + date against the same large fixture: succeeds and is far smaller still', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', { phase_id: 'big0', date: '2026-02-01' }));
    assert.equal(result.phase_id, 'big0');
    assert.ok(result.items.length > 0);
    assert.ok(result.items.every(i => i.date === '2026-02-01'));
    const size = JSON.stringify(result).length;
    assert.ok(size < 40_000, `single-phase, single-date result should stay under the safety threshold, got ${size}`);
  });

  test('date alone against the same large fixture: filtered per-phase, still under the threshold', async () => {
    const result = parseToolJson(await mcpCallTool('get_phase_plan', { date: '2026-02-01' }));
    // Every big phase has an item on 2026-02-01 (dates cycle every 9 items,
    // 30 items per phase), so all five keys should still be present here —
    // this exercises the date-alone filter at volume, not the phase-dropping
    // behaviour (that is covered on the small fixture above).
    assert.deepEqual(Object.keys(result).sort(), [...BIG_PHASE_IDS].sort());
    for (const p of BIG_PHASE_IDS) {
      assert.ok(result[p].items.every(i => i.date === '2026-02-01'));
    }
    const size = JSON.stringify(result).length;
    assert.ok(size < 40_000, `date-filtered result should stay under the safety threshold, got ${size}`);
  });
});
