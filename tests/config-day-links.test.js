/**
 * config-day-links.test.js — Sprint 4.7 "carry the enriched links onto the
 * itinerary lines" item.
 *
 * Provision-time enrichment (control_plane_worker/enrichment.py) matches a
 * config day line to the phase venue it names and copies that venue's
 * maps / waze / url onto the day ITEM — siblings of {time, text}, because the
 * extract schema has no per-item URL field and never emits inline <a>.
 *
 *   A. rendering — renderDays()'s config-days branch turns those siblings into
 *      the same 🗺️/🔵/🎫 buttons the venue card shows, and drops a non-http one.
 *   B. promotion — promote-config-days lifts them into the editable plan layer's
 *      dedicated columns (location_url / waze_url / ticket_url), not just the
 *      inline-<a> path it already had, and a re-run backfills them.
 *   C. persistence — a trip DB that seeded / promoted before the links existed
 *      picks them up on the next boot (P1: bookings.json seed backfill; P2:
 *      the promote backfill no longer gated on extra_links).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startTestServer, stopTestServer, api } from './helpers/server.js';
import { createRenderContext } from './helpers/dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_KEY = 'test-hermes-key';

// A phase whose days carry the sibling links enrichment writes. "Skytree" has
// the full set, "TeamLab" only a map, "Onsen" carries a junk (non-http) url
// that must never reach an href, and "Free morning" carries nothing.
const TOKYO_PHASE = {
  id: 'tokyo',
  tabLabel: 'TOKYO',
  title: { he: 'טוקיו', en: 'Tokyo' },
  dates: { start: '2027-04-01', end: '2027-04-04' },
  venues: [
    { id: 'skytree', name: { he: 'סקייטרי', en: 'Tokyo Skytree' },
      url: 'https://www.tokyo-skytree.jp/en/',
      maps: 'https://www.google.com/maps/search/?api=1&query=Tokyo%20Skytree',
      waze: 'https://waze.com/ul?q=Tokyo%20Skytree&navigate=yes' },
  ],
  days: [
    {
      date: '2027-04-02',
      label: { he: 'סקייטרי', en: 'Skytree day' },
      items: [
        { time: '10:00',
          text: { he: 'כניסה ל-Tokyo Skytree', en: 'Entry to Tokyo Skytree (e-ticket)' },
          maps: 'https://www.google.com/maps/search/?api=1&query=Tokyo%20Skytree',
          waze: 'https://waze.com/ul?q=Tokyo%20Skytree&navigate=yes',
          url:  'https://www.tokyo-skytree.jp/en/' },
        { time: '18:00',
          text: { he: 'טימלאב', en: 'TeamLab Planets' },
          maps: 'https://www.google.com/maps/search/?api=1&query=TeamLab%20Planets' },
        { time: '20:00',
          text: { he: 'אונסן', en: 'Onsen' },
          url: 'javascript:alert(1)' },
        { time: '09:00', text: { he: 'בוקר חופשי', en: 'Free morning' } },
      ],
    },
  ],
};

const T_STRINGS = {
  he: { plan_unscheduled: 'ללא תאריך', plan_original_sched: 'המסלול המקורי', plan_enriching: 'מעדכן…' },
  en: { plan_unscheduled: 'Unscheduled', plan_original_sched: 'Original schedule', plan_enriching: 'Updating…' },
};

// ── A. Rendering ────────────────────────────────────────────────────────────
describe('A. renderDays() config-days branch renders the carried links', () => {
  function render() {
    const { document, ctx } = createRenderContext(
      '<div id="sched-tokyo"></div>',
      { phases: [TOKYO_PHASE] },
      'en',
      { isOrganizer: false, PHASE_PLAN: {}, PHASE_PLAN_DAYS: {}, T: T_STRINGS },
    );
    ctx.renderDays(TOKYO_PHASE);
    return document.getElementById('sched-tokyo');
  }

  test('an item with the full set gets 🗺️/🔵/🎫, each pointing at its url', () => {
    const el = render();
    const li = [...el.querySelectorAll('li')].find(n => n.textContent.includes('Tokyo Skytree'));
    const hrefs = [...li.querySelectorAll('a.day-item-link')].map(a => a.getAttribute('href'));
    assert.equal(hrefs.length, 3);
    assert.ok(hrefs.some(h => h.includes('google.com/maps') && h.includes('Tokyo%20Skytree')));
    assert.ok(hrefs.some(h => h.startsWith('https://waze.com/ul?q=Tokyo%20Skytree')));
    assert.ok(hrefs.includes('https://www.tokyo-skytree.jp/en/'));
  });

  test('an item with only a map link gets just the 🗺️ button', () => {
    const el = render();
    const li = [...el.querySelectorAll('li')].find(n => n.textContent.includes('TeamLab'));
    const links = li.querySelectorAll('a.day-item-link');
    assert.equal(links.length, 1);
    assert.match(links[0].getAttribute('href'), /TeamLab%20Planets/);
  });

  test('a non-http item url never becomes an href', () => {
    const el = render();
    const li = [...el.querySelectorAll('li')].find(n => n.textContent.trim().startsWith('20:00'));
    assert.equal(li.querySelectorAll('a').length, 0);
    assert.ok(!el.innerHTML.includes('javascript:'), 'javascript: url leaked into the DOM');
  });

  test('an item with no links renders no link span at all', () => {
    const el = render();
    const li = [...el.querySelectorAll('li')].find(n => n.textContent.includes('Free morning'));
    assert.equal(li.querySelectorAll('.day-item-links').length, 0);
  });
});

// ── B. Promotion ───────────────────────────────────────────────────────────
describe('B. promote-config-days lifts the carried links into the plan layer', () => {
  let tripDir = null;

  before(async () => {
    tripDir = mkdtempSync(join(tmpdir(), 'trip-day-links-'));
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
    const cfgPath = join(tripDir, 'trip.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.phases = [...(cfg.phases || []), TOKYO_PHASE];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    await startTestServer({ PORT: '3110', TRIP_DIR: tripDir });
  });
  after(() => {
    stopTestServer();
    if (tripDir) { try { rmSync(tripDir, { recursive: true, force: true }); } catch {} tripDir = null; }
  });

  const tokyoRows = async () =>
    (await (await api('/api/phases/tokyo/plan', { apiKey: AGENT_KEY })).json())
      .filter(i => i.config_ref);

  test('the sibling maps/waze/url land in location_url / waze_url / ticket_url', async () => {
    const res = await api('/api/phase-plan/promote-config-days', { method: 'POST', apiKey: AGENT_KEY });
    assert.equal(res.status, 200);

    const rows = await tokyoRows();
    const skytree = rows.find(i => (i.text_en || '').includes('Tokyo Skytree'));
    assert.ok(skytree, 'the Skytree item should have promoted');
    assert.match(skytree.location_url, /google\.com\/maps.*Tokyo%20Skytree/);
    assert.equal(skytree.waze_url, 'https://waze.com/ul?q=Tokyo%20Skytree&navigate=yes');
    assert.equal(skytree.ticket_url, 'https://www.tokyo-skytree.jp/en/');

    const teamlab = rows.find(i => (i.text_en || '').includes('TeamLab'));
    assert.match(teamlab.location_url, /TeamLab%20Planets/);
    assert.equal(teamlab.waze_url, null);
    assert.equal(teamlab.ticket_url, null);
  });

  test('a non-http sibling url is dropped, not stored', async () => {
    const onsen = (await tokyoRows()).find(i => (i.text_en || '') === 'Onsen');
    assert.ok(onsen);
    assert.equal(onsen.ticket_url, null);
    assert.equal(onsen.location_url, null);
  });

  test('re-running promote backfills the link columns onto an existing row', async () => {
    const before = (await tokyoRows()).find(i => (i.text_en || '').includes('Tokyo Skytree'));
    // Simulate a row promoted by the older code path — links cleared.
    await api(`/api/phases/tokyo/plan/${before.id}`, {
      method: 'PATCH', apiKey: AGENT_KEY,
      body: { location_url: null, waze_url: null, ticket_url: null },
    });
    const res = await api('/api/phase-plan/promote-config-days', { method: 'POST', apiKey: AGENT_KEY });
    assert.equal(res.status, 200);
    const after = (await tokyoRows()).find(i => i.id === before.id);
    assert.match(after.location_url, /Tokyo%20Skytree/);
    assert.equal(after.waze_url, 'https://waze.com/ul?q=Tokyo%20Skytree&navigate=yes');
    assert.equal(after.ticket_url, 'https://www.tokyo-skytree.jp/en/');
  });
});

// ── C. Persistence: a DB seeded/promoted before the links existed ───────────
const SERVER_JS_C = join(HERE, '..', 'server', 'server.js');

function bootOnce(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_JS_C], {
      cwd: join(HERE, '..', 'server'),
      env: { ...process.env, PORT: String(port), JWT_SECRET: 'test-secret-000',
             IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234', ...env },
    });
    let ready = false;
    proc.stdout.on('data', c => { if (!ready && c.toString().includes('Trip server running on')) { ready = true; resolve(proc); } });
    proc.on('error', reject);
    proc.on('exit', code => { if (!ready) reject(new Error(`server exited with ${code} before ready`)); });
    setTimeout(() => { if (!ready) reject(new Error('boot timeout')); }, 10_000);
  });
}
const stopProc = (proc) => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });
const reqC = (port, path, opts = {}) =>
  fetch(`http://localhost:${port}${path}`, { headers: { 'X-API-Key': AGENT_KEY, ...(opts.headers || {}) }, ...opts });

// A kyoto phase whose one day item carries an inline <a> map link and NO
// siblings — exactly a row that ends up with non-null extra_links.
const KYOTO_PHASE = {
  id: 'kyoto', tabLabel: 'KYOTO', title: { he: 'קיוטו', en: 'Kyoto' },
  dates: { start: '2027-05-01', end: '2027-05-03' },
  days: [{
    date: '2027-05-02',
    label: { he: 'קינקאקוג׳י', en: 'Kinkaku-ji' },
    items: [{
      time: '10:00',
      text: {
        he: 'ביקור ב-<a href="https://www.google.com/maps/search/?api=1&query=Kinkaku-ji">Kinkaku-ji</a>',
        en: 'Visit <a href="https://www.google.com/maps/search/?api=1&query=Kinkaku-ji">Kinkaku-ji</a>',
      },
    }],
  }],
};

describe('C. links reach a DB that was seeded / promoted before they existed', () => {
  const PORT = 3111;
  let dataDir, tripDir;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-day-links-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'trip-day-links-trip-'));
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
    const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
    cfg.phases = [...(cfg.phases || []), KYOTO_PHASE];
    writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));
    // Two seed hotels: one with no location_url yet, one an organizer already
    // pinned (its link must never be stomped by a later bookings.json value).
    writeFileSync(join(tripDir, 'bookings.json'), JSON.stringify([
      { phase: 'kyoto', type: 'hotel', name: 'Cross Hotel Kyoto', seed_key: 'hotel_kyoto', cost: 0 },
      { phase: 'kyoto', type: 'hotel', name: 'Locked Inn', seed_key: 'hotel_locked',
        location_url: 'https://locked.example/keep', cost: 0 },
    ], null, 2));
  });
  after(() => {
    for (const d of [dataDir, tripDir]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  test('first boot: seed hotel has no link, promoted row has extra_links but no waze/ticket', async () => {
    const proc = await bootOnce(PORT, { TRIP_DIR: tripDir, DATA_DIR: dataDir });
    try {
      assert.equal((await reqC(PORT, '/api/phase-plan/promote-config-days', { method: 'POST' })).status, 200);

      const bookings = await (await reqC(PORT, '/api/bookings')).json();
      assert.equal(bookings.find(b => b.seed_key === 'hotel_kyoto').location_url, null);
      assert.equal(bookings.find(b => b.seed_key === 'hotel_locked').location_url, 'https://locked.example/keep');

      const row = (await (await reqC(PORT, '/api/phases/kyoto/plan')).json()).find(i => i.config_ref);
      assert.ok(JSON.parse(row.extra_links || '[]').length >= 1, 'inline <a> should populate extra_links');
      assert.match(row.location_url, /Kinkaku-ji/);
      assert.equal(row.waze_url, null);
      assert.equal(row.ticket_url, null);
    } finally { await stopProc(proc); }
  });

  test('after bookings.json gains the link and config gains siblings, a reboot picks both up', async () => {
    // P1: fill the missing seed link; try to change the locked one.
    writeFileSync(join(tripDir, 'bookings.json'), JSON.stringify([
      { phase: 'kyoto', type: 'hotel', name: 'Cross Hotel Kyoto', seed_key: 'hotel_kyoto',
        location_url: 'https://maps.example/kyoto-hotel', cost: 0 },
      { phase: 'kyoto', type: 'hotel', name: 'Locked Inn', seed_key: 'hotel_locked',
        location_url: 'https://locked.example/CHANGED', cost: 0 },
    ], null, 2));
    // P2: the same promoted day item now also has waze/url siblings.
    const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
    cfg.phases.find(p => p.id === 'kyoto').days[0].items[0].waze = 'https://waze.com/ul?q=Kinkaku-ji&navigate=yes';
    cfg.phases.find(p => p.id === 'kyoto').days[0].items[0].url  = 'https://www.shokoku-ji.jp/kinkakuji/';
    writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));

    const proc = await bootOnce(PORT, { TRIP_DIR: tripDir, DATA_DIR: dataDir });
    try {
      const bookings = await (await reqC(PORT, '/api/bookings')).json();
      // P1: a seed row that was NULL gets filled on the next boot …
      assert.equal(bookings.find(b => b.seed_key === 'hotel_kyoto').location_url, 'https://maps.example/kyoto-hotel');
      // … but one already set is left exactly as the organizer had it.
      assert.equal(bookings.find(b => b.seed_key === 'hotel_locked').location_url, 'https://locked.example/keep');

      const before = (await (await reqC(PORT, '/api/phases/kyoto/plan')).json()).find(i => i.config_ref);
      assert.equal(before.waze_url, null, 'sanity: not backfilled until promote re-runs');

      assert.equal((await reqC(PORT, '/api/phase-plan/promote-config-days', { method: 'POST' })).status, 200);
      const after = (await (await reqC(PORT, '/api/phases/kyoto/plan')).json()).find(i => i.id === before.id);
      // P2: waze/ticket backfill even though extra_links is already non-null …
      assert.equal(after.waze_url, 'https://waze.com/ul?q=Kinkaku-ji&navigate=yes');
      assert.equal(after.ticket_url, 'https://www.shokoku-ji.jp/kinkakuji/');
      // … and the columns that were already set are untouched.
      assert.equal(after.extra_links, before.extra_links);
      assert.equal(after.location_url, before.location_url);
    } finally { await stopProc(proc); }
  });
});
