/**
 * plan-review — the judge that reads a provisioned trip's plan and says what
 * is missing from it (Sprint 4.5, the row tagged `separate build`:
 * "Site live-plan enrichment worker").
 *
 * WHY THIS EXISTS, in the organizer's own words after a real provision:
 *
 *   "I would expect to see on the plan first day, landing in NRT, checkin at
 *    14:00 at hotel name, skytree external view and on and on. The daily
 *    itinerary is a list of things to do organized with a rational order, and
 *    allow access to the necessary data to simplify the day, like location,
 *    attractions web site, tickets etc. It checks and sees if the plan makes
 *    sense from effort point of view, fits the group preferred pace."
 *
 * What actually ships today is a day built by `derive_days_from_anchors`
 * (transformer.py): the dated things the organizer had already BOOKED, in
 * clock order, and nothing else. No arrival, no check-in, no transfer between
 * two cities, no place they said they wanted to see but had not ticketed. The
 * plan is not wrong — it is thin, and a thin plan reads as a data dump.
 *
 * THE DIVISION OF LABOUR, and why this is a third module rather than more of
 * `enrichment.py`:
 *
 *   enrichment.py  fills in FACTS that need a lookup — a currency, a lat/lng,
 *                  a hero photo. Its two hard rules are that a failure never
 *                  blocks a deploy and that it never invents a fact.
 *   this module    makes JUDGEMENTS about a plan — what is missing, what is
 *                  out of order, what is too much for this group.
 *
 * A judgement that lands silently on a live trip is a different and much worse
 * thing than a missing hero photo, so nothing here writes to a plan. Every
 * output is a PROPOSAL carrying its own evidence, for an organizer to accept
 * or throw away. `enrichment.py`'s two rules are kept, and a third is added:
 *
 *   1. never block anything — `reviewPlan` cannot throw;
 *   2. never invent a fact — see the gate below;
 *   3. anything that cannot be sourced is asked as a QUESTION, never written
 *      as a proposal. "Check-in is at 14:00" with no evidence is a lie with a
 *      plausible number attached; "what time is check-in?" is useful.
 *
 * THE GATE. Rule 2 is not an aspiration, it is `gateModelProposals` below, and
 * it is the same discipline `interpret.ts` runs on interview proposals —
 * `evidenceAppears` (the quote must be in the source) and `exampleEchoes` (a
 * value that is only in the prompt's own example came from the prompt, not the
 * trip). That gate was written after a live 2026-09-12 intake recorded the
 * example's "Tokyo Skytree" and "TeamLab Planets" as an organizer's plans; the
 * organizer had sent a four-page itinerary naming neither. A plan reviewer is
 * a far WORSE place for that failure to happen — it writes whole itinerary
 * lines rather than one answer, and a family reads them on the day — so it is
 * gated harder: model output may contain no URL at all, and may not name a
 * place the trip does not already name.
 *
 * WHAT IS PURE AND WHAT IS NOT. `auditPlan` is a pure function of the config
 * plus the intake and needs no model; it is the half that runs everywhere and
 * is what the tests mostly exercise. The model half only ever ADDS proposals
 * that survive the gate, so a deployment with no runner configured gets a
 * strictly smaller review rather than a broken one — and says so out loud
 * (`modelUsed`/`modelSkipped` on the result), because an unannounced downgrade
 * is the failure mode CLAUDE.md's interview section was written about.
 */
import { createHash } from "node:crypto";
import { evidenceAppears, exampleEchoes } from "./interpret.js";
import type { StructuredModelRunner, RunnerFailure } from "./model-runner.js";

// ── The plan, as this module reads it ────────────────────────────────────────

export interface Bi {
  he: string;
  en: string;
}

export interface PlanItem {
  /**
   * `<phaseId>|<YYYY-MM-DD>|<index>` — deliberately the SAME identity the trip
   * site gives a config-imported itinerary item (`CONFIG_REF_RE` /
   * `config_ref` in server/living-journey.js). A proposal that says "reorder
   * these three" has to name rows the site can find, and re-running the review
   * against the same config has to produce the same keys or the queue fills
   * with duplicates of itself. Both come free by borrowing the site's key
   * instead of minting a parallel one.
   */
  key: string;
  phaseId: string;
  date: string;
  index: number;
  /** HH:MM, or null for "some time that day". */
  time: string | null;
  text: Bi;
  links: { maps?: string; waze?: string; url?: string };
}

export interface PlanDay {
  phaseId: string;
  date: string;
  label: Bi | null;
  items: PlanItem[];
}

export interface PlanVenue {
  name: Bi;
  /** Neighbourhood/district, when the extractor captured one. */
  area: string;
  /** Official or ticket URL. Empty when neither the document nor the venue
   *  store had one — which is itself worth asking about. */
  url: string;
  maps: string;
}

export interface PlanPhase {
  id: string;
  title: Bi;
  /** ISO dates. Empty when the config carried none — every rule that needs a
   *  range checks first rather than assuming. */
  start: string;
  end: string;
  hotel: { name: string; confirmation: string } | null;
  days: PlanDay[];
  venues: PlanVenue[];
}

export interface Plan {
  destination: string;
  phases: PlanPhase[];
}

// ── What the group said they wanted ──────────────────────────────────────────

export type Pace = "easygoing" | "balanced" | "intense";

export interface Traveler {
  name: string;
  age: number | null;
}

/** A flight/activity the organizer has already booked, as `travel_anchors`
 *  carries it. The review needs these for the one thing the config drops:
 *  what time the plane actually lands. */
export interface Anchor {
  type: string;
  name: string;
  date: string | null;
  time: string | null;
  detail: string;
}

export interface Group {
  /** Absent means "they never answered the pace question". No pace finding is
   *  produced in that case — see `paceFindings`. */
  pace: Pace | null;
  travelers: Traveler[];
  anchors: Anchor[];
  /** The free text of `constraints`, joined. Quoted as evidence when it moves
   *  a pace budget. */
  constraints: string;
}

// ── What comes out ───────────────────────────────────────────────────────────

export type PlanSeverity = "info" | "warning";

export type PlanProposalKind =
  /** A concrete line to add to a day, with evidence for every word of it. */
  | "add_item"
  /** The day's existing items, in the order they should actually run. */
  | "reorder_day"
  /** A location / official site / ticket link for a line that has none. */
  | "attach_link"
  /** The day does not fit the pace the group ASKED FOR. Never a patch — how
   *  to fix an overfull day is the organizer's call, not ours. */
  | "pace"
  /** The day cannot happen as written, whatever pace anyone wanted: a hop
   *  between two districts with no time to make it. Arithmetic, not taste,
   *  which is why it is a separate kind — it fires on a trip that never
   *  answered the pace question. */
  | "feasibility"
  /** We could not source it. Asked, never written. */
  | "question";

export interface PlanEvidence {
  /**
   * `config`   — quoted from the deployed trip.config.json.
   * `intake`   — quoted from the confirmed intake answers.
   * `document` — quoted from the plan document the organizer uploaded.
   * `derived`  — arithmetic over the above (a count, a gap in minutes). The
   *              quote then states the arithmetic, so a reader can redo it.
   */
  source: "config" | "intake" | "document" | "derived";
  quote: string;
}

export type PlanPatch =
  | { op: "add_item"; phaseId: string; date: string; time: string | null; text: Bi }
  | { op: "reorder_day"; phaseId: string; date: string; order: string[] }
  | { op: "attach_link"; itemKey: string; links: { maps?: string; waze?: string; url?: string } };

export interface PlanProposal {
  /** Stable across re-runs of the same review over the same plan, so the queue
   *  dedups instead of growing a copy per pass. */
  id: string;
  kind: PlanProposalKind;
  severity: PlanSeverity;
  phaseId: string;
  date: string | null;
  /** One organizer-facing line. Plain text. */
  title: string;
  detail: string;
  /** For `question` — the thing to actually ask. */
  ask: string;
  /** Absent for `question` and `pace`: there is nothing to apply. */
  patch?: PlanPatch;
  /** Never empty. A proposal with no evidence is not emitted. */
  evidence: PlanEvidence[];
  origin: "rules" | "model";
}

export type ModelRejectReason =
  /** The quoted span is in neither the document nor the config. */
  | "EVIDENCE_NOT_IN_SOURCE"
  /** A value whose only provenance is the prompt's own example. */
  | "EXAMPLE_ECHO"
  /** A place the trip does not name anywhere. */
  | "UNKNOWN_PLACE"
  /** Model output containing a URL. Links come from the venue store, never
   *  from a model's recollection. */
  | "MODEL_SUPPLIED_URL"
  /** A reorder that added, dropped or renamed a row. */
  | "NOT_A_PERMUTATION"
  /** A date outside the phase, a time that is not HH:MM, empty text. */
  | "MALFORMED";

export interface ModelRejection {
  reason: ModelRejectReason;
  detail: string;
}

export interface PlanReview {
  generatedAt: string;
  /**
   * How many legs the review could actually read. Zero means the plan did not
   * parse as one — and that is NOT the same as a plan with nothing wrong in
   * it, which is why the queue checks this before concluding that findings it
   * raised last time have been fixed. A corrupt snapshot must not read as an
   * organizer who tidied everything up.
   */
  phasesReviewed: number;
  proposals: PlanProposal[];
  /** True when a model pass ran AND produced at least one accepted proposal. */
  modelUsed: boolean;
  /**
   * Why the model half did not contribute, when it did not. Never silent: a
   * review that quietly ran at half strength looks exactly like a plan with
   * nothing wrong in it.
   */
  modelSkipped: "NO_RUNNER" | RunnerFailure | null;
  rejected: ModelRejection[];
}

// ── Reading the config ───────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Plain text, one line. The trip site renders a config day's text as raw HTML
 *  (`_biSpan` in site/app.js), so anything this module writes into a proposal
 *  has to arrive without markup — the same reason `itinerary-extract.ts`
 *  strips it at the other end of the pipeline. */
function plain(value: unknown): string {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

function bi(value: unknown): Bi {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const node = value as Record<string, unknown>;
    const he = plain(node.he);
    const en = plain(node.en);
    if (he || en) return { he: he || en, en: en || he };
  }
  const flat = plain(value);
  return { he: flat, en: flat };
}

/** A venue name, in either shape the pipeline produces: the transformer writes
 *  `{name: {he, en}}`, the hand-built trips write `{name, name_he}`. Both reach
 *  this module — `enrichment._enrich_venues` already had to learn the same
 *  lesson, which is why it reads `name` as either a dict or a string. */
function venueName(raw: Record<string, unknown>): Bi {
  if (raw.name && typeof raw.name === "object") return bi(raw.name);
  const en = plain(raw.name);
  const he = plain(raw.name_he) || en;
  return { he: he || en, en: en || he };
}

function httpUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

/** Read the deployed trip.config.json into the shape the rules work on.
 *  Tolerant by construction: a phase with no dates, a day with no items and a
 *  venue with no name all survive as empties rather than throwing, because
 *  this runs against configs produced by two different generations of the
 *  pipeline plus four hand-authored trips. */
export function readPlan(config: unknown, destination = ""): Plan {
  const root = (config ?? {}) as Record<string, unknown>;
  const rawPhases = Array.isArray(root.phases) ? root.phases : [];
  const phases: PlanPhase[] = [];
  for (const entry of rawPhases) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const id = plain(raw.id);
    if (!id) continue;
    const dates = (raw.dates ?? {}) as Record<string, unknown>;
    const start = ISO_DATE.test(plain(dates.start)) ? plain(dates.start) : "";
    const end = ISO_DATE.test(plain(dates.end)) ? plain(dates.end) : "";

    const acc = raw.accommodation && typeof raw.accommodation === "object"
      ? (raw.accommodation as Record<string, unknown>)
      : null;
    const hotelName = acc ? plain(acc.name_en) || plain(acc.name) : "";

    const days: PlanDay[] = [];
    for (const dayEntry of Array.isArray(raw.days) ? raw.days : []) {
      if (!dayEntry || typeof dayEntry !== "object") continue;
      const day = dayEntry as Record<string, unknown>;
      const date = plain(day.date);
      if (!ISO_DATE.test(date)) continue;
      const items: PlanItem[] = [];
      const rawItems = Array.isArray(day.items) ? day.items : [];
      rawItems.forEach((itemEntry, index) => {
        if (!itemEntry || typeof itemEntry !== "object") return;
        const item = itemEntry as Record<string, unknown>;
        const text = bi(item.text);
        if (!text.en && !text.he) return;
        const time = plain(item.time);
        items.push({
          key: `${id}|${date}|${index}`,
          phaseId: id,
          date,
          index,
          time: HHMM.test(time) ? time : null,
          text,
          links: {
            ...(httpUrl(item.maps) ? { maps: httpUrl(item.maps) } : {}),
            ...(httpUrl(item.waze) ? { waze: httpUrl(item.waze) } : {}),
            ...(httpUrl(item.url) ? { url: httpUrl(item.url) } : {}),
          },
        });
      });
      const label = day.label !== undefined ? bi(day.label) : null;
      days.push({ phaseId: id, date, label: label && (label.he || label.en) ? label : null, items });
    }
    days.sort((a, b) => a.date.localeCompare(b.date));

    const venues: PlanVenue[] = [];
    for (const venueEntry of Array.isArray(raw.venues) ? raw.venues : []) {
      if (!venueEntry || typeof venueEntry !== "object") continue;
      const venue = venueEntry as Record<string, unknown>;
      const name = venueName(venue);
      if (!name.en && !name.he) continue;
      venues.push({ name, area: plain(venue.area), url: httpUrl(venue.url), maps: httpUrl(venue.maps) });
    }

    phases.push({
      id,
      title: bi(raw.title ?? raw.tabLabel),
      start,
      end,
      hotel: hotelName ? { name: hotelName, confirmation: acc ? plain(acc.confirmation) : "" } : null,
      days,
      venues,
    });
  }
  phases.sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999"));
  return { destination: plain(destination), phases };
}

// ── Reading the intake ───────────────────────────────────────────────────────

const PACES: ReadonlySet<string> = new Set(["easygoing", "balanced", "intense"]);

function structuredList(answers: Record<string, unknown>, id: string): Record<string, unknown>[] {
  const answer = answers[id];
  if (!answer || typeof answer !== "object") return [];
  const node = answer as Record<string, unknown>;
  if (node.kind !== "structured" || !Array.isArray(node.data)) return [];
  return node.data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
}

/** The 24-hour clock inside a free-text anchor ("…at 10:00", "14:02"). The
 *  transformer parses exactly this for the same reason; reading it here rather
 *  than re-deriving it differently keeps the two from disagreeing about what
 *  an anchor says. */
const CLOCK_IN_TEXT = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

/** Read the confirmed intake. Everything is optional: a review of a config
 *  with no intake to hand (a hand-authored trip, the CLI run against
 *  `trips/japan-2025`) still produces every finding that needs only the
 *  config, and simply produces no pace or arrival finding. */
export function readGroup(answers: unknown): Group {
  const data = (answers ?? {}) as Record<string, unknown>;

  const paceAnswer = data.trip_pace as Record<string, unknown> | undefined;
  const paceId = paceAnswer && paceAnswer.kind === "choice" ? plain(paceAnswer.option_id) : "";
  const pace = PACES.has(paceId) ? (paceId as Pace) : null;

  const travelers: Traveler[] = structuredList(data, "travelers").map((row) => {
    const age = Number(row.age);
    return {
      name: plain(row.name_en) || plain(row.name),
      age: Number.isFinite(age) && age > 0 && age < 120 ? Math.round(age) : null,
    };
  });

  const anchors: Anchor[] = structuredList(data, "travel_anchors").map((row) => {
    const name = plain(row.name) || plain(row.title);
    const detail = plain(row.detail) || plain(row.note) || plain(row.text);
    const stated = plain(row.date) || plain(row.date_from) || plain(row.start);
    const statedTime = plain(row.time);
    const found = CLOCK_IN_TEXT.exec(`${name} ${detail}`);
    return {
      type: plain(row.type).toLowerCase(),
      name,
      date: ISO_DATE.test(stated) ? stated : null,
      time: HHMM.test(statedTime)
        ? statedTime
        : found
          ? `${(found[1] ?? "0").padStart(2, "0")}:${found[2] ?? "00"}`
          : null,
      detail,
    };
  });

  const constraintsAnswer = data.constraints as Record<string, unknown> | undefined;
  const constraintsData =
    constraintsAnswer && constraintsAnswer.kind === "structured" && constraintsAnswer.data && typeof constraintsAnswer.data === "object"
      ? (constraintsAnswer.data as Record<string, unknown>)
      : {};
  const constraints = Object.values(constraintsData).map(plain).filter(Boolean).join(" · ");

  return { pace, travelers, anchors, constraints };
}

// ── Recognising what a line already says ─────────────────────────────────────
//
// A generated day is bilingual, and half the trips on this platform are
// Hebrew-first, so every recogniser below has to read both sides or it will
// cheerfully report that a Hebrew plan has no arrival on it. The Hebrew
// spellings include the two apostrophe characters real text actually uses
// (U+05F3 geresh and a plain ASCII quote) — a live config carries both.

const ARRIVAL_WORDS = [
  "land", "landing", "arrive", "arrival", "flight", "fly to", "touch down",
  "נחית", "נחיתה", "טיסה", "הגעה",
];
const CHECKIN_WORDS = [
  "check-in", "check in", "checkin", "drop luggage", "drop bags", "hotel arrival",
  "צ׳ק-אין", "צ'ק-אין", "צ׳ק אין", "צ'ק אין", "קבלת חדר", "כניסה למלון",
];
const CHECKOUT_WORDS = [
  "check-out", "check out", "checkout", "leave the hotel", "luggage storage",
  "צ׳ק-אאוט", "צ'ק-אאוט", "צ׳ק אאוט", "צ'ק אאוט", "עזיבת המלון", "פינוי חדר",
];
const TRANSFER_WORDS = [
  "train", "shinkansen", "bus", "transfer", "drive", "ferry", "taxi", "rental car",
  "רכבת", "אוטובוס", "הסעה", "נסיעה", "מעבר", "מעבורת", "מונית",
];

/**
 * A flight designator — two letters and a number, "LY075", "BA2490".
 *
 * `derive_days_from_anchors` (transformer.py) puts a dated flight anchor on
 * the day as its own label, which on a real intake reads "LY075 TLV-NRT" and
 * matches none of ARRIVAL_WORDS. Without this the pass looked at a day that
 * already had the flight on it and proposed adding the flight — which is the
 * kind of finding that teaches an organizer the queue is not worth opening.
 *
 * Matched against the ORIGINAL casing, which is what makes it a designator
 * rather than any two letters followed by a digit.
 */
const FLIGHT_DESIGNATOR = /\b[A-Z]{2}\d{2,4}\b/;

function namesAFlight(item: PlanItem): boolean {
  return FLIGHT_DESIGNATOR.test(`${item.text.en} ${item.text.he}`);
}

function haystack(item: PlanItem): string {
  return `${item.text.en} ${item.text.he}`.toLowerCase();
}

function mentions(item: PlanItem, words: readonly string[]): boolean {
  const hay = haystack(item);
  return words.some((word) => hay.includes(word.toLowerCase()));
}

/** Is this line logistics rather than a stop? Used only by the pace budget:
 *  "how many things are we trying to see" is the question the pace answer
 *  actually answers, and a check-in is not one of them. Counting every line
 *  instead made a well-built day (japan-2025's arrival day: land, train,
 *  check-in, Asakusa, Skytree, dinner) look like six things to do. */
function isLogistics(item: PlanItem): boolean {
  return mentions(item, ARRIVAL_WORDS) || mentions(item, CHECKIN_WORDS)
    || mentions(item, CHECKOUT_WORDS) || mentions(item, TRANSFER_WORDS)
    || namesAFlight(item);
}

function minutes(time: string): number {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return h * 60 + m;
}

function addDays(date: string, delta: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

function datesBetween(start: string, end: string): string[] {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end) || end < start) return [];
  const out: string[] = [];
  // A phase is a stay, not an era. 60 days is well past any real leg and
  // stops a corrupted date pair from generating a proposal per day for a year.
  for (let date = start; date <= end && out.length < 60; date = addDays(date, 1)) out.push(date);
  return out;
}

/**
 * The generic word a venue list puts on the end of a name that an itinerary
 * line leaves off. "Gion District" is a venue on japan-2025; its days say
 * "Gion in the evening" and "Higashiyama / Gion", and matching on the full
 * name reported a place the plan visits twice as never scheduled.
 */
const TRAILING_CATEGORY_WORDS: ReadonlySet<string> = new Set([
  "district", "area", "quarter", "neighbourhood", "neighborhood",
  "street", "alley", "market", "station", "temple", "shrine", "park",
  "museum", "castle", "tower", "building", "gardens", "garden",
]);

/**
 * Match candidates for a venue name: each language side, plus that side with
 * one trailing word dropped when that word is generic or is the city's own
 * name. Mirrors `_venue_name_variants` in enrichment.py — a source document
 * writes "TeamLab Planets" for a venue the store holds as "TeamLab Planets
 * Tokyo".
 *
 * Two guards, both earned. Four characters minimum, or a short name collides
 * with a coincidental substring. And a trimmed variant that turns out to BE
 * the city ("Osaka Castle" → "osaka") is thrown away: it would match every
 * line of the leg and report the castle as scheduled on a day that never
 * mentions it — a false negative, which is the direction that fails silently.
 */
function venueNeedles(venue: PlanVenue, phase: PlanPhase, destination: string): string[] {
  const places = new Set(
    [phase.title.en, phase.title.he, destination].map((word) => word.trim().toLowerCase()).filter(Boolean),
  );
  const out: string[] = [];
  for (const side of [venue.name.en, venue.name.he]) {
    const text = side.trim();
    if (!text) continue;
    const words = text.split(/\s+/);
    const variants = [text];
    const last = (words.at(-1) ?? "").toLowerCase();
    if (words.length >= 2 && (places.has(last) || TRAILING_CATEGORY_WORDS.has(last))) {
      variants.push(words.slice(0, -1).join(" "));
    }
    for (const variant of variants) {
      const key = variant.toLowerCase();
      if (key.length >= 4 && !places.has(key) && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

function itemNamesVenue(item: PlanItem, needles: readonly string[]): boolean {
  const hay = haystack(item);
  return needles.some((needle) => hay.includes(needle));
}

// ── Proposal construction ────────────────────────────────────────────────────

/**
 * The proposal's identity. Kind + where it lands + what it says, hashed — the
 * same shape as `issueFingerprint` in the trip site's living-journey.js, and
 * for the same reason: a review that runs again after a re-provision must
 * recognise its own earlier finding rather than filing a second copy of it,
 * and an organizer who dismissed one must not have it come back.
 *
 * Deliberately NOT including the evidence or the severity: a finding whose
 * wording improves is still the same finding.
 */
export function proposalId(parts: { kind: string; phaseId: string; date: string | null; subject: string }): string {
  const digest = createHash("sha256")
    .update([parts.kind, parts.phaseId, parts.date ?? "", parts.subject].join("|"))
    .digest("hex");
  return `prop_${digest.slice(0, 20)}`;
}

interface DraftProposal {
  kind: PlanProposalKind;
  severity?: PlanSeverity;
  phaseId: string;
  date?: string | null;
  /** Stable identity input — the thing the proposal is ABOUT, not its wording. */
  subject: string;
  title: string;
  detail?: string;
  ask?: string;
  patch?: PlanPatch;
  evidence: PlanEvidence[];
  origin?: "rules" | "model";
}

function propose(draft: DraftProposal): PlanProposal | null {
  const evidence = draft.evidence.filter((entry) => plain(entry.quote).length > 0);
  // Rule 3, enforced rather than remembered: a proposal with nothing behind it
  // is dropped here, at the one place proposals are built, instead of relying
  // on each rule to have checked.
  if (evidence.length === 0) return null;
  return {
    id: proposalId({ kind: draft.kind, phaseId: draft.phaseId, date: draft.date ?? null, subject: draft.subject }),
    kind: draft.kind,
    severity: draft.severity ?? "info",
    phaseId: draft.phaseId,
    date: draft.date ?? null,
    title: plain(draft.title),
    detail: plain(draft.detail ?? ""),
    ask: plain(draft.ask ?? ""),
    ...(draft.patch ? { patch: draft.patch } : {}),
    evidence: evidence.map((entry) => ({ source: entry.source, quote: plain(entry.quote).slice(0, 400) })),
    origin: draft.origin ?? "rules",
  };
}

// ── The rules ────────────────────────────────────────────────────────────────

/** How many STOPS a day may hold before the pace answer says it is too many,
 *  and how long the day may run end to end. The numbers come from the option
 *  labels the organizer actually tapped (interview.ts `trip_pace`):
 *  "late starts, few things a day" / "a main plan a day, room to drift" /
 *  "early starts, pack it in". `earliestStart` only exists for easygoing,
 *  because that is the only option that makes a promise about the morning. */
const PACE_BUDGET: Record<Pace, { stops: number; spanMinutes: number; earliestStart: string | null }> = {
  easygoing: { stops: 3, spanMinutes: 9 * 60, earliestStart: "08:30" },
  balanced: { stops: 5, spanMinutes: 11 * 60, earliestStart: null },
  intense: { stops: 7, spanMinutes: 13 * 60, earliestStart: null },
};

const PACE_QUOTE: Record<Pace, string> = {
  easygoing: "trip_pace = easygoing — late starts, few things a day",
  balanced: "trip_pace = balanced — a main plan a day, room to drift",
  intense: "trip_pace = intense — early starts, pack it in",
};

/** A day where two stops in different districts are scheduled this close
 *  together is a day that cannot happen as written. Deliberately generous:
 *  the check only fires between two places the config itself puts in DIFFERENT
 *  areas, so it is describing a real hop across a city, and 35 minutes is
 *  below what such a hop costs anywhere this platform has sent anyone. A
 *  tighter number would be right more often and wrong in public. */
const MIN_CROSS_AREA_MINUTES = 35;

function itemsOn(phase: PlanPhase, date: string): PlanItem[] {
  return phase.days.find((day) => day.date === date)?.items ?? [];
}

/**
 * "First day, landing in NRT" — the organizer's first example, and the one
 * thing trip.config.json cannot tell you: it carries no flight and no landing
 * time. `travel_anchors` does, when the organizer gave one.
 *
 * So: a flight anchor with a time, and a first day that says nothing about
 * arriving, becomes a proposal quoting that anchor. A trip with no flight
 * anchor becomes a QUESTION, never a guess — "Land at NRT 09:00" invented for
 * a family flying into Haneda is exactly the failure this module exists to
 * avoid.
 */
function arrivalFindings(plan: Plan, group: Group): PlanProposal[] {
  const out: PlanProposal[] = [];
  const first = plan.phases[0];
  if (!first || !first.start) return out;

  const arrivalDate = first.start;
  const onDay = itemsOn(first, arrivalDate);
  if (onDay.some((item) => mentions(item, ARRIVAL_WORDS) || namesAFlight(item))) return out;

  const flight = group.anchors.find(
    (anchor) => anchor.type === "flight" && anchor.date === arrivalDate,
  );
  if (flight && flight.time) {
    const label = flight.name || flight.detail;
    const text: Bi = { he: `נחיתה — ${label}`, en: `Land — ${label}` };
    const found = propose({
      kind: "add_item",
      severity: "warning",
      phaseId: first.id,
      date: arrivalDate,
      subject: "arrival",
      title: `The trip starts with no arrival on it — add the landing at ${flight.time}`,
      detail: `${arrivalDate} is the first day of the trip and nothing on it says you have arrived.`,
      patch: { op: "add_item", phaseId: first.id, date: arrivalDate, time: flight.time, text },
      evidence: [
        { source: "intake", quote: `travel_anchors: ${flight.type} ${label} ${flight.date ?? ""} ${flight.time}`.trim() },
      ],
    });
    if (found) out.push(found);
    return out;
  }

  const found = propose({
    kind: "question",
    severity: "warning",
    phaseId: first.id,
    date: arrivalDate,
    subject: "arrival",
    title: "The first day has no arrival on it",
    detail: "The plan starts mid-day with nothing that says how the trip begins.",
    ask: `What time do you land on ${arrivalDate}, and at which airport? I will not guess one.`,
    evidence: [
      { source: "config", quote: `phase ${first.id} starts ${arrivalDate}` },
      { source: "derived", quote: `no item on ${arrivalDate} mentions an arrival (${onDay.length} item(s) on the day)` },
    ],
  });
  if (found) out.push(found);
  return out;
}

/**
 * "Checkin at 14:00 at hotel name" — the second example. The hotel name is in
 * the config; the hour is not, and no source this pass can read carries it, so
 * the item is proposed WITHOUT a time and the hour is asked for alongside.
 * Half a fact is still a fact; a plausible 14:00 attached to a hotel that
 * checks in at 16:00 is a family sitting in a lobby.
 */
function lodgingFindings(plan: Plan): PlanProposal[] {
  const out: PlanProposal[] = [];
  for (const phase of plan.phases) {
    if (!phase.hotel || !phase.start) continue;
    // Deliberately `itemsOn` rather than "the day, if the config has one": a
    // leg whose first day is blank needs the check-in MORE, not less, and an
    // earlier version that skipped a missing day silently dropped the
    // proposal on exactly the thinnest trips this pass exists for.
    const onDay = itemsOn(phase, phase.start);
    if (onDay.some((item) => mentions(item, CHECKIN_WORDS))) continue;
    const hotel = phase.hotel.name;
    const found = propose({
      kind: "add_item",
      severity: "warning",
      phaseId: phase.id,
      date: phase.start,
      subject: `checkin:${hotel}`,
      title: `No check-in on the first day at ${hotel}`,
      detail:
        "Proposed without a time on purpose — nothing in the config, the intake or the document says what hour "
        + "this hotel checks in, and a guessed hour is worse than a missing one.",
      ask: `What time is check-in at ${hotel}?`,
      patch: {
        op: "add_item",
        phaseId: phase.id,
        date: phase.start,
        time: null,
        text: { he: `צ׳ק-אין / השארת מזוודות — ${hotel}`, en: `Check-in / drop luggage — ${hotel}` },
      },
      evidence: [
        { source: "config", quote: `phase ${phase.id} accommodation: ${hotel}` },
        { source: "derived", quote: `no item on ${phase.start} mentions a check-in` },
      ],
    });
    if (found) out.push(found);
  }
  return out;
}

/**
 * The hand-off between two stops. Two phases that meet — B starts the day A
 * ends, or the day after — and nothing on the boundary day says how the group
 * gets from one to the other. Asked, not proposed: "Shinkansen to Kyoto" is a
 * guess about a booking, and this platform has already shipped one plan whose
 * only transport was a model's assumption.
 */
function transferFindings(plan: Plan): PlanProposal[] {
  const out: PlanProposal[] = [];
  for (let i = 1; i < plan.phases.length; i++) {
    const previous = plan.phases[i - 1];
    const next = plan.phases[i];
    if (!previous || !next || !previous.end || !next.start) continue;
    // A gap of more than a day between two legs is not a transfer this pass
    // understands — something else is happening in between.
    if (next.start !== previous.end && next.start !== addDays(previous.end, 1)) continue;
    const boundary = [previous.end, next.start].filter((v, idx, arr) => arr.indexOf(v) === idx);
    const boundaryItems = boundary.flatMap((date) => [...itemsOn(previous, date), ...itemsOn(next, date)]);
    if (boundaryItems.some(
      (item) => mentions(item, TRANSFER_WORDS) || mentions(item, ARRIVAL_WORDS) || namesAFlight(item),
    )) continue;
    const from = previous.title.en || previous.title.he;
    const to = next.title.en || next.title.he;
    const found = propose({
      kind: "question",
      severity: "warning",
      phaseId: next.id,
      date: next.start,
      subject: `transfer:${previous.id}->${next.id}`,
      title: `Nothing says how you get from ${from} to ${to}`,
      detail: `${from} ends ${previous.end} and ${to} starts ${next.start}, with no travel on either day.`,
      ask: `How are you travelling from ${from} to ${to} on ${next.start} — train, car, or a flight? If it is booked, the confirmation number can go on the plan too.`,
      evidence: [
        { source: "config", quote: `phase ${previous.id} ends ${previous.end}; phase ${next.id} starts ${next.start}` },
        { source: "derived", quote: `${boundaryItems.length} item(s) across ${boundary.join(" / ")}, none of them travel` },
      ],
    });
    if (found) out.push(found);
  }
  return out;
}

/**
 * Clock order. Purely arithmetic and therefore proposed as a concrete patch
 * rather than asked about: if the day already carries times, the order they
 * should run in is not a matter of opinion. Untimed items keep their relative
 * position at the end, which is what the site does when it renders them
 * (`COALESCE(time_sort, 99999)` in living-journey.js) — moving them would be
 * a change nobody asked for.
 */
function orderingFindings(plan: Plan): PlanProposal[] {
  const out: PlanProposal[] = [];
  for (const phase of plan.phases) {
    for (const day of phase.days) {
      const timed = day.items.filter((item) => item.time !== null);
      if (timed.length < 2) continue;
      const inOrder = [...timed].sort((a, b) => minutes(a.time!) - minutes(b.time!) || a.index - b.index);
      if (inOrder.every((item, i) => item.key === timed[i]?.key)) continue;
      const untimed = day.items.filter((item) => item.time === null);
      const order = [...inOrder, ...untimed].map((item) => item.key);
      const found = propose({
        kind: "reorder_day",
        severity: "warning",
        phaseId: phase.id,
        date: day.date,
        subject: "order",
        title: `${day.date} is not in clock order`,
        detail: inOrder.map((item) => `${item.time} ${item.text.en || item.text.he}`).join(" → "),
        patch: { op: "reorder_day", phaseId: phase.id, date: day.date, order },
        evidence: [
          {
            source: "config",
            quote: timed.map((item) => `${item.time} ${item.text.en || item.text.he}`).join(" | "),
          },
        ],
      });
      if (found) out.push(found);
    }
  }
  return out;
}

/**
 * A place the trip means to see that is on no day. `phases[].venues[]` is
 * exactly that list — the transformer fills it from the intake's `planned`
 * answer and the extractor fills it from the document — and today it renders
 * as a card beside an itinerary that never mentions it.
 *
 * Which day it should go on is a judgement, so the rules half asks. The model
 * half can upgrade the same finding to a concrete day, and reuses this
 * proposal's subject so the two never appear side by side.
 */
function unscheduledVenueFindings(plan: Plan): PlanProposal[] {
  const out: PlanProposal[] = [];
  for (const phase of plan.phases) {
    if (!phase.venues.length) continue;
    const allItems = phase.days.flatMap((day) => day.items);
    for (const venue of phase.venues) {
      const needles = venueNeedles(venue, phase, plan.destination);
      if (!needles.length) continue;
      if (allItems.some((item) => itemNamesVenue(item, needles))) continue;
      const name = venue.name.en || venue.name.he;
      const where = phase.title.en || phase.title.he;
      const found = propose({
        kind: "question",
        phaseId: phase.id,
        date: null,
        subject: `unscheduled:${name.toLowerCase()}`,
        title: `${name} is on the list for ${where} but on no day`,
        detail: venue.area ? `Listed under ${venue.area}.` : "",
        ask: `Which day should ${name} go on? The days in ${where} are ${
          phase.days.map((day) => day.date).join(", ") || "not laid out yet"
        }.`,
        evidence: [
          { source: "config", quote: `phase ${phase.id} venues[]: ${name}${venue.area ? ` (${venue.area})` : ""}` },
          { source: "derived", quote: `no item across ${allItems.length} line(s) in ${phase.id} names it` },
        ],
      });
      if (found) out.push(found);
    }
  }
  return out;
}

/**
 * "Allow access to the necessary data to simplify the day, like location,
 * attractions web site, tickets."
 *
 * Two different holes, and they want two different answers:
 *  - the line names a venue the config ALREADY has a link for, and the link
 *    never reached the line. That is a patch, from data already on the trip.
 *    (`_carry_venue_links_to_days` in enrichment.py does this at provision
 *    time; this catches what it missed — a venue resolved by the drain after
 *    the trip was built, or a line that names the place in the other language.)
 *  - the venue has no link at all. Nothing on the trip can fill that, so it is
 *    a question. Notably the TICKET question: whether a place needs booking
 *    ahead is the one thing a bare itinerary line never tells you, and the
 *    trip site already has the columns for the answer (`needs_tickets`,
 *    `advance_booking` on phase_plan_items).
 */
function dataFindings(plan: Plan): PlanProposal[] {
  const out: PlanProposal[] = [];
  for (const phase of plan.phases) {
    const linked = phase.venues
      .map((venue) => ({ venue, needles: venueNeedles(venue, phase, plan.destination) }))
      .filter((entry) => entry.needles.length > 0)
      // Longest needle first, so "Tokyo Station" wins over a bare "Tokyo" when
      // a phase carries both — the same ordering enrichment.py uses.
      .sort((a, b) => Math.max(...b.needles.map((n) => n.length)) - Math.max(...a.needles.map((n) => n.length)));

    for (const day of phase.days) {
      for (const item of day.items) {
        if (item.links.maps || item.links.url) continue;
        const match = linked.find((entry) => itemNamesVenue(item, entry.needles));
        if (!match) continue;
        const links = {
          ...(match.venue.maps ? { maps: match.venue.maps } : {}),
          ...(match.venue.url ? { url: match.venue.url } : {}),
        };
        if (!links.maps && !links.url) continue;
        const name = match.venue.name.en || match.venue.name.he;
        const found = propose({
          kind: "attach_link",
          phaseId: phase.id,
          date: day.date,
          subject: `link:${item.key}`,
          title: `${day.date}: "${item.text.en || item.text.he}" has no link, and ${name} has one`,
          detail: Object.entries(links).map(([key, value]) => `${key}: ${value}`).join(" · "),
          patch: { op: "attach_link", itemKey: item.key, links },
          evidence: [{ source: "config", quote: `phase ${phase.id} venues[]: ${name} → ${links.url || links.maps}` }],
        });
        if (found) out.push(found);
      }
    }

    const allItems = phase.days.flatMap((day) => day.items);
    for (const venue of phase.venues) {
      if (venue.url) continue;
      const needles = venueNeedles(venue, phase, plan.destination);
      // A place that is on no day at all gets ONE question, and it is
      // `unscheduledVenueFindings`' — which day does it go on. Asking whether
      // it needs tickets first is asking about the logistics of something that
      // is not yet in the plan, and two questions about one venue is how a
      // queue stops being read.
      if (!needles.length || !allItems.some((item) => itemNamesVenue(item, needles))) continue;
      const name = venue.name.en || venue.name.he;
      const found = propose({
        kind: "question",
        phaseId: phase.id,
        date: null,
        subject: `ticketing:${name.toLowerCase()}`,
        title: `No official or ticket link for ${name}`,
        detail: "Neither the document nor the cross-trip venue store had one.",
        ask: `Does ${name} need tickets, and do they have to be bought in advance? A link to the official site would put a 🎫 on the day.`,
        evidence: [{ source: "config", quote: `phase ${phase.id} venues[]: ${name} — no url` }],
      });
      if (found) out.push(found);
    }
  }
  return out;
}

/**
 * The effort check. Only ever runs when the group ANSWERED the pace question:
 * `trip_pace` is optional, and a judgement about whether a day is too full,
 * made against a pace nobody stated, is this module inventing a preference and
 * then enforcing it.
 *
 * Three separate readings, because they fail differently:
 *  - too many stops for the pace;
 *  - a day that runs longer end-to-end than the pace implies;
 *  - an easygoing group with a day that starts before 08:30, which is the one
 *    concrete promise that option's label makes ("late starts").
 *
 * The budget drops by one stop when the roster has a young child or someone
 * over 75, or when `constraints` says anything at all — the intake asks about
 * mobility there, and a group that wrote something into it is a group that
 * will feel a full day differently. Both adjustments are quoted in the
 * evidence, so the organizer can see exactly why the bar moved.
 */
function paceFindings(plan: Plan, group: Group): PlanProposal[] {
  const out: PlanProposal[] = [];
  if (!group.pace) return out;
  const budget = PACE_BUDGET[group.pace];
  const paceEvidence: PlanEvidence = { source: "intake", quote: PACE_QUOTE[group.pace] };

  const tender = group.travelers.filter((t) => t.age !== null && (t.age < 6 || t.age > 75));
  const adjustments: PlanEvidence[] = [];
  let stopBudget = budget.stops;
  if (tender.length) {
    stopBudget -= 1;
    adjustments.push({
      source: "intake",
      quote: `travelers: ${tender.map((t) => `${t.name || "traveller"} (${t.age})`).join(", ")}`,
    });
  }
  if (group.constraints) {
    stopBudget -= 1;
    adjustments.push({ source: "intake", quote: `constraints: ${group.constraints}` });
  }
  stopBudget = Math.max(1, stopBudget);

  for (const phase of plan.phases) {
    for (const day of phase.days) {
      const stops = day.items.filter((item) => !isLogistics(item));
      if (stops.length > stopBudget) {
        const found = propose({
          kind: "pace",
          severity: "warning",
          phaseId: phase.id,
          date: day.date,
          subject: "stops",
          title: `${day.date} has ${stops.length} stops on it; this group asked for about ${stopBudget}`,
          detail: stops.map((item) => item.text.en || item.text.he).join(" · "),
          ask: "Which of these would you drop, or move to another day?",
          evidence: [
            paceEvidence,
            ...adjustments,
            { source: "derived", quote: `${stops.length} non-logistics item(s) on ${day.date} against a budget of ${stopBudget}` },
          ],
        });
        if (found) out.push(found);
      }

      const timed = day.items.filter((item) => item.time !== null).map((item) => minutes(item.time!));
      if (timed.length >= 2) {
        const span = Math.max(...timed) - Math.min(...timed);
        if (span > budget.spanMinutes) {
          const found = propose({
            kind: "pace",
            severity: "warning",
            phaseId: phase.id,
            date: day.date,
            subject: "span",
            title: `${day.date} runs ${Math.round((span / 60) * 10) / 10} hours end to end`,
            detail: `An ${group.pace} pace works out at about ${budget.spanMinutes / 60} hours of day.`,
            ask: "Worth trimming either end?",
            evidence: [
              paceEvidence,
              {
                source: "derived",
                quote: `first timed item ${day.items.find((i) => i.time)?.time}, last ${
                  day.items.filter((i) => i.time).slice(-1)[0]?.time
                }`,
              },
            ],
          });
          if (found) out.push(found);
        }
      }

      if (budget.earliestStart) {
        const earliest = day.items
          .filter((item) => item.time !== null)
          .sort((a, b) => minutes(a.time!) - minutes(b.time!))[0];
        if (earliest && minutes(earliest.time!) < minutes(budget.earliestStart)) {
          const found = propose({
            kind: "pace",
            phaseId: phase.id,
            date: day.date,
            subject: "early-start",
            title: `${day.date} starts at ${earliest.time}, and this group asked for late starts`,
            detail: earliest.text.en || earliest.text.he,
            ask: "Is that start fixed, or can it move later?",
            evidence: [
              paceEvidence,
              { source: "config", quote: `${earliest.time} ${earliest.text.en || earliest.text.he}` },
            ],
          });
          if (found) out.push(found);
        }
      }
    }
  }
  return out;
}

/**
 * "The transfer that does not fit between two fixed points." Two consecutive
 * timed stops that the config itself places in different districts, with less
 * time between them than the hop costs. Only fires when both lines map to a
 * venue carrying an `area`, which is what keeps it from firing on two stops in
 * the same neighbourhood that genuinely are 20 minutes apart.
 */
function feasibilityFindings(plan: Plan): PlanProposal[] {
  const out: PlanProposal[] = [];
  for (const phase of plan.phases) {
    const areaed = phase.venues
      .filter((venue) => venue.area)
      .map((venue) => ({ venue, needles: venueNeedles(venue, phase, plan.destination) }));
    if (areaed.length < 2) continue;

    for (const day of phase.days) {
      const timed = day.items
        .filter((item) => item.time !== null)
        .sort((a, b) => minutes(a.time!) - minutes(b.time!));
      for (let i = 1; i < timed.length; i++) {
        const before = timed[i - 1];
        const after = timed[i];
        if (!before || !after || before.time === null || after.time === null) continue;
        const beforeArea = areaed.find((entry) => itemNamesVenue(before, entry.needles))?.venue.area;
        const afterArea = areaed.find((entry) => itemNamesVenue(after, entry.needles))?.venue.area;
        if (!beforeArea || !afterArea || beforeArea === afterArea) continue;
        const gap = minutes(after.time!) - minutes(before.time!);
        if (gap >= MIN_CROSS_AREA_MINUTES) continue;
        const found = propose({
          kind: "feasibility",
          severity: "warning",
          phaseId: phase.id,
          date: day.date,
          subject: `hop:${before.key}->${after.key}`,
          title: `${gap} minutes between ${beforeArea} and ${afterArea} on ${day.date}`,
          detail: `${before.time} ${before.text.en || before.text.he} → ${after.time} ${after.text.en || after.text.he}`,
          ask: "Does that hop fit, or should one of them move?",
          evidence: [
            { source: "config", quote: `${before.time} ${before.text.en || before.text.he} (${beforeArea})` },
            { source: "config", quote: `${after.time} ${after.text.en || after.text.he} (${afterArea})` },
            { source: "derived", quote: `${gap} minutes apart, in different areas` },
          ],
        });
        if (found) out.push(found);
      }
    }
  }
  return out;
}

/**
 * A date inside a phase with no day at all, or a day with no lines on it.
 * Asked rather than filled: an empty day is sometimes deliberate.
 *
 * Phases OVERLAP at their edges by design — a leg that ends 10 Sep and the
 * next that starts 10 Sep are one travel day, and the config puts that day's
 * items on exactly one of the two. Reading each phase alone reported three
 * blank days on japan-2025, every one of which was a day the plan describes
 * in full under the other leg. So a date is blank only if it is blank
 * everywhere.
 */
function emptyDayFindings(plan: Plan): PlanProposal[] {
  const out: PlanProposal[] = [];
  const plannedDates = new Set(
    plan.phases.flatMap((phase) => phase.days.filter((day) => day.items.length).map((day) => day.date)),
  );
  // One finding per blank DATE, not per (phase, date). A boundary day belongs
  // to two phases and asking about it twice is the same noise as reporting it
  // under the leg whose plan it is not. The arriving leg owns it — that is
  // where the day's content will end up — so the later phase wins.
  const ownerPhase = new Map<string, string>();
  for (const phase of plan.phases) {
    for (const date of datesBetween(phase.start, phase.end)) ownerPhase.set(date, phase.id);
  }
  for (const phase of plan.phases) {
    const all = datesBetween(phase.start, phase.end);
    if (!all.length) continue;
    // A phase with no days at all is one finding, not one per date — a leg the
    // organizer has not planned yet does not need seven identical prompts.
    if (!phase.days.length) {
      const found = propose({
        kind: "question",
        severity: "warning",
        phaseId: phase.id,
        date: phase.start,
        subject: "no-days",
        title: `${phase.title.en || phase.title.he} has no day-by-day at all`,
        detail: `${all.length} day(s), ${phase.start} to ${phase.end}, with nothing on any of them.`,
        ask: `What are you doing in ${phase.title.en || phase.title.he}? Even a few places per day is enough for me to lay it out.`,
        evidence: [
          { source: "config", quote: `phase ${phase.id}: ${phase.start} → ${phase.end}, days[] empty` },
        ],
      });
      if (found) out.push(found);
      continue;
    }
    for (const date of all) {
      if (plannedDates.has(date)) continue;
      if (ownerPhase.get(date) !== phase.id) continue;
      const found = propose({
        kind: "question",
        phaseId: phase.id,
        date,
        subject: "empty-day",
        title: `${date} is blank`,
        detail: `Every other day in ${phase.title.en || phase.title.he} has something on it.`,
        ask: `Is ${date} a rest day, or is it just not planned yet?`,
        evidence: [{ source: "config", quote: `phase ${phase.id} covers ${date}; no items on it` }],
      });
      if (found) out.push(found);
    }
  }
  return out;
}

/** A day whose lines carry no times at all. The site sorts untimed items to
 *  the end of the day, so a day of them has no shape — it is a list, which is
 *  the complaint. */
function untimedDayFindings(plan: Plan): PlanProposal[] {
  const out: PlanProposal[] = [];
  for (const phase of plan.phases) {
    for (const day of phase.days) {
      if (day.items.length < 2) continue;
      if (day.items.some((item) => item.time !== null)) continue;
      const found = propose({
        kind: "question",
        phaseId: phase.id,
        date: day.date,
        subject: "untimed",
        title: `${day.date} has ${day.items.length} things on it and no times`,
        detail: day.items.map((item) => item.text.en || item.text.he).join(" · "),
        ask: `What time does ${day.date} start, and is that order the one you want?`,
        evidence: [
          { source: "config", quote: day.items.map((item) => item.text.en || item.text.he).join(" | ") },
          { source: "derived", quote: `${day.items.length} item(s), none with a time` },
        ],
      });
      if (found) out.push(found);
    }
  }
  return out;
}

/**
 * Everything the rules can see, with no model involved. Pure, total, and
 * ordered so a reader meets a day's problems in the order they would hit them:
 * what is missing, then what is out of order, then what is too much.
 */
export function auditPlan(plan: Plan, group: Group): PlanProposal[] {
  const proposals = [
    ...arrivalFindings(plan, group),
    ...lodgingFindings(plan),
    ...transferFindings(plan),
    ...emptyDayFindings(plan),
    ...orderingFindings(plan),
    ...untimedDayFindings(plan),
    ...unscheduledVenueFindings(plan),
    ...dataFindings(plan),
    ...paceFindings(plan, group),
    ...feasibilityFindings(plan),
  ];
  // Two rules can legitimately reach the same conclusion about the same thing.
  // The queue wants one row per finding, and the ids already say which are the
  // same finding, so dedup here rather than making every rule check the others.
  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    if (seen.has(proposal.id)) return false;
    seen.add(proposal.id);
    return true;
  });
}

// ── The model half ───────────────────────────────────────────────────────────

/**
 * The task name this pass asks `model-runner.ts` for. A separate task from
 * `interpret` and `extract` on purpose — the runner's whole reason for
 * existing is that model choice is per task and lives in configuration, and
 * this task wants something that reasons about a schedule rather than
 * something cheap and precise or something with long context.
 */
export const PLAN_REVIEW_TASK = "plan_review";

/**
 * The example in the prompt. It exists so the model uses the right FIELD
 * names, and its values are deliberately drab and unusable — "Place A",
 * "09:00" — because the realistic example is what produced the 2026-09-12
 * incident `exampleEchoes` was written for. `exampleEchoes` still runs over
 * it; this is belt and braces, not a replacement.
 */
const PROMPT_EXAMPLE = JSON.stringify({
  days: [
    {
      date: "2026-01-01",
      headline: { he: "כותרת", en: "Headline for the day" },
      order: ["phase|2026-01-01|1", "phase|2026-01-01|0"],
      add: [{ time: "09:00", text: { he: "טקסט", en: "One line" }, place: "Place A", evidence: "the line of the document this came from" }],
    },
  ],
});

export interface PlanReviewPromptArgs {
  plan: Plan;
  group: Group;
  /** The uploaded document's plain text. "" when there was none. */
  documentText: string;
  /** One phase per call — a whole trip does not fit a sensible context, and a
   *  failure then costs the whole review rather than one leg. */
  phase: PlanPhase;
}

/** Everything the model is allowed to draw on, as one string. Also the
 *  haystack `evidenceAppears` checks against: a quote the model attributes to
 *  "the plan" has to be IN the plan. */
export function reviewSourceText(args: PlanReviewPromptArgs): string {
  const lines: string[] = [];
  const { phase } = args;
  lines.push(`PHASE ${phase.id}: ${phase.title.en} / ${phase.title.he}  ${phase.start} → ${phase.end}`);
  if (phase.hotel) lines.push(`ACCOMMODATION: ${phase.hotel.name}`);
  for (const venue of phase.venues) {
    lines.push(`VENUE: ${venue.name.en} / ${venue.name.he}${venue.area ? ` — ${venue.area}` : ""}`);
  }
  for (const day of phase.days) {
    lines.push(`DAY ${day.date}${day.label ? ` — ${day.label.en}` : ""}`);
    for (const item of day.items) {
      lines.push(`  ${item.key}  ${item.time ?? "--:--"}  ${item.text.en} / ${item.text.he}`);
    }
  }
  if (args.group.pace) lines.push(`PACE: ${PACE_QUOTE[args.group.pace]}`);
  for (const traveler of args.group.travelers) {
    lines.push(`TRAVELLER: ${traveler.name}${traveler.age !== null ? ` (${traveler.age})` : ""}`);
  }
  if (args.documentText) {
    lines.push("DOCUMENT:");
    // Capped: the gate reads this whole string on every proposal, and a 200k
    // character PDF turns an O(n) check into the slowest thing in the pass.
    lines.push(args.documentText.slice(0, 60_000));
  }
  return lines.join("\n");
}

export function buildPlanReviewPrompt(args: PlanReviewPromptArgs): string {
  return [
    "You are reviewing one leg of a family trip that has already been built into a website.",
    "Your job is to make the day-by-day read like a plan a person would follow, using ONLY what is below.",
    "",
    "HARD RULES — output that breaks any of them is discarded by the caller, not corrected:",
    "  * Never name a place that does not appear below. Not a nearby museum, not a better restaurant.",
    "  * Never output a URL. Links are attached from the trip's own data, never from you.",
    "  * Every entry in `add` must carry `evidence`: a line copied EXACTLY from the material below",
    "    that shows the thing is part of this trip. No evidence, no entry.",
    "  * `order` may only reorder the keys already listed for that day. Do not add or drop one.",
    "  * `time` is HH:MM or null. Never invent a time you cannot point at.",
    "",
    "Produce JSON only, in this shape:",
    PROMPT_EXAMPLE,
    "",
    "Where:",
    "  days[].date      one of the dates listed below",
    "  days[].headline  what the day IS, in both languages — a name, not a sentence. Optional.",
    "  days[].order     that day's keys, in the order the day should actually run. Optional.",
    "  days[].add       lines missing from the day. Each needs place + evidence. Optional.",
    "",
    "=== THE TRIP ===",
    reviewSourceText(args),
  ].join("\n");
}

/**
 * Advisory schema for adapters that can enforce one (Codex's --output-schema,
 * OpenRouter structured outputs). It never replaces the parse+gate below —
 * a schema describes what the model was ASKED for; the gate decides what we
 * are willing to believe.
 */
export const PLAN_REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["days"],
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date"],
        properties: {
          date: { type: "string" },
          headline: {
            type: "object",
            additionalProperties: false,
            required: ["he", "en"],
            properties: { he: { type: "string" }, en: { type: "string" } },
          },
          order: { type: "array", items: { type: "string" } },
          add: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "place", "evidence"],
              properties: {
                time: { type: ["string", "null"] },
                text: {
                  type: "object",
                  additionalProperties: false,
                  required: ["he", "en"],
                  properties: { he: { type: "string" }, en: { type: "string" } },
                },
                place: { type: "string" },
                evidence: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

export interface ModelDayAdd {
  time: string | null;
  text: Bi;
  place: string;
  evidence: string;
}

export interface ModelDay {
  date: string;
  headline: Bi | null;
  order: string[];
  add: ModelDayAdd[];
}

export interface PlanReviewPayload {
  days: ModelDay[];
}

/** Total: anything it does not accept becomes null, and the runner turns that
 *  into BAD_OUTPUT rather than a half-read answer. Same contract as
 *  `parseInterpretPayload`. */
export function parsePlanReviewPayload(raw: unknown): PlanReviewPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.days)) return null;
  const days: ModelDay[] = [];
  for (const entry of root.days) {
    if (!entry || typeof entry !== "object") continue;
    const node = entry as Record<string, unknown>;
    const date = plain(node.date);
    if (!ISO_DATE.test(date)) continue;
    const headline = node.headline !== undefined && node.headline !== null ? bi(node.headline) : null;
    const order = Array.isArray(node.order) ? node.order.map(plain).filter(Boolean) : [];
    const add: ModelDayAdd[] = [];
    for (const addEntry of Array.isArray(node.add) ? node.add : []) {
      if (!addEntry || typeof addEntry !== "object") continue;
      const row = addEntry as Record<string, unknown>;
      const text = bi(row.text);
      if (!text.en && !text.he) continue;
      const time = plain(row.time);
      add.push({
        time: HHMM.test(time) ? time : null,
        text,
        place: plain(row.place),
        evidence: String(row.evidence ?? ""),
      });
    }
    days.push({ date, headline: headline && (headline.he || headline.en) ? headline : null, order, add });
  }
  return { days };
}

const URL_ANYWHERE = /https?:\/\/|www\./i;

export interface GateResult {
  proposals: PlanProposal[];
  rejected: ModelRejection[];
}

/**
 * The gate. Everything the model said, checked against what the trip actually
 * contains, and dropped rather than repaired when it does not line up.
 *
 * `interpret.ts`'s two checks are reused verbatim — `evidenceAppears` and
 * `exampleEchoes` — and two more are added that only matter when a model is
 * writing whole itinerary lines rather than filling one answer:
 *
 *   UNKNOWN_PLACE       the line names something the trip does not. This is
 *                       the "invented museum" case, and it is the one a
 *                       reader of the finished site could never catch: a
 *                       plausible restaurant on a plausible street reads
 *                       exactly like a real one.
 *   MODEL_SUPPLIED_URL  any URL at all. Not "a URL that 404s" — any. Links on
 *                       this platform come from the venue store, the source
 *                       document, or a name search built from data we hold
 *                       (`enrichment._maps_search_url`). A model-recalled
 *                       ticket link is the single most expensive thing this
 *                       pass could get wrong: it sends someone to a gate
 *                       holding the wrong booking.
 */
export function gateModelProposals(
  payload: PlanReviewPayload,
  args: PlanReviewPromptArgs,
): GateResult {
  const source = reviewSourceText(args);
  const proposals: PlanProposal[] = [];
  const rejected: ModelRejection[] = [];
  const { phase } = args;

  // Two lists, matched differently, and the split is load-bearing. A VENUE
  // matches loosely in both directions ("Planets" for "teamLab Planets",
  // "Senso-ji Temple" for "Senso-ji"), because a model naming a real place
  // slightly differently is the normal case. A CITY matches only exactly:
  // with a loose check, the phase title "Tokyo" accepted "Edo-Tokyo Museum",
  // which is a museum this trip has never heard of arriving through the one
  // gate that exists to stop it.
  const knownVenues = [
    ...phase.venues.flatMap((venue) => [venue.name.en, venue.name.he]),
    ...(phase.hotel ? [phase.hotel.name] : []),
  ]
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length >= 4);
  const knownCities = [phase.title.en, phase.title.he, args.plan.destination]
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  for (const day of payload.days) {
    const planDay = phase.days.find((candidate) => candidate.date === day.date);
    if (!planDay) {
      rejected.push({ reason: "MALFORMED", detail: `date ${day.date} is not a day of phase ${phase.id}` });
      continue;
    }

    if (day.order.length) {
      const existing = planDay.items.map((item) => item.key);
      const sameSet =
        day.order.length === existing.length && [...day.order].sort().join("|") === [...existing].sort().join("|");
      if (!sameSet) {
        rejected.push({ reason: "NOT_A_PERMUTATION", detail: `${day.date}: ${day.order.join(",")}` });
      } else if (day.order.join("|") !== existing.join("|")) {
        // A reorder proposed by a model competes with `orderingFindings`,
        // which is arithmetic. Arithmetic wins: the id is the same, and the
        // rules pass is merged first, so this one is dropped by the dedup.
        const found = propose({
          kind: "reorder_day",
          phaseId: phase.id,
          date: day.date,
          subject: "order",
          title: `A different order for ${day.date}`,
          detail: day.order
            .map((key) => planDay.items.find((item) => item.key === key))
            .map((item) => (item ? `${item.time ?? "--:--"} ${item.text.en || item.text.he}` : ""))
            .filter(Boolean)
            .join(" → "),
          patch: { op: "reorder_day", phaseId: phase.id, date: day.date, order: day.order },
          evidence: [{ source: "config", quote: planDay.items.map((item) => item.text.en || item.text.he).join(" | ") }],
          origin: "model",
        });
        if (found) proposals.push(found);
      }
    }

    if (day.headline && !planDay.label) {
      const headlineText = `${day.headline.en} ${day.headline.he}`;
      if (URL_ANYWHERE.test(headlineText)) {
        rejected.push({ reason: "MODEL_SUPPLIED_URL", detail: `${day.date} headline` });
      } else {
        const echoed = exampleEchoes(PROMPT_EXAMPLE, day.headline, source);
        if (echoed.length) {
          rejected.push({ reason: "EXAMPLE_ECHO", detail: `${day.date} headline: ${echoed.join(", ")}` });
        } else {
          const found = propose({
            kind: "add_item",
            phaseId: phase.id,
            date: day.date,
            subject: "headline",
            title: `${day.date} has no headline — proposed: ${day.headline.en}`,
            detail: day.headline.he,
            // A headline is not an item; it is the day's own label, and the
            // site stores it on phase_plan_days. No patch until the queue
            // that applies these knows how to write one.
            evidence: [{ source: "config", quote: planDay.items.map((item) => item.text.en || item.text.he).join(" | ") }],
            origin: "model",
          });
          if (found) proposals.push(found);
        }
      }
    }

    for (const add of day.add) {
      const label = `${day.date} "${add.text.en || add.text.he}"`;
      const body = `${add.text.en} ${add.text.he} ${add.place}`;
      if (URL_ANYWHERE.test(body)) {
        rejected.push({ reason: "MODEL_SUPPLIED_URL", detail: label });
        continue;
      }
      const place = add.place.trim().toLowerCase();
      const recognised =
        place.length >= 4
        && (knownCities.includes(place)
          || knownVenues.some((known) => place.includes(known) || known.includes(place)));
      if (!recognised) {
        rejected.push({ reason: "UNKNOWN_PLACE", detail: `${label} → ${add.place || "(none)"}` });
        continue;
      }
      if (!evidenceAppears(add.evidence, source)) {
        rejected.push({ reason: "EVIDENCE_NOT_IN_SOURCE", detail: label });
        continue;
      }
      const echoed = exampleEchoes(PROMPT_EXAMPLE, add.text, source);
      if (echoed.length) {
        rejected.push({ reason: "EXAMPLE_ECHO", detail: `${label}: ${echoed.join(", ")}` });
        continue;
      }
      // Already on the day, in either language — the model re-proposing a line
      // that is there is not an error worth reporting, just nothing to do.
      if (planDay.items.some((item) => haystack(item).includes((add.text.en || add.text.he).toLowerCase()))) continue;

      const found = propose({
        kind: "add_item",
        phaseId: phase.id,
        date: day.date,
        subject: `add:${(add.text.en || add.text.he).toLowerCase()}`,
        title: `${day.date}: add "${add.text.en || add.text.he}"${add.time ? ` at ${add.time}` : ""}`,
        detail: add.place,
        patch: { op: "add_item", phaseId: phase.id, date: day.date, time: add.time, text: add.text },
        evidence: [{ source: args.documentText ? "document" : "config", quote: add.evidence }],
        origin: "model",
      });
      if (found) proposals.push(found);
    }
  }

  return { proposals, rejected };
}

// ── The pass ─────────────────────────────────────────────────────────────────

export interface ReviewPlanArgs {
  config: unknown;
  answers?: unknown;
  destination?: string;
  documentText?: string;
  /** Absent means the deterministic half only, and `modelSkipped: NO_RUNNER`
   *  on the result — never a silent downgrade. */
  runner?: StructuredModelRunner;
  now?: () => Date;
}

/**
 * The whole pass. Cannot throw: a review that fails takes a provisioned trip's
 * enrichment down with it in exactly the way `enrich_config` was written not
 * to, and this runs on a background loop where the only visible symptom would
 * be a queue that stopped filling.
 *
 * The rules half runs first and its proposals are merged first, so where a
 * rule and the model reach the same finding (same id) the ARITHMETIC survives
 * the dedup and the model's version is dropped.
 */
export async function reviewPlan(args: ReviewPlanArgs): Promise<PlanReview> {
  const now = args.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  let plan: Plan;
  let group: Group;
  try {
    plan = readPlan(args.config, args.destination ?? "");
    group = readGroup(args.answers);
  } catch {
    return { generatedAt, phasesReviewed: 0, proposals: [], modelUsed: false, modelSkipped: "NO_RUNNER", rejected: [] };
  }

  let proposals: PlanProposal[] = [];
  try {
    proposals = auditPlan(plan, group);
  } catch {
    proposals = [];
  }

  if (!args.runner) {
    return { generatedAt, phasesReviewed: plan.phases.length, proposals, modelUsed: false, modelSkipped: "NO_RUNNER", rejected: [] };
  }

  const rejected: ModelRejection[] = [];
  let accepted = 0;
  let lastFailure: RunnerFailure | null = null;

  for (const phase of plan.phases) {
    // A leg with nothing on it has nothing for a model to reorder or complete,
    // and `emptyDayFindings` has already asked the only useful question about
    // it. Spending a model call on it is spending it on a blank page.
    if (!phase.days.length) continue;
    const promptArgs: PlanReviewPromptArgs = {
      plan,
      group,
      documentText: args.documentText ?? "",
      phase,
    };
    let result;
    try {
      result = await args.runner.run({
        task: PLAN_REVIEW_TASK,
        prompt: buildPlanReviewPrompt(promptArgs),
        schema: PLAN_REVIEW_SCHEMA,
        parse: parsePlanReviewPayload,
      });
    } catch {
      lastFailure = "FAILED";
      continue;
    }
    if (!result.ok) {
      lastFailure = result.reason;
      continue;
    }
    let gated: GateResult;
    try {
      gated = gateModelProposals(result.value, promptArgs);
    } catch {
      rejected.push({ reason: "MALFORMED", detail: `phase ${phase.id}` });
      continue;
    }
    rejected.push(...gated.rejected);
    for (const proposal of gated.proposals) {
      if (proposals.some((existing) => existing.id === proposal.id)) continue;
      proposals.push(proposal);
      accepted += 1;
    }
  }

  return {
    generatedAt,
    phasesReviewed: plan.phases.length,
    proposals,
    modelUsed: accepted > 0,
    // A pass that ran and found nothing to add is not a skip; a pass where
    // every phase failed is, and it names the reason the runner gave.
    modelSkipped: accepted > 0 ? null : lastFailure,
    rejected,
  };
}
