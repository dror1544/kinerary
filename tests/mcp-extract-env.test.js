/**
 * mcp-extract-env.test.js — the Hermes child runHermesExtract spawns gets an
 * ALLOW-listed environment, never trip-mcp's own ambient one (issue #183).
 *
 * Before this fix, runHermesExtract's execFile call had no `env` option at
 * all, and Node treats that as "inherit everything" — so a prompt injection
 * in an uploaded document ran inside a process that could see this bridge's
 * own MCP_API_KEY-equivalent secret (HERMES_API_KEY), the trip site it talks
 * to (API_BASE_URL), and anything else the bridge's process happened to hold.
 *
 * This plants canary secrets in trip-mcp's own environment, points the
 * default `hermes` binary lookup (HERMES_BIN unset, so PATH resolution)
 * at a fake `hermes` on PATH that dumps its received env and argv to disk,
 * and asserts none of the canaries reached the child — while the variables
 * the allow-list is supposed to let through (PATH, HERMES_HOME) did, and the
 * argv shape a normal extraction sends is unchanged.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { PORTS } from './helpers/ports.js';
import { startTestMcp, stopTestMcp, mcpApi, TRIP_API_KEY } from './helpers/mcp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_HERMES_BIN_DIR = join(HERE, 'fixtures', 'mock-hermes-bin');

const CANARY_HERMES_API_KEY = 'canary-hermes-api-key-do-not-leak';
const CANARY_API_BASE_URL   = 'http://canary-api-base-should-not-leak.invalid';
const CANARY_MADE_UP_TOKEN  = 'canary-made-up-secret-token-12345';

describe('runHermesExtract child environment', () => {
  let hermesHome;

  before(async () => {
    hermesHome = mkdtempSync(join(tmpdir(), 'kinerary-hermes-env-test-'));
    await startTestMcp({
      MCP_PORT: String(PORTS.mcpExtractEnv),
      HERMES_EXTRACT_PROFILE: 'test-extract-profile',
      // HERMES_BIN deliberately unset — this exercises the real default
      // ('hermes'), resolved off PATH, exactly as production does.
      PATH: `${FAKE_HERMES_BIN_DIR}:${process.env.PATH}`,
      HERMES_HOME: hermesHome,
      // Canary secrets planted in trip-mcp's OWN ambient environment, the
      // way a real deployment's would be. None of these are needed by
      // Hermes and none should reach it.
      HERMES_API_KEY: CANARY_HERMES_API_KEY,
      API_BASE_URL: CANARY_API_BASE_URL,
      SOME_MADE_UP_SECRET_TOKEN: CANARY_MADE_UP_TOKEN,
    });
  });
  after(() => {
    stopTestMcp();
    rmSync(hermesHome, { recursive: true, force: true });
  });

  test('withholds the bridge\'s own secrets from the Hermes child, and leaves argv unchanged', async () => {
    const pdf_base64 = readFileSync(join(HERE, 'fixtures', 'sample-confirmation.pdf')).toString('base64');
    const res = await mcpApi('/extract', { method: 'POST', apiKey: TRIP_API_KEY, body: { pdf_base64, pdf_name: 'test.pdf' } });
    // The fake hermes always answers "{}" (no usable data), so the route's
    // own empty-result guard turns this into a 500 — that is not what this
    // test is about; what matters is what the child actually saw. This also
    // relies on the route's `try { bookings = await apiGet('/api/bookings') }
    // catch (_) {}` swallowing the DNS failure against the unreachable
    // API_BASE_URL this suite sets — fine today, but if that try/catch is
    // ever removed, this test would start failing for that unrelated reason.
    assert.equal(res.status, 500);

    const envDump  = readFileSync(join(hermesHome, 'env-dump.txt'), 'utf8');
    const rawArgvDump = readFileSync(join(hermesHome, 'argv-dump.txt'), 'utf8');
    const argvDump = rawArgvDump.slice(0, -1).split('\0'); // drop the trailing NUL printf adds

    // Canaries must not appear anywhere in the child's environment — neither
    // as a value (in case they rode in under a different key) nor as their
    // known key names.
    assert.doesNotMatch(envDump, new RegExp(CANARY_HERMES_API_KEY));
    assert.doesNotMatch(envDump, new RegExp(CANARY_API_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(envDump, new RegExp(CANARY_MADE_UP_TOKEN));
    assert.doesNotMatch(envDump, /^HERMES_API_KEY=/m);
    assert.doesNotMatch(envDump, /^API_BASE_URL=/m);
    assert.doesNotMatch(envDump, /^SOME_MADE_UP_SECRET_TOKEN=/m);
    // MCP_API_KEY / TRIP_API_KEY — this bridge's own auth secrets — must not
    // leak either, even though they aren't this test's named canaries.
    assert.doesNotMatch(envDump, /^MCP_API_KEY=/m);
    assert.doesNotMatch(envDump, /^TRIP_API_KEY=/m);

    // Positive control: the allow-list is supposed to let these through, or
    // the fake binary could never have run at all / found its dump target.
    assert.match(envDump, /^PATH=/m);
    assert.match(envDump, new RegExp(`^HERMES_HOME=${hermesHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

    // argv unchanged from today: ['-p', profile, 'chat', '-q', <prompt>, '-Q', '--ignore-rules', '--reasoning', 'none']
    assert.equal(argvDump.length, 9, `expected 9 argv entries, got ${argvDump.length}: ${JSON.stringify(argvDump)}`);
    assert.equal(argvDump[0], '-p');
    assert.equal(argvDump[1], 'test-extract-profile');
    assert.equal(argvDump[2], 'chat');
    assert.equal(argvDump[3], '-q');
    // argvDump[4] is the (large, dynamic) prompt itself — not asserted verbatim.
    assert.equal(argvDump[5], '-Q');
    assert.equal(argvDump[6], '--ignore-rules');
    assert.equal(argvDump[7], '--reasoning');
    assert.equal(argvDump[8], 'none');
  });
});
