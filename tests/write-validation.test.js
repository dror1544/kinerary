/**
 * write-validation.test.js — participant and booking text is checked when it
 * is WRITTEN, and a refusal says what to fix in Hebrew and English (owner
 * decision, 2026-10-11).
 *
 * The display side was already safe (Classic escapes, Modern is React), but
 * POST /api/agent/participants checked only username and colour, and
 * POST/PATCH /api/bookings only that phase/type/name were present — so
 * `<img src=x onerror=…>` in a passengers field was stored as given, from the
 * HTTP routes and from both MCP servers' booking tools (they call the routes).
 *
 * The rule is the stop layer's (server/trip-structure.js, twinned in
 * server/text-rules.js): `<`, `>` and control characters are refused (a line
 * break only in notes); `"`, `'` and `&` are text and stored exactly as typed
 * (ארה"ב); links are absolute http(s) with no quotes or whitespace; dates are
 * YYYY-MM-DD; lengths are capped. The extract-draft route — text an LLM read
 * off a PDF, nobody typed it — cleans instead of refusing.
 *
 * Layers, each against the REAL trip server:
 *   1. HTTP: every field x every hostile value, on POST and PATCH; what is
 *      accepted is stored byte for byte; auth is unchanged; GET is unchanged.
 *   2. extract-draft cleans an extraction (stand-in extraction service).
 *   3. mcp/mcp.js (the companion's bridge) passes the bilingual message on.
 *   4. server/trip-mcp/tools.js (the site's own MCP) passes it on through the
 *      same 300-character cap siteClient() applies.
 *   5. site/app.js submitBooking() shows the message in the page's language,
 *      as text.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { PORTS } from './helpers/ports.js';
import { TRIP_API_KEY, MCP_API_KEY, startTestMcp, stopTestMcp, mcpCallTool } from './helpers/mcp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const PORT = PORTS.writeValidation;
const EXTRACT_PORT = PORTS.writeValidationExtract;
const AGENT_KEY = TRIP_API_KEY; // mcp/mcp.js authenticates to the site with this

const HEBREW = /[א-ת]/;
const XSS = '<img src=x onerror=alert(1)>';
// The hostile values every one-line field must refuse. Notes allows the newline.
const HOSTILE = [['tag', XSS], ['angle', 'a>b'], ['nul', 'a\u0000b'], ['newline', 'line one\nline two']];
// Ordinary text that must be stored EXACTLY as typed.
const ORDINARY = ['ארה"ב', '"The Plaza"', "it's ours", 'A & B', '🏨 Hotel 🎉', 'מלון Hilton תל אביב', 'בע"מ — 55" TV'];
const TEXT_FIELDS = ['name', 'passengers', 'confirmation', 'pin', 'notes'];
const LINK_FIELDS = ['location_url', 'google_wallet_url', 'apple_wallet_url'];

let proc, dataDir, tripDir, alice, bob, extractServer;
let nextExtraction = null;

function api(path, { method = 'GET', body, token, apiKey } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`http://localhost:${PORT}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    .then(async r => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, body: json, text }; });
}
const asAgent = (path, opts = {}) => api(path, { ...opts, apiKey: AGENT_KEY });
async function login(username) {
  for (let i = 0; i < 40; i++) {
    const r = await api('/api/auth/login', { method: 'POST', body: { username, password: '1234' } });
    if (r.status === 200) return r.body.token;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error(`login as ${username} failed`);
}
function bookingCount() {
  const db = new Database(join(dataDir, 'trip.db'), { readonly: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n; } finally { db.close(); }
}
function bookingRow(id) {
  const db = new Database(join(dataDir, 'trip.db'), { readonly: true });
  try { return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id); } finally { db.close(); }
}
const base = (extra = {}) => ({ phase: 'ny', type: 'hotel', name: 'Base Hotel', ...extra });

function assertBilingual(body, ctx) {
  assert.equal(typeof body?.message?.he, 'string', `${ctx}: message.he missing in ${JSON.stringify(body)}`);
  assert.equal(typeof body?.message?.en, 'string', `${ctx}: message.en missing`);
  assert.ok(body.message.he.length > 10 && HEBREW.test(body.message.he), `${ctx}: Hebrew message is Hebrew: ${body.message.he}`);
  assert.ok(body.message.en.length > 10 && !HEBREW.test(body.message.en), `${ctx}: English message has no Hebrew: ${body.message.en}`);
}

before(async () => {
  extractServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextExtraction || {}));
    });
  });
  await new Promise(r => extractServer.listen(EXTRACT_PORT, '127.0.0.1', r));

  dataDir = mkdtempSync(join(tmpdir(), 'write-validation-data-'));
  tripDir = mkdtempSync(join(tmpdir(), 'write-validation-trip-'));
  cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
  proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      AVATARS_DIR: join(dataDir, 'avatars'), JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
      HERMES_URL: `http://127.0.0.1:${EXTRACT_PORT}`, HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234' },
  });
  let log = '';
  proc.stdout.on('data', c => { log += c; });
  proc.stderr.on('data', c => { log += c; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
    proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log.slice(-600)}`)); });
    setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log.slice(-600)}`)); }, 15_000);
  });
  alice = await login('alice'); // the fixture's organizer
  bob = await login('bob');     // a member
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise(r => proc.once('exit', r));
    proc.kill('SIGTERM');
    await exited;
  }
  await new Promise(r => extractServer.close(r));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(tripDir, { recursive: true, force: true });
});

// ── 1. HTTP ──────────────────────────────────────────────────────────────────
describe('POST /api/bookings — free text', () => {
  test('every text field x every hostile value is 400 invalid_text, names the field, says so in Hebrew and English; nothing stored', async () => {
    const before = bookingCount();
    for (const field of TEXT_FIELDS) {
      for (const [kind, value] of HOSTILE) {
        if (field === 'notes' && kind === 'newline') continue; // notes are multi-line
        for (const who of [{ token: alice }, { apiKey: AGENT_KEY }]) {
          const r = await api('/api/bookings', { method: 'POST', ...who, body: base({ [field]: value }) });
          assert.equal(r.status, 400, `${field}/${kind}: ${r.text}`);
          assert.equal(r.body.error, 'invalid_text', `${field}/${kind}`);
          assert.equal(r.body.field, field);
          assert.equal(r.body.detail, 'text may not contain < > or control characters');
          assertBilingual(r.body, `${field}/${kind}`);
        }
      }
    }
    assert.equal(bookingCount(), before, 'no row was written');
  });

  test('the passengers message is the one the owner asked for, in both languages', async () => {
    const r = await asAgent('/api/bookings', { method: 'POST', body: base({ passengers: XSS }) });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.message, {
      he: "השדה 'נוסעים' מכיל תו שאסור: < או >. הסירו אותו ונסו שוב.",
      en: "The 'passengers' field contains a character that isn't allowed: < or >. Remove it and try again.",
    });
    const nl = await asAgent('/api/bookings', { method: 'POST', body: base({ pin: '12\n34' }) });
    assert.match(nl.body.message.en, /single line/);
    assert.match(nl.body.message.he, /שורה אחת/);
  });

  test('quotes, ampersands, gershayim, emoji and RTL text are stored exactly as typed, in every text field', async () => {
    for (const value of ORDINARY) {
      const body = base(Object.fromEntries(TEXT_FIELDS.map(f => [f, value])));
      const r = await api('/api/bookings', { method: 'POST', token: alice, body });
      assert.equal(r.status, 200, `${value}: ${r.text}`);
      const row = bookingRow(r.body.id);
      for (const f of TEXT_FIELDS) assert.equal(row[f], value, `${f} stored as typed`);
    }
    const notes = 'שורה ראשונה\nsecond line "quoted" & more';
    const r = await asAgent('/api/bookings', { method: 'POST', body: base({ notes }) });
    assert.equal(r.status, 200, r.text);
    assert.equal(bookingRow(r.body.id).notes, notes, 'a line break is fine in notes');
  });

  test('a number is stored as its text (an unquoted confirmation number); an object or array is refused as not text', async () => {
    const r = await asAgent('/api/bookings', { method: 'POST', body: base({ confirmation: 123456, pin: 4321 }) });
    assert.equal(r.status, 200, r.text);
    assert.equal(bookingRow(r.body.id).confirmation, '123456');
    for (const value of [{ a: 1 }, ['x'], true]) {
      const bad = await asAgent('/api/bookings', { method: 'POST', body: base({ passengers: value }) });
      assert.equal(bad.status, 400, JSON.stringify(value));
      assert.equal(bad.body.error, 'invalid_text');
      assertBilingual(bad.body, 'not text');
    }
  });

  test('a blank (whitespace) name is refused, with both messages; a missing one keeps its old error', async () => {
    const blank = await asAgent('/api/bookings', { method: 'POST', body: base({ name: '   ' }) });
    assert.equal(blank.status, 400, blank.text);
    assert.equal(blank.body.field, 'name');
    assertBilingual(blank.body, 'blank name');
    const missing = await asAgent('/api/bookings', { method: 'POST', body: { phase: 'ny', type: 'hotel' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'phase, type, name required');
  });
});

describe('POST /api/bookings — links, dates, lengths', () => {
  test('links with quotes, javascript:, < >, spaces or no scheme are 400 invalid_link with both messages', async () => {
    const bad = ['javascript:alert(1)', 'https://maps.example/x"onmouseover="alert(1)', "https://maps.example/'x", 'https://maps.example/<b>',
      'https://maps.example/a b', 'maps.example/x', 'ftp://maps.example/x', 'data:text/html,hi'];
    for (const field of LINK_FIELDS) {
      for (const value of bad) {
        const r = await asAgent('/api/bookings', { method: 'POST', body: base({ [field]: value }) });
        assert.equal(r.status, 400, `${field} ${value}: ${r.text}`);
        assert.deepEqual([r.body.error, r.body.field], ['invalid_link', field]);
        assertBilingual(r.body, `${field} ${value}`);
      }
    }
    const good = 'https://www.google.com/maps/search/?api=1&query=Tel+Aviv';
    const r = await asAgent('/api/bookings', { method: 'POST', body: base(Object.fromEntries(LINK_FIELDS.map(f => [f, good]))) });
    assert.equal(r.status, 200, r.text);
    const row = bookingRow(r.body.id);
    for (const f of LINK_FIELDS) assert.equal(row[f], good);
  });

  test('dates must be a real YYYY-MM-DD', async () => {
    for (const field of ['date_from', 'date_to']) {
      for (const value of ['2026-13-01', '2026-02-30', '12/02/2026', '2026-12-02T10:00', '<b>', '2026-1-2']) {
        const r = await asAgent('/api/bookings', { method: 'POST', body: base({ [field]: value }) });
        assert.equal(r.status, 400, `${field} ${value}: ${r.text}`);
        assert.deepEqual([r.body.error, r.body.field], ['invalid_date', field]);
        assertBilingual(r.body, `${field} ${value}`);
      }
    }
    const r = await asAgent('/api/bookings', { method: 'POST', body: base({ date_from: '2027-03-11', date_to: '2027-03-14' }) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([bookingRow(r.body.id).date_from, bookingRow(r.body.id).date_to], ['2027-03-11', '2027-03-14']);
  });

  test('length caps: name 120, passengers 300, confirmation 80, pin 40, notes 2000, links 2000 — counted in characters', async () => {
    const caps = { name: 120, passengers: 300, confirmation: 80, pin: 40, notes: 2000 };
    for (const [field, max] of Object.entries(caps)) {
      const okR = await asAgent('/api/bookings', { method: 'POST', body: base({ [field]: 'א'.repeat(max) }) });
      assert.equal(okR.status, 200, `${field} at ${max}: ${okR.text}`);
      const over = await asAgent('/api/bookings', { method: 'POST', body: base({ [field]: 'א'.repeat(max + 1) }) });
      assert.equal(over.status, 400, `${field} at ${max + 1}`);
      assert.deepEqual([over.body.error, over.body.field, over.body.max], ['text_too_long', field, max]);
      assertBilingual(over.body, `${field} too long`);
      assert.ok(over.body.message.en.includes(String(max)) && over.body.message.he.includes(String(max)), 'the cap is in the message');
    }
    const emoji = await asAgent('/api/bookings', { method: 'POST', body: base({ name: '🏨'.repeat(120) }) });
    assert.equal(emoji.status, 200, 'an emoji is one character');
    const long = 'https://maps.example/' + 'a'.repeat(2000 - 'https://maps.example/'.length);
    assert.equal((await asAgent('/api/bookings', { method: 'POST', body: base({ location_url: long }) })).status, 200);
    const tooLong = await asAgent('/api/bookings', { method: 'POST', body: base({ location_url: long + 'a' }) });
    assert.deepEqual([tooLong.status, tooLong.body.error], [400, 'invalid_link']);
  });
});

describe('PATCH /api/bookings/:id', () => {
  let id;
  before(async () => {
    id = (await asAgent('/api/bookings', { method: 'POST', body: base({ name: 'Patch Me', passengers: 'two', pin: '1111', notes: 'n' }) })).body.id;
  });

  test('every field x every hostile value is refused, and the row is unchanged', async () => {
    const before = bookingRow(id);
    for (const field of TEXT_FIELDS) {
      for (const [kind, value] of HOSTILE) {
        if (field === 'notes' && kind === 'newline') continue;
        const r = await api(`/api/bookings/${id}`, { method: 'PATCH', token: alice, body: { [field]: value } });
        assert.equal(r.status, 400, `${field}/${kind}: ${r.text}`);
        assert.deepEqual([r.body.error, r.body.field], ['invalid_text', field]);
        assertBilingual(r.body, `PATCH ${field}/${kind}`);
      }
    }
    for (const field of LINK_FIELDS) {
      const r = await asAgent(`/api/bookings/${id}`, { method: 'PATCH', body: { [field]: 'javascript:alert(1)' } });
      assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_link', field]);
    }
    for (const field of ['date_from', 'date_to']) {
      const r = await asAgent(`/api/bookings/${id}`, { method: 'PATCH', body: { [field]: '2027/03/11' } });
      assert.deepEqual([r.status, r.body.error, r.body.field], [400, 'invalid_date', field]);
    }
    const tooLong = await asAgent(`/api/bookings/${id}`, { method: 'PATCH', body: { pin: '1'.repeat(41) } });
    assert.deepEqual([tooLong.status, tooLong.body.error], [400, 'text_too_long']);
    // One bad field refuses the whole PATCH: the good field beside it is not applied.
    const mixed = await asAgent(`/api/bookings/${id}`, { method: 'PATCH', body: { passengers: 'three', pin: '<1>' } });
    assert.equal(mixed.status, 400);
    assert.deepEqual(bookingRow(id), before, 'nothing changed');
  });

  test('a blank name is refused (it would have hit NOT NULL or stored an empty name)', async () => {
    for (const name of ['', '   ', null]) {
      const r = await asAgent(`/api/bookings/${id}`, { method: 'PATCH', body: { name } });
      assert.equal(r.status, 400, `${JSON.stringify(name)}: ${r.text}`);
      assert.equal(r.body.field, 'name');
      assertBilingual(r.body, 'blank name');
    }
  });

  test('ordinary text is stored as typed; null clears an optional field, as before', async () => {
    for (const value of ORDINARY) {
      const r = await api(`/api/bookings/${id}`, { method: 'PATCH', token: alice, body: Object.fromEntries(TEXT_FIELDS.map(f => [f, value])) });
      assert.equal(r.status, 200, `${value}: ${r.text}`);
      const row = bookingRow(id);
      for (const f of TEXT_FIELDS) assert.equal(row[f], value);
    }
    const cleared = await asAgent(`/api/bookings/${id}`, { method: 'PATCH', body: { passengers: null, date_from: null, location_url: null } });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(bookingRow(id).passengers, null);
  });

  test('the Classic form\'s own PATCH body (every field, nulls for blanks) still saves', async () => {
    const body = { phase: 'ny', type: 'hotel', name: 'מלון ת"א', date_from: '2027-03-11', date_to: null, passengers: null,
      confirmation: 'AB-12', pin: null, cost: 0, notes: null, google_wallet_url: null, location_url: 'https://maps.example/x' };
    const r = await api(`/api/bookings/${id}`, { method: 'PATCH', token: alice, body });
    assert.equal(r.status, 200, r.text);
    assert.equal(bookingRow(id).name, 'מלון ת"א');
  });
});

describe('auth and the read path are unchanged', () => {
  test('a member is still 403 and anonymous still 401 — before any validation', async () => {
    const hostile = base({ passengers: XSS });
    assert.equal((await api('/api/bookings', { method: 'POST', token: bob, body: hostile })).status, 403);
    assert.equal((await api('/api/bookings', { method: 'POST', body: hostile })).status, 401);
    assert.equal((await api('/api/bookings/1', { method: 'PATCH', token: bob, body: { pin: '<x>' } })).status, 403);
    assert.equal((await api('/api/bookings/1', { method: 'PATCH', body: { pin: '<x>' } })).status, 401);
    const part = { username: 'mallory', name: '<b>x</b>' };
    assert.equal((await api('/api/agent/participants', { method: 'POST', token: bob, body: part })).status, 403);
    assert.equal((await api('/api/agent/participants', { method: 'POST', body: part })).status, 401);
  });

  test('GET /api/bookings still serves pin, notes and location_url to a member (owner: intended)', async () => {
    const made = await asAgent('/api/bookings', { method: 'POST', body: base({ name: 'Read Me', pin: '9876', notes: 'Door code 9876', location_url: 'https://maps.example/read' }) });
    assert.equal(made.status, 200);
    const rows = (await api('/api/bookings', { token: bob })).body;
    const row = rows.find(b => b.id === made.body.id);
    assert.ok(row, 'the member sees the approved booking');
    assert.deepEqual([row.pin, row.notes, row.location_url], ['9876', 'Door code 9876', 'https://maps.example/read']);
  });

  test('a value stored before this change is read back verbatim, and reading never fails on it', async () => {
    const db = new Database(join(dataDir, 'trip.db'));
    let id;
    try {
      id = db.prepare("INSERT INTO bookings (phase,type,name,date_from,passengers,created_by) VALUES ('ny','hotel',?,?,?,'old-code')")
        .run(`Old ${XSS}`, 'next Tuesday', 'a\nb').lastInsertRowid;
    } finally { db.close(); }
    const r = await api('/api/bookings', { token: bob });
    assert.equal(r.status, 200);
    const row = r.body.find(b => b.id === Number(id));
    assert.deepEqual([row.name, row.date_from, row.passengers], [`Old ${XSS}`, 'next Tuesday', 'a\nb']);
  });
});

describe('POST /api/agent/participants — names', () => {
  let n = 0;
  const uname = () => `p${Date.now().toString(36)}${n++}`;

  test('name, name_en and family refuse < > and control characters, with both messages; nothing is added', async () => {
    const before = readFileSync(join(tripDir, 'trip.config.json'), 'utf8');
    for (const field of ['name', 'name_en', 'family']) {
      for (const [kind, value] of HOSTILE) {
        const body = { username: uname(), name: 'Ok', [field]: value };
        for (const who of [{ token: alice }, { apiKey: AGENT_KEY }]) {
          const r = await api('/api/agent/participants', { method: 'POST', ...who, body });
          assert.equal(r.status, 400, `${field}/${kind}: ${r.text}`);
          assert.deepEqual([r.body.error, r.body.field], ['invalid_text', field]);
          assertBilingual(r.body, `participant ${field}/${kind}`);
        }
      }
    }
    assert.equal(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'), before, 'trip.config.json untouched');
  });

  test('the participant-name message names the field in both languages', async () => {
    const r = await asAgent('/api/agent/participants', { method: 'POST', body: { username: uname(), name: 'Dan <3' } });
    assert.deepEqual(r.body.message, {
      he: "השדה 'שם המשתתף' מכיל תו שאסור: < או >. הסירו אותו ונסו שוב.",
      en: "The 'participant name' field contains a character that isn't allowed: < or >. Remove it and try again.",
    });
  });

  test('an empty or blank name is refused; 80 characters is the cap', async () => {
    const missing = await asAgent('/api/agent/participants', { method: 'POST', body: { username: uname(), name: '' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'missing_fields', 'the old code is kept');
    const blank = await asAgent('/api/agent/participants', { method: 'POST', body: { username: uname(), name: '   ' } });
    assert.equal(blank.status, 400, blank.text);
    assert.equal(blank.body.field, 'name');
    assertBilingual(blank.body, 'blank participant');
    const over = await asAgent('/api/agent/participants', { method: 'POST', body: { username: uname(), name: 'א'.repeat(81) } });
    assert.deepEqual([over.status, over.body.error, over.body.max], [400, 'text_too_long', 80]);
    assert.equal((await asAgent('/api/agent/participants', { method: 'POST', body: { username: uname(), name: 'א'.repeat(80) } })).status, 200);
  });

  test('a quoted Hebrew name, an apostrophe and an emoji are stored exactly as typed', async () => {
    const u = uname();
    const r = await asAgent('/api/agent/participants', { method: 'POST', body: { username: u, name: 'אבי "הגדול" 🦁', name_en: "Avi O'Neil & co", family: 'family-a' } });
    assert.equal(r.status, 200, r.text);
    const cfg = JSON.parse(readFileSync(join(tripDir, 'trip.config.json'), 'utf8'));
    const p = cfg.participants.find(x => x.username === u);
    assert.deepEqual([p.name, p.name_en], ['אבי "הגדול" 🦁', "Avi O'Neil & co"]);
  });
});

// ── 2. extract-draft ─────────────────────────────────────────────────────────
describe('POST /api/bookings/extract-draft — cleans an LLM extraction instead of refusing it', () => {
  test('< > and control characters are removed, lengths clamped, a bad date dropped; the organizer gets a usable draft', async () => {
    nextExtraction = {
      phase: 'ny', type: 'hotel', name: '<b>Hotel</b> Plaza\n',
      passengers: '2 adults\n1 child <script>', confirmation: 'AB\u0000C' + '9'.repeat(200), pin: '12\t34',
      notes: 'line one\r\nline two <img src=x onerror=alert(1)>', date_from: '2027-03-11', date_to: '11/03/2027',
    };
    const r = await asAgent('/api/bookings/extract-draft', { method: 'POST', body: { url: 'https://example.com/conf' } });
    assert.equal(r.status, 201, r.text);
    const b = r.body.booking;
    assert.equal(b.review_status, 'draft');
    assert.equal(b.name, 'bHotel/b Plaza');
    assert.equal(b.passengers, '2 adults 1 child script');
    assert.equal(b.confirmation, 'ABC' + '9'.repeat(77), 'clamped to 80');
    assert.equal(b.pin, '12 34');
    assert.equal(b.notes, 'line one\nline two img src=x onerror=alert(1)', 'line break kept in notes; no angle brackets');
    assert.equal(b.date_from, '2027-03-11');
    assert.equal(b.date_to, null, 'a date that is not YYYY-MM-DD is dropped');
    for (const f of TEXT_FIELDS) assert.ok(!/[<>\u0000]/.test(b[f] || ''), f);
  });

  test('ordinary extracted text (quotes, Hebrew) is kept as is', async () => {
    nextExtraction = { phase: 'ny', type: 'hotel', name: 'מלון "הנסיך" & Spa', passengers: "Dan O'Brien", confirmation: 'ת"א-77' };
    const r = await asAgent('/api/bookings/extract-draft', { method: 'POST', body: { url: 'https://example.com/conf' } });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.booking.name, r.body.booking.passengers, r.body.booking.confirmation], ['מלון "הנסיך" & Spa', "Dan O'Brien", 'ת"א-77']);
  });

  test('a name that is nothing but markup leaves nothing to file: 422, as for a missing name', async () => {
    nextExtraction = { phase: 'ny', type: 'hotel', name: '<><>' };
    const r = await asAgent('/api/bookings/extract-draft', { method: 'POST', body: { url: 'https://example.com/conf' } });
    assert.equal(r.status, 422, r.text);
  });
});

// ── 3. mcp/mcp.js ────────────────────────────────────────────────────────────
describe('mcp/mcp.js booking and participant tools — the bilingual message reaches the model whole', () => {
  before(async () => {
    await startTestMcp({ API_BASE_URL: `http://127.0.0.1:${PORT}`, MCP_PORT: String(PORTS.writeValidationMcp), MCP_API_KEY });
  });
  after(() => stopTestMcp());

  const errorText = (res) => {
    const result = res.result || res;
    assert.equal(result.isError, true, `expected a tool error, got ${JSON.stringify(result).slice(0, 400)}`);
    return result.content[0].text;
  };

  test('add_booking with a hostile passengers value: the refusal carries code, field and both messages in full', async () => {
    const text = errorText(await mcpCallTool('add_booking', base({ passengers: XSS })));
    assert.match(text, /invalid_text/);
    assert.ok(text.includes("השדה 'נוסעים' מכיל תו שאסור: < או >. הסירו אותו ונסו שוב."), text);
    assert.ok(text.includes("The 'passengers' field contains a character that isn't allowed: < or >. Remove it and try again."), text);
    assert.match(text, /organizer/i, 'the hint tells the model to relay it');
  });

  test('update_booking and add_participant pass the message on too; ordinary quoted Hebrew succeeds', async () => {
    const made = await asAgent('/api/bookings', { method: 'POST', body: base() });
    const upd = errorText(await mcpCallTool('update_booking', { id: made.body.id, notes: 'x\u0000y' }));
    assert.match(upd, /invalid_text/);
    assert.ok(upd.includes("השדה 'הערות'"), upd);
    const part = errorText(await mcpCallTool('add_participant', { username: 'mcpbad', name: '<b>Dan</b>' }));
    assert.ok(part.includes("השדה 'שם המשתתף'") && part.includes("The 'participant name' field"), part);
    const okRes = await mcpCallTool('update_booking', { id: made.body.id, passengers: 'ארה"ב' });
    assert.notEqual((okRes.result || okRes).isError, true, JSON.stringify(okRes));
    assert.equal(bookingRow(made.body.id).passengers, 'ארה"ב');
  });
});

// ── 4. server/trip-mcp/tools.js ─────────────────────────────────────────────
describe('server/trip-mcp/tools.js — the message survives siteClient\'s 300-character cap', () => {
  const { McpServer } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js');
  const { Client } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
  const { InMemoryTransport } = require('../server/node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js');
  const { registerTools } = require('../server/trip-mcp/tools.js');

  // The real trip server, called as the organizer, failing EXACTLY as
  // siteClient() in server/trip-mcp/index.js does: the body cut at 300.
  function realSite(token) {
    const call = async (method, path, body) => {
      const r = await api(path, { method, token, body });
      if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${(r.body ? JSON.stringify(r.body) : r.text).slice(0, 300)}`);
      return r.body;
    };
    return { get: p => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b ?? {}), del: p => call('DELETE', p) };
  }
  async function connect() {
    const server = new McpServer({ name: 'test', version: '1' });
    registerTools(server, realSite(alice), { write: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  test('every refusal text-rules.js can produce fits its message inside the first 300 characters of the body', () => {
    // siteClient() cuts a refusal body at 300 characters. A message that grows
    // past that reaches the organizer's assistant cut mid-sentence — fail here.
    const rules = require('../server/text-rules.js');
    const samples = { line: ['<', 'a\nb', 'a\u0000b', { x: 1 }, 'x'.repeat(3000)], multiline: ['<', 'a\u0000b', { x: 1 }, 'x'.repeat(3000)], date: ['bad'], link: ['bad'] };
    let checked = 0;
    for (const specs of [rules.BOOKING_FIELDS, rules.PARTICIPANT_FIELDS]) {
      for (const [field, spec] of Object.entries(specs)) {
        const bodies = samples[spec.kind].map(v => rules.checkField(field, v, spec).error);
        bodies.push(rules.requiredRefusal('missing_fields', field, specs), rules.requiredRefusal('phase, type, name required', field, specs));
        for (const body of bodies) {
          assert.ok(body, `${field}: expected a refusal`);
          const json = JSON.stringify(body);
          const end = json.indexOf(JSON.stringify(body.message.en).slice(1, -1)) + JSON.stringify(body.message.en).length - 2;
          assert.ok(end <= 300, `${field}/${body.error}: message ends at character ${end} of the body:\n${json}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 40, `checked ${checked}`);
  });

  test('add_booking / update_booking / add_participant: both messages arrive whole, with the hint', async () => {
    const client = await connect();
    try {
      // The longest messages: a link (the longest text) on the longest label.
      const cases = [
        ['add_booking', base({ passengers: XSS }), 'passengers'],
        ['add_booking', base({ location_url: 'https://maps.example/a b' }), 'location_url'],
        ['add_booking', base({ notes: 'x\u0007' }), 'notes'],
        ['add_participant', { username: 'toolbad', name: 'Dan\nCohen' }, 'name'],
      ];
      const made = await asAgent('/api/bookings', { method: 'POST', body: base() });
      cases.push(['update_booking', { id: made.body.id, confirmation: 'A'.repeat(81) }, 'confirmation']);
      for (const [name, args, field] of cases) {
        const res = await client.callTool({ name, arguments: args });
        assert.equal(res.isError, true, `${name}: ${JSON.stringify(res)}`);
        const text = res.content[0].text;
        const direct = name === 'update_booking'
          ? await asAgent(`/api/bookings/${args.id}`, { method: 'PATCH', body: { confirmation: args.confirmation } })
          : name === 'add_participant'
            ? await asAgent('/api/agent/participants', { method: 'POST', body: args })
            : await asAgent('/api/bookings', { method: 'POST', body: args });
        assert.equal(direct.body.field, field);
        assert.ok(text.includes(direct.body.message.he), `${name}/${field}: Hebrew message cut or missing:\n${text}`);
        assert.ok(text.includes(direct.body.message.en), `${name}/${field}: English message cut or missing:\n${text}`);
        assert.match(text, /organizer/i, `${name}: the hint says to relay it`);
      }
    } finally { await client.close(); }
  });
});

// ── 5. site/app.js — the booking form shows the message ─────────────────────
describe('site/app.js submitBooking() — a refused save shows the server\'s message in the page language, as text', () => {
  const APP = readFileSync(join(REPO, 'site', 'app.js'), 'utf8');
  const fn = (name) => {
    const start = APP.search(new RegExp(`(async )?function ${name}\\(`));
    assert.notEqual(start, -1, `${name} not found in app.js`);
    return APP.slice(start, APP.indexOf('\n}\n', start) + 3);
  };
  const FORM = ['bk-id', 'bk-phase', 'bk-type', 'bk-name', 'bk-date-from', 'bk-date-to', 'bk-passengers', 'bk-conf', 'bk-pin',
    'bk-cost', 'bk-notes', 'bk-google-wallet', 'bk-location-url'];

  async function run(lang, response, values = {}) {
    const win = new Window({ url: 'http://localhost/' });
    const doc = win.document;
    doc.body.innerHTML = FORM.map(id => `<input id="${id}">`).join('') +
      '<input id="bk-file" type="file"><input id="bk-pkpass-file" type="file"><p id="bk-err"></p>';
    const vals = { 'bk-phase': 'ny', 'bk-type': 'hotel', 'bk-name': 'Hotel', ...values };
    for (const [id, v] of Object.entries(vals)) doc.getElementById(id).value = v;
    const calls = [];
    const ctx = vm.createContext({
      window: win, document: doc, currentLang: lang, console,
      localStorage: { getItem: () => 'tok' },
      T: { he: { bk_err_req: 'חובה', bk_err_server: 'שגיאת שרת' }, en: { bk_err_req: 'Required', bk_err_server: 'Server error' } },
      fetch: async (url, opts) => { calls.push({ url, opts }); return response(); },
      hideBookingForm: () => calls.push('hidden'), loadBookings: () => {}, loadPhaseBookings: () => {}, loadHomeOverview: () => {},
      FormData: win.FormData,
    });
    const extra = /function bookingSaveRefusal\(/.test(APP) ? fn('bookingSaveRefusal') : '';
    vm.runInContext(`${extra}\n${fn('submitBooking')}`, ctx);
    await ctx.submitBooking();
    return { doc, calls, err: doc.getElementById('bk-err') };
  }
  const refused = (body) => () => ({ ok: false, status: 400, json: async () => body });
  const MESSAGE = { he: "השדה 'נוסעים' מכיל תו שאסור: < או >. הסירו אותו ונסו שוב.", en: "The 'passengers' field contains a character that isn't allowed: < or >. Remove it and try again." };

  test('Hebrew page → the Hebrew message; English page → the English one; the form stays open', async () => {
    for (const lang of ['he', 'en']) {
      const { err, calls } = await run(lang, refused({ error: 'invalid_text', field: 'passengers', message: MESSAGE }));
      assert.equal(err.textContent, MESSAGE[lang]);
      assert.ok(!calls.includes('hidden'), 'the form is not closed on a refusal');
    }
  });

  test('the message is inserted as text — a message carrying markup creates no element', async () => {
    const { err } = await run('en', refused({ error: 'invalid_text', message: { he: 'x', en: '<img src=x onerror=alert(1)>' } }));
    assert.equal(err.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(err.querySelectorAll('img').length, 0);
  });

  test('no message (an older server, a 500, a non-JSON body) → the generic error, as before', async () => {
    for (const response of [refused({ error: 'boom' }), () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } })]) {
      const { err } = await run('he', response);
      assert.equal(err.textContent, 'שגיאת שרת');
    }
  });
});
