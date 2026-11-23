import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseArgs, UsageError } from "../src/cli.js";
import { prepareSessionDir } from "../src/session.js";
import { SECRET, tempDir } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "bridge.js");

test("arguments: the session and the port are required; the secret comes from the environment or a private file, never argv", () => {
  assert.throws(() => parseArgs(["--port", "4000"], { WHATSAPP_BRIDGE_SECRET: SECRET }), UsageError);
  assert.throws(() => parseArgs(["--session", "/x"], { WHATSAPP_BRIDGE_SECRET: SECRET }), /--port/);
  assert.throws(() => parseArgs(["--session", "/x", "--port", "70000"], { WHATSAPP_BRIDGE_SECRET: SECRET }), /--port/);
  assert.throws(() => parseArgs(["--session", "/x", "--port", "4000"], {}), /secret/);
  assert.throws(() => parseArgs(["--session", "/x", "--port", "4000"], { WHATSAPP_BRIDGE_SECRET: "short" }), /16 characters/);
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
  assert.equal(prepareSessionDir(fresh), fresh);
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

test("the process refuses to start without a session, without a port, without a secret: exit 2, usage, no library loaded", () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [entry, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });
  for (const [args, env, pattern] of [
    [[], {}, /--session/],
    [["--session", path.join(tempDir(), "s")], { WHATSAPP_BRIDGE_SECRET: SECRET }, /--port/],
    [["--session", path.join(tempDir(), "s"), "--port", "4000"], {}, /secret/],
    [["--session", path.join(here, "..", "s"), "--port", "4000"], { WHATSAPP_BRIDGE_SECRET: SECRET }, /git work tree/],
  ]) {
    const res = run(args, env);
    assert.equal(res.status, 2, `${args.join(" ")}: ${res.stderr}`);
    assert.match(res.stderr, pattern);
    assert.match(res.stderr, /usage:/);
  }
});
