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
 * menu alone is exactly what kept Hermes's list there. /group, /trips and
 * /switch appear only outside groups — /group mints a binding token in the
 * organizer's DM, /trips would list trips the rest of the room has no claim
 * to, and a group's binding is the family's, not one member's to /switch.
 *
 * `/start` is deliberately absent. Telegram surfaces its own Start button, and
 * a menu entry for a command that does nothing without a token is a dead end.
 * `/done` is absent too: it means something only mid-interview.
 *
 * LOCALISED, like the replies. Telegram prefers a language's own list over the
 * unlabelled default, so `en` and `he` are published explicitly too — which
 * also overwrites any language-specific list a previous owner left behind.
 *
 * /trips and /switch arrived from PR #47, whose menu this one absorbed by
 * union — same module, same signature, their commands added to the private list.
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
  en: {
    help: "What I can do",
    name: "Show or change my name",
    group: "Connect me to your family group",
    trips: "Your trips, and which one this chat is on",
    switch: "Point this chat at a different trip",
  },
  he: {
    help: "מה אני יודע לעשות",
    name: "להציג או לשנות את השם שלי",
    group: "לחבר אותי לקבוצה המשפחתית",
    trips: "הטיולים שלך, ולאיזה מהם הצ׳אט הזה מחובר",
    switch: "חיבור הצ׳אט הזה לטיול אחר",
  },
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
    const privateChat = [
      ...everywhere,
      { command: "group", description: text.group },
      { command: "trips", description: text.trips },
      { command: "switch", description: text.switch },
    ];
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
