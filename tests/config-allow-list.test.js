/**
 * config-allow-list.test.js — GET /api/config serves an ALLOW-list (issue #172).
 *
 * sanitizeConfig() and publicAgent() used to name the fields to strip and pass
 * everything else through a deep copy verbatim, so a field nobody had thought
 * about — a passport number, an API key under `meta`, an internal id in the
 * agent block — reached every signed-in family member the day it was written.
 * shared/config-visibility.js now names the fields that MAY be served, and
 * anything it does not name is dropped.
 *
 * An allow-list fails the other way: a field the site needs and the list
 * forgot vanishes from the site, silently. So half of this file is the golden
 * round-trip — the tracked japan-2025 config and the config the provisioner
 * actually builds must come back with nothing dropped except what is withheld
 * on purpose. A new provisioner field that is not on the list fails HERE,
 * loudly, not on a family's phone.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PORTS } from './helpers/ports.js';
import { projectConfig, publicConfig } from '../shared/config-visibility.js';
import { publicAgent, normalizeTone, normalizeGender } from '../shared/agent-schema.js';
import { createRequire } from 'module';

// The trip server's own SQLite binding, to plant a row as the pre-fix import
// wrote it (tests/ has no better-sqlite3 of its own).
const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
const JAPAN = JSON.parse(readFileSync(join(REPO, 'trips', 'japan-2025', 'trip.config.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

// The fields issue #172 was proven with, plus one per level the old deny-list
// never looked at. Every value is unique so a leak is findable by substring.
function hostile(base = FIXTURE) {
  const cfg = clone(base);
  const alice = cfg.participants.find(p => p.username === 'alice');
  Object.assign(alice, {
    passport_number: 'X1234567', phone: '+972-50-1234567',
    email: 'alice@example.com', date_of_birth: '1980-04-02',
  });
  cfg.meta.immich_api_key = 'IMMICH-SECRET-ABC';
  cfg.meta.emergency_contact_phone = '+972-50-9999999';
  cfg.agent.SECRET_AGENT_FIELD = 'agent-internal-value';
  cfg.agent.profile = 'hermes:internal-profile-name';
  cfg.agent.proactive.secret_schedule = 'PROACTIVE-SECRET';
  cfg.agent.standing_instructions[0].author_note = 'INSTRUCTION-SECRET';
  cfg.participants.find(p => p.username === 'bob').needs[1].doctor = 'NEED-SECRET';
  cfg.phases[0].secret_phase_note = 'PHASE-SECRET';
  cfg.phases[0].accommodation.door_code = 'ACCOMMODATION-SECRET';
  cfg.phases[0].venues[0].owner_phone = 'VENUE-SECRET';
  cfg.travel_info.countries[Object.keys(cfg.travel_info.countries)[0]].visa_pin = 'COUNTRY-SECRET';
  cfg.SECRET_TOP_LEVEL = { token: 'TOP-SECRET' };
  // Right key, wrong shape: a scalar slot holding an object, a bilingual slot
  // carrying a third key. Both used to pass through whole.
  cfg.meta.title = { he: 'x', leaked: 'SHAPE-SECRET' };
  cfg.phases[0].title = { he: 'ניו יורק', en: 'New York', internal: 'TEXT-SECRET' };
  // Routes OTHER than /api/config that read the config (boundary review of
  // #172, round 2): /api/hermes/status served agent.name and agent.profile
  // raw; the itinerary import copied phases[].pickup whole and the lodging
  // name raw into rows /api/itinerary/active serves.
  cfg.agent.name = { he: 'ויקטור', x: 'LEAK-AGENT-NAME-X' };
  cfg.phases[0].pickup = { driver_phone: 'PICKUP-SECRET' };
  cfg.phases[0].accommodation.name = { he: 'מלון מרידיאן', en: 'Hotel Meridian', internal: 'LODGING-NAME-SECRET' };
  cfg.phases[0].days[0].items[0].tickets = { url: 'DAY-TICKETS-SECRET' };
  // Round 3: promoteConfigDays() — the boot-time import that becomes the
  // ACTIVE plan on a fresh DB — read these raw. A one-element array passes a
  // regex and binds in SQLite as a plain value, so each was stored and served.
  cfg.phases[0].days[0].label = ['DAY-LABEL-ARRAY-SECRET'];
  cfg.phases[0].days[0].items[0].text = ['ITEM-TEXT-ARRAY-SECRET'];
  cfg.phases[0].days[0].items[1].text.he = ['ITEM-TEXT-HE-ARRAY-SECRET'];
  cfg.phases[0].days[0].items.push({
    time: '15:00', text: { he: 'אחר הצהריים', en: 'Afternoon' },
    maps: ['https://maps.example/MAPS-ARRAY-SECRET'],
    waze: ['https://waze.example/WAZE-ARRAY-SECRET'],
    url: ['https://url.example/URL-ARRAY-SECRET'],
  });
  return cfg;
}
const HOSTILE_VALUES = [
  'X1234567', '+972-50-1234567', 'alice@example.com', '1980-04-02',
  'IMMICH-SECRET-ABC', '+972-50-9999999', 'agent-internal-value', 'hermes:internal-profile-name',
  'PROACTIVE-SECRET', 'INSTRUCTION-SECRET', 'NEED-SECRET', 'PHASE-SECRET', 'ACCOMMODATION-SECRET',
  'VENUE-SECRET', 'COUNTRY-SECRET', 'TOP-SECRET', 'SHAPE-SECRET', 'TEXT-SECRET',
  'LEAK-AGENT-NAME-X', 'PICKUP-SECRET', 'LODGING-NAME-SECRET', 'DAY-TICKETS-SECRET',
  'DAY-LABEL-ARRAY-SECRET', 'ITEM-TEXT-ARRAY-SECRET', 'ITEM-TEXT-HE-ARRAY-SECRET',
  'MAPS-ARRAY-SECRET', 'WAZE-ARRAY-SECRET', 'URL-ARRAY-SECRET',
];
const leaked = (served) => HOSTILE_VALUES.filter(v => JSON.stringify(served).includes(v));

// What projectConfig reports as WITHHELD is known and kept back on purpose
// (PINs, identity links, organizer-only needs and instructions). DROPPED is
// "not on the list" — the golden configs must never produce any.
function withoutWithheld(cfg, withheld) {
  const out = clone(cfg);
  // Last index first, so removing one array item never shifts the next path.
  const order = [...withheld].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const path of order) {
    const keys = path.match(/[^.[\]]+/g).map(k => (/^\d+$/.test(k) ? Number(k) : k));
    const last = keys.pop();
    const parent = keys.reduce((o, k) => o[k], out);
    if (Array.isArray(parent)) parent.splice(last, 1); else delete parent[last];
  }
  // An emptied needs / instructions list is dropped, not served as [] — an
  // empty list is itself a disclosure (see sanitizeConfig's needs comment).
  for (const p of out.participants || []) if (Array.isArray(p.needs) && !p.needs.length) delete p.needs;
  if (out.agent && Array.isArray(out.agent.standing_instructions) && !out.agent.standing_instructions.length) {
    delete out.agent.standing_instructions;
  }
  // The public agent view always carries a normalized tone and gender, as it
  // always has — a renderer never guesses the default.
  if (out.agent) {
    out.agent.tone = normalizeTone(out.agent.tone);
    out.agent.gender = normalizeGender(out.agent.gender);
  }
  return out;
}

describe('config allow-list — unknown fields are dropped (fail safe)', () => {
  test('the issue #172 hostile config leaks none of its planted values', () => {
    const served = publicConfig(hostile());
    assert.deepEqual(leaked(served), []);
  });

  test('every planted field is reported as dropped, by path, never silently', () => {
    const { dropped } = projectConfig(hostile());
    for (const path of [
      'participants[0].passport_number', 'participants[0].phone', 'participants[0].email',
      'participants[0].date_of_birth', 'meta.immich_api_key', 'meta.emergency_contact_phone',
      'agent.SECRET_AGENT_FIELD', 'agent.profile', 'agent.proactive.secret_schedule',
      'agent.standing_instructions[0].author_note', 'participants[1].needs[1].doctor',
      'phases[0].secret_phase_note', 'phases[0].accommodation.door_code',
      'phases[0].venues[0].owner_phone', 'SECRET_TOP_LEVEL', 'meta.title', 'phases[0].title.internal',
      'agent.name', 'phases[0].pickup', 'phases[0].accommodation.name.internal', 'phases[0].days[0].items[0].tickets',
      'phases[0].days[0].label', 'phases[0].days[0].items[0].text', 'phases[0].days[0].items[1].text.he',
      'phases[0].days[0].items[3].maps', 'phases[0].days[0].items[3].waze', 'phases[0].days[0].items[3].url',
    ]) assert.ok(dropped.includes(path), `${path} was not reported dropped; got ${JSON.stringify(dropped)}`);
  });

  test('a field unknown at the TOP level is dropped, not deep-copied', () => {
    const served = publicConfig({ meta: { title: 'T' }, brand_new_block: { anything: 1 } });
    assert.deepEqual(served, { meta: { title: 'T' } });
  });

  test('a key that is data, not schema, cannot smuggle a prototype', () => {
    const cfg = JSON.parse('{"travel_info":{"countries":{"__proto__":{"flag":"x"},"Japan":{"flag":"🇯🇵"}}}}');
    const served = publicConfig(cfg);
    assert.equal(Object.getPrototypeOf(served.travel_info.countries), Object.prototype);
    assert.equal(served.travel_info.countries.Japan.flag, '🇯🇵');
  });

  test('the live config object is never mutated by projection', () => {
    const cfg = hostile();
    const before = JSON.stringify(cfg);
    publicConfig(cfg);
    assert.equal(JSON.stringify(cfg), before);
  });

  test('a provenance tag outside its closed set is dropped (the #156 shape)', () => {
    const cfg = { travel_info: { money: [
      { he: 'א', en: 'a', source: 'model', origin: 'model' },
      { he: 'ב', en: 'b', source: 'model', origin: 'hermes:some-profile' },
    ] } };
    const { value, dropped } = projectConfig(cfg);
    assert.equal(value.travel_info.money[0].origin, 'model');
    assert.ok(!('origin' in value.travel_info.money[1]));
    assert.ok(dropped.includes('travel_info.money[1].origin'));
  });
});

// A visibility rule that reads `visibility` twice — once to decide, once to
// serve — can be told two different things. Unreachable from JSON.parse, but
// the decision and the served value must come from one read.
function twoFaced(obj, first, then) {
  let reads = 0;
  Object.defineProperty(obj, 'visibility', { enumerable: true, configurable: true,
    get: () => (reads++ === 0 ? first : then) });
  return () => reads;
}

describe('visibility is read once', () => {
  test('a need whose visibility changes between reads is decided and served from one read', () => {
    const need = { type: 'medical', severity: 'firm', text: { he: 'א', en: 'TWO-FACED-NEED' } };
    const reads = twoFaced(need, 'group', 'organizer');
    const { value } = projectConfig({ participants: [{ username: 'a', needs: [need] }] });
    assert.equal(reads(), 1, 'visibility read more than once');
    for (const n of value.participants[0].needs || []) assert.notEqual(n.visibility, 'organizer');
  });

  test('a standing instruction whose visibility changes between reads is decided and served from one read', () => {
    const ins = { text: { he: 'א', en: 'TWO-FACED-INSTRUCTION' } };
    const reads = twoFaced(ins, 'group', 'organizer');
    const agent = publicAgent({ name: 'x', standing_instructions: [ins] });
    assert.equal(reads(), 1, 'visibility read more than once');
    for (const i of agent.standing_instructions || []) assert.notEqual(i.visibility, 'organizer');
  });
});

describe('publicAgent — allow-list, not deny-list', () => {
  test('persona survives; unknown keys, `profile` and unknown proactive keys do not', () => {
    const agent = publicAgent({
      name: 'ויקטור', name_en: 'Victor', gender: 'male', tone: 'dry', default_language: 'he',
      timezone: 'Asia/Tokyo', organizers: ['alice'], organizer: 'alice',
      proactive: { morning_briefing: '07:30', flight_changes: true, invented_key: true },
      standing_instructions: [
        { visibility: 'group', text: { he: 'א', en: 'a' }, extra: 'x' },
        { visibility: 'organizer', text: { he: 'ב', en: 'b' } },
      ],
      profile: 'hermes:x', api_key: 'k',
    });
    assert.deepEqual(agent, {
      name: 'ויקטור', name_en: 'Victor', gender: 'male', tone: 'dry', default_language: 'he',
      timezone: 'Asia/Tokyo', organizers: ['alice'], organizer: 'alice',
      proactive: { morning_briefing: '07:30', flight_changes: true },
      standing_instructions: [{ visibility: 'group', text: { he: 'א', en: 'a' } }],
    });
  });

  test('a missing block is still undefined, and an all-hidden instruction list drops its key', () => {
    assert.equal(publicAgent(undefined), undefined);
    assert.equal(publicAgent('not an object'), undefined);
    const agent = publicAgent({ name: 'x', standing_instructions: [{ text: { he: 'א', en: 'a' } }] });
    assert.ok(!('standing_instructions' in agent));
  });
});

describe('config allow-list — golden round trip (nothing the site needs is lost)', () => {
  test('trips/japan-2025 round-trips: nothing dropped, only identity links withheld', () => {
    const { value, dropped, withheld } = projectConfig(JAPAN);
    assert.deepEqual(dropped, [], `fields missing from the allow-list: ${dropped.join(', ')}`);
    assert.ok(withheld.every(p => /^participants\[\d+\]\.telegram_id$/.test(p)), withheld.join(', '));
    assert.deepEqual(value, withoutWithheld(JAPAN, withheld));
  });

  test('the test fixture round-trips except its deliberately malformed entries', () => {
    const { value, dropped, withheld } = projectConfig(FIXTURE);
    // The fixture carries a junk proactive key on purpose (boot-warning tests).
    assert.deepEqual(dropped, ['agent.proactive.unknown_key']);
    for (const p of withheld) {
      assert.match(p, /\.pin$|^participants\[\d+\]\.needs\[\d+\]$|^agent\.standing_instructions\[\d+\]$/);
    }
    assert.equal(value.phases[0].accommodation.confirmation, 'TEST-001');
    assert.ok(!('pin' in value.phases[0].accommodation));
  });

  // The producer is Python; the allow-list is JS. This runs the real
  // transform_intake + enrich_config (offline, canned lookups) on both
  // interview paths and projects what they emit. A field the provisioner
  // learns to write, and this list does not know, fails here.
  test('the provisioner\'s own output round-trips on both interview paths', () => {
    const run = spawnSync('python3', [join(HERE, 'helpers', 'provisioned-config.py')], { encoding: 'utf8' });
    assert.equal(run.status, 0, `provisioned-config.py failed: ${run.stderr}`);
    const configs = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(configs).sort(), ['planned-path', 'venues-path']);
    for (const [name, cfg] of Object.entries(configs)) {
      const { value, dropped, withheld } = projectConfig(cfg);
      assert.deepEqual(dropped, [], `${name}: provisioner fields missing from the allow-list: ${dropped.join(', ')}`);
      for (const p of withheld) {
        assert.match(p, /^participants\[\d+\]\.needs\[\d+\]$|^agent\.standing_instructions\[\d+\]$/, `${name}: ${p}`);
      }
      assert.deepEqual(value, withoutWithheld(cfg, withheld), name);
    }
    // The fixture really exercised what it claims to: both shapes the two
    // interview paths write, enrichment's additions, and a withheld need.
    const planned = configs['planned-path'].phases.find(p => p.id === 'tokyo');
    assert.ok(planned.venues?.length, 'agentless `planned` places should arrive as venues');
    const tokyo = configs['venues-path'].phases.find(p => p.id === 'tokyo');
    assert.ok(tokyo.venues.some(v => v.url_source), 'enrichment should have filled a url_source');
    assert.ok(tokyo.days?.length && tokyo.accommodation?.confirmation);
    assert.ok(projectConfig(configs['planned-path']).withheld.some(p => /\.needs\[/.test(p)),
      'organizer-only dietary needs should be withheld on the planned path');
  });
});

// ── Over HTTP, as a plain family member ───────────────────────────────────────
describe('GET /api/config and /api/config/versions/:version — hostile config over HTTP', () => {
  const PORT = PORTS.configAllowList;
  const BASE = `http://localhost:${PORT}`;
  let dataDir, proc, bob;
  async function login(username) {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: '1234' }) });
      if (r.ok) return (await r.json()).token;
      await new Promise(res => setTimeout(res, 100));
    }
    return null;
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-allow-list-'));
    const tripDir = join(dataDir, 'trip');
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
    writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(hostile(), null, 2));
    mkdirSync(join(dataDir, 'site'), { recursive: true });
    proc = spawn('node', [join(REPO, 'server', 'server.js')], {
      cwd: join(REPO, 'server'),
      env: { ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
        SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
        JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
        HERMES_API_KEY: 'test-hermes-key', SEED_PASSWORD: '1234' },
    });
    let log = '';
    proc.stderr.on('data', c => { log += c; });
    proc.stdout.on('data', c => { log += c; });
    await new Promise((resolve, reject) => {
      const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
      proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log}`)); });
      setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log}`)); }, 10_000);
    });
    proc.bootLog = () => log;
    bob = await login('bob');
    assert.ok(bob, 'bob (a plain member) could not log in');
  });
  after(() => {
    proc?.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('a plain member reading /api/config gets none of the planted fields', async () => {
    const res = await fetch(`${BASE}/api/config`, { headers: { Authorization: `Bearer ${bob}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(leaked(body), []);
    assert.ok(!('SECRET_TOP_LEVEL' in body));
    assert.equal(body.trivia_available !== undefined, true, 'the route still adds trivia_available');
    assert.equal(body.agent.name_en, 'Victor');
    assert.ok(!('name' in body.agent), 'a wrong-shaped agent.name is dropped, not served whole');
  });

  test('/api/hermes/status serves the allow-listed name and no profile', async () => {
    const res = await fetch(`${BASE}/api/hermes/status`, { headers: { Authorization: `Bearer ${bob}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(leaked(body), []);
    assert.ok(!('profile' in body.identity), `identity carries a profile: ${JSON.stringify(body.identity)}`);
    // agent.name is an object here, so the allow-list drops it: the fallback.
    assert.equal(body.identity.name, 'Hermes');
  });

  // Before the restore test below: on a fresh DB the boot-time promote IS the
  // active plan, so this reads what promoteConfigDays() imported.
  test('the boot-time promote stores nothing /api/config would drop (plan, plan days, active plan)', async () => {
    for (const path of ['/api/itinerary/active', '/api/phases/ny/plan', '/api/phases/ny/plan/days']) {
      const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${bob}` } });
      assert.equal(res.status, 200, path);
      assert.deepEqual(leaked(await res.json()), [], path);
    }
    // The well-formed values beside them still arrive.
    const plan = await (await fetch(`${BASE}/api/phases/ny/plan`, { headers: { Authorization: `Bearer ${bob}` } })).json();
    const afternoon = plan.find(i => i.text_en === 'Afternoon');
    assert.ok(afternoon, 'the item whose links were wrong-shaped is still imported, without them');
    assert.equal(afternoon.location_url, null);
    assert.equal(afternoon.waze_url, null);
    assert.equal(afternoon.ticket_url, null);
    const second = plan.find(i => i.config_ref === 'ny|2027-03-11|1');
    assert.ok(second?.text_en, 'the item with a wrong-shaped Hebrew text is still imported');
    // Falls back to the English, not to "[object Object]".
    assert.equal(second.text_he, second.text_en);
  });

  // The day context built from the config reaches members when the imported
  // plan becomes the active one — restore-original is the organizer action that
  // does it — and from rows stored before this fix, which stay in the database.
  test('/api/itinerary/active carries allow-listed day context only — after a restore, and on rows stored before the fix', async () => {
    const alice = await login('alice');
    const restore = await fetch(`${BASE}/api/itinerary/restore-original`, { method: 'POST', headers: { Authorization: `Bearer ${alice}` } });
    assert.equal(restore.status, 200);
    // A day row as the old import wrote it: pickup whole, lodging raw.
    const db = new Database(join(dataDir, 'trip.db'));
    const { active_version_id: active } = db.prepare('SELECT active_version_id FROM trip_itinerary_state WHERE id = 1').get();
    db.prepare('INSERT INTO itinerary_plan_days (revision_id, phase_id, date, label_he, label_en, lodging_context, pickup_context, sort_order) VALUES (?,?,?,?,?,?,?,?)')
      .run(active, 'ny', '2027-03-13', null, null,
        JSON.stringify({ name: { he: 'x', en: 'y', internal: 'STORED-LODGING-SECRET' }, door: 'STORED-EXTRA-SECRET' }),
        JSON.stringify({ driver_phone: 'STORED-PICKUP-SECRET' }), 99);
    db.close();

    const res = await fetch(`${BASE}/api/itinerary/active`, { headers: { Authorization: `Bearer ${bob}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(leaked(body), []);
    for (const s of ['STORED-LODGING-SECRET', 'STORED-EXTRA-SECRET', 'STORED-PICKUP-SECRET']) assert.ok(!text.includes(s), s);
    assert.ok(body.days.every(d => d.pickup_context == null), 'pickup_context has no allow-listed source');
    const imported = body.days.find(d => d.phase_id === 'ny' && d.date === '2027-03-11');
    assert.deepEqual(imported?.lodging_context?.name, { he: 'מלון מרידיאן', en: 'Hotel Meridian' },
      'the allow-listed lodging name still reaches the imported day');
    const stored = body.days.find(d => d.date === '2027-03-13');
    assert.deepEqual(stored.lodging_context, { name: { he: 'x', en: 'y' }, address: null, location_url: null });
    const today = await (await fetch(`${BASE}/api/today`, { headers: { Authorization: `Bearer ${bob}` } })).json();
    assert.deepEqual(leaked(today), []);
  });

  test('the same through a stored version', async () => {
    const list = await (await fetch(`${BASE}/api/config/versions`, { headers: { Authorization: `Bearer ${bob}` } })).json();
    const res = await fetch(`${BASE}/api/config/versions/${list[0].version}`, { headers: { Authorization: `Bearer ${bob}` } });
    assert.equal(res.status, 200);
    const { content } = await res.json();
    assert.deepEqual(leaked(content), []);
    assert.ok(content.participants.length === 3 && content.phases.length > 0);
  });

  test('the agent key reads the same allow-listed view (brief carries the rest)', async () => {
    const res = await fetch(`${BASE}/api/config`, { headers: { 'X-API-Key': 'test-hermes-key' } });
    assert.deepEqual(leaked(await res.json()), []);
  });

  test('a dropped field is loud in the server log (path only) and counted in /api/config/warnings (no names)', async () => {
    assert.match(proc.bootLog(), /not on the served allow-list.*meta\.immich_api_key/s);
    assert.ok(!proc.bootLog().includes('IMMICH-SECRET-ABC'), 'the log names the path, never the value');
    const warnings = await (await fetch(`${BASE}/api/config/warnings`, { headers: { Authorization: `Bearer ${bob}` } })).json();
    const entry = warnings.find(w => w.scope === 'config');
    assert.ok(entry, `expected a config-scope warning, got ${JSON.stringify(warnings)}`);
    const text = JSON.stringify(warnings);
    assert.ok(!text.includes('immich') && !text.includes('passport'), 'a field NAME is authored config text too — never served');
  });

  // LAST in this describe: it appends a participant, which writes a new config version.
  test('/api/config/roster (no auth) serves only scalar roster fields', async () => {
    // An organizer or the agent can append a participant whose name is not a
    // string. The config write lands before the users-table insert fails, so
    // until a restart the roster used to serve the object whole.
    await fetch(`${BASE}/api/agent/participants`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-hermes-key' },
      body: JSON.stringify({ username: 'mallory', name: { he: 'מ', leak: 'ROSTER-SECRET' } }) });
    const roster = await (await fetch(`${BASE}/api/config/roster`)).text();
    assert.ok(!roster.includes('ROSTER-SECRET'), roster);
    assert.ok(JSON.parse(roster).participants.some(p => p.username === 'mallory'), 'the appended participant is still listed');
  });
});

// ── The boot-time plan import with malformed entries ──────────────────────────
// A separate trip: a multi-element array used to crash boot outright
// (better-sqlite3: "Too many parameter values"), which would take every other
// test above down with it.
describe('boot-time plan import — malformed entries degrade to dropped fields', () => {
  const PORT = PORTS.configAllowListPromote;
  const BASE = `http://localhost:${PORT}`;
  let dataDir, proc, bob, alice;
  async function login(username) {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: '1234' }) });
      if (r.ok) return (await r.json()).token;
      await new Promise(res => setTimeout(res, 100));
    }
    return null;
  }
  const get = async (path, token) => (await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })).json();

  before(async () => {
    const cfg = clone(FIXTURE);
    // Malformed entries BEFORE good ones: the good items must keep the
    // config_ref / sort_order their raw position gives them (index stability).
    cfg.phases[0].days[0].items = [
      'not-an-item',
      { text: ['ARRAY-TEXT-SECRET'] },
      { time: '11:00', text: { he: 'שני', en: 'Two-element links' },
        maps: ['https://maps.example/A-SECRET', 'https://maps.example/B-SECRET'] },
      { time: '12:00', text: { he: 'טוב', en: 'Good item' } },
      { time: '13:00', text: { en: 'English only' } },
    ];
    // Accepted by Intl in any case, but not a value the config should echo.
    cfg.meta.timezone = 'aSiA/tOkYo';
    // No accommodation: the night's hotel is chosen from `hotels` by date. The
    // first has object-shaped dates, which the allow-list would drop — the
    // choice must still be made on the raw dates, as it always was.
    delete cfg.phases[1].accommodation;
    cfg.phases[1].hotels = [
      { name: 'Hotel-with-malformed-dates', date_from: { d: 1 }, date_to: { d: 1 } },
      { name: 'Hotel-B', date_from: '2027-03-17', date_to: '2027-03-23' },
    ];
    dataDir = mkdtempSync(join(tmpdir(), 'trip-allow-list-promote-'));
    const tripDir = join(dataDir, 'trip');
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
    writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));
    mkdirSync(join(dataDir, 'site'), { recursive: true });
    proc = spawn('node', [join(REPO, 'server', 'server.js')], {
      cwd: join(REPO, 'server'),
      env: { ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
        SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
        JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
        HERMES_API_KEY: 'test-hermes-key', SEED_PASSWORD: '1234' },
    });
    let log = '';
    proc.stderr.on('data', c => { log += c; });
    proc.stdout.on('data', c => { log += c; });
    await new Promise((resolve, reject) => {
      const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
      proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log.slice(-400)}`)); });
      setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log.slice(-400)}`)); }, 10_000);
    });
    bob = await login('bob');
    alice = await login('alice');
    assert.ok(bob && alice);
  });
  after(() => {
    proc?.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('boots, and serves none of the malformed values', async () => {
    for (const path of ['/api/itinerary/active', '/api/phases/ny/plan', '/api/phases/ny/plan/days']) {
      const text = JSON.stringify(await get(path, bob));
      for (const s of ['ARRAY-TEXT-SECRET', 'A-SECRET', 'B-SECRET']) assert.ok(!text.includes(s), `${path}: ${s}`);
    }
  });

  test('good items keep the config_ref and sort_order of their raw position', async () => {
    const plan = await get('/api/phases/ny/plan', bob);
    const byRef = Object.fromEntries(plan.map(i => [i.config_ref, i]));
    assert.equal(byRef['ny|2027-03-11|2']?.text_en, 'Two-element links');
    assert.equal(byRef['ny|2027-03-11|2']?.sort_order, 2);
    assert.equal(byRef['ny|2027-03-11|2']?.location_url, null);
    assert.equal(byRef['ny|2027-03-11|3']?.text_en, 'Good item');
    assert.equal(byRef['ny|2027-03-11|3']?.sort_order, 3);
    assert.ok(!byRef['ny|2027-03-11|0'] && !byRef['ny|2027-03-11|1'], 'the malformed entries import nothing');
    // An English-only text is shown in English, not as "[object Object]".
    assert.equal(byRef['ny|2027-03-11|4']?.text_he, 'English only');
    assert.ok(!JSON.stringify(plan).includes('[object Object]'));
  });

  test('/api/today serves the canonical time zone, not the config\'s spelling', async () => {
    const today = await get('/api/today', bob);
    assert.equal(today.time_zone, 'Asia/Tokyo');
  });

  test('the night\'s hotel is chosen on its raw dates, then projected', async () => {
    const res = await fetch(`${BASE}/api/itinerary/days`, { method: 'PATCH',
      headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase_id: 'colorado', date: '2027-03-18', label_he: 'יום', label_en: 'Day' }) });
    assert.equal(res.status, 200);
    const active = await get('/api/itinerary/active', bob);
    const day = active.days.find(d => d.phase_id === 'colorado' && d.date === '2027-03-18');
    assert.equal(day?.lodging_context?.name, 'Hotel-B');
  });
});
