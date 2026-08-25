import { readFile } from "node:fs/promises";
import { z } from "zod";

const secretReference = z.string().regex(
  // vault:// carries a #field selector because a KV secret holds several
  // pairs — without it the reference would not say which one it means, and
  // "the only field" is not a property the schema can enforce.
  /^(?:env:\/\/[A-Z][A-Z0-9_]*|file:\/\/[A-Za-z0-9_./-]+|vault:\/\/[A-Za-z0-9_./-]+#[A-Za-z0-9_.-]+)$/,
  "must be an opaque env://, file://, or vault://<path>#<field> secret reference",
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
    /**
     * The super-admin's raw Telegram numeric ID, used only as the outbound
     * sendMessage chat_id — the digest above cannot be reversed to find where
     * to deliver the DM. Independent of super_admin_subject_digest: this
     * value is never used to authenticate an inbound sender, only to address
     * an outbound one. Required when adapters.messaging is "telegram".
     */
    super_admin_chat_id_secret_ref: secretReference.optional(),
    action_secret_ref: secretReference,
    action_ttl_seconds: z.number().int().min(60).max(86400).default(3600),
    signup_rate_limit_cooldown_seconds: z.number().int().min(0).max(86400).default(3600),
    /** Seconds until an issued enrollment link expires. Default 24 hours. */
    enrollment_ttl_seconds: z.number().int().min(60).max(604800).default(86400),
    // Registered with Telegram via setWebhook's secret_token param. The
    // callback route verifies this header instead of trusting a client-
    // supplied sender identity — see identity.ts's verifyTelegramWebhookSecret.
    webhook_secret_ref: secretReference,
  }).strict().optional(),
  web: z.object({
    public_origin: z.string().url(),
    runtime_origin: z.string().url(),
    google_client_id_secret_ref: secretReference,
    google_client_secret_ref: secretReference,
    runtime_exchange_key_secret_ref: secretReference,
    runtime_upstream_host_suffixes: z.array(z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/)).min(1),
    telegram_bot_username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
    provisioning_admin_subject_digests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1),
    session_ttl_seconds: z.number().int().min(3600).max(2592000).default(604800),
  }).strict().optional(),
}).strict().superRefine((profile, ctx) => {
  if (profile.environment === "production" && profile.test_resources.enabled) {
    ctx.addIssue({ code: "custom", path: ["test_resources"], message: "test resource selection must be disabled in production" });
  }
  if (profile.environment === "production" && profile.signup && profile.adapters.messaging === "fake") {
    ctx.addIssue({
      code: "custom",
      path: ["adapters", "messaging"],
      message: "a production profile with signup configured must not select the fake messaging adapter — the super-admin would never receive a real approval notification",
    });
  }
  if (profile.adapters.messaging === "telegram" && profile.signup && !profile.signup.super_admin_chat_id_secret_ref) {
    ctx.addIssue({
      code: "custom",
      path: ["signup", "super_admin_chat_id_secret_ref"],
      message: "the telegram messaging adapter needs super_admin_chat_id_secret_ref to know where to send the approval DM",
    });
  }
  if (profile.web && profile.web.public_origin === profile.web.runtime_origin) {
    ctx.addIssue({ code: "custom", path: ["web", "runtime_origin"], message: "runtime origin must be isolated from the organizer origin" });
  }
  if (profile.environment === "production" && profile.web) {
    for (const [key, value] of [["public_origin", profile.web.public_origin], ["runtime_origin", profile.web.runtime_origin]] as const) {
      if (!value.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["web", key], message: "production web origins must use https" });
    }
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
