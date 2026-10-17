/**
 * Documents after confirmation: changes proposed to the organizer, never written.
 *
 * WHO OWNS A DOCUMENT THAT ARRIVES AFTER CONFIRMATION: this flow (decided
 * 2026-09-13). Such a file used to go to the companion gateway, where the
 * trip-confirmation-intake skill read it and wrote bookings straight onto the
 * site through MCP — a second, independent lifecycle for the same facts the
 * intake holds, with no approval step and no provenance. Now the organizer's
 * document goes through the same pipeline as during the interview (registry,
 * per-document extraction, the reconciling gate), and what it would change is
 * PROPOSED here. Only the organizer's approval turns a proposal into a new
 * immutable intake version (`correctIntake`), which re-provisions the site the
 * way confirming did. The skill stays a fallback for what this flow does not
 * take: files posted in groups or by other members, and relays with no model.
 *
 * SWITCHED OFF UNLESS CONFIGURED (2026-09-26): the organizer's private-chat
 * route into this flow runs only with ORGANIZER_DOCUMENT_ROUTE_ENABLED=1 on the
 * relay. Off, the organizer's file keeps the companion route it had before
 * #178 — see `ORGANIZER_DOCUMENT_ROUTE_SETTING` below for why.
 *
 * WHAT A MODEL NEVER DECIDES HERE: whether anything changes (the organizer),
 * who the organizer is (the confirmed interview's own private chat, and the
 * sender Telegram delivered), and which version a change applies to (the one it
 * was computed against; anything newer makes it stale, except a single replaced
 * field whose held value is still exactly what was shown).
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { applyConflictChoice, canonical, entryIdentity, isRecord } from "./answer-merge.js";
import { recordAnswerSources, type AnswerSource } from "./answer-provenance.js";
import { correctionCallbackData } from "./chat-router.js";
import { gateDocumentProposals, type DocumentGateResult, type DocumentReading } from "./document-gate.js";
import { listTripDocuments } from "./document-registry.js";
import { correctIntake } from "./intake-correction.js";
import { readableDate, recapLabel, UI_STRINGS, uiString, type Language } from "./intake-copy.js";
import { INTAKE_QUESTIONS, partitionQuestions, type AnswerStore } from "./interview.js";
import { structuredLog } from "./redaction.js";

type Db = Pick<pg.Pool, "query">;

export type CorrectionKind = "changes" | "replace";
export type CorrectionStatus = "pending" | "applying" | "approved" | "rejected" | "stale" | "failed";

export interface CorrectionChange {
  questionId: string;
  kind: "answered" | "added" | "filled" | "replaced";
  /** `entryIdentity` of the entry, or "" for the answer as a whole. */
  entryKey: string;
  paths: string[];
  /** What identifies the entry to a person — its name and dates, as stored. */
  entry: { name: string | null; start: string | null; end: string | null } | null;
  held?: unknown;
  value?: unknown;
}

export interface ProposedCorrection {
  kind: CorrectionKind;
  proposedAnswers: AnswerStore;
  changes: CorrectionChange[];
  sources: AnswerSource[];
}

export interface DocumentCorrection extends ProposedCorrection {
  id: string;
  tripId: string;
  baseVersionId: string;
  baseDigest: string;
  documentIds: string[];
  requestedChatId: string;
  status: CorrectionStatus;
  failureReason: string | null;
  resultVersionId: string | null;
}

interface CorrectionRow {
  id: string;
  trip_id: string;
  kind: CorrectionKind;
  base_version_id: string;
  base_digest: string;
  proposed_answers: AnswerStore;
  changes: CorrectionChange[];
  sources: AnswerSource[];
  document_ids: string[];
  requested_chat_id: string;
  status: CorrectionStatus;
  failure_reason: string | null;
  result_version_id: string | null;
}

const COLUMNS =
  "id, trip_id, kind, base_version_id, base_digest, proposed_answers, changes, sources, document_ids, requested_chat_id, status, failure_reason, result_version_id";

function toCorrection(row: CorrectionRow): DocumentCorrection {
  return {
    id: row.id,
    tripId: row.trip_id,
    kind: row.kind,
    baseVersionId: row.base_version_id,
    baseDigest: row.base_digest,
    proposedAnswers: row.proposed_answers,
    changes: row.changes ?? [],
    sources: row.sources ?? [],
    documentIds: row.document_ids ?? [],
    requestedChatId: row.requested_chat_id,
    status: row.status,
    failureReason: row.failure_reason,
    resultVersionId: row.result_version_id,
  };
}

// ── Who, and against what ────────────────────────────────────────────────────

/** The confirmed record a document is read against: the trip's latest intake version. */
export async function latestIntakeVersion(
  db: Db,
  tripId: string,
): Promise<{ id: string; version: number; digest: string; answers: AnswerStore } | null> {
  const res = await db.query<{ id: string; version: number; digest: string; data: AnswerStore | null }>(
    "SELECT id, version, digest, data FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
    [tripId],
  );
  const row = res.rows[0];
  return row ? { id: row.id, version: row.version, digest: row.digest, answers: row.data ?? {} } : null;
}

/**
 * The organizer's own chat for a trip: the private chat its interview was
 * confirmed in. The same authority every write during the interview had.
 */
export async function confirmedOrganizerChat(
  db: Db,
  tripId: string,
  chatId: string,
): Promise<{ sessionId: string; language: Language } | null> {
  const res = await db.query<{ id: string; language: string | null }>(
    `SELECT id, language FROM control_plane.intake_sessions
      WHERE trip_id = $1 AND telegram_chat_id = $2 AND state = 'confirmed'
      ORDER BY updated_at DESC LIMIT 1`,
    [tripId, chatId],
  );
  const row = res.rows[0];
  return row ? { sessionId: row.id, language: row.language === "he" ? "he" : "en" } : null;
}

// ── Whether this flow is switched on at all ──────────────────────────────────

/**
 * The relay setting that switches the organizer's private-chat route ON.
 * Generic on purpose: it names no host, path or deployment.
 *
 * OFF UNLESS CONFIGURED (owner's decision, 2026-09-26, Release A). An Approve
 * here writes a new intake version and re-provisions the site — for a trip
 * that is `ready_private` that is a REDEPLOY, from whatever release is newest
 * at the time, in the middle of the family's holiday. Live trips are
 * redeployed only after they end (docs/sprint6-tracks.md decisions 11, 12,
 * 28), so shipping this code must never be what switches it on. Off, such a
 * file goes where it went before #178: to the companion. Like
 * `ASSISTANT_EVENTS_ENABLED`, and unlike `INTERPRET_*`, unset is the safe
 * state — do not "fix" this into default-on. What has to happen before it is
 * turned on anywhere real: docs/document-intake-operations.md.
 */
export const ORGANIZER_DOCUMENT_ROUTE_SETTING = "ORGANIZER_DOCUMENT_ROUTE_ENABLED";

/**
 * Whether the route is on. ONLY the exact value `1` enables it — stricter
 * than `ASSISTANT_EVENTS_ENABLED`, which forgives surrounding whitespace:
 * this gate decides whether a live trip can be rebuilt, so " 1" from a
 * hand-edited env file is off, and says so. Unset, empty and `0` are off
 * quietly; anything else is off and flagged as unrecognized, so a typo in the
 * enabling direction is visible rather than a silent no-op.
 */
export function organizerDocumentRouteSetting(env: NodeJS.ProcessEnv): { enabled: boolean; unrecognized: boolean } {
  const raw = env[ORGANIZER_DOCUMENT_ROUTE_SETTING];
  if (raw === "1") return { enabled: true, unrecognized: false };
  const knownOff = raw === undefined || raw === "" || raw === "0";
  return { enabled: false, unrecognized: !knownOff };
}

/**
 * Read once, when the relay starts. Always logs the state it chose — the
 * post-deploy log read proves the flag from this line — and never the raw
 * value it was given.
 */
export function organizerDocumentRouteFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void): boolean {
  const setting = organizerDocumentRouteSetting(env);
  if (setting.unrecognized) {
    log(structuredLog("warn", "relay.organizer_document_route_setting_unrecognized", {
      setting: ORGANIZER_DOCUMENT_ROUTE_SETTING,
      hint: "only 1 enables the organizer's private-chat document route; treating this as off",
    }));
  }
  log(structuredLog("info", "relay.organizer_document_route", { enabled: setting.enabled }));
  return setting.enabled;
}

/**
 * Whether an inbound companion message belongs to this flow: a private chat,
 * whose sender IS the chat, that is the organizer's confirmed interview chat,
 * carrying at least one re-hosted file this flow can read — a document, or an
 * image where a runner reads images — on a relay that has a model at all, and
 * with the route switched on (`enabled`, from ORGANIZER_DOCUMENT_ROUTE_ENABLED).
 * Anything else keeps the route it had.
 *
 * `enabled` is required so no caller can reach this flow without deciding.
 * Off, a message that WOULD have been routed is logged (trip id only — never
 * the chat, the sender or the file) so the operator can see it happening.
 */
export async function organizerDocumentRoute(
  db: Db,
  input: {
    tripId: string;
    chatId: string;
    chatType: string | undefined;
    fromId: string | undefined;
    mediaKinds: readonly string[];
    hasMedia: boolean;
    hasRunner: boolean;
    canReadImages: boolean;
    enabled: boolean;
    log?: (line: string) => void;
  },
): Promise<{ sessionId: string; language: Language } | null> {
  if (!input.hasRunner || !input.hasMedia) return null;
  if (input.chatType !== "private" || !input.fromId || input.fromId !== input.chatId) return null;
  const readable = input.mediaKinds.some((kind) => kind === "document" || (kind === "image" && input.canReadImages));
  if (!readable) return null;
  const organizer = await confirmedOrganizerChat(db, input.tripId, input.chatId);
  if (organizer && !input.enabled) {
    input.log?.(structuredLog("info", "trip_bot.organizer_document_route_off", { trip_id: input.tripId }));
    return null;
  }
  return organizer;
}

export async function tripOwnerUserId(db: Db, tripId: string): Promise<string | null> {
  const res = await db.query<{ user_id: string }>(
    "SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1 AND role = 'owner' AND status = 'active'",
    [tripId],
  );
  return res.rows.length === 1 ? res.rows[0]!.user_id : null;
}

// ── From readings to proposals ───────────────────────────────────────────────

function entryOf(value: unknown): CorrectionChange["entry"] {
  if (!isRecord(value)) return null;
  const name = [value.name_en, value.name].find((n) => typeof n === "string" && n.trim() !== "");
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  return { name: typeof name === "string" ? name : null, start: text(value.start ?? value.date), end: text(value.end) };
}

function entriesByKey(answer: unknown): Map<string, unknown> {
  const data = isRecord(answer) && Array.isArray(answer.data) ? answer.data : [];
  return new Map(data.map((entry) => [entryIdentity(entry), entry]));
}

/**
 * What the gate's decisions would change, as proposals: one for everything that
 * adds or fills, and one per disagreement. Pure.
 */
export function buildCorrections(input: { tripId: string; held: AnswerStore; gated: DocumentGateResult }): ProposedCorrection[] {
  const { tripId, held, gated } = input;
  const { decisions } = gated;
  const out: ProposedCorrection[] = [];

  if (decisions.accepted.length > 0) {
    const proposedAnswers: AnswerStore = { ...held };
    const changes: CorrectionChange[] = [];
    const sources: AnswerSource[] = [];
    for (const accepted of decisions.accepted) {
      const questionId = accepted.questionId;
      proposedAnswers[questionId] = accepted.answer;
      const own: CorrectionChange[] = [];
      const reconciled = accepted.reconciled;
      if (reconciled) {
        const merged = entriesByKey(accepted.answer);
        const before = entriesByKey(held[questionId]);
        for (const added of reconciled.added) {
          own.push({ questionId, kind: "added", entryKey: added.entryKey, paths: [], entry: entryOf(merged.get(added.entryKey)) });
        }
        const filled = new Map<string, string[]>();
        for (const fill of reconciled.filled) filled.set(fill.entryKey, [...(filled.get(fill.entryKey) ?? []), fill.path]);
        for (const [entryKey, paths] of filled) {
          own.push({ questionId, kind: "filled", entryKey, paths, entry: entryOf(before.get(entryKey) ?? merged.get(entryKey)) });
        }
      } else {
        own.push({ questionId, kind: "answered", entryKey: "", paths: [], entry: null, value: accepted.answer });
      }
      changes.push(...own);
      for (const documentId of gated.sources.get(questionId) ?? []) {
        sources.push({
          tripId,
          questionId,
          entryKey: "",
          documentId,
          disposition: reconciled ? "filled" : "accepted",
          paths: [...new Set(own.flatMap((c) => c.paths))],
        });
      }
    }
    if (changes.length > 0) out.push({ kind: "changes", proposedAnswers, changes, sources });
  }

  for (const conflict of decisions.conflicts) {
    const heldAnswer = held[conflict.questionId];
    if (!isRecord(heldAnswer)) continue;
    const replaced = applyConflictChoice(heldAnswer.data, conflict);
    if (replaced === null) continue;
    const documentId = gated.documentOf(conflict.proposal);
    out.push({
      kind: "replace",
      proposedAnswers: { ...held, [conflict.questionId]: { ...heldAnswer, data: replaced } as AnswerStore[string] },
      changes: [{
        questionId: conflict.questionId,
        kind: "replaced",
        entryKey: conflict.entryKey,
        paths: [conflict.path],
        entry: entryOf(entriesByKey(heldAnswer).get(conflict.entryKey)),
        held: conflict.held,
        value: conflict.incoming,
      }],
      sources: documentId
        ? [{ tripId, questionId: conflict.questionId, entryKey: conflict.entryKey, documentId, disposition: "accepted", paths: [conflict.path] }]
        : [],
    });
  }
  return out;
}

export function correctionDigest(proposal: ProposedCorrection): string {
  return createHash("sha256").update(canonical([proposal.kind, proposal.changes, proposal.proposedAnswers])).digest("hex");
}

export type ProposeOutcome =
  | { kind: "no_version" }
  | { kind: "proposed"; corrections: DocumentCorrection[]; created: boolean[]; agreed: boolean };

/**
 * The documents' readings against the trip as confirmed now, stored as
 * proposals. The same documents proposing the same change to the same version
 * are the same proposal, however often the file is sent.
 */
export async function proposeCorrectionsFromReadings(
  db: Db,
  input: { tripId: string; chatId: string; readings: readonly DocumentReading[]; documentIds: readonly string[] },
): Promise<ProposeOutcome> {
  const version = await latestIntakeVersion(db, input.tripId);
  if (!version) return { kind: "no_version" };
  const { outstanding, answered } = partitionQuestions(version.answers, INTAKE_QUESTIONS);
  const gated = gateDocumentProposals(input.readings, { outstanding, answered, held: version.answers });
  const agreed = gated.decisions.rejected.some((r) => r.reason === "NO_NEW_INFORMATION" || r.reason === "ALREADY_ANSWERED");
  const corrections: DocumentCorrection[] = [];
  const created: boolean[] = [];
  for (const proposal of buildCorrections({ tripId: input.tripId, held: version.answers, gated })) {
    const stored = await storeCorrection(db, {
      tripId: input.tripId,
      baseVersionId: version.id,
      baseDigest: version.digest,
      requestedChatId: input.chatId,
      documentIds: [...input.documentIds],
      proposal,
    });
    corrections.push(stored.correction);
    created.push(stored.created);
  }
  return { kind: "proposed", corrections, created, agreed };
}

// ── Storage ──────────────────────────────────────────────────────────────────

export async function storeCorrection(
  db: Db,
  input: {
    tripId: string;
    baseVersionId: string;
    baseDigest: string;
    requestedChatId: string;
    documentIds: readonly string[];
    proposal: ProposedCorrection;
  },
): Promise<{ correction: DocumentCorrection; created: boolean }> {
  const digest = correctionDigest(input.proposal);
  const inserted = await db.query<CorrectionRow>(
    `INSERT INTO control_plane.trip_document_corrections
       (id, trip_id, kind, base_version_id, base_digest, proposed_answers, changes, sources, document_ids, changes_digest, requested_chat_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::text[], $10, $11)
     ON CONFLICT (trip_id, base_version_id, changes_digest) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      `dcor_${randomBytes(16).toString("hex")}`,
      input.tripId,
      input.proposal.kind,
      input.baseVersionId,
      input.baseDigest,
      JSON.stringify(input.proposal.proposedAnswers),
      JSON.stringify(input.proposal.changes),
      JSON.stringify(input.proposal.sources),
      [...input.documentIds],
      digest,
      input.requestedChatId,
    ],
  );
  if (inserted.rows[0]) return { correction: toCorrection(inserted.rows[0]), created: true };
  const existing = await db.query<CorrectionRow>(
    `SELECT ${COLUMNS} FROM control_plane.trip_document_corrections
      WHERE trip_id = $1 AND base_version_id = $2 AND changes_digest = $3`,
    [input.tripId, input.baseVersionId, digest],
  );
  return { correction: toCorrection(existing.rows[0]!), created: false };
}

export async function getCorrection(db: Db, id: string): Promise<DocumentCorrection | null> {
  const res = await db.query<CorrectionRow>(`SELECT ${COLUMNS} FROM control_plane.trip_document_corrections WHERE id = $1`, [id]);
  return res.rows[0] ? toCorrection(res.rows[0]) : null;
}

/** A proposal's documents, reviewed — once no other proposal from them is still open. */
export async function reviewDeliveries(db: Db, tripId: string, documentIds: readonly string[], status: "approved" | "rejected"): Promise<void> {
  if (documentIds.length === 0) return;
  await db.query(
    `UPDATE control_plane.source_artifacts a
        SET review_status = $3
      WHERE a.trip_id = $1 AND a.document_id = ANY($2::text[]) AND a.review_status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM control_plane.trip_document_corrections c
           WHERE c.trip_id = a.trip_id AND c.status IN ('pending', 'applying') AND a.document_id = ANY(c.document_ids)
        )`,
    [tripId, [...documentIds], status],
  );
}

async function settle(
  db: Db,
  id: string,
  outcome: { status: CorrectionStatus; decidedBy?: string; resultVersionId?: string; failureReason?: string },
): Promise<void> {
  await db.query(
    `UPDATE control_plane.trip_document_corrections
        SET status = $2,
            decided_by = CASE WHEN $2 = 'pending' THEN NULL ELSE $3 END,
            decided_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END,
            result_version_id = $4,
            failure_reason = $5
      WHERE id = $1 AND status IN ('pending', 'applying')`,
    [id, outcome.status, outcome.decidedBy ?? null, outcome.resultVersionId ?? null, outcome.failureReason ?? null],
  );
}

// ── Deciding ─────────────────────────────────────────────────────────────────

export type ApproveOutcome =
  | { kind: "applied"; correction: DocumentCorrection; versionId: string }
  | { kind: "already_decided" }
  | { kind: "stale"; correction: DocumentCorrection }
  | { kind: "not_now"; correction: DocumentCorrection }
  | { kind: "failed"; correction: DocumentCorrection; reason: string };

/**
 * Apply one proposal, as its organizer asked. Claimed first (pending →
 * applying), so a second tap cannot apply it twice; applied only to the version
 * it was computed against, or — for a single replaced field — to a newer one
 * whose field still holds exactly what the organizer was shown.
 */
export async function approveCorrection(
  db: pg.Pool,
  input: { id: string; chatId: string; decidedBy: string },
): Promise<ApproveOutcome> {
  const claimedRes = await db.query<CorrectionRow>(
    `UPDATE control_plane.trip_document_corrections SET status = 'applying'
      WHERE id = $1 AND requested_chat_id = $2 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [input.id, input.chatId],
  );
  if (!claimedRes.rows[0]) return { kind: "already_decided" };
  const claimed = toCorrection(claimedRes.rows[0]);

  const current = await latestIntakeVersion(db, claimed.tripId);
  let answers: AnswerStore | null = null;
  if (current && current.id === claimed.baseVersionId) {
    answers = claimed.proposedAnswers;
  } else if (current && claimed.kind === "replace" && claimed.changes[0]) {
    const change = claimed.changes[0];
    const heldAnswer = current.answers[change.questionId];
    const replaced = isRecord(heldAnswer)
      ? applyConflictChoice(heldAnswer.data, { entryKey: change.entryKey, path: change.paths[0] ?? "", held: change.held, incoming: change.value })
      : null;
    if (replaced !== null && isRecord(heldAnswer)) {
      answers = { ...current.answers, [change.questionId]: { ...heldAnswer, data: replaced } as AnswerStore[string] };
    }
  }
  if (!answers) {
    await settle(db, claimed.id, { status: "stale", decidedBy: input.decidedBy });
    return { kind: "stale", correction: claimed };
  }

  const result = await correctIntake(db, claimed.tripId, `user:${input.decidedBy}`, answers);
  if (!result.ok) {
    if (result.reason === "INVALID_STATE") {
      // The site is mid-build. Nothing is wrong with the proposal; it waits.
      await settle(db, claimed.id, { status: "pending" });
      return { kind: "not_now", correction: claimed };
    }
    await settle(db, claimed.id, { status: "failed", decidedBy: input.decidedBy, failureReason: result.reason });
    return { kind: "failed", correction: claimed, reason: result.reason };
  }
  await settle(db, claimed.id, { status: "approved", decidedBy: input.decidedBy, resultVersionId: result.versionId });
  // The record of which file supplied what. Best-effort: the version is written.
  await recordAnswerSources(db, claimed.sources).catch(() => 0);
  await reviewDeliveries(db, claimed.tripId, claimed.documentIds, "approved");
  return { kind: "applied", correction: claimed, versionId: result.versionId };
}

/** Decline one proposal, from its own chat. False when it was already decided. */
export async function rejectCorrection(db: Db, input: { id: string; chatId: string; decidedBy: string }): Promise<boolean> {
  const res = await db.query<CorrectionRow>(
    `UPDATE control_plane.trip_document_corrections
        SET status = 'rejected', decided_by = $3, decided_at = now()
      WHERE id = $1 AND requested_chat_id = $2 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [input.id, input.chatId, input.decidedBy],
  );
  const row = res.rows[0];
  if (!row) return false;
  await reviewDeliveries(db, row.trip_id, row.document_ids ?? [], "rejected");
  return true;
}

// ── What the organizer sees ──────────────────────────────────────────────────

function fieldLabel(path: string, language: Language): string {
  const key = `conflictField.${path}`;
  return UI_STRINGS[language]?.[key] ?? UI_STRINGS.en[key] ?? uiString("conflictField.default", language);
}

function valueText(value: unknown, language: Language): string {
  if (typeof value === "string") return readableDate(value, language) ?? value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value)) {
    for (const key of ["text", "other_text", "name", "name_en", "option_id"]) {
      if (typeof value[key] === "string" && (value[key] as string).trim()) return value[key] as string;
    }
    if (Array.isArray(value.data)) return `${value.data.length}`;
  }
  return JSON.stringify(value).slice(0, 80);
}

function entryLabel(entry: CorrectionChange["entry"], language: Language): string {
  if (!entry) return "";
  const dates = [entry.start, entry.end].map((d) => (d ? readableDate(d, language) ?? d : null)).filter(Boolean);
  return [entry.name ?? "", dates.length ? `(${dates.join(" – ")})` : ""].filter(Boolean).join(" ");
}

function questionLabel(questionId: string, language: Language): string {
  const question = INTAKE_QUESTIONS.find((q) => q.id === questionId);
  return question ? recapLabel(question, language) : questionId;
}

/** The message for one proposal, with Approve / Keep buttons. */
export function renderCorrection(
  correction: Pick<DocumentCorrection, "id" | "kind" | "changes">,
  documentName: string,
  language: Language,
): { text: string; replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  const replyMarkup = {
    inline_keyboard: [[
      { text: uiString("correctionApprove", language), callback_data: correctionCallbackData(correction.id, "approve") },
      { text: uiString("correctionReject", language), callback_data: correctionCallbackData(correction.id, "reject") },
    ]],
  };
  const document = documentName || "—";
  if (correction.kind === "replace" && correction.changes[0]) {
    const change = correction.changes[0];
    const text = uiString("correctionConflict", language)
      .replace("{document}", document)
      .replace("{what}", fieldLabel(change.paths[0] ?? "", language))
      .replace("{entry}", entryLabel(change.entry, language) || questionLabel(change.questionId, language))
      .replace("{held}", valueText(change.held, language))
      .replace("{incoming}", valueText(change.value, language));
    return { text, replyMarkup };
  }
  const lines = correction.changes.map((change) => {
    const question = questionLabel(change.questionId, language);
    if (change.kind === "added") {
      return uiString("correctionChange.added", language).replace("{question}", question).replace("{entry}", entryLabel(change.entry, language));
    }
    if (change.kind === "filled") {
      return uiString("correctionChange.filled", language)
        .replace("{question}", question)
        .replace("{entry}", entryLabel(change.entry, language))
        .replace("{what}", change.paths.map((p) => fieldLabel(p, language)).join(", "));
    }
    return uiString("correctionChange.answered", language).replace("{question}", question).replace("{value}", valueText(change.value, language));
  });
  const text = uiString("correctionProposal", language).replace("{document}", document).replace("{changes}", lines.join("\n"));
  return { text, replyMarkup };
}

/** The name the organizer gave the first document behind a proposal. */
export async function correctionDocumentName(db: Db, correction: Pick<DocumentCorrection, "tripId" | "documentIds">): Promise<string> {
  const documents = await listTripDocuments(db, correction.tripId);
  return correction.documentIds.map((id) => documents.find((d) => d.id === id)?.filename).find(Boolean) ?? "";
}
