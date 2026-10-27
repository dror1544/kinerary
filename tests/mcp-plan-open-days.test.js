/**
 * mcp-plan-open-days.test.js — the companion's one call for "plan these open
 * days" (issue #133): plan_open_days on mcp/mcp.js → POST /api/stops.
 *
 *   1. against a STAND-IN site: the tool's exact route, body and If-Match; the
 *      argument checks that refuse before any request; the server's refusals
 *      reaching the model whole, with what to do next.
 *   2. against the REAL trip server: the stop AND its plan items arrive in one
 *      tool call; a refusal leaves the trip untouched; and a caller that does
 *      not hold the agent key is refused (the authority is the route's
 *      organizerOrAgentRequired — the tool adds no check of its own).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_API_KEY, TRIP_API_KEY, startTestMcp, stopTestMcp, mcpCallTool, mcpListTools } from './helpers/mcp.js';
import { PORTS } from './helpers/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

function parseToolJson(result) {
  assert.notEqual(result.isError, true, `expected success, got error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}
function parseToolError(result) {
  assert.equal(result.isError, true, `expected a tool error, got: ${result.content?.[0]?.text}`);
  return result.content[0].text;
}
async function expectRefusedArgs(call) {
  try { return parseToolError(await call()); } catch (err) {
    assert.match(err.message, /tools\/call error/);
    return err.message;
  }
}
function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(raw); } });
  });
}

const ARGS = {
  start: '2026-12-04', end: '2026-12-05', title_he: 'שטרסבורג', title_en: 'Strasbourg', tab_label: 'STRASBOURG',
  accommodation: { name: 'Hotel Strasbourg Centre', type: 'hotel' },
  day_titles: [{ date: '2026-12-04', label_en: 'The old town' }],
  items: [
    { date: '2026-12-04', time: '10:00', text_he: 'קתדרלת שטרסבורג', text_en: 'Strasbourg Cathedral' },
    { date: '2026-12-05', time: 'morning', text_he: 'שוק חג המולד', text_en: 'Christmas market', item_type: 'activity' },
  ],
};

// ── 1. stand-in ──────────────────────────────────────────────────────────────
describe('plan_open_days — against a stand-in trip site', () => {
  let apiServer;
  const requests = [];
  const last = () => requests.at(-1);
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  before(async () => {
    apiServer = createServer(async (req, res) => {
      const body = await parseBody(req);
      requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], ifMatch: req.headers['if-match'] ?? null, body });
      if (req.headers['x-api-key'] !== TRIP_API_KEY) return send(res, 401, { error: 'unauthorized' });
      const ifMatch = req.headers['if-match'];
      if (ifMatch && ifMatch.replace(/"/g, '') !== 'st-4') return send(res, 409, { error: 'stops_changed_reload_before_retry', revision: 'st-4' });
      if (req.method === 'POST' && req.url === '/api/stops') {
        if (body.dates.start === '2026-12-03') {
          return send(res, 409, { error: 'dates_overlap_stop', stop: 'frankfurt', days: ['2026-12-03'], open_days: [{ start: '2026-12-04', end: '2026-12-05' }] });
        }
        if (body.items?.some(i => i.date > body.dates.end)) return send(res, 400, { error: 'item_outside_stop', index: 1, date: '2026-12-06', stop: body.dates });
        return send(res, 201, {
          revision: 'st-5', itinerary_revision: 'rev_x', stop: { id: 'strasbourg', title: body.title, dates: body.dates },
          items: (body.items || []).map((i, n) => ({ item_uid: `item_${n}`, date: i.date })), moved_from_open_days: { items: [], days: [] }, open_days: [],
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(`<pre>Cannot ${req.method} ${req.url.split('?')[0]}</pre>`);
    });
    await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(0, '127.0.0.1', resolve); });
    await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${apiServer.address().port}`, MCP_PORT: String(PORTS.mcpPlanOpenDaysStand), MCP_API_KEY });
  });
  after(async () => {
    stopTestMcp();
    await new Promise((resolve) => apiServer.close(resolve));
  });

  test('the tool is listed and says it is one action, what it refuses, who may, and to read the result back', async () => {
    const tools = await mcpListTools();
    assert.ok(tools.plan_open_days, 'plan_open_days is listed');
    const d = tools.plan_open_days.description;
    assert.match(d, /ONE action/);
    assert.match(d, /all-or-nothing/);
    assert.match(d, /NOTHING is written/);
    assert.match(d, /refuse/i);
    assert.match(d, /read[^.]*back/i);
    assert.match(d, /Organizer or agent only/);
    assert.match(d, /update_stop/, 'says what NOT to rebuild it from');
    assert.match(tools.update_stop.description + tools.split_stop.description, /plan_open_days|open days/i);
  });

  test('maps onto POST /api/stops with the stop, the hotel, the headlines and every item; the revision is the If-Match', async () => {
    const r = parseToolJson(await mcpCallTool('plan_open_days', { ...ARGS, revision: 'st-4' }));
    assert.equal(r.stop.id, 'strasbourg');
    assert.equal(r.items.length, 2);
    assert.deepEqual(last(), {
      method: 'POST', url: '/api/stops', apiKey: TRIP_API_KEY, ifMatch: '"st-4"',
      body: {
        dates: { start: '2026-12-04', end: '2026-12-05' }, title: { he: 'שטרסבורג', en: 'Strasbourg' }, tabLabel: 'STRASBOURG',
        accommodation: ARGS.accommodation, items: ARGS.items, days: ARGS.day_titles,
      },
    });
  });

  test('a stop with no plan is sent without items; one title language is enough', async () => {
    parseToolJson(await mcpCallTool('plan_open_days', { start: '2026-12-04', end: '2026-12-04', title_en: 'Basel' }));
    assert.deepEqual(last().body, { dates: { start: '2026-12-04', end: '2026-12-04' }, title: { en: 'Basel' } });
    assert.equal(last().ifMatch, null);
  });

  test('argument validation refuses before any request: no title, bad dates, a bad item, markup-free shapes only', async () => {
    const cases = [
      { start: '2026-12-04', end: '2026-12-05' },
      { ...ARGS, start: 'tomorrow' },
      { ...ARGS, end: '2026-12-5' },
      { ...ARGS, items: [{ date: '2026-12-04' }] },
      { ...ARGS, items: [{ date: '04/12', text_he: 'x' }] },
      { ...ARGS, items: [{ date: '2026-12-04', text_he: 'x', time: '25:00' }] },
      { ...ARGS, items: [{ date: '2026-12-04', text_he: 'x', item_type: 'rave' }] },
      { ...ARGS, items: [{ date: '2026-12-04', text_he: 'x', location_url: 'javascript:alert(1)' }] },
      { ...ARGS, items: [{ date: '2026-12-04', text_he: 'x', surprise: true }] },
      { ...ARGS, accommodation: { name: 'Hotel', pin: '0000' } },
      { ...ARGS, revision: 'anything' },
    ];
    const before = requests.length;
    for (const args of cases) {
      const message = await expectRefusedArgs(() => mcpCallTool('plan_open_days', args));
      assert.match(message, /validation|invalid|unrecognized|needs a title/i, `${JSON.stringify(args).slice(0, 120)}: ${message}`);
    }
    assert.equal(requests.length, before, 'no request reached the trip site');
  });

  test('the site\'s refusals reach the model whole, with what to do next', async () => {
    const overlap = parseToolError(await mcpCallTool('plan_open_days', { ...ARGS, start: '2026-12-03' }));
    assert.match(overlap, /dates_overlap_stop/);
    assert.match(overlap, /open_days/);
    assert.match(overlap, /Nothing was written/);
    assert.match(overlap, /"stop":"frankfurt"/);
    const outside = parseToolError(await mcpCallTool('plan_open_days', { ...ARGS, items: [{ date: '2026-12-04', text_he: 'a' }, { date: '2026-12-06', text_he: 'b' }] }));
    assert.match(outside, /item_outside_stop/);
    assert.match(outside, /"index":1/);
    const stale = parseToolError(await mcpCallTool('plan_open_days', { ...ARGS, revision: 'st-1' }));
    assert.match(stale, /stops_changed_reload_before_retry/);
    assert.match(stale, /get_stops again/);
  });

  test('a trip site built before the route existed is named as such, not as an unknown stop', async () => {
    // The stand-in answers a bare HTML 404 for any other route; POST /api/stops is
    // handled above, so this checks the hint through the same helper on a sibling.
    const err = parseToolError(await mcpCallTool('move_plan_day', { from_phase_id: 'a', date: '2026-12-04', to_phase_id: 'b' }));
    assert.match(err, /does not have stop editing yet/);
  });
});

// ── 2. real server ───────────────────────────────────────────────────────────
function gapConfig() {
  return {
    meta: { title: 'Alsace 2026', brand: 'ALSACE', departure: '2026-12-02', returnDate: '2026-12-07', totalDays: 6, deploymentNonce: 'mcp-open-days', defaultLang: 'he' },
    participants: [
      { username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' },
      { username: 'bob', name: 'בוב', name_en: 'Bob', family: 'a', color: '#10B981' },
    ],
    phases: [
      { id: 'frankfurt', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT', dates: { start: '2026-12-02', end: '2026-12-03' } },
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR', dates: { start: '2026-12-06', end: '2026-12-07' } },
      {
        id: 'open-days', unplanned: true, title: { he: 'ימים שעוד לא תוכננו', en: 'Days not planned yet' }, tabLabel: '?',
        dates: { start: '2026-12-04', end: '2026-12-05' }, note: { he: '2 ימים', en: '2 day(s) of this trip do not belong to a stop yet.' },
      },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

async function bootTripServer(port) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-open-days-'));
  const tripDir = join(dataDir, 'trip');
  mkdirSync(tripDir, { recursive: true });
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(gapConfig(), null, 2));
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
    base,
    async call(path) {
      const res = await fetch(`${base}${path}`, { headers: { 'X-API-Key': TRIP_API_KEY } });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, body };
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

describe('plan_open_days — against the real trip server', () => {
  let site;
  const state = async () => ({ config: (await site.call('/api/config')).text, itinerary: (await site.call('/api/itinerary/active')).text });

  before(async () => {
    site = await bootTripServer(PORTS.mcpPlanOpenDaysSite);
    await startTestMcp({ API_BASE_URL: site.base, MCP_PORT: String(PORTS.mcpPlanOpenDaysMcp), MCP_API_KEY });
  });
  after(async () => {
    stopTestMcp();
    await site?.stop();
  });

  test('a caller that does not hold the agent key is refused by the site, and nothing is written', async () => {
    stopTestMcp();
    await startTestMcp({ API_BASE_URL: site.base, MCP_PORT: String(PORTS.mcpPlanOpenDaysMcp), MCP_API_KEY, TRIP_API_KEY: 'a-members-token-is-not-the-agent-key' });
    const before = await state();
    const refused = parseToolError(await mcpCallTool('plan_open_days', ARGS));
    assert.match(refused, /401/);
    assert.deepEqual(await state(), before);
    stopTestMcp();
    await startTestMcp({ API_BASE_URL: site.base, MCP_PORT: String(PORTS.mcpPlanOpenDaysMcp), MCP_API_KEY });
  });

  test('a refused plan (an item on a day outside the stretch) changes nothing — not even the items before it', async () => {
    const before = await state();
    const refused = parseToolError(await mcpCallTool('plan_open_days', { ...ARGS, items: [...ARGS.items, { date: '2026-12-07', text_he: 'x' }] }));
    assert.match(refused, /item_outside_stop/);
    assert.deepEqual(await state(), before);
    const overlap = parseToolError(await mcpCallTool('plan_open_days', { ...ARGS, start: '2026-12-03' }));
    assert.match(overlap, /dates_overlap_stop/);
    assert.deepEqual(await state(), before);
  });

  test('ONE tool call: the stop and its plan are on the site together, and the open days are gone', async () => {
    const stops = parseToolJson(await mcpCallTool('get_stops'));
    assert.deepEqual(stops.stops.map(s => [s.id, s.kind]), [['frankfurt', 'config'], ['open-days', 'computed'], ['colmar', 'config']]);
    const r = parseToolJson(await mcpCallTool('plan_open_days', { ...ARGS, revision: stops.revision }));
    assert.equal(r.stop.id, 'strasbourg');
    assert.equal(r.items.length, 2);
    assert.deepEqual(r.open_days, []);
    const config = (await site.call('/api/config')).body;
    assert.deepEqual(config.phases.map(p => p.id), ['frankfurt', 'strasbourg', 'colmar']);
    assert.equal(config.phases.find(p => p.id === 'strasbourg').accommodation.name, 'Hotel Strasbourg Centre');
    const active = (await site.call('/api/itinerary/active')).body;
    assert.deepEqual(active.items.filter(i => i.phase_id === 'strasbourg').map(i => i.text_en).sort(), ['Christmas market', 'Strasbourg Cathedral']);
    assert.equal(active.days.find(d => d.phase_id === 'strasbourg' && d.date === '2026-12-04').label_en, 'The old town');
    // The same stretch cannot be planned twice: the stale revision is the first line of defence, overlap the second.
    const again = parseToolError(await mcpCallTool('plan_open_days', ARGS));
    assert.match(again, /dates_overlap_stop/);
  });
});
