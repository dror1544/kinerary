import type pg from "pg";
import type { NotificationAdapter } from "../signup.js";
import { TelegramNotificationAdapter } from "./telegram.js";

/** Records calls instead of sending anything. Selected by adapters.messaging === "fake". */
export class FakeNotificationAdapter implements NotificationAdapter {
  readonly calls: Array<Parameters<NotificationAdapter["sendApprovalRequest"]>[0]> = [];
  async sendApprovalRequest(params: Parameters<NotificationAdapter["sendApprovalRequest"]>[0]): Promise<void> {
    this.calls.push(params);
  }
}

export interface NotificationAdapterDeps {
  /** Required when messagingAdapter === "telegram". */
  telegram?: {
    botToken: string;
    superAdminChatId: string;
    db: pg.Pool;
    log?: (line: string) => void;
  };
}

/**
 * Selects a NotificationAdapter by the architecture profile's
 * adapters.messaging value. Throws for anything unrecognized rather than
 * silently no-op'ing, so a profile that names an adapter this build can't
 * provide fails at startup instead of leaving the super-admin's approval
 * notifications unsent with no error anywhere.
 *
 * config.ts's schema separately refuses "fake" messaging in production when
 * signup is configured, and refuses "telegram" without a chat-id secret ref
 * — those are fixed cross-field profile invariants, not implementation
 * gaps, so they live in the schema rather than here.
 */
export function createNotificationAdapter(messagingAdapter: string, deps: NotificationAdapterDeps = {}): NotificationAdapter {
  if (messagingAdapter === "fake") {
    return new FakeNotificationAdapter();
  }
  if (messagingAdapter === "telegram") {
    if (!deps.telegram) {
      throw new Error('adapters.messaging "telegram" requires telegram deps (botToken, superAdminChatId, db)');
    }
    return new TelegramNotificationAdapter(deps.telegram);
  }
  throw new Error(
    `adapters.messaging "${messagingAdapter}" has no notification adapter implementation yet`,
  );
}
