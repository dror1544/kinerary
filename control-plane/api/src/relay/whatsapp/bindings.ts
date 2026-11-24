/**
 * The few binding-row reads and writes the WhatsApp side of the relay needs beyond
 * what S2's `chat-binding-codes.ts` and `group-binding.ts` already do (spec 625, S3).
 * Every query names `platform = 'whatsapp'`, so none of them can touch a Telegram row,
 * and none of them is on a path Telegram traffic takes (AC-5).
 *
 * The one column that holds a real address, `transport_address`, is read here for one
 * send and returned to the caller in memory. It is never logged.
 */
import type pg from "pg";
import { whatsappChatTitle } from "./text.js";

type Queryable = Pick<pg.Pool, "query">;

/**
 * The real address of an OPEN WhatsApp binding, by its alias; null when there is none now. With `tripId`, only a binding
 * of that trip counts (#655 review, F2): the connector passes the trip its scope check approved, so a chat rebound to
 * another trip in between is not sent the first trip's text. Without it (the relay's own owner notice, which has just
 * read the binding itself) the alias alone decides.
 */
export async function whatsappAddressOf(db: Queryable, alias: string, tripId?: string): Promise<string | null> {
  const found = tripId === undefined
    ? await db.query<{ transport_address: string | null }>(
      `SELECT transport_address FROM control_plane.telegram_chat_bindings
        WHERE chat_id = $1 AND closed_at IS NULL AND platform = 'whatsapp'`,
      [alias],
    )
    : await db.query<{ transport_address: string | null }>(
      `SELECT transport_address FROM control_plane.telegram_chat_bindings
        WHERE chat_id = $1 AND trip_id = $2 AND closed_at IS NULL AND platform = 'whatsapp'`,
      [alias, tripId],
    );
  return found.rows[0]?.transport_address ?? null;
}

/**
 * `title_changed`: the open group binding's `chat_title` follows the group's (spec "Bridge sidecar"). A title that is a
 * number is stored as no title (#655 review, F4). Returns whether a row changed.
 */
export async function updateWhatsAppGroupTitle(db: Queryable, alias: string, title: string): Promise<boolean> {
  const cleaned = whatsappChatTitle(title);
  const updated = await db.query(
    `UPDATE control_plane.telegram_chat_bindings SET chat_title = $2
      WHERE chat_id = $1 AND closed_at IS NULL AND platform = 'whatsapp'`,
    [alias, cleaned],
  );
  return (updated.rowCount ?? 0) > 0;
}
