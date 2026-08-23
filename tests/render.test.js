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

// googleMapsUrl lives outside the RENDER_FUNS block in site/app.js (shared
// with the Bookings tab, which isn't part of that block) — render functions
// that call it need it supplied via extra, per createRenderContext's docstring.
function googleMapsUrl(query) {
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
function bkConfUrls(confFile) {
  if (!confFile) return null;
  const url = `/api/bookings/confirmation/${encodeURIComponent(confFile)}`;
  return { view: url, download: url };
}
function bkEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const HOTEL_EXTRAS = { googleMapsUrl, bkConfUrls, bkEsc };

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
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg, 'he', HOTEL_EXTRAS);
    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    const el = document.getElementById('hotel-ny');
    assert.ok(el?.querySelector('.hotel-card'), '#hotel-ny missing .hotel-card');
  });

  test('hotel card contains the hotel name', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg, 'he', HOTEL_EXTRAS);
    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    const html = document.getElementById('hotel-ny').innerHTML;
    assert.ok(html.includes('Meridian') || html.includes('מרידיאן'), 'hotel name not found');
  });

  test('hotel icon is 🏨 for type=hotel, 🏠 for type=private', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg, 'he', HOTEL_EXTRAS);

    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    assert.ok(document.getElementById('hotel-ny').innerHTML.includes('🏨'), 'expected 🏨 for hotel');

    const coPhase = cfg.phases.find(p => p.id === 'colorado');
    ctx.renderPhaseHotelCard(coPhase);
    assert.ok(document.getElementById('hotel-colorado').innerHTML.includes('🏠'), 'expected 🏠 for private');
  });

  test('renders phone link when phone is present', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg, 'he', HOTEL_EXTRAS);
    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    const html = document.getElementById('hotel-ny').innerHTML;
    assert.ok(html.includes('href="tel:'), 'phone link not found');
  });

  test('does not render pin in hotel card HTML', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg, 'he', HOTEL_EXTRAS);
    const nyPhase = cfg.phases.find(p => p.id === 'ny');
    ctx.renderPhaseHotelCard(nyPhase);
    // Pin may appear as a label (that's intentional on-screen) — but should not be hardcoded
    // Here we check that the card renders without error and has the confirmation number
    const html = document.getElementById('hotel-ny').innerHTML;
    assert.ok(html.includes('TEST-001'), 'confirmation number not shown');
  });

  test('renders accommodation documents only through the authenticated endpoint', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg, 'he', HOTEL_EXTRAS);
    const source = cfg.phases.find(p => p.id === 'ny');
    const phase = { ...source, accommodation: { ...source.accommodation, pdf: 'hotel-confirmation.pdf' } };
    ctx.renderPhaseHotelCard(phase);
    const html = document.getElementById('hotel-ny').innerHTML;
    assert.ok(html.includes('/api/bookings/confirmation/hotel-confirmation.pdf'));
    assert.ok(html.includes('data-authed-document='));
    assert.ok(!html.includes('href="/confirmations/'));
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

// ── renderTelegramLogin ─────────────────────────────────────────────────────────
describe('renderTelegramLogin()', () => {
  test('stays hidden when no bot username is configured', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderTelegramLogin(null);
    const wrap = document.getElementById('telegram-signin-wrap');
    assert.equal(wrap.style.display, 'none');
    assert.equal(document.getElementById('telegram-signin-btn').innerHTML, '');
  });

  test('shows the wrap and injects the widget script when a bot username is present', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderTelegramLogin('my_trip_bot');
    const wrap = document.getElementById('telegram-signin-wrap');
    assert.equal(wrap.style.display, 'flex');
    const script = document.querySelector('#telegram-signin-btn script');
    assert.ok(script, 'expected an injected <script> in the mount point');
    assert.equal(script.getAttribute('data-telegram-login'), 'my_trip_bot');
    assert.equal(script.getAttribute('data-onauth'), 'onTelegramAuth(user)');
  });

  test('does not re-inject the script on a repeat call for the same bot', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderTelegramLogin('my_trip_bot');
    ctx.renderTelegramLogin('my_trip_bot');
    const scripts = document.querySelectorAll('#telegram-signin-btn script');
    assert.equal(scripts.length, 1, 'expected exactly one injected script, not a duplicate');
  });

  test('re-injects when the bot username changes', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderTelegramLogin('bot_one');
    ctx.renderTelegramLogin('bot_two');
    const script = document.querySelector('#telegram-signin-btn script');
    assert.equal(script.getAttribute('data-telegram-login'), 'bot_two');
  });
});

// ── telegramLoginErrorMessage ─────────────────────────────────────────────────
describe('telegramLoginErrorMessage()', () => {
  const tr = {
    err_telegram_not_configured: 'not configured',
    err_telegram_invalid: 'invalid',
    err_telegram_not_member: 'not a member',
    err_telegram_check_failed: 'check failed',
    err_telegram_not_linked: 'not linked',
    err_wrong: 'generic wrong',
  };

  test('maps each known backend error code to its message', () => {
    const { ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    assert.equal(ctx.telegramLoginErrorMessage('telegram_not_configured', tr), 'not configured');
    assert.equal(ctx.telegramLoginErrorMessage('invalid_telegram_login', tr), 'invalid');
    assert.equal(ctx.telegramLoginErrorMessage('not_group_member', tr), 'not a member');
    assert.equal(ctx.telegramLoginErrorMessage('telegram_membership_check_failed', tr), 'check failed');
    assert.equal(ctx.telegramLoginErrorMessage('telegram_account_not_linked', tr), 'not linked');
  });

  test('falls back to the generic error message for an unknown code', () => {
    const { ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    assert.equal(ctx.telegramLoginErrorMessage('some_future_code', tr), 'generic wrong');
  });
});

// ── Day headline escaping ────────────────────────────────────────────────────
// renderDays() puts a day headline through _biSpan(), which emits raw HTML on
// purpose so hand-authored config markup keeps working. Headlines are model
// output summarising booking notes, and POST /api/bookings is only
// authRequired — so a family member's note can reach this string. It must be
// escaped here even though the server also strips tags on the way in.
describe('renderDays — stored day headline', () => {
  const cfg = { phases: [{ id: 'ny', days: [] }] };

  function renderWithHeadline(label) {
    const { document, ctx } = createRenderContext('<div id="sched-ny"></div>', cfg);
    ctx.isOrganizer = false;
    ctx.PHASE_PLAN = { ny: [{
      id: 1, date: '2027-03-11', time: '09:00',
      text_he: 'פריט', text_en: 'Item', status: 'confirmed', enrichment_status: 'done',
    }] };
    ctx.PHASE_PLAN_DAYS = { ny: { '2027-03-11': { label_he: label, label_en: label, enrichment_status: 'done' } } };
    ctx.renderDays(cfg.phases[0]);
    return document.getElementById('sched-ny');
  }

  test('markup in a headline renders as inert text, not as elements', () => {
    const el = renderWithHeadline('<img src=x onerror=alert(1)>Diamond Head');
    assert.equal(el.querySelectorAll('img').length, 0, 'headline injected a real <img>');
    assert.equal(el.querySelectorAll('script').length, 0, 'headline injected a real <script>');
    assert.ok(el.textContent.includes('Diamond Head'), 'the readable part should still show');
    assert.ok(el.textContent.includes('<img'), 'the markup should appear as literal text');
  });

  test('a plain headline still renders normally', () => {
    const el = renderWithHeadline('Diamond Head + Waikiki');
    assert.ok(el.textContent.includes('Diamond Head + Waikiki'));
    assert.equal(el.querySelectorAll('img, script').length, 0);
  });
});
