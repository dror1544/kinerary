import { structuredLog } from "./redaction.js";
import { resolveSecretRef } from "./secrets.js";

/**
 * Which chat an operator-facing message goes to. Two different jobs, two chats:
 *
 *  - the APPROVAL DM (signup request with Approve / Reject buttons) goes to the
 *    super-admin's own chat, `signup.super_admin_chat_id_secret_ref`. That is a
 *    decision a person takes, and it stays a private chat.
 *  - the operator NOTICES (`operator_*` outbox rows: provisioning approved,
 *    complete, failed) are monitoring. Optionally they go to a separate chat,
 *    `signup.operator_notices_chat_id_secret_ref` (an ops group), so they do not
 *    land in the middle of the owner's own conversation with the bot (issue #649).
 *
 * Unset, notices follow the row's own recipient, which is the super-admin chat:
 * exactly the behaviour before the setting existed.
 */

/** The `operator_*` outbox types; the worker and the API both write them. */
export function isOperatorNotice(notificationType: string): boolean {
  return notificationType.startsWith("operator_");
}

/**
 * The chat an outbox row is sent to. An operator notice goes to the configured
 * notices chat when there is one; everything else, and a notice with no notices
 * chat configured, goes where the row says.
 *
 * Applied at SEND time, not at enqueue time, because the worker enqueues two of
 * the three notices (complete, failed) from its own environment and only the API
 * can see the profile. A row queued before the setting existed is redirected too.
 */
export function chatForOutboxRow(
  row: { notification_type: string; recipient: string | null },
  noticesChatId: string | undefined,
): string | null {
  if (!row.recipient) return null;
  if (noticesChatId && isOperatorNotice(row.notification_type)) return noticesChatId;
  return row.recipient;
}

/**
 * Resolves `operator_notices_chat_id_secret_ref`, or undefined when it is not named.
 *
 * A ref that IS named but does not resolve throws: an ops chat that silently
 * degraded to "send to the owner's private chat" is the bug this setting exists
 * to remove. A value equal to the super-admin chat is a mistake (the relay would
 * then go silent in the owner's own chat), so it is refused loudly and treated as
 * unset.
 */
export async function resolveOperatorNoticesChatId(
  signup: { operator_notices_chat_id_secret_ref?: string } | undefined,
  superAdminChatId: string | undefined,
  log: (line: string) => void,
  resolve: (ref: string) => Promise<string> = resolveSecretRef,
): Promise<string | undefined> {
  const ref = signup?.operator_notices_chat_id_secret_ref;
  if (!ref) return undefined;
  const value = (await resolve(ref)).trim();
  if (!value) return undefined;
  if (superAdminChatId && value === superAdminChatId.trim()) {
    log(structuredLog("error", "operator_notices.same_as_super_admin", {
      effect: "ignored: operator notices stay on the super-admin chat; point operator_notices_chat_id_secret_ref at a separate chat",
    }));
    return undefined;
  }
  return value;
}
