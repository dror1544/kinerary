import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every new migration declares whether the release before it can keep running
 * on the schema it leaves behind.
 *
 * Rolling the control plane back (`kinerary-cp-release rollback`) keeps the
 * newer database whenever it can, because restoring the pre-upgrade dump loses
 * every write since. Nothing at runtime can tell whether that is safe: the
 * runner is keyed by filename, readyz only counts rows, and an older image
 * starts happily on a newer schema. Whether it then *works* is a fact only the
 * author of the migration knows — a dropped table breaks old code outright, a
 * relaxed NOT NULL lets new code write rows old code cannot read, a backfill
 * changes what old queries return. So the author writes it down, here:
 *
 *   -- rollback: compatible — new nullable column; older code never reads it
 *   -- rollback: breaking — drops plan_operations_reviews, which older code queries
 *
 * The release tool reads only this header. A missing header counts as
 * breaking, so an undeclared migration can never make a code-only rollback
 * look safe.
 */

const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

export const ROLLBACK_HEADER = /^--\s*rollback:\s*(compatible|breaking)\s*[—-]\s*\S.*$/m;

// Every migration on main when the rule was introduced (2026-09-16). All of
// them are applied on every deployment and below every rollback target, so no
// rollback can ever cross one. Adding a name here is not a way to skip the
// rule: a new migration always needs its header.
const GRANDFATHERED = new Set([
  "0001_foundation.sql",
  "0002_canonical_guardrails.sql",
  "0003_sprint0_review_hardening.sql",
  "0004_canonical_guardrail_key_matching.sql",
  "0005_opaque_id_format.sql",
  "0006_sprint1_signup.sql",
  "0007_sprint1_signup_unique_fix.sql",
  "0008_sprint2_interview.sql",
  "0009_sprint2_review.sql",
  "0010_sprint3_planner.sql",
  "0011_sprint3_review.sql",
  "0012_plans_updated_at.sql",
  "0013_sprint4.sql",
  "0014_telegram_callback_refs.sql",
  "0015_intake_versions_canonical_guard.sql",
  "0016_sprint4_seed_development_release.sql",
  "0017_telegram_chat_id.sql",
  "0018_release_accepts_intake_schema_v2.sql",
  "0019_telegram_chat_bindings.sql",
  "0020_web_portal.sql",
  "0021_password_identity.sql",
  "0021_web_password_credentials.sql",
  "0022_interview_chat_id_hint.sql",
  "0023_country_reference.sql",
  "0024_intake_source_document.sql",
  "0025_venue_links_reference.sql",
  "0026_plans_retryable_digest.sql",
  "0027_release_manifest.sql",
  "0028_interview_chat_binding.sql",
  "0029_telegram_binding_lifecycle.sql",
  "0030_trip_assistant_names.sql",
  "0031_interview_agent_turns.sql",
  "0032_release_accepts_intake_schema_v3.sql",
  "0033_router_prompt_handoff.sql",
  "0034_web_portal_addenda.sql",
  "0035_interview_ui_state.sql",
  "0036_interview_language.sql",
  "0037_interview_phase.sql",
  "0038_interview_floor.sql",
  "0039_interview_inbound_settle.sql",
  "0040_interview_document_floor.sql",
  "0041_drop_plan_operations_reviews.sql",
  "0042_trip_reachability.sql",
  "0043_binding_without_companion.sql",
  "0044_companion_intro_facts.sql",
  "0045_group_binding_tokens.sql",
  "0046_intake_version_language.sql",
  "0047_agent_spoke_on_turn.sql",
  "0048_interview_interpretations.sql",
  "0049_interview_session_expiry.sql",
  "0051_trip_person_links.sql",
]);

// Statements that break the release before them on the schema they leave.
// A header claiming `compatible` over one of these is wrong, not a judgement
// call — the older code's queries fail. Matched on SQL with comments removed,
// so a comment explaining why a DROP is safe cannot trip it.
const BREAKING_STATEMENTS: Array<[string, RegExp]> = [
  ["DROP TABLE", /\bdrop\s+table\b/i],
  ["DROP COLUMN", /\bdrop\s+column\b/i],
  ["RENAME", /\brename\s+(?:column\s+|constraint\s+)?\w*\s*to\b|\brename\s+to\b/i],
  ["ALTER COLUMN … TYPE", /\balter\s+column\s+\w+\s+(?:set\s+data\s+)?type\b/i],
  ["SET NOT NULL", /\bset\s+not\s+null\b/i],
];

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export function declaredRollback(sql: string): "compatible" | "breaking" | undefined {
  const match = ROLLBACK_HEADER.exec(sql.split("\n").slice(0, 20).join("\n"));
  return match?.[1] as "compatible" | "breaking" | undefined;
}

export function breakingStatementsIn(sql: string): string[] {
  const body = stripSqlComments(sql);
  return BREAKING_STATEMENTS.filter(([, pattern]) => pattern.test(body)).map(([label]) => label);
}

test("every migration since the rule declares whether a rollback can keep it", async () => {
  const files = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const undeclared: string[] = [];
  for (const file of files) {
    if (GRANDFATHERED.has(file)) continue;
    const sql = await readFile(`${migrationsDir}/${file}`, "utf8");
    if (!declaredRollback(sql)) undeclared.push(file);
  }
  assert.deepEqual(
    undeclared,
    [],
    "start each new migration with `-- rollback: compatible — <why>` or `-- rollback: breaking — <what>` in its first 20 lines",
  );
});

test("a migration declared compatible contains no statement that breaks the release before it", async () => {
  const files = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const contradictions: string[] = [];
  for (const file of files) {
    const sql = await readFile(`${migrationsDir}/${file}`, "utf8");
    if (declaredRollback(sql) !== "compatible") continue;
    const found = breakingStatementsIn(sql);
    if (found.length) contradictions.push(`${file}: ${found.join(", ")}`);
  }
  assert.deepEqual(contradictions, []);
});

test("the header is read the way the release tool reads it", () => {
  assert.equal(declaredRollback("-- rollback: compatible — new nullable column\nALTER TABLE x ADD COLUMN y text;"), "compatible");
  assert.equal(declaredRollback("-- rollback: breaking - drops a table older code reads\nDROP TABLE x;"), "breaking");
  assert.equal(declaredRollback("--rollback:compatible — tight spacing"), "compatible");
  // A bare verdict with no reason is not a declaration: the reason is the part
  // the person deciding on a rollback actually reads.
  assert.equal(declaredRollback("-- rollback: compatible\nSELECT 1;"), undefined);
  assert.equal(declaredRollback("-- rollback: maybe — unsure\nSELECT 1;"), undefined);
  assert.equal(declaredRollback("SELECT 1;"), undefined);
  // Below the first 20 lines is too late to be a header.
  assert.equal(declaredRollback(`${"-- note\n".repeat(20)}-- rollback: compatible — late`), undefined);
});

test("breaking statements are found in SQL and not in comments", () => {
  assert.deepEqual(breakingStatementsIn("DROP TABLE IF EXISTS control_plane.x;"), ["DROP TABLE"]);
  assert.deepEqual(breakingStatementsIn("ALTER TABLE t DROP COLUMN c;"), ["DROP COLUMN"]);
  assert.deepEqual(breakingStatementsIn("ALTER TABLE t RENAME COLUMN a TO b;"), ["RENAME"]);
  assert.deepEqual(breakingStatementsIn("ALTER TABLE t RENAME TO u;"), ["RENAME"]);
  assert.deepEqual(breakingStatementsIn("ALTER TABLE t ALTER COLUMN c TYPE bigint;"), ["ALTER COLUMN … TYPE"]);
  assert.deepEqual(breakingStatementsIn("ALTER TABLE t ALTER COLUMN c SET NOT NULL;"), ["SET NOT NULL"]);
  assert.deepEqual(breakingStatementsIn("-- we never DROP TABLE here\n/* nor DROP COLUMN */\nALTER TABLE t ADD COLUMN c text;"), []);
  // Relaxing a constraint and adding a defaulted column are not in the list:
  // whether they break older code is exactly the judgement the header records.
  assert.deepEqual(breakingStatementsIn("ALTER TABLE t ALTER COLUMN c DROP NOT NULL; ALTER TABLE t ADD COLUMN d int NOT NULL DEFAULT 0;"), []);
});
