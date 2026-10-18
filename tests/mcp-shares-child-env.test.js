/**
 * mcp.js's Hermes child allow-list is the SAME definition as
 * control-plane/api/src/model-runner.ts's, not a second copy kept in sync by
 * hand (#284). Before this, #153/#58's STRUCTURING_BASE_ENV + hermesChildEnv
 * and #183's HERMES_CHILD_ENV_ALLOW + hermesChildEnv() were byte-for-byte
 * duplicates, with a comment on the mcp.js side asking a human to notice when
 * either one drifted — exactly the kind of thing that stops being checked the
 * first time nobody happens to look.
 *
 * mcp.js can't be required in-process without starting its HTTP server
 * (`app.listen` runs unconditionally at module load — see tests/helpers/mcp.js,
 * which always spawns it as a subprocess instead). So this is the mechanical
 * half: mcp.js's own source must import the allow-list from
 * shared/child-env.js, and must not define a second, locally-maintained copy
 * — a future edit that reintroduces a hand-rolled array (even one that still
 * matches today's list) fails here, not silently. The behavioural half — the
 * spawned Hermes child actually receives exactly this allow-list — is
 * mcp-extract-env.test.js, unchanged by this refactor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharedChildEnv from '../shared/child-env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SOURCE = readFileSync(join(HERE, '..', 'mcp', 'mcp.js'), 'utf8');

test('mcp.js imports its Hermes child environment from shared/child-env.js', () => {
  assert.match(
    MCP_SOURCE,
    /require\(['"]\.\.\/shared\/child-env\.js['"]\)/,
    'mcp.js must require ../shared/child-env.js for hermesChildEnv',
  );
});

test('mcp.js does not define its own copy of the allow-list', () => {
  assert.doesNotMatch(
    MCP_SOURCE,
    /HERMES_CHILD_ENV_ALLOW\s*=/,
    "a hand-rolled HERMES_CHILD_ENV_ALLOW is back in mcp.js — that was #183's copy, now owned by shared/child-env.js (#284)",
  );
  assert.doesNotMatch(
    MCP_SOURCE,
    /function hermesChildEnv/,
    'mcp.js must use the shared hermesChildEnv, not redefine its own',
  );
});

test('shared/child-env.js exports what both consumers use', () => {
  assert.equal(typeof sharedChildEnv.structuringChildEnv, 'function');
  assert.equal(typeof sharedChildEnv.hermesChildEnv, 'function');
  assert.ok(Array.isArray(sharedChildEnv.STRUCTURING_BASE_ENV));
  assert.deepEqual(
    Object.keys(sharedChildEnv.hermesChildEnv({ PATH: 'x', HOME: 'y', HERMES_HOME: 'z', SECRET: 'leak' })).sort(),
    ['HERMES_HOME', 'HOME', 'PATH'],
  );
});
