import { readFile } from "node:fs/promises";
import { z } from "zod";

const secretReference = z.string().regex(
  /^(?:env:\/\/[A-Z][A-Z0-9_]*|(?:file|vault):\/\/[A-Za-z0-9_./-]+)$/,
  "must be an opaque env://, file://, or vault:// secret reference",
).refine(
  // The character class above allows dots, so file://../../etc/passwd would
  // otherwise satisfy it.
  (value) => !value.slice(value.indexOf("://") + 3).split("/").includes(".."),
  "secret reference must not traverse parent directories",
);

const privateHost = z.enum(["127.0.0.1", "::1"]);

export const architectureProfileSchema = z.object({
  version: z.literal(1),
  environment: z.enum(["test", "development", "production"]),
  public_api: z.object({
    bind_host: z.string().min(1),
    port: z.number().int().min(1024).max(65535),
  }).strict(),
  worker: z.object({
    queue: z.literal("postgres"),
    health_bind_host: privateHost,
    health_port: z.number().int().min(1024).max(65535),
  }).strict(),
  database: z.object({
    connection_secret_ref: secretReference,
  }).strict(),
  adapters: z.object({
    compute: z.string().min(1),
    ingress: z.string().min(1),
    agent_runtime: z.string().min(1),
    messaging: z.string().min(1),
    secrets: z.string().min(1),
  }).strict(),
  test_resources: z.discriminatedUnion("enabled", [
    z.object({
      enabled: z.literal(true),
      label_key: z.literal("kinerary.test_run_id"),
      allowed_name_prefix: z.string().regex(/^kinerary-test-[a-z0-9-]+$/),
    }).strict(),
    z.object({ enabled: z.literal(false) }).strict(),
  ]),
  signup: z.object({
    telegram_bot_token_secret_ref: secretReference,
    /** SHA256 digest of the super-admin's Telegram numeric ID — not the raw ID. */
    super_admin_subject_digest: z.string().regex(
      /^sha256:[a-f0-9]{64}$/,
      "must be sha256:hex of the super-admin Telegram numeric ID",
    ),
    action_secret_ref: secretReference,
    action_ttl_seconds: z.number().int().min(60).max(86400).default(3600),
    signup_rate_limit_cooldown_seconds: z.number().int().min(0).max(86400).default(3600),
  }).strict().optional(),
}).strict().superRefine((profile, ctx) => {
  if (profile.environment === "production" && profile.test_resources.enabled) {
    ctx.addIssue({ code: "custom", path: ["test_resources"], message: "test resource selection must be disabled in production" });
  }
});

export type ArchitectureProfile = z.infer<typeof architectureProfileSchema>;

export function validateArchitectureProfile(raw: unknown): ArchitectureProfile {
  return architectureProfileSchema.parse(raw);
}

export async function loadArchitectureProfile(path: string): Promise<ArchitectureProfile> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return validateArchitectureProfile(raw);
}

export function validateBeforeProvider<T>(raw: unknown, providerFactory: () => T): T {
  validateArchitectureProfile(raw);
  return providerFactory();
}
