import { buildApp, type SignupDependencies, type InterviewDependencies, type PlannerDependencies, type ProvisionerDependencies, type ChatRoutingDependencies } from "./app.js";
import { createNotificationAdapter } from "./adapters/notification.js";
import { loadArchitectureProfile, validateBeforeProvider } from "./config.js";
import { createDatabasePool, databaseReadiness } from "./database.js";
import { dispatchPendingTripNotifications } from "./outbox-dispatcher.js";
import { venueLinkSearchConfigured } from "./itinerary-extract.js";
import { resolvePendingVenueLinks } from "./venue-links.js";
import { structuredLog } from "./redaction.js";
import { resolveSecretRef } from "./secrets.js";
import { deleteWebhookIfPresent, startTelegramApprovalPoller } from "./telegram-poller.js";

const profilePath = process.env.CONTROL_PLANE_ARCHITECTURE_PROFILE;
if (!profilePath) throw new Error("CONTROL_PLANE_ARCHITECTURE_PROFILE is required");

const profile = await loadArchitectureProfile(profilePath);
// The profile is authoritative for the database too, not only for signup.
// Reading CONTROL_PLANE_DATABASE_URL_FILE directly here would leave
// database.connection_secret_ref validated but never resolved — an env:// or
// vault:// value would pass validation and then be silently ignored.
const connectionString = await resolveSecretRef(profile.database.connection_secret_ref);
const pool = createDatabasePool(connectionString, () => {
  process.stderr.write(`${structuredLog("error", "database.pool_idle_error", {
    safe_error_code: "DATABASE_POOL_IDLE_ERROR",
  })}\n`);
});

let signup: SignupDependencies | undefined;
if (profile.signup) {
  const signupConfig = profile.signup;
  const [botToken, actionSecret, webhookSecret, superAdminChatId] = await Promise.all([
    resolveSecretRef(signupConfig.telegram_bot_token_secret_ref),
    resolveSecretRef(signupConfig.action_secret_ref),
    resolveSecretRef(signupConfig.webhook_secret_ref),
    signupConfig.super_admin_chat_id_secret_ref
      ? resolveSecretRef(signupConfig.super_admin_chat_id_secret_ref)
      : Promise.resolve(undefined),
  ]);
  // validateBeforeProvider re-checks the already-loaded profile immediately
  // before this build's first provider construction, per the ordering
  // guarantee its own test asserts: an invalid profile must never reach a
  // constructed provider.
  const notification = validateBeforeProvider(profile, () => createNotificationAdapter(profile.adapters.messaging, {
    telegram: superAdminChatId ? { botToken, superAdminChatId, db: pool, log: (line) => process.stderr.write(`${line}\n`) } : undefined,
  }));
  signup = {
    db: pool,
    config: {
      superAdminSubjectDigest: signupConfig.super_admin_subject_digest,
      actionSecret,
      actionTtlSeconds: signupConfig.action_ttl_seconds,
      messagingAdapter: profile.adapters.messaging,
      signupRateLimitCooldownSeconds: signupConfig.signup_rate_limit_cooldown_seconds,
    },
    botToken,
    webhookSecret,
    notification,
  };
}

// Interview is active whenever signup is configured. The enrollment TTL comes
// from the signup block; a separate interview block would only be needed if the
// TTL ever needs independent tuning.
let interview: InterviewDependencies | undefined;
if (profile.signup) {
  interview = {
    db: pool,
    config: {
      enrollmentTtlSeconds: profile.signup.enrollment_ttl_seconds ?? 86400,
    },
  };
}

// Planner is active whenever signup is configured. Approval TTL defaults to
// 24 hours; add a planner block to the profile to tune it independently.
// generatePlan() also reads CONTROL_PLANE_ALLOW_UNSEALED_RELEASE from the
// environment: unset (the default, and what a real deployment uses) means only
// a manifest-backed, digest-verified release is selectable; "1" lets the
// hand-seeded dev release through for local work. See planner.ts.
let planner: PlannerDependencies | undefined;
if (profile.signup) {
  planner = {
    db: pool,
    config: {
      approvalTtlSeconds: 86400,
    },
  };
}

// Provisioner dependency block: intake correction route requires the same
// pool as the planner. Active whenever signup is configured.
let provisioner: ProvisionerDependencies | undefined;
if (profile.signup) {
  provisioner = { db: pool };
}

// Chat-routing lookup Hermes's gateway calls to pick a profile per chat id.
// A plain env var, not a secrets.ts ref — same tier and pattern as
// interview-mcp.ts's INTERVIEW_MCP_KEY (a process-to-process shared secret,
// not part of the profile's provider-neutral config). Optional: absent env
// var just leaves the route unmounted (503), same as every other dependency
// block here when its prerequisite isn't configured.
let chatRouting: ChatRoutingDependencies | undefined;
const chatRoutingKey = process.env.CONTROL_PLANE_CHAT_ROUTING_KEY;
if (chatRoutingKey) {
  chatRouting = { db: pool, apiKey: chatRoutingKey };
}

const app = buildApp(profile, {
  readiness: () => databaseReadiness(pool),
  close: () => pool.end(),
  signup,
  interview,
  planner,
  provisioner,
  chatRouting,
});

// Dispatches trip notifications (e.g. "your site is ready") that the worker
// leaves 'pending' in notification_outbox after provisioning completes.
// Guarded against overlap in-process; see outbox-dispatcher.ts for why that's
// sufficient (single API process today).
if (signup) {
  const notification = signup.notification;
  let dispatching = false;
  const OUTBOX_POLL_INTERVAL_MS = 10_000;
  const timer = setInterval(() => {
    if (dispatching) return;
    dispatching = true;
    dispatchPendingTripNotifications(pool, notification, (line) => process.stderr.write(`${line}\n`))
      .catch((error) => {
        process.stderr.write(`${structuredLog("error", "outbox.dispatch_loop_error", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        })}\n`);
      })
      .finally(() => { dispatching = false; });
  }, OUTBOX_POLL_INTERVAL_MS);
  timer.unref();
}

// Retries venue ticket/official-URL lookups parked in venue_links because the
// interview-time web search was rate-limited. Same single-process overlap guard
// as the outbox loop. Only runs when a search profile is configured.
if (venueLinkSearchConfigured()) {
  let draining = false;
  const VENUE_LINK_POLL_INTERVAL_MS = 5 * 60_000;
  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    resolvePendingVenueLinks(pool, undefined, (line) => process.stderr.write(`${line}\n`))
      .catch((error) => {
        process.stderr.write(`${structuredLog("error", "venue_links.drain_loop_error", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        })}\n`);
      })
      .finally(() => { draining = false; });
  }, VENUE_LINK_POLL_INTERVAL_MS);
  timer.unref();
}

// Signup-approval callbacks (the super-admin's Approve/Reject tap) arrive via
// Telegram long polling, not the /v1/signup/callback webhook route — see
// telegram-poller.ts's module doc. getUpdates fails while a webhook is still
// registered for this bot, so clear one if present before the first poll.
if (signup) {
  await deleteWebhookIfPresent(signup.botToken, (line) => process.stderr.write(`${line}\n`));
  startTelegramApprovalPoller({
    db: pool,
    botToken: signup.botToken,
    config: signup.config,
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

await app.listen({ host: profile.public_api.bind_host, port: profile.public_api.port });
