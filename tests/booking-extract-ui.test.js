/**
 * booking-extract-ui.test.js — extractBookingWithAI() in site/app.js.
 *
 * Two UX fixes verified here, against the real function source (not a
 * reimplementation):
 *  1. A loading indicator (spinner + "may take a few seconds" copy) shows
 *     while the request is in flight — extraction can take 10-30+ seconds.
 *  2. The same PDF already uploaded for extraction is carried over into the
 *     "Attach PDF confirmation" file input, instead of silently discarding
 *     it and making the user pick the identical file a second time.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { Window } from 'happy-dom';

const HERE   = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'site', 'app.js');

function extractSource() {
  const src = readFileSync(APP_JS, 'utf8');
  const start = src.indexOf('async function extractBookingWithAI');
  const end = src.indexOf('function showBookingForm');
  if (start === -1 || end === -1) throw new Error('Could not locate extractBookingWithAI() in app.js');
  return src.slice(start, end);
}

const FORM_HTML = `
  <div id="bk-extract-section">
    <input id="bk-extract-url" value="">
    <input id="bk-extract-file" type="file">
    <button id="bk-extract-btn"></button>
    <p id="bk-extract-status"></p>
  </div>
  <select id="bk-phase"></select>
  <select id="bk-type"></select>
  <input id="bk-name">
  <input id="bk-date-from">
  <input id="bk-date-to">
  <input id="bk-passengers">
  <input id="bk-conf">
  <input id="bk-pin">
  <input id="bk-cost">
  <textarea id="bk-notes"></textarea>
  <input id="bk-location-url">
  <input id="bk-file" type="file">
`;

function makeContext({ fetchImpl }) {
  const win = new Window({ url: 'http://localhost/' });
  const doc = win.document;
  doc.body.innerHTML = FORM_HTML;

  const ctx = vm.createContext({
    window: win,
    document: doc,
    File: win.File,
    DataTransfer: win.DataTransfer,
    FileReader: win.FileReader,
    currentLang: 'en',
    T: { en: { bk_extract_loading: 'Extracting details... this may take a few seconds', bk_extract_success: 'Details extracted', bk_extract_error: 'Extraction failed' } },
    localStorage: { getItem: () => 'fake-token' },
    fetch: fetchImpl,
    console,
  });
  vm.runInContext(extractSource(), ctx, { filename: 'app.js (extractBookingWithAI)' });
  return { document: doc, ctx };
}

function setFile(doc, inputId, filename) {
  const dt = new doc.defaultView.DataTransfer();
  dt.items.add(new doc.defaultView.File(['%PDF-1.4 fake content'], filename, { type: 'application/pdf' }));
  doc.getElementById(inputId).files = dt.files;
}

describe('extractBookingWithAI()', () => {
  test('shows a spinner and "may take a few seconds" copy while in flight', async () => {
    let sawSpinnerWhileInFlight = false;
    const { document, ctx } = makeContext({
      fetchImpl: async () => {
        const statusHtml = document.getElementById('bk-extract-status').innerHTML;
        sawSpinnerWhileInFlight = statusHtml.includes('inline-spinner') && statusHtml.includes('may take a few seconds');
        return { ok: true, json: async () => ({ name: 'Test Hotel' }) };
      },
    });
    setFile(document, 'bk-extract-file', 'confirmation.pdf');
    await ctx.extractBookingWithAI();
    assert.ok(sawSpinnerWhileInFlight, 'expected spinner + "may take a few seconds" text while the request was in flight');
  });

  test('carries the same uploaded PDF over to the confirmation-attachment input on success', async () => {
    const { document, ctx } = makeContext({
      fetchImpl: async () => ({ ok: true, json: async () => ({ name: 'Test Hotel', type: 'hotel' }) }),
    });
    setFile(document, 'bk-extract-file', 'confirmation.pdf');
    await ctx.extractBookingWithAI();

    const confFile = document.getElementById('bk-file').files[0];
    assert.ok(confFile, 'the confirmation-attachment input should now have a file, without the user picking one');
    assert.equal(confFile.name, 'confirmation.pdf');
  });

  test('does not touch the confirmation-attachment input when extracting from a URL instead of a file', async () => {
    const { document, ctx } = makeContext({
      fetchImpl: async () => ({ ok: true, json: async () => ({ name: 'Test Hotel' }) }),
    });
    document.getElementById('bk-extract-url').value = 'https://example.com/booking';
    await ctx.extractBookingWithAI();
    assert.equal(document.getElementById('bk-file').files.length, 0);
  });

  test('on failure, does not touch the confirmation-attachment input either', async () => {
    const { document, ctx } = makeContext({
      fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'boom' }) }),
    });
    setFile(document, 'bk-extract-file', 'confirmation.pdf');
    await ctx.extractBookingWithAI();
    assert.equal(document.getElementById('bk-file').files.length, 0);
    assert.match(document.getElementById('bk-extract-status').textContent, /boom/);
  });
});
