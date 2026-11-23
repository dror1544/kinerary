/**
 * WhatsApp ids: one canonical form, and the bridge's resolver to reach it.
 *
 * WhatsApp names a person two ways: a phone id (`<digits>@s.whatsapp.net`) and a
 * linked-identity id (`<digits>@lid`). The 2026-11-22 capture (spec 625, AC-0)
 * found the linked-identity form in EVERY event and the phone form missing from
 * some, so the linked-identity form is canonical. The phone form, when known, is
 * reported beside it and never instead of it.
 *
 * A person seen only as a phone id would otherwise get a second opaque id in the
 * relay, so the resolver maps one to the other: from the alternates WhatsApp
 * puts beside an id, from group participant lists, and from the library's own
 * mapping store. A sender it cannot resolve is reported as UNKNOWN (null), never
 * guessed.
 *
 * Adapted from the device-suffix handling of the MIT-licensed Hermes Agent
 * bridge (see NOTICE.md); the resolver is new.
 */

const LID_RE = /^[0-9]{5,40}@lid$/;
const PN_RE = /^[0-9]{5,40}@s\.whatsapp\.net$/;
const GROUP_RE = /^[0-9]{5,40}(-[0-9]{5,20})?@g\.us$/;

/**
 * `<user>:<device>@<server>` -> `<user>@<server>`. The library reports the
 * number's own ids device-qualified and everyone else's not; both must compare
 * equal.
 */
export function stripDevice(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const at = trimmed.indexOf("@");
  if (at === -1) return trimmed.replace(/:\d+$/, "");
  const user = trimmed.slice(0, at).replace(/:\d+$/, "");
  return `${user}${trimmed.slice(at)}`;
}

/** The legacy server name some library paths still use for the phone form. */
function normalizeServer(id) {
  return id.endsWith("@c.us") ? `${id.slice(0, -5)}@s.whatsapp.net` : id;
}

export function normalizeId(value) {
  const id = normalizeServer(stripDevice(value));
  return id;
}

/** "lid" | "pn" | "group" | "other" — by shape only. */
export function idKind(value) {
  const id = normalizeId(value);
  if (LID_RE.test(id)) return "lid";
  if (PN_RE.test(id)) return "pn";
  if (GROUP_RE.test(id)) return "group";
  return "other";
}

export const isGroupId = (value) => idKind(value) === "group";

/** A bounded map that forgets its oldest entry first. */
class Lru {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
}

/**
 * @param {{ lookupLid?: (pn: string) => Promise<string|null|undefined>, limit?: number }} [options]
 *   `lookupLid` asks the library's own mapping store (which lives in the session
 *   directory). It is the only place the library's address-book-derived mappings
 *   are consulted, and only for an id that arrived in traffic.
 */
export function createIdResolver({ lookupLid, limit = 4096 } = {}) {
  const lidByPn = new Lru(limit);
  const pnByLid = new Lru(limit);

  function learn(lid, pn) {
    const l = normalizeId(lid);
    const p = normalizeId(pn);
    if (idKind(l) !== "lid" || idKind(p) !== "pn") return;
    lidByPn.set(p, l);
    pnByLid.set(l, p);
  }

  /**
   * @param {...(string|null|undefined)} ids every form of ONE person that the event carries
   * @returns {Promise<{ lid: string|null, phone: string|null }>}
   */
  async function resolve(...ids) {
    let lid = null;
    let phone = null;
    for (const raw of ids) {
      const id = normalizeId(raw);
      const kind = idKind(id);
      if (kind === "lid" && !lid) lid = id;
      else if (kind === "pn" && !phone) phone = id;
    }
    if (lid && phone) {
      learn(lid, phone);
      return { lid, phone };
    }
    if (lid) return { lid, phone: pnByLid.get(lid) ?? null };
    if (phone) {
      let found = lidByPn.get(phone) ?? null;
      if (!found && lookupLid) {
        try {
          const asked = normalizeId(await lookupLid(phone));
          if (idKind(asked) === "lid") found = asked;
        } catch {
          found = null;
        }
      }
      if (found) {
        learn(found, phone);
        return { lid: found, phone };
      }
      return { lid: null, phone };
    }
    return { lid: null, phone: null };
  }

  return { resolve, learn };
}
