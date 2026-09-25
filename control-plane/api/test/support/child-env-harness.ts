/**
 * The fake-binary + planted-secret harness the three model-runner isolation
 * tests share (codex, claude, hermes). Each one asks the same black-box
 * question — "what did the child process actually receive?" — so the parts
 * that are not specific to one CLI live here once instead of three times.
 *
 * Deliberately knows nothing about model-runner: it imports no implementation
 * constant, so a test built on it cannot end up asserting that the code equals
 * itself.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Secret-shaped names the relay genuinely holds (or could), planted in the parent. */
export const RELAY_SECRET_NAMES = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "CONTROL_PLANE_DATABASE_URL",
  "CONTROL_PLANE_INTERVIEW_AGENT_KEY",
  "CONTROL_PLANE_CHAT_ROUTING_KEY",
  "INTERVIEW_MCP_KEY",
  "RELAY_SECRET",
  "KINERARY_TEST_SECRET",
] as const;

/** A directory that is removed again, for fake CLI binaries. */
export async function withFakeBinDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes an executable node script named `name` into `dir` and returns its path. */
export async function writeFakeBin(dir: string, name: string, scriptLines: readonly string[]): Promise<string> {
  const bin = join(dir, name);
  await writeFile(bin, ["#!/usr/bin/env node", ...scriptLines].join("\n"));
  await chmod(bin, 0o755);
  return bin;
}

/** Sets the given variables for the duration of `fn`, then restores every one. */
export async function withPlantedEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** One planted canary per relay secret name, each value naming who must not see it. */
export function plantedSecrets(victim: string): Record<string, string> {
  return Object.fromEntries(RELAY_SECRET_NAMES.map((name) => [name, `must-not-reach-${victim}:${name}`]));
}

/**
 * Added by the operating system to every child, not inherited from us, so a
 * subset check must not count them. Verified: a Node child spawned with
 * `env: { PATH }` and nothing else still reports `__CF_USER_TEXT_ENCODING` on
 * macOS. It carries a user id and an encoding, never a credential.
 */
export const OS_INJECTED = new Set(["__CF_USER_TEXT_ENCODING"]);
