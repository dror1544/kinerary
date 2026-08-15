/**
 * booking-xss.test.js — bookingRefBadges()/buildBookingRow() must escape
 * booking-controlled text and reject non-http(s) URLs before they reach
 * innerHTML.
 *
 * Any authenticated participant can set a booking's name/confirmation/
 * location_url/google_wallet_url via the booking form (POST /api/bookings
 * only requires phase/type/name). Both functions render straight into
 * innerHTML, so an unescaped value is stored XSS for every visitor of the
 * Bookings tab or the Home "Full Overview". Extracts the real source from
 * site/app.js (not a reimplementation), same technique as
 * booking-phase-order.test.js.
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
  const start = src.indexOf('const TYPE_ICONS');
  const end = src.indexOf('async function loadPhaseBookings');
  if (start === -1 || end === -1) throw new Error('Could not locate booking-row region in app.js');
  return src.slice(start, end);
}

function makeContext() {
  const win = new Window({ url: 'http://localhost/' });
  const ctx = vm.createContext({ window: win, document: win.document, console });
  vm.runInContext(extractSource(), ctx, { filename: 'app.js (booking-row region)' });
  return ctx;
}

describe('bookingRefBadges() — escaping and URL sanitization', () => {
  test('escapes an XSS payload in confirmation', () => {
    const ctx = makeContext();
    const html = ctx.bookingRefBadges({ confirmation: '<img src=x onerror=alert(1)>' });
    assert.ok(!html.includes('<img'), 'raw <img> tag must not appear');
    assert.ok(html.includes('&lt;img'), 'should be HTML-escaped');
  });

  test('drops a javascript: location_url instead of rendering it', () => {
    const ctx = makeContext();
    const html = ctx.bookingRefBadges({ location_url: 'javascript:alert(1)' });
    assert.ok(!html.includes('javascript:'), 'javascript: URL must not reach an href');
    assert.ok(!html.includes('<a'), 'no location badge should render at all for an unsafe URL');
  });

  test('drops a javascript: google_wallet_url instead of rendering it', () => {
    const ctx = makeContext();
    const html = ctx.bookingRefBadges({ google_wallet_url: 'javascript:alert(1)' });
    assert.ok(!html.includes('javascript:'));
  });

  test('passes through a real https location_url unchanged', () => {
    const ctx = makeContext();
    const html = ctx.bookingRefBadges({ location_url: 'https://maps.example/x' });
    assert.ok(html.includes('href="https://maps.example/x"'));
  });

  test('a pkpass_file with a quote cannot break out of the wallet-badge href attribute', () => {
    const ctx = makeContext();
    const html = ctx.bookingRefBadges({ pkpass_file: '"><script>alert(1)</script>' });
    assert.ok(!html.includes('<script>'), 'must not produce a live <script> tag');
  });

  test('a location_url with an embedded quote cannot break out of the href attribute', () => {
    const ctx = makeContext();
    // Passes the http(s)-scheme check, but the raw quote would otherwise
    // close the href="..." attribute early and let the rest become new
    // attributes on the <a> tag.
    const html = ctx.bookingRefBadges({ location_url: 'https://maps.example/" autofocus onfocus="alert(1)' });
    assert.ok(!html.includes('" autofocus'), 'the quote must be escaped, not left to close the href attribute');
    assert.ok(html.includes('href="https://maps.example/&quot;'), 'the quote should appear HTML-escaped inside the attribute');
  });

  test('a google_wallet_url with an embedded quote cannot break out of the href attribute', () => {
    const ctx = makeContext();
    const html = ctx.bookingRefBadges({ google_wallet_url: 'https://wallet.example/" onmouseover="alert(1)' });
    assert.ok(!html.includes('" onmouseover'), 'the quote must be escaped, not left to close the href attribute');
  });
});

describe('buildBookingRow() — escaping', () => {
  test('escapes an XSS payload in the booking name', () => {
    const ctx = makeContext();
    const html = ctx.buildBookingRow({ type: 'flight', name: '<script>alert(1)</script>' }, false);
    assert.ok(!html.includes('<script>alert'), 'raw <script> tag must not appear');
    assert.ok(html.includes('&lt;script&gt;'), 'name should be HTML-escaped');
  });

  test('a normal name still renders visibly (escaping is not over-aggressive)', () => {
    const ctx = makeContext();
    const html = ctx.buildBookingRow({ type: 'flight', name: 'TLV → JFK' }, false);
    assert.ok(html.includes('TLV'));
  });

  test('escapes an XSS payload in date_from (accepted by the API with no format validation)', () => {
    const ctx = makeContext();
    const html = ctx.buildBookingRow({ type: 'flight', name: 'ok', date_from: '<img src=x onerror=alert(1)>' }, false);
    assert.ok(!html.includes('<img'), 'raw <img> tag must not appear');
    assert.ok(html.includes('&lt;img'), 'date_from should be HTML-escaped');
  });
});
