import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #367: server/Dockerfile copied only server/*.js, so server/trip-mcp/
// was missing from a Docker-hosted trip. server.js loads it inside a
// try/catch, so the site booted and the MCP connector silently never
// registered. Every local directory server.js requires must be COPYed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const dockerfile = fs.readFileSync(path.join(serverDir, 'Dockerfile'), 'utf8');
const source = fs.readFileSync(path.join(serverDir, 'server.js'), 'utf8');

const copies = dockerfile.split('\n')
  .map(l => l.trim())
  .filter(l => /^COPY\s/i.test(l))
  .map(l => l.replace(/^COPY\s+/i, '').split(/\s+/));

test('every local directory server.js requires is copied into the image', () => {
  const localRequires = [...source.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map(m => m[1].slice(2));
  const dirs = [...new Set(localRequires)].filter(name => {
    const p = path.join(serverDir, name);
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  });
  assert.ok(dirs.includes('trip-mcp'), 'sanity: server.js requires ./trip-mcp (a directory)');
  for (const dir of dirs) {
    const covered = copies.some(([src]) => src === `server/${dir}` || src === `server/${dir}/`);
    assert.ok(covered, `server.js requires ./${dir} (a directory) but server/Dockerfile has no COPY server/${dir} line`);
  }
});

test('the server/*.js COPY is still there for the single-file requires', () => {
  assert.ok(copies.some(([src]) => src === 'server/*.js'), 'server/*.js is copied');
});

test("trip-mcp's relative requires out of its directory resolve inside the image layout", () => {
  // /app/server/trip-mcp/index.js requires ../../shared/... -> /app/shared.
  assert.ok(copies.some(([src, dst]) => src === 'shared' && dst === '/app/shared'), 'shared is copied to /app/shared');
  for (const f of fs.readdirSync(path.join(serverDir, 'trip-mcp')).filter(n => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(serverDir, 'trip-mcp', f), 'utf8');
    for (const m of text.matchAll(/require\(\s*['"](\.\.\/[^'"]+)['"]\s*\)/g)) {
      assert.ok(m[1].startsWith('../../shared/'),
        `trip-mcp/${f} requires ${m[1]}; only ../../shared/* is present in the image`);
    }
  }
});
