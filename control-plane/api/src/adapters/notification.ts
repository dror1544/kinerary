import type { NotificationAdapter } from "../signup.js";

/** Records calls instead of sending anything. Selected by adapters.messaging === "fake". */
export class FakeNotificationAdapter implements NotificationAdapter {
  readonly calls: Array<Parameters<NotificationAdapter["sendApprovalRequest"]>[0]> = [];
  async sendApprovalRequest(params: Parameters<NotificationAdapter["sendApprovalRequest"]>[0]): Promise<void> {
    this.calls.push(params);
  }
}

/**
 * Selects a NotificationAdapter by the architecture profile's
 * adapters.messaging value. Only "fake" exists today — real Telegram sending
 * (and the setWebhook registration the callback trust boundary depends on)
 * is Sprint 5 scope: "provider-neutral messaging bindings and the shared
 * Trip Bot router." Throws for anything else rather than silently no-op'ing,
 * so a profile that names an adapter this build can't provide fails at
 * startup instead of leaving the super-admin's approval notifications
 * unsent with no error anywhere.
 *
 * config.ts's schema separately refuses "fake" messaging in production when
 * signup is configured — that's a fixed cross-field profile invariant, not
 * an implementation gap, so it lives in the schema rather than here.
 */
export function createNotificationAdapter(messagingAdapter: string): NotificationAdapter {
  if (messagingAdapter === "fake") {
    return new FakeNotificationAdapter();
  }
  throw new Error(
    `adapters.messaging "${messagingAdapter}" has no notification adapter implementation yet (Sprint 5: real Telegram sending)`,
  );
}
