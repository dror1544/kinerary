/**
 * What the relay assumes about Hermes, as captured from a pinned Hermes
 * revision (#380). Test input only: the relay's runtime code never reads this.
 *
 * `fixtures/hermes-mirror.json` is written by `scripts/capture-hermes-mirror.py`
 * from Hermes SOURCE, and `control-plane/deployment/hermes-patches/BASE_REV`
 * names the revision it must describe (`hermes-mirror.test.ts` fails when they
 * differ). Every place that used to copy Hermes' wording or behaviour by hand
 * reads it from here, so a Hermes upgrade changes one file by a command and the
 * tests that depend on what moved fail by name.
 */
import { readFileSync } from "node:fs";

export interface HermesMirror {
  schema: number;
  revision: string;
  captured: string;
  source_files: Record<string, string>;
  error_classifier: { timeout_substrings: string[]; retryable_substrings: string[] };
  outbound_timeout_seconds: number;
  /** catalog key -> lower-cased template; `{name}` is a placeholder. */
  approval_prompt_strings: Record<string, string>;
  /** catalog key or `file:function:variable` -> lower-cased template; `{}` is an f-string expression. */
  status_strings: Record<string, string>;
  relay_contract: {
    contract_version: number;
    descriptor_fields: string[];
    legacy_ops: string[];
    ops: string[];
    outbound_frame_fields: string[];
    outbound_metadata_fields: string[];
  };
  log_formats: { mcp_registered: string; tool_completed: string };
  config_keys: string[];
  config_key_spreads: string[];
}

export const HERMES_MIRROR_FIXTURE = new URL("../fixtures/hermes-mirror.json", import.meta.url);
export const BASE_REV_FILE = new URL("../../../deployment/hermes-patches/BASE_REV", import.meta.url);
export const CAPTURE_COMMAND =
  "python3 -I scripts/capture-hermes-mirror.py --source <hermes tree at BASE_REV> --out control-plane/api/test/fixtures/hermes-mirror.json";

export const hermesMirror: HermesMirror = JSON.parse(readFileSync(HERMES_MIRROR_FIXTURE, "utf8"));

/** `BasePlatformAdapter._is_timeout_error`, over the captured substrings. */
export function hermesIsTimeout(error: string, mirror: HermesMirror = hermesMirror): boolean {
  const lowered = error.toLowerCase();
  return mirror.error_classifier.timeout_substrings.some((pat) => lowered.includes(pat));
}

/** `BasePlatformAdapter._is_retryable_error`, over the captured `_RETRYABLE_ERROR_PATTERNS`. */
export function hermesIsRetryable(error: string, mirror: HermesMirror = hermesMirror): boolean {
  const lowered = error.toLowerCase();
  return mirror.error_classifier.retryable_substrings.some((pat) => lowered.includes(pat));
}

/** What a placeholder is filled with when a captured template is rendered for a test. */
const PLACEHOLDER_SAMPLES: Record<string, string> = {
  prefix: "/",
  sethome_cmd: "/sethome",
  window: "5 minutes",
  name: "Family trip",
  platform: "telegram",
};

/**
 * A captured template as Hermes would send it. `{name}` takes its sample from
 * PLACEHOLDER_SAMPLES; `{}` (an f-string expression) and any other name is "x".
 */
export function renderTemplate(template: string): string {
  return template.replace(/\{([^{}]*)\}/g, (_all, name: string) => PLACEHOLDER_SAMPLES[name] ?? "x");
}

/** The AC-5 comparison: null when the fixture describes the pinned revision. */
export function revisionMismatch(fixtureRevision: string, baseRevision: string): string | null {
  if (fixtureRevision.trim() === baseRevision.trim() && fixtureRevision.trim() !== "") return null;
  return (
    `hermes-mirror.json describes Hermes ${JSON.stringify(fixtureRevision.trim())} but ` +
    `hermes-patches/BASE_REV pins ${JSON.stringify(baseRevision.trim())}. ` +
    `Read the diff, then recapture: ${CAPTURE_COMMAND} --revision ${baseRevision.trim()} ` +
    `(\`--check\` shows the diff first).`
  );
}
