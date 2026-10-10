/**
 * trip-documents.test.js — the source documents a provisioned trip carries.
 *
 * The provisioner publishes a trip's source documents into TRIP_DIR/documents
 * under content-addressed names, with documents.json beside the config saying
 * what each one supports. These tests hold them to the boundary every other trip
 * document already has: nothing without authentication, nothing outside that
 * directory, nothing listed that is not actually there — and a saved web page is
 * never rendered as a page on the trip's own origin.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, stopTestServer, api, loginAsAlice, testTripDir } from './helpers/server.js';
import { PORTS } from './helpers/ports.js';

let token;

const VOUCHER_TEXT = 'Hotel Gracery Shinjuku - confirmation GR-4471';
const SAVED_PAGE = '<html><body><script>fetch("/api/config")</script>Booking confirmation</body></html>';
const contentName = (content, ext) => `${createHash('sha256').update(content).digest('hex')}.${ext}`;
const VOUCHER = contentName(VOUCHER_TEXT, 'txt');
const PAGE = contentName(SAVED_PAGE, 'html');

// A document published into the trip's NFS directory only — the hard-linked,
// single-copy path — must be listed and served exactly like one beside the config.
const NFS_ONLY_TEXT = 'Hotel Artemide - confirmation HTL-99117';
const NFS_ONLY = contentName(NFS_ONLY_TEXT, 'txt');

before(async () => {
  const nfsDocuments = mkdtempSync(join(tmpdir(), 'trip-nfs-documents-'));
  writeFileSync(join(nfsDocuments, NFS_ONLY), NFS_ONLY_TEXT);
  await startTestServer({ PORT: String(PORTS.tripDocuments), TRIP_DOCUMENTS_DIR: nfsDocuments });
  token = await loginAsAlice();

  const documents = join(testTripDir(), 'documents');
  mkdirSync(documents, { recursive: true });
  writeFileSync(join(documents, VOUCHER), VOUCHER_TEXT);
  writeFileSync(join(documents, PAGE), SAVED_PAGE);
  writeFileSync(join(testTripDir(), 'documents.json'), JSON.stringify([
    { file: NFS_ONLY, filename: 'Artemide.txt', mime: 'text/plain', links: [{ kind: 'phase', id: 'rome' }] },
    {
      file: VOUCHER,
      filename: 'Gracery voucher.txt',
      mime: 'text/plain',
      links: [
        { kind: 'phase', id: 'tokyo' },
        { kind: 'booking', seed_key: 'hotel_tokyo' },
        { kind: 'script', src: 'https://example.invalid/x.js' },
      ],
    },
    { file: PAGE, filename: 'booking.html', mime: 'text/html', links: [] },
    // Named but never published: must not be listed.
    { file: `${'f'.repeat(64)}.pdf`, filename: 'missing.pdf', mime: 'application/pdf', links: [] },
    // Not content-addressed names at all: must never be followed.
    { file: '../trip.config.json', filename: 'config', links: [] },
    { file: 'trip.config.json', filename: 'config', links: [] },
  ]));
});

after(() => stopTestServer());

describe('GET /api/trip-documents', () => {
  test('refuses without authentication', async () => {
    assert.equal((await api('/api/trip-documents')).status, 401);
  });

  test('lists only content-addressed documents that are present, with only the links it understands', async () => {
    const res = await api('/api/trip-documents', { token });
    assert.equal(res.status, 200);
    const docs = await res.json();
    assert.deepEqual(docs.map((d) => d.file).sort(), [NFS_ONLY, PAGE, VOUCHER].sort());

    const voucher = docs.find((d) => d.file === VOUCHER);
    assert.equal(voucher.filename, 'Gracery voucher.txt');
    assert.deepEqual(voucher.links, [
      { kind: 'phase', id: 'tokyo' },
      { kind: 'booking', seed_key: 'hotel_tokyo' },
    ]);
  });
});

describe('a document in the trip NFS directory (TRIP_DOCUMENTS_DIR)', () => {
  test('is served, authenticated, with its own bytes', async () => {
    assert.equal((await api(`/api/bookings/confirmation/${NFS_ONLY}`)).status, 401);
    const res = await api(`/api/bookings/confirmation/${NFS_ONLY}`, { token });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), NFS_ONLY_TEXT);
  });
});

describe('a published source document through the confirmation route', () => {
  test('refuses without authentication', async () => {
    assert.equal((await api(`/api/bookings/confirmation/${VOUCHER}`)).status, 401);
  });

  test('serves the original bytes with a token, privately', async () => {
    const res = await api(`/api/bookings/confirmation/${VOUCHER}`, { token });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), VOUCHER_TEXT);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('a saved web page is a download, never a page on the trip origin', async () => {
    const res = await api(`/api/bookings/confirmation/${PAGE}`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('a path that tries to leave the documents directory reaches nothing', async () => {
    const res = await api(`/api/bookings/confirmation/${encodeURIComponent('../trip.config.json')}`, { token });
    assert.equal(res.status, 404);
  });
});
