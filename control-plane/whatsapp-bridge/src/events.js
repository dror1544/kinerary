/**
 * From the library's events to the bridge's contract (spec 625, "Bridge sidecar
 * and WhatsAppClient"). Pure apart from the id resolver it is handed.
 *
 * Parts of the envelope handling and the bounded store are adapted from the
 * MIT-licensed Hermes Agent bridge (see NOTICE.md); everything that decides what
 * leaves the bridge is new, because Hermes's bridge decides who may talk to the
 * agent and this one decides nothing — the relay does.
 *
 * What is NOT delivered as a message: a message with no text and no media
 * (protocol notices, history-sync notices, key distribution on its own,
 * reactions, stickers), a group stub, and anything that arrived as history
 * (`type !== "notify"`).
 */
import { idKind, isGroupId, normalizeId, phoneLast4 } from "./ids.js";

/** Peel the envelopes a message can arrive wrapped in (ephemeral, view-once, caption wrappers). */
export function unwrap(message) {
  let current = message;
  for (let i = 0; i < 8 && current; i += 1) {
    const next =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.documentWithCaptionMessage?.message;
    if (next === undefined) break;
    current = next;
  }
  return current ?? {};
}

function contextOf(content) {
  for (const value of Object.values(content)) {
    if (value && typeof value === "object" && value.contextInfo) return value.contextInfo;
  }
  return {};
}

function textOf(content) {
  if (typeof content.conversation === "string" && content.conversation) return content.conversation;
  const ext = content.extendedTextMessage?.text;
  if (typeof ext === "string" && ext) return ext;
  for (const key of ["imageMessage", "videoMessage", "documentMessage"]) {
    const caption = content[key]?.caption;
    if (typeof caption === "string" && caption) return caption;
  }
  return "";
}

const MEDIA = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["audioMessage", "audio"],
  ["documentMessage", "document"],
];

function mediaOf(content) {
  for (const [key, kind] of MEDIA) {
    const item = content[key];
    if (!item) continue;
    const size = Number(item.fileLength?.toString?.() ?? item.fileLength ?? 0);
    return {
      kind,
      mime: typeof item.mimetype === "string" ? item.mimetype : "",
      size: Number.isFinite(size) ? size : 0,
      filename: typeof item.fileName === "string" ? item.fileName : "",
    };
  }
  return undefined;
}

/**
 * A display name that is really a number is not a name. The relay needs "empty
 * rather than a number when the name is absent" (Sender ids), so the bridge
 * does not hand it one to filter.
 */
export function cleanName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim().slice(0, 100);
  if (!name) return "";
  if (/^[+\d\s().-]{6,}$/.test(name)) return "";
  if (/@(lid|s\.whatsapp\.net|g\.us|c\.us)$/.test(name)) return "";
  return name;
}

/** The text of a quoted message, if it carries any. */
function quotedTextOf(quoted) {
  if (!quoted || typeof quoted !== "object") return undefined;
  const text = textOf(unwrap(quoted));
  return text || undefined;
}

/**
 * @param {object} msg a library message from `messages.upsert`
 * @param {{ resolver: ReturnType<typeof import("./ids.js").createIdResolver>, own: { lid: string|null, phone: string|null } }} ctx
 * @returns {Promise<{ event: object } | { skip: string }>}
 */
export async function extractMessage(msg, { resolver, own }) {
  const key = msg?.key;
  if (!key || !msg.message) return { skip: "no_message" };
  if (msg.messageStubType) return { skip: "stub" };
  const remote = normalizeId(key.remoteJid);
  const remoteKind = idKind(remote);
  if (remoteKind === "other") return { skip: "unsupported_chat" };

  const content = unwrap(msg.message);
  const text = textOf(content);
  const media = mediaOf(content);
  if (!text && !media) return { skip: "no_content" };

  const fromMe = key.fromMe === true;
  const ownLid = own.lid;
  let chatId;
  let senderId = null;
  let senderPhone; // the phone id, held only long enough to take its last four digits

  if (remoteKind === "group") {
    chatId = remote;
    if (fromMe) {
      senderId = ownLid;
      if (own.phone) senderPhone = own.phone;
    } else {
      const who = await resolver.resolve(key.participant, key.participantAlt);
      senderId = who.lid;
      if (who.phone) senderPhone = who.phone;
    }
  } else {
    // A private chat: its address IS the other person, in the canonical form.
    const peer = await resolver.resolve(key.remoteJid, key.remoteJidAlt);
    if (!peer.lid) return { skip: "unresolved_chat" };
    chatId = peer.lid;
    if (fromMe) {
      senderId = ownLid;
      if (own.phone) senderPhone = own.phone;
    } else {
      senderId = peer.lid;
      if (peer.phone) senderPhone = peer.phone;
    }
  }

  const ctxInfo = contextOf(content);
  const mentioned = [];
  for (const raw of ctxInfo.mentionedJid ?? []) {
    const who = await resolver.resolve(raw);
    if (who.lid && !mentioned.includes(who.lid)) mentioned.push(who.lid);
  }

  const event = {
    type: "message",
    chatId,
    senderId,
    senderName: fromMe ? "" : cleanName(msg.pushName),
    messageId: String(key.id ?? ""),
    text,
    timestamp: Number(msg.messageTimestamp?.toString?.() ?? msg.messageTimestamp ?? 0) || 0,
    fromMe,
    mentionedIds: mentioned,
  };
  if (!event.messageId) return { skip: "no_message_id" };
  // A full number never leaves the bridge in a message: the relay needs only the last four at binding time.
  const last4 = senderPhone ? phoneLast4(senderPhone) : undefined;
  if (last4) event.senderPhoneLast4 = last4;
  if (typeof ctxInfo.stanzaId === "string" && ctxInfo.stanzaId) {
    event.quotedMessageId = ctxInfo.stanzaId;
    if (ctxInfo.participant) {
      const quoted = await resolver.resolve(ctxInfo.participant);
      if (quoted.lid) event.quotedParticipant = quoted.lid;
    }
    const quotedText = quotedTextOf(ctxInfo.quotedMessage);
    if (quotedText) event.quotedText = quotedText;
  }
  if (media) event.media = media;
  return { event };
}

/** A group participant entry, in any shape the library has used. */
function participantForms(entry) {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [];
  return [entry.id, entry.lid, entry.phoneNumber, entry.jid].filter((v) => typeof v === "string");
}

export async function resolveParticipant(entry, resolver) {
  return resolver.resolve(...participantForms(entry));
}

/** True when one of `forms` is the number itself (either of its two ids). */
export function isOwn(forms, own) {
  const ids = forms.map(normalizeId);
  return ids.some((id) => (own.lid && id === own.lid) || (own.phone && id === own.phone));
}

/**
 * The events a group notification means to the relay.
 *
 * `addedBy` is taken from the notification's AUTHOR only (the person who did the
 * adding), never from the group's owner or subject owner: AC-28 binds a group on
 * it, and a creator is not necessarily the adder.
 */
export async function groupEventsFromUpsert(groups, { resolver, own, remember }) {
  const out = [];
  for (const group of groups ?? []) {
    const chatId = normalizeId(group?.id);
    if (!isGroupId(chatId)) continue;
    const forms = (group.participants ?? []).flatMap((p) => participantForms(p));
    if (!isOwn(forms, own)) continue;
    if (!remember(chatId)) continue;
    const by = await resolver.resolve(group.author, group.authorPn);
    const event = { type: "added_to_group", chatId };
    if (by.lid) event.addedBy = by.lid;
    if (typeof group.subject === "string" && group.subject) event.title = group.subject.slice(0, 200);
    out.push(event);
  }
  return out;
}

export async function groupEventsFromParticipants(update, { resolver, own, remember, forget }) {
  const out = [];
  const chatId = normalizeId(update?.id);
  if (!isGroupId(chatId)) return out;
  const participants = update.participants ?? [];
  if (update.action === "add") {
    const forms = participants.flatMap((p) => participantForms(p));
    if (isOwn(forms, own) && remember(chatId)) {
      const by = await resolver.resolve(update.author, update.authorPn);
      const event = { type: "added_to_group", chatId };
      if (by.lid) event.addedBy = by.lid;
      out.push(event);
    }
    return out;
  }
  if (update.action === "remove") {
    for (const entry of participants) {
      const who = await resolveParticipant(entry, resolver);
      if (!who.lid) continue;
      if (isOwn(participantForms(entry), own)) forget(chatId);
      out.push({ type: "participant_left", chatId, participantId: who.lid });
    }
  }
  return out;
}

export function groupEventsFromUpdates(updates) {
  const out = [];
  for (const update of updates ?? []) {
    const chatId = normalizeId(update?.id);
    if (!isGroupId(chatId)) continue;
    if (typeof update.subject === "string" && update.subject) {
      out.push({ type: "title_changed", chatId, title: update.subject.slice(0, 200) });
    }
  }
  return out;
}

/**
 * Recent message handles, keyed by chat AND id so that a lookup in one chat can
 * never reach another chat's message (AC-24, AC-26). Bounded; the oldest goes
 * first; a dropped handle is a 404.
 */
export function createMessageStore(limit = 512) {
  const byKey = new Map();
  const keyOf = (chatId, messageId) => `${chatId}\n${messageId}`;
  return {
    remember(chatId, msg) {
      const id = msg?.key?.id;
      if (!chatId || !id) return;
      const key = keyOf(chatId, id);
      byKey.delete(key);
      byKey.set(key, msg);
      while (byKey.size > limit) byKey.delete(byKey.keys().next().value);
    },
    get(chatId, messageId) {
      return byKey.get(keyOf(chatId, messageId)) ?? null;
    },
    get size() {
      return byKey.size;
    },
  };
}

/**
 * A cursor over a bounded ring of events. Reading does not remove anything: a
 * relay that crashed between receiving a batch and acting on it asks again with
 * the same cursor. What falls off the end before it was asked for is reported as
 * a count (`lost`), never dropped silently.
 */
export function createEventLog(capacity = 500) {
  let nextSeq = 1;
  const events = [];
  const waiters = new Set();
  return {
    push(event) {
      events.push({ ...event, seq: nextSeq });
      nextSeq += 1;
      while (events.length > capacity) events.shift();
      for (const wake of [...waiters]) wake();
    },
    /**
     * `lastSeq` is the cursor to ask with next: the last event DELIVERED in this
     * batch, so a batch cut at `limit` never skips the rest; `more` says there is
     * a rest. With nothing to deliver it is the ring's tip (which also resyncs a
     * caller whose cursor is ahead of a restarted bridge).
     */
    since(after, limit = 100) {
      const from = Number.isFinite(after) && after > 0 ? after : 0;
      const oldest = events.length ? events[0].seq : nextSeq;
      const lost = from + 1 < oldest ? oldest - from - 1 : 0;
      const pending = events.filter((e) => e.seq > from);
      const batch = pending.slice(0, limit);
      return {
        events: batch,
        lastSeq: batch.length ? batch[batch.length - 1].seq : nextSeq - 1,
        lost,
        more: pending.length > batch.length,
      };
    },
    /** Resolve when something newer than `after` exists, or after `ms`, or when aborted. */
    wait(after, ms, signal) {
      return new Promise((resolve) => {
        const ready = () => events.length > 0 && events[events.length - 1].seq > after;
        if (ready()) return resolve();
        let timer;
        const done = () => {
          waiters.delete(check);
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", done);
          resolve();
        };
        const check = () => {
          if (ready()) done();
        };
        waiters.add(check);
        timer = setTimeout(done, ms);
        signal?.addEventListener?.("abort", done);
      });
    },
    get lastSeq() {
      return nextSeq - 1;
    },
    get size() {
      return events.length;
    },
  };
}
