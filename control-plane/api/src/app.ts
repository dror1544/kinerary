import Fastify from "fastify";
import type { ArchitectureProfile } from "./config.js";
import { structuredLog } from "./redaction.js";

export interface AppDependencies {
  readiness?: () => Promise<Record<string, unknown>>;
  close?: () => Promise<void>;
  log?: (line: string) => void;
}

// A driver's message and stack routinely carry the connection string, so the
// only part of a failure worth logging is its SQLSTATE: a fixed five-character
// class code that cannot hold a credential.
function sqlstateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export function buildApp(profile: ArchitectureProfile, dependencies: AppDependencies = {}) {
  const log = dependencies.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const app = Fastify({ logger: false });
  app.get("/", async () => ({
    service: "kinerary-control-plane",
    sprint: 0,
    endpoints: ["/healthz", "/readyz"],
  }));
  app.get("/healthz", async () => ({ status: "ok", service: "control-plane-api" }));
  app.get("/readyz", async (_request, reply) => {
    if (!dependencies.readiness) {
      log(structuredLog("error", "readiness.unconfigured", { safe_error_code: "READINESS_UNCONFIGURED" }));
      return reply.code(503).send({ status: "not_ready", reason: "readiness_unconfigured" });
    }
    try {
      const details = await dependencies.readiness();
      return { status: "ready", profile_version: profile.version, ...details };
    } catch (error) {
      // The response stays opaque, but an outage must not be silent.
      log(structuredLog("error", "readiness.check_failed", {
        safe_error_code: "DATABASE_UNAVAILABLE",
        sqlstate: sqlstateOf(error),
      }));
      return reply.code(503).send({ status: "not_ready", reason: "database_unavailable" });
    }
  });
  if (dependencies.close) app.addHook("onClose", dependencies.close);
  return app;
}
