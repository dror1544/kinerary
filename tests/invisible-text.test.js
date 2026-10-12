/**
 * invisible-text.test.js — the invisible and blank-looking characters the
 * write rules refuse, enumerated over every code point (boundary re-check of
 * PR #371, 2026-10-12).
 *
 * The re-check found the refused set too narrow: a soft hyphen, U+2063
 * INVISIBLE SEPARATOR, tag characters, variation selectors, the Hangul fillers
 * and the braille blank were all stored in booking, participant and stop text,
 * so a name or a confirmation number could look identical to another one, and
 * a booking name made of a lone U+3164 passed the blank check.
 *
 * The rule (server/text-rules.js, twinned in server/trip-structure.js):
 *   refused = Default_Ignorable_Code_Point − ALLOWED + EXTRA
 *   ALLOWED = ZWNJ, ZWJ, LRM, RLM, ALM, VS16 — RTL text and emoji are typed with them
 *   EXTRA   = U+2028/U+2029 (refused before this change, not default-ignorable)
 *             U+2800 BRAILLE PATTERN BLANK, U+FFFC OBJECT REPLACEMENT CHARACTER
 *             U+070F SYRIAC ABBREVIATION MARK and U+16FE4 KHITAN FILLER, which
 *             Chromium draws at zero width, and U+FFF9-U+FFFB, the interlinear
 *             annotation marks (second boundary re-check of PR #373, 2026-10-12)
 *
 * And two rules that sit on top of it (same re-check):
 *   BLANK   = a value made only of whitespace, the refused set, the ALLOWED
 *             marks and combining marks (\p{M}) is blank — a name of a lone RLM
 *             or a lone U+0301 renders as nothing. A real name that CONTAINS them
 *             (niqqud, a VS16 heart, a Persian ZWNJ word, e + U+0301) is not.
 *   CODES   = a confirmation number or a PIN also refuses the ALLOWED marks: RLM
 *             and ALM reorder digits inside a right-to-left page (123 RLM 456
 *             shows as 456123), and a code has no use for any of the six.
 * The Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the Khmer inherent
 * vowels (U+17B4, U+17B5) are already default-ignorable, so they are not listed
 * twice.
 *
 * Two enumerations, on purpose: one against this Node's own
 * \p{Default_Ignorable_Code_Point} (the regex is built from that rule), and
 * one against a PINNED list of ranges (Unicode 17, the set Node 22 ships). A
 * Node upgrade that moves the property fails the second one, loudly, instead
 * of silently refusing — or accepting — a new character.
 *
 * No server here; the HTTP routes are covered in write-validation.test.js and
 * the stop layer in stop-hardening.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rules = require('../server/text-rules.js');

const ch = (cp) => String.fromCodePoint(cp);
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
const DI = new RegExp('\\p{Default_Ignorable_Code_Point}', 'u');

const ALLOWED = new Map([
  [0x200C, 'ZWNJ — Persian and other scripts join/unjoin letters with it'],
  [0x200D, 'ZWJ — emoji family/profession sequences, Indic conjuncts'],
  [0x200E, 'LRM — Hebrew mixed with English/numbers'],
  [0x200F, 'RLM — Hebrew mixed with English/numbers'],
  [0x061C, 'ALM — Arabic mixed with numbers'],
  [0xFE0F, 'VS16 — emoji presentation (❤️ is U+2764 U+FE0F)'],
]);
const EXTRA = [0x070F, 0x2028, 0x2029, 0x2800, 0xFFF9, 0xFFFA, 0xFFFB, 0xFFFC, 0x16FE4];

// Default_Ignorable_Code_Point as of Unicode 17 (Node 22.23, ICU 78.2).
const PINNED_DI = [[0x00AD, 0x00AD], [0x034F, 0x034F], [0x061C, 0x061C], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F],
  [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x206F], [0x3164, 0x3164], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0],
  [0xFFF0, 0xFFF8], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE0FFF]];
// What the rule refuses, written out.
const PINNED_REFUSED = [[0x00AD, 0x00AD], [0x034F, 0x034F], [0x070F, 0x070F], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F], [0x200B, 0x200B],
  [0x2028, 0x202E], [0x2060, 0x206F], [0x2800, 0x2800], [0x3164, 0x3164], [0xFE00, 0xFE0E], [0xFEFF, 0xFEFF],
  [0xFFA0, 0xFFA0], [0xFFF0, 0xFFFC], [0x16FE4, 0x16FE4], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE0FFF]];

function* codePoints() {
  for (let cp = 0; cp <= 0x10FFFF; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    yield cp;
  }
}
function ranges(cps) {
  const out = [];
  for (const cp of cps) {
    const last = out[out.length - 1];
    if (last && last[1] === cp - 1) last[1] = cp; else out.push([cp, cp]);
  }
  return out;
}
const show = (rs) => rs.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join(' ');
const inRanges = (rs, cp) => rs.some(([a, b]) => cp >= a && cp <= b);

// Every code point INVISIBLE_RE refuses, computed once.
const REFUSED = [];
for (const cp of codePoints()) if (rules.INVISIBLE_RE.test(ch(cp))) REFUSED.push(cp);

describe('the refused set — Default_Ignorable_Code_Point minus the allowed marks, plus the blank-looking extras', () => {
  test('INVISIBLE_RE refuses exactly (DI − ALLOWED) ∪ EXTRA, over every code point', () => {
    const expected = [];
    for (const cp of codePoints()) {
      if ((DI.test(ch(cp)) && !ALLOWED.has(cp)) || EXTRA.includes(cp)) expected.push(cp);
    }
    assert.equal(show(ranges(REFUSED)), show(ranges(expected)));
  });

  test('this Node\'s Default_Ignorable_Code_Point is the pinned Unicode 17 set (an upgrade that moves it must be reviewed here)', () => {
    const di = [];
    for (const cp of codePoints()) if (DI.test(ch(cp))) di.push(cp);
    assert.equal(show(ranges(di)), show(PINNED_DI),
      `Default_Ignorable_Code_Point changed (Unicode ${process.versions.unicode}): review the new characters, then update PINNED_DI and PINNED_REFUSED`);
  });

  test('the refused set, written out, is what INVISIBLE_RE refuses', () => {
    assert.equal(show(ranges(REFUSED)), show(PINNED_REFUSED));
  });

  test('the allowed marks are not refused; every character the base already refused still is', () => {
    for (const cp of ALLOWED.keys()) assert.equal(rules.INVISIBLE_RE.test(ch(cp)), false, `${hex(cp)} is allowed: ${ALLOWED.get(cp)}`);
    const base = [0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029, 0xFEFF, 0x200B, 0x2060];
    for (const cp of base) assert.ok(REFUSED.includes(cp), `${hex(cp)} was refused before and must stay refused`);
  });

  test('every character the re-check reported as accepted is refused now (except the allowed marks and the visible format signs)', () => {
    // From the review's scan. U+0600-0605, U+06DD, U+0890-0891, U+08E2,
    // U+110BD, U+110CD and U+13430-1343F are format characters that are NOT
    // default-ignorable and draw a visible sign — outside the set. U+070F and
    // U+FFF9-FFFB joined it with the second re-check of PR #373 (U+070F draws
    // at zero width in Chromium; the annotation marks hide what they bracket).
    const reported = [0x070F, 0xFFF9, 0xFFFA, 0xFFFB, 0x16FE4, 0x00AD, 0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180B, 0x180C, 0x180D, 0x180E, 0x180F,
      0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F, 0x3164, 0xFFA0,
      0xFE00, 0xFE0E, 0xFFF0, 0xFFF8, 0x1BCA0, 0x1BCA3, 0x1D173, 0x1D17A, 0xE0000, 0xE0001, 0xE0041, 0xE007F, 0xE0100, 0xE0FFF,
      0x2800, 0xFFFC];
    for (const cp of reported) assert.ok(REFUSED.includes(cp), `${hex(cp)} is still accepted`);
  });

  test('UNSAFE_LINE_RE and UNSAFE_MULTILINE_RE refuse every character INVISIBLE_RE refuses, and accept the allowed marks', () => {
    for (const cp of REFUSED) {
      assert.ok(rules.UNSAFE_LINE_RE.test(`a${ch(cp)}b`), `line: ${hex(cp)}`);
      assert.ok(rules.UNSAFE_MULTILINE_RE.test(`a${ch(cp)}b`), `multiline: ${hex(cp)}`);
    }
    for (const cp of ALLOWED.keys()) {
      assert.equal(rules.UNSAFE_LINE_RE.test(`a${ch(cp)}b`), false, `line: ${hex(cp)}`);
      assert.equal(rules.UNSAFE_MULTILINE_RE.test(`a${ch(cp)}b`), false, `multiline: ${hex(cp)}`);
    }
  });

  test('checkField: a refused character in any text field is invalid_text with the invisible-character message', () => {
    for (const cp of REFUSED) {
      for (const [field, spec] of [['confirmation', rules.BOOKING_FIELDS.confirmation], ['notes', rules.BOOKING_FIELDS.notes], ['name', rules.PARTICIPANT_FIELDS.name]]) {
        const r = rules.checkField(field, `AB${ch(cp)}12`, spec);
        assert.ok(r.error, `${field}/${hex(cp)} accepted`);
        assert.equal(r.error.error, 'invalid_text');
        assert.equal(r.error.detail, rules.INVISIBLE_DETAIL, `${field}/${hex(cp)}`);
        assert.match(r.error.message.en, /hidden character/, `${field}/${hex(cp)}`);
      }
    }
  });
});

describe('text people type with the allowed marks is stored as typed', () => {
  const ZWNJ = ch(0x200C), ZWJ = ch(0x200D), LRM = ch(0x200E), RLM = ch(0x200F), ALM = ch(0x061C), VS16 = ch(0xFE0F);
  const samples = [
    ['Hebrew with RLM/LRM, mixed with English', `מלון${RLM} Hilton${LRM} תל אביב`],
    ['a ZWJ emoji family', `${ch(0x1F468)}${ZWJ}${ch(0x1F469)}${ZWJ}${ch(0x1F467)} משפחה`],
    ['a flag emoji', `${ch(0x1F1EE)}${ch(0x1F1F1)} Israel`],
    ['a VS16 emoji', `${ch(0x2764)}${VS16} Paris`],
    ['a keycap emoji', `1${VS16}${ch(0x20E3)} first`],
    ['Persian with ZWNJ', `می${ZWNJ}خواهم`],
    ['Arabic with ALM', `فندق${ALM} 5`],
  ];
  for (const [name, value] of samples) {
    test(name, () => {
      for (const [field, spec] of [['name', rules.BOOKING_FIELDS.name], ['notes', rules.BOOKING_FIELDS.notes], ['name', rules.PARTICIPANT_FIELDS.name]]) {
        assert.deepEqual(rules.checkField(field, value, spec), { value }, `${field}: ${JSON.stringify(value)}`);
      }
      assert.equal(rules.isBlank(value), false);
      assert.equal(rules.cleanText(value, rules.BOOKING_FIELDS.name), value, 'a draft keeps it too');
    });
  }

  test('a subdivision flag (England) is REFUSED: its tag characters are refused with the rest of U+E0000-E0FFF', () => {
    const england = [0x1F3F4, 0xE0067, 0xE0062, 0xE0065, 0xE006E, 0xE0067, 0xE007F].map(ch).join('');
    const r = rules.checkField('name', `${england} London`, rules.BOOKING_FIELDS.name);
    assert.equal(r.error?.error, 'invalid_text');
    assert.equal(r.error.detail, rules.INVISIBLE_DETAIL);
  });
});

describe('blank — a value made only of whitespace and refused characters is blank', () => {
  test('a lone U+3164, U+2800, U+200B, U+FEFF, U+00AD or U+E0041 — alone, repeated, or among spaces — is blank', () => {
    for (const cp of [0x3164, 0x2800, 0x200B, 0xFEFF, 0x00AD, 0xE0041, 0xFFA0, 0x115F, 0x2063, 0x2028]) {
      for (const v of [ch(cp), ch(cp).repeat(3), ` ${ch(cp)} \t${ch(cp)} `]) assert.equal(rules.isBlank(v), true, `${hex(cp)}: ${JSON.stringify(v)}`);
    }
  });
  test('every refused character, alone, is blank', () => {
    for (const cp of REFUSED) assert.equal(rules.isBlank(ch(cp)), true, hex(cp));
  });
  test('a visible character next to one is not blank (the write then refuses it as invisible)', () => {
    assert.equal(rules.isBlank(`A${ch(0x3164)}`), false);
    assert.equal(rules.isBlank('Hotel'), false);
    assert.equal(rules.isBlank(''), true);
    assert.equal(rules.isBlank('   '), true);
    assert.equal(rules.isBlank(undefined), true);
    assert.equal(rules.isBlank(null), true);
  });
});

// Second boundary re-check of PR #373: "names made only of allowed marks are
// accepted" — a booking name of a lone RLM, or of U+0301 alone, came back 200.
describe('blank, widened — the allowed marks and combining marks alone are blank too', () => {
  const MARK_ONLY = [[0x200F], [0x200E, 0x200F], [0x200D], [0xFE0F], [0x061C], [0x200C], [0x0301], [0x070F], [0x16FE4],
    [0x05B8], [0x05BC, 0x05B8], [0x20E3], [0x0301, 0x0301, 0x0300]];
  test('each value the re-check reported (and niqqud or an enclosing keycap with no letter) is blank — alone, among spaces, mixed', () => {
    for (const cps of MARK_ONLY) {
      const v = cps.map(ch).join('');
      for (const x of [v, ` ${v} `, `${v}\t${ch(0x3164)}`]) assert.equal(rules.isBlank(x), true, `${cps.map(hex).join(' ')}: ${JSON.stringify(x)}`);
    }
    assert.equal(rules.isBlank(` ${ch(0x0301)} `), true, "' U+0301 ' is blank");
    assert.equal(rules.isBlank(`${ch(0x200F)}${ch(0x200E)}`), true, 'RLM LRM (what extract-draft stored) is blank');
  });
  test('every allowed mark and every combining mark (\\p{M}), alone, is blank', () => {
    for (const cp of ALLOWED.keys()) assert.equal(rules.isBlank(ch(cp)), true, hex(cp));
    const M = new RegExp('\\p{M}', 'u');
    let n = 0;
    for (const cp of codePoints()) if (M.test(ch(cp))) { assert.equal(rules.isBlank(ch(cp)), true, hex(cp)); n++; }
    assert.ok(n > 2000, `enumerated ${n} combining marks`);
  });
  test('a real name that merely CONTAINS marks is not blank', () => {
    const names = [
      `${ch(0x05E9)}${ch(0x05B8)}${ch(0x05DC)}${ch(0x05D5)}${ch(0x05B9)}${ch(0x05DD)}`, // Hebrew with niqqud
      `${ch(0x2764)}${ch(0xFE0F)}`,                                                       // a VS16 heart, the emoji alone
      `${ch(0x0645)}${ch(0x06CC)}${ch(0x200C)}${ch(0x062E)}${ch(0x0648)}${ch(0x0627)}${ch(0x0647)}${ch(0x0645)}`, // Persian ZWNJ word
      `Cafe${ch(0x0301)}`,                                                                // a combining accent on a base letter
      `${ch(0x1F468)}${ch(0x200D)}${ch(0x1F469)}`,                                        // a ZWJ emoji
      `1${ch(0xFE0F)}${ch(0x20E3)}`,                                                      // a keycap
      `${ch(0x05D3)}${ch(0x05DF)}${ch(0x200F)}`,                                          // Hebrew + RLM
    ];
    for (const v of names) {
      assert.equal(rules.isBlank(v), false, JSON.stringify(v));
      assert.deepEqual(rules.checkField('name', v, rules.BOOKING_FIELDS.name), { value: v }, `stored as typed: ${JSON.stringify(v)}`);
      assert.deepEqual(rules.checkField('name', v, rules.PARTICIPANT_FIELDS.name), { value: v });
    }
  });
  test('extract-draft: a name made only of marks cleans to nothing (null, which the route answers 422)', () => {
    for (const cps of MARK_ONLY) assert.equal(rules.cleanText(cps.map(ch).join(''), rules.BOOKING_FIELDS.name), null, cps.map(hex).join(' '));
    assert.equal(rules.cleanText(`${ch(0x200F)}${ch(0x200E)}`, rules.BOOKING_FIELDS.name), null);
    assert.equal(rules.cleanText(`Dan${ch(0x200F)}`, rules.BOOKING_FIELDS.name), `Dan${ch(0x200F)}`, 'a real name keeps its mark');
  });
});

// RLM and ALM reorder digits inside a right-to-left container: 123 RLM 456
// shows as 456123 on a Hebrew page, and the site renders a confirmation number
// with no bidi isolation. A code has no use for any of the six marks.
describe('code fields — a confirmation number and a PIN refuse the allowed marks too', () => {
  const CODE_FIELDS = [['confirmation', rules.BOOKING_FIELDS.confirmation], ['pin', rules.BOOKING_FIELDS.pin]];
  test('each of LRM, RLM, ALM, ZWNJ, ZWJ, VS16 inside a confirmation number or a PIN → invalid_text, the invisible message, the code detail', () => {
    for (const [field, spec] of CODE_FIELDS) {
      for (const cp of ALLOWED.keys()) {
        const r = rules.checkField(field, `123${ch(cp)}456`, spec);
        assert.ok(r.error, `${field}/${hex(cp)} accepted`);
        assert.deepEqual([r.error.error, r.error.field, r.error.detail], ['invalid_text', field, rules.CODE_DETAIL], `${field}/${hex(cp)}`);
        assert.match(r.error.message.en, /hidden character/);
        assert.match(r.error.message.he, /תו נסתר/);
      }
    }
  });
  test('the same marks in a name, passengers or notes are stored as typed (the other direction)', () => {
    for (const cp of ALLOWED.keys()) {
      const v = `${ch(0x05D3)}${ch(0x05DF)}${ch(cp)} 5`;
      for (const field of ['name', 'passengers', 'notes']) {
        assert.deepEqual(rules.checkField(field, v, rules.BOOKING_FIELDS[field]), { value: v }, `${field}/${hex(cp)}`);
      }
    }
  });
  test('a plain code, a Hebrew-lettered code and a numeric one are still accepted', () => {
    for (const [field, spec] of CODE_FIELDS) {
      for (const v of ['ABC123', 'LY-001', `${ch(0x05D0)}${ch(0x05D1)}-12`, 4321]) {
        assert.equal(rules.checkField(field, v, spec).error, undefined, `${field}: ${v}`);
      }
    }
  });
  test('extract-draft strips the six marks from a code (the write would refuse them), and keeps them in a name', () => {
    const marks = [...ALLOWED.keys()].map(ch).join('');
    assert.equal(rules.cleanText(`123${marks}456`, rules.BOOKING_FIELDS.confirmation), '123456');
    assert.equal(rules.cleanText(`12${marks}34`, rules.BOOKING_FIELDS.pin), '1234');
    assert.equal(rules.cleanText(`x${marks}y`, rules.BOOKING_FIELDS.name), `x${marks}y`);
  });
});

describe('extract-draft cleaners strip exactly what the write refuses (one source, so they cannot drift)', () => {
  test('a draft carrying each refused character comes out clean, in a one-line field and in notes', () => {
    for (const cp of REFUSED) {
      const line = rules.cleanText(`AB${ch(cp)}12`, rules.BOOKING_FIELDS.confirmation);
      assert.equal(line, 'AB12', `line: ${hex(cp)}`);
      const notes = rules.cleanText(`one${ch(cp)}\ntwo`, rules.BOOKING_FIELDS.notes);
      // U+2028/U+2029 are removed too (they are not the line ending; \n is).
      assert.equal(notes, 'one\ntwo', `notes: ${hex(cp)}`);
    }
  });
  test('RLM, LRM, ZWJ, ZWNJ, ALM and VS16 survive a draft', () => {
    const keep = [0x200E, 0x200F, 0x200D, 0x200C, 0x061C, 0xFE0F].map(ch).join('');
    assert.equal(rules.cleanText(`x${keep}y`, rules.BOOKING_FIELDS.name), `x${keep}y`);
    assert.equal(rules.cleanText(`x${keep}\ny`, rules.BOOKING_FIELDS.notes), `x${keep}\ny`);
  });
  test('a draft value made only of refused characters cleans to nothing (null)', () => {
    assert.equal(rules.cleanText(ch(0x3164), rules.BOOKING_FIELDS.name), null);
    assert.equal(rules.cleanText(`${ch(0x2800)} ${ch(0x200B)}`, rules.BOOKING_FIELDS.notes), null);
  });
});

describe('link hosts — every character INVISIBLE_RE refuses is refused inside a link host too', () => {
  test('for every refused code point c, safeLink("https://a" + c + "b.com/") is refused', () => {
    for (const cp of REFUSED) {
      assert.equal(rules.safeLink(`https://a${ch(cp)}b.com/`), undefined, `${hex(cp)} accepted in a link host`);
    }
  });
});
