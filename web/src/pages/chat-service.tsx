import type { ReactNode } from "react";

/**
 * The two chat services the companion lives on, described once so that every place that links or unlinks a chat treats them
 * the same: the same words, the same actions, each with its own logo and brand colour (#690). The marks are inline SVG, never
 * image files (CLAUDE.md hard rule 3). Colours live in styles.css as `.chat-service-telegram` / `.chat-service-whatsapp`.
 */
export type ChatService = "telegram" | "whatsapp";

/**
 * Lets the trip card own which of its two menus is open, so that opening one closes the other: both hang from the same
 * place, and a second one opening underneath the first would look like nothing happened.
 */
export type MenuControl = { open: boolean; setOpen: (open: boolean) => void };

export const SERVICE: Record<ChatService, { name: string; noun: string }> = {
  telegram: { name: "Telegram", noun: "account" },
  whatsapp: { name: "WhatsApp", noun: "chat" },
};

/** The service's logo, drawn in the colour of its container (`currentColor`), so the brand colour is a style, not a file. */
export function ServiceMark({ service, size = 18 }: { service: ChatService; size?: number }) {
  return (
    <svg className={`chat-mark chat-mark-${service}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <ServiceMarkPaths service={service} />
    </svg>
  );
}

/**
 * The status mark on a trip card: the logo in its brand colour when something is linked, grey and struck through when
 * nothing is, and the plain logo when this viewer cannot be told (`linked` null: a co-organizer is not shown the trip's
 * WhatsApp chats, so the card must not claim "not linked" for them).
 */
export function ServiceStatusIcon({ service, linked }: { service: ChatService; linked: boolean | null }) {
  const { name } = SERVICE[service];
  const label = linked === null ? name : `${name} ${linked ? "linked" : "not linked"}`;
  return (
    <span className={`chat-icon chat-service-${service}${linked ? " linked" : linked === false ? " unlinked" : " unknown"}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <ServiceMarkPaths service={service} />
        {linked === false && <path d="M3 3l18 18" stroke="#fff" strokeWidth="5" strokeLinecap="round" />}
        {linked === false && <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
      </svg>
    </span>
  );
}

/** Telegram: the paper plane. WhatsApp: a speech bubble with its tail at the lower left and a telephone handset cut out of it. */
function ServiceMarkPaths({ service }: { service: ChatService }): ReactNode {
  return service === "telegram"
    ? <path fill="currentColor" d="M21.5 3.5 2.7 10.8c-.8.3-.8 1.4 0 1.7l4.6 1.7 1.8 5.5c.2.7 1.1.9 1.6.4l2.6-2.6 4.6 3.4c.6.4 1.4.1 1.6-.6l3.2-15.6c.2-.8-.6-1.4-1.3-1.1Z" />
    : <path fill="currentColor" fillRule="evenodd" d="M12 2.2a9.8 9.8 0 0 0-8.4 14.8L2.3 21.8l4.9-1.3A9.8 9.8 0 1 0 12 2.2Zm-3.2 5c.3-.3.6-.3.9-.3h.3c.2 0 .4.1.5.4l.8 1.9c.1.2.1.4-.1.6l-.5.7c-.1.2-.1.3 0 .5.6 1 1.4 1.8 2.5 2.4.2.1.3.1.5-.1l.7-.8c.2-.2.4-.2.6-.1l1.8.9c.2.1.4.2.4.4 0 .6-.2 1.2-.8 1.6-.5.4-1.2.5-1.8.3-2.9-.9-4.8-2.7-5.7-5.6-.2-.7 0-1.5.4-2.1Z" />;
}
