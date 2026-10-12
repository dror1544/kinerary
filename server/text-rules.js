// Write-time rules for the free text a booking or a participant carries, and
// the refusal a person can act on (owner decision, 2026-10-11: "add write-time
// validation for participant names and booking passengers/pin/notes; clarify
// in the native [Hebrew] and English").
//
// STORED TEXT IS NEVER MARKUP. The renderers escape (Classic esc()/bkEsc(),
// React in trip-web), but a value that cannot open a tag is the floor under
// them: the agent key writes bookings and participants, and the companion that
// holds it reads text travellers typed — one prompt injection away. Refused at
// the write, not cleaned: a silently altered value is the failure this
// repository keeps paying for. The one exception is the extract-draft route,
// where nobody typed the text (an LLM read it off a PDF) and refusing would
// leave the organizer with nothing — that route uses clean*() below instead.
//
// `"`, `'` and `&` are TEXT, stored exactly as typed (owner decision,
// 2026-10-11): Hebrew abbreviations are typed with an ASCII quote — ארה"ב,
// ת"א — and refusing or rewriting the quote broke ordinary Hebrew. A quote
// cannot open an element; keeping it inside an attribute is the renderers' job.
// Links are a different kind of value and DO refuse quotes: a link goes into an
// href as it stands.
//
// INVISIBLE CHARACTERS (fifth boundary review, 2026-10-11). A name or a
// confirmation number that RENDERS differently from what it contains is a
// display spoof: U+202E reverses what follows it, U+200B splits a number where
// nobody can see it split. Refused, in one-line fields and in notes alike: the
// bidi embeddings and overrides (U+202A-U+202E), the isolates (U+2066-U+2069),
// the line and paragraph separators (U+2028/U+2029), the BOM (U+FEFF), the
// zero-width space (U+200B) and the word joiner (U+2060). NOT refused, because
// Hebrew and other RTL text is typed with them: LRM (U+200E), RLM (U+200F),
// ALM (U+061C), ZWNJ (U+200C) and ZWJ (U+200D, also inside emoji).
//
// LINE ENDINGS. A multi-line field's \r\n and lone \r become \n before it is
// checked (toLf), so an API or MCP client that sends CRLF is not refused for a
// "hidden control character" it cannot see. A one-line field refuses both.
//
// LINKS are stored as typed, so a link is refused when the URL parser would
// have to REWRITE it to accept it: `https:\\evil.com`, `https:evil.com`,
// `https:///evil.com` and `https://.` all parse, as something else. safeLink()
// wants the literal `http://` or `https://`, no backslash, and a host typed as
// the browser will use it — no empty label, no `%`, and no character the
// parser silently deletes (LINK_HOST_HIDDEN_RE: the invisible set above, the
// soft hyphen, and the rest of what UTS #46 maps to nothing — enumerated
// against Node's own parser in tests/stop-hardening.test.js).
//
// TWIN: UNSAFE_LINE_RE, UNSAFE_MULTILINE_RE, INVISIBLE_RE, TEXT_DETAIL,
// INVISIBLE_DETAIL, LINK_DETAIL, LINK_HOST_HIDDEN_RE, LINK_LABEL_DOT_RE, toLf,
// textDetail() and safeLink() are copies of the same names in
// server/trip-structure.js (the stop layer), duplicated rather than imported
// because that file belongs to another line of work and exports none of them.
// Change one, change both: tests/stop-hardening.test.js ("the twins") compares
// them byte for byte.
// Existing stored data is never rewritten here, and nothing on the read path
// calls this file: reading an old value can never fail on it.
'use strict';

const UNSAFE_LINE_RE = /[<>\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
const UNSAFE_MULTILINE_RE = /[<>\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
const INVISIBLE_RE = /[\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
const TEXT_DETAIL = 'text may not contain < > or control characters';
const INVISIBLE_DETAIL = 'text may not contain invisible characters that change its direction or display (U+200B, U+2028, U+2029, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF)';
const LINK_DETAIL = 'a link must start with http:// or https://, name its host as the browser will use it, and contain no quotes, backslashes, < >, or whitespace';
const LINK_HOST_HIDDEN_RE = /[\u00AD\u034F\u180B-\u180D\u180F\u200B\u2028\u2029\u202A-\u202E\u2060\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF\u{1BCA0}-\u{1BCA3}\u{E0100}-\u{E01EF}]/u;
const LINK_LABEL_DOT_RE = /[.。．｡]/;
const toLf = (s) => s.replace(/\r\n?/g, '\n');
const DATE_DETAIL = 'a date must be YYYY-MM-DD';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The detail for a refused string (twin of trip-structure.js): the invisible-
// character one only when nothing a person can see — < >, or a line break in
// a one-line field — explains the refusal.
function textDetail(s, multiline) {
  if (/[<>]/.test(s) || (!multiline && /[\n\r]/.test(s)) || !INVISIBLE_RE.test(s)) return TEXT_DETAIL;
  return INVISIBLE_DETAIL;
}

// A link a renderer can put in an href as it stands, going where it reads
// (twin of trip-structure.js). Returned as typed (trimmed), never rewritten.
function safeLink(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s || s.length > 2000 || /[\s"'<>`\\\u0000-\u001F\u007F-\u009F]/.test(s)) return undefined;
  const authority = /^https?:\/\/([^/?#]*)/i.exec(s)?.[1];
  if (authority === undefined) return undefined;
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hostPort.startsWith('[')) {
    const host = hostPort.replace(/:\d*$/, '');
    const labels = host.split(LINK_LABEL_DOT_RE);
    if (labels.length > 1 && labels[labels.length - 1] === '') labels.pop();
    if (!host || host.includes('%') || LINK_HOST_HIDDEN_RE.test(host) || labels.some(l => !l)) return undefined;
  }
  let url;
  try { url = new URL(s); } catch { return undefined; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined;
  return s;
}

// The booking types, ONE list: server/server.js builds the bookings table's
// CHECK constraint from it (byte for byte the text it always had), and
// POST/PATCH /api/bookings refuse anything else with a bilingual 400 instead
// of letting SQLite answer 500. The MCP tools' z.enum lists cannot require
// this file (other checkouts); tests/write-validation.test.js pins them to it.
const BOOKING_TYPES = Object.freeze(['flight', 'hotel', 'car', 'attraction', 'other']);
const BOOKING_TYPE_LABEL = { he: 'סוג ההזמנה', en: 'booking type' };

function isoDay(value) {
  return typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
}

// Characters, not UTF-16 units: an emoji is one character to the person typing it.
const charCount = (s) => [...s].length;

// ── field specs ──────────────────────────────────────────────────────────────
// label: how the field is named to a person, in both languages.
const BOOKING_FIELDS = {
  name:              { kind: 'line', max: 120, label: { he: 'שם ההזמנה', en: 'booking name' } },
  passengers:        { kind: 'line', max: 300, label: { he: 'נוסעים', en: 'passengers' } },
  confirmation:      { kind: 'line', max: 80, label: { he: 'מספר אישור', en: 'confirmation number' } },
  pin:               { kind: 'line', max: 40, label: { he: 'קוד PIN', en: 'PIN' } },
  notes:             { kind: 'multiline', max: 2000, label: { he: 'הערות', en: 'notes' } },
  date_from:         { kind: 'date', label: { he: 'תאריך התחלה', en: 'start date' } },
  date_to:           { kind: 'date', label: { he: 'תאריך סיום', en: 'end date' } },
  location_url:      { kind: 'link', max: 2000, label: { he: 'קישור למיקום', en: 'location link' } },
  google_wallet_url: { kind: 'link', max: 2000, label: { he: 'קישור ל-Google Wallet', en: 'Google Wallet link' } },
  apple_wallet_url:  { kind: 'link', max: 2000, label: { he: 'קישור ל-Apple Wallet', en: 'Apple Wallet link' } },
};

const PARTICIPANT_FIELDS = {
  name:    { kind: 'line', max: 80, label: { he: 'שם המשתתף', en: 'participant name' } },
  name_en: { kind: 'line', max: 80, label: { he: 'שם באנגלית', en: 'English name' } },
  family:  { kind: 'line', max: 80, label: { he: 'משפחה', en: 'family' } },
};

// ── the human message, in both languages ─────────────────────────────────────
// Hebrew is written for an organizer (plural imperative, the way the site
// already addresses people); English is plain. Both name the field the way
// the form does, never by its JSON key alone.
const MESSAGES = {
  angle: (l) => ({
    he: `השדה '${l.he}' מכיל תו שאסור: < או >. הסירו אותו ונסו שוב.`,
    en: `The '${l.en}' field contains a character that isn't allowed: < or >. Remove it and try again.`,
  }),
  newline: (l) => ({
    he: `השדה '${l.he}' צריך להיות שורה אחת. הסירו את ירידת השורה ונסו שוב.`,
    en: `The '${l.en}' field must be a single line. Remove the line break and try again.`,
  }),
  control: (l) => ({
    he: `השדה '${l.he}' מכיל תו בקרה נסתר שאסור. הקלידו את הטקסט מחדש ונסו שוב.`,
    en: `The '${l.en}' field contains a hidden control character that isn't allowed. Retype the text and try again.`,
  }),
  invisible: (l) => ({
    he: `השדה '${l.he}' מכיל תו נסתר שמשנה את כיוון הטקסט או את מראהו. הקלידו אותו מחדש, בלי להדביק.`,
    en: `The '${l.en}' field has a hidden character that changes the text's direction or look. Retype it without pasting.`,
  }),
  type: (l) => ({
    he: `השדה '${l.he}' צריך להכיל טקסט.`,
    en: `The '${l.en}' field must be text.`,
  }),
  booking_type: (l) => ({
    he: `השדה '${l.he}' צריך להיות אחד מהבאים: ${BOOKING_TYPES.join(', ')}. בחרו אחד מהם ונסו שוב.`,
    en: `The '${l.en}' field must be one of: ${BOOKING_TYPES.join(', ')}. Pick one and try again.`,
  }),
  too_long: (l, max) => ({
    he: `השדה '${l.he}' ארוך מדי: עד ${max} תווים. קצרו אותו ונסו שוב.`,
    en: `The '${l.en}' field is too long: up to ${max} characters. Shorten it and try again.`,
  }),
  link: (l) => ({
    he: `הקישור בשדה '${l.he}' לא תקין: צריך כתובת מלאה ב-http:// או https://, בלי רווחים, מירכאות או < >.`,
    en: `The '${l.en}' link isn't valid: use a full http:// or https:// address, no spaces, quotes or < >.`,
  }),
  date: (l) => ({
    he: `השדה '${l.he}' צריך להכיל תאריך תקין בצורה YYYY-MM-DD (למשל 2026-12-02).`,
    en: `The '${l.en}' field needs a valid date written as YYYY-MM-DD (for example 2026-12-02).`,
  }),
  required: (l) => ({
    he: `השדה '${l.he}' לא יכול להיות ריק. כתבו אותו ונסו שוב.`,
    en: `The '${l.en}' field can't be empty. Fill it in and try again.`,
  }),
};

// The 400 body. `message` comes before `detail` on purpose: the site's own MCP
// (server/trip-mcp/index.js siteClient) passes a refusal on capped at 300
// characters, and the human message is what the assistant has to relay.
function refusal(error, field, label, reason, { detail, max } = {}) {
  const body = { error, field, message: MESSAGES[reason](label, max) };
  if (detail) body.detail = detail;
  if (max !== undefined) body.max = max;
  return body;
}

function textReason(s, multiline) {
  if (/[<>]/.test(s)) return 'angle';
  if (!multiline && /[\n\r]/.test(s)) return 'newline';
  if (INVISIBLE_RE.test(s)) return 'invisible';
  return 'control';
}

// A booking's `type`: one of BOOKING_TYPES, as a string — not an array that
// better-sqlite3 would flatten, not null. Returns the 400 body, or null.
function bookingTypeRefusal(value) {
  if (typeof value === 'string' && BOOKING_TYPES.includes(value)) return null;
  return refusal('invalid_type', 'type', BOOKING_TYPE_LABEL, 'booking_type', { detail: `must be one of: ${BOOKING_TYPES.join(', ')}` });
}

// One field. Absent (undefined), null and '' are not checked — the routes keep
// their own meaning for those (POST stores NULL, PATCH clears). Returns
// { value } (what to store) or { error } (the 400 body).
function checkField(field, value, spec) {
  if (value === undefined || value === null || value === '') return { value };
  const { kind, max, label } = spec;
  if (kind === 'date') {
    return isoDay(value) ? { value } : { error: refusal('invalid_date', field, label, 'date', { detail: DATE_DETAIL }) };
  }
  if (kind === 'link') {
    const v = safeLink(value);
    return v === undefined ? { error: refusal('invalid_link', field, label, 'link', { detail: LINK_DETAIL }) } : { value: v };
  }
  // A number is text a JSON client did not quote (a confirmation number, a
  // PIN); anything else — an object, an array, a boolean — is not text at all.
  let s = value;
  if (typeof s === 'number' && Number.isFinite(s)) s = String(s);
  if (typeof s !== 'string') return { error: refusal('invalid_text', field, label, 'type', { detail: 'must be text' }) };
  const multiline = kind === 'multiline';
  // CRLF and a lone CR are a client's line ending, not a hidden character:
  // normalised before the check (and the length) in a multi-line field.
  if (multiline) s = toLf(s);
  if ((multiline ? UNSAFE_MULTILINE_RE : UNSAFE_LINE_RE).test(s)) {
    return { error: refusal('invalid_text', field, label, textReason(s, multiline), { detail: textDetail(s, multiline) }) };
  }
  if (charCount(s) > max) return { error: refusal('text_too_long', field, label, 'too_long', { detail: `at most ${max} characters`, max }) };
  return { value: s };
}

// Every present field of `body` named in `specs`, in spec order; the first
// refusal wins. Returns { values } (only the fields that were present) or
// { error }.
function checkFields(body, specs) {
  const values = {};
  for (const [field, spec] of Object.entries(specs)) {
    if (!body || !Object.hasOwn(body, field)) continue;
    const r = checkField(field, body[field], spec);
    if (r.error) return { error: r.error };
    values[field] = r.value;
  }
  return { values };
}

// A required text field that is missing or only whitespace.
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
function requiredRefusal(error, field, specs) {
  return refusal(error, field, specs[field].label, 'required');
}

// ── extract-draft: clean, never refuse ───────────────────────────────────────
// The draft route's text was read off a PDF by an LLM: nobody typed it, and a
// refusal would leave the organizer with no draft. So each field is cleaned —
// `<`, `>`, control characters and the invisible characters the write refuses
// removed (a line break becomes a space in a one-line field, and stays in
// notes), the length clamped — and a bad date or link is dropped. The
// organizer reviews every draft before it is approved. A number (a PDF's
// confirmation number or PIN, read as a JSON number) is kept as its text, as
// POST /api/bookings keeps it; NaN and Infinity are not text.
const STRIP_LINE_RE = /[<>\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const STRIP_MULTILINE_RE = /[<>\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
function cleanText(value, spec) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const multiline = spec.kind === 'multiline';
  let s = value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  if (!multiline) s = s.replace(/\n+/g, ' ');
  s = s.replace(multiline ? STRIP_MULTILINE_RE : STRIP_LINE_RE, '').trim();
  if (charCount(s) > spec.max) s = [...s].slice(0, spec.max).join('').trim();
  return s || null;
}
const cleanDate = (value) => (typeof value === 'string' ? isoDay(value.trim()) : null);
const cleanLink = (value) => safeLink(value) ?? null;

module.exports = {
  BOOKING_FIELDS, PARTICIPANT_FIELDS, BOOKING_TYPES,
  UNSAFE_LINE_RE, UNSAFE_MULTILINE_RE, INVISIBLE_RE, TEXT_DETAIL, INVISIBLE_DETAIL, LINK_DETAIL,
  safeLink, isoDay, checkField, checkFields, isBlank, requiredRefusal, refusal, bookingTypeRefusal,
  cleanText, cleanDate, cleanLink,
};
