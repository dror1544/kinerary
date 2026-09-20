/**
 * The document gate — what several documents' readings are allowed to answer.
 *
 * Pure: no database, no store, no model, no clock. It reads proposals and the
 * answers already held and decides, which is why it lives here rather than in
 * `document-intake.ts` beside the registry, the object store and the vision
 * reader. Those decide where a document's BYTES live; this decides what its
 * words are allowed to say, and only the second half can be exercised without
 * provisioned infrastructure.
 *
 * `document-intake.ts` re-exports it, so callers that hold a whole intake keep
 * importing one module.
 */
import { normaliseDatesAndTimes, tripWindow } from "./document-dates.js";
import {
  applyProposals,
  evidenceAppears,
  type InterpretPayload,
  type ProposalDecisions,
  type ProposedAnswer,
  type RejectedProposal,
} from "./interpret.js";
import type { IntakeQuestion } from "./interview.js";

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
