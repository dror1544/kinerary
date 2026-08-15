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
});
