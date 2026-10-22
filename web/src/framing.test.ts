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

it("every location that adds a header of its own restates the no-framing pair (nginx does not inherit them)", () => {
  for (const [name, lines] of blocks()) {
    const adds = lines.filter((line) => line.startsWith("add_header "));
    if (adds.length === 0 || name === "@mini_app_shell") continue;
    expect(adds, name).toContain(NONE);
    expect(adds, name).toContain(DENY);
  }
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
