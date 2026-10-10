// Single source of truth for the base allow-list a spawned CLI child reading
// untrusted organizer or document text may inherit, and the Hermes-specific
// builder on top of it (issue #284) — imported by mcp/mcp.js (CommonJS
// require) and control-plane/api/src/model-runner.ts (ESM import of a CJS
// module; Node's cjs-module-lexer synthesizes named exports for the
// `module.exports = { a, b, c }` shape below), same arrangement as
// needs-schema.js and agent-schema.js.
//
// Before this file, model-runner.ts's STRUCTURING_BASE_ENV +
// structuringChildEnv + hermesChildEnv (#153/#58) and mcp.js's
// HERMES_CHILD_ENV_ALLOW + hermesChildEnv() (#183) were two independently
// maintained, byte-for-byte copies of the same allow-list — kept in sync by
// hand, which is exactly the drift risk CLAUDE.md's "prefer fixing something
// at its source" line warns about.
//
// An ALLOW-list, not a deny-list: a secret either process holds that gets
// added later is withheld by default rather than by remembering to add it to
// every copy. Nothing here is a credential — PATH/HOME/config locations,
// locale and certificates, the bare minimum a child needs to find its own
// executable, write somewhere, and talk TLS.
//
// Callers with CLI-specific credentials (model-runner.ts's claudeChildEnv
// adds CLAUDE_CODE_OAUTH_TOKEN, the ANTHROPIC_* keys, and — Mac-only —
// USER/LOGNAME/XDG_CACHE_HOME; codexChildEnv adds CODEX_HOME) layer those on
// top of structuringChildEnv themselves; that layering is NOT shared here,
// because mcp.js never spawns a Claude or Codex child and has no use for it.

const STRUCTURING_BASE_ENV = [
  'PATH', 'HOME', 'XDG_CONFIG_HOME',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];

// The one allow-list builder: the base set above plus `extra` — a CLI's own
// credential or config-directory variables — and nothing else the caller
// holds.
function structuringChildEnv(extra = [], source = process.env) {
  const allowed = new Set([...STRUCTURING_BASE_ENV, ...extra]);
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => allowed.has(key) && value !== undefined),
  );
}

// The Hermes CLI's environment: how to run, and where its own config lives
// (HERMES_HOME — a location, not a credential). Hermes keeps its provider
// keys in ~/.hermes/.env, which it reads itself, so none of the caller's
// variables are needed and none are passed.
function hermesChildEnv(source = process.env) {
  return structuringChildEnv(['HERMES_HOME'], source);
}

module.exports = { STRUCTURING_BASE_ENV, structuringChildEnv, hermesChildEnv };
