import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findMissingDeps, describeMissingDeps, REQUIRED_DEPS } from './helpers/required-deps.js';
import { assertPortFree, findBusyPorts, freePort, describeBusyPorts } from './helpers/port-guard.js';

const occupy = (host) => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, host, () => resolve(s));
});
const release = s => new Promise(r => s.close(r));

test('a port held by a live listener fails fast, naming the pid, the command and the remedy', async () => {
  const s = await occupy();
  const port = s.address().port;
  try {
    await assert.rejects(assertPortFree(port, { name: 'leakedThing', waitMs: 0 }), err => {
      assert.match(err.message, new RegExp(`port ${port}`));
      assert.match(err.message, /leakedThing/);
      assert.match(err.message, new RegExp(`pid ${process.pid}\\b`), err.message);
      assert.match(err.message, /node/, 'the holder\'s command is named');
      assert.match(err.message, new RegExp(`kill ${process.pid}`), 'the remedy is stated');
      return true;
    });
  } finally { await release(s); }
});

test('a listener on loopback only is found too', async () => {
  const s = await occupy('127.0.0.1');
  const port = s.address().port;
  try {
    await assert.rejects(assertPortFree(port, { waitMs: 0 }), new RegExp(`pid ${process.pid}\\b`));
  } finally { await release(s); }
});

test('a free port passes, and a holder that lets go inside the grace window is not an error', async () => {
  const s = await occupy();
  const port = s.address().port;
  setTimeout(() => s.close(), 150);
  await assertPortFree(port, { waitMs: 3000 });   // previous describe()'s server still shutting down
  await assertPortFree(port, { waitMs: 0 });
});

test('findBusyPorts names every busy entry of a table and ignores the free ones', async () => {
  const a = await occupy();
  const free = await freePort();
  try {
    const busy = await findBusyPorts({ leaked: a.address().port, fine: free });
    assert.deepEqual(busy.map(b => b.name), ['leaked']);
    const text = describeBusyPorts(busy);
    assert.match(text, /leaked/);
    assert.match(text, new RegExp(`pid ${process.pid}\\b`));
    assert.match(text, /kill/);
    assert.deepEqual(await findBusyPorts({ fine: free }), []);
  } finally { await release(a); }
});

test('freePort hands back a port that can be bound, and a different one while the first is held', async () => {
  const p1 = await freePort();
  const s1 = net.createServer();
  await new Promise(r => s1.listen(p1, r));
  try {
    const p2 = await freePort();
    assert.notEqual(p1, p2);
    assert.ok(p1 > 1023 && p1 < 65536);
  } finally { await release(s1); }
});

// Issue #366: a worktree with no `npm ci` does not fail, its tests are
// cancelled — the pretest names the missing package and the command instead.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO_ROOT, 'tests', 'helpers', 'check-free-ports.js');

test('the dependencies the suite needs resolve in this tree', () => {
  assert.deepEqual(findMissingDeps(REPO_ROOT).map(m => m.request), []);
  assert.deepEqual(REQUIRED_DEPS.map(d => d.dir).sort(), ['mcp', 'server', 'tests']);
});

test('a tree with no node_modules is named package by package, with the npm ci command', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-deps-'));
  try {
    const missing = findMissingDeps(empty);
    assert.deepEqual(missing.map(m => m.dir).sort(), ['mcp', 'server', 'tests']);
    const text = describeMissingDeps(missing);
    assert.match(text, /express/);
    assert.match(text, /@modelcontextprotocol\/sdk/);
    assert.match(text, /happy-dom/);
    for (const dir of ['server', 'mcp', 'tests']) assert.match(text, new RegExp(`npm ci --prefix ${dir}\\b`));
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('only the directory that lacks a package is named', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'some-deps-'));
  try {
    for (const dep of REQUIRED_DEPS.filter(d => d.dir !== 'mcp')) {
      const pkg = dep.request.startsWith('@') ? dep.request.split('/').slice(0, 2).join('/') : dep.request;
      const dir = path.join(root, dep.dir, 'node_modules', pkg);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, main: 'index.js' }));
      fs.writeFileSync(path.join(dir, 'index.js'), '');
    }
    assert.deepEqual(findMissingDeps(root).map(m => m.dir), ['mcp']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the pretest exits 1 naming the install command in a tree without dependencies', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-deps-'));
  try {
    const bad = spawnSync(process.execPath, [CHECK, empty], { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr, /npm ci --prefix server/);
    // This tree's own ports may legitimately be held by a neighbour's run; only the deps half is asserted.
    const ok = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' });
    assert.doesNotMatch(ok.stderr, /npm ci/, ok.stderr);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
