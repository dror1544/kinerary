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
