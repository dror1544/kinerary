/**
 * mcp-trip-stops.test.js — stop editing from the trip companion (slice S4).
 *
 * The server slices (S1–S3, tests/trip-stops-http.test.js) gave a trip's stops
 * an override layer and five routes. This is the companion's way to them: five
 * MCP tools on mcp/mcp.js (Hermes, the agent key) and the same five on the
 * site's own in-process MCP (server/trip-mcp/tools.js, as the organizer who
 * connected — and absent on a read-only connection).
 *
 * Three layers, in the pattern of tests/mcp-trip-timezone.test.js:
 *   1. mcp/mcp.js against a STAND-IN trip site: every tool's exact route, body
 *      and If-Match; argument validation that refuses before any request; and
 *      every server refusal surfacing whole and readable, never truncated or
 *      swallowed.
 *   2. mcp/mcp.js against the REAL trip server on the colmar trip of the 10 Oct
 *      run — so the request shapes are the routes' own, not a re-guessed copy.
 *   3. server/trip-mcp/tools.js on a real McpServer: the tools are offered on
 *      a write connection and ABSENT on a read one, and call the right routes.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MCP_API_KEY, TRIP_API_KEY, startTestMcp, stopTestMcp, mcpCallTool, mcpListTools } from './helpers/mcp.js';
import { PORTS } from './helpers/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const require = createRequire(import.meta.url);

const STOP_TOOLS = ['get_stops', 'update_stop', 'split_stop', 'set_stop_from_booking', 'move_plan_day'];
const WRITE_STOP_TOOLS = STOP_TOOLS.filter(n => n !== 'get_stops');

function parseToolJson(result) {
  assert.notEqual(result.isError, true, `expected success, got error: ${result.content?.[0]?.text}`);
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

function parseToolError(result) {
  assert.equal(result.isError, true, `expected a tool error, got: ${result.content?.[0]?.text}`);
  assert.equal(result.content?.[0]?.type, 'text');
  return result.content[0].text;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(raw); } });
  });
}

// A validation refusal may come back as an isError result or as a JSON-RPC
// error, depending on the SDK version. Either is a refusal; a success is not.
async function expectRefusedArgs(call) {
  try {
    const result = await call();
    return parseToolError(result);
  } catch (err) {
    assert.match(err.message, /tools\/call error/);
    return err.message;
  }
}

// ── 1. mcp/mcp.js against a stand-in ─────────────────────────────────────────
const COLMAR = {
  id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR',
  dates: { start: '2026-12-02', end: '2026-12-07' },
};
const FRANKFURT = { id: 'frankfurt', title: 'Frankfurt', tabLabel: 'FRANKFURT' };
// Long enough that a 300-character error cap (the old errorSuffix) would cut
// it: the last item must still reach the model.
const OUTSIDE_ITEMS = Array.from({ length: 8 }, (_, i) => ({
  item_uid: `item-outside-${i + 1}`, date: '2026-12-03', time: null,
  text_he: `פריט שנשאר מחוץ לטווח מספר ${i + 1}`, text_en: `An item left outside the new range, number ${i + 1}`,
}));

describe('mcp/mcp.js stop tools — against a stand-in trip site', () => {
  let apiServer;
  const requests = [];
  const last = () => requests.at(-1);
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  before(async () => {
    apiServer = createServer(async (req, res) => {
      const body = await parseBody(req);
      requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], ifMatch: req.headers['if-match'] ?? null, body });
      if (req.headers['x-api-key'] !== TRIP_API_KEY) return send(res, 401, { error: 'unauthorized' });
      const ifMatch = req.headers['if-match'];
      if (ifMatch && ifMatch.replace(/"/g, '') !== 'st-4') return send(res, 409, { error: 'stops_changed_reload_before_retry', revision: 'st-4' });

      if (req.method === 'GET' && req.url === '/api/stops') {
        return send(res, 200, {
          revision: 'st-4', trip: { start: '2026-12-02', end: '2026-12-07' },
          stops: [
            { id: 'frankfurt', kind: 'config', unplanned: false, stop: FRANKFURT, override: null, conflict: null, booking_out_of_sync: false },
            { id: 'colmar', kind: 'config', unplanned: false, stop: COLMAR, override: null, conflict: null, booking_out_of_sync: false },
            { id: 'open-days', kind: 'computed', unplanned: true, stop: { id: 'open-days', unplanned: true }, override: null, conflict: null, booking_out_of_sync: false },
          ],
          orphaned_overrides: [],
        });
      }
      // The real write refuses any ASCII " in stop text (server/trip-structure.js
      // UNSAFE_LINE_RE); the stand-in does the same, so what the tools send is
      // what is judged.
      const stopText = [body?.title, body?.new_stop, body?.accommodation].map(v => JSON.stringify(v ?? '')).join('');
      if ((req.method === 'PATCH' || req.url.endsWith('/split')) && stopText.includes('\\"')) {
        return send(res, 400, { error: 'invalid_text', field: 'title', detail: 'text may not contain < > " or control characters (for a Hebrew abbreviation use ״, U+05F4)' });
      }
      if (req.method === 'PATCH' && req.url === '/api/stops/colmar') {
        if (body?.dates && body.dates.end > '2026-12-07') return send(res, 400, { error: 'dates_outside_trip', trip: { start: '2026-12-02', end: '2026-12-07' } });
        if (body?.dates?.start === '2026-12-04' && !body.on_outside) return send(res, 409, { error: 'items_outside_stop', items: OUTSIDE_ITEMS });
        return send(res, 200, { revision: 'st-5', stop: { ...COLMAR, ...(body.dates ? { dates: body.dates } : {}), ...(body.title ? { title: body.title } : {}) } });
      }
      if (req.method === 'PATCH' && req.url === '/api/stops/frankfurt') {
        return send(res, 200, { revision: 'st-5', stop: { ...FRANKFURT, ...body } });
      }
      if (req.method === 'POST' && req.url === '/api/stops/colmar/split') {
        return send(res, 201, {
          revision: 'st-6', itinerary_revision: 12,
          stops: [{ ...COLMAR, dates: { start: '2026-12-02', end: body.at } }, { id: 'near-the-airport', title: body.new_stop.title, dates: { start: body.at, end: '2026-12-07' } }],
          moved: { items: [], days: [] }, review: { status: 'unavailable', scope: 'phases', phases: ['colmar', 'near-the-airport'] },
        });
      }
      const fromBooking = /^\/api\/stops\/(colmar|near-the-airport)\/from-booking$/.exec(req.url);
      if (req.method === 'POST' && fromBooking) {
        if (body.booking_id === 7) return send(res, 409, { error: 'booking_is_draft' });
        if (body.booking_id === 8) return send(res, 409, { error: 'booking_belongs_to_another_stop', stop: 'frankfurt' });
        if (body.booking_id === 11) return send(res, 409, { error: 'booking_linked_to_another_stop', stop: 'colmar' });
        return send(res, 200, { revision: 'st-7', stop: { id: fromBooking[1], dates: { start: '2026-12-06', end: '2026-12-07' } }, items: { checkin: `booking_${body.booking_id}_checkin`, checkout: `booking_${body.booking_id}_checkout` } });
      }
      if (req.method === 'POST' && req.url === '/api/itinerary/move-day') {
        if (!body.headline && body.date === '2026-12-05') {
          return send(res, 409, { error: 'target_day_has_headline', source: { label_en: 'Market' }, target: { label_en: 'Museum' }, detail: 'resend with headline: "keep_target" or "take_source"' });
        }
        return send(res, 200, { revision: 13, phase_id: body.to_phase_id, date: body.date, moved: { items: ['a'], days: [body.date] }, review: { status: 'unavailable' } });
      }
      // An Express app that has no such route — a trip site built before the
      // stop routes existed — answers a bare HTML 404.
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(`<pre>Cannot ${req.method} ${req.url.split('?')[0]}</pre>`);
    });
    await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(0, '127.0.0.1', resolve); });
    await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${apiServer.address().port}`, MCP_PORT: String(PORTS.mcpTripStops), MCP_API_KEY });
  });

  after(async () => {
    stopTestMcp();
    await new Promise((resolve) => apiServer.close(resolve));
  });

  test('the five stop tools are listed, each saying what it refuses and to read the result back', async () => {
    const tools = await mcpListTools();
    for (const name of STOP_TOOLS) assert.ok(tools[name], `${name} is listed`);
    for (const name of WRITE_STOP_TOOLS) {
      assert.match(tools[name].description, /refuse/i, `${name} says what it refuses`);
      assert.match(tools[name].description, /read[^.]*back/i, `${name} says to read the result back`);
    }
    assert.match(tools.update_stop.description, /on_outside/);
    assert.match(tools.update_stop.description, /outside the trip/i);
    assert.match(tools.set_stop_from_booking.description, /draft/i);
    // A hotel booking does not change a stop — the booking tools now say so.
    for (const name of ['add_booking', 'update_booking']) {
      assert.match(tools[name].description, /does not change (a|the) stop/i, name);
      assert.match(tools[name].description, /set_stop_from_booking/, name);
    }
  });

  test('argument validation refuses bad ids, dates, booking ids and a PIN — before any request is made', async () => {
    const cases = [
      ['update_stop', { phase_id: 'Colmar', title_en: 'x' }],
      ['update_stop', { phase_id: '../admin', title_en: 'x' }],
      ['update_stop', { phase_id: 'a'.repeat(49), title_en: 'x' }],
      ['update_stop', { phase_id: '', title_en: 'x' }],
      ['update_stop', { phase_id: 'colmar', start: '2026-12-4', end: '2026-12-07' }],
      ['update_stop', { phase_id: 'colmar', end: 'next friday' }],
      ['update_stop', { phase_id: 'colmar', title_en: 'x', on_outside: 'drop' }],
      ['update_stop', { phase_id: 'colmar', title_en: 'x', on_outside: 'move_to:Not An Id' }],
      ['update_stop', { phase_id: 'colmar', accommodation: { name: 'Hotel', pin: '0000' } }],
      ['update_stop', { phase_id: 'colmar', accommodation: { name: 'Hotel', location_url: 'javascript:alert(1)' } }],
      ['update_stop', { phase_id: 'colmar', title_en: 'x', revision: 'anything' }],
      ['split_stop', { phase_id: 'colmar', at_date: 'tomorrow', title_en: 'x' }],
      ['split_stop', { phase_id: 'colmar', at_date: '2026-12-06', title_en: 'x', booking_id: 0 }],
      ['set_stop_from_booking', { phase_id: 'colmar', booking_id: -1 }],
      ['set_stop_from_booking', { phase_id: 'colmar', booking_id: 1.5 }],
      ['set_stop_from_booking', { phase_id: 'colmar', booking_id: '7' }],
      ['set_stop_from_booking', { phase_id: 'colmar/../x', booking_id: 7 }],
      ['move_plan_day', { from_phase_id: 'colmar', date: '12/05/2026', to_phase_id: 'frankfurt' }],
      ['move_plan_day', { from_phase_id: 'colmar', date: '2026-12-05', to_phase_id: 'FRANKFURT' }],
      ['move_plan_day', { from_phase_id: 'colmar', date: '2026-12-05', to_phase_id: 'frankfurt', headline: 'merge' }],
    ];
    const before = requests.length;
    for (const [name, args] of cases) {
      const message = await expectRefusedArgs(() => mcpCallTool(name, args));
      assert.match(message, /validation|invalid|unrecognized/i, `${name} ${JSON.stringify(args)} refused by validation: ${message}`);
    }
    assert.equal(requests.length, before, `no request reached the trip site: ${JSON.stringify(requests.slice(before))}`);
  });

  test('get_stops reads GET /api/stops with the trip key', async () => {
    const result = parseToolJson(await mcpCallTool('get_stops'));
    assert.equal(result.revision, 'st-4');
    assert.deepEqual(last(), { method: 'GET', url: '/api/stops', apiKey: TRIP_API_KEY, ifMatch: null, body: null });
  });

  test('update_stop with every field maps 1:1 onto PATCH /api/stops/:id, and returns the effective stop', async () => {
    const accommodation = { name: 'Hotel Colmar Centre', type: 'hotel', confirmation: 'HCC-778', location_url: 'https://maps.example/colmar' };
    const result = parseToolJson(await mcpCallTool('update_stop', {
      phase_id: 'colmar', start: '2026-12-02', end: '2026-12-06', title_he: 'קולמר', title_en: 'Colmar',
      accommodation, on_outside: 'move_to:frankfurt',
    }));
    assert.deepEqual(result.stop.dates, { start: '2026-12-02', end: '2026-12-06' });
    assert.deepEqual(last(), {
      method: 'PATCH', url: '/api/stops/colmar', apiKey: TRIP_API_KEY, ifMatch: null,
      body: { dates: { start: '2026-12-02', end: '2026-12-06' }, title: { he: 'קולמר', en: 'Colmar' }, accommodation, on_outside: 'move_to:frankfurt' },
    });
  });

  test('update_stop with one end of the range or one language fills the other from the stop as it is, under its revision', async () => {
    const at = requests.length;
    parseToolJson(await mcpCallTool('update_stop', { phase_id: 'colmar', end: '2026-12-06', title_en: 'Colmar old town' }));
    const sent = requests.slice(at);
    assert.deepEqual(sent.map(r => `${r.method} ${r.url}`), ['GET /api/stops', 'PATCH /api/stops/colmar']);
    assert.deepEqual(sent[1].body, { dates: { start: '2026-12-02', end: '2026-12-06' }, title: { he: 'קולמר', en: 'Colmar old town' } });
    assert.equal(sent[1].ifMatch, '"st-4"', 'the merge is sent under the revision it was read at');
  });

  test('update_stop: a string title is kept for the language not given', async () => {
    parseToolJson(await mcpCallTool('update_stop', { phase_id: 'frankfurt', title_he: 'פרנקפורט' }));
    assert.deepEqual(last().body, { title: { he: 'פרנקפורט', en: 'Frankfurt' } });
  });

  test('update_stop: one end of a range on a stop with no dates is refused readably, with nothing written', async () => {
    const at = requests.length;
    const message = parseToolError(await mcpCallTool('update_stop', { phase_id: 'frankfurt', start: '2026-12-02' }));
    assert.match(message, /no dates yet/);
    assert.match(message, /both start and end/);
    assert.ok(!requests.slice(at).some(r => r.method !== 'GET'), 'nothing written');
  });

  test('update_stop: an unknown or computed stop, or nothing to change, is refused readably', async () => {
    assert.match(parseToolError(await mcpCallTool('update_stop', { phase_id: 'nowhere', end: '2026-12-05' })), /get_stops/);
    assert.match(parseToolError(await mcpCallTool('update_stop', { phase_id: 'open-days', end: '2026-12-05' })), /not a stop/i);
    const at = requests.length;
    assert.match(parseToolError(await mcpCallTool('update_stop', { phase_id: 'colmar' })), /nothing to change/i);
    assert.equal(requests.length, at);
  });

  test('update_stop passes a caller\'s revision as If-Match; a stale one surfaces the server\'s refusal', async () => {
    parseToolJson(await mcpCallTool('update_stop', { phase_id: 'colmar', title_en: 'Colmar', title_he: 'קולמר', revision: 'st-4' }));
    assert.equal(last().ifMatch, '"st-4"');
    const message = parseToolError(await mcpCallTool('update_stop', { phase_id: 'colmar', title_en: 'Colmar', title_he: 'קולמר', revision: 'st-3' }));
    assert.match(message, /stops_changed_reload_before_retry/);
    assert.match(message, /get_stops/);
  });

  test('the 409 "items outside the stop" refusal reaches the model whole — every item — with what to do next', async () => {
    const message = parseToolError(await mcpCallTool('update_stop', { phase_id: 'colmar', start: '2026-12-04', end: '2026-12-06' }));
    assert.match(message, /409/);
    assert.match(message, /items_outside_stop/);
    assert.match(message, /on_outside/);
    for (const item of OUTSIDE_ITEMS) assert.ok(message.includes(item.item_uid), `${item.item_uid} is in the refusal`);
  });

  test('dates outside the trip are refused with the trip\'s range', async () => {
    const message = parseToolError(await mcpCallTool('update_stop', { phase_id: 'colmar', start: '2026-12-02', end: '2026-12-09' }));
    assert.match(message, /dates_outside_trip/);
    assert.match(message, /2026-12-07/);
  });

  test('split_stop maps onto POST /api/stops/:id/split with the new stop\'s title and hotel', async () => {
    const accommodation = { name: 'Airport Hotel', type: 'hotel' };
    const result = parseToolJson(await mcpCallTool('split_stop', {
      phase_id: 'colmar', at_date: '2026-12-06', title_he: 'ליד שדה התעופה', title_en: 'Near the airport', accommodation,
    }));
    assert.equal(result.stops[1].id, 'near-the-airport');
    assert.deepEqual(last(), {
      method: 'POST', url: '/api/stops/colmar/split', apiKey: TRIP_API_KEY, ifMatch: null,
      body: { at: '2026-12-06', new_stop: { title: { he: 'ליד שדה התעופה', en: 'Near the airport' }, accommodation } },
    });
  });

  test('split_stop without a title for the new stop is refused before any request', async () => {
    const at = requests.length;
    assert.match(parseToolError(await mcpCallTool('split_stop', { phase_id: 'colmar', at_date: '2026-12-06' })), /title/);
    assert.equal(requests.length, at);
  });

  test('split_stop with booking_id splits, then links the booking to the NEW stop', async () => {
    const at = requests.length;
    const result = parseToolJson(await mcpCallTool('split_stop', { phase_id: 'colmar', at_date: '2026-12-06', title_en: 'Near the airport', booking_id: 9 }));
    const sent = requests.slice(at);
    assert.deepEqual(sent.map(r => `${r.method} ${r.url}`), ['POST /api/stops/colmar/split', 'POST /api/stops/near-the-airport/from-booking']);
    assert.deepEqual(sent[1].body, { booking_id: 9 });
    assert.equal(result.booking.items.checkin, 'booking_9_checkin');
  });

  test('split_stop: a refused booking link says the split DID happen and which stop to link later — it is not reported as a failed split', async () => {
    const result = parseToolJson(await mcpCallTool('split_stop', { phase_id: 'colmar', at_date: '2026-12-06', title_en: 'Near the airport', booking_id: 7 }));
    assert.equal(result.split.stops[1].id, 'near-the-airport');
    assert.equal(result.booking_link.refused, true);
    assert.equal(result.booking_link.error, 'booking_is_draft');
    assert.match(result.booking_link.message, /near-the-airport/);
    assert.match(result.booking_link.message, /set_stop_from_booking/);
  });

  test('set_stop_from_booking maps onto POST /api/stops/:id/from-booking; add_checkin_checkout false is create_items false', async () => {
    const result = parseToolJson(await mcpCallTool('set_stop_from_booking', { phase_id: 'colmar', booking_id: 12 }));
    assert.equal(result.items.checkin, 'booking_12_checkin');
    assert.deepEqual(last(), { method: 'POST', url: '/api/stops/colmar/from-booking', apiKey: TRIP_API_KEY, ifMatch: null, body: { booking_id: 12 } });
    parseToolJson(await mcpCallTool('set_stop_from_booking', { phase_id: 'colmar', booking_id: 12, add_checkin_checkout: false, on_outside: 'keep', revision: 'st-4' }));
    assert.deepEqual(last().body, { booking_id: 12, create_items: false, on_outside: 'keep' });
    assert.equal(last().ifMatch, '"st-4"');
  });

  test('set_stop_from_booking: a draft booking is refused readably', async () => {
    const message = parseToolError(await mcpCallTool('set_stop_from_booking', { phase_id: 'colmar', booking_id: 7 }));
    assert.match(message, /booking_is_draft/);
    assert.match(message, /draft/i);
  });

  test('move_plan_day maps onto POST /api/itinerary/move-day; a headline clash surfaces and resolves with headline', async () => {
    parseToolJson(await mcpCallTool('move_plan_day', { from_phase_id: 'open-days', date: '2026-12-04', to_phase_id: 'colmar' }));
    assert.deepEqual(last(), {
      method: 'POST', url: '/api/itinerary/move-day', apiKey: TRIP_API_KEY, ifMatch: null,
      body: { from_phase_id: 'open-days', date: '2026-12-04', to_phase_id: 'colmar' },
    });
    const clash = parseToolError(await mcpCallTool('move_plan_day', { from_phase_id: 'colmar', date: '2026-12-05', to_phase_id: 'frankfurt' }));
    assert.match(clash, /target_day_has_headline/);
    assert.match(clash, /keep_target/);
    parseToolJson(await mcpCallTool('move_plan_day', { from_phase_id: 'colmar', date: '2026-12-05', to_phase_id: 'frankfurt', headline: 'take_source' }));
    assert.equal(last().body.headline, 'take_source');
  });

  test('split_stop: a booking filed under, or linked to, another stop — the refusal says in words what to do', async () => {
    const belongs = parseToolJson(await mcpCallTool('split_stop', { phase_id: 'colmar', at_date: '2026-12-06', title_en: 'Near the airport', booking_id: 8 }));
    assert.equal(belongs.booking_link.error, 'booking_belongs_to_another_stop');
    assert.match(belongs.booking_link.message, /filed under another stop/);
    assert.match(belongs.booking_link.message, /set_stop_from_booking/);
    const linked = parseToolError(await mcpCallTool('set_stop_from_booking', { phase_id: 'colmar', booking_id: 11 }));
    assert.match(linked, /booking_linked_to_another_stop/);
    assert.match(linked, /already sets another stop/);
  });

  test('Hebrew abbreviations typed with an ASCII " are sent with ״ (U+05F4) — in every free-text field of update_stop', async () => {
    parseToolJson(await mcpCallTool('update_stop', {
      phase_id: 'colmar', title_he: 'טיסה לארה"ב דרך חו"ל', title_en: 'Colmar',
      accommodation: {
        name: { he: 'מלון ת"א', en: 'Hotel TLV' }, address: 'רח׳ הרצל 1, ראשל"צ', confirmation: 'אב"ג-1',
        description: { he: 'קרוב לבע"מ', en: 'Near the office' }, note: 'חו"ל', dates: 'א"ב"ג', guests: 4,
        location_url: 'https://maps.example/colmar',
      },
    }));
    const sent = last().body;
    assert.equal(sent.title.he, 'טיסה לארה״ב דרך חו״ל', 'both occurrences');
    assert.equal(sent.title.en, 'Colmar');
    assert.deepEqual(sent.accommodation, {
      name: { he: 'מלון ת״א', en: 'Hotel TLV' }, address: 'רח׳ הרצל 1, ראשל״צ', confirmation: 'אב״ג-1',
      description: { he: 'קרוב לבע״מ', en: 'Near the office' }, note: 'חו״ל', dates: 'א״ב״ג', guests: 4,
      location_url: 'https://maps.example/colmar',
    });
  });

  test('split_stop: the new stop\'s title and accommodation get the same rewrite', async () => {
    parseToolJson(await mcpCallTool('split_stop', {
      phase_id: 'colmar', at_date: '2026-12-06', title_he: 'ליד נתב"ג', title_en: 'Near the airport', accommodation: { name: 'מלון ת"א' },
    }));
    assert.deepEqual(last().body.new_stop, { title: { he: 'ליד נתב״ג', en: 'Near the airport' }, accommodation: { name: 'מלון ת״א' } });
  });

  test('any other " is sent as typed, and the server\'s refusal reaches the model with what to do', async () => {
    for (const args of [
      { phase_id: 'colmar', title_he: 'קולמר', title_en: 'Colmar "old town"' },        // Latin-Latin
      { phase_id: 'colmar', title_he: 'ת"a', title_en: 'Colmar' },                     // mixed
      { phase_id: 'colmar', accommodation: { name: 'Hotel', note: 'a 55" TV' } },       // digit-Latin
      { phase_id: 'colmar', title_he: 'ת"א" onmouseover=alert(1)', title_en: 'x' },    // a second quote
    ]) {
      const message = parseToolError(await mcpCallTool('update_stop', args));
      assert.match(message, /invalid_text/, JSON.stringify(args));
      assert.match(message, /single quotes/, 'the hint says what to do');
      const sent = JSON.stringify(last().body);
      assert.ok(sent.includes('\\"'), `the " was not rewritten away: ${sent}`);
    }
  });

  test('a trip site with no stop routes yet (built before them) is named as such, not as an unknown stop', async () => {
    const message = parseToolError(await mcpCallTool('set_stop_from_booking', { phase_id: 'frankfurt2', booking_id: 3 }));
    assert.match(message, /404/);
    assert.match(message, /does not have stop editing yet/);
  });
});

// ── 2. mcp/mcp.js against the real trip server ───────────────────────────────
function colmarConfig() {
  return {
    meta: { title: 'Alsace 2026', brand: 'ALSACE', departure: '2026-12-02', returnDate: '2026-12-07', totalDays: 6, deploymentNonce: 'mcp-stops-test', defaultLang: 'he' },
    participants: [
      { username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' },
      { username: 'bob', name: 'בוב', name_en: 'Bob', family: 'a', color: '#10B981' },
    ],
    phases: [
      { id: 'frankfurt', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT' },
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR' },
      {
        id: 'open-days', unplanned: true, title: { he: 'ימים שעוד לא תוכננו', en: 'Days not planned yet' }, tabLabel: '?',
        dates: { start: '2026-12-02', end: '2026-12-07' },
        note: { he: '6 ימים', en: '6 day(s) of this trip do not belong to a stop yet.' },
      },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

async function bootTripServer(port) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-trip-stops-'));
  const tripDir = join(dataDir, 'trip');
  mkdirSync(tripDir, { recursive: true });
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(colmarConfig(), null, 2));
  writeFileSync(join(tripDir, 'bookings.json'), '[]');
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  const proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(port), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_URL: '',
      HERMES_API_KEY: TRIP_API_KEY, SEED_PASSWORD: '1234' },
  });
  let log = '';
  proc.stdout.on('data', c => { log += c; });
  proc.stderr.on('data', c => { log += c; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
    proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log.slice(-600)}`)); });
    setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log.slice(-600)}`)); }, 10_000);
  });
  const base = `http://localhost:${port}`;
  return {
    dataDir, base,
    async call(path, { method = 'GET', body } = {}) {
      const res = await fetch(`${base}${path}`, {
        method, headers: { 'X-API-Key': TRIP_API_KEY, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise(res => proc.once('exit', res));
        proc.kill('SIGTERM');
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('mcp/mcp.js stop tools — against the real trip server (the colmar trip, 10 Oct run)', () => {
  let site;
  const phase = async (id) => (await site.call('/api/config')).body.phases.find(p => p.id === id);
  const items = async () => (await site.call('/api/itinerary/active')).body.items;

  before(async () => {
    site = await bootTripServer(PORTS.mcpTripStopsSite);
    await startTestMcp({ API_BASE_URL: site.base, MCP_PORT: String(PORTS.mcpTripStopsLive), MCP_API_KEY });
  });
  after(async () => {
    stopTestMcp();
    await site?.stop();
  });

  test('get_stops lists the stops, open-days computed', async () => {
    const result = parseToolJson(await mcpCallTool('get_stops'));
    assert.deepEqual(result.stops.map(s => [s.id, s.kind]), [['frankfurt', 'config'], ['colmar', 'config'], ['open-days', 'computed']]);
    assert.match(result.revision, /^st-\d+$/);
  });

  test('move_plan_day files a day planned under open-days onto Colmar', async () => {
    const add = await site.call('/api/itinerary/items', { method: 'POST', body: { phase_id: 'open-days', date: '2026-12-04', text_he: 'שוק', text_en: 'Christmas market' } });
    assert.equal(add.status, 201);
    const result = parseToolJson(await mcpCallTool('move_plan_day', { from_phase_id: 'open-days', date: '2026-12-04', to_phase_id: 'colmar' }));
    assert.equal(result.moved.items.length, 1);
    assert.equal((await items()).find(i => i.text_en === 'Christmas market').phase_id, 'colmar');
    // A target that is the computed block is the route's refusal, surfaced.
    assert.match(parseToolError(await mcpCallTool('move_plan_day', { from_phase_id: 'colmar', date: '2026-12-04', to_phase_id: 'open-days' })), /unknown_stop/);
  });

  test('set_stop_from_booking: a draft is refused; the approved hotel sets Colmar\'s dates and hotel, with check-in/out', async () => {
    const Database = require('../server/node_modules/better-sqlite3');
    const db = new Database(join(site.dataDir, 'trip.db'));
    let draft;
    try {
      draft = db.prepare("INSERT INTO bookings (phase, type, name, date_from, date_to, created_by, review_status) VALUES ('colmar','hotel','Draft Hotel','2026-12-02','2026-12-07','alice','draft')").run().lastInsertRowid;
    } finally { db.close(); }
    const refused = parseToolError(await mcpCallTool('set_stop_from_booking', { phase_id: 'colmar', booking_id: Number(draft) }));
    assert.match(refused, /booking_is_draft/);
    assert.ok(!refused.includes('Draft Hotel'), 'the refused draft is not echoed');

    const hotel = (await site.call('/api/bookings', { method: 'POST', body: {
      phase: 'colmar', type: 'hotel', name: 'Hotel Colmar Centre', date_from: '2026-12-02', date_to: '2026-12-07', confirmation: 'HCC-778',
    } })).body.id;
    const result = parseToolJson(await mcpCallTool('set_stop_from_booking', { phase_id: 'colmar', booking_id: hotel }));
    assert.deepEqual(result.stop.dates, { start: '2026-12-02', end: '2026-12-07' });
    assert.deepEqual(result.items, { checkin: `booking_${hotel}_checkin`, checkout: `booking_${hotel}_checkout` });
    const colmar = await phase('colmar');
    assert.deepEqual(colmar.dates, { start: '2026-12-02', end: '2026-12-07' });
    assert.equal(colmar.accommodation.name, 'Hotel Colmar Centre');
  });

  test('update_stop: one end of the range, merged and sent under the read revision; a shrink with items outside is refused with the list', async () => {
    const refused = parseToolError(await mcpCallTool('update_stop', { phase_id: 'colmar', start: '2026-12-05' }));
    assert.match(refused, /items_outside_stop/);
    assert.match(refused, /Christmas market/);
    assert.deepEqual((await phase('colmar')).dates, { start: '2026-12-02', end: '2026-12-07' }, 'nothing changed');
    const kept = parseToolJson(await mcpCallTool('update_stop', { phase_id: 'colmar', start: '2026-12-03', title_en: 'Colmar old town', on_outside: 'keep' }));
    assert.deepEqual(kept.stop.dates, { start: '2026-12-03', end: '2026-12-07' });
    const colmar = await phase('colmar');
    assert.deepEqual(colmar.title, { he: 'קולמר', en: 'Colmar old town' }, 'the Hebrew title survived an English-only rename');
  });

  test('split_stop with booking_id: "last night near the airport" — two stops, the hotel on the new one', async () => {
    const airport = (await site.call('/api/bookings', { method: 'POST', body: {
      phase: 'colmar', type: 'hotel', name: 'Airport Hotel', date_from: '2026-12-06', date_to: '2026-12-07',
    } })).body.id;
    await site.call('/api/itinerary/items', { method: 'POST', body: { phase_id: 'colmar', date: '2026-12-07', text_he: 'טיסה', text_en: 'Fly home' } });
    const result = parseToolJson(await mcpCallTool('split_stop', {
      phase_id: 'colmar', at_date: '2026-12-06', title_he: 'ליד שדה התעופה', title_en: 'Near the airport', booking_id: airport,
    }));
    const newId = result.split.stops[1].id;
    assert.equal(newId, 'near-the-airport');
    assert.equal(result.booking.stop.accommodation.name, 'Airport Hotel');
    const cfg = (await site.call('/api/config')).body;
    assert.deepEqual(cfg.phases.find(p => p.id === 'colmar').dates, { start: '2026-12-03', end: '2026-12-06' });
    assert.deepEqual(cfg.phases.find(p => p.id === newId).dates, { start: '2026-12-06', end: '2026-12-07' });
    assert.equal((await items()).find(i => i.text_en === 'Fly home').phase_id, newId);
    // The airport hotel was filed under Colmar; linked to the new stop, it is
    // re-filed there. Colmar's own hotel keeps Colmar, and its check-in.
    const filed = async (p) => (await site.call(`/api/bookings?phase=${p}`)).body.map(b => b.name);
    assert.deepEqual(await filed(newId), ['Airport Hotel']);
    assert.ok((await filed('colmar')).includes('Hotel Colmar Centre'));
    assert.ok(!(await filed('colmar')).includes('Airport Hotel'));
    assert.equal(cfg.phases.find(p => p.id === 'colmar').accommodation.name, 'Hotel Colmar Centre');
    assert.equal((await items()).find(i => i.text_en === 'Check-in — Hotel Colmar Centre')?.phase_id, 'colmar');
  });

  test('update_stop: a Hebrew abbreviation typed with " is stored with ״; any other " is refused readably, nothing stored', async () => {
    const result = parseToolJson(await mcpCallTool('update_stop', { phase_id: 'colmar', title_he: 'קולמר (ליד ארה"ב?)', title_en: 'Colmar old town' }));
    assert.equal(result.stop.title.he, 'קולמר (ליד ארה״ב?)');
    assert.equal((await phase('colmar')).title.he, 'קולמר (ליד ארה״ב?)');
    const refused = parseToolError(await mcpCallTool('update_stop', { phase_id: 'colmar', title_he: 'קולמר', title_en: 'Colmar "old town"' }));
    assert.match(refused, /400 invalid_text/);
    assert.match(refused, /title\.en/);
    assert.match(refused, /single quotes/);
    assert.equal((await phase('colmar')).title.en, 'Colmar old town', 'nothing stored');
  });

  test('update_stop accommodation takes a bilingual name, as the server\'s text fields do, and replaces the whole accommodation', async () => {
    const result = parseToolJson(await mcpCallTool('update_stop', {
      phase_id: 'colmar', accommodation: { name: { he: 'מלון קולמר', en: 'Hotel Colmar' }, type: 'hotel' },
    }));
    assert.deepEqual(result.stop.accommodation, { name: { he: 'מלון קולמר', en: 'Hotel Colmar' }, type: 'hotel' });
    assert.deepEqual((await phase('colmar')).accommodation, { name: { he: 'מלון קולמר', en: 'Hotel Colmar' }, type: 'hotel' });
  });
});

// ── 3. server/trip-mcp/tools.js — write gating and routes ────────────────────
describe('server/trip-mcp/tools.js stop tools — absent on a read-only connection', () => {
  const { McpServer } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js');
  const { Client } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
  const { InMemoryTransport } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js');
  const { registerTools } = require('../server/trip-mcp/tools.js');

  // A stand-in for siteClient(): records the call, answers like the routes,
  // and fails the way siteClient does (an Error carrying status and body).
  function fakeSite() {
    const calls = [];
    const refuse = (method, path, status, body) => { throw new Error(`${method} ${path} → ${status} ${JSON.stringify(body).slice(0, 300)}`); };
    const answer = (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/api/stops') {
        return { revision: 'st-4', stops: [{ id: 'colmar', kind: 'config', unplanned: false, stop: COLMAR }] };
      }
      if (path === '/api/stops/colmar/from-booking' && body.booking_id === 7) refuse(method, path, 409, { error: 'booking_is_draft' });
      if (path === '/api/stops/colmar/from-booking' && body.booking_id === 8) refuse(method, path, 409, { error: 'booking_belongs_to_another_stop', stop: 'frankfurt' });
      if (path === '/api/stops/colmar/from-booking' && body.booking_id === 11) refuse(method, path, 409, { error: 'booking_linked_to_another_stop', stop: 'near-the-airport' });
      if (path === '/api/stops/colmar/from-booking' && body.booking_id === 13) refuse(method, path, 400, { error: 'invalid_text', field: 'accommodation.name', source: 'booking' });
      if (path === '/api/stops/colmar/from-booking' && body.booking_id === 14) refuse(method, path, 400, { error: 'invalid_link', field: 'accommodation.location_url', source: 'booking' });
      if (path === '/api/stops/colmar' && body?.dates?.start === '2026-12-04' && !body.on_outside) refuse(method, path, 409, { error: 'items_outside_stop', items: OUTSIDE_ITEMS });
      if (path === '/api/stops/colmar/split') return { stops: [COLMAR, { id: 'near-the-airport' }] };
      return { ok: true, stop: { id: 'colmar' } };
    };
    return {
      calls,
      get: async path => answer('GET', path),
      post: async (path, body) => answer('POST', path, body ?? {}),
      patch: async (path, body) => answer('PATCH', path, body ?? {}),
      del: async path => answer('DELETE', path),
    };
  }

  async function connect(write) {
    const site = fakeSite();
    const server = new McpServer({ name: 'test', version: '1' });
    registerTools(server, site, { write });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { site, client, close: () => client.close() };
  }

  test('read-only: none of the stop tools is offered (get_stops is organizer-only, like the briefing); calling one fails', async () => {
    const { client, site, close } = await connect(false);
    try {
      const names = (await client.listTools()).tools.map(t => t.name);
      assert.ok(names.includes('get_config'), 'read tools are still there');
      for (const name of STOP_TOOLS) assert.ok(!names.includes(name), `${name} must not be offered read-only`);
      const call = await client.callTool({ name: 'update_stop', arguments: { phase_id: 'colmar', title_en: 'x' } }).catch(err => ({ isError: true, err }));
      assert.equal(call.isError, true);
      assert.equal(site.calls.length, 0, 'nothing reached the site');
    } finally { await close(); }
  });

  test('organizer (write): all five are offered; the write ones are marked as writes; booking tools point at set_stop_from_booking', async () => {
    const { client, close } = await connect(true);
    try {
      const tools = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t]));
      for (const name of STOP_TOOLS) assert.ok(tools[name], name);
      assert.equal(tools.get_stops.annotations.readOnlyHint, true);
      for (const name of WRITE_STOP_TOOLS) {
        assert.equal(tools[name].annotations.readOnlyHint, false, name);
        assert.match(tools[name].description, /refuse/i, name);
      }
      for (const name of ['add_booking', 'update_booking']) {
        assert.match(tools[name].description, /does not change (a|the) stop/i, name);
        assert.match(tools[name].description, /set_stop_from_booking/, name);
      }
    } finally { await close(); }
  });

  test('organizer (write): each tool calls its route with the route\'s body', async () => {
    const { client, site, close } = await connect(true);
    try {
      const ok = async (name, args) => {
        const r = await client.callTool({ name, arguments: args });
        assert.notEqual(r.isError, true, `${name}: ${r.content?.[0]?.text}`);
        return JSON.parse(r.content[0].text);
      };
      await ok('get_stops', {});
      await ok('update_stop', { phase_id: 'colmar', end: '2026-12-06', title_he: 'קולמר העתיקה' });
      await ok('split_stop', { phase_id: 'colmar', at_date: '2026-12-06', title_en: 'Near the airport', booking_id: 9 });
      await ok('set_stop_from_booking', { phase_id: 'colmar', booking_id: 12, add_checkin_checkout: false });
      await ok('move_plan_day', { from_phase_id: 'colmar', date: '2026-12-05', to_phase_id: 'frankfurt' });
      assert.deepEqual(site.calls, [
        { method: 'GET', path: '/api/stops', body: undefined },
        { method: 'GET', path: '/api/stops', body: undefined },
        { method: 'PATCH', path: '/api/stops/colmar', body: { dates: { start: '2026-12-02', end: '2026-12-06' }, title: { he: 'קולמר העתיקה', en: 'Colmar' } } },
        { method: 'POST', path: '/api/stops/colmar/split', body: { at: '2026-12-06', new_stop: { title: { en: 'Near the airport' } } } },
        { method: 'POST', path: '/api/stops/near-the-airport/from-booking', body: { booking_id: 9 } },
        { method: 'POST', path: '/api/stops/colmar/from-booking', body: { booking_id: 12, create_items: false } },
        { method: 'POST', path: '/api/itinerary/move-day', body: { from_phase_id: 'colmar', date: '2026-12-05', to_phase_id: 'frankfurt' } },
      ]);
    } finally { await close(); }
  });

  test('organizer (write): Hebrew abbreviations are sent with ״ in update_stop and split_stop; any other " is sent as typed', async () => {
    const { client, site, close } = await connect(true);
    try {
      const call = async (name, args) => {
        const r = await client.callTool({ name, arguments: args });
        assert.notEqual(r.isError, true, `${name}: ${r.content?.[0]?.text}`);
      };
      await call('update_stop', { phase_id: 'colmar', title_he: 'ארה"ב וחו"ל', title_en: 'say "hi"',
        accommodation: { name: { he: 'מלון ת"א', en: 'a"b' }, address: 'ראשל"צ', note: '55" TV', location_url: 'https://maps.example/x' } });
      await call('split_stop', { phase_id: 'colmar', at_date: '2026-12-06', title_he: 'ליד נתב"ג', accommodation: { name: 'בע"מ' } });
      const [patch, split] = site.calls.filter(c => c.method !== 'GET');
      assert.deepEqual(patch.body, {
        title: { he: 'ארה״ב וחו״ל', en: 'say "hi"' },
        accommodation: { name: { he: 'מלון ת״א', en: 'a"b' }, address: 'ראשל״צ', note: '55" TV', location_url: 'https://maps.example/x' },
      });
      assert.deepEqual(split.body, { at: '2026-12-06', new_stop: { title: { he: 'ליד נתב״ג' }, accommodation: { name: 'בע״מ' } } });
    } finally { await close(); }
  });

  test('organizer (write): the four refusals the hardening added each say what to do', async () => {
    const { client, close } = await connect(true);
    try {
      for (const [bookingId, code, words] of [
        [8, 'booking_belongs_to_another_stop', /filed under another stop/],
        [11, 'booking_linked_to_another_stop', /already sets another stop/],
        [13, 'invalid_text', /single quotes/],
        [14, 'invalid_link', /http/],
      ]) {
        const r = await client.callTool({ name: 'set_stop_from_booking', arguments: { phase_id: 'colmar', booking_id: bookingId } });
        assert.equal(r.isError, true, code);
        assert.match(r.content[0].text, new RegExp(code));
        assert.match(r.content[0].text.split('\n').slice(1).join('\n'), words, `${code}: the hint, not the echoed body`);
      }
    } finally { await close(); }
  });

  test('organizer (write): bad ids and dates are refused before the site is called; server refusals surface with what to do', async () => {
    const { client, site, close } = await connect(true);
    try {
      for (const [name, args] of [
        ['update_stop', { phase_id: '../x', title_en: 'x' }],
        ['split_stop', { phase_id: 'colmar', at_date: '6/12', title_en: 'x' }],
        ['set_stop_from_booking', { phase_id: 'colmar', booking_id: 0 }],
        ['move_plan_day', { from_phase_id: 'colmar', date: '2026-12-05', to_phase_id: 'Frankfurt' }],
      ]) {
        const r = await client.callTool({ name, arguments: args }).catch(err => ({ isError: true, content: [{ text: err.message }] }));
        assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
      }
      assert.equal(site.calls.length, 0);
      const draft = await client.callTool({ name: 'set_stop_from_booking', arguments: { phase_id: 'colmar', booking_id: 7 } });
      assert.equal(draft.isError, true);
      assert.match(draft.content[0].text, /booking_is_draft/);
      assert.match(draft.content[0].text, /draft/i);
      const outside = await client.callTool({ name: 'update_stop', arguments: { phase_id: 'colmar', start: '2026-12-04', end: '2026-12-06' } });
      assert.equal(outside.isError, true);
      assert.match(outside.content[0].text, /items_outside_stop/);
      assert.match(outside.content[0].text, /on_outside/);
    } finally { await close(); }
  });
});
