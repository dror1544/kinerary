/**
 * What the relay says, at start, about whether it keeps the originals of the
 * documents it reads (#544).
 *
 * With `DOCUMENT_STORE_DIR` unset the relay registers and reads every file and
 * keeps none of the bytes, and it used to say nothing about it: the start-up
 * check only ran when the variable was set, so the unset case - the one that
 * drops every original - was the one case with no line at all. A staging run
 * on 2026-11-12 built a trip from two ticket photos, and their originals were
 * never attached to its reservation; the only trace was `stored:false` on each
 * `interview.document_read` line, read as a photo problem when it was every
 * file type. Unset is not an error here, it is a downgrade, and a downgrade is
 * said out loud.
 *
 * Pure, so the three outcomes can be asserted without a relay: the caller logs
 * the line and exits when `fatal`.
 */
import type { DocumentStoreReadiness } from "../document-store.js";

export interface DocumentStoreNotice {
  level: "info" | "warn" | "error";
  event: "relay.document_store_ready" | "relay.document_store_not_ready";
  fields: Record<string, unknown>;
  /** The relay must not start: originals would not be kept safely and the deployment said that matters. */
  fatal: boolean;
}

export function documentStoreNotice(readiness: DocumentStoreReadiness, env: NodeJS.ProcessEnv = process.env): DocumentStoreNotice {
  if (readiness.ok) {
    return { level: "info", event: "relay.document_store_ready", fields: { keeps_originals: true }, fatal: false };
  }
  const fatal = env.DOCUMENT_STORE_REQUIRED === "1";
  return {
    level: fatal ? "error" : "warn",
    event: "relay.document_store_not_ready",
    fields: {
      keeps_originals: false,
      reason: readiness.reason,
      detail: readiness.detail,
      hint: fatal
        ? "refusing to start: originals would not be kept safely"
        : "running without keeping originals: documents are read, their files are dropped and no reservation will carry one",
    },
    fatal,
  };
}
