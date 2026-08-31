// The production PayloadSource for the release build: a thin wrapper over `git`
// against a checkout of this repo. git ls-tree gives the exact tracked file set
// at a revision plus each file's blob sha (git's own content hash), so the
// artifact digest is revision-accurate and needs no filesystem walk or
// node_modules/data exclusions of its own.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PAYLOAD_ROOTS, type PayloadSource, type TreeEntry } from "./release-artifact.js";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export function createGitPayloadSource(repoRoot: string): PayloadSource {
  const git = (args: string[]) => run("git", args, { cwd: repoRoot, maxBuffer: MAX_BUFFER });

  return {
    async resolveRevision(ref: string): Promise<string> {
      // `<ref>^{commit}` peels a tag/branch to the commit; --verify fails loudly
      // on an unknown ref instead of echoing it back.
      const { stdout } = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
      return stdout.trim();
    },

    async listPayload(revision: string): Promise<TreeEntry[]> {
      const { stdout } = await git(["ls-tree", "-r", revision, "--", ...PAYLOAD_ROOTS]);
      const entries: TreeEntry[] = [];
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        // "<mode> SP <type> SP <sha> TAB <path>"
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const meta = line.slice(0, tab).split(/\s+/);
        const blobSha = meta[2];
        if (meta[1] !== "blob" || !blobSha) continue; // skip tree / submodule (commit) rows
        entries.push({ path: line.slice(tab + 1), blobSha });
      }
      return entries;
    },

    async readTextFile(revision: string, path: string): Promise<string> {
      const { stdout } = await git(["show", `${revision}:${path}`]);
      return stdout;
    },
  };
}
