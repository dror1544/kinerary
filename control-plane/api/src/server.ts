import { buildApp, type SignupDependencies, type InterviewDependencies } from "./app.js";
import { createNotificationAdapter } from "./adapters/notification.js";
import { loadArchitectureProfile, validateBeforeProvider } from "./config.js";
import { createDatabasePool, databaseReadiness } from "./database.js";
import { structuredLog } from "./redaction.js";
import { resolveSecretRef } from "./secrets.js";

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
  const [botToken, actionSecret, webhookSecret] = await Promise.all([
    resolveSecretRef(signupConfig.telegram_bot_token_secret_ref),
    resolveSecretRef(signupConfig.action_secret_ref),
    resolveSecretRef(signupConfig.webhook_secret_ref),
  ]);
  // validateBeforeProvider re-checks the already-loaded profile immediately
  // before this build's first provider construction, per the ordering
  // guarantee its own test asserts: an invalid profile must never reach a
  // constructed provider.
  const notification = validateBeforeProvider(profile, () => createNotificationAdapter(profile.adapters.messaging));
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

// Sprint 2: interview is active whenever signup is configured. The enrollment
// TTL comes from the signup block; a separate interview block in the profile
// would be added if the TTL ever needs to be tuned independently.
let interview: InterviewDependencies | undefined;
if (profile.signup) {
  interview = {
    db: pool,
    config: {
      enrollmentTtlSeconds: profile.signup.enrollment_ttl_seconds ?? 86400,
    },
  };
}

const app = buildApp(profile, {
  readiness: () => databaseReadiness(pool),
  close: () => pool.end(),
  signup,
  interview,
});
await app.listen({ host: profile.public_api.bind_host, port: profile.public_api.port });
