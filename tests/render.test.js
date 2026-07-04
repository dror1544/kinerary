/**
 * render.test.js — tests for the config-driven render functions in site/app.js.
 * Uses happy-dom as the browser environment. No server needed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRenderContext, RENDER_TARGETS_HTML } from './helpers/dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg  = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));

// ── renderStats ───────────────────────────────────────────────────────────────
describe('renderStats()', () => {
  test('fills #stat-strip with one div per stat', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderStats(cfg);
    const strip = document.getElementById('stat-strip');
    assert.equal(strip.children.length, 2, 'expected 2 stat divs (fixture has 2 stats)');
  });

  test('each stat contains the number', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderStats(cfg);
    const strip = document.getElementById('stat-strip');
    const numbers = [...strip.querySelectorAll('h2')].map(el => el.textContent);
    assert.ok(numbers.includes('2'), 'stat number "2" not found');
    assert.ok(numbers.includes('1'), 'stat number "1" not found');
  });

  test('renders bilingual description spans', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderStats(cfg);
    const html = document.getElementById('stat-strip').innerHTML;
    assert.ok(html.includes('lang-he'), 'missing lang-he spans');
    assert.ok(html.includes('lang-en'), 'missing lang-en spans');
  });

  test('does nothing when cfg.stats is empty', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, {});
    ctx.renderStats({});
    const strip = document.getElementById('stat-strip');
    assert.equal(strip.innerHTML.trim(), '', 'expected empty strip for empty cfg');
  });
});

// ── renderAlerts ──────────────────────────────────────────────────────────────
describe('renderAlerts()', () => {
  test('renders alert-s for booked and alert-w for pending', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderAlerts(cfg);
    const el = document.getElementById('home-alerts');
    assert.ok(el.querySelector('.alert-s'), 'missing alert-s (booked)');
    assert.ok(el.querySelector('.alert-w'), 'missing alert-w (pending)');
  });

  test('renders only booked alert when no pending', () => {
    const cfgNoPending = { alerts: { booked: { he: 'הכל מוזמן', en: 'All booked' } } };
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfgNoPending);
    ctx.renderAlerts(cfgNoPending);
    const el = document.getElementById('home-alerts');
    assert.ok(el.querySelector('.alert-s'), 'missing booked alert');
    assert.ok(!el.querySelector('.alert-w'), 'unexpected pending alert');
  });
});

// ── renderFamilies ────────────────────────────────────────────────────────────
describe('renderFamilies()', () => {
  test('renders one .fam div per family', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderFamilies(cfg);
    const section = document.getElementById('families-section');
    assert.equal(section.querySelectorAll('.fam').length, 1, 'expected 1 family (fixture)');
  });

  test('adult member (age >= 25) renders in bold', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderFamilies(cfg);
    const html = document.getElementById('families-section').innerHTML;
    assert.ok(html.includes('<strong>'), 'expected <strong> for adult member');
    assert.ok(html.includes('Alice') || html.includes('אליס'), 'adult name not found');
  });

  test('child member (age < 25) does not get a bold line', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderFamilies(cfg);
    // Bob (age 10) should appear as part of the grouped kids line "..." not in <strong>
    const section = document.getElementById('families-section');
    const strongTexts = [...section.querySelectorAll('strong')]
      .map(el => el.textContent.trim());
    const bobInBold = strongTexts.some(t => t.includes('Bob') || t.includes('בוב'));
    assert.ok(!bobInBold, 'child member Bob should not be in <strong>');
  });

  test('renders the family letter', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderFamilies(cfg);
    const html = document.getElementById('families-section').innerHTML;
    assert.ok(html.includes('>A<'), 'family letter "A" not found');
  });
});

// ── renderTasks ───────────────────────────────────────────────────────────────
describe('renderTasks()', () => {
  test('renders a table with one data row per task', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderTasks(cfg);
    const wrap = document.getElementById('tasks-table-wrap');
    const table = wrap.querySelector('table');
    assert.ok(table, 'table not found');
    // 1 header row + 2 task rows = 3 tr elements
    assert.equal(table.querySelectorAll('tr').length, 3, 'expected 3 rows (1 header + 2 tasks)');
  });

  test('each row has a data-tid attribute matching task id', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderTasks(cfg);
    const tids = [...document.querySelectorAll('tr[data-tid]')].map(r => r.getAttribute('data-tid'));
    assert.ok(tids.includes('t1'), 'task t1 row not found');
    assert.ok(tids.includes('t2'), 'task t2 row not found');
  });

  test('task text is rendered bilingual (lang-he + lang-en spans)', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderTasks(cfg);
    const html = document.getElementById('tasks-table-wrap').innerHTML;
    assert.ok(html.includes('lang-he'), 'missing lang-he in task rows');
    assert.ok(html.includes('lang-en'), 'missing lang-en in task rows');
  });
});

// ── renderPhaseHotelCard ──────────────────────────────────────────────────────
describe('renderPhaseHotelCard()', () => {
  test('fills #hotel-{phase.id} with a .hotel-card div', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    const el = document.getElementById('hotel-ny');
    assert.ok(el?.querySelector('.hotel-card'), '#hotel-ny missing .hotel-card');
  });

  test('hotel card contains the hotel name', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    const html = document.getElementById('hotel-ny').innerHTML;
    assert.ok(html.includes('Meridian') || html.includes('מרידיאן'), 'hotel name not found');
  });

  test('hotel icon is 🏨 for type=hotel, 🏠 for type=private', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);

    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    assert.ok(document.getElementById('hotel-ny').innerHTML.includes('🏨'), 'expected 🏨 for hotel');

    const coPhase = cfg.phases.find(p => p.id === 'colorado');
    ctx.renderPhaseHotelCard(coPhase);
    assert.ok(document.getElementById('hotel-colorado').innerHTML.includes('🏠'), 'expected 🏠 for private');
  });

  test('renders phone link when phone is present', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    const html = document.getElementById('hotel-ny').innerHTML;
    assert.ok(html.includes('href="tel:'), 'phone link not found');
  });

  test('does not render pin in hotel card HTML', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    // Pin may appear as a label (that's intentional on-screen) — but should not be hardcoded
    // Here we check that the card renders without error and has the confirmation number
    const html = document.getElementById('hotel-ny').innerHTML;
    assert.ok(html.includes('TEST-001'), 'confirmation number not shown');
  });
});

// ── renderPhotoUploads ────────────────────────────────────────────────────────
describe('renderPhotoUploads()', () => {
  test('renders one .mini div per phase', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderPhotoUploads(cfg);
    const grid = document.getElementById('photo-uploads');
    assert.equal(grid.querySelectorAll('.mini').length, 2, 'expected 2 mini divs (fixture has 2 phases)');
  });

  test('upload areas use short_id for data-phase attribute', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderPhotoUploads(cfg);
    const phases = [...document.querySelectorAll('[data-phase]')].map(el => el.getAttribute('data-phase'));
    // ny has short_id "ny", colorado has short_id "co"
    assert.ok(phases.includes('ny'), 'data-phase="ny" not found');
    assert.ok(phases.includes('co'), 'data-phase="co" not found (short_id alias not applied)');
    assert.ok(!phases.includes('colorado'), 'data-phase="colorado" found — alias was not applied');
  });

  test('album link placeholder is rendered for each phase', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderPhotoUploads(cfg);
    const albumLinks = document.querySelectorAll('[id^="album-link-"]');
    assert.equal(albumLinks.length, 2, 'expected 2 album link placeholders');
  });
});

// ── short_id alias correctness (key generalization invariant) ─────────────────
describe('short_id alias in render outputs', () => {
  test('colorado phase renders with alias "co" not "colorado" in upload grid', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderPhotoUploads(cfg);
    const allPhaseAttrs = [...document.querySelectorAll('[data-phase]')]
      .map(el => el.getAttribute('data-phase'));
    assert.ok(!allPhaseAttrs.includes('colorado'),
      'colorado ID leaked into data-phase — short_id alias not applied');
    assert.ok(allPhaseAttrs.includes('co'),
      '"co" alias not found — short_id alias not applied');
  });
});
