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

/** `new URL(x).origin`; an origin the URL parser calls opaque ("null") is not a usable origin. */
function originOf(value: string, ctx: z.RefinementCtx): string {
  const origin = new URL(value).origin;
  if (origin === "null") {
    ctx.addIssue({ code: "custom", message: "must be an http(s) origin" });
    return z.NEVER;
  }
  return origin;
}

export const GOOGLE_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;

/** A key the profile used to carry, now refused with the instruction instead of a bare "unrecognized key". */
function removedGoogleField(name: string) {
  return z.unknown().superRefine((value, ctx) => {
    if (value === undefined) return;
    ctx.addIssue({
      code: "custom",
      message: `web.${name} is no longer supported: Google sign-in now uses Google Identity Services and needs only the public OAuth client ID. `
        + `Remove web.google_client_id_secret_ref and web.google_client_secret_ref, and set web.google_client_id to the client ID `
        + `(a string ending in .apps.googleusercontent.com, not a secret reference).`,
    });
  }).optional();
}

export const architectureProfileSchema = z.object({
  version: z.literal(1),
  environment: z.enum(["test", "development", "production"]),
  public_api: z.object({
    bind_host: z.string().min(1),
    port: z.number().int().min(1024).max(65535),
    /**
     * Which proxies in front of this API may speak for the client's address.
     * OFF (absent) is the default and means `request.ip` is the socket peer —
     * correct for a direct deployment, and for one behind a proxy it means every
     * client shares the proxy's address, so the per-IP sign-in limits
     * (/v1/auth/email-password, /v1/auth/password, /v1/auth/telegram-mini-app)
     * become one global budget. Set it to the proxy's address(es) or CIDR(s) —
     * or a hop count when the chain is fixed — and Fastify takes the client's
     * address from `X-Forwarded-For` ONLY for requests arriving from them. A
     * wrong list is worse than none: it lets a caller pick their own address.
     */
    trust_proxy: z.union([
      z.number().int().min(1).max(8),
      z.array(z.string().min(1).max(64)).min(1).max(16),
    ]).optional(),
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
    /**
     * Grant the trip at signup rather than waiting for the super-admin's
     * approve tap. This is the front-door admission gate, so it defaults to
     * FALSE and a profile that omits it keeps the operator in the loop.
     * Intended for a local stack whose API binds to 127.0.0.1; on anything
     * reachable it means whoever can POST /v1/signup gets a trip.
     */
    auto_approve: z.boolean().default(false),
    /** Seconds until an issued enrollment link expires. Default 24 hours. */
    enrollment_ttl_seconds: z.number().int().min(60).max(604800).default(86400),
    // Registered with Telegram via setWebhook's secret_token param. The
    // callback route verifies this header instead of trusting a client-
    // supplied sender identity — see identity.ts's verifyTelegramWebhookSecret.
    webhook_secret_ref: secretReference,
  }).strict().optional(),
  web: z.object({
    // Normalised to the WHATWG origin (scheme://host[:port], lower case, default port dropped, no
    // trailing slash or path): the browser's Origin header is always in that form, so a profile written
    // "https://Portal.example/" must still equal it, or every mutation would be refused as a foreign origin.
    public_origin: z.string().url().transform(originOf),
    runtime_origin: z.string().url().transform(originOf),
    /**
     * The OAuth client ID for "Sign in with Google" (Google Identity Services), a plain string. It is PUBLIC:
     * the page needs it to draw Google's button, so it is served by GET /v1/auth/capabilities and is not a
     * secret reference. The sign-in is the ID-token flow (POST /v1/auth/google verifies Google's signed token
     * against this audience), so there is no client secret anywhere. ABSENT means Google sign-in is off.
     * Create the client as type "Web application" with the portal origin under "Authorized JavaScript origins"
     * (docs/control-plane-vm-deployment.md).
     */
    google_client_id: z.string().max(256).regex(GOOGLE_CLIENT_ID_PATTERN, "must be an OAuth client ID ending in .apps.googleusercontent.com").optional(),
    // The two fields the server-side OIDC redirect flow used. They are REFUSED rather than ignored: a profile
    // that still names them would otherwise boot with Google sign-in silently off (unset is a downgrade, not
    // an error), or fail with a bare "unrecognized key" that does not say what to do.
    google_client_id_secret_ref: removedGoogleField("google_client_id_secret_ref"),
    google_client_secret_ref: removedGoogleField("google_client_secret_ref"),
    runtime_exchange_key_secret_ref: secretReference,
    runtime_upstream_host_suffixes: z.array(z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/)).min(1),
    telegram_bot_username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
    /**
     * The token of the bot whose Mini App signs people in. OPTIONAL, and absent
     * means the feature is OFF (logged at boot, and `capabilities` says so) — it
     * never falls back to some other configured bot token. At boot `getMe` on
     * this token must name `telegram_bot_username`, or the feature stays off:
     * a token for a different bot would otherwise verify that bot's launches.
     */
    telegram_bot_token_secret_ref: secretReference.optional(),
    /** How old a Mini App launch's `auth_date` may be. Telegram's own guidance is minutes, not hours. */
    telegram_init_data_max_age_seconds: z.number().int().min(60).max(3600).default(300),
    // There is deliberately no provisioning-admin allowlist here. Provisioning
    // is approved by the trip's own organizer; the operator is notified, not
    // asked. See docs/landing-page-plan.md.
    session_ttl_seconds: z.number().int().min(3600).max(2592000).default(604800),
    /**
     * Email for the portal's own sign-up and password reset (verification and
     * reset links). All three ABSENT means "email is not configured": the
     * sign-up and forgot-password routes answer 503 SIGN_UP_UNAVAILABLE, the
     * page says sign-up is not open yet, and nothing is ever "sent" into the
     * void. `resend` posts to Resend's HTTP API with the key behind
     * `email_api_key_secret_ref`; `log` sends nothing and is for tests and a
     * development stack (refused in production, where it would swallow every
     * link). The address, domain and key belong in the deployment's profile,
     * never in this repository.
     */
    email_provider: z.enum(["resend", "log"]).optional(),
    email_api_key_secret_ref: secretReference.optional(),
    email_from: z.string().email().max(254).optional(),
  }).strict().refine((web) => web.email_provider !== undefined || (web.email_api_key_secret_ref === undefined && web.email_from === undefined), {
    message: "email_api_key_secret_ref and email_from need email_provider",
    path: ["email_provider"],
  }).refine((web) => web.email_provider !== "resend" || (web.email_api_key_secret_ref !== undefined && web.email_from !== undefined), {
    message: "email_provider \"resend\" needs both email_api_key_secret_ref and email_from",
    path: ["email_provider"],
  }).optional(),
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
    /**
     * The authenticated id of the ONE gateway still serving many profiles from
     * a single process, if there is one.
     *
     * Turns are addressed to the gateway whose id matches the trip's Hermes
     * profile (`docs/per-trip-gateway-architecture.md`). A multiplexing gateway
     * serves every profile under one id, so nothing it serves would ever match
     * and it would go silent the moment routing became exact. Declaring it here
     * says "send this gateway anything no trip's own gateway claims".
     *
     * TRANSITIONAL, and meant to be deleted. It is unset once every active trip
     * has its own gateway process; at that point routing is exact with no code
     * change, and an unreachable trip is reported rather than absorbed.
     */
    multiplex_gateway_id: z.string().min(1).optional(),
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
  if (profile.web && profile.web.public_origin === profile.web.runtime_origin) {
    ctx.addIssue({ code: "custom", path: ["web", "runtime_origin"], message: "runtime origin must be isolated from the organizer origin" });
  }
  if (profile.environment === "production" && profile.web?.email_provider === "log") {
    ctx.addIssue({
      code: "custom",
      path: ["web", "email_provider"],
      message: "email_provider \"log\" sends nothing; a production profile must use a real provider or leave email unconfigured (sign-up then answers 503)",
    });
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
