import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  buildReleaseManifest,
  computeArtifactDigest,
  isBinaryExtension,
  scanLine,
  verifyManifest,
  type PayloadSource,
  type ReleaseManifest,
  type TreeEntry,
} from "../src/release-artifact.js";

// ── A fake PayloadSource: a fixed revision, an in-memory file map ────────────

function fakeSource(files: Record<string, string>, revision = "a".repeat(40)): PayloadSource {
  const sha = (s: string) => {
    // any stable 40-hex derived from the content; the digest only needs it to
    // be a function of the bytes.
    let h = 0n;
    for (const ch of s) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 160n);
    return h.toString(16).padStart(40, "0").slice(0, 40);
  };
  return {
    async resolveRevision() { return revision; },
    async listPayload() {
      return Object.entries(files).map(([path, content]) => ({ path, blobSha: sha(content) }));
    },
    async readTextFile(_rev, path) {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file ${path}`);
      return content;
    },
  };
}

const CLEAN_PAYLOAD = {
  "site/app.js": "const h = { Authorization: `Bearer ${token}` };\nfetch('/api/x', { headers: h });\n",
  "server/server.js": "// connects via env only\nconst url = process.env.DB_URL;\n",
  "shared/schema.js": "export const V = 1;\n",
  "site/logo.png": "\u0000PNG-binary-not-scanned\u0000",
};

// ── computeArtifactDigest ──────────────────────────────────────────────────

describe("computeArtifactDigest", () => {
  const files: TreeEntry[] = [
    { path: "site/app.js", blobSha: "1".repeat(40) },
    { path: "server/server.js", blobSha: "2".repeat(40) },
  ];

  test("is a sha256 ref and is order-independent", () => {
    const a = computeArtifactDigest(files);
    const b = computeArtifactDigest([...files].reverse());
    assert.match(a, /^sha256:[a-f0-9]{64}$/);
    assert.equal(a, b);
  });

  test("changes when a file's content hash changes", () => {
    const before = computeArtifactDigest(files);
    const after = computeArtifactDigest([{ ...files[0]!, blobSha: "9".repeat(40) }, files[1]!]);
    assert.notEqual(before, after);
  });

  test("changes when a file is added or removed", () => {
    const base = computeArtifactDigest(files);
    const more = computeArtifactDigest([...files, { path: "shared/x.js", blobSha: "3".repeat(40) }]);
    assert.notEqual(base, more);
  });
});

// ── scanLine ──────────────────────────────────────────────────────────────

describe("scanLine", () => {
  test("flags real leaks", () => {
    assert.deepEqual(scanLine("host = 192.168.0.202"), ["private-ipv4"]);
    assert.deepEqual(scanLine("const p = '/Users/elul/kinerary/secret'"), ["host-path"]);
    assert.deepEqual(scanLine("PVEAPIToken=root@pam!ci=0123456789abcdef0123"), ["pve-api-token"]);
    assert.deepEqual(scanLine("DATABASE_URL=postgres://admin:hunter2@db.internal/app"), ["connection-userinfo"]);
    assert.deepEqual(scanLine("token: eyJhbGciOiJ.eyJzdWIiOiIxMj.SflKxwRJSMeKKF"), ["jwt-literal"]);
    assert.deepEqual(scanLine("aws_key = AKIAIOSFODNN7EXAMPLE"), ["aws-access-key"]);
    assert.deepEqual(scanLine("token ghp_abcdefghijklmnopqrstuvwxyz0123456789"), ["github-pat"]);
    assert.deepEqual(scanLine("-----BEGIN OPENSSH PRIVATE KEY-----"), ["private-key-block"]);
  });

  test("does not flag legitimate source", () => {
    assert.deepEqual(scanLine("headers: { Authorization: `Bearer ${token}` }"), []);
    assert.deepEqual(scanLine("CONTROL_PLANE_TEST_DATABASE_URL: postgresql://kinerary_test@localhost:5432/db"), []);
    assert.deepEqual(scanLine("const semver = '10.15.7'; // not an address"), []);
    assert.deepEqual(scanLine("released 2026-08-30, see 172.20 spec section"), []);
    assert.deepEqual(scanLine("// see mcp/PROVISIONING.md about /home/ layout"), []);
  });
});

test("isBinaryExtension: images/fonts skipped, code and extensionless runtime files not", () => {
  assert.equal(isBinaryExtension("site/logo.png"), true);
  assert.equal(isBinaryExtension("site/font.woff2"), true);
  assert.equal(isBinaryExtension("site/app.js"), false);
  assert.equal(isBinaryExtension("shared/needs-schema.js"), false);
  // The bug this replaced: an extension-only classifier called Dockerfile
  // "not scannable" and skipped it, so a leak there promoted as clean.
  assert.equal(isBinaryExtension("server/Dockerfile"), false);
  assert.equal(isBinaryExtension("Makefile"), false);
  assert.equal(isBinaryExtension("server/.dockerignore"), false);
});

// ── buildReleaseManifest ──────────────────────────────────────────────────

describe("buildReleaseManifest", () => {
  const opts = {
    applicationSchema: 1,
    dataSchemaMin: 1,
    dataSchemaMax: 2,
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  };

  test("a clean payload builds a passing, self-consistent manifest", async () => {
    const manifest = await buildReleaseManifest(fakeSource(CLEAN_PAYLOAD), opts);
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.sourceRevision, "a".repeat(40));
    assert.match(manifest.artifactDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(manifest.artifactDigest, computeArtifactDigest(manifest.files));
    assert.equal(manifest.files.length, 4);
    assert.equal(manifest.sanitation.passed, true);
    assert.equal(manifest.sanitation.findings.length, 0);
    // the .png is listed (integrity) but not scanned
    assert.equal(manifest.sanitation.scannedFiles, 3);
    assert.deepEqual(verifyManifest(manifest), { ok: true });
  });

  test("files are sorted so the digest is build-order independent", async () => {
    const a = await buildReleaseManifest(fakeSource(CLEAN_PAYLOAD), opts);
    const shuffled = Object.fromEntries(Object.entries(CLEAN_PAYLOAD).reverse());
    const b = await buildReleaseManifest(fakeSource(shuffled), opts);
    assert.equal(a.artifactDigest, b.artifactDigest);
    assert.deepEqual(a.files.map((f) => f.path), b.files.map((f) => f.path));
  });

  test("a planted secret fails the scan and names the file:line and rule only", async () => {
    const poisoned = {
      ...CLEAN_PAYLOAD,
      "server/server.js": "line one\nconst PROXMOX = '192.168.0.202';\nline three\n",
    };
    const manifest = await buildReleaseManifest(fakeSource(poisoned), opts);
    assert.equal(manifest.sanitation.passed, false);
    assert.deepEqual(manifest.sanitation.findings, [
      { path: "server/server.js", line: 2, rule: "private-ipv4" },
    ]);
    // no offending value anywhere in the manifest
    assert.ok(!JSON.stringify(manifest).includes("192.168.0.202"));
    assert.equal(verifyManifest(manifest).ok, false);
  });

  test("rejects an empty payload and a bad schema range", async () => {
    await assert.rejects(buildReleaseManifest(fakeSource({}), opts), /payload is empty/);
    await assert.rejects(
      buildReleaseManifest(fakeSource(CLEAN_PAYLOAD), { ...opts, dataSchemaMax: 0 }),
      /schema range/,
    );
  });

  test("scans an extensionless runtime file — a leak in server/Dockerfile is caught", async () => {
    const manifest = await buildReleaseManifest(fakeSource({
      ...CLEAN_PAYLOAD,
      "server/Dockerfile": "FROM node:20\nENV DB_HOST=10.0.0.9\nCMD [\"node\", \"server.js\"]\n",
    }), opts);
    assert.equal(manifest.sanitation.scannedFiles, 4, "the Dockerfile must be one of the scanned files");
    assert.deepEqual(manifest.sanitation.findings, [
      { path: "server/Dockerfile", line: 2, rule: "private-ipv4" },
    ]);
    assert.equal(manifest.sanitation.passed, false);
  });

  test("a NUL-byte file with a text-ish name is treated as binary, not scanned", async () => {
    const manifest = await buildReleaseManifest(fakeSource({
      ...CLEAN_PAYLOAD,
      "site/blob.js": `header${String.fromCharCode(0)}\x01\x02 10.0.0.1 raw bytes`,
    }), opts);
    // still in the file list / digest, but never line-scanned, so its "10.0.0.1" is not a finding
    assert.ok(manifest.files.some((f) => f.path === "site/blob.js"));
    assert.equal(manifest.sanitation.findings.length, 0);
    assert.equal(manifest.sanitation.passed, true);
  });
});

// ── verifyManifest ────────────────────────────────────────────────────────

describe("verifyManifest", () => {
  async function fresh(): Promise<ReleaseManifest> {
    return buildReleaseManifest(fakeSource(CLEAN_PAYLOAD), {
      applicationSchema: 1, dataSchemaMin: 1, dataSchemaMax: 2,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
  }

  test("passes a freshly built manifest", async () => {
    assert.deepEqual(verifyManifest(await fresh()), { ok: true });
  });

  test("breaks the seal when the file list is tampered with", async () => {
    const m = await fresh();
    m.files.push({ path: "server/backdoor.js", blobSha: "f".repeat(40) });
    assert.deepEqual(verifyManifest(m), { ok: false, reason: "ARTIFACT_DIGEST_MISMATCH" });
  });

  test("rejects a manifest carrying sanitation findings", async () => {
    const m = await fresh();
    m.sanitation = { scannedFiles: 3, passed: false, findings: [{ path: "x", line: 1, rule: "private-ipv4" }] };
    assert.deepEqual(verifyManifest(m), { ok: false, reason: "SANITATION_NOT_PASSED" });
  });

  test("rejects an empty file list and a bad revision", async () => {
    const m = await fresh();
    assert.equal(verifyManifest({ ...m, files: [] }).ok, false);
    assert.equal(verifyManifest({ ...m, sourceRevision: "nope" }).ok, false);
  });
});
