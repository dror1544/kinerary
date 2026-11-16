/**
 * feature-switches-site.test.js — the site half of per-trip feature switches
 * (issue #567, slice S2; docs/specs/sprint-9/567-feature-switches.md).
 *
 * The control plane writes a `features` block into trip.config.json at provision
 * and at rollout. The site reads it once at boot and serves members the part they
 * may see. This file pins the three things the boundary rests on:
 *
 *   AC-12  GET /api/config carries `features` only for switches the REGISTRY marks
 *          member-visible, and only when the file's value is the literal `true`.
 *   AC-13  a name the registry does not hold, or a value that is not `true`, is not
 *          served, and the boot log names it once.
 *   (rule) `features` is a closed node built from the registry — never a
 *          pass-through map — so the name of an unreleased feature is not served to
 *          every signed-in child.
 *
 * Over HTTP, as a plain member and as the agent key, with delivery_probe off, on,
 * and the file carrying an unregistered name and a non-`true` value.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { PORTS } from './helpers/ports.js';
import { projectConfig, publicConfig, featureEntries, makeFeatureOn, buildFeaturesNode } from '../shared/config-visibility.js';
import { FEATURE_SWITCHES } from '../shared/feature-switches.js';
import allow from '../shared/allow-list.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const withFeatures = (features) => ({ ...clone(FIXTURE), features });

// A registry with one switch a member may be told about and one they may not —
// the shipped registry has only delivery_probe (member-visible), so the
// "registered but withheld" branch is exercised on a stand-in registry.
const STAND_IN_ENTRIES = [
  { name: 'visible_one', memberVisible: true },
  { name: 'hidden_one', memberVisible: false },
];
const STAND_IN = { findSwitch: (name) => STAND_IN_ENTRIES.find((e) => e.name === name) || null };

describe('the features node (shared/config-visibility.js)', () => {
  const project = (value) => {
    const report = allow.newReport();
    const out = allow.project(value, buildFeaturesNode(STAND_IN), report, 'features');
    return { out, report };
  };

  test('serves a member-visible switch whose value is the literal true', () => {
    const { out, report } = project({ visible_one: true });
    assert.deepEqual(out, { visible_one: true });
    assert.deepEqual(report.dropped, []);
    assert.deepEqual(report.withheld, []);
  });

  test('a registered switch the registry does not mark member-visible is withheld, not dropped', () => {
    const { out, report } = project({ visible_one: true, hidden_one: true });
    assert.deepEqual(out, { visible_one: true });
    assert.deepEqual(report.withheld, ['features.hidden_one']);
    assert.deepEqual(report.dropped, []);
  });

  test('when nothing is served the node is omitted: a hidden switch leaves no trace', () => {
    const { out } = project({ hidden_one: true });
    assert.equal(out, allow.OMIT);
  });

  test('only the literal true is served: false, "true", 1, null, objects and arrays are dropped', () => {
    for (const bad of [false, 'true', 1, 0, null, {}, [], { on: true }, 'yes']) {
      const { out, report } = project({ visible_one: bad });
      assert.equal(out, allow.OMIT, `value ${JSON.stringify(bad)} must not be served`);
      assert.deepEqual(report.dropped, ['features.visible_one'], `value ${JSON.stringify(bad)}`);
    }
  });

  test('an unregistered name is dropped whatever its value, including prototype-ish names', () => {
    const raw = JSON.parse('{"ghost": true, "__proto__": true, "constructor": true, "toString": true, "visible_one": true}');
    const { out, report } = project(raw);
    assert.deepEqual(out, { visible_one: true });
    assert.deepEqual(report.dropped.sort(), ['features.__proto__', 'features.constructor', 'features.ghost', 'features.toString'].sort());
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  });

  test('a features value that is not an object is dropped whole (an array is not a map of names)', () => {
    for (const bad of [true, 'delivery_probe', ['delivery_probe'], 7, null]) {
      const { out, report } = project(bad);
      assert.equal(out, allow.OMIT, JSON.stringify(bad));
      assert.deepEqual(report.dropped, ['features']);
    }
  });

  test('the shipped registry: delivery_probe true is served by projectConfig/publicConfig', () => {
    assert.ok(FEATURE_SWITCHES.some((s) => s.name === 'delivery_probe' && s.memberVisible === true));
    const { value, dropped } = projectConfig(withFeatures({ delivery_probe: true }));
    assert.deepEqual(value.features, { delivery_probe: true });
    assert.deepEqual(dropped.filter((p) => /^features/.test(p)), []);
    assert.deepEqual(publicConfig(withFeatures({ delivery_probe: true })).features, { delivery_probe: true });
  });

  test('absent, empty and all-off blocks serve no features key at all', () => {
    for (const features of [undefined, {}]) {
      const served = publicConfig(withFeatures(features));
      assert.ok(!('features' in served), JSON.stringify(features));
    }
  });
});

describe('featureOn — the one server-side gate', () => {
  test('on only for a registered name whose value in the file is the literal true', () => {
    const log = [];
    const on = makeFeatureOn({ delivery_probe: true, ghost: true }, { warn: (m) => log.push(m) });
    assert.equal(on('delivery_probe'), true);
    assert.equal(on('ghost'), false, 'an unregistered name is off even if the file says true');
  });

  test('a non-true value is off', () => {
    for (const bad of [false, 'true', 1, null, 'yes', {}]) {
      assert.equal(makeFeatureOn({ delivery_probe: bad }, { warn() {} })('delivery_probe'), false, JSON.stringify(bad));
    }
  });

  test('no block, a non-object block and an array block are all off', () => {
    for (const raw of [undefined, null, 'delivery_probe', ['delivery_probe'], 7]) {
      assert.equal(makeFeatureOn(raw, { warn() {} })('delivery_probe'), false, JSON.stringify(raw));
    }
  });

  test('it answers for registered names whether or not members may see them (memberVisible is a serving rule, not a gate)', () => {
    const on = makeFeatureOn({ hidden_one: true }, { warn() {} }, STAND_IN);
    assert.equal(on('hidden_one'), true);
  });

  test('asking about a name the registry does not hold is off AND loud, once per name', () => {
    const log = [];
    const on = makeFeatureOn({ delivery_probe: true }, { warn: (m) => log.push(m) });
    assert.equal(on('delivary_probe'), false);
    assert.equal(on('delivary_probe'), false);
    assert.equal(log.length, 1, `logged once, not per call: ${JSON.stringify(log)}`);
    assert.match(log[0], /delivary_probe/);
    assert.match(log[0], /shared\/feature-switches\.js/);
  });

  test('featureEntries names every unserved entry by path and reason, never by value', () => {
    const { on, problems } = featureEntries({ delivery_probe: 'SECRET-VALUE', ghost: true, __proto__x: false });
    assert.deepEqual(on, []);
    assert.deepEqual(problems.map((p) => p.path).sort(), ['features.__proto__x', 'features.delivery_probe', 'features.ghost']);
    assert.ok(!JSON.stringify(problems).includes('SECRET-VALUE'));
  });
});

describe('server.js gates through featureOn and reads the raw block exactly once', () => {
  const src = readFileSync(join(REPO, 'server', 'server.js'), 'utf8');
  test('the raw `features` key is read in one place, to build featureOn', () => {
    const reads = src.match(/TRIP_CONFIG\??\.features/g) || [];
    assert.equal(reads.length, 1, `TRIP_CONFIG.features read ${reads.length} times; gate with featureOn(name) instead`);
    assert.match(src, /const FEATURES_IN_FILE = TRIP_CONFIG\.features;\s*const featureOn = makeFeatureOn\(FEATURES_IN_FILE/);
  });
});

describe('site/app.js reads cfg.features only for the literal true', () => {
  const src = readFileSync(join(REPO, 'site', 'app.js'), 'utf8');
  const start = src.indexOf('function tripFeatureOn(');
  test('tripFeatureOn exists', () => assert.notEqual(start, -1, 'tripFeatureOn() not found in site/app.js'));
  test('absent, false and non-true values are off; true is on', () => {
    const fn = src.slice(start, src.indexOf('\n}\n', start) + 3);
    const run = (cfg, name) => {
      const ctx = vm.createContext({ window: { TRIP_CONFIG: cfg } });
      return vm.runInContext(`${fn}; tripFeatureOn(${JSON.stringify(name)})`, ctx);
    };
    assert.equal(run({ features: { delivery_probe: true } }, 'delivery_probe'), true);
    assert.equal(run({}, 'delivery_probe'), false);
    assert.equal(run(undefined, 'delivery_probe'), false);
    assert.equal(run({ features: { delivery_probe: 'true' } }, 'delivery_probe'), false);
    assert.equal(run({ features: { delivery_probe: 1 } }, 'delivery_probe'), false);
    assert.equal(run({ features: ['delivery_probe'] }, 'delivery_probe'), false);
    assert.equal(run({ features: {} }, 'constructor'), false);
  });
});

// ── Over HTTP ─────────────────────────────────────────────────────────────────
// One server per planted config, as a plain member (bob) and as the agent key.
describe('GET /api/config and /api/config/warnings over HTTP', () => {
  const PORT = PORTS.featureSwitchesSite;
  const BASE = `http://localhost:${PORT}`;
  const AGENT_KEY = 'test-hermes-key';
  let dataDir;

  async function withServer(features, fn) {
    dataDir = mkdtempSync(join(tmpdir(), 'trip-features-'));
    const tripDir = join(dataDir, 'trip');
    cpSync(join(HERE, 'fixtures'), tripDir, { recursive: true });
    const cfg = clone(FIXTURE);
    if (features !== undefined) cfg.features = features;
    writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(cfg, null, 2));
    mkdirSync(join(dataDir, 'site'), { recursive: true });
    const proc = spawn('node', [join(REPO, 'server', 'server.js')], {
      cwd: join(REPO, 'server'),
      env: { ...process.env, PORT: String(PORT), TRIP_DIR: tripDir, DATA_DIR: dataDir,
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
        setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log}`)); }, 10_000);
      });
      let token = null;
      for (let i = 0; i < 30 && !token; i++) {
        const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'bob', password: '1234' }) });
        if (r.ok) token = (await r.json()).token; else await new Promise((res) => setTimeout(res, 100));
      }
      assert.ok(token, 'bob could not log in');
      const get = async (path, headers) => {
        const res = await fetch(`${BASE}${path}`, { headers });
        return { status: res.status, body: await res.json() };
      };
      return await fn({
        asMember: (path) => get(path, { Authorization: `Bearer ${token}` }),
        asAgent: (path) => get(path, { 'X-API-Key': AGENT_KEY }),
        bootLog: () => log,
      });
    } finally {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  test('delivery_probe OFF (no features block): the key is not in the response, member or agent', async () => {
    await withServer(undefined, async ({ asMember, asAgent, bootLog }) => {
      for (const ask of [asMember, asAgent]) {
        const { status, body } = await ask('/api/config');
        assert.equal(status, 200);
        assert.ok(!('features' in body), `features served with no block in the file: ${JSON.stringify(body.features)}`);
      }
      assert.doesNotMatch(bootLog(), /"features[".]/);
    });
  });

  test('delivery_probe ON: a member and the agent key both get exactly { delivery_probe: true }', async () => {
    await withServer({ delivery_probe: true }, async ({ asMember, asAgent, bootLog }) => {
      const m = await asMember('/api/config');
      const a = await asAgent('/api/config');
      assert.equal(m.status, 200);
      assert.equal(a.status, 200);
      assert.deepEqual(m.body.features, { delivery_probe: true });
      assert.deepEqual(a.body.features, { delivery_probe: true }, 'the agent key sees the same node as a member, no wider');
      assert.doesNotMatch(bootLog(), /"features[".]/, 'a valid block is not a warning');
      // /api/config/versions/:version is the same projection
      const warnings = await asMember('/api/config/warnings');
      assert.ok(!JSON.stringify(warnings.body).includes('features'), 'a valid block adds no warning');
    });
  });

  test('delivery_probe explicitly false is off, and is named in the boot log (a registered name with a non-true value)', async () => {
    await withServer({ delivery_probe: false }, async ({ asMember, bootLog }) => {
      const { body } = await asMember('/api/config');
      assert.ok(!('features' in body));
      assert.match(bootLog(), /"features\.delivery_probe"/);
    });
  });

  test('an unregistered name and a non-true value are not served; the boot log names each once; warnings carry a count only', async () => {
    const planted = { delivery_probe: 'SECRET-VALUE-XYZ', ghost_feature: true, another_ghost: 1 };
    await withServer(planted, async ({ asMember, asAgent, bootLog }) => {
      for (const ask of [asMember, asAgent]) {
        const { status, body } = await ask('/api/config');
        assert.equal(status, 200);
        assert.ok(!('features' in body), `served: ${JSON.stringify(body.features)}`);
        const text = JSON.stringify(body);
        assert.ok(!text.includes('ghost_feature') && !text.includes('another_ghost'), 'an unregistered name reached /api/config');
      }
      const log = bootLog();
      for (const name of ['delivery_probe', 'ghost_feature', 'another_ghost']) {
        const hits = log.split('\n').filter((l) => l.includes(`features.${name}`));
        assert.equal(hits.length, 1, `${name}: expected the boot log to name it once, got ${hits.length}\n${log}`);
      }
      assert.ok(!log.includes('SECRET-VALUE-XYZ'), 'the value is never logged');
      for (const ask of [asMember, asAgent]) {
        const w = await ask('/api/config/warnings');
        assert.equal(w.status, 200);
        const text = JSON.stringify(w.body);
        assert.ok(!text.includes('ghost_feature') && !text.includes('another_ghost') && !text.includes('delivery_probe'),
          `/api/config/warnings leaked a switch name: ${text}`);
        const mine = w.body.filter((x) => /features/.test(x.issue));
        assert.equal(mine.length, 1, 'exactly one count-only warning for the features block');
        assert.match(mine[0].issue, /^3 features entries are not honoured/);
      }
    });
  });

  test('a mixed block serves the good entry and drops the bad ones', async () => {
    await withServer({ delivery_probe: true, ghost_feature: true }, async ({ asMember }) => {
      const { body } = await asMember('/api/config');
      assert.deepEqual(body.features, { delivery_probe: true });
    });
  });

  test('features that is not an object (an array of names) serves nothing', async () => {
    await withServer(['delivery_probe'], async ({ asMember, bootLog }) => {
      const { body } = await asMember('/api/config');
      assert.ok(!('features' in body));
      assert.match(bootLog(), /"features"/);
    });
  });
});
