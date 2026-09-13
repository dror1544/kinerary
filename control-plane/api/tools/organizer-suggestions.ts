// tools/organizer-suggestions.ts — the one pure decision the automated
// organizer needs from a SessionView, split out so it can be unit-tested
// without importing auto-organizer.ts itself, which parses CLI args and opens
// a database connection as soon as it loads.
import type { IntakeQuestion, SessionView } from "../src/interview.js";

/**
 * `y:${id}` when the current question has a document suggestion pending —
 * accepting it is the right move whenever one is on screen, before anything
 * type-specific runs — else `null`.
 *
 * Regression, 2026-09-13: an unsure reading from a document renders as a
 * Yes/No suggestion rather than an outright accept. The automated organizer
 * did not know this and kept tapping the plain-question button for
 * `trip_type`, which was never sent — the 'multi' scenario always scripts
 * `trip_type: family`, and its own document proposes exactly that below the
 * confidence floor. The tool waited out BUTTON_PATIENCE and the run stalled.
 * A scenario's documents are written to say what its scripted answers say,
 * so confirming the suggestion is correct here, on every question type.
 */
export function suggestionTapData(
  q: Pick<IntakeQuestion, "id">,
  suggestions: SessionView["suggestions"] | undefined,
): string | null {
  return suggestions?.[q.id] ? `y:${q.id}` : null;
}
