/**
 * The typed-command menu Telegram draws behind the ⌘ button — the router's
 * own commands, and nothing else.
 *
 * WHY IT EXISTS. On 2026-09-13 a family group's menu listed some sixty Hermes
 * commands (/new, /model, /restart, /approve …), registered by a Hermes gateway
 * back when it polled this bot directly. Telegram keeps a menu until somebody
 * replaces it, and under the relay nobody did. So the menu offered commands the
 * router refuses by design — a command never reaches a gateway — and did not
 * show /name, the one command that renames the assistant.
 *
 * SCOPED. Groups get a menu too, not only private chats: leaving a group's
 * menu alone is exactly what kept Hermes's list there. /group appears only
 * outside groups — it mints a binding token in the organizer's DM, and a group
 * has nothing to bind.
 *
 * `/start` is deliberately absent. Telegram surfaces its own Start button, and
 * a menu entry for a command that does nothing without a token is a dead end.
 *
 * LOCALISED, like the replies. Telegram prefers a language's own list over the
 * unlabelled default, so `en` and `he` are published explicitly too — which
 * also overwrites any language-specific list a previous owner left behind.
 *
 * Shares its name and signature with PR #47's module of the same name, which
 * adds /trips and /switch to private chats; the two menus merge by union.
 */
import { structuredLog } from "../redaction.js";
import type { TelegramClient } from "./telegram-api.js";

export interface CommandMenu {
  scope: "default" | "all_private_chats" | "all_group_chats";
  /** Absent for the unlabelled default a client with any other locale sees. */
  languageCode?: "en" | "he";
  commands: { command: string; description: string }[];
}

const DESCRIPTIONS = {
  en: { help: "What I can do", name: "Show or change my name", group: "Connect me to your family group" },
  he: { help: "מה אני יודע לעשות", name: "להציג או לשנות את השם שלי", group: "לחבר אותי לקבוצה המשפחתית" },
} as const;

/** Every menu the router publishes: three scopes, for the default, en and he. */
export function routerCommandMenus(): CommandMenu[] {
  const menus: CommandMenu[] = [];
  for (const languageCode of [undefined, "en", "he"] as const) {
    const text = DESCRIPTIONS[languageCode ?? "en"];
    const everywhere = [
      { command: "help", description: text.help },
      { command: "name", description: text.name },
    ];
    const privateChat = [...everywhere, { command: "group", description: text.group }];
    menus.push(
      { scope: "default", languageCode, commands: privateChat },
      { scope: "all_private_chats", languageCode, commands: privateChat },
      { scope: "all_group_chats", languageCode, commands: everywhere },
    );
  }
  return menus;
}

/**
 * Publishes every menu. Called ONCE at relay boot, not per message: Telegram
 * rate-limits these, and the list only changes when this file does.
 *
 * NEVER FATAL. A failed publish leaves a stale menu over a fully working
 * command surface; failing startup over it would trade a cosmetic gap for an
 * outage. Returns whether every call succeeded.
 */
export async function publishCommandMenu(
  telegram: TelegramClient,
  log: (line: string) => void = () => {},
): Promise<boolean> {
  if (!telegram.setMyCommands) {
    log(structuredLog("info", "relay.command_menu_unsupported", {}));
    return false;
  }
  let published = 0;
  let failed = 0;
  for (const menu of routerCommandMenus()) {
    let ok = false;
    try {
      ok = await telegram.setMyCommands({
        commands: menu.commands,
        scope: { type: menu.scope },
        ...(menu.languageCode ? { languageCode: menu.languageCode } : {}),
      });
    } catch {
      // A network fault — counted, still not worth an outage.
    }
    if (ok) published += 1;
    else failed += 1;
  }
  log(structuredLog(failed ? "warn" : "info", "relay.command_menu_published", { published, failed }));
  return failed === 0;
}
