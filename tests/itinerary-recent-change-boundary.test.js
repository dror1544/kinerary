/**
 * itinerary-recent-change-boundary.test.js — the member-visible half of video
 * Release 1B, over HTTP, as a member, an organizer and the agent key
 * (docs/specs/sprint-9/x-video-r1-site-look.md: AC-1, AC-4, AC-14, AC-23, AC-28).
 *
 * This file is the evidence the boundary review reads. It starts the real trip
 * server three times — `features` absent, `plan_change_marks` on, and only
 * `site_video_layout` on — makes real plan edits through the agent key, and reads
 * /api/itinerary/active and /api/today back as each kind of caller.
 *
 *   - a member never learns who changed or who added an item: no `recent_change`
 *     key outside kind/at/fields/previous_time/previous_date, no author, note or
 *     revision id in it, and no `created_by` on any served item (AC-28);
 *   - an organizer and the agent key still get `created_by`, as before;
 *   - /api/itinerary/revisions (which lists authors) is still 403 to a member;
 *   - with the switch off, no `recent_change` text anywhere in either body, and with
 *     it on but nothing changed the items are byte-identical to the off server (AC-1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/port-guard.js';


const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
const AGENT_KEY = 'test-hermes-key';
const CLOSED_KEYS = ['at', 'fields', 'kind', 'previous_date', 'previous_time'];

async function withServer(features, fn) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'trip-recent-'));
  const tripDir = join(dataDir, 'trip');
  cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  const cfg = JSON.parse(JSON.stringify(FIXTURE));
  if (features !== undefined) cfg.features = features;
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  const proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(port), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
      HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234' },
  });
  let log = '';
  proc.stderr.on('data', (c) => { log += c; });
  proc.stdout.on('data', (c) => { log += c; });
  try {
    await new Promise((resolve, reject) => {
      const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
      proc.on('exit', (code) => { clearInterval(t); reject(new Error(`server exited ${code}: ${log}`)); });
      setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log}`)); }, 15_000);
    });
    const tokenFor = async (username) => {
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: '1234' }) });
        if (r.ok) return (await r.json()).token;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error(`${username} could not log in`);
    };
    const member = { Authorization: `Bearer ${await tokenFor('bob')}` };
    const organizer = { Authorization: `Bearer ${await tokenFor('alice')}` };
    const agent = { 'X-API-Key': AGENT_KEY };
    const call = async (headers, path, init = {}) => {
      const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, body, headers: res.headers };
    };
    return await fn({ member, organizer, agent, call, dataDir, log: () => log });
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// Real edits through the agent key: one added item today, one existing item moved to
// today and re-timed. Returns the date used and the two uids.
async function makeEdits({ agent, call }) {  // edits seconds after boot: the system's own first-boot versions must not hide them
  const { body: today } = await call(agent, '/api/today');
  const date = today.today;
  const added = await call(agent, '/api/itinerary/items', { method: 'POST', body: JSON.stringify({ phase_id: 'ny', date, text_he: 'ארוחת ערב', text_en: 'Dinner at the pier', time: '20:00', item_type: 'meal' }) });
  assert.equal(added.status, 201, added.text);
  const active = (await call(agent, '/api/itinerary/active')).body;
  const park = active.items.find((i) => i.text_en === 'Visit Central Park');
  const patched = await call(agent, `/api/itinerary/items/${park.item_uid}`, { method: 'PATCH', body: JSON.stringify({ date, time: '19:00' }) });
  assert.equal(patched.status, 200, patched.text);
  return { date, addedUid: added.body.item_uid, parkUid: park.item_uid, parkDate: park.date, parkTime: park.time };
}

const itemsOf = (body) => body.items;
const todayItems = (body) => [body.current, body.next, ...body.events].filter(Boolean);

describe('switches off: the pages are what they were, minus the author', () => {
  test('AC-1/AC-28: no recent_change anywhere; a member gets no created_by, organizer and agent still do', async () => {
    await withServer(undefined, async ({ member, organizer, agent, call, dataDir }) => {
      const edits = await makeEdits({ agent, call, dataDir });
      for (const path of ['/api/itinerary/active', '/api/today']) {
        const m = await call(member, path);
        assert.equal(m.status, 200);
        assert.ok(!m.text.includes('recent_change'), `${path}: recent_change served with the switch off`);
        const items = path.endsWith('active') ? itemsOf(m.body) : todayItems(m.body);
        assert.ok(items.length > 0, `${path}: nothing to check`);
        for (const item of items) assert.ok(!('created_by' in item), `${path}: member sees created_by on ${item.item_uid}`);
        assert.ok(!m.text.includes('"hermes"'), `${path}: the agent's name reached a member`);

        for (const [who, headers] of [['organizer', organizer], ['agent', agent]]) {
          const r = await call(headers, path);
          assert.equal(r.status, 200);
          assert.ok(!r.text.includes('recent_change'));
          const theirs = path.endsWith('active') ? itemsOf(r.body) : todayItems(r.body);
          assert.ok(theirs.every((i) => 'created_by' in i), `${path}: ${who} lost created_by`);
        }
      }
      const added = (await call(agent, '/api/itinerary/active')).body.items.find((i) => i.item_uid === edits.addedUid);
      assert.equal(added.created_by, 'hermes', 'the organizer-or-agent view still says who added it');
      // The member's item has exactly the organizer's keys minus the author and the organizer-only extras.
      const orgItem = (await call(organizer, '/api/itinerary/active')).body.items.find((i) => i.item_uid === edits.addedUid);
      const memItem = (await call(member, '/api/itinerary/active')).body.items.find((i) => i.item_uid === edits.addedUid);
      const organizerOnly = new Set(['created_by', 'seed_changed', 'seed_removed', 'plan_conflicts']);
      assert.deepEqual(Object.keys(memItem), Object.keys(orgItem).filter((k) => !organizerOnly.has(k)));
    });
  });

  test('/api/itinerary/revisions (which lists authors) is 403 to a member and open to the organizer and the agent', async () => {
    await withServer(undefined, async ({ member, organizer, agent, call }) => {
      assert.equal((await call(member, '/api/itinerary/revisions')).status, 403);
      assert.equal((await call(organizer, '/api/itinerary/revisions')).status, 200);
      assert.equal((await call(agent, '/api/itinerary/revisions')).status, 200);
    });
  });

  test('AC-4: only site_video_layout on -> the server serves no recent_change', async () => {
    await withServer({ site_video_layout: true }, async ({ member, agent, call, dataDir }) => {
      await makeEdits({ agent, call, dataDir });
      for (const path of ['/api/itinerary/active', '/api/today']) {
        assert.ok(!(await call(member, path)).text.includes('recent_change'));
      }
      const cfg = (await call(member, '/api/config')).body;
      assert.deepEqual(cfg.features, { site_video_layout: true }, 'the member page is told its layout switch and nothing more');
    });
  });
});

// AC-28 says "any route serving plan items": the Classic table route serves phase_plan_items rows, which
// carry created_by, so it is checked too (server/seed-reconcile.js shapePlanItem drops it for non-organizers).
describe('AC-28: the Classic plan route', () => {
  test('GET /api/phases/:id/plan serves a member no created_by; the organizer and the agent still get it', async () => {
    await withServer(undefined, async ({ member, organizer, agent, call }) => {
      const asMember = await call(member, '/api/phases/ny/plan');
      assert.equal(asMember.status, 200);
      assert.ok(asMember.body.length > 0);
      assert.ok(!asMember.text.includes('created_by'), 'created_by reached a member on the Classic plan route');
      const asOrganizer = await call(organizer, '/api/phases/ny/plan');
      assert.ok(asOrganizer.text.includes('created_by'), 'the organizer still sees who added an item');
      const asAgent = await call(agent, '/api/phases/ny/plan');
      assert.ok(asAgent.text.includes('created_by'), 'the agent key still sees who added an item');
    });
  });
});

describe('server.js hands living-journey its one featureOn', () => {
  test('livingJourney.create is given featureOn, so the raw features block is read in one place', () => {
    const src = readFileSync(join(REPO, 'server', 'server.js'), 'utf8');
    const call = src.slice(src.indexOf('livingJourney.create({'), src.indexOf('journey.registerRoutes('));
    assert.match(call, /\n\s+featureOn,\n/);
  });
});

describe('plan_change_marks on', () => {
  test('AC-1: with nothing changed the items are byte-identical to the switch-off server', async () => {
    let off;
    await withServer(undefined, async ({ member, call }) => { off = (await call(member, '/api/itinerary/active')).body; });
    await withServer({ plan_change_marks: true }, async ({ member, call }) => {
      const on = (await call(member, '/api/itinerary/active')).body;
      // revision_id is the version each row was written in: random per server, not part of the claim.
      const bare = (rows) => JSON.stringify(rows.map(({ revision_id, ...rest }) => rest));
      assert.equal(bare(on.items), bare(off.items));
      assert.equal(bare(on.days), bare(off.days));
    });
  });

  test('AC-14/AC-23/AC-28: a member reads Updated and Added markers with no author, note or revision id', async () => {
    await withServer({ plan_change_marks: true }, async ({ member, organizer, agent, call, dataDir }) => {
      const edits = await makeEdits({ agent, call, dataDir });
      const active = await call(member, '/api/itinerary/active');
      const marked = itemsOf(active.body).filter((i) => i.recent_change);
      assert.deepEqual(marked.map((i) => i.item_uid).sort(), [edits.addedUid, edits.parkUid].sort(), 'exactly the two edited items are marked');
      const park = marked.find((i) => i.item_uid === edits.parkUid).recent_change;
      assert.equal(park.kind, 'updated');
      assert.deepEqual(park.fields, ['time', 'date']);
      assert.equal(park.previous_time, edits.parkTime);
      assert.equal(park.previous_date, edits.parkDate);
      assert.match(park.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      const added = marked.find((i) => i.item_uid === edits.addedUid).recent_change;
      assert.deepEqual({ kind: added.kind, fields: added.fields }, { kind: 'added', fields: [] });

      for (const path of ['/api/itinerary/active', '/api/today']) {
        for (const [who, headers] of [['member', member], ['organizer', organizer], ['agent', agent]]) {
          const r = await call(headers, path);
          assert.equal(r.status, 200);
          const items = path.endsWith('active') ? itemsOf(r.body) : todayItems(r.body);
          for (const item of items) {
            if (!item.recent_change) continue;
            assert.ok(Object.keys(item.recent_change).every((k) => CLOSED_KEYS.includes(k)), `${path}/${who}: ${Object.keys(item.recent_change)}`);
            // Nothing that names a person or a revision rides on the marker, for anyone.
            assert.doesNotMatch(JSON.stringify(item.recent_change), /hermes|alice|bob|active_|original_|note/i);
          }
        }
        const m = await call(member, path);
        assert.ok(!/"created_by"/.test(m.text), `${path}: created_by reached a member`);
      }

      const today = await call(member, '/api/today');
      const events = today.body.events.filter((e) => e.recent_change).map((e) => e.item_uid).sort();
      assert.deepEqual(events, [edits.addedUid, edits.parkUid].sort(), 'both edited items are on today, marked');
      const next = [today.body.next, today.body.current].filter((i) => i?.recent_change);
      for (const item of next) assert.ok(CLOSED_KEYS.includes('kind') && item.recent_change.kind);
    });
  });

  test('a member is still refused the revision list, with markers on', async () => {
    await withServer({ plan_change_marks: true }, async ({ member, agent, call, dataDir }) => {
      await makeEdits({ agent, call, dataDir });
      const r = await call(member, '/api/itinerary/revisions');
      assert.equal(r.status, 403);
      assert.ok(!r.text.includes('hermes'));
    });
  });

  test('the ETag follows the payload: unchanged is a 304, a new edit is a new ETag', async () => {
    await withServer({ plan_change_marks: true }, async ({ member, agent, call, dataDir }) => {
      const a = await call(member, '/api/itinerary/active');
      const etag = a.headers.get('etag');
      assert.ok(etag);
      assert.equal((await call({ ...member, 'If-None-Match': etag }, '/api/itinerary/active')).status, 304);
      await makeEdits({ agent, call, dataDir });
      const b = await call({ ...member, 'If-None-Match': etag }, '/api/itinerary/active');
      assert.equal(b.status, 200);
      assert.notEqual(b.headers.get('etag'), etag);
    });
  });
});
