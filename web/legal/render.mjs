// Renders web/legal/*.md into the static pages web/public/{privacy,terms}/index.html.
//
//   npm run legal            rewrite both pages from their markdown
//   npm run legal -- --check exit 1 if a committed page differs from its markdown
//
// The markdown is the source of truth (owner-approved wording); the HTML is generated and committed so the
// build needs nothing extra, and src/legal.test.ts fails when the two disagree. This is NOT a general markdown
// engine: it handles exactly the subset the two documents use (headings, paragraphs, bullet lists, tables,
// bold, italic, inline code, bare e-mail addresses) and THROWS on anything else, so a future edit that uses
// a construct it cannot render fails loudly instead of printing literal markdown on a legal page.
// No script, no external font or stylesheet, no runtime dependency: the pages say what third parties load,
// so they load none themselves.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PAGES = {
  privacy: { title: "Privacy Policy", other: { href: "/terms", label: "Terms of Service" } },
  terms: { title: "Terms of Service", other: { href: "/privacy", label: "Privacy Policy" } },
};

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline markup: `code`, **bold**, *italic*, e-mail addresses. */
export function inline(text) {
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    const code = /`([^`]+)`/.exec(rest);
    if (!code) { parts.push(emphasis(rest)); break; }
    parts.push(emphasis(rest.slice(0, code.index)), `<code>${escapeHtml(code[1])}</code>`);
    rest = rest.slice(code.index + code[0].length);
  }
  return parts.join("");
}

function emphasis(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (mail) => `<a href="mailto:${mail}">${mail}</a>`);
  // Anything markdown-ish left over is a construct this renderer does not know: fail rather than print it raw.
  if (/[*`]/.test(html)) throw new Error(`legal markdown: unsupported inline markup in: ${text}`);
  return html;
}

const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

/** The body of a page: markdown to HTML (the h1 is returned separately). */
export function renderBody(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let heading = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const h = /^(#{1,2}) (.+)$/.exec(line);
    if (h) {
      if (h[1] === "#") {
        if (heading) throw new Error("legal markdown: more than one h1");
        heading = h[2];
      } else {
        out.push(`<h2>${inline(h[2])}</h2>`);
      }
      i++; continue;
    }
    if (line.startsWith("#")) throw new Error(`legal markdown: unsupported heading: ${line}`);
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      if (rows.length < 3 || !/^\|[\s|:-]+\|$/.test(rows[1])) throw new Error(`legal markdown: malformed table at: ${rows[0]}`);
      const head = splitRow(rows[0]);
      const body = rows.slice(2).map(splitRow);
      for (const row of body) {
        if (row.length !== head.length) throw new Error(`legal markdown: table row has ${row.length} cells, header has ${head.length}: ${row.join(" | ")}`);
      }
      out.push(
        `<div class="table-scroll" role="region" tabindex="0" aria-label="${escapeHtml(head[0])} table"><table>`,
        `<thead><tr>${head.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead>`,
        `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("\n")}</tbody>`,
        "</table></div>",
      );
      continue;
    }
    if (line.startsWith("- ")) {
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        let item = lines[i++].slice(2);
        while (i < lines.length && /^ {2}\S/.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(item);
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("\n")}</ul>`);
      continue;
    }
    if (/^\s/.test(line) || /^\d+\. /.test(line)) throw new Error(`legal markdown: unsupported block: ${line}`);
    // A paragraph runs to the next blank line or block start; a soft line break is a space.
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#|\||- )/.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  if (!heading) throw new Error("legal markdown: no h1");
  return { heading, html: out.join("\n") };
}

const STYLE = `
:root { --ink: #10263a; --ink-soft: #405363; --teal: #0e8f86; --paper: #faf8f5; --line: rgba(16, 38, 58, 0.13); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main, footer { width: min(820px, calc(100% - 32px)); margin: 0 auto; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 24px; padding: 20px 0 12px; border-bottom: 1px solid var(--line); }
header a.brand { color: var(--ink); font-weight: 800; font-size: 20px; letter-spacing: -0.01em; text-decoration: none; }
nav { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 14px; font-weight: 700; }
a { color: var(--teal); }
a:focus-visible, .table-scroll:focus-visible { outline: 3px solid rgba(14, 143, 134, 0.32); outline-offset: 2px; }
h1 { margin: 32px 0 8px; font-size: clamp(28px, 6vw, 38px); line-height: 1.15; letter-spacing: -0.02em; }
h2 { margin: 36px 0 8px; font-size: 21px; line-height: 1.3; }
p, ul { margin: 0 0 14px; }
ul { padding-left: 22px; }
li { margin-bottom: 6px; }
code { padding: 1px 5px; border-radius: 4px; background: rgba(16, 38, 58, 0.07); font-size: 0.92em; }
.table-scroll { margin: 0 0 18px; overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
table { width: 100%; min-width: 640px; border-collapse: collapse; font-size: 14px; line-height: 1.5; }
th, td { padding: 9px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { background: rgba(14, 143, 134, 0.08); font-weight: 700; }
tr:last-child td { border-bottom: 0; }
footer { margin-top: 40px; padding: 28px 0 48px; border-top: 1px solid var(--line); color: var(--ink-soft); font-size: 14px; }
`.trim();

export function renderPage(kind, markdown) {
  const page = PAGES[kind];
  if (!page) throw new Error(`legal markdown: unknown page ${kind}`);
  const { heading, html } = renderBody(markdown);
  const nav = (label) => `<nav aria-label="${label}"><a href="/">Home</a><a href="${page.other.href}">${page.other.label}</a></nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} · Kinerary</title>
<meta name="description" content="Kinerary ${page.title}">
<style>
${STYLE}
</style>
</head>
<body>
<header>
<a class="brand" href="/">Kinerary</a>
${nav("Legal")}
</header>
<main>
<h1>${inline(heading)}</h1>
${html}
</main>
<footer>
${nav("Legal footer")}
</footer>
</body>
</html>
`;
}

const here = dirname(fileURLToPath(import.meta.url));
export const sourcePath = (kind) => resolve(here, `${kind}.md`);
export const outputPath = (kind) => resolve(here, "../public", kind, "index.html");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const kind of Object.keys(PAGES)) {
    const html = renderPage(kind, readFileSync(sourcePath(kind), "utf8"));
    if (check) {
      let current = "";
      try { current = readFileSync(outputPath(kind), "utf8"); } catch { /* missing counts as stale */ }
      if (current !== html) { console.error(`web/public/${kind}/index.html is out of date with web/legal/${kind}.md; run: npm run legal`); stale = true; }
    } else {
      writeFileSync(outputPath(kind), html);
      console.log(`wrote web/public/${kind}/index.html`);
    }
  }
  if (stale) process.exit(1);
}
