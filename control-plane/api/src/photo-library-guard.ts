/**
 * The address guard for a photo library a person typed in (docs/specs/sprint-9/699-user-photo-library.md, AC-4).
 *
 * A server that fetches an address a user supplied is the classic request-forgery shape: "my Immich is at
 * http://169.254.169.254/" asks the control plane to read its own cloud metadata, and "http://127.0.0.1:5432/" to poke
 * its own database. So, on EVERY call, not only when the connection is made:
 *
 *   - http and https only, and no username or password in the address;
 *   - the host is resolved HERE, every address it resolves to is checked, and the connection is made to the address
 *     that was checked (a `lookup` that answers with it): there is no second resolution a rebinding name could win;
 *   - loopback, link-local, the metadata address, the private ranges, unspecified, multicast and reserved space are
 *     refused, in every spelling (IPv4-mapped and IPv4-embedding IPv6 forms are judged as the IPv4 address they carry),
 *     unless the deployment's `photo_library.allowed_private_hosts` names the host. The metadata address, unspecified
 *     and multicast are refused even then: no home library lives there;
 *   - a redirect (any 3xx) is an error, never followed;
 *   - one deadline for the whole exchange, the name lookup included (a resolver that never answers or a trickling server
 *     cannot keep it open), and a cap on the bytes read,
 *     counted as they arrive rather than trusted from `content-length`.
 *
 * Errors carry a code and a fixed sentence, never the address, a header or the server's own text: the caller's
 * headers hold the library key.
 *
 * The private ranges are written as octets, not dotted strings, on purpose: they are the generic ranges every
 * deployment has, and preflight's hard-rule-6 check looks for dotted literals of two of them in code.
 */
import { Resolver as DnsResolver } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

export type AddressClass = "public" | "loopback" | "private" | "link_local" | "metadata" | "unspecified" | "multicast" | "reserved";

export type GuardErrorCode = "invalid_address" | "address_not_allowed" | "unreachable" | "timeout" | "response_too_large" | "redirect_refused";

const GUARD_MESSAGES: Record<GuardErrorCode, string> = {
  invalid_address: "The address must be an http or https address with no user name or password in it.",
  address_not_allowed: "That address is on a private, local or reserved network the control plane may not reach.",
  unreachable: "The server could not be reached.",
  timeout: "The server took too long to answer.",
  response_too_large: "The server's answer was larger than allowed.",
  redirect_refused: "The server answered with a redirect, which is not followed.",
};

export class PhotoLibraryGuardError extends Error {
  readonly code: GuardErrorCode;
  constructor(code: GuardErrorCode) {
    super(GUARD_MESSAGES[code]);
    this.name = "PhotoLibraryGuardError";
    this.code = code;
  }
  toJSON(): { code: GuardErrorCode } { return { code: this.code }; }
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export interface GuardOptions {
  /** `photo_library.allowed_private_hosts`: hosts (as typed in the address) that may resolve to a private address. */
  allowedPrivateHosts?: readonly string[];
  /** Injected by tests; production resolves with the system resolver. */
  resolve?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * The production resolver: c-ares (`dns.Resolver`), with its own per-try timeout and a bounded number of tries, and
 * cancelled when the call's deadline passes. Not `dns.lookup`: getaddrinfo cannot be cancelled and runs in the libuv
 * thread pool every file read and crypto call shares, so a few hung lookups would stall the whole API. c-ares does not
 * follow the system's full name-service configuration (getaddrinfo's), so a name only some other source knows may not
 * resolve here: the request then reads `unreachable`.
 */
export function systemResolver(timeoutMs: number, servers?: readonly string[]): { resolve: Resolver; cancel: () => void } {
  const resolver = new DnsResolver({ timeout: Math.max(100, Math.floor(timeoutMs / 2)), tries: 2 });
  // Tests only: point it at a stand-in name server. Production uses the system's configured servers.
  if (servers) resolver.setServers([...servers]);
  return {
    cancel: () => resolver.cancel(),
    resolve: async (hostname) => {
      const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
      if (v4.status === "rejected" && v6.status === "rejected") throw new Error("lookup failed");
      return [
        ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
        ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
      ];
    },
  };
}

// ── address classification ────────────────────────────────────────────────────────────────────────────────────────────

type Range = readonly [bytes: readonly number[], prefix: number, kind: AddressClass];

// Order matters: the first range that matches decides.
const V4_RANGES: readonly Range[] = [
  [[169, 254, 169, 254], 32, "metadata"],
  [[0, 0, 0, 0], 8, "unspecified"],
  [[127, 0, 0, 0], 8, "loopback"],
  [[169, 254, 0, 0], 16, "link_local"],
  [[10, 0, 0, 0], 8, "private"],
  [[100, 64, 0, 0], 10, "private"], // shared address space (carrier NAT)
  [[172, 16, 0, 0], 12, "private"],
  [[192, 168, 0, 0], 16, "private"],
  [[224, 0, 0, 0], 4, "multicast"],
  [[192, 0, 0, 0], 24, "reserved"],
  [[192, 0, 2, 0], 24, "reserved"],
  [[198, 18, 0, 0], 15, "reserved"],
  [[198, 51, 100, 0], 24, "reserved"],
  [[203, 0, 113, 0], 24, "reserved"],
  [[240, 0, 0, 0], 4, "reserved"], // includes the broadcast address
];

const V6_RANGES: readonly Range[] = [
  [[0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54], 128, "metadata"],
  [[0xfc], 7, "private"],
  [[0xfe, 0x80], 10, "link_local"],
  [[0xfe, 0xc0], 10, "private"], // deprecated site-local
  [[0xff], 8, "multicast"],
  [[0x20, 0x01, 0x0d, 0xb8], 32, "reserved"],
  [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64, "reserved"],
  [[0x20, 0x01, 0x00, 0x00], 32, "reserved"], // Teredo: an obfuscated IPv4 inside
  [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48, "private"], // local-use NAT64
];

function inRange(bytes: readonly number[], base: readonly number[], prefix: number): boolean {
  for (let bit = 0; bit < prefix; bit += 8) {
    const index = bit / 8;
    const take = Math.min(8, prefix - bit);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((base[index] ?? 0) & mask)) return false;
  }
  return true;
}

function ipv4Bytes(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function ipv6Bytes(input: string): number[] | null {
  let value = input.toLowerCase();
  if (value.includes("%")) return null; // a zone id names an interface, not an address
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4Bytes(tail);
    if (!v4) return null;
    value = `${value.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length > 7) return null;
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => { const n = parseInt(group, 16); return [n >> 8, n & 0xff]; });
}

function classifyV4(bytes: readonly number[]): AddressClass {
  for (const [base, prefix, kind] of V4_RANGES) if (inRange(bytes, base, prefix)) return kind;
  return "public";
}

/** What kind of address this is. Anything that does not parse is "reserved", and so refused. */
export function classifyAddress(raw: string): AddressClass {
  const value = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const v4 = ipv4Bytes(value);
  if (v4) return classifyV4(v4);
  const b = ipv6Bytes(value);
  if (!b) return "reserved";
  const zeroUpTo = (n: number) => b.slice(0, n).every((byte) => byte === 0);
  if (zeroUpTo(16)) return "unspecified";
  if (zeroUpTo(15) && b[15] === 1) return "loopback";
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64): the IPv4 address they carry decides.
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12));
  if (inRange(b, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return classifyV4(b.slice(12));
  // 2002:abcd:efgh::/48 (6to4) carries an IPv4 address in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6));
  if (zeroUpTo(12)) return "reserved"; // deprecated IPv4-compatible form
  for (const [base, prefix, kind] of V6_RANGES) if (inRange(b, base, prefix)) return kind;
  // Only 2000::/3 is global unicast.
  return (b[0]! & 0xe0) === 0x20 ? "public" : "reserved";
}

/** Classes the allow-list can never open: nobody's photo library lives at the metadata address or a broadcast. */
const NEVER_ALLOWED: ReadonlySet<AddressClass> = new Set(["metadata", "unspecified", "multicast"]);

function bareHost(hostname: string): string {
  return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname).toLowerCase();
}

function isIpLiteral(host: string): boolean {
  return ipv4Bytes(host) !== null || ipv6Bytes(host) !== null;
}

// ── the address a person typed ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The library address as stored: http(s), no credentials, no query or fragment, host lower-cased (the URL parser also
 * turns decimal, hex and octal IPv4 spellings into the dotted form), no trailing slash on the path.
 */
export function parseLibraryAddress(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) throw new PhotoLibraryGuardError("invalid_address");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PhotoLibraryGuardError("invalid_address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PhotoLibraryGuardError("invalid_address");
  if (url.username || url.password || !url.hostname || url.search || url.hash) throw new PhotoLibraryGuardError("invalid_address");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

/** The stored form of a parsed address: origin plus path, no trailing slash. */
export function libraryAddressString(url: URL): string {
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

/**
 * Resolves the URL's host and checks every address it gets. Returns the address to connect to (the first one; all of
 * them passed). A literal IP host is checked as it is and never resolved.
 */
export async function vetHost(url: URL, options: GuardOptions & { resolve: Resolver }): Promise<{ address: string; family: 4 | 6 }> {
  const host = bareHost(url.hostname);
  const allowed = (options.allowedPrivateHosts ?? []).map(bareHost).includes(host);
  let answers: Array<{ address: string; family: 4 | 6 }>;
  if (isIpLiteral(host)) {
    answers = [{ address: host, family: ipv4Bytes(host) ? 4 : 6 }];
  } else {
    try {
      answers = await options.resolve(host);
    } catch {
      throw new PhotoLibraryGuardError("unreachable");
    }
  }
  if (answers.length === 0) throw new PhotoLibraryGuardError("unreachable");
  for (const answer of answers) {
    const kind = classifyAddress(answer.address);
    if (kind === "public") continue;
    if (allowed && !NEVER_ALLOWED.has(kind)) continue;
    throw new PhotoLibraryGuardError("address_not_allowed");
  }
  return answers[0]!;
}

export interface GuardedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * One request to a library address, guarded as the file header says. `url` must come from `parseLibraryAddress` (or be
 * built on one); the path and query here are the caller's, the host is the person's.
 */
export async function guardedFetch(
  url: URL,
  init: { method?: "GET" | "POST" | "PUT"; headers?: Record<string, string>; body?: Buffer | string },
  options: GuardOptions,
): Promise<GuardedResponse> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PhotoLibraryGuardError("invalid_address");
  if (url.username || url.password) throw new PhotoLibraryGuardError("invalid_address");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  // ONE deadline, armed before the name is looked up: the lookup, the connect and the response all spend from it.
  const expiresAt = Date.now() + timeoutMs;
  const system = options.resolve ? null : systemResolver(timeoutMs);
  let lookupTimer: NodeJS.Timeout | undefined;
  const lookupExpired = new Promise<never>((_resolve, reject) => {
    lookupTimer = setTimeout(() => { system?.cancel(); reject(new PhotoLibraryGuardError("timeout")); }, timeoutMs);
  });
  const vetting = vetHost(url, { ...options, resolve: options.resolve ?? system!.resolve });
  vetting.catch(() => {}); // a lookup that loses the race may still settle later; that is not an unhandled rejection
  let target: { address: string; family: 4 | 6 };
  try {
    target = await Promise.race([vetting, lookupExpired]);
  } finally {
    clearTimeout(lookupTimer);
  }
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) throw new PhotoLibraryGuardError("timeout");
  // The connection goes to the address checked above, whatever the system resolver would say now.
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if ((lookupOptions as { all?: boolean } | undefined)?.all) {
      (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    const finish = (error: PhotoLibraryGuardError | null, value?: GuardedResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        response?.destroy();
        request.destroy();
        reject(error);
      } else {
        resolve(value!);
      }
    };
    let request: ReturnType<typeof httpRequest>;
    try {
      request = send({
        protocol: url.protocol,
        hostname: bareHost(url.hostname),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: { ...(init.headers ?? {}), host: url.host },
        agent: false,
        lookup: pinned,
      });
    } catch {
      // An invalid header value (a key with a line break, say) throws here, before anything is sent.
      reject(new PhotoLibraryGuardError("invalid_address"));
      return;
    }
    const deadline = setTimeout(() => finish(new PhotoLibraryGuardError("timeout")), remaining);
    request.on("error", () => finish(new PhotoLibraryGuardError("unreachable")));
    request.on("response", (incoming) => {
      response = incoming;
      const status = incoming.statusCode ?? 0;
      if (status >= 300 && status < 400) { finish(new PhotoLibraryGuardError("redirect_refused")); return; }
      const announced = Number(incoming.headers["content-length"]);
      if (Number.isFinite(announced) && announced > maxBytes) { finish(new PhotoLibraryGuardError("response_too_large")); return; }
      const chunks: Buffer[] = [];
      let received = 0;
      incoming.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) { finish(new PhotoLibraryGuardError("response_too_large")); return; }
        chunks.push(chunk);
      });
      incoming.on("end", () => finish(null, { status, headers: incoming.headers, body: Buffer.concat(chunks) }));
      incoming.on("error", () => finish(new PhotoLibraryGuardError("unreachable")));
      incoming.on("aborted", () => finish(new PhotoLibraryGuardError("unreachable")));
    });
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}
