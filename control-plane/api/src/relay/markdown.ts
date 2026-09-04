/**
 * CommonMark → Telegram MarkdownV2.
 *
 * Our capability descriptor advertises `markdown_dialect: "markdown_v2"`, but
 * what actually arrives from the agent is ordinary CommonMark — `**bold**`,
 * unescaped punctuation, the usual. Those are not the same language, and the
 * difference is not cosmetic:
 *
 *   - MarkdownV2 bold is *one* asterisk. `**bold**` is not "bold with extra
 *     asterisks"; it is an empty entity followed by stray text.
 *   - MarkdownV2 reserves `_ * [ ] ( ) ~ \` > # + - = | { } . !` EVERYWHERE.
 *     One unescaped `.` or `-` in ordinary prose rejects the entire message
 *     with 400 "can't parse entities" — which is exactly what we were seeing.
 *
 * So sending CommonMark as MarkdownV2 fails outright, and sending it as plain
 * text shows the asterisks. Converting is the only option that renders.
 *
 * The strategy is conservative: recognise the handful of constructs Telegram
 * actually supports, and escape absolutely everything else. A construct we do
 * not recognise degrades to visible literal text, never to a parse error —
 * and the caller still has a plain-text retry underneath as a last resort.
 */

/** Reserved in MarkdownV2 body text. Telegram rejects any of these unescaped. */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapeAll(text: string): string {
  return text.replace(RESERVED, (ch) => `\\${ch}`);
}

/** Inside a code span only the backslash and backtick need escaping. */
function escapeCode(text: string): string {
  return text.replace(/([`\\])/g, "\\$1");
}

/** Inside a link target, only `)` and `\` terminate it. */
function escapeUrl(text: string): string {
  return text.replace(/([)\\])/g, "\\$1");
}

interface Token {
  kind: "text" | "code" | "pre" | "bold" | "italic" | "strike" | "link" | "heading";
  value: string;
  /** link only */
  url?: string;
}

/**
 * Splits CommonMark into the tokens Telegram can express.
 *
 * Order matters. Code fences are taken before inline code, inline code before
 * emphasis, and `**` before `*` — otherwise the shorter marker eats the longer
 * one's opening delimiter and the rest of the message parses as garbage.
 */
export function tokenizeCommonMark(input: string): Token[] {
  const tokens: Token[] = [];
  let rest = input;

  // Each pattern captures its content; the union is scanned left to right so
  // the earliest match in the string wins regardless of which pattern it is.
  const patterns: { kind: Token["kind"]; re: RegExp }[] = [
    { kind: "pre", re: /```(?:[a-zA-Z0-9_+-]*\n)?([\s\S]*?)```/ },
    // Telegram has NO heading syntax, so `## Title` would otherwise escape to a
    // literal "\#\# Title". Bold is the conventional stand-in, and it keeps the
    // document's structure legible instead of turning it into visible hashes.
    //
    // Matched at line start only, and AFTER the code-fence pattern in earliest-
    // match order — so a `# comment` inside a fenced block belongs to the fence
    // (which starts earlier) and is left alone.
    { kind: "heading", re: /(?:^|\n)[ \t]*#{1,6}[ \t]+([^\n]+)/ },
    { kind: "code", re: /`([^`\n]+)`/ },
    { kind: "link", re: /\[([^\]\n]*)\]\(([^)\s]+)\)/ },
    { kind: "bold", re: /\*\*([^\n]+?)\*\*/ },
    { kind: "strike", re: /~~([^\n]+?)~~/ },
    // Single-marker emphasis last, and it must not match the `**` it is part
    // of — the bold pattern above has already consumed those.
    { kind: "italic", re: /(?<![*\w])\*([^*\n]+?)\*(?![*\w])/ },
    { kind: "italic", re: /(?<![_\w])_([^_\n]+?)_(?![_\w])/ },
  ];

  while (rest.length > 0) {
    let best: { kind: Token["kind"]; index: number; match: RegExpExecArray } | null = null;
    for (const { kind, re } of patterns) {
      const m = re.exec(rest);
      if (m && (best === null || m.index < best.index)) {
        best = { kind, index: m.index, match: m };
      }
    }
    if (!best) {
      tokens.push({ kind: "text", value: rest });
      break;
    }
    if (best.index > 0) tokens.push({ kind: "text", value: rest.slice(0, best.index) });
    if (best.kind === "link") {
      tokens.push({ kind: "link", value: best.match[1] ?? "", url: best.match[2] ?? "" });
    } else {
      tokens.push({ kind: best.kind, value: best.match[1] ?? "" });
    }
    rest = rest.slice(best.index + best.match[0].length);
  }
  return tokens;
}

/**
 * Renders CommonMark as MarkdownV2 that Telegram will accept.
 *
 * Emphasis content is escaped too — a bold run containing a full stop is still
 * a parse error without it, which is the subtle version of the same bug.
 */
export function toTelegramMarkdownV2(input: string): string {
  let out = "";
  for (const token of tokenizeCommonMark(input)) {
    switch (token.kind) {
      case "text":
        out += escapeAll(token.value);
        break;
      case "pre":
        out += "```\n" + escapeCode(token.value.replace(/\n$/, "")) + "\n```";
        break;
      case "code":
        out += "`" + escapeCode(token.value) + "`";
        break;
      case "heading":
        // Keep the line break the pattern consumed, so the heading still starts
        // its own line.
        out += "\n*" + escapeAll(token.value) + "*";
        break;
      case "bold":
        // One asterisk, not two. This is the whole reason `**bold**` rendered
        // as literal asterisks rather than as bold.
        out += "*" + escapeAll(token.value) + "*";
        break;
      case "italic":
        out += "_" + escapeAll(token.value) + "_";
        break;
      case "strike":
        out += "~" + escapeAll(token.value) + "~";
        break;
      case "link":
        out += "[" + escapeAll(token.value) + "](" + escapeUrl(token.url ?? "") + ")";
        break;
    }
  }
  return out;
}
