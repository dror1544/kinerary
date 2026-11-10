/**
 * Test-side signer for Telegram Mini App initData.
 *
 * Written separately from src/telegram-webapp-auth.ts on purpose: it builds the
 * data-check-string by hand from the fields it is given, in a fixed order the
 * caller controls, so a bug shared by both would need to be the same bug
 * written twice. The reference vector in telegram-webapp-auth.test.ts is
 * computed by `openssl` rather than by either.
 */
import { createHmac } from "node:crypto";

export const TEST_BOT_TOKEN = "123456789:AAExampleFakeBotTokenForUnitTests_0000";
export const OTHER_BOT_TOKEN = "987654321:AAAnotherFakeBotTokenForUnitTests_1111";

export function signedInitData(
  fields: Record<string, string>,
  token: string = TEST_BOT_TOKEN,
  options: { dropFromCheck?: string[] } = {},
): string {
  const checked = Object.entries(fields)
    .filter(([key]) => !(options.dropFromCheck ?? []).includes(key))
    // Code-unit order via Buffer comparison, deliberately not the verifier's.
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checked).digest("hex");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) query.append(key, value);
  query.append("hash", hash);
  return query.toString();
}

export function userField(id: number | string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, first_name: "Test", ...extra });
}

/** Fresh, valid fields for one launch by Telegram user `id`. */
export function launchFields(
  id: number,
  nowMs: number = Date.now(),
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: userField(id),
    auth_date: String(Math.floor(nowMs / 1000)),
    signature: "c2lnbmF0dXJlLWZvci11bml0LXRlc3Rz",
    ...extra,
  };
}
