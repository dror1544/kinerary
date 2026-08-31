import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Boots the real server entrypoint — `src/server.ts`, the file the container
 * actually runs — rather than calling buildApp() with test-constructed
 * dependencies.
 *
 * Sprint 1 shipped a fully tested signup flow that returned 503 from every
 * route in a real deployment, because server.ts never assembled the signup
 * dependency block. Every test passed, because every test built the app
 * itself. This file exists so that failure mode is caught by the suite
 * instead of by someone deploying it.
 */

const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const serverEntrypoint = fileURLToPath(new URL("../src/server.ts", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not determine a free port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function baseProfile(port: number, workerPort: number): Record<string, unknown> {
  return {
    version: 1,
    environment: "test",
    public_api: { bind_host: "127.0.0.1", port },
    worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: workerPort },
    database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
    adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
    test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
  };
}

const signupBlock = {
  telegram_bot_token_secret_ref: "env://CONTROL_PLANE_TELEGRAM_BOT_TOKEN",
  super_admin_subject_digest: `sha256:${"0".repeat(64)}`,
  action_secret_ref: "env://CONTROL_PLANE_ACTION_SECRET",
  action_ttl_seconds: 3600,
  signup_rate_limit_cooldown_seconds: 3600,
  webhook_secret_ref: "env://CONTROL_PLANE_TELEGRAM_WEBHOOK_SECRET",
};

interface BootedServer {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Waits for a process expected to die on its own.
 *
 * The bound matters: if a boot that should fail instead succeeds, the process
 * runs forever and an unbounded wait would hang the suite rather than fail it.
 * A hang reads as "still working" in CI, which is exactly how a regression
 * here would go unnoticed.
 */
async function exitCodeWithin(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process was still running after ${timeoutMs}ms; it was expected to exit`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

async function bootServer(profile: Record<string, unknown>, port: number): Promise<BootedServer> {
  const directory = await mkdtemp(join(tmpdir(), "kinerary-control-plane-boot-"));
  const profilePath = join(directory, "architecture.json");
  await writeFile(profilePath, JSON.stringify(profile), "utf8");

  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", serverEntrypoint], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      CONTROL_PLANE_ARCHITECTURE_PROFILE: profilePath,
      // Satisfies the profile's env:// database reference. The pool is lazy,
      // so a syntactically valid URL is enough to boot; no route under test
      // touches the database.
      CONTROL_PLANE_DATABASE_URL: "postgresql://unused.invalid:5432/unused",
      CONTROL_PLANE_TELEGRAM_BOT_TOKEN: "12345678:AAFakeBootTestBotToken",
      CONTROL_PLANE_ACTION_SECRET: "boot-test-action-secret",
      CONTROL_PLANE_TELEGRAM_WEBHOOK_SECRET: "boot-test-webhook-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  let exited: number | null = null;
  child.on("exit", (code) => { exited = code ?? 0; });

  const stop = async () => {
    child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  };

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      await stop();
      throw new Error(`server exited with code ${exited} before listening:\n${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { port, stop };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await stop();
  throw new Error(`server did not listen within 20s:\n${stderr}`);
}

test("the real server entrypoint mounts the signup routes when the profile configures them", async () => {
  const port = await freePort();
  const workerPort = await freePort();
  const server = await bootServer({ ...baseProfile(port, workerPort), signup: signupBlock }, port);
  try {
    // An empty body is a validation failure, not a configuration failure. The
    // distinction is the whole point: 400 proves the route is mounted with a
    // real signup dependency block, 503 would mean server.ts never wired one.
    const response = await fetch(`http://127.0.0.1:${port}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.notEqual(response.status, 503, "signup routes are not wired into the real server entrypoint");
    assert.equal(response.status, 400);

    // The callback route is reachable too, and refuses an unsigned caller
    // rather than reporting itself unconfigured.
    const callback = await fetch(`http://127.0.0.1:${port}/v1/signup/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query: { from: { id: 1 }, data: "x" } }),
    });
    assert.equal(callback.status, 401);

    // Sprint 2: the interview routes are also mounted when the signup block is
    // configured. A missing enrollment token is 401, not 503.
    const interview = await fetch(`http://127.0.0.1:${port}/v1/interview`, { method: "POST" });
    assert.notEqual(interview.status, 503, "interview route is not wired into the real server entrypoint");
    assert.equal(interview.status, 401);

    // Sprint 3: the planner routes are also mounted when signup is configured.
    // A missing Telegram login header is 401, not 503.
    const releases = await fetch(`http://127.0.0.1:${port}/v1/releases`);
    assert.notEqual(releases.status, 503, "planner routes are not wired into the real server entrypoint");
    assert.equal(releases.status, 401);

    // Sprint 4: intake correction route is also mounted when signup is configured.
    const correction = await fetch(`http://127.0.0.1:${port}/v1/trips/trip_test/intake/correct`, { method: "POST" });
    assert.notEqual(correction.status, 503, "intake correction route is not wired into the real server entrypoint");
    assert.equal(correction.status, 401);
  } finally {
    await server.stop();
  }
});

test("the real server entrypoint still reports 503 when the profile omits signup", async () => {
  // Without this, the test above could pass for the wrong reason — a route
  // that never returns 503 would satisfy it whether or not wiring happened.
  const port = await freePort();
  const workerPort = await freePort();
  const server = await bootServer(baseProfile(port, workerPort), port);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
  } finally {
    await server.stop();
  }
});

test("the real server entrypoint resolves the database reference from the profile", async () => {
  // Previously server.ts read CONTROL_PLANE_DATABASE_URL_FILE directly and
  // ignored profile.database.connection_secret_ref, so an env:// or vault://
  // database reference validated and was then silently unused. Leaving the
  // reference unresolvable must now stop the boot.
  const port = await freePort();
  const workerPort = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "kinerary-control-plane-boot-"));
  try {
    const profilePath = join(directory, "architecture.json");
    await writeFile(profilePath, JSON.stringify(baseProfile(port, workerPort)), "utf8");

    const child = spawn(process.execPath, ["--import", "tsx", serverEntrypoint], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        CONTROL_PLANE_ARCHITECTURE_PROFILE: profilePath,
        // The profile's env:// reference has nothing behind it.
        CONTROL_PLANE_DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    const code = await exitCodeWithin(child, 20_000);
    assert.notEqual(code, 0, "an unresolvable database reference must fail the boot");
    assert.match(stderr, /env:\/\/CONTROL_PLANE_DATABASE_URL is unset or empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the real server entrypoint refuses to start when a signup secret cannot be resolved", async () => {
  const port = await freePort();
  const workerPort = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "kinerary-control-plane-boot-"));
  try {
    const profilePath = join(directory, "architecture.json");
    await writeFile(profilePath, JSON.stringify({ ...baseProfile(port, workerPort), signup: signupBlock }), "utf8");

    const child = spawn(process.execPath, ["--import", "tsx", serverEntrypoint], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        CONTROL_PLANE_ARCHITECTURE_PROFILE: profilePath,
        CONTROL_PLANE_DATABASE_URL: "postgresql://unused.invalid:5432/unused",
        // CONTROL_PLANE_TELEGRAM_BOT_TOKEN deliberately unset — a missing
        // secret must stop the boot rather than yield a half-configured
        // server that 503s at request time.
        CONTROL_PLANE_ACTION_SECRET: "boot-test-action-secret",
        CONTROL_PLANE_TELEGRAM_WEBHOOK_SECRET: "boot-test-webhook-secret",
        CONTROL_PLANE_TELEGRAM_BOT_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    const code = await exitCodeWithin(child, 20_000);
    assert.notEqual(code, 0, "a missing signup secret must fail the boot");
    assert.match(stderr, /CONTROL_PLANE_TELEGRAM_BOT_TOKEN is unset or empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
