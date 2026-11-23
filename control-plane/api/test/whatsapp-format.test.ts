import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatForWhatsApp, splitForWhatsApp, toWhatsAppText } from "../src/relay/whatsapp/format.js";

describe("toWhatsAppText: the companion's Markdown in WhatsApp's dialect", () => {
  const rows: [string, string, string][] = [
    // [name, markdown, whatsapp]
    ["bold", "a **bold** word", "a *bold* word"],
    ["bold with underscores", "a __bold__ word", "a *bold* word"],
    ["bold is not then re-read as italic", "**Day 1** and **Day 2**", "*Day 1* and *Day 2*"],
    ["italic with stars", "an *italic* word", "an _italic_ word"],
    ["italic with underscores stays", "an _italic_ word", "an _italic_ word"],
    ["bold italic", "***both***", "*_both_*"],
    ["strikethrough", "~~old~~ new", "~old~ new"],
    ["bold next to italic", "**a** and *b*", "*a* and _b_"],
    ["nothing to convert", "plain text, with punctuation. (And a bracket.)", "plain text, with punctuation. (And a bracket.)"],
    ["empty", "", ""],
    ["a star between spaces is not emphasis", "5 * 3 * 2", "5 * 3 * 2"],
    ["snake_case is not italic", "use snake_case_names here", "use snake_case_names here"],
    ["a lone star is left alone", "a * b", "a * b"],

    ["heading becomes a bold line", "# Day 1\ntext", "*Day 1*\ntext"],
    ["deeper heading, closing hashes", "### Day 2 ###", "*Day 2*"],
    ["bold inside a heading does not nest", "## **Day 3**", "*Day 3*"],
    ["a hash that is not a heading", "#1 priority", "#1 priority"],

    ["star bullets", "* one\n* two", "- one\n- two"],
    ["plus bullets, nested", "+ one\n  + two", "- one\n  - two"],
    ["dash bullets stay", "- one\n- two", "- one\n- two"],
    ["numbered lists stay", "1. one\n2. two", "1. one\n2. two"],
    ["a bullet with bold", "* **Tokyo**: day one", "- *Tokyo*: day one"],
    ["a quote stays", "> quoted line", "> quoted line"],
    ["horizontal rules become a blank line", "above\n\n---\n\nbelow", "above\n\nbelow"],
    ["a star rule", "a\n***\nb", "a\n\nb"],

    ["a link becomes label (url)", "see [the map](https://example.org/map)", "see the map (https://example.org/map)"],
    ["a link whose label is its url", "[https://example.org/a](https://example.org/a)", "https://example.org/a"],
    ["an image becomes its alt text and url", "![ticket](https://example.org/t.png)", "ticket (https://example.org/t.png)"],
    ["underscores in a url are not italic", "open https://example.org/a_b_c now", "open https://example.org/a_b_c now"],
    ["underscores in a link target survive", "[x](https://example.org/a_b_c_d)", "x (https://example.org/a_b_c_d)"],
    ["a trailing full stop is not part of a url", "go to https://example.org.", "go to https://example.org."],
    ["bold label on a link", "**[Map](https://example.org/m)**", "*Map (https://example.org/m)*"],

    ["inline code is untouched", "run `a_b *c* **d**` now", "run `a_b *c* **d**` now"],
    ["a fence keeps its content and loses its language", "```ts\nconst a_b = **x**;\n```", "```\nconst a_b = **x**;\n```"],
    ["a one-line fence keeps its content", "```hello```", "```\nhello\n```"],
    ["a one-line fence with several words", "see ```npm run build``` now", "see ```\nnpm run build\n``` now"],
    ["an opening line that is not a single word is content, not a tag", "```hello world\nfoo```", "```\nhello world\nfoo\n```"],
    ["a fence with no language", "```\nline *1*\nline 2\n```", "```\nline *1*\nline 2\n```"],
    ["emphasis outside code, none inside", "**a** `**b**` **c**", "*a* `**b**` *c*"],

    ["a table becomes rows", "| Day | Place |\n|---|---|\n| 1 | Tokyo |\n| 2 | Kyoto |", "Day | Place\n1 | Tokyo\n2 | Kyoto"],
    ["a table with alignment colons", "| a | b |\n|:--|--:|\n| 1 | 2 |", "a | b\n1 | 2"],

    ["blank-line runs collapse", "a\n\n\n\n\nb", "a\n\nb"],
    ["trailing spaces go", "a   \nb\t", "a\nb"],
    ["windows line endings", "a\r\n\r\nb", "a\n\nb"],

    // Hebrew: \w is ASCII-only, so these are the cases a naive rule gets wrong.
    ["hebrew bold", "**שלום** עולם", "*שלום* עולם"],
    ["hebrew italic", "מה *שלומך* היום", "מה _שלומך_ היום"],
    ["hebrew with a bullet and a heading", "# יום ראשון\n* טוקיו", "*יום ראשון*\n- טוקיו"],
    ["hebrew link label", "[מפה](https://example.org/m)", "מפה (https://example.org/m)"],
    ["mixed hebrew and english bold", "**Tokyo** ו**קיוטו**", "*Tokyo* ו*קיוטו*"],
    ["emoji survive", "**נחיתה** ✈️ ב-10:30", "*נחיתה* ✈️ ב-10:30"],
  ];

  for (const [name, markdown, expected] of rows) {
    test(name, () => assert.equal(toWhatsAppText(markdown), expected));
  }

  test("a message cannot forge the converter's private markers", () => {
    assert.equal(toWhatsAppText("abc"), "abc");
  });

  test("it never throws, whatever it is given", () => {
    for (const hostile of ["`", "```", "```\n", "**", "[](", "![", "| |", "999", "*".repeat(5000), "[a](http://".repeat(500)]) {
      assert.doesNotThrow(() => toWhatsAppText(hostile));
    }
  });
});

describe("splitForWhatsApp", () => {
  const strip = (s: string) => s.replace(/```/g, "").replace(/\s+/g, "");

  test("a short message is one message", () => {
    assert.deepEqual(splitForWhatsApp("hello"), ["hello"]);
    assert.deepEqual(splitForWhatsApp("  \n "), []);
  });

  test("breaks at a blank line when it can", () => {
    const a = "a".repeat(60);
    const b = "b".repeat(60);
    const c = "c".repeat(60);
    assert.deepEqual(splitForWhatsApp(`${a}\n\n${b}\n\n${c}`, 130), [`${a}\n\n${b}`, c]);
  });

  test("falls back to a line end, then a space, then mid-word", () => {
    assert.deepEqual(splitForWhatsApp("aaaaaaa\nbbbbbbb\nccccccc", 16), ["aaaaaaa\nbbbbbbb", "ccccccc"]);
    const prose = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const bySpace = splitForWhatsApp(prose, 40);
    assert.ok(bySpace.length > 1 && bySpace.every((c) => c.length <= 40));
    assert.equal(bySpace.join(" "), prose, "cut at spaces only: every word is whole");
    const hard = splitForWhatsApp("x".repeat(100), 32);
    assert.ok(hard.every((c) => c.length <= 32));
    assert.equal(hard.join(""), "x".repeat(100));
  });

  test("never cuts a surrogate pair", () => {
    const text = "😀".repeat(40); // 80 UTF-16 units
    const chunks = splitForWhatsApp(text, 31);
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(c.length <= 31);
      assert.equal([...c].every((ch) => ch === "😀"), true, "no lone surrogate");
    }
    assert.equal(chunks.join(""), text);
  });

  test("a fenced block that has to be cut is closed and reopened, so each message renders alone", () => {
    const code = Array.from({ length: 12 }, (_, i) => `line ${i} of the code`).join("\n");
    const chunks = splitForWhatsApp(`intro\n\`\`\`\n${code}\n\`\`\`\noutro`, 80);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) {
      assert.ok(c.length <= 80, `${c.length}: ${c}`);
      assert.equal((c.match(/```/g) ?? []).length % 2, 0, `balanced fences in: ${c}`);
    }
    assert.equal(strip(chunks.join("\n")), strip(`intro\n\`\`\`\n${code}\n\`\`\`\noutro`));
  });

  test("nothing is lost, every message fits, in mixed prose, Hebrew and emoji (property)", () => {
    const words = ["שלום", "טוקיו", "hotel", "ramen", "✈️", "😀", "check-in", "10:30", "\n", "\n\n", "- item", "\n```\n", "a_b", "*x*"];
    let seed = 7;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let run = 0; run < 200; run += 1) {
      const parts: string[] = [];
      const n = 20 + Math.floor(rand() * 400);
      for (let i = 0; i < n; i += 1) parts.push(words[Math.floor(rand() * words.length)]!);
      const text = parts.join(rand() < 0.5 ? " " : "");
      const max = 40 + Math.floor(rand() * 200);
      const chunks = splitForWhatsApp(text, max);
      for (const c of chunks) {
        assert.ok(c.length <= max, `run ${run}: chunk of ${c.length} > ${max}`);
        assert.ok(!/[\ud800-\udbff]$/.test(c) && !/^[\udc00-\udfff]/.test(c), `run ${run}: split a surrogate pair`);
      }
      assert.equal(strip(chunks.join("")), strip(text), `run ${run}: content changed`);
    }
  });
});

describe("formatForWhatsApp: Markdown in, messages out", () => {
  test("converts, then splits", () => {
    const md = `# Plan\n${Array.from({ length: 30 }, (_, i) => `* **Day ${i}**: something to do`).join("\n")}`;
    const out = formatForWhatsApp(md, 200);
    assert.ok(out.length > 1);
    assert.ok(out.every((c) => c.length <= 200));
    assert.ok(out[0]!.startsWith("*Plan*\n- *Day 0*"));
    assert.ok(out.every((c) => !c.includes("**")));
  });

  test("a message that is only a rule is nothing to send", () => {
    assert.deepEqual(formatForWhatsApp("---"), []);
  });
});
