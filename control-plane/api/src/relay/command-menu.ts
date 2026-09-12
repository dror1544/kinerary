/**
 * The typed-command menu Telegram draws behind the ⌘ button.
 *
 * WHY IT EXISTS. `/group` has worked since Sprint 5 and was still folk
 * knowledge — a command nobody outside this repo could discover. `/trips` and
 * `/switch` would inherit exactly that, which for `/switch` is worse than for
 * most: it is the command an organizer reaches for precisely when they are
 * already confused about which trip they are talking to.
 *
 * SCOPED, NOT GLOBAL. The commands are not the same everywhere, and a menu
 * offering `/switch` inside a family group advertises something that will be
 * refused — a group's binding belongs to the family, not to whoever typed. So
 * private chats get the full set and groups are left alone.
 *
 * `/start` is deliberately absent. Telegram surfaces its own Start button, and
 * a menu entry for a command that does nothing without a token is a dead end.
 *
 * LOCALISED, for the same reason the replies are: an English menu over a
 * Hebrew conversation is the half-translated state commit f56f7b2 set out to
 * remove. Telegram keys menus by `language_code`, so this publishes one per
 * language plus an unlabelled default.
 */
import { LANGUAGES, uiString, type Language } from "../intake-copy.js";
import { structuredLog } from "../redaction.js";
import type { TelegramClient } from "./telegram-api.js";

/** The commands offered in a 1:1 chat with the bot, in menu order. */
const PRIVATE_COMMANDS: { command: string; descriptionKey: string }[] = [
  { command: "trips", descriptionKey: "cmdTrips" },
  { command: "switch", descriptionKey: "cmdSwitch" },
  { command: "group", descriptionKey: "cmdGroup" },
  { command: "done", descriptionKey: "cmdDone" },
];

function commandsFor(language: Language): { command: string; description: string }[] {
  return PRIVATE_COMMANDS.map(({ command, descriptionKey }) => ({
    command,
    description: uiString(descriptionKey, language),
  }));
}

/**
 * Publishes the menu. Called ONCE at relay boot, not per message: Telegram
 * rate-limits these, and the list only changes when this file does.
 *
 * NEVER FATAL. A failed publish means an undiscoverable but fully working
 * command surface — the exact state before this module existed. Failing
 * startup over it would trade a cosmetic gap for an outage. Returns whether
 * every call succeeded, for the caller's log and for tests.
 */
export async function publishCommandMenu(
  telegram: TelegramClient,
  log: (line: string) => void = () => {},
): Promise<boolean> {
  if (!telegram.setMyCommands) {
    log(structuredLog("info", "relay.command_menu_unsupported", {}));
    return false;
  }

  let allOk = true;
  try {
    // The default menu, for a client whose locale is neither language we draw.
    // Sent with no language_code at all — see setMyCommands' note on why an
    // empty string is not the same thing.
    allOk = await telegram.setMyCommands({
      commands: commandsFor("en"),
      scope: { type: "all_private_chats" },
    });

    for (const language of LANGUAGES) {
      const ok = await telegram.setMyCommands({
        commands: commandsFor(language),
        scope: { type: "all_private_chats" },
        languageCode: language,
      });
      allOk = allOk && ok;
    }
  } catch (error) {
    // A throw here is a network fault, and it is still not worth an outage.
    log(structuredLog("warn", "relay.command_menu_failed", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    return false;
  }

  log(structuredLog(allOk ? "info" : "warn", "relay.command_menu_published", {
    ok: allOk,
    commands: PRIVATE_COMMANDS.map((c) => c.command).join(","),
  }));
  return allOk;
}
