import { buildApp, type SignupDependencies } from "./app.js";
import { createNotificationAdapter } from "./adapters/notification.js";
import { loadArchitectureProfile, validateBeforeProvider } from "./config.js";
import { createDatabasePool, databaseReadiness, readRequiredSecretFile } from "./database.js";
import { structuredLog } from "./redaction.js";
import { resolveSecretRef } from "./secrets.js";

const profilePath = process.env.CONTROL_PLANE_ARCHITECTURE_PROFILE;
if (!profilePath) throw new Error("CONTROL_PLANE_ARCHITECTURE_PROFILE is required");

const profile = await loadArchitectureProfile(profilePath);
const connectionString = await readRequiredSecretFile(
  process.env.CONTROL_PLANE_DATABASE_URL_FILE,
  "CONTROL_PLANE_DATABASE_URL",
);
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

const app = buildApp(profile, {
  readiness: () => databaseReadiness(pool),
  close: () => pool.end(),
  signup,
});
await app.listen({ host: profile.public_api.bind_host, port: profile.public_api.port });
