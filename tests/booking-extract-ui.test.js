/**
 * booking-extract-ui.test.js — extractBookingWithAI() and showBookingForm()
 * in site/app.js.
 *
 * UX fixes verified here, against the real function source (not a
 * reimplementation):
 *  1. A loading indicator (spinner + "may take a few seconds" copy) shows
 *     while the request is in flight — extraction can take 10-30+ seconds.
 *  2. The same PDF already uploaded for extraction is carried over into the
 *     "Attach PDF confirmation" file input, instead of silently discarding
 *     it and making the user pick the identical file a second time.
 *  3. Reopening the Add Booking form (new or edit) resets the extraction
 *     status line — it used to leave a previous attempt's message and
 *     color (e.g. a stale green "✓ Details extracted") showing for an
 *     entirely unrelated booking.
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
  const end = src.indexOf('function hideBookingForm');
  if (start === -1 || end === -1) throw new Error('Could not locate extractBookingWithAI()/showBookingForm() in app.js');
  return src.slice(start, end);
}

const FORM_HTML = `
  <div id="bk-extract-section">
    <input id="bk-extract-url" value="">
    <input id="bk-extract-file" type="file">
    <button id="bk-extract-btn"></button>
    <p id="bk-extract-status"></p>
  </div>
  <input id="bk-id" type="hidden">
  <h2 id="bk-form-title"></h2>
  <div id="bk-overlay" style="display:none"></div>
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
  <input id="bk-google-wallet">
  <input id="bk-location-url">
  <input id="bk-file" type="file">
  <input id="bk-pkpass-file" type="file">
  <p id="bk-err"></p>
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
    T: { en: { bk_extract_loading: 'Extracting details... this may take a few seconds', bk_extract_success: 'Details extracted', bk_extract_error: 'Extraction failed', bk_form_title: 'Add Booking', bk_form_edit: 'Edit Booking' } },
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

describe('showBookingForm() resets the extraction section', () => {
  test('clears a leftover success message and its color when reopening for a new booking', () => {
    const { document, ctx } = makeContext({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
    const statusEl = document.getElementById('bk-extract-status');
    // Simulate what a previous, unrelated extraction left behind.
    statusEl.textContent = '✓ Details extracted — review and save';
    statusEl.style.color = 'rgb(22, 163, 74)';
    document.getElementById('bk-extract-url').value = 'https://example.com/old';
    setFile(document, 'bk-extract-file', 'old.pdf');

    ctx.showBookingForm('intl_flights', null);

    assert.equal(statusEl.textContent, '', 'stale extraction message must be cleared on reopen');
    assert.equal(statusEl.style.color, '', 'stale (green) color must be cleared on reopen');
    assert.equal(document.getElementById('bk-extract-url').value, '');
  });

  test('also clears it when reopening to edit an existing booking', () => {
    const { document, ctx } = makeContext({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
    const statusEl = document.getElementById('bk-extract-status');
    statusEl.textContent = 'Extraction failed: boom';
    statusEl.style.color = 'rgb(200, 0, 0)';

    ctx.showBookingForm('intl_flights', { id: 5, name: 'Existing booking', type: 'hotel' });

    assert.equal(statusEl.textContent, '');
    assert.equal(statusEl.style.color, '');
  });
});
