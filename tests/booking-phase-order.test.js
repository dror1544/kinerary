/**
 * booking-phase-order.test.js — regression test for the "Bookings" tab
 * silently dropping any booking whose phase isn't literally one of the
 * original trip's hardcoded ids (nyc/dallas/colorado/west_coast).
 *
 * Real-world trigger: a trip with phases like los-angeles/honolulu/maui had
 * bookings saved and visible via the API, but they never appeared on the
 * site's Bookings tab, because loadBookings() only ever iterated a
 * hardcoded phaseOrder array. Extracts the real loadBookings()/
 * buildBookingRow() source from site/app.js (not a reimplementation) and
 * runs it against a fake fetch + a config with non-legacy phase ids.
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
  if (start === -1 || end === -1) throw new Error('Could not locate loadBookings() region in app.js');
  return src.slice(start, end);
}

function makeContext({ cfg, rows }) {
  const win = new Window({ url: 'http://localhost/' });
  const doc = win.document;
  doc.body.innerHTML = `<div id="bookings-content"></div><button id="bk-add-main"></button>`;

  const ctx = vm.createContext({
    window: Object.assign(win, { TRIP_CONFIG: cfg }),
    document: doc,
    currentLang: 'he',
    T: { he: { th_name: 'הזמנה', th_dates: 'תאריכים', th_passengers: 'נוסעים', th_conf: 'אישור', th_cost: 'עלות', bk_no_bookings: 'אין הזמנות', bk_err_server: 'שגיאה' } },
    localStorage: { getItem: () => null },
    fetch: async () => ({ ok: true, json: async () => rows }),
    console,
  });
  vm.runInContext(extractSource(), ctx, { filename: 'app.js (loadBookings region)' });
  return { document: doc, ctx };
}

const cfg = { phases: [{ id: 'los-angeles' }, { id: 'honolulu' }, { id: 'maui' }] };

const rows = [
  { id: 1, phase: 'los-angeles', type: 'car', name: 'Alamo LA' },
  { id: 2, phase: 'honolulu',    type: 'attraction', name: 'Diamond Head' },
  { id: 3, phase: 'a-removed-phase', type: 'other', name: 'Stale phase booking' },
];

describe('loadBookings() phase grouping', () => {
  test('renders bookings for phases that are in trip.config.json but not the legacy hardcoded set', async () => {
    const { document, ctx } = makeContext({ cfg, rows });
    await ctx.loadBookings();
    const html = document.getElementById('bookings-content').innerHTML;
    assert.ok(html.includes('Alamo LA'), 'los-angeles booking should render');
    assert.ok(html.includes('Diamond Head'), 'honolulu booking should render');
  });

  test('never silently drops a booking whose phase matches no known phase id', async () => {
    const { document, ctx } = makeContext({ cfg, rows });
    await ctx.loadBookings();
    const html = document.getElementById('bookings-content').innerHTML;
    assert.ok(html.includes('Stale phase booking'), 'booking under an unrecognized phase must still render, not vanish');
  });

  test('an empty config still renders every booking (no phases silently excluded)', async () => {
    const { document, ctx } = makeContext({ cfg: {}, rows });
    await ctx.loadBookings();
    const html = document.getElementById('bookings-content').innerHTML;
    for (const b of rows) assert.ok(html.includes(b.name), `${b.name} should render even with no phases configured`);
  });
});
