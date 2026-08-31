// Release-artifact renderer + sanitation scan + sealed manifest.
//
// Sprint 4.7 — release-artifact hardening. A "release" is the trip-runtime
// source tree (site/, server/, shared/) frozen at a git revision. This module
// turns that revision into a *sealed manifest*: the exact file list with git's
// own per-file content hash, the schema-compatibility range, and a sanitation
// scan report. The manifest's artifactDigest is a pure function of its file
// list, so the release row's digest column re-verifies against it — adding,
// dropping or altering a file breaks the seal.
//
// No I/O here: a PayloadSource (release-git.ts in production, a fake in tests)
// supplies the revision, the file list and file contents. Everything below is
// deterministic given that source.

import { createHash } from "node:crypto";
import { privateIpv4Pattern } from "./canonical.js";

export const RELEASE_MANIFEST_SCHEMA = 1 as const;

// The trip-runtime render payload: what a provisioned trip site actually runs.
// site/ is served to browsers, server/ is the node app, shared/ is the schema
// code both import. Not .agents/skills/create-trip/ — that is the human
// scaffolding path, not what a control-plane provision renders against.
export const PAYLOAD_ROOTS = ["site", "server", "shared"] as const;

export interface TreeEntry {
  /** repo-root-relative POSIX path, e.g. "site/app.js" */
  path: string;
  /** git blob object id (40 lowercase hex) — git's own content hash of the file */
  blobSha: string;
}

export interface LeakFinding {
  path: string;
  /** 1-indexed line the match landed on */
  line: number;
  /** which SCAN_RULES entry fired — never the matched text (that would re-leak it) */
  rule: string;
}

export interface SanitationReport {
  scannedFiles: number;
  passed: boolean;
  findings: LeakFinding[];
}

export interface ReleaseManifest {
  schema: typeof RELEASE_MANIFEST_SCHEMA;
  /** 40-hex commit the payload was frozen at */
  sourceRevision: string;
  /** "sha256:" + 64 hex — a pure function of `files` (see computeArtifactDigest) */
  artifactDigest: string;
  applicationSchema: number;
  dataSchemaMin: number;
  dataSchemaMax: number;
  /** ISO 8601 */
  builtAt: string;
  /** the sealed file list, sorted by path */
  files: TreeEntry[];
  sanitation: SanitationReport;
}

export interface PayloadSource {
  /** Resolve a ref ("HEAD", a branch, a sha) to its 40-hex commit id. */
  resolveRevision(ref: string): Promise<string>;
  /** Tracked files under PAYLOAD_ROOTS at `revision`, each with its blob sha. */
  listPayload(revision: string): Promise<TreeEntry[]>;
  /** UTF-8 contents of one payload file at `revision`. */
  readTextFile(revision: string, path: string): Promise<string>;
}

// ── artifact digest ─────────────────────────────────────────────────────────

/**
 * A stable digest over a file list: sha256 of `<path> <blobSha>` lines, sorted
 * by path, `\n`-joined. Because blobSha is git's content hash, any content
 * change anywhere changes the digest; because the list is included, so does an
 * added or removed file. Re-running the build on the same clean revision
 * reproduces the same value. (Python twin: worker/control_plane_worker/
 * release_source.py `tree_digest` — change them together.)
 */
export function computeArtifactDigest(files: readonly TreeEntry[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path} ${f.blobSha}`)
    .join("\n");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

// ── sanitation scan ─────────────────────────────────────────────────────────

// High-signal only: each rule flags something that should never be committed to
// the shipped tree. Deliberately NOT `Bearer \S+` — `Bearer ${token}` is a
// legitimate literal in client fetch() code. The private-ipv4 rule is the exact
// pattern the canonical-record guard rejects (imported, not re-stated).
const SCAN_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "private-ipv4", pattern: privateIpv4Pattern },
  { rule: "host-path", pattern: /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+)\// },
  { rule: "pve-api-token", pattern: /PVEAPIToken=[A-Za-z0-9!@._-]+=[0-9a-f-]{16,}/i },
  { rule: "connection-userinfo", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/$"'{}]+:[^\s@/$"'{}]+@/i },
  { rule: "jwt-literal", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { rule: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github-pat", pattern: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { rule: "slack-bot-token", pattern: /\bxoxb-[0-9]{6,}-[0-9A-Za-z-]{10,}/ },
  { rule: "openai-key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { rule: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
];

// Extensions whose contents are opaque bytes — never read, never scanned (they
// still count toward the artifact digest). Everything else is scanned unless a
// NUL-byte content sniff says otherwise, so an extensionless runtime text file
// like `server/Dockerfile` is covered rather than silently skipped.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz", ".tgz", ".br", ".wasm",
  ".mp3", ".mp4", ".m4a", ".mov", ".webm", ".ogg", ".wav",
  ".jar", ".class", ".node", ".so", ".dylib", ".dll",
]);

/** True when a path's extension marks it as opaque binary (skip without reading). */
export function isBinaryExtension(path: string): boolean {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot <= slash + 1) return false; // no extension, or a dotfile like ".gitignore"
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

const NUL = String.fromCharCode(0);

/** A NUL byte in the first chunk means binary content regardless of the name. */
function looksBinary(text: string): boolean {
  return text.slice(0, 8192).indexOf(NUL) !== -1;
}

/** Rules that fire on one line of text, as {rule} — no matched text. */
export function scanLine(line: string): string[] {
  const hits: string[] = [];
  for (const { rule, pattern } of SCAN_RULES) {
    if (pattern.test(line)) hits.push(rule);
  }
  return hits;
}

export async function scanPayload(
  source: PayloadSource,
  revision: string,
  files: readonly TreeEntry[],
): Promise<SanitationReport> {
  const findings: LeakFinding[] = [];
  let scannedFiles = 0;
  for (const file of files) {
    if (isBinaryExtension(file.path)) continue;
    const text = await source.readTextFile(revision, file.path);
    if (looksBinary(text)) continue; // an image/font with a misleading or absent extension
    scannedFiles += 1;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      for (const rule of scanLine(lines[i] ?? "")) {
        findings.push({ path: file.path, line: i + 1, rule });
      }
    }
  }
  return { scannedFiles, passed: findings.length === 0, findings };
}

// ── build + verify ──────────────────────────────────────────────────────────

export interface BuildManifestOptions {
  /** ref to freeze; default "HEAD" */
  ref?: string;
  applicationSchema: number;
  dataSchemaMin: number;
  dataSchemaMax: number;
  /** injectable clock for deterministic builtAt in tests */
  now?: () => Date;
}

export async function buildReleaseManifest(
  source: PayloadSource,
  options: BuildManifestOptions,
): Promise<ReleaseManifest> {
  const sourceRevision = await source.resolveRevision(options.ref ?? "HEAD");
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new Error("resolveRevision did not return a 40-hex commit id");
  }
  if (
    !Number.isInteger(options.applicationSchema) || options.applicationSchema < 1 ||
    !Number.isInteger(options.dataSchemaMin) || options.dataSchemaMin < 1 ||
    !Number.isInteger(options.dataSchemaMax) || options.dataSchemaMax < options.dataSchemaMin
  ) {
    throw new Error("invalid schema range");
  }
  const files = [...(await source.listPayload(sourceRevision))]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length === 0) {
    throw new Error("release payload is empty — check PAYLOAD_ROOTS against the revision");
  }
  const artifactDigest = computeArtifactDigest(files);
  const sanitation = await scanPayload(source, sourceRevision, files);
  const builtAt = (options.now ? options.now() : new Date()).toISOString();

  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    sourceRevision,
    artifactDigest,
    applicationSchema: options.applicationSchema,
    dataSchemaMin: options.dataSchemaMin,
    dataSchemaMax: options.dataSchemaMax,
    builtAt,
    files,
    sanitation,
  };
}

export type ManifestVerification =
  | { ok: true }
  | { ok: false; reason: "UNKNOWN_MANIFEST_SCHEMA" | "BAD_SOURCE_REVISION" | "EMPTY_FILE_LIST" | "ARTIFACT_DIGEST_MISMATCH" | "SANITATION_NOT_PASSED" };

/**
 * Re-derives the seal: the file list must hash to the recorded artifactDigest
 * and the sanitation scan must have passed with no findings. This is what
 * promoteRelease() runs before letting a candidate become 'verified'.
 */
export function verifyManifest(manifest: ReleaseManifest): ManifestVerification {
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) return { ok: false, reason: "UNKNOWN_MANIFEST_SCHEMA" };
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceRevision)) return { ok: false, reason: "BAD_SOURCE_REVISION" };
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return { ok: false, reason: "EMPTY_FILE_LIST" };
  if (computeArtifactDigest(manifest.files) !== manifest.artifactDigest) return { ok: false, reason: "ARTIFACT_DIGEST_MISMATCH" };
  if (!manifest.sanitation || manifest.sanitation.passed !== true || manifest.sanitation.findings.length > 0) {
    return { ok: false, reason: "SANITATION_NOT_PASSED" };
  }
  return { ok: true };
}
