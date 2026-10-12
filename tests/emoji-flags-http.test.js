/**
 * emoji-flags-http.test.js — subdivision flags in stop text, over HTTP
 * (owner decision, 2026-10-12: "England, Scotland, Wales, and any other emoji
 * tag sequence must NOT be refused in stored text. Keep every other
 * protection.").
 *
 * England is U+1F3F4, the tag letters g b e n g (U+E0067 U+E0062 U+E0065
 * U+E006E U+E0067), and U+E007F CANCEL TAG. The tag characters are refused as
 * lone characters (they are default-ignorable: invisible); the well-formed
 * sequence renders as a flag and is stored exactly as typed. The rule lives in
 * server/text-rules.js and its twin in server/trip-structure.js (withoutFlags);
 * it is enumerated in invisible-text.test.js and pinned on the stop layer in
 * stop-hardening.test.js. This file is the stop ROUTES against a real trip
 * server: PATCH /api/stops/:id and POST /api/stops/:id/split write, and a
 * member reads the stop back through GET /api/config — byte for byte.
 * Booking and participant routes are in write-validation.test.js.
 *
 * Every flag here is built from code points: no literal tag character sits in
 * this file, where an editor could not show it.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from './helpers/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PORT = PORTS.emojiFlagsHttp;
const AGENT_KEY = 'test-hermes-key';
const INVISIBLE_DETAIL = 'text may not contain invisible or blank-looking characters (zero-width, bidi, filler, tag or variation characters); LRM, RLM, ALM, ZWNJ, ZWJ and U+FE0F are allowed';

const tagsOf = (s) => [...s].map(c => 0xE0000 + c.codePointAt(0));
const flag = (region) => String.fromCodePoint(0x1F3F4, ...tagsOf(region), 0xE007F);
const ENGLAND = flag('gbeng'), SCOTLAND = flag('gbsct'), WALES = flag('gbwls');
const FLAGS = [['England', ENGLAND], ['Scotland', SCOTLAND], ['Wales', WALES]];
const MALFORMED = [
  ['a lone U+E0041', `Col${String.fromCodePoint(0xE0041)}mar`],
  ['an unterminated sequence', String.fromCodePoint(0x1F3F4, ...tagsOf('gbeng'))],
  ['tag letters after another base', String.fromCodePoint(0x1F3F3, ...tagsOf('gbeng'), 0xE007F)],
  ['a terminator without a base', `x${String.fromCodePoint(0xE007F)}`],
  ['a second tag run glued after the terminator', ENGLAND + String.fromCodePoint(...tagsOf('gbsct'), 0xE007F)],
  ['a VS16 inside the tag run', String.fromCodePoint(0x1F3F4, 0xE0067, 0xFE0F, 0xE0062, 0xE007F)],
  ['a ZWJ inside the tag run', String.fromCodePoint(0x1F3F4, 0xE0067, 0x200D, 0xE0062, 0xE007F)],
];

function colmarConfig() {
  return {
    meta: { title: 'Alsace 2026', brand: 'ALSACE', departure: '2026-12-02T00:00:00+00:00', returnDate: '2026-12-07', totalDays: 6, deploymentNonce: 'flags-test', defaultLang: 'he' },
    participants: [
      { username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' },
      { username: 'bob', name: 'בוב', name_en: 'Bob', family: 'a', color: '#10B981' },
    ],
    phases: [
      { id: 'frankfurt', title: { he: 'פרנקפורט', en: 'Frankfurt' }, tabLabel: 'FRANKFURT', dates: { start: '2026-12-02', end: '2026-12-04' } },
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR', dates: { start: '2026-12-05', end: '2026-12-07' } },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

let proc, dataDir, alice, bob, log = '';

async function call(path, { method = 'GET', token, apiKey, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://localhost:${PORT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, body: json };
}
async function login(username) {
  for (let i = 0; i < 40; i++) {
    const r = await call('/api/auth/login', { method: 'POST', body: { username, password: '1234' } });
    if (r.status === 200) return r.body.token;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error(`login ${username} failed`);
}
// What a member is served for a stop.
const memberStop = async (pred) => (await call('/api/config', { token: bob })).body.phases.find(pred);

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'emoji-flags-'));
  const tripDir = join(dataDir, 'trip');
  mkdirSync(tripDir, { recursive: true });
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(colmarConfig(), null, 2));
  writeFileSync(join(tripDir, 'bookings.json'), '[]');
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_URL: '',
      HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234' },
  });
  proc.stdout.on('data', c => { log += c; });
  proc.stderr.on('data', c => { log += c; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
    proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log.slice(-600)}`)); });
    setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log.slice(-600)}`)); }, 15_000);
  });
  alice = await login('alice');
  bob = await login('bob');
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise(r => proc.once('exit', r));
    proc.kill('SIGTERM');
    await exited;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('PATCH /api/stops/:id — a subdivision flag in stop text is stored, and served to a member, exactly as typed', () => {
  for (const [name, f] of FLAGS) {
    test(`${name}: title, tabLabel, emoji, accommodation name (organizer and agent key)`, async () => {
      for (const who of [{ token: alice }, { apiKey: AGENT_KEY }]) {
        const body = { title: { he: `קולמר ${f}`, en: `Colmar ${f}` }, tabLabel: `COLMAR ${f}`, emoji: f, accommodation: { name: `מלון ${f} Hotel`, address: `1 Rue ${f}` } };
        const r = await call('/api/stops/colmar', { method: 'PATCH', ...who, body });
        assert.equal(r.status, 200, r.text);
        const seen = await memberStop(p => p.id === 'colmar');
        assert.deepEqual([seen.title, seen.tabLabel, seen.emoji, seen.accommodation.name, seen.accommodation.address],
          [body.title, body.tabLabel, f, body.accommodation.name, body.accommodation.address]);
      }
      // A title of the flag alone is not blank.
      const alone = await call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { title: f } });
      assert.equal(alone.status, 200, alone.text);
      assert.equal((await memberStop(p => p.id === 'colmar')).title, f);
    });
  }
});

describe('POST /api/stops/:id/split — a new stop titled with a flag', () => {
  test('created; a member reads the new stop\'s title and emoji exactly as typed', async () => {
    const title = { he: `אדינבורו ${SCOTLAND}`, en: `Edinburgh ${SCOTLAND}` };
    const r = await call('/api/stops/colmar/split', { method: 'POST', token: alice, body: { at: '2026-12-06', new_stop: { title, emoji: SCOTLAND } } });
    assert.equal(r.status, 201, r.text);
    const seen = await memberStop(p => p.title?.en === title.en);
    assert.ok(seen, 'the new stop is served');
    assert.deepEqual([seen.title, seen.emoji], [title, SCOTLAND]);
  });
});

describe('refused, over HTTP — malformed tag runs anywhere, and any flag in accommodation.confirmation', () => {
  for (const [what, v] of MALFORMED) {
    test(`${what}: PATCH title / tabLabel / emoji / accommodation.name, and split new_stop.title → 400 invalid_text, the invisible detail; the stop unchanged`, async () => {
      const before = await memberStop(p => p.id === 'frankfurt');
      for (const [body, field] of [[{ title: v }, 'title'], [{ tabLabel: v }, 'tabLabel'], [{ emoji: v }, 'emoji'], [{ accommodation: { name: v } }, 'accommodation.name']]) {
        const r = await call('/api/stops/frankfurt', { method: 'PATCH', token: alice, body });
        assert.deepEqual([r.status, r.body.error, r.body.field, r.body.detail], [400, 'invalid_text', field, INVISIBLE_DETAIL], `${field}: ${r.text}`);
      }
      const split = await call('/api/stops/frankfurt/split', { method: 'POST', token: alice, body: { at: '2026-12-03', new_stop: { title: v } } });
      assert.deepEqual([split.status, split.body.error, split.body.field], [400, 'invalid_text', 'new_stop.title'], split.text);
      assert.deepEqual(await memberStop(p => p.id === 'frankfurt'), before);
    });
  }

  test('a flag in accommodation.confirmation → 400 invalid_text (a code has no use for one)', async () => {
    for (const [, f] of FLAGS) {
      const r = await call('/api/stops/frankfurt', { method: 'PATCH', apiKey: AGENT_KEY, body: { accommodation: { name: 'H', confirmation: `AB${f}12` } } });
      assert.deepEqual([r.status, r.body.error, r.body.field, r.body.detail], [400, 'invalid_text', 'accommodation.confirmation', INVISIBLE_DETAIL], r.text);
    }
  });
});
