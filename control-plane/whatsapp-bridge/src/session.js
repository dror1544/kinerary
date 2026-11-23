/**
 * The session directory is a credential: it gives full control of the WhatsApp
 * account, and the library keeps per-participant key files in it (spec 625,
 * Security notes). It is the deployment's state, so:
 *
 *  - it is an ARGUMENT, never a default;
 *  - it is created 0700 and forced to 0700 (a `mkdir` mode is subject to umask);
 *  - it is refused when it sits inside a git work tree, which is how a
 *    credential ends up in a commit.
 */
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

function insideWorkTree(start) {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function prepareSessionDir(dirArg) {
  if (typeof dirArg !== "string" || !dirArg.trim()) {
    throw new Error("a session directory is required (--session <dir>)");
  }
  const dir = path.resolve(dirArg);
  if (insideWorkTree(dir)) {
    throw new Error("the session directory must not be inside a git work tree: it is a credential");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const mode = statSync(dir).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("the session directory is readable by others and could not be restricted");
  }
  return dir;
}
