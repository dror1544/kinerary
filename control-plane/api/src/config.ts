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
  /**
   * The Trip Bot relay connector — the WebSocket server Hermes's gateway dials
   * OUT to, plus the shared bot token the connector polls.
   *
   * Runs as its own process (relay/server.ts), so this block is optional: an
   * API-only deployment simply omits it. Its absence is what keeps the bot
   * dark, which is a supported state, not a broken one.
   */
  relay: z.object({
    /**
     * Private hosts only, and not merely by convention. The gateway
     * authenticates with an HMAC upgrade token and the connector holds the bot
     * token; binding this to a public interface would expose the socket that
     * sends as the trip bot to anything that can reach the port.
     */
    bind_host: privateHost,
    port: z.number().int().min(1024).max(65535),
    /**
     * Accepted upgrade-token signing secrets, newest first. A LIST because
     * rotation has to be able to overlap: the gateway may still be presenting
     * a token signed with the previous secret when this side restarts, and a
     * single-valued field would drop those connections rather than carry them
     * through the change.
     */
    gateway_secret_refs: z.array(secretReference).min(1),
    /**
     * The shared trip bot's token, kept as its own ref because signup and trip
     * are distinct ROLES — not because they are guaranteed to be distinct bots.
     *
     * On this deployment they are in fact the SAME bot, and an earlier version
     * of this comment asserted the opposite. That mattered: Telegram hands each
     * update to exactly one getUpdates caller, so two loops on one token steal
     * from each other at random rather than sharing the work. The relay poller
     * therefore subsumes the approval poller when the two refs resolve to the
     * same token — detected by comparing the resolved values, since that is a
     * fact the process can observe rather than a flag someone can set wrong.
     */
    telegram_bot_token_secret_ref: secretReference,
    /**
     * The Hermes profile that serves written interview answers.
     *
     * One shared profile, not one per trip: an inbound chat with no live
     * binding is routed to the interviewer by design, so the same profile
     * fronts every newcomer.
     *
     * OPTIONAL, and its absence is a working state rather than a broken one.
     * With no profile configured the router keeps answering a written mid-
     * interview message itself, which means saying plainly that it cannot
     * record one. Forwarding only begins once there is somewhere to forward
     * to.
     */
    interviewer_profile: z.string().min(1).optional(),
  }).strict().optional(),
}).strict().superRefine((profile, ctx) => {
  if (profile.relay) {
    // All three services default into the same 431x range, and a collision
    // surfaces as EADDRINUSE at boot on whichever loses the race — or, worse,
    // as one service quietly never starting.
    const taken = new Map<number, string>([
      [profile.public_api.port, "public_api.port"],
      [profile.worker.health_port, "worker.health_port"],
    ]);
    const clash = taken.get(profile.relay.port);
    if (clash) {
      ctx.addIssue({
        code: "custom",
        path: ["relay", "port"],
        message: `relay.port must not collide with ${clash}`,
      });
    }
  }
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
