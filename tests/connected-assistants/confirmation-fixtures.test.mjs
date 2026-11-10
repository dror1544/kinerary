import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { makeConfirmationPdf, startConfirmationFixtureServer, OVERSIZE_BYTES } from './confirmation-fixtures.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('synthetic originals are structurally valid PDFs, with stable duplicate and changed revision', () => {
  const original = makeConfirmationPdf('Example Traveler', 'ABC-123');
  const duplicate = makeConfirmationPdf('Example Traveler', 'ABC-123');
  const revised = makeConfirmationPdf('Example Traveler', 'ABC-124');

  assert.deepEqual(original, duplicate);
  assert.notEqual(digest(original), digest(revised));
  assert.ok(original.subarray(0, 9).toString().startsWith('%PDF-1.4'));
  assert.ok(original.toString().endsWith('%%EOF\n'));

  const text = original.toString('ascii');
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
  assert.ok(Number.isInteger(startxref) && startxref > 0);
  assert.equal(text.slice(startxref, startxref + 5), 'xref\n');
  const entries = [...text.matchAll(/^(\d{10}) 00000 n \n/gm)];
  assert.equal(entries.length, 5);
  entries.forEach(([, offset], index) => {
    assert.equal(text.slice(Number(offset), Number(offset) + 7), `${index + 1} 0 obj`.slice(0, 7));
  });
});

test('fixture HTTP endpoints expose exact bytes and hostile transfer cases', async t => {
  const fixture = await startConfirmationFixtureServer();
  t.after(() => fixture.close());

  const original = await fetch(`${fixture.origin}/original`);
  const duplicate = await fetch(`${fixture.origin}/duplicate`);
  const revised = await fetch(`${fixture.origin}/revised`);
  const wrongMime = await fetch(`${fixture.origin}/wrong-mime`);
  const empty = await fetch(`${fixture.origin}/empty`);
  const oversized = await fetch(`${fixture.origin}/oversized`);
  const redirect = await fetch(`${fixture.origin}/private-redirect`, { redirect: 'manual' });
  const interrupted = await fetch(`${fixture.origin}/interrupted`);
  const retryFirst = await fetch(`${fixture.origin}/retry-once`);
  const retrySecond = await fetch(`${fixture.origin}/retry-once`);

  assert.equal(original.status, 200);
  assert.equal(original.headers.get('content-type'), 'application/pdf');
  assert.equal(original.headers.get('content-disposition'), 'attachment; filename="synthetic-confirmation.pdf"');
  const originalBytes = Buffer.from(await original.arrayBuffer());
  assert.deepEqual(originalBytes, Buffer.from(await duplicate.arrayBuffer()));
  assert.notEqual(digest(originalBytes), digest(Buffer.from(await revised.arrayBuffer())));
  assert.equal(wrongMime.headers.get('content-type'), 'text/plain');
  assert.deepEqual(Buffer.from(await wrongMime.arrayBuffer()), originalBytes);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  assert.equal((await oversized.arrayBuffer()).byteLength, OVERSIZE_BYTES);
  assert.equal(interrupted.status, 200);
  await assert.rejects(interrupted.arrayBuffer());
  assert.equal(retryFirst.status, 503);
  assert.equal(retrySecond.status, 200);
  assert.deepEqual(Buffer.from(await retrySecond.arrayBuffer()), originalBytes);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'http://127.0.0.1:9/private');
  assert.equal((await fetch(`${fixture.origin}/unknown`)).status, 404);
});
