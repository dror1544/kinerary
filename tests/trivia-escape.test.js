/**
 * trivia-escape.test.js — the trivia leaderboard and game-over screens keep
 * server JSON inert.
 *
 * Review 2026-10-11: renderLeaderboard() and renderGameOver() in
 * site/trivia.html put `familyLabel(p.family)` and `p.score` (and the score
 * delta) into innerHTML raw. Not reachable today — the server strips `family`
 * from the public game state and computes the score — but trivia is a
 * supported extension ("especially for multi-family trips", owner,
 * 2026-10-11), so the sinks are made safe for the day the state changes.
 *
 * The real functions, extracted from trivia.html's inline script by name and
 * run in happy-dom; never reimplemented.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { Window } from 'happy-dom';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, '..', 'site', 'trivia.html'), 'utf8');
const SCRIPT = HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>'));

const XSS = '<img src=x onerror=alert(1)>';
const DQ = 'x" onmouseover="alert(1)';
const HOSTILE = [XSS, DQ, '<b>bold</b>', "' autofocus onfocus='alert(1)"];

function extract(name) {
  const start = SCRIPT.search(new RegExp(`\\nfunction ${name}\\(`));
  if (start === -1) throw new Error(`Could not locate function ${name}() in trivia.html`);
  const end = SCRIPT.indexOf('\n}\n', start + 1) + 3;
  return SCRIPT.slice(start, end);
}

const BODY = `
  <div id="t-lb-title"></div><div id="lb-list"></div><div id="next-persons-badge"></div>
  <div id="t-go-title"></div><div id="go-podium"></div><div id="go-list"></div>`;

function sandbox({ screen = false, lang = 'he', familyEn = {} } = {}) {
  const win = new Window({ url: 'http://localhost/trivia.html' });
  win.document.body.innerHTML = BODY;
  const ctx = vm.createContext({
    window: win, document: win.document, console,
    T: { he: { lbTitle: 'טבלה', goTitle: 'סוף' }, en: { lbTitle: 'Board', goTitle: 'Over' } },
    isAdmin: () => false,
    screenEl: (he, en) => { const s = win.document.createElement('span'); s.textContent = lang === 'he' ? he : en; return s; },
    buildAvatar: (u, cls) => { const i = win.document.createElement('img'); i.className = cls; i.setAttribute('src', `/avatars/${u}.png`); return i; },
    personsToLabel: () => '',
  });
  // The page's own globals, declared the way the page declares them.
  vm.runInContext(`let lang = ${JSON.stringify(lang)}; const isScreenMode = ${screen};
    let _lastLbKey = ''; let FAMILY_EN = ${JSON.stringify(familyEn)};`, ctx);
  const names = ['familyLabel', 'renderLeaderboard', 'renderGameOver'];
  for (const helper of ['escHtml', 'scoreNum']) if (SCRIPT.includes(`function ${helper}(`)) names.unshift(helper);
  vm.runInContext(names.map(extract).join('\n'), ctx, { filename: 'trivia.html (extracted)' });
  return { ctx, document: win.document };
}

function players(overrides = {}) {
  return {
    dana: { name: 'דנה', name_en: 'Dana', score: 30, delta: 10, family: 'כהן', ...overrides },
    avi: { name: 'אבי', name_en: 'Avi', score: 20, delta: 0, family: 'לוי' },
    noa: { name: 'נועה', name_en: 'Noa', score: 10, delta: -5, family: 'לוי' },
    tom: { name: 'תום', name_en: 'Tom', score: 5, delta: 0, family: 'כהן', ...overrides },
  };
}

function assertInert(root) {
  assert.equal(root.querySelectorAll('img[src="x"], b, script, iframe').length, 0, root.innerHTML);
  for (const el of root.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(attr), `${el.tagName} carries ${attr}: ${el.outerHTML}`);
      assert.ok(!/autofocus|alert|["'=();]/i.test(attr), `${el.tagName} grew an attribute ${attr}: ${el.outerHTML}`);
    }
  }
}

describe('trivia leaderboard and game over: family label', () => {
  for (const v of HOSTILE) {
    for (const screen of [false, true]) {
      test(`a family ${JSON.stringify(v)} renders as text (screen mode: ${screen})`, () => {
        const { ctx, document } = sandbox({ screen, familyEn: { [v]: v } });
        ctx.renderLeaderboard({ players: players({ family: v }) });
        ctx.renderGameOver({ players: players({ family: v }) });
        assertInert(document.body);
        const fam = document.querySelector('#lb-list .lb-fam').textContent;
        assert.equal(fam, screen ? `${v} / ${v}` : v, 'the label is shown exactly as written');
        assert.equal(document.querySelector('#go-list .lb-fam').textContent, screen ? `${v} / ${v}` : v);
      });
    }
  }

  test('an English family name from the config map is escaped too', () => {
    const { ctx, document } = sandbox({ lang: 'en', familyEn: { 'כהן': XSS } });
    ctx.renderLeaderboard({ players: players() });
    assertInert(document.body);
    assert.equal(document.querySelector('#lb-list .lb-fam').textContent, XSS);
  });
});

describe('trivia leaderboard and game over: score and delta', () => {
  for (const v of HOSTILE) {
    test(`a score/delta of ${JSON.stringify(v)} is coerced to a number`, () => {
      const { ctx, document } = sandbox();
      ctx.renderLeaderboard({ players: players({ score: v, delta: v }) });
      ctx.renderGameOver({ players: players({ score: v }) });
      assertInert(document.body);
      for (const el of document.querySelectorAll('.lb-score, .pscore, .lb-delta')) {
        assert.match(el.textContent, /^[+-]?\d*$/, `not a number: ${el.outerHTML}`);
      }
    });
  }

  test('positive control: ordinary scores, deltas and families render as before', () => {
    const { ctx, document } = sandbox();
    ctx.renderLeaderboard({ players: players() });
    const rows = [...document.querySelectorAll('#lb-list .lb-row')];
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(r => r.querySelector('.lb-score').textContent), ['30', '20', '10', '5']);
    assert.deepEqual(rows.map(r => r.querySelector('.lb-delta').textContent), ['+10', '', '-5', '']);
    assert.deepEqual(rows.map(r => r.querySelector('.lb-delta').className), ['lb-delta pos', 'lb-delta zer', 'lb-delta neg', 'lb-delta zer']);
    assert.deepEqual(rows.map(r => r.querySelector('.lb-fam').textContent), ['כהן', 'לוי', 'לוי', 'כהן']);
    assert.equal(rows[0].querySelector('.lb-rank').textContent, '🥇');

    ctx.renderGameOver({ players: players() });
    assert.deepEqual([...document.querySelectorAll('#go-podium .pscore')].map(e => e.textContent), ['20', '30', '10']);
    assert.equal(document.querySelector('#go-list .lb-rank').textContent, '4');
    assert.equal(document.querySelector('#go-list .lb-score').textContent, '5');
    assert.equal(document.querySelector('#go-list .lb-fam').textContent, 'כהן');
  });

  test('a missing family renders an empty label, not "undefined"', () => {
    const { ctx, document } = sandbox();
    ctx.renderLeaderboard({ players: players({ family: undefined }) });
    assert.equal(document.querySelector('#lb-list .lb-fam').textContent, '');
  });
});
