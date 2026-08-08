/**
 * Telegram SSO integration tests. The Telegram API is a local HTTP stub so no
 * real bot, group, account, or network access is needed.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');
const SERVER_JS = join(HERE, '..', 'server', 'server.js');
const SERVER_DIR = join(HERE, '..', 'server');
const PORT = 3095;
const BOT_TOKEN = 'test-bot-token';
const CHAT_ID = '-100-test-chat';

function signedPayload(overrides = {}) {
  const payload = {
    id: '1001',
    first_name: 'Telegram',
    username: 'telegram-user',
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
  const dataCheckString = Object.keys(payload).sort().map(key => `${key}=${payload[key]}`).join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  payload.hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return payload;
}

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => { if (!ready) reject(new Error('server boot timeout')); }, 10_000);
    proc.stdout.on('data', chunk => {
      if (!ready && chunk.toString().includes('Trip server running on')) {
        ready = true;
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.stderr.on('data', chunk => {
      // Keep runtime diagnostics available after the readiness line too; an
      // accepted SSO request must never be able to terminate the server silently.
      process.stderr.write(chunk);
    });
    proc.on('error', reject);
    proc.on('exit', code => { if (!ready) reject(new Error(`server exited with ${code}`)); });
  });
}

function stop(proc) {
  return new Promise(resolve => {
    proc.once('exit', resolve);
    proc.kill('SIGTERM');
  });
}

describe('Telegram Login SSO', () => {
  let apiServer;
  let apiBaseUrl;
  let tripServer;
  let dataDir;
  let tripDir;
  let membership = { status: 'member' };
  let telegramCalls = 0;

  before(async () => {
    apiServer = createServer((req, res) => {
      telegramCalls++;
      // Prefix-checked rather than one hardcoded user_id, so a second
      // participant (added at runtime via POST /api/agent/participants,
      // elsewhere in this file) can also exercise a real getChatMember call
      // against this same stub without colliding with participants[0]'s id.
      const prefix = `/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHAT_ID)}&user_id=`;
      assert.ok(req.url.startsWith(prefix), `unexpected getChatMember URL: ${req.url}`);
      const userId = Number(req.url.slice(prefix.length));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { user: { id: userId }, ...membership } }));
    });
    await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;

    dataDir = mkdtempSync(join(tmpdir(), 'trip-telegram-data-'));
    tripDir = mkdtempSync(join(tmpdir(), 'trip-telegram-trip-'));
    cpSync(FIXTURES_DIR, tripDir, { recursive: true });
    const configPath = join(tripDir, 'trip.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.participants[0].telegram_id = '1001';
    writeFileSync(configPath, JSON.stringify(config));

    tripServer = spawn('node', [SERVER_JS], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(PORT),
        TRIP_DIR: tripDir,
        DATA_DIR: dataDir,
        AVATARS_DIR: join(dataDir, 'avatars'),
        JWT_SECRET: 'test-secret-000',
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_CHAT_ID: CHAT_ID,
        TELEGRAM_API_BASE_URL: apiBaseUrl,
        TELEGRAM_AUTH_MAX_AGE_SECONDS: '300',
        TELEGRAM_BOT_USERNAME: 'test_trip_bot',
        IMMICH_URL: '',
        IMMICH_API_KEY: '',
        HERMES_API_KEY: 'test-hermes-key',
      },
    });
    await waitForServer(tripServer);
  });

  after(async () => {
    await stop(tripServer);
    await new Promise(resolve => apiServer.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tripDir, { recursive: true, force: true });
  });

  async function telegramLogin(payload) {
    return fetch(`http://localhost:${PORT}/api/auth/telegram-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  test('rejects a request with no existing JWT before login', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/config`);
    assert.equal(res.status, 401);
  });

  test('GET /api/health exposes the bot username so the pre-auth widget can render', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.telegramBotUsername, 'test_trip_bot');
  });

  test('rejects a forged Telegram Login signature without checking membership', async () => {
    telegramCalls = 0;
    const payload = signedPayload({ first_name: 'Forged' });
    payload.hash = '0'.repeat(64);
    const res = await telegramLogin(payload);
    assert.equal(res.status, 401);
    assert.equal(telegramCalls, 0);
  });

  test('rejects an expired Telegram Login payload without checking membership', async () => {
    telegramCalls = 0;
    const res = await telegramLogin(signedPayload({ auth_date: '1' }));
    assert.equal(res.status, 401);
    assert.equal(telegramCalls, 0);
  });

  test('requires active configured-group membership', async () => {
    membership = { status: 'left' };
    const res = await telegramLogin(signedPayload());
    assert.equal(res.status, 403);
  });

  test('accepts a signed active member and returns the existing JWT-compatible session', async () => {
    membership = { status: 'member' };
    const res = await telegramLogin(signedPayload());
    assert.equal(res.status, 200);
    const { token, user } = await res.json();
    assert.equal(user.username, 'alice');
    assert.ok(typeof token === 'string' && token.length > 20);

    const configRes = await fetch(`http://localhost:${PORT}/api/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(configRes.status, 200);
    const config = await configRes.json();
    assert.ok(!('telegram_id' in config.participants.find(p => p.username === 'alice')),
      'participant Telegram IDs must never be returned to another signed-in member');
  });

  test('a participant added via POST /api/agent/participants can log in via Telegram immediately, no restart', async () => {
    membership = { status: 'member' };
    const created = await fetch(`http://localhost:${PORT}/api/agent/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-hermes-key' },
      body: JSON.stringify({ username: 'new-guy', name: 'New Guy', telegram_id: '2002' }),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).telegram_bound, true);

    const res = await telegramLogin(signedPayload({ id: '2002' }));
    assert.equal(res.status, 200, 'expected immediate login with no server restart');
    const { user } = await res.json();
    assert.equal(user.username, 'new-guy');
  });
});

// ── telegram_id sync on restart (not just first-boot seed) ────────────────────
// Real organizers add/correct a participant's telegram_id long after the DB
// already exists — e.g. Shiran's DB is seeded before all 12 participants'
// Telegram IDs are collected. Confirms trip.config.json stays the live source
// of truth across a restart, not just at the very first boot of a fresh DB.
describe('telegram_id syncs from config on every boot, not just fresh-DB seed', () => {
  const PORT2 = 3100; // 3095-3099 are already claimed by other test files
  let apiServer2;
  let apiBaseUrl2;
  let dataDir2;
  let tripDir2;
  let configPath2;

  before(async () => {
    apiServer2 = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { user: { id: 1001 }, status: 'member' } }));
    });
    await new Promise(resolve => apiServer2.listen(0, '127.0.0.1', resolve));
    apiBaseUrl2 = `http://127.0.0.1:${apiServer2.address().port}`;

    dataDir2 = mkdtempSync(join(tmpdir(), 'trip-telegram-resync-data-'));
    tripDir2 = mkdtempSync(join(tmpdir(), 'trip-telegram-resync-trip-'));
    cpSync(FIXTURES_DIR, tripDir2, { recursive: true });
    configPath2 = join(tripDir2, 'trip.config.json');
    // Deliberately no telegram_id yet — simulates the DB getting seeded
    // before the organizer has collected this participant's Telegram ID.
  });

  after(async () => {
    await new Promise(resolve => apiServer2.close(resolve));
    rmSync(dataDir2, { recursive: true, force: true });
    rmSync(tripDir2, { recursive: true, force: true });
  });

  function bootServer2() {
    const proc = spawn('node', [SERVER_JS], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(PORT2),
        TRIP_DIR: tripDir2,
        DATA_DIR: dataDir2,
        AVATARS_DIR: join(dataDir2, 'avatars'),
        JWT_SECRET: 'test-secret-000',
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_CHAT_ID: CHAT_ID,
        TELEGRAM_API_BASE_URL: apiBaseUrl2,
        TELEGRAM_AUTH_MAX_AGE_SECONDS: '300',
        IMMICH_URL: '',
        IMMICH_API_KEY: '',
        HERMES_API_KEY: 'test-hermes-key',
      },
    });
    return waitForServer(proc).then(() => proc);
  }

  // HTTP readiness is logged before async bcrypt user seeding completes (same
  // known race tests/helpers/server.js's loginAsAlice() already works around)
  // — retry briefly rather than assuming the very first request lands after
  // seeding has actually finished.
  async function telegramLoginRetrying() {
    let res, body;
    for (let attempt = 0; attempt < 30; attempt++) {
      res = await fetch(`http://localhost:${PORT2}/api/auth/telegram-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedPayload()),
      });
      body = await res.json();
      if (res.status !== 403 || body.error !== 'telegram_account_not_linked') return { res, body };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { res, body };
  }

  test('adding telegram_id to config and restarting links a user seeded without one', async () => {
    // First boot: fresh DB seeded with no telegram_id for this participant.
    // Not racy — before or after seeding finishes, the row either doesn't
    // exist yet or exists with telegram_id NULL, and both cases resolve to
    // the same telegram_account_not_linked response.
    let proc = await bootServer2();
    let { res, body } = await telegramLoginRetrying();
    assert.equal(res.status, 403, 'expected not-yet-linked before config has a telegram_id');
    assert.equal(body.error, 'telegram_account_not_linked');
    await stop(proc);

    // Organizer adds the participant's Telegram ID to config, same DB. This
    // side IS racy — the expected result flips from 403 to 200 once the
    // (still-async) seed/sync on the new process actually finishes.
    const config = JSON.parse(readFileSync(configPath2, 'utf8'));
    config.participants[0].telegram_id = '1001';
    writeFileSync(configPath2, JSON.stringify(config));

    proc = await bootServer2();
    ({ res, body } = await telegramLoginRetrying());
    assert.equal(res.status, 200, 'expected login to succeed once config has the telegram_id and the server restarted');
    assert.ok(typeof body.token === 'string' && body.token.length > 20);
    await stop(proc);
  });
});

// ── POST /api/agent/telegram-group ──────────────────────────────────────────
// A bot can't create or discover a Telegram group on its own, so chat_id is
// the one Telegram setting that can't be known at deploy time — this route
// is how it gets bound once the organizer actually creates the group.
describe('POST /api/agent/telegram-group', () => {
  const PORT3 = 3102; // 3095-3101 already claimed by other test files
  let apiServer3, apiBaseUrl3, tripServer3, dataDir3, tripDir3, envFile3, membership3;

  before(async () => {
    membership3 = { status: 'member' };
    apiServer3 = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { ...membership3 } }));
    });
    await new Promise(resolve => apiServer3.listen(0, '127.0.0.1', resolve));
    apiBaseUrl3 = `http://127.0.0.1:${apiServer3.address().port}`;

    dataDir3 = mkdtempSync(join(tmpdir(), 'trip-telegram-group-data-'));
    tripDir3 = mkdtempSync(join(tmpdir(), 'trip-telegram-group-trip-'));
    cpSync(FIXTURES_DIR, tripDir3, { recursive: true });
    envFile3 = join(dataDir3, '.env');
    // alice is already the fixture's configured organizer (agent.organizer);
    // give her a telegram_id so the route has someone to verify membership
    // against — the same precondition a real trip needs (bind the organizer
    // first via bind_participant_telegram, then bind the group).
    const configPath = join(tripDir3, 'trip.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.participants[0].telegram_id = '1001';
    writeFileSync(configPath, JSON.stringify(config));

    tripServer3 = spawn('node', [SERVER_JS], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(PORT3),
        TRIP_DIR: tripDir3,
        DATA_DIR: dataDir3,
        AVATARS_DIR: join(dataDir3, 'avatars'),
        JWT_SECRET: 'test-secret-000',
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_API_BASE_URL: apiBaseUrl3,
        ENV_FILE_PATH: envFile3,
        IMMICH_URL: '',
        IMMICH_API_KEY: '',
        HERMES_API_KEY: 'test-hermes-key',
      },
    });
    await waitForServer(tripServer3);
  });

  after(async () => {
    await stop(tripServer3);
    await new Promise(resolve => apiServer3.close(resolve));
    rmSync(dataDir3, { recursive: true, force: true });
    rmSync(tripDir3, { recursive: true, force: true });
  });

  function bindGroup(body, headers = { 'X-API-Key': 'test-hermes-key' }) {
    return fetch(`http://localhost:${PORT3}/api/agent/telegram-group`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  test('rejects an unauthenticated request', async () => {
    const res = await bindGroup({ chat_id: '-1002345678901' }, {});
    assert.equal(res.status, 401);
  });

  test('rejects a malformed chat_id', async () => {
    const res = await bindGroup({ chat_id: 'not-a-chat-id' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_chat_id');
  });

  test('rejects when the bound organizer is not an active member of the given chat', async () => {
    membership3 = { status: 'left' };
    const res = await bindGroup({ chat_id: '-1002345678901' });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, 'organizer_not_member_of_chat');
  });

  test('accepts, persists to .env, and takes effect immediately with no restart', async () => {
    membership3 = { status: 'member' };
    const res = await bindGroup({ chat_id: '-1002345678901', chat_title: 'Test Trip Group' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.chat_id, '-1002345678901');
    assert.equal(body.telegram_enabled, true);

    assert.match(readFileSync(envFile3, 'utf8'), /^TELEGRAM_CHAT_ID=-1002345678901$/m);

    // No restart: a login for this chat's member should work against the
    // already-running process immediately.
    const login = await fetch(`http://localhost:${PORT3}/api/auth/telegram-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedPayload({ id: '1001' })),
    });
    assert.equal(login.status, 200);

    // GET /api/health flips telegramGroupBound live too — this is the signal
    // an agent (or the pre-auth login screen) polls to know binding finished,
    // no restart or separate confirmation needed.
    const health = await fetch(`http://localhost:${PORT3}/api/health`);
    assert.equal((await health.json()).telegramGroupBound, true);
  });

  test('re-binding overwrites the previously persisted chat_id rather than duplicating the line', async () => {
    const res = await bindGroup({ chat_id: '-1009999999999' });
    assert.equal(res.status, 200);
    const envContent = readFileSync(envFile3, 'utf8');
    assert.match(envContent, /^TELEGRAM_CHAT_ID=-1009999999999$/m);
    assert.equal(envContent.match(/TELEGRAM_CHAT_ID=/g).length, 1);
  });
});
