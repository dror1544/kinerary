import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, chmodSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseArgs, UsageError } from "../src/cli.js";
import { prepareSessionDir, sessionIsPaired } from "../src/session.js";
import { SECRET, tempDir } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "bridge.js");

test("arguments: the session and the port are required; the secret comes from the environment or a private file, never argv", () => {
  assert.throws(() => parseArgs(["--port", "4000"], { WHATSAPP_BRIDGE_SECRET: SECRET }), UsageError);
  assert.throws(() => parseArgs(["--session", "/x"], { WHATSAPP_BRIDGE_SECRET: SECRET }), /--port/);
  assert.throws(() => parseArgs(["--session", "/x", "--port", "70000"], { WHATSAPP_BRIDGE_SECRET: SECRET }), /--port/);
  assert.throws(() => parseArgs(["--session", "/x", "--port", "4000"], {}), /secret/);
  assert.throws(() => parseArgs(["--session", "/x", "--port", "4000"], { WHATSAPP_BRIDGE_SECRET: "short" }), /32 characters/);
  // A secret on the command line is not accepted.
  assert.throws(() => parseArgs(["--session", "/x", "--port", "4000", "--secret", SECRET], {}), /secret/);
  assert.deepEqual(parseArgs(["--session", "/x", "--port", "4000"], { WHATSAPP_BRIDGE_SECRET: SECRET }), {
    pairOnly: false,
    session: "/x",
    port: 4000,
    secret: SECRET,
  });
  assert.deepEqual(parseArgs(["--session", "/x", "--pair-only"], {}), { pairOnly: true, session: "/x" });
});

test("the secret: trimmed, no whitespace inside, at least 32 characters, and removed from the environment once read", () => {
  const env = { WHATSAPP_BRIDGE_SECRET: `  ${SECRET}\n` };
  assert.equal(parseArgs(["--session", "/x", "--port", "4000"], env).secret, SECRET);
  assert.equal("WHATSAPP_BRIDGE_SECRET" in env, false, "deleted after reading");
  for (const bad of [`${SECRET} x`, `${SECRET}\tx`, "a".repeat(31), "a b".repeat(20)]) {
    const e = { WHATSAPP_BRIDGE_SECRET: bad };
    assert.throws(() => parseArgs(["--session", "/x", "--port", "4000"], e), /32 characters|whitespace/, JSON.stringify(bad));
    assert.equal("WHATSAPP_BRIDGE_SECRET" in e, false, "deleted even when refused");
  }
  assert.equal(parseArgs(["--session", "/x", "--port", "4000"], { WHATSAPP_BRIDGE_SECRET: "a".repeat(32) }).secret.length, 32);
});

test("a secret file readable by group or others is refused", () => {
  const dir = tempDir();
  const file = path.join(dir, "secret");
  writeFileSync(file, `${SECRET}\n`, { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.throws(() => parseArgs(["--session", "/x", "--port", "4000", "--secret-file", file], {}), /readable by group or others/);
  chmodSync(file, 0o600);
  assert.equal(parseArgs(["--session", "/x", "--port", "4000", "--secret-file", file], {}).secret, SECRET);
});

test("the session directory is created 0700 and forced to 0700 if it already existed wider", () => {
  const parent = tempDir();
  const fresh = path.join(parent, "a", "b", "session");
  // Returned as the real path (a temp dir is itself reached through a symlink on macOS).
  assert.equal(prepareSessionDir(fresh), path.join(realpathSync(parent), "a", "b", "session"));
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
  const wide = path.join(parent, "wide");
  mkdirSync(wide, { mode: 0o755 });
  chmodSync(wide, 0o755);
  prepareSessionDir(wide);
  assert.equal(statSync(wide).mode & 0o777, 0o700);
  assert.throws(() => prepareSessionDir(""), /required/);
  assert.throws(() => prepareSessionDir(undefined), /required/);
});

test("a session directory inside a git work tree (this repository, for one) is refused", () => {
  // The package itself lives in this repository's work tree.
  assert.throws(() => prepareSessionDir(path.join(here, "..", "session")), /git work tree/);
  const fake = tempDir();
  mkdirSync(path.join(fake, ".git"));
  assert.throws(() => prepareSessionDir(path.join(fake, "state", "session")), /git work tree/);
});

test("a symlink is not a way into a repository: a linked parent, or a session path that is itself a link, is refused", () => {
  const repo = tempDir("wa-repo-");
  mkdirSync(path.join(repo, ".git"));
  mkdirSync(path.join(repo, "sub"));
  const outside = tempDir("wa-outside-");

  // A symlinked PARENT that leads into the repository; the session dir does not exist yet.
  symlinkSync(repo, path.join(outside, "linked-parent"));
  assert.throws(() => prepareSessionDir(path.join(outside, "linked-parent", "state", "session")), /git work tree/);
  assert.equal(existsSync(path.join(repo, "state")), false, "nothing was created inside the repository");

  // The session path ITSELF is a symlink from outside into the repository.
  symlinkSync(path.join(repo, "sub"), path.join(outside, "session"));
  assert.throws(() => prepareSessionDir(path.join(outside, "session")), /git work tree/);
  assert.deepEqual(readdirSync(path.join(repo, "sub")), []);

  // A link that stays outside is fine.
  const elsewhere = tempDir("wa-elsewhere-");
  symlinkSync(elsewhere, path.join(outside, "ok-link"));
  assert.equal(prepareSessionDir(path.join(outside, "ok-link", "session")), path.join(realpathSync(elsewhere), "session"));
});

test("sessionIsPaired reads the credentials file: registered or with an identity is paired; absent, unreadable or unregistered is not", () => {
  const dir = tempDir();
  assert.equal(sessionIsPaired(dir), false);
  writeFileSync(path.join(dir, "creds.json"), "not json");
  assert.equal(sessionIsPaired(dir), false);
  writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ registered: false }));
  assert.equal(sessionIsPaired(dir), false);
  writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ registered: true }));
  assert.equal(sessionIsPaired(dir), true);
  writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: { id: "1:2@s.whatsapp.net" } }));
  assert.equal(sessionIsPaired(dir), true);
});

test("serving an unpaired session exits 3 before the library is loaded or anything listens", () => {
  const session = path.join(tempDir(), "s");
  const res = spawnSync(process.execPath, [entry, "--session", session, "--port", "4000"], {
    env: { PATH: process.env.PATH, WHATSAPP_BRIDGE_SECRET: SECRET },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(res.status, 3);
  assert.match(res.stderr, /not paired/);
  assert.match(res.stderr, /"event":"unpaired"/);
  assert.ok(!res.stderr.includes(SECRET));
});

test("the process refuses to start without a session, without a port, without a secret: exit 2, usage, no library loaded", () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [entry, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });
  for (const [args, env, pattern] of [
    [[], {}, /--session/],
    [["--session", path.join(tempDir(), "s")], { WHATSAPP_BRIDGE_SECRET: SECRET }, /--port/],
    [["--session", path.join(tempDir(), "s"), "--port", "4000"], {}, /secret/],
    [["--session", path.join(here, "..", "s"), "--port", "4000"], { WHATSAPP_BRIDGE_SECRET: SECRET }, /git work tree/],
    [["--session", path.join(tempDir(), "s"), "--port", "4000"], { WHATSAPP_BRIDGE_SECRET: "too-short" }, /32 characters/],
  ]) {
    const res = run(args, env);
    assert.equal(res.status, 2, `${args.join(" ")}: ${res.stderr}`);
    assert.match(res.stderr, pattern);
    assert.match(res.stderr, /usage:/);
  }
});
