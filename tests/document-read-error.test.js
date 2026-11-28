/**
 * document-read-error.test.js — a source document the site process cannot read answers an error and the process lives.
 *
 * Found on the first full vm-container run (2026-11-28): the trip's documents were published owner-only, the site ran as
 * another uid, `fs.createReadStream(...).pipe(res)` had no 'error' handler, the open failed with EACCES, Node raised an
 * unhandled 'error' event and exited — every request then got a 502 from the proxy until the container restarted.
 * One unreadable file must never take the whole trip site down, whatever the placement.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, stopTestServer, api, loginAsAlice, testTripDir, testDataDir } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

const TEXT = 'Hotel Locked - confirmation LCK-1';
const LOCKED = `${createHash('sha256').update(TEXT).digest('hex')}.jpg`;
let token;
let lockedFile;
let lockedPhoto;
let canLock = true;

before(async () => {
  await startTestServer({ PORT: String(await freePort()) });
  token = await loginAsAlice();
  const documents = join(testTripDir(), 'documents');
  mkdirSync(documents, { recursive: true });
  lockedFile = join(documents, LOCKED);
  writeFileSync(lockedFile, TEXT);
  chmodSync(lockedFile, 0o000);
  // The other stream-to-client route in the album: express's sendFile, which hands a read error to the app's error
  // middleware instead of crashing. Proven rather than assumed, because the middleware is what keeps the path out.
  const uploads = join(testDataDir(), 'uploads');
  mkdirSync(uploads, { recursive: true });
  lockedPhoto = join(uploads, 'locked.jpg');
  writeFileSync(lockedPhoto, 'jpg');
  chmodSync(lockedPhoto, 0o000);
  // stat() still succeeds on a mode-000 file (the directory is searchable), which is exactly the production shape. A
  // process that bypasses file modes (root) cannot reproduce it; say so loudly instead of passing without the cause.
  try { closeSync(openSync(lockedFile, 'r')); canLock = false; } catch { /* EACCES: the precondition holds */ }
});

after(() => {
  for (const file of [lockedFile, lockedPhoto]) { try { chmodSync(file, 0o600); } catch { /* already gone */ } }
  stopTestServer();
});

describe('an unreadable confirmation file', () => {
  test('answers an error without the path or the errno, and the server keeps answering', async (t) => {
    if (!canLock) return t.skip('this process ignores file modes (root): the unreadable-file precondition cannot be built');
    const res = await api(`/api/bookings/confirmation/${LOCKED}`, { token });
    const body = await res.text();
    assert.ok(res.status >= 400 && res.status < 600, `status ${res.status}`);
    assert.doesNotMatch(body, /EACCES|permission denied|documents|\/trip|open '/i, 'no path or errno text in the body');
    assert.equal(res.headers.get('content-disposition'), null, 'an error response is not a download');
    assert.deepEqual(JSON.parse(body), { error: 'could not read the document' });

    // The process is still up, and a second hit on the same file is the same answer, not a restart.
    const health = await api('/api/health');
    assert.equal(health.status, 200);
    assert.equal((await api(`/api/bookings/confirmation/${LOCKED}`, { token })).status, res.status);
    assert.equal((await api('/api/health')).status, 200);
  });

  test('an unreadable album photo (sendFile) also answers an error with no path, and the server keeps answering', async (t) => {
    if (!canLock) return t.skip('this process ignores file modes (root): the unreadable-file precondition cannot be built');
    const res = await api('/api/photos/file/locked.jpg', { token });
    const body = await res.text();
    assert.ok(res.status >= 400 && res.status < 600, `status ${res.status}`);
    assert.doesNotMatch(body, /EACCES|permission denied|uploads|\/trip|open '/i, 'no path or errno text in the body');
    assert.equal((await api('/api/health')).status, 200);
  });

  test('is still behind authentication', async () => {
    assert.equal((await api(`/api/bookings/confirmation/${LOCKED}`)).status, 401);
  });
});
