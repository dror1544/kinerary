import Fastify from "fastify";
import type { ArchitectureProfile } from "./config.js";

export interface AppDependencies {
  readiness?: () => Promise<Record<string, unknown>>;
  close?: () => Promise<void>;
}

export function buildApp(profile: ArchitectureProfile, dependencies: AppDependencies = {}) {
  const app = Fastify({ logger: false });
  app.get("/", async () => ({
    service: "kinerary-control-plane",
    sprint: 0,
    endpoints: ["/healthz", "/readyz"],
  }));
  app.get("/healthz", async () => ({ status: "ok", service: "control-plane-api" }));
  app.get("/readyz", async (_request, reply) => {
    if (!dependencies.readiness) {
      return reply.code(503).send({ status: "not_ready", reason: "readiness_unconfigured" });
    }
    try {
      const details = await dependencies.readiness();
      return { status: "ready", profile_version: profile.version, ...details };
    } catch {
      return reply.code(503).send({ status: "not_ready", reason: "database_unavailable" });
    }
  });
  if (dependencies.close) app.addHook("onClose", dependencies.close);
  return app;
}
