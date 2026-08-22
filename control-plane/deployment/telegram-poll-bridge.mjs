#!/usr/bin/env node
// Test-only local dev tool: bridges real Telegram getUpdates long-polling to
// the control plane's /v1/signup/callback webhook endpoint, so a manual
// acceptance test can exercise a REAL Telegram approval flow without
// exposing anything to the public internet.
//
// This is NOT how production should receive Telegram updates — production
// uses a real webhook (setWebhook), which requires public ingress. This
// script exists because a local dev machine behind NAT has none, and
// getUpdates (long polling) is Telegram's own supported alternative that
// needs no inbound connectivity at all.
//
// It is a dumb relay ONLY: it does not verify, interpret, or act on
// anything in the update. All of that — including clearing the tapped
// button's loading spinner via answerCallbackQuery — happens inside
// /v1/signup/callback itself (see app.ts), exactly as it would for a real
// production webhook delivery. That symmetry is deliberate: whatever this
// script does not need to know, a real webhook wouldn't need to know either.
//
// The bridge inherits the callback route's trust boundary rather than
// replacing it: it authenticates to Telegram with the bot token over
// outbound HTTPS, and every forwarded request carries the same
// X-Telegram-Bot-Api-Secret-Token header a real webhook delivery would.
// Nothing downstream of that header treats this differently from Telegram
// itself.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=... CONTROL_PLANE_WEBHOOK_SECRET=... \
//     TELEGRAM_POLL_BRIDGE_CONFIRM=yes-delete-webhook node telegram-poll-bridge.mjs
//
// Env:
//   TELEGRAM_BOT_TOKEN             required
//   CONTROL_PLANE_WEBHOOK_SECRET   required — must match the profile's
//                                  signup.webhook_secret_ref value
//   TELEGRAM_POLL_BRIDGE_CONFIRM   required, must equal "yes-delete-webhook" —
//                                  see the guard below; this is not a real
//                                  secret, just a deliberate opt-in so this
//                                  can't run unattended against a production
//                                  bot token by accident.
//   CONTROL_PLANE_CALLBACK_URL     default http://127.0.0.1:4310/v1/signup/callback
//   TELEGRAM_POLL_TIMEOUT_SECONDS  default 30 (long-poll duration per request)

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.CONTROL_PLANE_WEBHOOK_SECRET;
const CALLBACK_URL = process.env.CONTROL_PLANE_CALLBACK_URL ?? "http://127.0.0.1:4310/v1/signup/callback";
const POLL_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? "30");
const CONFIRM = process.env.TELEGRAM_POLL_BRIDGE_CONFIRM;

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error("CONTROL_PLANE_WEBHOOK_SECRET is required");
  process.exit(1);
}
if (CONFIRM !== "yes-delete-webhook") {
  // deleteWebhook() below is unconditional and unscoped — it disables
  // whatever webhook is currently registered for TELEGRAM_BOT_TOKEN. If
  // that token is a production bot's, this silently kills production
  // Telegram delivery until setWebhook is called again. This bridge is
  // test-only by design (see file header), so refuse to run without an
  // explicit, deliberate opt-in rather than trusting the caller noticed.
  console.error(
    "Refusing to start: this deletes whatever webhook is currently registered\n" +
      "for TELEGRAM_BOT_TOKEN. If that token is a production bot's, this disables\n" +
      "production webhook delivery until setWebhook is called again.\n" +
      "Set TELEGRAM_POLL_BRIDGE_CONFIRM=yes-delete-webhook to proceed — only do\n" +
      "this for a local/dev bot token, never a production one.",
  );
  process.exit(1);
}

const TELEGRAM_API_ROOT = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function deleteWebhook() {
  // Telegram refuses getUpdates with a 409 while a webhook is registered —
  // the two delivery modes are mutually exclusive.
  const response = await fetch(`${TELEGRAM_API_ROOT}/deleteWebhook`, { method: "POST" });
  const body = await response.json();
  if (!body.ok) {
    throw new Error(`deleteWebhook failed: ${JSON.stringify(body)}`);
  }
  console.log("[bridge] webhook cleared, long-polling instead");
}

async function getUpdates(offset) {
  const url = new URL(`${TELEGRAM_API_ROOT}/getUpdates`);
  url.searchParams.set("timeout", String(POLL_TIMEOUT_SECONDS));
  url.searchParams.set("allowed_updates", JSON.stringify(["callback_query"]));
  if (offset !== undefined) url.searchParams.set("offset", String(offset));
  const response = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT_SECONDS + 10) * 1000) });
  const body = await response.json();
  if (!body.ok) {
    throw new Error(`getUpdates failed: ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function forwardUpdate(update) {
  const response = await fetch(CALLBACK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
  const text = await response.text();
  console.log(`[bridge] forwarded update_id=${update.update_id} -> HTTP ${response.status} ${text}`);
}

async function main() {
  await deleteWebhook();
  let offset;
  console.log(`[bridge] long-polling Telegram, forwarding callback_query updates to ${CALLBACK_URL}`);
  console.log("[bridge] Ctrl-C to stop");

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; console.log("\n[bridge] stopping..."); });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    let updates;
    try {
      updates = await getUpdates(offset);
    } catch (error) {
      if (stopping) break;
      console.error("[bridge] getUpdates error, retrying in 3s:", error?.message ?? error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    for (const update of updates) {
      // Advance past every update we've seen regardless of whether we acted
      // on it — an unhandled update left at the old offset would be
      // re-delivered by Telegram forever.
      offset = update.update_id + 1;
      if (update.callback_query) {
        await forwardUpdate(update);
      } else {
        console.log(`[bridge] ignoring update_id=${update.update_id} (no callback_query)`);
      }
    }
  }
}

main().catch((error) => {
  console.error("[bridge] fatal:", error);
  process.exit(1);
});
