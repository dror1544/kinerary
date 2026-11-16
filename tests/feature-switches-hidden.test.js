/**
 * feature-switches-hidden.test.js — a registered switch that is ON but not member-visible
 * leaves no tell on the wire (issue #567 S2, boundary review round 1).
 *
 * The shipped registry holds one entry, `delivery_probe`, which IS member-visible, so the
 * hidden-but-on branch of shared/config-visibility.js cannot be reached with it. This file
 * boots the REAL server (server/server.js, unmodified) from a temp copy of server/ and
 * shared/ in which shared/feature-switches.js carries a second entry, `hidden_probe`, with
 * memberVisible:false — nothing in the security code is made testable for this: the registry
 * is just different data.
 *
 * Proved end to end through GET /api/config and GET /api/config/warnings, as a member and as
 * the agent key:
 *   - a trip with ONLY the hidden switch on answers byte-for-byte as a trip with no block;
 *   - with the visible and the hidden both on, only the visible one is served;
 *   - the hidden switch's NAME appears in no response and in no boot log line;
 *   - a hidden switch that is not `true` is still a problem (named in the log, counted).
 * And the dropped-field warning's exclusion of the features node is exact: a top-level key
 * that merely looks like one of its paths is still logged and counted.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PORTS } from './helpers/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
const AGENT_KEY = 'test-hermes-key';
const PORT = PORTS.featureSwitchesHidden;
const BASE = `http://127.0.0.1:${PORT}`;

describe('hidden-but-on switch, on the real server with a patched registry', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'trip-hidden-switch-'));
    cpSync(join(REPO, 'shared'), join(root, 'shared'), { recursive: true });
    cpSync(join(REPO, 'server'), join(root, 'server'), {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|avatars|data)([\\/]|$)/.test(src.slice(join(REPO, 'server').length)),
    });
    symlinkSync(join(REPO, 'server', 'node_modules'), join(root, 'server', 'node_modules'));
    const registry = join(root, 'shared', 'feature-switches.js');
    const src = readFileSync(registry, 'utf8');
    const marker = 'const FEATURE_SWITCHES = Object.freeze([';
    assert.ok(src.includes(marker), 'the registry changed shape; update this test');
    writeFileSync(registry, src.replace(marker, `${marker}
  Object.freeze({ name: 'hidden_probe', summary: 'test-only hidden switch', surfaces: Object.freeze(['site']), memberVisible: false }),`));
    const check = spawnSync('node', ['-e',
      "const r=require(process.argv[1]);console.log(JSON.stringify([r.findSwitch('hidden_probe')?.memberVisible,r.findSwitch('delivery_probe')?.memberVisible]))",
      registry], { encoding: 'utf8' });
    assert.equal(check.stdout.trim(), '[false,true]', `the patched registry is not what the server will load: ${check.stderr}`);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  async function withServer(mutate, fn) {
    const dataDir = mkdtempSync(join(tmpdir(), 'trip-hidden-data-'));
    const tripDir = join(dataDir, 'trip');
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
    const cfg = JSON.parse(JSON.stringify(FIXTURE));
    mutate(cfg);
    writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));
    mkdirSync(join(dataDir, 'site'), { recursive: true });
    const proc = spawn('node', [join(root, 'server', 'server.js')], {
      cwd: join(root, 'server'),
      env: { ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir, SITE_DIR: join(dataDir, 'site'),
        AVATARS_DIR: join(dataDir, 'avatars'), JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '',
        HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234' },
    });
    let log = '';
    proc.stderr.on('data', (c) => { log += c; });
    proc.stdout.on('data', (c) => { log += c; });
    try {
      await new Promise((resolve, reject) => {
        const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
        proc.on('exit', (code) => { clearInterval(t); reject(new Error(`server exited ${code}: ${log}`)); });
        setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log}`)); }, 10_000);
      });
      let token = null;
      for (let i = 0; i < 30 && !token; i++) {
        const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'bob', password: '1234' }) });
        if (r.ok) token = (await r.json()).token; else await new Promise((res) => setTimeout(res, 100));
      }
      assert.ok(token, 'bob could not log in');
      const read = async (headers) => {
        const out = {};
        for (const path of ['/api/config', '/api/config/warnings']) {
          const res = await fetch(`${BASE}${path}`, { headers });
          assert.equal(res.status, 200, path);
          out[path] = await res.text();      // the BODY, byte for byte
        }
        return out;
      };
      return await fn({
        member: () => read({ Authorization: `Bearer ${token}` }),
        agent: () => read({ 'X-API-Key': AGENT_KEY }),
        bootLog: () => log,
      });
    } finally {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  test('only the hidden switch on: every response body is identical to a trip with no features block', async () => {
    const none = await withServer(() => {}, async ({ member, agent }) => ({ member: await member(), agent: await agent() }));
    const hidden = await withServer((cfg) => { cfg.features = { hidden_probe: true }; },
      async ({ member, agent, bootLog }) => ({ member: await member(), agent: await agent(), log: bootLog() }));
    for (const who of ['member', 'agent']) {
      for (const path of ['/api/config', '/api/config/warnings']) {
        assert.equal(hidden[who][path], none[who][path], `${who} ${path}: a hidden-but-on switch changed the response`);
      }
    }
    assert.ok(!JSON.parse(none.member['/api/config']).features, 'the baseline has no features key');
    assert.ok(!hidden.log.includes('hidden_probe'), 'the hidden switch\'s name is in the boot log although it is a valid, registered entry');
    assert.doesNotMatch(hidden.log, /"features/, 'a valid block is not a warning');
  });

  test('visible and hidden both on: only the visible one is served, to a member and to the agent key', async () => {
    await withServer((cfg) => { cfg.features = { delivery_probe: true, hidden_probe: true }; }, async ({ member, agent }) => {
      for (const ask of [member, agent]) {
        const r = await ask();
        assert.deepEqual(JSON.parse(r['/api/config']).features, { delivery_probe: true });
        assert.ok(!r['/api/config'].includes('hidden_probe') && !r['/api/config/warnings'].includes('hidden_probe'));
      }
    });
  });

  test('a hidden switch that does not hold the literal true is a problem: named in the log, counted, never served', async () => {
    await withServer((cfg) => { cfg.features = { hidden_probe: 'yes' }; }, async ({ member, bootLog }) => {
      const r = await member();
      assert.ok(!('features' in JSON.parse(r['/api/config'])));
      assert.ok(!r['/api/config/warnings'].includes('hidden_probe'), 'the name never reaches a member');
      assert.match(r['/api/config/warnings'], /1 features entry is not honoured/);
      assert.match(bootLog(), /"features\.hidden_probe" does not hold the literal true/);
    });
  });

  test('the dropped-field warning skips the features node exactly: a top-level key named like one of its paths is still logged and counted', async () => {
    await withServer((cfg) => { cfg['features.delivery_probe'] = 'planted'; cfg.features = { delivery_probe: true }; },
      async ({ member, bootLog }) => {
        const r = await member();
        assert.deepEqual(JSON.parse(r['/api/config']).features, { delivery_probe: true });
        assert.match(bootLog(), /not on the served allow-list[^\n]*features\.delivery_probe/, 'the stray top-level key is named in the log');
        assert.match(r['/api/config/warnings'], /config field\(s\) are not on the served allow-list/);
      });
  });
});
