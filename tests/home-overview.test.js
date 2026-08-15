/**
 * home-overview.test.js — the Home "Full Overview" anchor list in site/app.js.
 *
 * The overview used to be a table of one row per phase, showing only that
 * phase's accommodation. It's now a merged list of "anchor" events — things
 * that can't be moved once they exist: every phase's accommodation, plus
 * flight/hotel/attraction bookings from /api/bookings (attraction bookings
 * only once they have a fixed date — a dateless attraction is still a loose
 * idea, not an anchor). Each row exposes the same clickable reference badges
 * (confirmation, PDF, wallet, location→Maps) as the Bookings tab.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRenderContext } from './helpers/dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg  = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));

const HTML = `<div id="home-overview"></div>`;

// Everything below mirrors the real implementations that live outside the
// RENDER_FUNS block in site/app.js (shared with the Bookings tab, which
// isn't part of that block) — supplied via extra per createRenderContext's
// documented pattern, same as render.test.js does for renderPhaseHotelCard.
function googleMapsUrl(query) {
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
const TYPE_ICONS = { flight: '✈️', hotel: '🏨', car: '🚗', attraction: '⚡', other: '📌' };
const ANCHOR_TYPES = ['flight', 'hotel', 'attraction'];
const PHASE_LABELS = {};
function bkConfUrls(confFile) {
  if (!confFile) return null;
  return { view: `/confirmations/view/${confFile}`, download: `/confirmations/${confFile}` };
}
function bookingRefBadges(b) {
  const urls = bkConfUrls(b.conf_file);
  const pdfLink = urls ? `<span class="conf-pdf-pair"><a class="conf-pdf" href="${urls.view}">👁</a></span>` : '';
  const confBadge = b.confirmation ? `<span class="conf">${b.confirmation}</span>` : '';
  const locationBadge = b.location_url ? `<a class="loc" href="${b.location_url}" title="Location">📍</a>` : '';
  return `${confBadge}${pdfLink}${locationBadge}`;
}
const EXTRA = { googleMapsUrl, TYPE_ICONS, ANCHOR_TYPES, PHASE_LABELS, bkConfUrls, bookingRefBadges };

describe('accommodationAnchors()', () => {
  test('builds one hotel anchor per phase with an accommodation field', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    const anchors = ctx.accommodationAnchors(cfg);
    assert.equal(anchors.length, 2, 'fixture has 2 phases, both with accommodation');
    assert.ok(anchors.every(a => a.type === 'hotel'));
  });

  test('carries the raw phase id, for matching against a hotel booking on the same phase', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    const [ny] = ctx.accommodationAnchors(cfg);
    assert.equal(ny.phaseId, 'ny');
  });

  test('falls back to a Maps search link built from address when no mapsUrl is authored', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    const [ny] = ctx.accommodationAnchors(cfg);
    assert.ok(!cfg.phases[0].accommodation.mapsUrl, 'fixture hotel has no mapsUrl (matches a still-TBD real hotel)');
    assert.equal(ny.location_url, googleMapsUrl(cfg.phases[0].accommodation.address));
  });

  test('uses the phase dates as the anchor date range', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    const [ny] = ctx.accommodationAnchors(cfg);
    assert.equal(ny.date_from, '2027-03-11');
    assert.equal(ny.date_to, '2027-03-14');
  });
});

describe('isAnchorBooking()', () => {
  test('flight and hotel bookings are always anchors', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    assert.equal(ctx.isAnchorBooking({ type: 'flight' }), true);
    assert.equal(ctx.isAnchorBooking({ type: 'hotel' }), true);
  });

  test('an attraction with no date is not an anchor yet', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    assert.equal(ctx.isAnchorBooking({ type: 'attraction', name: 'maybe teamLab' }), false);
  });

  test('an attraction with a fixed date is an anchor', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    assert.equal(ctx.isAnchorBooking({ type: 'attraction', date_from: '2027-03-12' }), true);
  });

  test('car and other bookings are never anchors, dated or not', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    assert.equal(ctx.isAnchorBooking({ type: 'car', date_from: '2027-03-12' }), false);
    assert.equal(ctx.isAnchorBooking({ type: 'other', date_from: '2027-03-12' }), false);
  });

  test('a cancelled booking (❌-prefixed name, the Bookings tab convention) is never an anchor', () => {
    const { ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    assert.equal(ctx.isAnchorBooking({ type: 'flight', name: '❌ TLV → JFK', date_from: '2027-03-10' }), false);
    assert.equal(ctx.isAnchorBooking({ type: 'hotel', name: '❌ Hotel Meridian' }), false);
  });
});

describe('renderHomeOverview()', () => {
  test('renders one row per anchor, sorted by date', () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    const anchors = [
      { type: 'flight', name: 'TLV → JFK', date_from: '2027-03-10', phaseLabel: '✈️' },
      { type: 'hotel',  name: 'Hotel Meridian', date_from: '2027-03-11', phaseLabel: '🗽 New York' },
    ];
    ctx.renderHomeOverview(cfg, anchors.slice().reverse()); // fed out of order on purpose
    const rows = [...document.querySelectorAll('#home-overview tr')].slice(1); // skip header
    assert.equal(rows.length, 2);
    assert.ok(rows[0].innerHTML.includes('TLV'), 'earlier date should sort first');
    assert.ok(rows[1].innerHTML.includes('Meridian'));
  });

  test('shows a location badge linking to the anchor location_url', () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    ctx.renderHomeOverview(cfg, [
      { type: 'hotel', name: 'Hotel Meridian', date_from: '2027-03-11', phaseLabel: '🗽', location_url: 'https://maps.example/x' },
    ]);
    const html = document.getElementById('home-overview').innerHTML;
    assert.ok(html.includes('href="https://maps.example/x"'), 'location badge should link to the Maps URL');
  });

  test('an empty anchor list renders without crashing', () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    ctx.renderHomeOverview(cfg, []);
    assert.ok(document.getElementById('home-overview').querySelector('table'));
  });

  test('escapes an XSS payload in an anchor name (esc() is real, part of the RENDER_FUNS block)', () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', EXTRA);
    ctx.renderHomeOverview(cfg, [
      { type: 'attraction', name: '<img src=x onerror=alert(1)>', date_from: '2027-03-12', phaseLabel: '🗽' },
    ]);
    const el = document.getElementById('home-overview');
    // Check the parsed DOM structure, not the serialized .innerHTML string —
    // happy-dom's innerHTML getter doesn't re-escape text-node content on
    // the way out (a known quirk), so a round-tripped string check would be
    // a false positive/negative either way. What actually matters for XSS is
    // whether a live <img> element exists to fire onerror; it must not.
    assert.equal(el.querySelectorAll('img').length, 0, 'no live <img> element should be created from the payload');
    assert.ok(el.textContent.includes('<img src=x onerror=alert(1)>'), 'the payload should still be visible as inert text');
  });
});

describe('loadHomeOverview()', () => {
  test('merges accommodation anchors with anchor-eligible bookings from /api/bookings', async () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', {
      ...EXTRA,
      localStorage: { getItem: () => null },
      fetch: async () => ({
        ok: true,
        json: async () => [
          { id: 1, phase: 'ny', type: 'flight', name: 'TLV → JFK', date_from: '2027-03-10' },
          { id: 2, phase: 'ny', type: 'attraction', name: 'Undated idea' }, // no date_from — not an anchor
        ],
      }),
    });
    await ctx.loadHomeOverview(cfg);
    const html = document.getElementById('home-overview').innerHTML;
    assert.ok(html.includes('TLV'), 'dated flight booking should appear as an anchor');
    assert.ok(!html.includes('Undated idea'), 'dateless attraction should not appear as an anchor');
    assert.ok(html.includes('Meridian') || html.includes('מרידיאן'), 'phase accommodation should still appear');
  });

  test('renders accommodation-only anchors if the bookings fetch fails', async () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', {
      ...EXTRA,
      localStorage: { getItem: () => null },
      fetch: async () => { throw new Error('network down'); },
    });
    await ctx.loadHomeOverview(cfg);
    const html = document.getElementById('home-overview').innerHTML;
    assert.ok(html.includes('Meridian') || html.includes('מרידיאן'), 'hotel anchors should still render');
  });

  test('a real hotel booking on a phase replaces that phase\'s accommodation placeholder, not duplicates it', async () => {
    const { document, ctx } = createRenderContext(HTML, cfg, 'he', {
      ...EXTRA,
      localStorage: { getItem: () => null },
      fetch: async () => ({
        ok: true,
        json: async () => [
          { id: 1, phase: 'ny', type: 'hotel', name: 'Hotel Meridian (confirmed)', date_from: '2027-03-11', confirmation: 'RES-1' },
        ],
      }),
    });
    await ctx.loadHomeOverview(cfg);
    const rows = [...document.querySelectorAll('#home-overview tr')].slice(1);
    // Fixture has 2 phases with accommodation (ny, colorado); only ny has a
    // booking. Correct total is 2 rows: ny's booking (deduped against its
    // accommodation placeholder) + colorado's untouched placeholder — not 3.
    assert.equal(rows.length, 2, 'ny should contribute one row (the booking), not both the booking and its accommodation placeholder');
    const nyRow = rows.find(r => r.innerHTML.includes('confirmed'));
    assert.ok(nyRow, 'the real booking record should win over the accommodation placeholder');
    assert.ok(!document.getElementById('home-overview').innerHTML.includes('מרידיאן'), 'the bare accommodation-name placeholder for ny should not also appear');
    // colorado has no booking, so its accommodation placeholder is untouched
    assert.ok(document.getElementById('home-overview').innerHTML.includes('Alpine') || document.getElementById('home-overview').innerHTML.includes('אלפים'));
  });
});
