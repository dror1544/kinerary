/**
 * classic-escape-sweep.test.js — every Classic-site (site/app.js) sink that
 * takes a value from server JSON renders it inert.
 *
 * Third boundary review, 2026-10-11:
 *   B. renderTaskDoneState put the done-by participant name into
 *      `title="בוצע על ידי ${who}"` raw, so a name holding a `"` grew the
 *      Home tab's task button an onmouseover (live proof on the review).
 *   D. config text the provisioner writes from an interview or an uploaded
 *      document — families, stats, alerts, tasks, travel info, hero, brand,
 *      budget labels, packing, RSVP activities, venues — reached innerHTML
 *      raw, and config ids (task, venue, activity, photo phase) reached
 *      inline onclick/onchange JavaScript strings.
 * Finding A (booking PIN/passengers) is in booking-xss.test.js, and the
 * stop/day-schedule sinks in stop-xss-render.test.js.
 *
 * The rule each test checks: no element and no handler comes out of the
 * planted text, a `javascript:` link never becomes an href, the text is shown
 * exactly as typed, and an id reaches its handler through a data- attribute
 * read by one delegated listener (runDataAction), never inside an inline JS
 * string. Each block plants the same hostile values and ends with a positive
 * control: an ordinary value still renders the way it did.
 *
 * The real functions from site/app.js, extracted by name or by the
 * RENDER_FUNS region (tests/helpers/dom.js) — never reimplemented.
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
const DQ = 'x" onmouseover="alert(1)';
const SQ = "' autofocus onfocus='alert(1)";
const JSURL = 'javascript:alert(1)';
const JSSTR = "x');alert(1);//";
const HOSTILE = [XSS, DQ, SQ, JSURL, JSSTR];

// Every helper the extracted functions may call, all present on the base.
const BASE_HELPERS = ['escapeHtml', 'esc', 'safeUrl', 'safeParticipantColor', 'uname'];

function extractFunction(name) {
  const start = SRC.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start === -1) throw new Error(`Could not locate function ${name}() in app.js`);
  const end = SRC.indexOf('\n}\n', start) + 3;
  return SRC.slice(start, end);
}

// T stand-in: any key reads back as its own name, so a template never prints
// "undefined" and a string method on it never throws.
const TR = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? k : undefined) });
const T = { he: TR, en: TR };

function sandbox(names, globals = {}, html = '') {
  const win = new Window({ url: 'http://localhost/' });
  win.document.body.innerHTML = html;
  const ctx = vm.createContext({
    window: win, document: win.document, localStorage: win.localStorage, console,
    T, currentLang: 'en', currentUser: null, setTimeout: () => 0,
    ...globals,
  });
  if (!ctx.window.USERS_CACHE) ctx.window.USERS_CACHE = {};
  vm.runInContext([...BASE_HELPERS, ...names].map(extractFunction).join('\n'), ctx, { filename: 'app.js (extracted)' });
  return { ctx, document: win.document, win };
}

// HTML a function returned, parsed into a real DOM.
function parse(html) {
  const win = new Window({ url: 'http://localhost/' });
  const div = win.document.createElement('div');
  div.innerHTML = html;
  return div;
}

// No element and no handler came out of the planted text; every link is one a
// browser will not run.
function assertInert(root, { allowHandlers = [] } = {}) {
  assert.equal(root.querySelectorAll('img[src="x"], script, iframe, object, embed').length, 0, root.innerHTML);
  for (const el of root.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(attr) || allowHandlers.includes(attr), `${el.tagName} carries ${attr}: ${el.outerHTML}`);
      assert.ok(!/autofocus|alert|["'=();]/i.test(attr), `${el.tagName} grew an attribute named ${attr}: ${el.outerHTML}`);
    }
    // An inline handler that survives (the cancel button's loadBudget(), the
    // weather button) must never carry planted text.
    for (const attr of el.getAttributeNames().filter(a => /^on/i.test(a))) {
      assert.ok(!/alert/.test(el.getAttribute(attr)), `${el.tagName} ${attr} carries planted text: ${el.outerHTML}`);
    }
  }
  for (const a of root.querySelectorAll('[href]')) {
    assert.ok(!/^\s*(javascript|data|vbscript):/i.test(a.getAttribute('href')), a.outerHTML);
  }
}

// ── B. the done-by name on a finished task ─────────────────────────────────
describe('B. renderTaskDoneState: who did the task, and the task id', () => {
  const ROW = '<table><tr data-tid="t1"><td><span class="task-deadline" data-deadline="ongoing"></span></td><td class="task-done-cell"></td></tr></table>';

  for (const v of HOSTILE) {
    test(`a participant named ${JSON.stringify(v)} stays inside the title`, () => {
      const { ctx, document } = sandbox(['renderTaskDoneState', 'renderTaskDeadlines'],
        { taskDoneCache: { t1: { user: { name: v } } }, currentUser: { username: 'dana' } }, ROW);
      ctx.renderTaskDoneState();
      assertInert(document.body);
      const btn = document.querySelector('.task-done-cell button');
      assert.equal(btn.getAttribute('title'), `בוצע על ידי ${v}`, 'the whole name is the title, nothing more');
    });

    test(`a task id ${JSON.stringify(v)} reaches no inline handler (done and not done)`, () => {
      for (const done of [true, false]) {
        const { ctx, document } = sandbox(['renderTaskDoneState', 'renderTaskDeadlines'],
          { taskDoneCache: done ? { [v]: { done_by: 'dana' } } : {}, currentUser: { username: 'dana' } }, ROW);
        document.querySelector('tr').setAttribute('data-tid', v);
        ctx.renderTaskDoneState();
        assertInert(document.body);
        const btn = document.querySelector('.task-done-cell button');
        assert.equal(btn.getAttribute('onclick'), null);
        assert.equal(btn.dataset.act, 'task-done');
        assert.equal(btn.dataset.arg, v, 'the id travels exactly, as data');
      }
    });
  }

  test('positive control: an ordinary done task', () => {
    const { ctx, document } = sandbox(['renderTaskDoneState', 'renderTaskDeadlines'],
      { taskDoneCache: { t1: { user: { name: 'Dana & Avi' } } }, currentUser: { username: 'dana' } }, ROW);
    ctx.renderTaskDoneState();
    const btn = document.querySelector('.task-done-cell button');
    assert.equal(btn.getAttribute('title'), 'בוצע על ידי Dana & Avi');
    assert.equal(btn.dataset.arg, 't1');
    assert.equal(document.querySelector('tr td span').textContent, '✅ בוצע', 'the deadline badge flips to done');
  });
});

// ── The delegated listener every converted handler goes through ───────────
describe('runDataAction: the one listener that replaced the inline handlers', () => {
  const ACTIONS = [
    ['act', 'task-done', 'toggleTaskDone'],
    ['act', 'rating-save', 'saveRating'],
    ['act', 'venue-comments', 'toggleVenueComments'],
    ['act', 'venue-comment', 'submitVenueComment'],
    ['act-enter', 'venue-comment', 'submitVenueComment'],
    ['act', 'rsvp', 'setRsvp'],
    ['act', 'photo-react', 'togglePhotoReaction'],
    ['act', 'photo-del-ask', 'askDeletePhoto'],
    ['act', 'photo-del-yes', 'confirmDeletePhoto'],
    ['act', 'photo-del-no', 'cancelDeletePhoto'],
    ['act', 'photo-fb', 'sharePhotoFacebook'],
    ['act', 'photo-ig', 'sharePhotoInstagram'],
    ['act', 'photo-comments', 'togglePhotoComments'],
    ['act', 'photo-comment', 'submitPhotoComment'],
    ['act-enter', 'photo-comment', 'submitPhotoComment'],
    ['act-change', 'upload', 'uploadPhotos'],
  ];

  function wired(html) {
    const calls = [];
    const stubs = Object.fromEntries([...new Set(ACTIONS.map(a => a[2])), 'toggleLfResolve', 'startEditBudget', 'deleteBudgetItem',
      'saveBudgetEdit', 'editBooking', 'deleteBooking'].map(n => [n, (...args) => { calls.push([n, ...args]); }]));
    const { ctx, document, win } = sandbox(['runDataAction'], stubs, html);
    for (const t of ['click', 'change', 'keydown']) document.addEventListener(t, ctx.runDataAction);
    return { calls, document, win };
  }

  for (const v of HOSTILE) {
    for (const [kind, act, fn] of ACTIONS) {
      test(`data-${kind}="${act}" calls ${fn} with ${JSON.stringify(v)} exactly`, () => {
        const tag = kind === 'act' ? 'button' : 'input';
        const { calls, document, win } = wired(`<${tag} id="t" data-${kind}="${act}"></${tag}>`);
        const el = document.getElementById('t');
        el.setAttribute('data-arg', v);
        el.setAttribute('data-arg2', 'yes');
        if (kind === 'act') el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        else if (kind === 'act-change') el.dispatchEvent(new win.Event('change', { bubbles: true }));
        else {
          el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
          assert.equal(calls.length, 0, 'only Enter submits');
          el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        assert.equal(calls.length, 1, JSON.stringify(calls));
        assert.equal(calls[0][0], fn);
        assert.equal(calls[0][1], v);
      });
    }
  }

  test('a click inside a button reaches its action; numeric ids arrive as numbers', () => {
    const { calls, document, win } = wired(
      '<button data-act="booking-edit" data-arg="7"><span id="in">✏️</span></button>' +
      '<button id="lf" data-act="lf-resolve" data-arg="3" data-arg2="1"></button>' +
      '<button id="be" data-act="budget-edit" data-arg="4" data-arg2="12.5"></button>');
    document.getElementById('in').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    document.getElementById('lf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    document.getElementById('be').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(calls, [['editBooking', 7], ['toggleLfResolve', 3, 1], ['startEditBudget', 4, 12.5]]);
  });

  test('a name not in the switch calls nothing, and the packing toggle writes its exact key', () => {
    const { calls, document, win } = wired(`<button id="x" data-act="constructor"></button><input id="p" type="checkbox" data-act-change="pack">`);
    document.getElementById('x').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.equal(calls.length, 0);
    const p = document.getElementById('p');
    p.setAttribute('data-arg', `pack-x-${DQ}`);
    p.checked = true;
    p.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.equal(win.localStorage.getItem(`pack-x-${DQ}`), '1');
  });
});

// ── Home tab: families, stats, alerts, tasks (config text) ─────────────────
describe('Home tab config text: renderFamilies, renderStats, renderAlerts, renderTasks', () => {
  for (const v of HOSTILE) {
    test(`${JSON.stringify(v)} in every field`, () => {
      const cfg = {
        participants: [{ username: 'a', name: 'Avi', name_en: 'Avi', age: v }],
        families: [{ letter: v, name: { he: v, en: v }, description: { he: v, en: v }, note: { he: v, en: v }, members: ['a'] }],
        stats: [{ number: v, description: { he: v, en: v } }],
        alerts: { booked: { he: v, en: v }, pending: { he: v, en: v } },
        tasks: [{ id: v, text: { he: v, en: v }, owner: { he: v, en: v }, deadline: v }],
      };
      const html = '<div id="families-section"></div><div id="stat-strip"></div><div id="home-alerts"></div><div id="tasks-table-wrap"></div>';
      const { document, ctx } = createRenderContext(html, cfg, 'en');
      ctx.renderFamilies(cfg); ctx.renderStats(cfg); ctx.renderAlerts(cfg); ctx.renderTasks(cfg);
      assertInert(document.body);
      const fam = document.querySelector('.fam');
      assert.equal(fam.querySelector('.fam-letter').textContent, v);
      assert.equal(fam.querySelector('h4 .lang-en').textContent, v);
      assert.equal(fam.querySelector('.fam-count .lang-he').textContent, v);
      assert.equal(fam.querySelector('.fam-note .lang-en').textContent, v);
      assert.ok(fam.querySelector('li').textContent.endsWith(`(${v})`), 'the age');
      assert.equal(document.querySelector('#stat-strip h2').textContent, v);
      assert.equal(document.querySelector('#stat-strip .lang-en').textContent, v);
      assert.deepEqual([...document.querySelectorAll('#home-alerts .lang-en')].map(e => e.textContent), [v, v]);
      const row = document.querySelector('tr[data-tid]');
      assert.equal(row.getAttribute('data-tid'), v, 'the task id stays inside data-tid');
      assert.equal(row.querySelector('.lang-en').textContent, v);
      assert.equal(row.children[1].querySelector('.lang-he').textContent, v, 'the owner');
      assert.equal(row.querySelector('.task-deadline').getAttribute('data-deadline'), v);
    });
  }

  test('positive control: an & shows as &, once', () => {
    const cfg = {
      participants: [{ username: 'a', name: 'אבי', name_en: 'Avi', age: 40 }],
      families: [{ letter: 'A', name: { he: 'כהן & לוי', en: 'Cohen & Levi' }, description: 'Two & two', members: ['a'] }],
      stats: [{ number: '12', description: { he: 'ימים', en: 'days & nights' } }],
      tasks: [{ id: 't1', text: 'Book R&R', owner: { he: 'אבי', en: 'Avi' }, deadline: '2027-01-01' }],
    };
    const { document, ctx } = createRenderContext('<div id="families-section"></div><div id="stat-strip"></div><div id="tasks-table-wrap"></div>', cfg, 'en');
    ctx.renderFamilies(cfg); ctx.renderStats(cfg); ctx.renderTasks(cfg);
    assert.equal(document.querySelector('.fam h4 .lang-en').textContent, 'Cohen & Levi');
    assert.equal(document.querySelector('.fam-count').textContent, 'Two & two', 'a plain string stays a plain string');
    assert.equal(document.querySelector('#stat-strip .lang-en').textContent, 'days & nights');
    assert.equal(document.querySelector('tr[data-tid="t1"] td').textContent, 'Book R&R');
    assert.ok(document.querySelector('.fam strong'), 'an adult is still bold');
  });
});

// ── Info tab: travel_info ──────────────────────────────────────────────────
describe('Info tab: renderInfo', () => {
  for (const v of HOSTILE) {
    test(`${JSON.stringify(v)} in country, emergency, currency, contacts and every list`, () => {
      const cfg = { travel_info: {
        countries: { [v]: { flag: v, emergency: { general: v }, currency: { symbol: v, name: v }, callingCode: v },
          Other: { emergency: { police: v, ambulance: v, fire: v } } },
        emergency_contacts: [{ name: { he: v, en: v }, phone: v }],
        health: [{ he: v, en: v }], hospitals: [{ area: { he: v, en: v }, name: v }], money: [v],
        communication: [{ he: v, en: v }], age_notes: [{ who: { he: v, en: v }, note: { he: v, en: v } }],
      } };
      const ids = ['info-countries', 'info-health', 'info-hospitals', 'info-money', 'info-communication', 'info-age-notes'];
      const { document, ctx } = createRenderContext(ids.map(id => `<div id="${id}"></div>`).join(''), cfg, 'en');
      ctx.renderInfo(cfg);
      assertInert(document.body);
      const card = document.querySelector('#info-countries .mini');
      assert.equal(card.querySelector('h4').textContent, `${v} ${v}`, 'flag + country name');
      assert.equal(card.querySelector('strong').textContent, v, 'the emergency number');
      assert.equal(card.querySelectorAll('p')[1].textContent, `${v} ${v} · ${v}`, 'currency symbol, name, calling code');
      assert.equal(document.querySelectorAll('#info-countries .mini')[1].querySelector('strong').textContent, `👮 ${v} · 🚑 ${v} · 🚒 ${v}`);
      const contact = document.querySelectorAll('#info-countries .mini')[2];
      assert.equal(contact.querySelector('h4 .lang-en').textContent, v);
      assert.equal(contact.querySelector('a').getAttribute('href'), `tel:${v}`, 'the phone stays inside its tel: href');
      assert.equal(contact.querySelector('a').textContent, v);
      assert.equal(document.querySelector('#info-health .lang-en').textContent, v);
      assert.equal(document.querySelector('#info-hospitals li').textContent, `${v}${v}: ${v}`, 'area (he+en) and hospital name');
      assert.equal(document.querySelector('#info-money li').textContent, v);
      assert.equal(document.querySelector('#info-communication .lang-he').textContent, v);
      assert.equal(document.querySelector('#info-age-notes li strong .lang-en').textContent, v);
    });
  }

  test('positive control: an ordinary country card and contact', () => {
    const cfg = { travel_info: { countries: { Japan: { flag: '🇯🇵', emergency: { general: '110', unified112: true }, currency: { symbol: '¥', name: 'Yen' }, callingCode: '+81' } },
      emergency_contacts: [{ name: { he: 'שגרירות', en: 'Embassy' }, phone: '+81 3 1234' }], money: [{ he: 'מזומן', en: 'Cash & cards' }] } };
    const { document, ctx } = createRenderContext('<div id="info-countries"></div><div id="info-money"></div>', cfg, 'en');
    ctx.renderInfo(cfg);
    assert.equal(document.querySelector('#info-countries h4').textContent, '🇯🇵 Japan');
    assert.equal(document.querySelector('#info-countries strong').textContent, '110 · 112');
    assert.equal(document.querySelector('a[href^="tel:"]').getAttribute('href'), 'tel:+81 3 1234');
    assert.equal(document.querySelector('#info-money .lang-en').textContent, 'Cash & cards');
  });
});

// ── Photos tab: the upload grid's phase id ─────────────────────────────────
describe('renderPhotoUploads: a phase id never reaches an inline onchange', () => {
  for (const v of HOSTILE) {
    test(`short_id ${JSON.stringify(v)}`, () => {
      const cfg = { phases: [{ id: 'ny', short_id: v, title: { he: 'ניו יורק', en: 'New York' } }] };
      const { document, ctx } = createRenderContext('<div id="photo-uploads"></div>', cfg, 'en');
      ctx.renderPhotoUploads(cfg);
      assertInert(document.body);
      const input = document.querySelector('input[type=file]');
      assert.equal(input.getAttribute('onchange'), null);
      assert.equal(input.dataset.actChange, 'upload');
      assert.equal(input.dataset.arg, v);
      assert.equal(document.querySelector('.photo-upload-area').getAttribute('data-phase'), v);
      assert.equal(document.querySelector('.album-share-link').getAttribute('data-album-phase'), v);
      assert.equal(document.querySelector('.album-share-link').id, `album-link-${v}`);
    });
  }
});

// ── Hero, brand and budget heading ─────────────────────────────────────────
describe('setHero, applyBrandFromConfig and the budget heading: meta.title, brand, hero title/cta/photo', () => {
  const HERO_HTML = '<div id="hero-img"></div><h1 id="hero-headline"></h1><div id="hero-label"></div><div id="hero-subtitle"></div>' +
    '<div id="hero-blurb"></div><div id="hero-meta"></div><button id="hero-cta"></button>';

  for (const v of HOSTILE) {
    test(`hero title and call-to-action ${JSON.stringify(v)}`, () => {
      const HERO = { home: { title: 'TRIP' }, ny: { title: v, photo: `https://img.example/a.jpg") , url("https://evil.example/t.png`, _i18n: { cta: { en: v, he: v } } } };
      const { ctx, document } = sandbox(['setHero', 'heroPhotoCss'], { HERO }, HERO_HTML);
      ctx.setHero('ny');
      assertInert(document.body);
      assert.equal(document.getElementById('hero-headline').firstChild.textContent, v, 'the title, as text');
      assert.equal(document.getElementById('hero-headline').querySelector('.dot').textContent, '.');
      assert.ok(document.getElementById('hero-cta').textContent.startsWith(`${v} `), 'the cta, as text');
      const bg = document.getElementById('hero-img').style.backgroundImage;
      assert.equal((bg.match(/url\(/g) || []).length, 1, `the photo stays one url(): ${bg}`);
    });

    test(`brand / meta.title / budget scope note ${JSON.stringify(v)}`, () => {
      const cfg = { meta: { title: v, brand: v }, trivia_available: true, phases: [{ id: 'ny' }], participants: [{}],
        budget: { scope_note: { he: v, en: v } } };
      const HERO = { home: { title: 'TRIP' }, mapview: {} };
      const html = '<span id="topbar-brand"></span><a id="sm-trivia-link"></a><div id="sm-trivia-section"></div><footer id="site-footer"></footer>' +
        '<h2 id="budget-h2"></h2><p id="budget-note"></p><nav class="topnav"></nav>';
      const { ctx, document } = sandbox(['applyBrandFromConfig', 'buildGlobalsFromConfig', 'buildPhaseNav', 'populatePhaseSectionDropdowns'], {
        HERO, MAP_STOPS: [], WX_LOCS: {}, VENUES: {}, RSVP_ACTIVITIES: {}, PACKING: {}, BUDGET_PHASES: {}, BUDGET_PHASE_ORDER: [], switchTab: () => {},
        fetch: async () => ({ ok: false }),
      }, html);
      ctx.buildGlobalsFromConfig(cfg);
      assertInert(document.body);
      assert.equal(document.getElementById('topbar-brand').firstChild.textContent, `${v} `);
      assert.equal(document.getElementById('sm-trivia-link').textContent, `🏆 ${v} Quiz`);
      assert.ok(document.getElementById('site-footer').textContent.startsWith(`${v} ●`), document.getElementById('site-footer').textContent);
      assert.equal(document.querySelector('#budget-h2 .lang-en').textContent, `${v} · ${v}`);
      assert.equal(document.querySelector('#budget-note .lang-he').textContent, `💡 ${v}`);
      assert.equal(ctx.HERO.home.title, v, 'the hero keeps the raw brand; setHero escapes it where it lands');
    });
  }

  test('positive control: an ordinary brand, hero and photo', () => {
    const HERO = { home: { title: 'Rock & Roll', photo: 'https://images.example/a.jpg?w=1&h=2', _i18n: { cta: { en: 'Go & see' } } } };
    const { ctx, document } = sandbox(['setHero', 'heroPhotoCss'], { HERO }, HERO_HTML);
    ctx.setHero('home');
    assert.equal(document.getElementById('hero-headline').textContent, 'Rock & Roll.');
    assert.equal(document.getElementById('hero-cta').textContent, 'Go & see →');
    assert.ok(document.getElementById('hero-img').style.backgroundImage.includes('https://images.example/a.jpg?w=1&h=2'));
  });
});

describe('populatePhaseSectionDropdowns and buildPhaseNav: budget phase keys/labels and phase ids in attributes', () => {
  for (const v of HOSTILE) {
    test(`${JSON.stringify(v)}`, () => {
      const cfg = { budget: { phase_labels: { [v]: { he: v, en: v } }, phases: [v] }, phases: [{ id: v, title: { he: 'א', en: 'A' } }] };
      const { ctx, document } = sandbox(['populatePhaseSectionDropdowns', 'buildPhaseNav'], { switchTab: () => {} },
        '<select id="ba-phase"></select><select id="bk-phase"></select><section id="bookings"></section>');
      ctx.populatePhaseSectionDropdowns(cfg, 'en');
      ctx.buildPhaseNav(cfg);
      assertInert(document.body);
      for (const sel of document.querySelectorAll('select')) {
        const opts = sel.querySelectorAll('option');
        assert.equal(opts.length, 1);
        assert.equal(opts[0].getAttribute('value'), v);
        assert.equal(opts[0].textContent, v);
      }
      const sec = document.getElementById(v);
      assert.ok(sec, 'the section is created');
      assert.deepEqual([...sec.querySelectorAll('[id]')].map(e => e.id),
        ['hotel', 'sched', 'rsvp', 'pack', 'ratings', 'photos'].map(p => `${p}-${v}`));
    });
  }
});

// ── Packing, RSVP, ratings and venue comments (config text and ids) ────────
describe('renderPacking: category, item and the storage key', () => {
  for (const v of HOSTILE) {
    test(`${JSON.stringify(v)}`, () => {
      const { ctx, document } = sandbox(['renderPacking'], {}, '<div id="pack-ny"></div>');
      ctx.renderPacking('pack-ny', [[{ he: v, en: v }, { he: v, en: v }]]);
      assertInert(document.body);
      assert.equal(document.querySelector('h4').textContent, v);
      assert.equal(document.querySelector('label').textContent, v);
      const box = document.querySelector('input[type=checkbox]');
      assert.equal(box.getAttribute('onchange'), null);
      assert.equal(box.id, `pack-pack-ny-${v}`);
      assert.equal(box.dataset.actChange, 'pack');
      assert.equal(box.dataset.arg, `pack-pack-ny-${v}`);
      assert.equal(document.querySelector('label').getAttribute('for'), box.id);
    });
  }

  test('positive control: a checked item stays checked', () => {
    const { ctx, document } = sandbox(['renderPacking'], {}, '<div id="pack-ny"></div>');
    ctx.localStorage.setItem('pack-pack-ny-דרכון', '1');
    ctx.renderPacking('pack-ny', [[{ he: 'מסמכים', en: 'Docs & IDs' }, { he: 'דרכון', en: 'Passport' }]]);
    assert.equal(document.querySelector('h4').textContent, 'Docs & IDs');
    assert.equal(document.querySelector('input').checked, true);
  });
});

describe('renderRsvpCard: activity id, title, date, price and a response status', () => {
  for (const v of HOSTILE) {
    test(`${JSON.stringify(v)}`, () => {
      const { ctx } = sandbox(['renderRsvpCard'], { rsvpCache: { [v]: [{ username: 'a', status: v, user: { name: 'Avi' } }] }, currentUser: { username: 'me' } });
      const root = parse(ctx.renderRsvpCard({ id: v, title: { en: v, he: v }, date: v, price: v }));
      assertInert(root);
      const card = root.querySelector('.rsvp-card');
      assert.equal(card.id, `rsvp-card-${v}`);
      assert.equal(card.querySelector('.rsvp-title').textContent, v);
      assert.equal(card.querySelector('.rsvp-meta').textContent, `📅 ${v} · ${v}`);
      assert.equal(card.querySelector('.rsvp-chip').getAttribute('title'), `Avi: ${v}`);
      const btns = [...card.querySelectorAll('.rsvp-btn')];
      assert.equal(btns.length, 3);
      assert.deepEqual(btns.map(b => [b.getAttribute('onclick'), b.dataset.act, b.dataset.arg, b.dataset.arg2]),
        [[null, 'rsvp', v, 'yes'], [null, 'rsvp', v, 'no'], [null, 'rsvp', v, 'maybe']]);
    });
  }
});

describe('renderRatings / buildRatingChips / renderVenueCommentThread: venue id, name, links, rating value', () => {
  for (const v of HOSTILE) {
    test(`${JSON.stringify(v)}`, () => {
      const { ctx, document } = sandbox(['renderRatings', 'buildRatingChips', 'renderVenueCommentThread'], {
        allRatings: { [v]: { a: v } }, venueCommentsCache: { [v]: [] }, currentUser: { username: 'me' },
      }, '<div id="ratings-ny"></div>');
      ctx.window.USERS_CACHE = { a: { name: 'Avi', color: '#123456' } };
      ctx.renderRatings('ratings-ny', [{ id: v, name: { en: v, he: v }, maps: JSURL, waze: `https://waze.com/ul?q=1" onmouseover="alert(1)`, url: v }]);
      const card = document.querySelector('.rating-card');
      assert.equal(card.id, `rc-${v}`);
      assert.equal(card.querySelector('h4').textContent, v);
      assert.equal(card.querySelector('.rating-chip').getAttribute('title'), `Avi: ${v}★`);
      assert.equal(card.querySelectorAll('a[href]').length, 1, 'the javascript: maps link is dropped, the waze link kept');
      assert.equal(card.querySelector('a[href]').getAttribute('href'), 'https://waze.com/ul?q=1" onmouseover="alert(1)');
      for (const r of card.querySelectorAll('input[type=radio]')) {
        assert.equal(r.getAttribute('name'), v);
        assert.ok(r.id.startsWith(`${v}-s`));
      }
      const save = card.querySelector('.save-btn');
      assert.deepEqual([save.getAttribute('onclick'), save.dataset.act, save.dataset.arg], [null, 'rating-save', v]);
      const toggle = card.querySelector('.vc-toggle');
      assert.deepEqual([toggle.getAttribute('onclick'), toggle.dataset.act, toggle.dataset.arg], [null, 'venue-comments', v]);
      // The comment thread, drawn into this card's own container.
      ctx.renderVenueCommentThread(v);
      const input = card.querySelector('.vc-input');
      assert.deepEqual([input.getAttribute('onkeydown'), input.dataset.actEnter, input.dataset.arg, input.id], [null, 'venue-comment', v, `vc-input-${v}`]);
      const send = card.querySelector('.vc-send');
      assert.deepEqual([send.getAttribute('onclick'), send.dataset.act, send.dataset.arg], [null, 'venue-comment', v]);
      assertInert(document.body);
    });
  }

  test('saveRating finds the checked star of a venue whose id carries a quote', async () => {
    let posted;
    const { ctx, document } = sandbox(['renderRatings', 'buildRatingChips', 'saveRating'], {
      allRatings: {}, currentUser: { username: 'me' }, fetch: async (url, o) => { posted = JSON.parse(o.body); return { ok: true }; },
    }, '<div id="ratings-ny"></div>');
    ctx.renderRatings('ratings-ny', [{ id: DQ, name: 'V' }]);
    document.querySelector('input[value="4"]').checked = true;
    await ctx.saveRating(DQ);
    assert.deepEqual(posted, { venue: DQ, rating: 4 });
  });
});

// ── Photos: card, reactions, delete confirm, comment thread, upload log ────
describe('the photo gallery: buildPhotoCard, the reaction bar, delete confirm, comments, upload progress', () => {
  for (const v of HOSTILE) {
    test(`photo id / url / filename ${JSON.stringify(v)}`, () => {
      const { ctx } = sandbox(['buildPhotoCard'], { photoIndex: {}, photoCommentsCache: {}, REACTION_EMOJIS: ['❤️'], currentUser: { username: 'me' } });
      const root = parse(ctx.buildPhotoCard({ id: v, username: 'me', url: `/api/photos/file/a.jpg?s=1" onerror="alert(1)`, uploadedAt: '2026-01-01' }, {}));
      assertInert(root);
      const card = root.querySelector('.pg-card');
      assert.equal(card.id, `pgcard-${v}`);
      assert.equal(card.querySelector('img').getAttribute('src'), `/api/photos/file/a.jpg?s=1" onerror="alert(1)`);
      for (const b of card.querySelectorAll('button')) {
        assert.equal(b.getAttribute('onclick'), null, b.outerHTML);
        assert.equal(b.dataset.arg, v, b.outerHTML);
      }
      assert.deepEqual([...card.querySelectorAll('button')].map(b => b.dataset.act),
        ['photo-del-ask', 'photo-fb', 'photo-ig', 'photo-react', 'photo-comments']);
      assert.equal(card.querySelector('[data-act="photo-react"]').dataset.arg2, '❤️');
      const byFile = parse(ctx.buildPhotoCard({ id: 1, username: 'x', filename: v, uploadedAt: '2026-01-01' }, {}));
      assertInert(byFile);
      assert.equal(byFile.querySelector('img').getAttribute('src'), `/api/photos/file/${encodeURIComponent(v)}`);
    });

    test(`delete confirm, reaction re-render and comment thread for photo ${JSON.stringify(v)}`, async () => {
      const html = `<div id="x"></div>`;
      const { ctx, document } = sandbox(['askDeletePhoto', 'cancelDeletePhoto', 'togglePhotoReaction', 'renderPhotoCommentThread'], {
        allPhotoReactions: {}, photoCommentsCache: { [v]: [] }, REACTION_EMOJIS: ['❤️'], currentUser: { username: 'me' },
        fetch: async () => ({ ok: true, json: async () => ({ action: 'added' }) }),
      }, html);
      const x = document.getElementById('x');
      for (const id of ['pgdel-', 'pg-reactions-', 'pg-thread-', 'pg-ct-']) {
        const d = document.createElement('div'); d.id = `${id}${v}`; x.appendChild(d);
      }
      ctx.askDeletePhoto(v);
      assert.deepEqual([...document.getElementById(`pgdel-${v}`).querySelectorAll('button')].map(b => [b.getAttribute('onclick'), b.dataset.act, b.dataset.arg]),
        [[null, 'photo-del-yes', v], [null, 'photo-del-no', v]]);
      assertInert(document.body);
      ctx.cancelDeletePhoto(v);
      assert.deepEqual([...document.getElementById(`pgdel-${v}`).querySelectorAll('button')].map(b => [b.getAttribute('onclick'), b.dataset.act, b.dataset.arg]),
        [[null, 'photo-del-ask', v]]);
      await ctx.togglePhotoReaction(v, '❤️');
      const react = document.getElementById(`pg-reactions-${v}`).querySelector('button');
      assert.deepEqual([react.getAttribute('onclick'), react.dataset.act, react.dataset.arg, react.dataset.arg2], [null, 'photo-react', v, '❤️']);
      ctx.renderPhotoCommentThread(v);
      const thread = document.getElementById(`pg-thread-${v}`);
      const input = thread.querySelector('.vc-input');
      assert.deepEqual([input.getAttribute('onkeydown'), input.dataset.actEnter, input.dataset.arg, input.id], [null, 'photo-comment', v, `pg-input-${v}`]);
      const send = thread.querySelector('.vc-send');
      assert.deepEqual([send.getAttribute('onclick'), send.dataset.act, send.dataset.arg], [null, 'photo-comment', v]);
      assertInert(document.body);
    });
  }

  test('the upload progress list names a file as text', async () => {
    const { ctx, document } = sandbox(['uploadPhotos'], {
      FormData: class { append() {} },
      XMLHttpRequest: class { constructor() { this.upload = {}; } open() {} setRequestHeader() {} send() { this.onerror(); } },
    }, '<div id="upload-log"></div>');
    ctx.localStorage.setItem('trip-token', 't');
    await ctx.uploadPhotos('ny', { files: [{ name: XSS }, { name: DQ }], value: '' });
    const log = document.getElementById('upload-log');
    assertInert(log);
    assert.deepEqual([...log.querySelectorAll('.upload-fname')].map(e => e.textContent.split(' — ')[0]), [XSS, DQ]);
  });
});

// ── Album share link (GET /api/album-share/:phase) ─────────────────────────
describe('the album share link: only an http(s) url becomes a link, and it stays inside its href', () => {
  for (const [url, expect] of [[JSURL, null], ['data:text/html,<script>alert(1)</script>', null],
    ['https://photos.example/s/abc" onmouseover="alert(1)', 'https://photos.example/s/abc" onmouseover="alert(1)'],
    ['https://photos.example/s/abc?x=1&y=2', 'https://photos.example/s/abc?x=1&y=2']]) {
    test(JSON.stringify(url), async () => {
      const { ctx, document } = sandbox(['loadAlbumShareLinks', 'albumShareLinkHtml'], {
        ALBUM_SHARE_URLS: {}, authGet: async () => ({ ok: true, json: async () => ({ url }) }),
      }, '<div data-album-phase="ny"></div>');
      await ctx.loadAlbumShareLinks();
      const el = document.querySelector('[data-album-phase="ny"]');
      assertInert(el);
      const a = el.querySelector('a');
      assert.equal(a ? a.getAttribute('href') : null, expect);
    });
  }
});

// ── Lost & found, budget ───────────────────────────────────────────────────
describe('loadLostFound: report id and resolved flag never reach inline JavaScript', () => {
  for (const v of HOSTILE) {
    test(`${JSON.stringify(v)}`, async () => {
      const items = [{ id: v, resolved: v, name: v, item: v, location: v, phone: v, created_at: '2026-01-01' }];
      const { ctx, document } = sandbox(['loadLostFound'], { fetch: async () => ({ ok: true, json: async () => items }) },
        '<div id="lf-list"></div><span id="lf-badge"></span>');
      ctx.localStorage.setItem('trip-token', 't');
      await ctx.loadLostFound();
      const list = document.getElementById('lf-list');
      assertInert(list);
      assert.equal(list.querySelector('.lf-card').id, `lf-card-${v}`);
      const btn = list.querySelector('.lf-resolve-btn');
      assert.deepEqual([btn.getAttribute('onclick'), btn.dataset.act, btn.dataset.arg, btn.dataset.arg2], [null, 'lf-resolve', v, '0']);
      assert.equal(list.querySelector('.lf-finder').textContent, v);
    });
  }
});

describe('loadBudget / startEditBudget: phase label, item id, amount, description', () => {
  for (const v of HOSTILE) {
    test(`${JSON.stringify(v)}`, async () => {
      const items = [{ id: v, phase: 'ny', category: 'food', description: v, amount: v, is_estimate: 0 }];
      const { ctx, document } = sandbox(['loadBudget', 'startEditBudget'], {
        BUDGET_PHASES: { ny: { label: v, en: v } }, BUDGET_PHASE_ORDER: ['ny'], BUDGET_CAT_ICON: {},
        fetch: async () => ({ ok: true, json: async () => items }),
      }, '<div id="budget-content"></div><div id="budget-grand-total"></div><div id="budget-add-wrap"></div><div id="budget-missing-alert"></div>');
      ctx.localStorage.setItem('trip-token', 't');
      ctx.window.TRIP_CONFIG = {};
      await ctx.loadBudget();
      assertInert(document.body);
      const content = document.getElementById('budget-content');
      assert.equal(content.querySelector('.budget-phase-label').textContent, v);
      assert.equal(content.querySelector('.budget-desc').textContent, v);
      const row = content.querySelector('tr');
      assert.equal(row.id, `brow-${v}`);
      assert.match(content.querySelector('.budget-amount').textContent, /^~?\$?[\d,.]+$|^\?$/, 'a non-number amount is not printed as markup');
      assert.ok(!document.getElementById('budget-grand-total').innerHTML.includes('alert'), 'the total is a number');
      const [edit, del] = row.querySelectorAll('button');
      assert.deepEqual([edit.getAttribute('onclick'), edit.dataset.act, edit.dataset.arg], [null, 'budget-edit', v]);
      assert.deepEqual([del.getAttribute('onclick'), del.dataset.act, del.dataset.arg], [null, 'budget-del', v]);
      // The edit box, opened on a cell whose id carries the hostile value.
      const cell = document.getElementById(`bamt-${v}`);
      ctx.startEditBudget(v, v);
      assertInert(document.body, { allowHandlers: ['onclick'] });
      assert.equal(cell.querySelector('input').getAttribute('value'), v);
      assert.equal(cell.querySelector('input').id, `bedit-${v}`);
      const save = cell.querySelector('.budget-save-btn');
      assert.deepEqual([save.getAttribute('onclick'), save.dataset.act, save.dataset.arg], [null, 'budget-save', v]);
    });
  }

  test('positive control: an ordinary item, its subtotal and the grand total', async () => {
    const items = [{ id: 1, phase: 'ny', category: 'food', description: 'Dinner & show', amount: 1200, is_estimate: 1 }];
    const { ctx, document } = sandbox(['loadBudget'], {
      BUDGET_PHASES: { ny: { label: 'ניו יורק', en: 'New York' } }, BUDGET_PHASE_ORDER: ['ny'], BUDGET_CAT_ICON: {},
      fetch: async () => ({ ok: true, json: async () => items }),
    }, '<div id="budget-content"></div><div id="budget-grand-total"></div><div id="budget-add-wrap"></div><div id="budget-missing-alert"></div>');
    ctx.localStorage.setItem('trip-token', 't');
    ctx.window.TRIP_CONFIG = { budget: { party_size: 4 } };
    await ctx.loadBudget();
    const content = document.getElementById('budget-content');
    assert.equal(content.querySelector('.budget-desc').textContent, 'Dinner & show');
    assert.equal(content.querySelector('.budget-amount').textContent, `~$${(1200).toLocaleString()}`);
    assert.equal(content.querySelector('.budget-phase-label').textContent, 'New York');
    assert.ok(document.getElementById('budget-grand-total').textContent.includes(`$${(1200).toLocaleString()}`));
  });
});

// ── Weather panels (open-meteo JSON) and the dead POI / booking-modal code ─
describe('weather and the dormant renderers', () => {
  test('loadWx: a forecast date from the weather API is text', async () => {
    const daily = { time: [`2026-${XSS}`], weathercode: [0], temperature_2m_max: [5], temperature_2m_min: [1] };
    const { ctx, document } = sandbox(['loadWx', 'wxIcon', 'dayName'], {
      WX_LOCS: { k: { name: 'K', lat: 1, lng: 2 } }, fetch: async () => ({ json: async () => ({ daily }) }),
    }, '<div id="wx-k" style="display:none"></div>');
    await ctx.loadWx('k');
    const el = document.getElementById('wx-k');
    assert.ok(el.dataset.loaded, el.innerHTML);
    assertInert(el);
  });

  for (const v of HOSTILE) {
    test(`_buildPoiBody: ${JSON.stringify(v)} as a venue name and every link`, () => {
      const { ctx } = sandbox(['_buildPoiBody']);
      for (const poi of [{ venues: [{ name: v, maps: v, waze: JSURL, tickets: `https://t.example/" onmouseover="alert(1)` }] },
        { maps: JSURL, waze: v, tickets: { url: JSURL, label: v } }]) {
        const root = parse(ctx._buildPoiBody(poi));
        assertInert(root);
        assert.ok(root.textContent.includes(v) || !poi.venues, root.innerHTML);
      }
    });

    test(`openBookingModal: ${JSON.stringify(v)} in every field`, () => {
      const item = { type: 'flight', name: v, conf: v, pin: v, dates: v, info: { en: v }, cost: v, note: { en: v }, pdfs: [{ label: v, file: 'a.pdf' }] };
      const { ctx, document } = sandbox(['openBookingModal', 'bkEsc', 'bkConfUrls'], {
        BOOKING_DATA: { b1: { title: { en: 'T' }, items: [item] } }, BK_TYPE_ICON: { flight: '✈️' }, navigator: {},
      }, '<div id="bk-modal"><h3 id="bk-modal-title"></h3><div id="bk-modal-body"></div></div>');
      ctx.openBookingModal('b1');
      const body = document.getElementById('bk-modal-body');
      assertInert(body);
      assert.equal(body.querySelector('.bkm-name').textContent, `✈️ ${v}`);
      assert.equal(body.querySelector('.bkm-copy').getAttribute('data-copy'), v);
      assert.equal(body.querySelector('.bkm-pin').textContent, v);
    });
  }
});
