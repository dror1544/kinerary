/**
 * Agent markdown → Telegram MarkdownV2, without losing the message.
 *
 * THE PROBLEM. MarkdownV2 requires `_ * [ ] ( ) ~ \` > # + - = | { } . !` to be
 * backslash-escaped everywhere they are not part of an entity. Ordinary prose
 * is full of them: a full stop, a hyphen, "(FCO)". So the agent writes a
 * perfectly good `[Fushimi Inari](https://…)`, Telegram rejects the whole
 * message with "can't parse entities", and `telegram-api.ts` re-sends it with
 * `parse_mode` deleted — a designed fallback that delivers the text and loses
 * every link in it. The organizer sees literal brackets and concludes the bot
 * cannot make links.
 *
 * Escaping everything would fix the rejection and break the links too, which is
 * the same outcome by a different route. So this escapes the PROSE and leaves
 * the entities alone: links, inline code and code fences are recognised first,
 * their inner text escaped by their own rules, and everything between them
 * escaped wholesale.
 *
 * Deliberately supports a small set — links, code, bold, italic. An agent
 * writing a table or a blockquote gets it escaped into visible punctuation,
 * which is legible and safe. The alternative, a full CommonMark translator,
 * is a large surface for a chat message and would still not cover everything
 * Telegram means by "entity".
 */

/** Every character MarkdownV2 reserves outside an entity. */
const SPECIALS = "_*[]()~`>#+-=|{}.!\\";

/** Escape a run of plain text so Telegram treats every character literally. */
export function escapeMarkdownV2(text: string): string {
  let out = "";
  for (const ch of text) out += SPECIALS.includes(ch) ? `\\${ch}` : ch;
  return out;
}

/**
 * Inside `(...)` of a link, only `)` and `\` may be escaped — escaping a dot
 * or dash there would put a backslash into the URL itself and break it. This
 * is the rule that makes "escape everything" wrong rather than merely ugly.
 */
function escapeUrl(url: string): string {
  return url.replace(/([\\)])/g, "\\$1");
}

/** Inside code, only the backtick and backslash are special. */
function escapeCode(code: string): string {
  return code.replace(/([\\`])/g, "\\$1");
}

// Ordered: a fenced block must win over inline code, and a link over emphasis,
// or a URL containing an underscore would be read as italic.
const FENCE = /```([\s\S]*?)```/;
const INLINE_CODE = /`([^`\n]+)`/;
const LINK = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/;
const BOLD = /\*\*([^*\n]+)\*\*/;
const ITALIC = /(?<![*\w])\*([^*\n]+)\*(?!\w)/;

/**
 * Convert one message. Never throws and never returns something Telegram will
 * reject: anything unrecognised ends up escaped, which renders as itself.
 */
export function toTelegramMarkdownV2(text: string): string {
  if (!text) return "";

  const patterns: { re: RegExp; render: (m: RegExpExecArray) => string }[] = [
    { re: FENCE, render: (m) => "```" + escapeCode(m[1] ?? "") + "```" },
    { re: INLINE_CODE, render: (m) => "`" + escapeCode(m[1] ?? "") + "`" },
    // A link's LABEL is prose and escapes as prose; its URL escapes by the
    // narrower rule above. An empty label would render as a bare `[](url)`,
    // so it falls back to showing the URL.
    {
      re: LINK,
      render: (m) => {
        const label = (m[1] ?? "").trim();
        const url = m[2] ?? "";
        return label
          ? `[${escapeMarkdownV2(label)}](${escapeUrl(url)})`
          : `[${escapeMarkdownV2(url)}](${escapeUrl(url)})`;
      },
    },
    { re: BOLD, render: (m) => `*${escapeMarkdownV2(m[1] ?? "")}*` },
    { re: ITALIC, render: (m) => `_${escapeMarkdownV2(m[1] ?? "")}_` },
  ];

  // Find the earliest entity, escape everything before it, render it, recurse
  // on the rest. Linear, and it cannot nest an entity inside another entity's
  // escaped text — which is what keeps a URL out of the emphasis parser.
  let earliest: { index: number; length: number; rendered: string } | null = null;
  for (const { re, render } of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    if (earliest === null || m.index < earliest.index) {
      earliest = { index: m.index, length: m[0].length, rendered: render(m) };
    }
  }

  if (!earliest) return escapeMarkdownV2(text);
  return (
    escapeMarkdownV2(text.slice(0, earliest.index))
    + earliest.rendered
    + toTelegramMarkdownV2(text.slice(earliest.index + earliest.length))
  );
}
