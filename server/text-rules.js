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
// TWIN: UNSAFE_LINE_RE, UNSAFE_MULTILINE_RE, TEXT_DETAIL, LINK_DETAIL and
// safeLink() are copies of the same names in server/trip-structure.js (the
// stop layer), duplicated rather than imported because that file belongs to
// another line of work and exports none of them. Change one, change both.
// Existing stored data is never rewritten here, and nothing on the read path
// calls this file: reading an old value can never fail on it.
'use strict';

const UNSAFE_LINE_RE = /[<>\u0000-\u001F\u007F-\u009F]/;
const UNSAFE_MULTILINE_RE = /[<>\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
const TEXT_DETAIL = 'text may not contain < > or control characters';
const LINK_DETAIL = 'a link must be an absolute http(s) URL with a host, and no quotes, < >, or whitespace';
const DATE_DETAIL = 'a date must be YYYY-MM-DD';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A link a renderer can put in an href as it stands (twin of trip-structure.js).
function safeLink(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s || s.length > 2000 || /[\s"'<>`\u0000-\u001F\u007F-\u009F]/.test(s)) return undefined;
  let url;
  try { url = new URL(s); } catch { return undefined; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined;
  return s;
}

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
  type: (l) => ({
    he: `השדה '${l.he}' צריך להכיל טקסט.`,
    en: `The '${l.en}' field must be text.`,
  }),
  too_long: (l, max) => ({
    he: `השדה '${l.he}' ארוך מדי: עד ${max} תווים. קצרו אותו ונסו שוב.`,
    en: `The '${l.en}' field is too long: up to ${max} characters. Shorten it and try again.`,
  }),
  link: (l) => ({
    he: `הקישור בשדה '${l.he}' לא תקין: צריך כתובת https:// מלאה, בלי רווחים, מירכאות או < >.`,
    en: `The '${l.en}' link isn't valid: use a full https:// address, with no spaces, quotes or < >.`,
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
  return 'control';
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
  if ((multiline ? UNSAFE_MULTILINE_RE : UNSAFE_LINE_RE).test(s)) {
    return { error: refusal('invalid_text', field, label, textReason(s, multiline), { detail: TEXT_DETAIL }) };
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
// `<`, `>` and control characters removed (a line break becomes a space in a
// one-line field, and stays in notes), the length clamped — and a bad date or
// link is dropped. The organizer reviews every draft before it is approved.
const STRIP_LINE_RE = /[<>\u0000-\u001F\u007F-\u009F]/g;
const STRIP_MULTILINE_RE = /[<>\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
function cleanText(value, spec) {
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
  BOOKING_FIELDS, PARTICIPANT_FIELDS,
  UNSAFE_LINE_RE, UNSAFE_MULTILINE_RE, TEXT_DETAIL, LINK_DETAIL,
  safeLink, isoDay, checkField, checkFields, isBlank, requiredRefusal, refusal,
  cleanText, cleanDate, cleanLink,
};
