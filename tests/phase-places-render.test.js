/**
 * phase-places-render.test.js — a phase that has places but no schedule.
 *
 * An interview-built trip arrives with the places each leg is planned around
 * and no dated days: nothing yet turns `venues[]` into `days[]`. Reported live
 * on 2026-09-12 — the trip config listed Tokyo Skytree and TeamLab Planets on
 * the Tokyo phase, and the phase page showed nothing at all; the places
 * surfaced only in the ratings block, which reads as a rating widget rather
 * than as the plan.
 *
 * `renderDays` now falls back to them, and only when there is nothing else:
 * once a plan or a config schedule exists, that IS the schedule.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderContext } from './helpers/dom.js';
import { readFileSync } from 'fs';
import vm from 'vm';

// The site's real translation table, so an assertion on a label tests the
// label the family reads.
const REAL_T = (() => {
  // translations.js ends with `window.T = T`, so it needs a window to write to.
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../site/translations.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.T;
})();

const PHASE = {
  id: 'tokyo',
  tabLabel: 'TOKYO',
  title: { he: 'טוקיו', en: 'Tokyo' },
  dates: { start: '2026-09-19', end: '2026-09-23' },
  venues: [
    { id: 'tokyo-skytree', name: { he: 'טוקיו סקייטרי', en: 'Tokyo Skytree' }, maps: 'https://maps.example/skytree', waze: 'https://waze.example/skytree', url: 'https://skytree.example' },
    { id: 'teamlab', name: { he: 'טימלאב פלנטס', en: 'TeamLab Planets' }, maps: 'https://maps.example/teamlab' },
    { id: 'junk', name: { he: 'משהו', en: 'Something' }, maps: 'javascript:alert(1)' },
  ],
};

function render(phase, extra = {}) {
  const { document, ctx } = createRenderContext(
    '<div id="sched-tokyo"></div>',
    { phases: [phase] },
    'en',
    { isOrganizer: false, PHASE_PLAN: {}, PHASE_PLAN_DAYS: {}, ...extra },
  );
  ctx.renderDays(phase);
  return document.getElementById('sched-tokyo');
}

describe('a phase with places and no days', () => {
  test('lists the places instead of rendering nothing', () => {
    const el = render(PHASE);
    const text = el.textContent;
    assert.match(text, /Tokyo Skytree/);
    assert.match(text, /TeamLab Planets/);
    assert.match(text, /Planned places/, 'and says the day-by-day is still open');
  });

  test('carries each place\'s links, and drops one that is not a real URL', () => {
    const el = render(PHASE);
    const hrefs = [...el.querySelectorAll('a')].map(a => a.getAttribute('href'));
    assert.ok(hrefs.includes('https://maps.example/skytree'));
    assert.ok(hrefs.includes('https://waze.example/skytree'));
    assert.ok(hrefs.includes('https://skytree.example'));
    assert.ok(!hrefs.some(href => href?.startsWith('javascript:')), 'a junk link never reaches an href');
  });

  test('says nothing extra once the phase HAS a schedule — that would be a duplicate', () => {
    const withDays = {
      ...PHASE,
      days: [{ label: { he: 'יום 1', en: 'Day 1' }, items: [{ text: { he: 'מגדל', en: 'The tower' } }] }],
    };
    const el = render(withDays);
    assert.match(el.textContent, /The tower/);
    assert.ok(!el.textContent.includes('Planned places'), 'the schedule is the schedule');
  });

  test('a phase with neither renders nothing, rather than an empty heading', () => {
    const el = render({ id: 'tokyo', title: { en: 'Tokyo' } });
    assert.equal(el.innerHTML.trim(), '');
  });
});

describe('every date of a phase is a day — empty ones included', () => {
  // Reported 2026-09-13 on a live trip: Tokyo ran 19–23 September, the 19th and
  // 20th had bookings, and the site drew those two days and nothing else.
  // "Where is the 21, it has no plan but should have shown it." An empty day is
  // where the next activity gets added; hiding it hides the gap.
  const PLAN = {
    tokyo: [
      { id: 'p1', date: '2026-09-19', text_he: 'צק אין', text_en: 'Check in', time: '' },
      { id: 'p2', date: '2026-09-20', text_he: 'סקייטרי', text_en: 'Skytree', time: '10:00' },
    ],
  };
  const dayBlocks = el => [...el.querySelectorAll('.day-block')];

  test('the unplanned 21st, 22nd and 23rd are drawn between the planned days', () => {
    const el = render(PHASE, { PHASE_PLAN: PLAN });
    const text = el.textContent;
    for (const day of ['September 19', 'September 20', 'September 21', 'September 22', 'September 23']) {
      assert.match(text, new RegExp(day), `${day} is missing from the phase`);
    }
    assert.equal(dayBlocks(el).length, 5, 'one block per date, no more and no less');
    assert.ok(text.indexOf('September 20') < text.indexOf('September 21'), 'in date order');
  });

  test('an empty day says it is empty', () => {
    // The harness carries its own minimal T, so the label the page shows is
    // passed in — from translations.js, not retyped here.
    const el = render(PHASE, { PHASE_PLAN: PLAN, T: REAL_T });
    const empty = el.querySelector('[data-plan-day="2026-09-21"]');
    assert.ok(empty, 'the 21st has its own block');
    assert.match(empty.textContent, /Nothing planned for this day yet/);
  });

  test('the organizer can add an activity straight onto an empty day', () => {
    const el = render(PHASE, { PHASE_PLAN: PLAN, isOrganizer: true });
    const add = el.querySelector('[data-plan-day="2026-09-21"] [data-plan-add="tokyo"]');
    assert.ok(add, 'the empty day carries the add row');
    assert.equal(add.getAttribute('data-plan-date'), '2026-09-21', 'and it adds to THAT date');
  });

  test('with no plan and no schedule, the days still show — and so do the places', () => {
    const el = render(PHASE);
    assert.equal(dayBlocks(el).filter(b => b.matches('[data-plan-day]')).length, 5);
    assert.match(el.textContent, /Planned places/, 'the places are not hidden by the empty days');
  });
});

