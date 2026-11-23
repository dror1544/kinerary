import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

/**
 * The real `control-plane/runtime-gateway/server.js` as a child process, for the tests that need the real thing on
 * the wire (runtime-wildcard-e2e.test.ts spawns its own the same way). Only the variables it names are passed, so
 * nothing from the test runner's environment decides what the gateway does.
 */
const gatewayScript = fileURLToPath(new URL("../../../runtime-gateway/server.js", import.meta.url));

export interface GatewayProcess {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** Everything the gateway wrote to stdout and stderr so far (never printed by the harness itself). */
  output(): string;
  /** SIGKILL, and resolves once the process has exited (the port is then refused). */
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });
}

export async function startGatewayProcess(env: Record<string, string>): Promise<GatewayProcess> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const child: ChildProcess = spawn(process.execPath, [gatewayScript], {
    env: {
      PATH: process.env.PATH ?? "", PORT: String(port), BIND_HOST: "127.0.0.1",
      RUNTIME_ORIGIN: origin, RUNTIME_UPSTREAM_TIMEOUT_MS: "3000",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline || child.exitCode !== null) { child.kill("SIGKILL"); throw new Error(`the gateway did not start: ${output}`); }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    origin,
    output: () => output,
    stop: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } },
  };
}
