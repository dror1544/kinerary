import { expect, it } from "vitest";
import raw from "../nginx.conf?raw";

// Comments explain the policy and name the hosts; only the directives are the policy.
const conf = raw.split("\n").filter((line: string) => !line.trim().startsWith("#")).join("\n");

/** The server's own header lines, and every location block's, by line (the conf is flat and two-space indented). */
function blocks(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of conf.split("\n")) {
    const start = /^ {2}location (.+?) \{$/.exec(line);
    if (start) { current = start[1]!; out.set(current, []); continue; }
    if (current && line === "  }") { current = null; continue; }
    if (current) out.get(current)!.push(line.trim());
  }
  return out;
}
const serverLevel = conf.split("\n").filter((line) => /^ {2}add_header /.test(line)).map((line) => line.trim());
const NONE = `add_header Content-Security-Policy "frame-ancestors 'none'" always;`;
const DENY = `add_header X-Frame-Options "DENY" always;`;
const TELEGRAM = [
  `add_header Content-Security-Policy "frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org" always;`,
];

it("the portal is not framable by default: frame-ancestors 'none' and X-Frame-Options DENY at the server", () => {
  expect(serverLevel).toContain(NONE);
  expect(serverLevel).toContain(DENY);
});

/** A location's Content-Security-Policy value, if it adds one. */
const policyOf = (lines: string[]) => /^add_header Content-Security-Policy "(.*)" always;$/.exec(lines.find((line) => line.startsWith("add_header Content-Security-Policy")) ?? "")?.[1];
const GOOGLE_SHELL = "@google_sign_in_shell";

it("every location that adds a header of its own restates the no-framing pair (nginx does not inherit them)", () => {
  for (const [name, lines] of blocks()) {
    const adds = lines.filter((line) => line.startsWith("add_header "));
    if (adds.length === 0 || name === "@mini_app_shell") continue;
    // The Google sign-in shell carries MORE than the pair in its policy, never less: it must still start with it.
    if (name === GOOGLE_SHELL) expect(policyOf(lines), name).toMatch(/^frame-ancestors 'none'(;|$)/);
    else expect(adds, name).toContain(NONE);
    expect(adds, name).toContain(DENY);
  }
});

it("Google may be reached from the sign-in and sign-up documents and from nowhere else", () => {
  const all = blocks();
  expect(all.get("= /sign-in")).toEqual(["try_files $uri @google_sign_in_shell;"]);
  expect(all.get("= /sign-up")).toEqual(["try_files $uri @google_sign_in_shell;"]);
  const shell = all.get(GOOGLE_SHELL)!;
  expect(shell).toContain("rewrite ^ /index.html break;");
  const policy = policyOf(shell)!;
  const directive = (name: string) => policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";
  // Exactly the paths Google documents for the Identity Services button: its script, its frame, its callbacks, its stylesheet.
  expect(directive("script-src")).toBe("script-src 'self' https://accounts.google.com/gsi/client");
  expect(directive("frame-src")).toBe("frame-src https://accounts.google.com/gsi/");
  expect(directive("connect-src")).toBe("connect-src 'self' https://accounts.google.com/gsi/");
  expect(directive("style-src")).toContain("https://accounts.google.com/gsi/style");
  // Not the whole of Google, not a wildcard, not an inline script.
  expect(policy).not.toMatch(/\*|google\.com(?!\/gsi)|unsafe-eval/);
  expect(directive("script-src")).not.toContain("unsafe-inline");
  // And nowhere else: the server-level headers and every other location never mention Google.
  expect(serverLevel.some((line) => /google/i.test(line))).toBe(false);
  for (const [name, lines] of all) {
    if (name === GOOGLE_SHELL || name === "= /sign-in" || name === "= /sign-up") continue; // the two that point at the shell
    expect(lines.some((line) => /google/i.test(line)), name).toBe(false);
  }
  expect(conf.match(/accounts\.google\.com/g)?.length).toBe(4);
  // The Mini App shell and its framing policy are untouched by any of this.
  expect(all.get("@mini_app_shell")).toContain(TELEGRAM[0]);
  expect(all.get("@mini_app_shell")!.some((line) => /google/i.test(line))).toBe(false);
});

it("only the Mini App shell may be framed, and only by Telegram's web clients", () => {
  const all = blocks();
  const shell = all.get("@mini_app_shell")!;
  expect(shell).toContain(TELEGRAM[0]);
  expect(shell.some((line) => /X-Frame-Options/i.test(line)), "X-Frame-Options cannot name an origin and would cancel the CSP line").toBe(false);
  // The allow-list appears exactly once in the whole file, nowhere near any other location.
  expect(conf.match(/telegram\.org/g)?.length).toBe(3);
  expect(conf.match(/frame-ancestors https:/g)?.length).toBe(1);
  // No wildcard, no 'self', no other site.
  expect(conf).not.toMatch(/frame-ancestors[^;"]*(\*|'self'|http:)/);
  // The two Mini App locations reach the shell through the named location - an
  // internal redirect to /index.html would take that location's 'none' instead.
  expect(all.get("= /mini-app")).toEqual(["try_files $uri @mini_app_shell;"]);
  expect(all.get("^~ /mini-app/")).toEqual(["try_files $uri @mini_app_shell;"]);
  expect(shell).toContain("rewrite ^ /index.html break;");
  for (const [name, lines] of all) {
    if (name === "@mini_app_shell") continue;
    expect(lines.some((line) => /telegram/i.test(line)), name).toBe(false);
  }
});

it("the asset location's regex is quoted, or nginx cannot start", () => {
  expect(conf).toMatch(/location ~\* "\/assets\/\.\*-\[A-Za-z0-9_-\]\{8,\}\\\.\(js\|css\|svg\|woff2\)\$" \{/);
});
