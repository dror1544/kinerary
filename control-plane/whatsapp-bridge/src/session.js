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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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

/** The real path of `target`, resolving symlinks in its nearest existing ancestor. */
function realish(target) {
  let existing = target;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...rest);
}

const REFUSED = "the session directory must not be inside a git work tree: it is a credential";

export function prepareSessionDir(dirArg) {
  if (typeof dirArg !== "string" || !dirArg.trim()) {
    throw new Error("a session directory is required (--session <dir>)");
  }
  const dir = path.resolve(dirArg);
  // Both the path as written and where it really leads: a symlink must not be
  // a way into a repository.
  if (insideWorkTree(dir) || insideWorkTree(realish(dir))) throw new Error(REFUSED);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = realpathSync(dir);
  if (insideWorkTree(real)) throw new Error(REFUSED);
  chmodSync(real, 0o700);
  const mode = statSync(real).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("the session directory is readable by others and could not be restricted");
  }
  return real;
}

/**
 * Does the session hold registered credentials? Read before the library is even
 * loaded: serving an unpaired session would make it ask for a QR and reconnect
 * for ever.
 */
export function sessionIsPaired(dir) {
  try {
    const creds = JSON.parse(readFileSync(path.join(dir, "creds.json"), "utf8"));
    return creds?.registered === true || !!creds?.me;
  } catch {
    return false;
  }
}
