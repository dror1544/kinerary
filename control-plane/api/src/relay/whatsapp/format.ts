/**
 * The companion's Markdown -> WhatsApp text, and splitting by length.
 *
 * WHY HERE. The gateway does not convert formatting on a relayed send, and the
 * primary (Telegram) descriptor governs its length (spec 625, AC-0, Hermes half),
 * so the relay owns WhatsApp formatting and length (AC-19, AC-24). The companion
 * writes the Markdown a model writes; WhatsApp reads a smaller dialect:
 *
 *   *bold*   _italic_   ~strike~   `inline code`   ```fenced block```
 *   "- " bullets, "1. " numbers, "> " quotes — and nothing else.
 *
 * Everything else is mapped to the nearest thing WhatsApp does show: a heading is
 * a bold line, a link is "label (url)", a table is its rows joined with " | ",
 * a rule is a blank line. Unrecognised syntax is left as the text it is, which
 * renders as itself.
 *
 * Both functions are pure and never throw.
 *
 * Three decisions that look incidental:
 *
 *  - Emphasis is TOKENISED, not rewritten in place. `**bold**` becomes `*bold*`,
 *    which a second pass would then read as italic and turn into `_bold_`; the
 *    markers go through private sentinels and are written out once.
 *  - Code and URLs are lifted out first and put back last, so an underscore in a
 *    URL or an asterisk in a code sample is never read as emphasis.
 *  - The emphasis rules use Unicode letter classes, not `\w`: `\w` is ASCII-only,
 *    so a Hebrew word next to an asterisk would otherwise be read as punctuation.
 */

// Private-use sentinels. Stripped from the input first, so a message cannot forge one.
const PUA = /[-]/g;
const SLOT_OPEN = "";
const SLOT_CLOSE = "";
const B = ""; // bold marker
const I = ""; // italic marker
const S = ""; // strike marker

const LETTER_OR_DIGIT = "\\p{L}\\p{N}";

function lift(text: string, pattern: RegExp, slots: string[], render: (match: string[]) => string): string {
  return text.replace(pattern, (...args: unknown[]) => {
    const end = args.findIndex((a) => typeof a === "number");
    slots.push(render(args.slice(0, end) as string[]));
    return `${SLOT_OPEN}${slots.length - 1}${SLOT_CLOSE}`;
  });
}

function restore(text: string, slots: string[]): string {
  let out = text;
  // A slot's content may itself hold a slot (a URL inside an inline link label),
  // so unwind until none is left.
  for (let i = 0; i < 4 && out.includes(SLOT_OPEN); i += 1) {
    out = out.replace(new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, "g"), (_m, n: string) => slots[Number(n)] ?? "");
  }
  return out;
}

// The first line is a language tag only when it is one word and a newline follows: "```hello```" is code.
const FENCE = /```(?:[\w+#.-]*[ \t]*\n)?([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const IMAGE = /!\[([^\]\n]{0,500})\]\(\s*(https?:\/\/[^\s)]{1,2000})(?:\s[^)]{0,300})?\)/g;
const LINK = /\[([^\]\n]{0,500})\]\(\s*(https?:\/\/[^\s)]{1,2000})(?:\s[^)]{0,300})?\)/g;
// Trailing punctuation is not part of a bare URL.
const BARE_URL = /https?:\/\/[^\s<>()\[\]]{1,2000}[^\s<>()\[\].,;:!?'"»”’)]/g;
const HEADING = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const RULE = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const BULLET = /^([ \t]*)[*+-][ \t]+/;

function convertLine(line: string): string {
  const heading = HEADING.exec(line);
  // A heading is a bold line; markers inside it would nest, so they are dropped.
  if (heading) return `${B}${(heading[1] ?? "").replace(/\*\*|__/g, "")}${B}`;
  if (RULE.test(line)) return "";
  if (line.trimStart().startsWith("|") && line.includes("|")) {
    if (TABLE_SEPARATOR.test(line)) return "";
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    return cells.join(" | ");
  }
  return line.replace(BULLET, "$1- ");
}

function emphasis(text: string): string {
  let out = text;
  const notWordBefore = `(?<![*${LETTER_OR_DIGIT}])`;
  const notWordAfter = `(?![*${LETTER_OR_DIGIT}])`;
  // ***bold italic***
  out = out.replace(/\*\*\*(?!\s)([^\n]{1,2000}?)(?<!\s)\*\*\*/gu, `${B}${I}$1${I}${B}`);
  // **bold**, __bold__
  out = out.replace(/\*\*(?!\s)([^\n]{1,2000}?)(?<!\s)\*\*/gu, `${B}$1${B}`);
  out = out.replace(new RegExp(`(?<![_${LETTER_OR_DIGIT}])__(?!\\s)([^\\n]{1,2000}?)(?<!\\s)__(?![_${LETTER_OR_DIGIT}])`, "gu"), `${B}$1${B}`);
  // ~~strike~~
  out = out.replace(/~~(?!\s)([^\n]{1,2000}?)(?<!\s)~~/gu, `${S}$1${S}`);
  // *italic*
  out = out.replace(new RegExp(`${notWordBefore}\\*(?!\\s)([^*\\n]{1,2000}?)(?<!\\s)\\*${notWordAfter}`, "gu"), `${I}$1${I}`);
  // _italic_ (already WhatsApp's own, but only where Markdown would read it as emphasis)
  out = out.replace(new RegExp(`(?<![_${LETTER_OR_DIGIT}])_(?!\\s)([^_\\n]{1,2000}?)(?<!\\s)_(?![_${LETTER_OR_DIGIT}])`, "gu"), `${I}$1${I}`);
  return out.replaceAll(B, "*").replaceAll(I, "_").replaceAll(S, "~");
}

/**
 * The longest input that is converted. A companion reply is a few thousand
 * characters; beyond this the text is passed through as written (and split), so
 * a pathological run of brackets cannot hold the relay's loop for seconds.
 */
export const MAX_CONVERT_CHARS = 64_000;
// Every pattern below that scans for a closer is also bounded (labels 500, targets and spans 2000):
// an unbounded scan from each of many openers is quadratic, and a cap on the input alone is not enough.

/** Convert one message's Markdown to WhatsApp's dialect. */
export function toWhatsAppText(markdown: string): string {
  if (!markdown) return "";
  if (markdown.length > MAX_CONVERT_CHARS) return markdown.replace(/\r\n?/g, "\n").trim();
  try {
    const slots: string[] = [];
    let text = markdown.replace(/\r\n?/g, "\n").replace(PUA, "");

    // 1. Code first: nothing inside it is touched. The language tag of a fence is dropped.
    text = lift(text, FENCE, slots, (m) => `\`\`\`\n${(m[1] ?? "").replace(/^\n+|\n+$/g, "")}\n\`\`\``);
    text = lift(text, INLINE_CODE, slots, (m) => `\`${m[1] ?? ""}\``);

    // 2. Links and images: the URL is lifted, the label stays as prose.
    text = text.replace(IMAGE, (_m, alt: string, url: string) => (alt.trim() ? `${alt.trim()} (${lift1(url, slots)})` : lift1(url, slots)));
    text = text.replace(LINK, (_m, label: string, url: string) => {
      const l = label.trim();
      return !l || l === url ? lift1(url, slots) : `${l} (${lift1(url, slots)})`;
    });
    text = lift(text, BARE_URL, slots, (m) => m[0] ?? "");

    // 3. Block structure, line by line.
    const lines = text.split("\n").map(convertLine).filter((line) => line !== "");
    text = lines.join("\n");

    // 4. Inline emphasis.
    text = emphasis(text);

    // 5. Put the lifted pieces back and tidy.
    text = restore(text, slots);
    return text
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return markdown;
  }
}

function lift1(value: string, slots: string[]): string {
  slots.push(value);
  return `${SLOT_OPEN}${slots.length - 1}${SLOT_CLOSE}`;
}

export const WHATSAPP_CHUNK_LIMIT = 4000;

/** Cut at a code-point boundary at or before `index`; never inside a surrogate pair. */
function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** Split a line that is longer than `max` on spaces, else on a hard cut. */
function splitLongLine(line: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < Math.floor(max / 2)) cut = safeCut(rest, max);
    if (cut < 1) cut = Math.max(1, safeCut(rest, max));
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

const FENCE_LINE = /^[ \t]*```/;

/**
 * Split WhatsApp text into messages of at most `max` UTF-16 units each.
 *
 * Breaks come, in order of preference, at a blank line, a line end, a space and
 * only then mid-word; never inside a surrogate pair. A fenced block that has to
 * be cut is closed at the end of one message and reopened at the start of the
 * next, so each message renders on its own. Nothing is dropped.
 */
export function splitForWhatsApp(text: string, max: number = WHATSAPP_CHUNK_LIMIT): string[] {
  const limit = Math.max(16, Math.floor(max));
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let inFence = false;

  const lengthOf = (lines: string[]) => lines.reduce((n, l) => n + l.length, 0) + Math.max(0, lines.length - 1);

  // A message that continues a fence starts with its own reopened "```" line, so
  // counting fence lines from "closed" gives the state at any point in it.
  function fenceOpenAfter(lines: string[]): boolean {
    let open = false;
    for (const l of lines) if (FENCE_LINE.test(l)) open = !open;
    return open;
  }

  function flush(lines: string[], endsInFence: boolean) {
    // A message that is only a reopened fence has nothing in it.
    if (lines.every((l) => /^[ \t]*(```)?[ \t]*$/.test(l))) return;
    const body = lines.join("\n").trimEnd();
    if (!body.trim()) return;
    chunks.push(endsInFence ? `${body}\n\`\`\`` : body);
  }

  function startNext(carry: string[], continuesFence: boolean) {
    cur = continuesFence ? ["```", ...carry] : carry;
    curLen = lengthOf(cur);
  }

  // The pieces of one overlong line are never packed together with anything:
  // joining them with a newline would put a line break inside a word.
  const pieces: { text: string; solo: boolean }[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.length > limit - 8) for (const part of splitLongLine(line, limit - 8)) pieces.push({ text: part, solo: true });
    else pieces.push({ text: line, solo: false });
  }

  for (const { text: piece, solo } of pieces) {
    if (solo) {
      flush(cur, inFence);
      chunks.push(inFence ? `\`\`\`\n${piece}\n\`\`\`` : piece);
      startNext([], inFence);
      continue;
    }
    const opens: boolean = FENCE_LINE.test(piece) ? !inFence : inFence; // the fence state once `piece` is in
    for (;;) {
      const add = (cur.length ? 1 : 0) + piece.length;
      // A message that ends inside a fence needs room for its closing line.
      if (!cur.length || curLen + add + (opens ? 4 : 0) <= limit) break;
      // Prefer to break at the last blank line of the current message, if the head fits.
      let blank = -1;
      for (let i = cur.length - 1; i > 0; i -= 1) {
        const head = cur.slice(0, i);
        if (cur[i]!.trim() === "" && lengthOf(head) >= Math.floor(limit / 3) && lengthOf(head) + (fenceOpenAfter(head) ? 4 : 0) <= limit) {
          blank = i;
          break;
        }
      }
      if (blank > 0) {
        const head = cur.slice(0, blank);
        const tail = cur.slice(blank + 1);
        const headFence = fenceOpenAfter(head);
        flush(head, headFence);
        startNext(tail, headFence);
      } else {
        flush(cur, inFence);
        startNext([], inFence);
      }
    }
    inFence = opens;
    cur.push(piece);
    curLen = lengthOf(cur);
  }
  flush(cur, false);
  return chunks.filter((c) => c.trim().length > 0);
}

/** Markdown in, ready-to-send messages out. */
export function formatForWhatsApp(markdown: string, max: number = WHATSAPP_CHUNK_LIMIT): string[] {
  return splitForWhatsApp(toWhatsAppText(markdown), max);
}
