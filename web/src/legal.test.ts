import { describe, expect, it } from "vitest";
import { PAGES, renderBody, renderPage } from "../legal/render.mjs";
import privacyMd from "../legal/privacy.md?raw";
import termsMd from "../legal/terms.md?raw";
import privacyHtml from "../public/privacy/index.html?raw";
import termsHtml from "../public/terms/index.html?raw";
import landing from "./pages/LandingPage.tsx?raw";
import nginx from "../nginx.conf?raw";

type Kind = "privacy" | "terms";
const KINDS: Kind[] = ["privacy", "terms"];
const SOURCE: Record<Kind, string> = { privacy: privacyMd, terms: termsMd };
const PAGE: Record<Kind, string> = { privacy: privacyHtml, terms: termsHtml };

/** Visible text of a generated page's <main>, with tags dropped and entities decoded. */
function visibleText(html: string): string {
  const main = /<main>([\s\S]*)<\/main>/.exec(html)![1]!;
  return main.replace(/<\/(p|li|h[12]|td|th|tr|ul|table|div)>/g, " ").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
/** The markdown with its markup dropped, so what is left is exactly the words the owner approved. */
function plainMarkdown(md: string): string {
  return md
    .split("\n")
    .filter((line) => !/^\|[\s|:-]+\|$/.test(line)) // table separator rows
    .map((line) => line.replace(/^#+ /, "").replace(/^- /, "").replace(/\|/g, " ").replace(/\*\*|\*|`/g, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the legal pages are generated from their markdown sources", () => {
  for (const kind of KINDS) {
    it(`web/public/${kind}/index.html is exactly what web/legal/${kind}.md renders to (run: npm run legal)`, () => {
      expect(PAGE[kind]).toBe(renderPage(kind, SOURCE[kind]));
    });

    it(`${kind}: every word of the approved markdown is on the page, and nothing else is`, () => {
      const html = PAGE[kind];
      expect(visibleText(html)).toBe(plainMarkdown(SOURCE[kind]));
    });
  }

  it("the policy headings are on the pages", () => {
    const privacy = PAGE.privacy;
    expect(privacy).toContain("<h1>Kinerary Privacy Policy</h1>");
    for (const h of ["1. What Kinerary is", "3. Children", "9. Who we share data with", "10. Your rights", "11. Cookies and browser storage"]) {
      expect(privacy).toContain(`<h2>${h}</h2>`);
    }
    const terms = PAGE.terms;
    expect(terms).toContain("<h1>Kinerary Terms of Service</h1>");
    for (const h of ["1. Agreeing to these terms", "7. AI output: check before you rely on it", "15. Law and courts"]) {
      expect(terms).toContain(`<h2>${h}</h2>`);
    }
  });

  it("each page is a plain document: lang, title, links home and to the other page, tables that scroll, nothing external", () => {
    for (const kind of KINDS) {
      const html = PAGE[kind];
      expect(html).toContain('<html lang="en">');
      expect(html).toContain(`<title>${PAGES[kind].title} · Kinerary</title>`);
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(html).toContain('<a href="/">Home</a>');
      expect(html).toContain(`<a href="${PAGES[kind].other.href}">${PAGES[kind].other.label}</a>`);
      expect(html).toContain("overflow-x: auto");
      // The policy says which third parties load; these pages load none of them.
      expect(html).not.toMatch(/<script|<link|<iframe|<img|@import|url\(|https?:\/\//i);
    }
    expect(PAGE.privacy).toContain('<div class="table-scroll"');
  });

  it("an unsupported markdown construct fails the build instead of printing raw on a legal page", () => {
    expect(() => renderBody("# T\n\n1. numbered\n")).toThrow(/unsupported/);
    expect(() => renderBody("# T\n\n### deeper\n")).toThrow(/unsupported heading/);
    expect(() => renderBody("# T\n\nstray * star\n")).toThrow(/unsupported inline/);
    expect(() => renderBody("# T\n\n| a | b |\n|---|---|\n| only one |\n")).toThrow(/cells/);
  });
});

describe("the landing page footer links to the static pages", () => {
  it("Privacy and Terms are plain anchors to /privacy and /terms, not router links or dead text", () => {
    const footer = /<footer className="site-footer">[\s\S]*?<\/footer>/.exec(landing)![0];
    expect(footer).toContain('<a href="/privacy">Privacy</a>');
    expect(footer).toContain('<a href="/terms">Terms</a>');
    expect(footer).not.toContain("<span>Terms</span>");
  });
});

/** nginx.conf without comment lines, split into its two-space-indented location blocks. */
function locationBlock(name: string): string[] {
  const lines = nginx.split("\n").filter((line) => !line.trim().startsWith("#"));
  const start = lines.findIndex((line) => line === `  location ${name} {`);
  if (start < 0) return [];
  return lines.slice(start + 1, lines.indexOf("  }", start)).map((line) => line.trim());
}

describe("nginx serves the pages before the SPA fallback", () => {
  for (const kind of KINDS) {
    it(`/${kind} (no trailing slash) is served in place, never redirected, and keeps the no-framing headers`, () => {
      const block = locationBlock(`= /${kind}`);
      // `location /` would answer 301 to http://$host/<page>/ (wrong scheme behind a TLS proxy); a rewrite serves the file.
      expect(block).toContain(`rewrite ^ /${kind}/index.html break;`);
      expect(block.some((line) => /^(return|try_files)/.test(line))).toBe(false);
      expect(block).toContain(`add_header Content-Security-Policy "frame-ancestors 'none'" always;`);
      expect(block).toContain(`add_header X-Frame-Options "DENY" always;`);
      expect(block).toContain(`add_header Referrer-Policy "strict-origin-when-cross-origin" always;`);
    });
  }

  it("the root is the build output (Vite copies web/public/ into it) and / falls back to index.html only when no file matches", () => {
    expect(nginx).toMatch(/root \/usr\/share\/nginx\/html;/);
    expect(nginx).toMatch(/location \/ \{\s+try_files \$uri \$uri\/ \/index\.html;/);
    for (const kind of KINDS) expect(PAGE[kind].length, `web/public/${kind}/index.html`).toBeGreaterThan(0);
  });
});
