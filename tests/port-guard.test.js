import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
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
