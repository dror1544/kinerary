/**
 * Document intake: an uploaded file, from bytes to answers the interview can use.
 *
 *   ingestDocument             read it, refuse what must not be kept, store the
 *                              bytes once per trip, record the delivery
 *   extractRegisteredDocuments read each document ON ITS OWN, once per
 *                              processing configuration, and keep the reading
 *   gateDocumentProposals      decide what the documents are allowed to answer,
 *                              together, with every answer traceable to a file
 *
 * WHY EACH FILE IS READ ON ITS OWN. They used to be joined into one string and
 * read in one call, and the join erased which file said what: nothing could be
 * cached per document, a re-sent confirmation was read and paid for again, and
 * no answer could point back at the voucher behind it. The join existed for a
 * real reason — extracting five files separately once produced five competing
 * `phases` answers and let the last one win — and that reason is honoured
 * below, not dropped: the separate readings meet in ONE gate, where several
 * files' slices of a structured answer merge exactly as they did inside one
 * reading.
 *
 * WHAT A MODEL NEVER DECIDES HERE. Which trip a document belongs to (the caller
 * resolves that from the authenticated chat), its storage path (derived from
 * the content), whether it is kept (the identity check and the reader), and
 * whether anything it says is accepted (the evidence check, the gate and
 * `validateAnswer`). The model proposes; this module and the ones it calls
 * dispose.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { normaliseDatesAndTimes, tripWindow } from "./document-dates.js";
import { documentKindFor, documentText, DOCUMENT_READER_VERSION, type DocumentCoverageUnit } from "./document-text.js";
import {
  contentDigest,
  documentExtensionFor,
  storageKeyFor,
  type DocumentBlobStore,
  type DocumentExtension,
} from "./document-store.js";
import {
  parseVisionOutput,
  readWithVision,
  visionFileFor,
  visionProcessingConfig,
  visionReaderVersion,
  visionTextFrom,
  type VisionReadResult,
  type VisionTranscript,
} from "./document-vision.js";
import {
  findExtraction,
  findTripDocumentByDigest,
  markDocumentStored,
  markDocumentUnstored,
  processingKey,
  recordDelivery,
  reserveDocument,
  saveExtraction,
  type DeliveryReviewStatus,
  type ProcessingConfig,
} from "./document-registry.js";
import {
  applyProposals,
  buildExtractIntakePrompt,
  DOCUMENT_ANSWERABLE_QUESTION_IDS,
  evidenceAppears,
  EXTRACT_INTAKE_TASK,
  extractIntakeFromDocument,
  INTERPRET_OUTPUT_SCHEMA,
  type InterpretPayload,
  type ProposalDecisions,
  type ProposedAnswer,
  type RejectedProposal,
} from "./interpret.js";
import type { IntakeQuestion } from "./interview.js";
import type { StructuredModelRunner } from "./model-runner.js";
import { structuredLog } from "./redaction.js";

// ── Ingest ───────────────────────────────────────────────────────────────────

export interface RegisteredDocument {
  documentId: string;
  digest: string;
  filename: string | null;
  mime: string;
  /** The original bytes are kept and can be opened later. */
  stored: boolean;
  /** This content was already on the trip before this delivery. */
  duplicateContent: boolean;
  /** This delivery had not been recorded before — false for a redelivered message. */
  newDelivery: boolean;
  text: string;
  pages: number;
  truncated: boolean;
  coverage: DocumentCoverageUnit[];
  /**
   * How the text was obtained — the parser's version, or the vision model that
   * transcribed it. Later readings of the text are keyed by it.
   */
  readerVersion: string;
}

export type IngestOutcome =
  | { kind: "registered"; document: RegisteredDocument }
  | { kind: "refused"; reason: "IDENTITY_DOCUMENT" }
  | { kind: "unreadable"; reason: "UNSUPPORTED_TYPE" | "TOO_LARGE" | "UNREADABLE" | "NO_TEXT"; detail?: string };

export interface IngestContext {
  db: pg.Pool;
  /** Absent: the document is still registered and read, just not kept. */
  store?: DocumentBlobStore;
  /** Resolved by the caller from an authenticated binding — never from the upload. */
  tripId: string;
  provider: string;
  reviewStatus: DeliveryReviewStatus;
  /**
   * The runner a photo or a scan is read through (`read_image`). Absent, or not
   * serving that task: those files get the same honest refusal as before.
   */
  vision?: StructuredModelRunner;
  log?: (line: string) => void;
}

/** What was made of a file, however it was read. */
interface IngestRead {
  text: string;
  pages: number;
  truncated: boolean;
  coverage: DocumentCoverageUnit[];
  ext: DocumentExtension;
  readerVersion: string;
  /** A fresh vision transcript, to be kept once the document row exists. */
  transcript?: { config: ProcessingConfig; value: VisionTranscript };
}

/**
 * Look at a photo or a scan — or reuse the transcript this trip already has of
 * these bytes, from this vision configuration. Null when no runner reads images.
 */
async function lookAt(
  ctx: IngestContext,
  input: { bytes: Uint8Array; mime: string; filename?: string },
  digest: string,
): Promise<{ result: VisionReadResult; config: ProcessingConfig; reused: boolean } | null> {
  const config = visionProcessingConfig(ctx.vision);
  if (!config) return null;
  const known = await findTripDocumentByDigest(ctx.db, ctx.tripId, digest);
  if (known) {
    const earlier = await findExtraction(ctx.db, {
      tripId: ctx.tripId,
      documentId: known.id,
      processingKey: processingKey(config),
    });
    const transcript = earlier?.status === "ok" ? parseVisionOutput(earlier.result) : null;
    if (transcript) return { result: visionTextFrom(transcript, input.filename), config, reused: true };
  }
  const result = await readWithVision(ctx.vision, {
    bytes: input.bytes,
    mime: input.mime,
    ...(input.filename ? { filename: input.filename } : {}),
  });
  // Reason only: a failure's detail can quote what the model saw.
  ctx.log?.(structuredLog(result.ok ? "info" : "warn", "document.vision_read", {
    trip_id: ctx.tripId,
    provider: config.provider,
    model: config.model,
    ...(result.ok ? { chars: result.text.length } : { reason: result.reason }),
  }));
  return { result, config, reused: false };
}

/**
 * One file into the registry.
 *
 * Reading comes FIRST, before anything is kept, because the identity-document
 * refusal runs on the extracted text: a passport must be recognised before its
 * bytes are written anywhere, not deleted after. The same ordering is why an
 * unreadable file is not kept either — a scan the reader could not read is also
 * a scan the identity check could not look at, and keeping it would be keeping
 * something nothing has vetted.
 *
 * A photo, or a PDF with no text layer, is read by LOOKING at it when a vision
 * runner is configured (document-vision.ts), and the same order holds for what
 * comes back: the transcript is identity-checked before the bytes are kept. What
 * cannot hold is "before anything leaves the machine" — see that module's
 * header. A transcript is kept as its own reading, so the same photo sent again
 * costs no second look.
 *
 * Idempotent end to end: the same bytes on the same trip are one document, the
 * same message redelivered is one delivery, and the bytes are written once.
 */
export async function ingestDocument(
  ctx: IngestContext,
  input: { bytes: Uint8Array; mime: string; filename?: string; sourceRef: string },
): Promise<IngestOutcome> {
  const digest = contentDigest(input.bytes);
  const typed = await documentText(input.bytes, input.mime, input.filename);
  let read: IngestRead;
  if (typed.ok) {
    // Non-null: the reader has just accepted this kind.
    const kind = documentKindFor(input.mime, input.filename)!;
    read = {
      text: typed.text,
      pages: typed.pages,
      truncated: typed.truncated,
      coverage: typed.coverage,
      ext: documentExtensionFor(kind),
      readerVersion: DOCUMENT_READER_VERSION,
    };
  } else {
    const unreadable = typed.reason as Exclude<typeof typed.reason, "IDENTITY_DOCUMENT">;
    if (typed.reason === "IDENTITY_DOCUMENT") return { kind: "refused", reason: "IDENTITY_DOCUMENT" };
    // The two things only looking can read: a picture, and a PDF with no text.
    const file = unreadable === "UNSUPPORTED_TYPE" || unreadable === "NO_TEXT"
      ? visionFileFor(input.mime, input.filename)
      : null;
    const looked = file ? await lookAt(ctx, input, digest) : null;
    if (!file || !looked) {
      return { kind: "unreadable", reason: unreadable, ...(typed.detail ? { detail: typed.detail } : {}) };
    }
    const seen = looked.result;
    if (!seen.ok) {
      if (seen.reason === "IDENTITY_DOCUMENT") return { kind: "refused", reason: "IDENTITY_DOCUMENT" };
      if (seen.reason === "NOT_CONFIGURED") {
        return { kind: "unreadable", reason: unreadable, ...(typed.detail ? { detail: typed.detail } : {}) };
      }
      const reason = seen.reason === "TOO_LARGE" || seen.reason === "NO_TEXT" || seen.reason === "UNSUPPORTED_TYPE"
        ? seen.reason
        : "UNREADABLE";
      return { kind: "unreadable", reason, ...(seen.detail ? { detail: seen.detail } : {}) };
    }
    read = {
      text: seen.text,
      pages: 1,
      truncated: seen.truncated,
      coverage: seen.coverage,
      ext: file.ext,
      readerVersion: visionReaderVersion(looked.config),
      ...(looked.reused ? {} : { transcript: { config: looked.config, value: seen.transcript } }),
    };
  }
  const { document, created } = await reserveDocument(ctx.db, {
    tripId: ctx.tripId,
    digest,
    byteSize: input.bytes.byteLength,
    mime: input.mime || null,
  });

  let stored = document.ingestState === "stored";
  if (!stored && ctx.store) {
    try {
      const key = storageKeyFor(ctx.tripId, digest, read.ext);
      await ctx.store.put(key, input.bytes);
      stored = await markDocumentStored(ctx.db, { tripId: ctx.tripId, documentId: document.id, storageKey: key });
    } catch (error) {
      // Not fatal to the interview: the document is still read. The log says
      // so, with detail for whoever runs the store, and the row says 'unstored'
      // rather than pretending.
      ctx.log?.(structuredLog("warn", "document.store_failed", {
        trip_id: ctx.tripId,
        document_id: document.id,
        reason: (error as { code?: string } | undefined)?.code ?? "ERROR",
        detail: String((error as Error)?.message ?? error).slice(0, 200),
      }));
    }
  }
  if (!stored) await markDocumentUnstored(ctx.db, { tripId: ctx.tripId, documentId: document.id });

  const delivery = await recordDelivery(ctx.db, {
    tripId: ctx.tripId,
    documentId: document.id,
    digest,
    provider: ctx.provider,
    sourceRef: input.sourceRef,
    filename: input.filename ?? null,
    reviewStatus: ctx.reviewStatus,
  });

  if (read.transcript) {
    try {
      await saveExtraction(ctx.db, {
        tripId: ctx.tripId,
        documentId: document.id,
        config: read.transcript.config,
        status: "ok",
        text: read.text,
        truncated: read.truncated,
        coverage: read.coverage,
        // The model's own shape, so it parses back exactly as it came.
        result: {
          legible: read.transcript.value.legible,
          identity_document: read.transcript.value.identityDocument,
          lines: read.transcript.value.lines,
        },
      });
    } catch (error) {
      // The document is read either way; losing the transcript only costs the
      // next delivery of the same photo a second look.
      ctx.log?.(structuredLog("warn", "document.transcript_save_failed", {
        trip_id: ctx.tripId,
        document_id: document.id,
        detail: String((error as Error)?.message ?? error).slice(0, 200),
      }));
    }
  }

  return {
    kind: "registered",
    document: {
      documentId: document.id,
      digest,
      filename: input.filename ?? null,
      mime: input.mime,
      stored,
      duplicateContent: !created,
      newDelivery: !delivery.duplicate,
      text: read.text,
      pages: read.pages,
      truncated: read.truncated,
      coverage: read.coverage,
      readerVersion: read.readerVersion,
    },
  };
}

// ── Per-document extraction ──────────────────────────────────────────────────

/** Documents read at once. Each read is a model call of a minute or more. */
export const DOCUMENT_EXTRACT_CONCURRENCY = 2;

/**
 * Names the extraction prompt and schema for one language.
 *
 * Derived from the prompt itself rather than a hand-kept version string, so a
 * change to the wording, the questions or the output schema moves the key on its
 * own and a stored reading made under the old prompt is not served as current.
 */
export function extractIntakeVersion(language: string, questions?: readonly IntakeQuestion[]): string {
  const template = buildExtractIntakePrompt({
    documentText: "",
    outstanding: DOCUMENT_ANSWERABLE_QUESTION_IDS,
    language,
    ...(questions ? { questions } : {}),
  });
  const hash = createHash("sha256").update(JSON.stringify([template, INTERPRET_OUTPUT_SCHEMA])).digest("hex");
  return `intake-${hash.slice(0, 16)}`;
}

/**
 * The processing configuration for reading a document's intake answers, or null
 * when no model is configured for that task.
 *
 * A runner that cannot describe itself still gets a configuration, with the
 * provider and model left null — it simply cannot tell two of its own models
 * apart, so a change of model on such a runner is not a new reading.
 */
export function intakeProcessingConfig(
  runner: StructuredModelRunner,
  language: string,
  readerVersion: string = DOCUMENT_READER_VERSION,
): ProcessingConfig | null {
  const pinned = runner.describe ? runner.describe(EXTRACT_INTAKE_TASK) : undefined;
  if (pinned === null) return null;
  return {
    readerVersion,
    extractorVersion: extractIntakeVersion(language),
    task: EXTRACT_INTAKE_TASK,
    provider: pinned?.provider ?? null,
    model: pinned?.model ?? null,
  };
}

export type DocumentExtractionOutcome =
  | { kind: "ok"; documentId: string; text: string; payload: InterpretPayload; reused: boolean }
  | { kind: "failed"; documentId: string; reason: string; detail?: string };

export interface ExtractionContext {
  db: pg.Pool;
  runner: StructuredModelRunner;
  tripId: string;
  language: string;
  timeoutMs?: number;
  concurrency?: number;
  log?: (line: string) => void;
}

/** A stored reading, if it has the shape this module wrote. */
function storedPayload(value: unknown): InterpretPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<InterpretPayload>;
  if (!Array.isArray(v.proposals) || !Array.isArray(v.unclear)) return null;
  return v as InterpretPayload;
}

/**
 * One document's reading: the stored one when this configuration already read
 * it, otherwise a model call whose answer is kept.
 *
 * A FAILED call is not kept. A timeout or a rate limit says nothing about the
 * document, and storing it under the processing key would turn one bad minute
 * into a permanent "this document could not be read".
 */
export async function extractRegisteredDocument(
  ctx: ExtractionContext,
  doc: Pick<RegisteredDocument, "documentId" | "text" | "truncated" | "coverage"> & { readerVersion?: string },
): Promise<DocumentExtractionOutcome> {
  const config = intakeProcessingConfig(ctx.runner, ctx.language, doc.readerVersion);
  if (!config) return { kind: "failed", documentId: doc.documentId, reason: "NOT_CONFIGURED" };

  const existing = await findExtraction(ctx.db, {
    tripId: ctx.tripId,
    documentId: doc.documentId,
    processingKey: processingKey(config),
  });
  const cached = existing && (existing.status === "ok" || existing.status === "empty") ? storedPayload(existing.result) : null;
  if (cached) return { kind: "ok", documentId: doc.documentId, text: doc.text, payload: cached, reused: true };

  const result = await extractIntakeFromDocument(ctx.runner, {
    documentText: doc.text,
    outstanding: DOCUMENT_ANSWERABLE_QUESTION_IDS,
    language: ctx.language,
    ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
  });
  if (!result.ok) {
    return { kind: "failed", documentId: doc.documentId, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
  }

  const saved = await saveExtraction(ctx.db, {
    tripId: ctx.tripId,
    documentId: doc.documentId,
    config,
    status: result.payload.proposals.length > 0 ? "ok" : "empty",
    text: doc.text,
    truncated: doc.truncated,
    coverage: doc.coverage,
    result: result.payload,
  });
  // A concurrent reading of the same document got there first. Its answer is
  // the one kept, so it is the one used — two readings of one document must not
  // both reach the gate.
  const payload = saved.created ? result.payload : storedPayload(saved.extraction.result) ?? result.payload;
  return { kind: "ok", documentId: doc.documentId, text: doc.text, payload, reused: !saved.created };
}

/** Every document's reading, a bounded number at a time, in input order. */
export async function extractRegisteredDocuments(
  ctx: ExtractionContext,
  docs: readonly (Pick<RegisteredDocument, "documentId" | "text" | "truncated" | "coverage"> & { readerVersion?: string })[],
): Promise<DocumentExtractionOutcome[]> {
  const out: DocumentExtractionOutcome[] = new Array(docs.length);
  let next = 0;
  const worker = async () => {
    while (next < docs.length) {
      const i = next;
      next += 1;
      const doc = docs[i]!;
      try {
        out[i] = await extractRegisteredDocument(ctx, doc);
      } catch (error) {
        // A database fault on one document must not take the others with it.
        out[i] = {
          kind: "failed",
          documentId: doc.documentId,
          reason: "FAILED",
          detail: String((error as Error)?.message ?? error).slice(0, 200),
        };
      }
    }
  };
  const width = Math.max(1, Math.min(ctx.concurrency ?? DOCUMENT_EXTRACT_CONCURRENCY, docs.length));
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

// ── The gate, across documents ───────────────────────────────────────────────

export interface DocumentReading {
  documentId: string;
  text: string;
  payload: InterpretPayload;
}

export interface DocumentGateResult {
  decisions: ProposalDecisions;
  /** For each accepted question, the documents its answer was drawn from. */
  sources: Map<string, string[]>;
  /**
   * The document a proposal came from — for a conflict or an ambiguity, which
   * carry the proposal that raised them, so the question can name the file.
   */
  documentOf: (proposal: ProposedAnswer) => string | undefined;
}

/**
 * What several documents' readings are allowed to answer, decided together.
 *
 * Two checks, in this order, and the order is the point:
 *
 *  1. EACH PROPOSAL MUST QUOTE ITS OWN DOCUMENT. Checked per document, before
 *     anything is combined. A proposal whose evidence is only in some OTHER file
 *     did not come from the file it claims to, and checking against the joined
 *     text of every file would let it through.
 *  2. ONE GATE FOR ALL OF THEM. The survivors go through `applyProposals`
 *     together, so several documents' slices of one structured answer — the
 *     hotels from one confirmation, the attractions from another — merge rather
 *     than compete. That is the property the joined-text reading had and the
 *     reason it existed.
 *
 * Because every surviving proposal is tagged with the document it came from
 * before the merge, each accepted answer can name all of the documents it was
 * built from.
 */
export function gateDocumentProposals(
  readings: readonly DocumentReading[],
  ctx: {
    outstanding: readonly string[];
    answered: readonly string[];
    /** The answers held now. Given, documents reconcile into them instead of being refused. */
    held?: Readonly<Record<string, unknown>>;
    questions?: readonly IntakeQuestion[];
  },
): DocumentGateResult {
  const owner = new Map<ProposedAnswer, string>();
  const surviving: ProposedAnswer[] = [];
  const notInOwnDocument: RejectedProposal[] = [];

  for (const reading of readings) {
    for (const proposal of reading.payload.proposals) {
      if (evidenceAppears(proposal.evidence, reading.text)) {
        surviving.push(proposal);
        owner.set(proposal, reading.documentId);
      } else {
        notInOwnDocument.push({ questionId: proposal.questionId, reason: "EVIDENCE_NOT_IN_SOURCE", proposal });
      }
    }
  }

  // A date a document gave without its year (`--07-06`) is completed from the
  // whole trip — every document in this burst and every answer held — and a
  // time is made HH:MM, before anything is judged. Here and not in each
  // document's extraction, so a cached reading never depends on its siblings.
  //
  // The proposal OBJECT is kept and only its value replaced: refusals, conflicts
  // and provenance are traced back to their document by that object's identity
  // (`documentOf` here, `readFrom` in the relay). Handing the gate copies
  // instead silently dropped every conflict a structured document raised.
  const window = tripWindow([...Object.values(ctx.held ?? {}), ...surviving.map((p) => p.value)]);
  for (const proposal of surviving) {
    if (proposal.value.kind === "structured") {
      proposal.value = { ...proposal.value, data: normaliseDatesAndTimes(proposal.value.data, window) };
    }
  }

  const gated = applyProposals(surviving, {
    sourceText: readings.map((r) => r.text).join("\n\n"),
    // A model leaves sourceMessageId empty on a document; the reading it came
    // from is what makes two disagreeing proposals two documents.
    sourceOf: (proposal) => owner.get(proposal) ?? "",
    outstanding: ctx.outstanding,
    answered: ctx.answered,
    unclear: readings.flatMap((r) => r.payload.unclear),
    ...(ctx.held ? { held: ctx.held } : {}),
    ...(ctx.questions ? { questions: ctx.questions } : {}),
  });

  const outstanding = new Set(ctx.outstanding);
  const answered = new Set(ctx.answered);
  const askAnyway = new Set(gated.askAnyway);
  for (const r of notInOwnDocument) {
    if (outstanding.has(r.questionId) && !answered.has(r.questionId)) askAnyway.add(r.questionId);
  }
  for (const a of gated.accepted) askAnyway.delete(a.questionId);

  const refused = new Set(gated.rejected.map((r) => r.proposal));
  const sources = new Map<string, string[]>();
  for (const accepted of gated.accepted) {
    const ids = surviving
      .filter((p) => p.questionId === accepted.questionId && !refused.has(p))
      .map((p) => owner.get(p)!)
      .filter(Boolean);
    sources.set(accepted.questionId, [...new Set(ids)]);
  }

  return {
    decisions: {
      accepted: gated.accepted,
      rejected: [...notInOwnDocument, ...gated.rejected],
      askAnyway: [...askAnyway],
      conflicts: gated.conflicts,
      ambiguous: gated.ambiguous,
      // Refused for confidence alone, and asked about with the reading rather
      // than lost (the relay keeps them as suggestions).
      suggested: gated.suggested,
    },
    sources,
    documentOf: (proposal) => owner.get(proposal),
  };
}
