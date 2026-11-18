/**
 * plan-changes-route.test.js — GET /api/internal/control-plane/plan-changes, the one
 * route the control plane's group line reads (video Release 1C,
 * docs/specs/sprint-9/x-video-r1-group-line.md: AC-21, AC-26, AC-27 and the
 * `since_known` rule).
 *
 * This file is the evidence the boundary review reads. It starts the real trip server
 * with a control-plane identity manifest and an exchange key, makes real plan edits
 * through the agent key, and reads the route back:
 *
 *   - no key, a wrong key, the agent key, a member's session: 401, and no plan data;
 *   - the right key and ANOTHER trip's id: 403 TRIP_MISMATCH, and no plan data;
 *   - the right key and this trip's id: 200 with only the closed keys of the contract —
 *     no author, note, created_by, keep_both_with, booking field or revision author;
 *   - the items it reports are the items the site marks Updated / New for the same
 *     two revisions (AC-21);
 *   - a `since` that is not in the active plan's chain describes nothing.
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
const EXCHANGE_KEY = 'test-dedicated-exchange-key';
const TRIP_ID = 'trip_planchanges01';
const ROUTE = '/api/internal/control-plane/plan-changes';
const TOP_KEYS = ['active_created_at', 'active_revision_id', 'changes', 'changes_omitted', 'group_change_line', 'language', 'now_local', 'since_known', 'time_zone', 'today'];
const CHANGE_KEYS = ['date', 'fields', 'kind', 'previous_date', 'previous_text_en', 'previous_text_he', 'previous_time', 'text_en', 'text_he', 'time'];

async function withServer(features, fn) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'trip-plan-changes-'));
  const tripDir = join(dataDir, 'trip');
  cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  const cfg = JSON.parse(JSON.stringify(FIXTURE));
  if (features !== undefined) cfg.features = features;
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  const manifest = join(dataDir, 'identity.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId: TRIP_ID, owner: { userId: 'user_planowner01', username: 'alice' } }));
  const proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(port), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
      HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234',
      CONTROL_PLANE_EXCHANGE_KEY: EXCHANGE_KEY, CONTROL_PLANE_IDENTITY_FILE: manifest },
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
    const poll = (since, { key = EXCHANGE_KEY, trip = TRIP_ID } = {}) => call(
      { ...(key ? { 'x-api-key': key } : {}), ...(trip ? { 'x-control-plane-trip-id': trip } : {}) },
      `${ROUTE}${since === undefined ? '' : `?since=${encodeURIComponent(since)}`}`,
    );
    return await fn({ member, organizer, agent, call, poll });
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const sorted = (keys) => [...keys].sort();

async function today({ agent, call }) {
  return (await call(agent, '/api/today')).body.today;
}

describe('AC-26: the route is behind internal()', () => {
  test('no key, a wrong key, the agent key and a member session are 401 with no plan data; another trip is 403', async () => {
    await withServer({ plan_change_marks: true }, async ({ member, agent, call, poll }) => {
      // Something to leak: a plan edit by a named agent.
      const date = await today({ agent, call });
      const added = await call(agent, '/api/itinerary/items', { method: 'POST', body: JSON.stringify({ phase_id: 'ny', date, text_he: 'סודי', text_en: 'Secret winery visit', time: '16:00', item_type: 'activity' }) });
      assert.equal(added.status, 201, added.text);

      const cases = [
        ['no key', await poll('x', { key: null })],
        ['a wrong key', await poll('x', { key: 'not-the-key' })],
        ['the agent key', await poll('x', { key: AGENT_KEY })],
        ['a member session', await call(member, `${ROUTE}?since=x`)],
      ];
      for (const [label, r] of cases) {
        assert.equal(r.status, 401, label);
        assert.deepEqual(r.body, { error: 'AUTHENTICATION_REQUIRED' }, label);
        assert.ok(!r.text.includes('Secret winery'), `${label}: plan data in the body`);
      }
      const wrongTrip = await poll('x', { trip: 'trip_anothertrip01' });
      assert.equal(wrongTrip.status, 403);
      assert.deepEqual(wrongTrip.body, { error: 'TRIP_MISMATCH' });
      assert.ok(!wrongTrip.text.includes('Secret winery'));
      const noTrip = await poll('x', { trip: null });
      assert.equal(noTrip.status, 403);
      assert.equal(noTrip.headers.get('cache-control'), 'no-store');
    });
  });
});

describe('the answer', () => {
  test('a first read (no since) says where the plan is and describes nothing; the keys are closed', async () => {
    await withServer(undefined, async ({ poll }) => {
      const r = await poll();
      assert.equal(r.status, 200, r.text);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.deepEqual(sorted(Object.keys(r.body)), TOP_KEYS);
      assert.match(r.body.active_revision_id, /^[A-Za-z0-9_-]{4,100}$/);
      assert.match(r.body.active_created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.equal(r.body.since_known, false);
      assert.deepEqual(r.body.changes, []);
      assert.equal(r.body.group_change_line, true, 'AC-25: on by default');
      assert.equal(r.body.language, 'he');
      assert.equal(r.body.time_zone, 'UTC', 'the fixture names no trip timezone: the site falls back to UTC');
      assert.match(r.body.today, /^\d{4}-\d\d-\d\d$/);
      assert.match(r.body.now_local, /^\d\d:\d\d$/);
    });
  });

  test('the trip\'s own timezone override and the setting reach the answer', async () => {
    await withServer(undefined, async ({ agent, call, poll }) => {
      const patched = await call(agent, '/api/settings', { method: 'PATCH', body: JSON.stringify({ timezone: 'europe/paris' }) });
      assert.equal(patched.status, 200, patched.text);
      assert.equal((await poll()).body.time_zone, 'Europe/Paris');
      const off = await call(agent, '/api/settings', { method: 'PATCH', body: JSON.stringify({ group_change_line: false }) });
      assert.equal(off.status, 200, off.text);
      const r = await poll();
      assert.equal(r.body.group_change_line, false);
      assert.equal(r.body.time_zone, 'Europe/Paris', 'a PATCH with only the setting leaves the timezone alone');
    });
  });

  test('AC-21: what it reports as updated or added is what the site marks, for the same two revisions', async () => {
    await withServer({ plan_change_marks: true }, async ({ member, agent, call, poll }) => {
      const first = (await poll()).body.active_revision_id;
      const date = await today({ agent, call });
      const added = await call(agent, '/api/itinerary/items', { method: 'POST', body: JSON.stringify({ phase_id: 'ny', date, text_he: 'ארוחת ערב', text_en: 'Dinner at the pier', time: '20:00', item_type: 'meal' }) });
      assert.equal(added.status, 201, added.text);
      const park = (await call(agent, '/api/itinerary/active')).body.items.find((i) => i.text_en === 'Visit Central Park');
      const patched = await call(agent, `/api/itinerary/items/${park.item_uid}`, { method: 'PATCH', body: JSON.stringify({ date, time: '19:00' }) });
      assert.equal(patched.status, 200, patched.text);

      const r = await poll(first);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.since_known, true);
      assert.notEqual(r.body.active_revision_id, first);

      const marked = (await call(member, '/api/itinerary/active')).body.items.filter((i) => i.recent_change);
      const byKind = (kind) => marked.filter((i) => i.recent_change.kind === kind).map((i) => i.text_en).sort();
      const reported = (kind) => r.body.changes.filter((c) => c.kind === kind).map((c) => c.text_en).sort();
      assert.deepEqual(reported('added'), byKind('added'));
      assert.deepEqual(reported('updated'), byKind('updated'));
      assert.deepEqual(reported('added'), ['Dinner at the pier']);
      assert.deepEqual(reported('updated'), ['Visit Central Park']);

      const moved = r.body.changes.find((c) => c.text_en === 'Visit Central Park');
      assert.deepEqual(moved.fields, ['time', 'date']);
      assert.equal(moved.time, '19:00');
      assert.equal(moved.previous_time, park.time);
      assert.equal(moved.previous_date, park.date);
      assert.equal(moved.date, date);
    });
  });

  test('AC-27: no author, note, created_by, keep_both_with, booking field or key outside the contract', async () => {
    await withServer(undefined, async ({ agent, call, poll }) => {
      const first = (await poll()).body.active_revision_id;
      const date = await today({ agent, call });
      const added = await call(agent, '/api/itinerary/items', { method: 'POST', body: JSON.stringify({ phase_id: 'ny', date, text_he: 'סודי', text_en: 'Winery visit', time: '16:00', item_type: 'activity', note: 'organizer private note' }) });
      assert.equal(added.status, 201, added.text);
      const gone = (await call(agent, '/api/itinerary/active')).body.items.find((i) => i.text_en === 'Visit Central Park');
      const removed = await call(agent, `/api/itinerary/items/${gone.item_uid}`, { method: 'DELETE' });
      assert.equal(removed.status, 200, removed.text);
      const r = await poll(first);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.changes.map((c) => c.kind).sort(), ['added', 'removed']);
      for (const change of r.body.changes) {
        for (const key of Object.keys(change)) assert.ok(CHANGE_KEYS.includes(key), `${key} is not in the contract`);
      }
      for (const word of ['hermes', 'alice', 'author', 'note', 'created_by', 'keep_both_with', 'booking', 'confirmation', 'cost', 'organizer private note', 'item_uid', 'revision_id']) {
        const wire = JSON.stringify({ ...r.body, active_revision_id: undefined });
        assert.ok(!wire.includes(word), `${word} reached the wire: ${wire}`);
      }
      assert.deepEqual(r.body.changes.find((c) => c.kind === 'removed').text_en, 'Visit Central Park');
    });
  });

  test('a since that is not in the active plan\'s chain is unknown and describes nothing', async () => {
    await withServer(undefined, async ({ agent, call, poll }) => {
      const date = await today({ agent, call });
      await call(agent, '/api/itinerary/items', { method: 'POST', body: JSON.stringify({ phase_id: 'ny', date, text_he: 'ב', text_en: 'Bike ride', time: '10:00', item_type: 'activity' }) });
      for (const since of ['rev_does_not_exist', 'x', '../../etc/passwd', 'a'.repeat(500), '']) {
        const r = await poll(since);
        assert.equal(r.status, 200, `${since.slice(0, 20)}: ${r.text}`);
        assert.equal(r.body.since_known, false);
        assert.deepEqual(r.body.changes, []);
      }
    });
  });

  test('only items dated today or later are reported: a change to a day already past is not news', async () => {
    await withServer(undefined, async ({ agent, call, poll }) => {
      const first = (await poll()).body.active_revision_id;
      const date = await today({ agent, call });
      const park = (await call(agent, '/api/itinerary/active')).body.items.find((i) => i.text_en === 'Visit Central Park');
      const breakfast = (await call(agent, '/api/itinerary/active')).body.items.find((i) => i.text_en === 'Breakfast');
      // One item moved onto a day that is over, another retimed today.
      const past = await call(agent, `/api/itinerary/items/${park.item_uid}`, { method: 'PATCH', body: JSON.stringify({ date: '2020-01-02', time: '19:00' }) });
      assert.equal(past.status, 200, past.text);
      const todays = await call(agent, `/api/itinerary/items/${breakfast.item_uid}`, { method: 'PATCH', body: JSON.stringify({ date, time: '08:15' }) });
      assert.equal(todays.status, 200, todays.text);
      const r = await poll(first);
      assert.equal(r.body.since_known, true);
      assert.deepEqual(r.body.changes.map((c) => c.text_en), ['Breakfast']);
    });
  });

  test('the switch is what /api/config tells the agent key (the bridge set_group_change_line reads it): the literal true, or absent', async () => {
    await withServer({ plan_change_group_line: true }, async ({ agent, member, call }) => {
      assert.equal((await call(agent, '/api/config')).body.features?.plan_change_group_line, true);
      assert.equal((await call(member, '/api/config')).body.features?.plan_change_group_line, true);
    });
    await withServer(undefined, async ({ agent, call }) => {
      assert.equal((await call(agent, '/api/config')).body.features?.plan_change_group_line, undefined);
    });
    await withServer({ plan_change_group_line: 'true' }, async ({ agent, call }) => {
      assert.notEqual((await call(agent, '/api/config')).body.features?.plan_change_group_line, true);
    });
  });

  test('the poll never moves the plan: reading it twice makes no new revision', async () => {
    await withServer(undefined, async ({ poll }) => {
      const a = (await poll()).body.active_revision_id;
      const b = (await poll(a)).body.active_revision_id;
      assert.equal(a, b);
    });
  });
});
