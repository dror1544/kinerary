/**
 * stop-xss-render.test.js — the Classic site renders a stop's text as TEXT.
 *
 * Boundary review 2026-10-11, finding 1: a stop's title, tab label, emoji and
 * accommodation reach /api/config, and the Classic renderer (site/app.js, the
 * default design variant) built HTML from them without escaping — the side
 * menu, the phase section heading, the home phase cards, the hotel card
 * (name, address, phone link, Maps/Waze links, description), the photo upload
 * grid, the overview labels, the map popups and the weather panel. The server
 * now refuses such text at the write, but a value that is already stored, or
 * hand-authored in trip.config.json, still reaches the renderer — so every
 * sink is escaped there too. Each test plants the hostile value and asserts
 * no element or handler came out of it, and that the text is still shown.
 *
 * Real source from site/app.js, extracted by name (not reimplemented), the
 * same technique as tests/helpers/dom.js and booking-xss.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { Window } from 'happy-dom';
import { createRenderContext } from './helpers/dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'site', 'app.js'), 'utf8');
const XSS = '<img src=x onerror=alert(1)>';
const QUOTE = '"><svg onload=alert(2)>';

function extractFunction(name) {
  const start = SRC.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start === -1) throw new Error(`Could not locate function ${name}() in app.js`);
  const end = SRC.indexOf('\n}\n', start) + 3;
  return SRC.slice(start, end);
}

// A sandbox holding only the named functions, plus whatever globals they read.
function sandbox(names, globals = {}, html = '') {
  const win = new Window({ url: 'http://localhost/' });
  win.document.body.innerHTML = html;
  const ctx = vm.createContext({ window: win, document: win.document, console, ...globals });
  vm.runInContext(names.map(extractFunction).join('\n'), ctx, { filename: 'app.js (extracted)' });
  return { ctx, document: win.document };
}

// No element and no handler attribute came out of the planted text, and every
// link is one a browser will not run.
function assertInert(root, { allowHandlers = [] } = {}) {
  assert.equal(root.querySelectorAll('img, svg, script, iframe, b, u').length, 0, root.innerHTML);
  for (const el of root.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(attr) || allowHandlers.includes(attr), `${el.tagName} carries ${attr}: ${el.outerHTML}`);
    }
  }
  for (const a of root.querySelectorAll('a[href]')) assert.match(a.getAttribute('href'), /^(https?:|tel:|#)/, a.outerHTML);
}

const hostilePhase = () => ({
  id: 'colmar',
  title: { he: XSS, en: QUOTE },
  tabLabel: '<b>TAB</b>',
  emoji: '<u>e</u>',
  dates: { start: '2026-12-02', end: '2026-12-07', display: '<b>2–7</b>' },
  accommodation: {
    type: 'hotel', name: { he: XSS, en: QUOTE }, address: XSS, phone: '"><img src=x onerror=alert(3)>',
    confirmation: XSS, cost: '<b>1</b>', guests: '<b>4</b>', rooms: '<b>2</b>', dates: { he: XSS, en: XSS },
    description: { he: XSS, en: QUOTE }, notes: [{ text: { he: XSS, en: XSS } }],
    maps: 'https://maps.example/x"onmouseover="alert(4)', waze: 'javascript:alert(5)',
    weatherKey: "x');alert(6);//",
  },
});

const googleMapsUrl = (q) => (q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null);
// Globals the render functions read from outside the RENDER_FUNS region.
const RENDER_EXTRAS = { googleMapsUrl, bkConfUrls: () => null, bkEsc: (s) => String(s ?? ''), ANCHOR_TYPES: ['flight', 'hotel', 'attraction'], PHASE_LABELS: {} };

describe('Classic render functions escape stop text (RENDER_FUNS region)', () => {
  test('renderPhaseHotelCard: name, address, phone, description, dates, notes, confirmation, links, weather key', () => {
    const phase = hostilePhase();
    const { document, ctx } = createRenderContext('<div id="hotel-colmar"></div>', { phases: [phase] }, 'en', RENDER_EXTRAS);
    ctx.renderPhaseHotelCard(phase);
    const el = document.getElementById('hotel-colmar');
    assert.ok(el.querySelector('.hotel-card'), 'the card still renders');
    assertInert(el);
    assert.ok(!el.querySelector('a[href^="javascript:"]'), 'the javascript: Waze link is dropped, not rendered');
    assert.ok(!el.querySelector('button[onclick]'), 'a weather key that is not a plain token gets no inline handler');
    const maps = el.querySelector('a.btn[href^="https://maps.example"]');
    assert.equal(maps?.getAttribute('href'), 'https://maps.example/x"onmouseover="alert(4)', 'the quote stays inside the href');
    assert.ok(el.textContent.includes(XSS), 'the stored text is still shown, as text');
  });

  test('renderPhaseHotelCard: an ordinary hotel renders as before — Maps, Waze, weather and phone', () => {
    const phase = { id: 'ny', accommodation: { type: 'hotel', name: { he: 'מלון', en: 'Hotel & Spa' }, address: '1 Main St', phone: '+1 212 555 0100',
      maps: 'https://maps.example/?q=a&b=c', waze: 'https://waze.com/ul?ll=1,2&navigate=yes', weatherKey: 'nyc_1' } };
    const { document, ctx } = createRenderContext('<div id="hotel-ny"></div>', { phases: [phase] }, 'en', RENDER_EXTRAS);
    ctx.renderPhaseHotelCard(phase);
    const el = document.getElementById('hotel-ny');
    assert.equal(el.querySelector('a[href^="https://maps"]').getAttribute('href'), 'https://maps.example/?q=a&b=c');
    assert.equal(el.querySelector('a[href^="https://waze"]').getAttribute('href'), 'https://waze.com/ul?ll=1,2&navigate=yes');
    assert.equal(el.querySelector('a[href^="tel:"]').getAttribute('href'), 'tel:+1 212 555 0100');
    assert.equal(el.querySelector('button[onclick]').getAttribute('onclick'), "loadWx('nyc_1')");
    assert.ok(el.querySelector('#wx-nyc_1'));
    assert.ok(el.querySelector('h4').textContent.includes('Hotel & Spa'), 'an & in a name looks the same');
  });

  test('renderHomePhases, renderPhotoUploads and the overview labels: title, tab label, emoji, display dates', () => {
    const cfg = { phases: [hostilePhase(), { id: 'plain', title: { he: 'רוק & רול', en: 'Rock & Roll' }, tabLabel: 'R&R' }] };
    const html = '<div id="home-phases"></div><div id="photo-uploads"></div><div id="labels"></div>';
    const { document, ctx } = createRenderContext(html, cfg, 'en', RENDER_EXTRAS);
    ctx.renderHomePhases(cfg);
    ctx.renderPhotoUploads(cfg);
    document.getElementById('labels').innerHTML = ctx.accommodationAnchors(cfg).map(a => a.phaseLabel).join('|')
      + ctx.bookingAnchors(cfg, [{ type: 'hotel', name: 'x', phase: 'colmar' }]).map(a => a.phaseLabel).join('|');
    assertInert(document.body, { allowHandlers: ['onchange'] });
    assert.ok(document.getElementById('home-phases').textContent.includes(XSS));
    assert.ok(document.getElementById('home-phases').textContent.includes('Rock & Roll'), 'an & in a title looks the same');
    assert.equal(document.getElementById('labels').querySelectorAll('.lang-en').length, 2);
  });
});

describe('Classic functions outside the render region escape stop text too', () => {
  test('buildPhaseNav: the side menu and the phase section heading', () => {
    const html = '<nav class="topnav"><a data-tab="mapview">MAP</a></nav><div id="sm-phase-links"></div><section id="bookings"></section>';
    const { ctx, document } = sandbox(['buildPhaseNav', 'esc'], { switchTab: () => {} }, html);
    ctx.buildPhaseNav({ phases: [hostilePhase()] });
    assertInert(document.body);
    assert.equal(document.querySelector('#sm-phase-links a').getAttribute('data-tab'), 'colmar');
    assert.ok(document.getElementById('sm-phase-links').textContent.includes(XSS));
    assert.ok(document.querySelector('#colmar h2').textContent.includes(QUOTE));
    assert.equal(document.querySelector('.topnav a[data-tab="colmar"]').textContent, '<b>TAB</b>', 'the tab label was always text');
  });

  test('buildMapPopup: stop name, dates, hotel, confirmation and emoji', () => {
    const { ctx, document } = sandbox(['buildMapPopup', 'esc']);
    const popup = ctx.buildMapPopup({ emoji: '<u>e</u>', name_he: XSS, name_en: QUOTE, dates: XSS, hotel: XSS, conf: XSS }, 'en');
    const div = document.createElement('div');
    div.innerHTML = popup;
    assertInert(div);
    assert.ok(div.textContent.includes(QUOTE) && div.textContent.includes(XSS));
  });

  test('loadWx: the weather panel names the stop as text', async () => {
    const T = { en: { wx_loading: '…', wx_forecast: 'Forecast', wx_error: 'error' } };
    const daily = { time: ['2026-12-02'], weathercode: [0], temperature_2m_max: [5], temperature_2m_min: [1] };
    const { ctx, document } = sandbox(['loadWx', 'esc'], {
      T, currentLang: 'en', WX_LOCS: { k: { name: XSS, lat: 1, lng: 2 } },
      fetch: async () => ({ json: async () => ({ daily }) }), wxIcon: () => '☀', dayName: () => 'Wed',
    }, '<div id="wx-k" style="display:none"></div>');
    await ctx.loadWx('k');
    const el = document.getElementById('wx-k');
    assert.ok(el.dataset.loaded, el.innerHTML);
    assertInert(el);
    assert.ok(el.textContent.includes(XSS));
  });
});

// ── A " or ' in stop text (owner decision 2026-10-11) ──────────────────────
// The write stores a `"` and a `'` exactly as typed (ארה"ב, ת"א, 55" TV): only
// `<`, `>` and control characters are refused. So every Classic sink that puts
// stop text in HTML has to keep a quote inside its attribute. These are the
// values that would leave one if a sink did not escape quotes, run through
// every sink above PLUS each attribute sink a stop field reaches:
//   - renderPhaseHotelCard: href="tel:<phone>"; href="<Maps>" built from the
//     address (googleMapsUrl, encodeURIComponent then esc); href="<Waze>";
//   - renderHomeOverview → bookingRefBadges: the 📍 href built from the
//     accommodation's address, and the confirmation badge.
// No other attribute carries stop text: data-tab / id / data-phase hold the
// stop id (STOP_ID_RE: lowercase letters, digits, dashes), the only inline
// handler left (loadWx) takes a weather key that must match
// /^[A-Za-z0-9_-]+$/ — the photo upload's phase id reaches uploadPhotos as a
// data- attribute since the third review (runDataAction) — and the countdown's
// aria-label/title are translation strings.
const QUOTED = [
  'x" onmouseover="alert(1)',
  "' autofocus onfocus='alert(1)",
  'ת"א onmouseover=alert(1)',
  'ארה"ב',
  `"' onload="alert(1)" '`,
];

// Nothing came out of the planted text: no element, no handler, no autofocus,
// no attribute whose NAME is a fragment of the value.
function assertQuoteInert(root, { allowHandlers = [] } = {}) {
  assert.equal(root.querySelectorAll('img, svg, script, iframe, b, u').length, 0, root.innerHTML);
  for (const el of root.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(attr) || allowHandlers.includes(attr), `${el.tagName} carries ${attr}: ${el.outerHTML}`);
      assert.ok(!/autofocus|alert|["'=()]/i.test(attr), `${el.tagName} grew an attribute named ${attr}: ${el.outerHTML}`);
    }
  }
  for (const a of root.querySelectorAll('a[href]')) assert.match(a.getAttribute('href'), /^(https?:|tel:|#)/, a.outerHTML);
}

const quotedPhase = (v) => ({
  id: 'colmar',
  title: { he: v, en: v },
  tabLabel: v,
  emoji: v,
  dates: { start: '2026-12-02', end: '2026-12-07' },
  accommodation: {
    type: 'hotel', name: { he: v, en: v }, address: v, phone: v, confirmation: v, cost: v, guests: v, rooms: v,
    dates: { he: v, en: v }, description: { he: v, en: v }, waze: 'https://waze.com/ul?ll=1,2&navigate=yes',
  },
});
const mapsFor = (v) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}`;

describe('the escapers every stop sink uses turn both quotes into entities', () => {
  const { ctx } = sandbox(['esc', 'escapeHtml', 'bkEsc']);
  for (const name of ['esc', 'escapeHtml', 'bkEsc']) {
    test(name, () => {
      assert.equal(ctx[name](`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
      assert.equal(ctx[name]('ת"א'), 'ת&quot;א');
    });
  }
});

describe('Classic: a stored " or \' in stop text stays text — element text and attributes', () => {
  for (const v of QUOTED) {
    test(`renderPhaseHotelCard: ${JSON.stringify(v)} in name, address, phone (tel: href), Maps href, confirmation, dates, description`, () => {
      const phase = quotedPhase(v);
      const { document, ctx } = createRenderContext('<div id="hotel-colmar"></div>', { phases: [phase] }, 'en', RENDER_EXTRAS);
      ctx.renderPhaseHotelCard(phase);
      const el = document.getElementById('hotel-colmar');
      assertQuoteInert(el);
      assert.equal(el.querySelector('h4 .lang-he').textContent, v);
      assert.equal(el.querySelector('h4 .lang-en').textContent, v);
      assert.equal(el.querySelector('a[href^="tel:"]').getAttribute('href'), `tel:${v}`, 'the phone stays inside its href');
      assert.equal(el.querySelector('a[href^="tel:"]').textContent, v);
      assert.equal(el.querySelector('a[href^="https://www.google.com/maps"]').getAttribute('href'), mapsFor(v), 'the address stays inside the Maps href');
      assert.equal(el.querySelector('a[href^="https://waze"]').getAttribute('href'), 'https://waze.com/ul?ll=1,2&navigate=yes', 'a clean link is unchanged');
      assert.equal(el.querySelector('.tag.g strong').textContent, v, 'the confirmation');
      assert.ok(el.querySelector('.hotel-card > p').textContent.startsWith(v), 'the address line');
      assert.equal(el.querySelector('.hotel-card > p + p .lang-en').textContent, v, 'the description');
      assert.equal(el.querySelectorAll('.tag')[0].querySelector('.lang-en').textContent, v, 'the accommodation dates');
    });

    test(`renderHomePhases, renderPhotoUploads, overview labels and renderHomeOverview: ${JSON.stringify(v)}`, () => {
      const phase = quotedPhase(v);
      const cfg = { phases: [phase] };
      const html = '<div id="home-phases"></div><div id="photo-uploads"></div><div id="labels"></div><div id="home-overview"></div>';
      const { document, ctx } = createRenderContext(html, cfg, 'en', { ...RENDER_EXTRAS, TYPE_ICONS: { hotel: 'H' } });
      // The real badge builder and its escapers, not RENDER_EXTRAS' stand-ins.
      vm.runInContext(['bkEsc', 'bkSafeUrl', 'bkConfUrls', 'bookingRefBadges'].map(extractFunction).join('\n'), ctx);
      ctx.renderHomePhases(cfg);
      ctx.renderPhotoUploads(cfg);
      document.getElementById('labels').innerHTML = ctx.accommodationAnchors(cfg).map(a => a.phaseLabel).join('|');
      const booking = { type: 'hotel', name: v, phase: 'colmar', date_from: '2026-12-02', confirmation: v, location_url: 'https://maps.example/b' };
      ctx.renderHomeOverview(cfg, [...ctx.accommodationAnchors(cfg), ...ctx.bookingAnchors(cfg, [booking])]);
      assertQuoteInert(document.body, { allowHandlers: ['onchange'] });
      assert.equal(document.querySelector('#home-phases .ph-place .lang-en').textContent, v);
      assert.ok(document.querySelector('#home-phases .ph-place').firstChild.textContent.trim().startsWith(v), 'the emoji');
      assert.equal(document.querySelector('#photo-uploads h4 .lang-he').textContent, v);
      assert.equal(document.getElementById('labels').querySelector('.lang-en').textContent, v);
      const overview = document.getElementById('home-overview');
      const rows = overview.querySelectorAll('tr');
      assert.equal(rows.length, 3, 'header + the stop\'s own hotel + the booking');
      for (const row of [rows[1], rows[2]]) {
        assert.ok(row.children[1].textContent.endsWith(v), 'the hotel name');
        assert.equal(row.children[2].querySelector('.lang-en').textContent, v, 'the stop label');
        assert.equal(row.querySelector('.conf').textContent, v, 'the confirmation badge');
      }
      assert.deepEqual([...overview.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).sort(), [mapsFor(v), 'https://maps.example/b'].sort(),
        'the 📍 hrefs: the address stays inside its href; a clean link is unchanged');
    });

    test(`buildPhaseNav: ${JSON.stringify(v)} in the tab, the side menu and the section heading`, () => {
      const html = '<nav class="topnav"><a data-tab="mapview">MAP</a></nav><div id="sm-phase-links"></div><section id="bookings"></section>';
      const { ctx, document } = sandbox(['buildPhaseNav', 'esc'], { switchTab: () => {} }, html);
      ctx.buildPhaseNav({ phases: [quotedPhase(v)] });
      assertQuoteInert(document.body);
      assert.equal(document.querySelector('.topnav a[data-tab="colmar"]').textContent, v);
      assert.equal(document.querySelector('#sm-phase-links .lang-he').textContent, `${v} ${v}`);
      assert.equal(document.querySelector('#sm-phase-links a').getAttribute('data-tab'), 'colmar');
      assert.equal(document.querySelector('#colmar h2 .lang-en').textContent, v);
    });

    test(`buildMapPopup and the map marker: ${JSON.stringify(v)}`, () => {
      const stop = { lat: 48, lng: 7, emoji: v, name_he: v, name_en: v, dates: v, hotel: v, conf: v, color: '#0a0f1c' };
      const icons = [];
      const popups = [];
      const L = {
        map: () => ({ setView() { return this; } }),
        tileLayer: () => ({ addTo() { return this; } }),
        polyline: () => ({ addTo() { return this; } }),
        divIcon: (o) => { icons.push(o.html); return o; },
        marker: () => ({ addTo() { return this; }, bindPopup(h) { popups.push(h); return this; } }),
      };
      const { ctx, document } = sandbox(['initMap', 'buildMapPopup', 'esc'], { L, MAP_STOPS: [stop], mapMarkers: [], currentLang: 'he' });
      ctx.initMap();
      for (const html of [icons[0], popups[0], ctx.buildMapPopup(stop, 'en')]) {
        const div = document.createElement('div');
        div.innerHTML = html;
        assertQuoteInert(div);
        assert.ok(div.textContent.includes(v), div.innerHTML);
      }
      const div = document.createElement('div');
      div.innerHTML = popups[0];
      assert.equal(div.querySelector('code').textContent, v, 'the confirmation');
    });

    test(`loadWx and the trip clock: ${JSON.stringify(v)} as the stop's name`, async () => {
      const T = { en: { wx_loading: '…', wx_forecast: 'Forecast', wx_error: 'error', cd_open_phase: 'Open' } };
      const daily = { time: ['2026-12-02'], weathercode: [0], temperature_2m_max: [5], temperature_2m_min: [1] };
      const { ctx, document } = sandbox(['loadWx', 'esc', 'tick', 'setClockTarget'], {
        T, currentLang: 'en', WX_LOCS: { k: { name: v, lat: 1, lng: 2 } },
        fetch: async () => ({ json: async () => ({ daily }) }), wxIcon: () => '☀', dayName: () => 'Wed',
        tripClockState: () => ({ state: 'during', phase: quotedPhase(v), day: 1, totalDays: 6 }),
      }, '<div id="wx-k" style="display:none"></div><div id="hero-countdown"><span id="cd-live-phase"></span></div>');
      await ctx.loadWx('k');
      const wx = document.getElementById('wx-k');
      assertQuoteInert(wx);
      assert.ok(wx.querySelector('strong').textContent.startsWith(`${v} — `), wx.innerHTML);
      ctx.window.TRIP_CONFIG = {};
      ctx.tick();
      assert.equal(document.getElementById('cd-live-phase').textContent, `${v} ${v}`);
      assertQuoteInert(document.getElementById('hero-countdown'));
      assert.equal(document.getElementById('hero-countdown').getAttribute('data-phase-tab'), 'colmar');
    });
  }
});

// ── Third boundary review 2026-10-11, finding D: the day schedule ──────────
// renderDays put a config day's label, an item's time and text, and a planned
// place's name into innerHTML raw. The provisioner writes all of them from the
// interview or an uploaded document (through an LLM), so a hostile document
// can reach them. Labels, times and place names are plain text. An ITEM's
// text is an HTML fragment by contract — hand-authored trips link places
// inline, and POST /api/phase-plan/export-to-config writes escaped text plus
// <a> links into it — so it is rebuilt from an allow-list (http(s) links,
// b/strong/i/em/br) rather than escaped: a link the organizer authored stays
// a link, an & written as &amp; still shows once, and nothing else survives.
const DAY_HOSTILE = [XSS, ...QUOTED, 'javascript:alert(1)', "x');alert(1);//"];
const DAY_EXTRAS = { isOrganizer: false, PHASE_PLAN: {}, PHASE_PLAN_DAYS: {} };

function renderSchedule(phase) {
  const { document, ctx } = createRenderContext(`<div id="sched-${phase.id}"></div>`, { phases: [phase] }, 'en', DAY_EXTRAS);
  ctx.renderDays(phase);
  return document.getElementById(`sched-${phase.id}`);
}

describe('renderDays: config day label, item time and text, planned places (finding D)', () => {
  for (const v of DAY_HOSTILE) {
    test(`${JSON.stringify(v)} as a day label, an item time and an item text`, () => {
      const el = renderSchedule({ id: 'ny', days: [{ date: '2027-03-11', label: { he: v, en: v }, items: [{ time: v, text: { he: v, en: v }, maps: 'javascript:alert(2)' }] }] });
      assertQuoteInert(el);
      assert.equal(el.querySelector('.day-label .lang-en').textContent, v, 'the label, as text');
      const li = el.querySelector('li');
      assert.equal(li.querySelector('strong').textContent, v, 'the time, as text');
      assert.equal(li.querySelectorAll('a').length, 0, 'the javascript: map link is dropped');
      // An item's text is an HTML fragment: a planted element is dropped, not
      // created; anything that is not markup is shown exactly as typed.
      const shown = li.querySelector('.lang-en').textContent;
      assert.equal(shown, v.startsWith('<img') ? '' : v);
    });

    test(`${JSON.stringify(v)} as a planned place's name, with hostile links`, () => {
      const el = renderSchedule({ id: 'tokyo', venues: [{ name: { he: v, en: v }, maps: v, waze: 'javascript:alert(3)', tickets: 'https://t.example/" onmouseover="alert(4)' }] });
      assertQuoteInert(el);
      const li = el.querySelector('.phase-places-block li');
      assert.equal(li.querySelector('.lang-en').textContent, v);
      assert.deepEqual([...li.querySelectorAll('a[href]')].map(a => a.getAttribute('href')), ['https://t.example/" onmouseover="alert(4)']);
    });
  }

  test('an item\'s authored markup: an http(s) link stays a link, everything else is reduced to its text', () => {
    const text = 'Visit <a href="https://www.google.com/maps/search/?q=Central+Park&amp;z=1" target="_blank" rel="noopener">Central Park</a> &amp; ' +
      '<a href="javascript:alert(1)">the zoo</a>, <a href="https://x.example/" onclick="alert(2)" style="color:red">the pier</a>, ' +
      '<strong>bold</strong> <span onmouseover="alert(3)">span</span> &amp;amp; <script>alert(4)</script>end';
    const el = renderSchedule({ id: 'ny', days: [{ date: '2027-03-11', items: [{ time: '11:00', text: { he: text, en: text } }] }] });
    assertQuoteInert(el);
    const en = el.querySelector('li .lang-en');
    assert.equal(en.textContent, 'Visit Central Park & the zoo, the pier, bold span &amp; end');
    const links = [...en.querySelectorAll('a')];
    assert.deepEqual(links.map(a => [a.getAttribute('href'), a.textContent, a.getAttribute('target'), a.getAttribute('rel')]), [
      ['https://www.google.com/maps/search/?q=Central+Park&z=1', 'Central Park', '_blank', 'noopener'],
      ['https://x.example/', 'the pier', '_blank', 'noopener'],
    ]);
    assert.ok(!links[1].hasAttribute('style'), 'no attribute is carried over from the authored tag');
    assert.equal(en.querySelectorAll('strong').length, 1, 'plain formatting survives, with no attributes');
    assert.equal(en.querySelectorAll('span, script').length, 0);
  });

  test('positive control: the fixture\'s schedule renders as before', () => {
    const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
    const ny = fixture.phases.find(p => p.id === 'ny');
    const el = renderSchedule(ny);
    assert.equal(el.querySelector('.day-label .lang-en').textContent, 'Sun 11/3 — New York');
    const park = [...el.querySelectorAll('li')].find(li => li.textContent.includes('Central Park'));
    assert.equal(park.querySelector('strong').textContent, '11:00');
    assert.equal(park.querySelector('.lang-en a').getAttribute('href'), 'https://www.google.com/maps/search/Central+Park');
    assert.equal(park.querySelector('.lang-en').textContent, 'Visit Central Park');
    assert.equal(park.querySelector('.lang-he').textContent, 'ביקור ב־Central Park');
  });
});
