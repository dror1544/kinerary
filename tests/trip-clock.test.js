/**
 * trip-clock.test.js — the hero clock.
 *
 * Once the trip starts, a countdown is the one number nobody wants ("3 days
 * until it's over"), so mid-trip the card stops counting and becomes a live
 * indicator instead: which phase you're in, which day of the trip it is, and
 * a click through to that phase's page.
 *
 * Runs the real TRIP_CLOCK region out of site/app.js (plus the real
 * site/translations.js) in happy-dom — no reimplementation of the date math.
 */
process.env.TZ = 'Asia/Jerusalem'; // must precede any Date construction below

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { Window } from 'happy-dom';

const HERE   = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'site', 'app.js');
const TRANS  = join(HERE, '..', 'site', 'translations.js');
const INDEX  = join(HERE, '..', 'site', 'index.html');

function clockSource() {
  const src = readFileSync(APP_JS, 'utf8');
  const m = src.match(/\/\* TRIP_CLOCK_BEGIN \*\/([\s\S]*?)\/\* TRIP_CLOCK_END \*\//);
  if (!m) throw new Error('TRIP_CLOCK_BEGIN / TRIP_CLOCK_END markers not found in app.js');
  return m[1];
}

/**
 * The real hero clock markup, lifted out of site/index.html rather than copied
 * here — a copy would keep passing after the ids in the page drift away from
 * the ones tick() writes to, which is exactly the breakage worth catching.
 */
const CLOCK_HTML = (() => {
  const html = readFileSync(INDEX, 'utf8');
  const start = html.indexOf('<div class="hero-countdown"');
  if (start === -1) throw new Error('hero-countdown block not found in site/index.html');
  const tags = /<\/?div\b/g;
  tags.lastIndex = start;
  let depth = 0, m;
  while ((m = tags.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, html.indexOf('>', m.index) + 1);
  }
  throw new Error('unbalanced hero-countdown block in site/index.html');
})();

// Japan-shaped: an evening departure the day before the first phase begins,
// and phases that share their boundary day (check out of one, into the next).
const cfg = {
  meta: { departure: '2026-09-05T20:00:00+03:00', returnDate: '2026-09-16', totalDays: 11 },
  phases: [
    { id: 'tokyo',  emoji: '🗼', tabLabel: 'TOKYO',  title: { he: 'טוקיו', en: 'Tokyo' },  dates: { start: '2026-09-06', end: '2026-09-10' } },
    { id: 'hakone', emoji: '🗻', tabLabel: 'HAKONE', title: { he: 'האקונה', en: 'Hakone' }, dates: { start: '2026-09-10', end: '2026-09-11' } },
    { id: 'kyoto',  emoji: '⛩️', tabLabel: 'KYOTO',  title: { he: 'קיוטו', en: 'Kyoto' },  dates: { start: '2026-09-11', end: '2026-09-13' } },
    { id: 'osaka',  emoji: '🏯', tabLabel: 'OSAKA',  title: { he: 'אוסקה', en: 'Osaka' },  dates: { start: '2026-09-13', end: '2026-09-16' } },
  ],
};

function makeContext(config = cfg, lang = 'he') {
  const win = new Window({ url: 'http://localhost/' });
  const doc = win.document;
  doc.body.innerHTML = CLOCK_HTML;

  const switched = [];
  const ctx = vm.createContext({
    window: Object.assign(win, { TRIP_CONFIG: config }),
    document: doc,
    currentLang: lang,
    switchTab: id => switched.push(id),
    setInterval: () => 0, // the region self-starts its 1s tick; don't let it
    console,
  });
  vm.runInContext(readFileSync(TRANS, 'utf8'), ctx, { filename: 'translations.js' });
  vm.runInContext(clockSource(), ctx, { filename: 'app.js (trip clock)' });
  return { document: doc, ctx, switched, window: win };
}

const at = iso => new Date(iso);

// ── tripClockState() ──────────────────────────────────────────────────────────
describe('tripClockState()', () => {
  test('before departure: counts down to departure', () => {
    const { ctx } = makeContext();
    const s = ctx.tripClockState(cfg, at('2026-08-11T09:00:00+03:00'));
    assert.equal(s.state, 'before');
    assert.equal(s.target.toISOString(), new Date(cfg.meta.departure).toISOString());
  });

  test('mid-trip: reports the phase whose dates contain today', () => {
    const { ctx } = makeContext();
    const s = ctx.tripClockState(cfg, at('2026-09-12T10:00:00+03:00'));
    assert.equal(s.state, 'during');
    assert.equal(s.phase.id, 'kyoto');
  });

  test('on a shared boundary day, the phase being travelled into wins', () => {
    const { ctx } = makeContext();
    // 09-10 is Tokyo's last day and Hakone's first — you sleep in Hakone.
    assert.equal(ctx.tripClockState(cfg, at('2026-09-10T08:00:00+03:00')).phase.id, 'hakone');
  });

  test('departure evening, before the first phase starts, points at the first phase', () => {
    const { ctx } = makeContext();
    const s = ctx.tripClockState(cfg, at('2026-09-05T22:00:00+03:00'));
    assert.equal(s.state, 'during');
    assert.equal(s.phase.id, 'tokyo');
  });

  test('day 1 is the departure day, and the count matches meta.totalDays', () => {
    const { ctx } = makeContext();
    assert.deepEqual(
      (({ day, totalDays }) => ({ day, totalDays }))(ctx.tripClockState(cfg, at('2026-09-05T22:00:00+03:00'))),
      { day: 1, totalDays: 11 },
    );
    assert.equal(ctx.tripClockState(cfg, at('2026-09-12T10:00:00+03:00')).day, 8);
  });

  test('the day number never exceeds the advertised trip length', () => {
    const { ctx } = makeContext();
    // 09-05 → 09-16 spans 12 calendar days but the config advertises 11.
    assert.equal(ctx.tripClockState(cfg, at('2026-09-16T18:00:00+03:00')).day, 11);
  });

  test('falls back to the departure→return span when meta.totalDays is missing', () => {
    const noTotal = { ...cfg, meta: { ...cfg.meta, totalDays: undefined } };
    const { ctx } = makeContext(noTotal);
    assert.equal(ctx.tripClockState(noTotal, at('2026-09-12T10:00:00+03:00')).totalDays, 12);
  });

  test('after the return date: finished, no phase', () => {
    const { ctx } = makeContext();
    const s = ctx.tripClockState(cfg, at('2026-09-20T10:00:00+03:00'));
    assert.equal(s.state, 'finished');
    assert.equal(s.phase, undefined);
  });

  test('a trip with no phases still reports the day', () => {
    const noPhases = { meta: cfg.meta, phases: [] };
    const { ctx } = makeContext(noPhases);
    const s = ctx.tripClockState(noPhases, at('2026-09-12T10:00:00+03:00'));
    assert.equal(s.state, 'during');
    assert.equal(s.phase, null);
    assert.equal(s.day, 8);
  });
});

// ── tick() rendering ──────────────────────────────────────────────────────────
describe('tick() — before departure', () => {
  test('shows the countdown units, hides the live card, is not clickable', () => {
    const { document, ctx } = makeContext();
    ctx.tick(at('2026-09-04T20:00:00+03:00'));
    assert.equal(document.getElementById('cd-units').hidden, false);
    assert.equal(document.getElementById('cd-live').hidden, true);
    assert.equal(document.getElementById('cd-d').textContent, '1');
    const card = document.getElementById('hero-countdown');
    assert.equal(card.getAttribute('data-phase-tab'), null);
    assert.equal(card.getAttribute('role'), null);
  });
});

describe('tick() — mid-trip', () => {
  test('replaces the counter with the current phase and trip day', () => {
    const { document, ctx } = makeContext();
    ctx.tick(at('2026-09-12T10:00:00+03:00'));
    assert.equal(document.getElementById('cd-units').hidden, true);
    assert.equal(document.getElementById('cd-finished').hidden, true);
    assert.equal(document.getElementById('cd-live').hidden, false);
    assert.equal(document.getElementById('cd-live-phase').textContent, '⛩️ קיוטו');
    assert.equal(document.getElementById('cd-live-day').textContent, 'יום 8 מתוך 11');
    assert.equal(document.getElementById('cd-caption').textContent, 'הטיול בעיצומו');
  });

  test('renders the phase title in the active language', () => {
    const { document, ctx } = makeContext(cfg, 'en');
    ctx.tick(at('2026-09-12T10:00:00+03:00'));
    assert.equal(document.getElementById('cd-live-phase').textContent, '⛩️ Kyoto');
    assert.equal(document.getElementById('cd-live-day').textContent, 'Day 8 of 11');
  });

  test('marks the card as a button pointing at the phase tab', () => {
    const { document, ctx } = makeContext();
    ctx.tick(at('2026-09-12T10:00:00+03:00'));
    const card = document.getElementById('hero-countdown');
    assert.equal(card.getAttribute('data-phase-tab'), 'kyoto');
    assert.equal(card.getAttribute('role'), 'button');
    assert.equal(card.getAttribute('tabindex'), '0');
    assert.ok(card.classList.contains('clickable'));
  });

  test('clicking the card opens that phase page', () => {
    const { document, ctx, switched, window } = makeContext();
    ctx.tick(at('2026-09-12T10:00:00+03:00'));
    document.getElementById('hero-countdown').dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.deepEqual(switched, ['kyoto']);
  });

  test('Enter on the focused card opens that phase page', () => {
    const { document, ctx, switched, window } = makeContext();
    ctx.tick(at('2026-09-12T10:00:00+03:00'));
    const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.getElementById('hero-countdown').dispatchEvent(ev);
    assert.deepEqual(switched, ['kyoto']);
  });

  test('a trip with no phases shows the day alone and stays unclickable', () => {
    const noPhases = { meta: cfg.meta, phases: [] };
    const { document, ctx } = makeContext(noPhases);
    ctx.tick(at('2026-09-12T10:00:00+03:00'));
    assert.equal(document.getElementById('cd-live').hidden, false);
    assert.equal(document.getElementById('cd-live-phase').textContent, '');
    assert.equal(document.getElementById('cd-live-day').textContent, 'יום 8 מתוך 11');
    assert.equal(document.getElementById('hero-countdown').getAttribute('data-phase-tab'), null);
  });
});

describe('tick() — finished', () => {
  test('hides both the counter and the live card, and stops being clickable', () => {
    const { document, ctx, switched, window } = makeContext();
    ctx.tick(at('2026-09-12T10:00:00+03:00')); // mid-trip first: card goes clickable
    ctx.tick(at('2026-09-20T10:00:00+03:00')); // …then the trip ends
    assert.equal(document.getElementById('cd-units').hidden, true);
    assert.equal(document.getElementById('cd-live').hidden, true);
    assert.equal(document.getElementById('cd-finished').hidden, false);
    assert.ok(document.getElementById('cd-finished').textContent.includes('הסתיים'));

    const card = document.getElementById('hero-countdown');
    assert.equal(card.getAttribute('data-phase-tab'), null);
    assert.equal(card.getAttribute('role'), null);
    assert.ok(!card.classList.contains('clickable'));
    card.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.deepEqual(switched, [], 'a finished clock must not route anywhere');
  });
});
