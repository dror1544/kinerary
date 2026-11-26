/**
 * Trip photos and moments, the relay's half (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B).
 *
 * The companion gate (companion-gate.ts) asks this object three things and it answers each without a model turn:
 *
 *   `unaddressed`  a group message nobody addressed to the assistant. A photo in it is held by reference for half an hour and, with
 *                  automatic saving on, queued to be saved (photo-saver.ts). The first such message after automatic saving is
 *                  on gets the L2 notice, once.
 *   `addressed`    a message that IS for the assistant: a group "@bot save this" / "save the last photos", a private chat's photo
 *                  ("save this to the trip", or a photo with no words, which is asked about once and saved only on a yes). A
 *                  phrase this object does not know returns null and the message goes where it always went.
 *   `tick`         the burst timer: one moment turn to the companion after five quiet minutes (photo-burst.ts).
 *
 * EVERYTHING IS GATED BY THE TRIP'S TWO SWITCHES, each honoured only as a literal `true` (feature-switches.ts: an unknown name, a
 * failed read or anything but true is off). With `chat_photos_to_album` off nothing here keeps or saves a photo; with
 * `trip_moments_capture` off no moment turn is sent. Off, a trip behaves exactly as it did before this file existed: the
 * only cost is one switch read per trip per minute.
 *
 * THE TWO SETTINGS come from the trip's site through the gateway and are cached for 60 seconds (15 when the site could not be
 * read). A setting the site did not state exactly (`group_photo_autosave: true`) is OFF, and an unknown mode is `organizer_draft`:
 * nothing is saved, and nothing reaches the chat or the site without an organizer, that nobody chose.
 *
 * THE TURN GUARD. After a moment turn, `guard` is asked about each thing the companion then sends to that chat (connector.ts):
 * in `organizer_draft` and `publish` NOTHING is posted (AC-11), in `ask_in_chat` the first message is the draft, with a Save
 * button, and any further message is held back. It correlates by the turn's own message id (the gateway's `reply_to`, or the
 * latest turn the connector forwarded to the chat); a send it cannot tie to the turn is left to the skill's own rule.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { resolveChatRoute, tripLanguage, type InlineKeyboard } from "../chat-router.js";
import { featureEnabled } from "../feature-switches.js";
import { structuredLog } from "../redaction.js";
import { addressedMark } from "./stay-silent.js";
import type { InboundTurn, MomentsPort, RoutedCompanionRoute } from "./companion-gate.js";
import type { GroupContext } from "./group-context.js";
import { HeldPhotos, type HeldPhoto } from "./held-photos.js";
import { photoLanguage, photoText, savingText, type PhotoLanguage } from "./photo-copy.js";
import { PhotoBursts, type Burst, type TripPerson } from "./photo-burst.js";
import { isNo, isYes, parseSaveRequest, plainRequestText } from "./photo-requests.js";
import { PhotoSaver, type SaveJob } from "./photo-saver.js";
import type { MomentMode, SiteParticipant, TripPhotoGateway } from "./trip-photo-gateway.js";
import type { WireMessageEvent } from "./protocol.js";

export const PHOTOS_SWITCH = "chat_photos_to_album";
export const MOMENTS_SWITCH = "trip_moments_capture";
export const SETTINGS_TTL_MS = 60_000;
export const SETTINGS_RETRY_MS = 15_000;
/** The longest the poll loop waits for a trip's settings to be read afresh. */
export const CONFIG_WAIT_MS = 1_500;
/** A question put to a person in a private chat waits this long for its yes or no. */
export const DM_QUESTION_TTL_MS = 10 * 60_000;
/** A drafted moment waits a day for an answer (the spec), on the button as in words. */
export const DRAFT_TTL_MS = 24 * 60 * 60_000;
/** How long after the turn the guard still applies to what the companion sends to the chat. */
const TURN_GUARD_MS = 15 * 60_000;
/** A send that names no turn is tied to the latest moment turn only this soon after it: its answer is quick or it is not its answer. */
const UNNAMED_REPLY_MS = 3 * 60_000;
/** A draft is shown to the companion again, with a reply that could be its answer, for this long after it was posted. */
const DRAFT_CONTEXT_MS = 30 * 60_000;
const DRAFT_TEXT_MAX = 1500;
const TURNS_MAX = 300;
const TOKENS_MAX = 300;

/** What the trip's switches and settings add up to right now. */
export interface MomentsConfig {
  /** `chat_photos_to_album` is on: photos in this trip's group are held, and may be saved. */
  photos: boolean;
  /** Automatic saving is on (the switch, the site's own switch and the setting, all exactly true). */
  autosave: boolean;
  /** `trip_moments_capture` is on (here and on the site): a burst may produce a moment turn. */
  moments: boolean;
  mode: MomentMode;
  noticePending: boolean;
  language: PhotoLanguage;
  /** Who the SITE maps by Telegram id: the one definition of a participant a photo is attributed by. */
  participants: Map<string, SiteParticipant>;
}

export interface TripMomentsDeps {
  db: pg.Pool;
  gateway: TripPhotoGateway;
  groupContext: GroupContext;
  resolvePerson(tripId: string, senderId: string): Promise<(TripPerson & { role?: string }) | null>;
  fetchAttachment(fileId: string, maxBytes: number): Promise<{ bytes: Buffer; mime?: string } | null>;
  /** Hands a turn to the companion; false when no gateway took it. */
  pushInbound(event: WireMessageEvent, turn?: { explicit?: boolean }): boolean;
  /** The bot's own @username, for the addressed mark on a tapped Save. */
  botUsername?: () => string | undefined;
  log: (line: string) => void;
  now?: () => number;
  /** Overrides the switch read (tests). Absent: feature-switches.ts, which fails to off. */
  switchOn?: (tripId: string, name: string) => Promise<boolean>;
  /** Overrides the two reads of the control-plane database (tests): a chat's route, and a trip's language. */
  routeOf?: (chatId: string) => Promise<{ kind: string; tripId?: string; hermesProfile?: string | null }>;
  languageOf?: (tripId: string) => Promise<string>;
  /** Tests run the saver and the bursts by hand with their own clock. */
  autoRunSaver?: boolean;
  /** How long the poll loop waits for a trip's settings to be read afresh (tests make it short). */
  configWaitMs?: number;
  quietMs?: number;
  maxWaitMs?: number;
}

interface MomentTurn {
  chatId: string;
  tripId: string;
  profile: string;
  mode: MomentMode;
  language: PhotoLanguage;
  photoIds: string[];
  sends: number;
  at: number;
}

/** The draft the companion posted for a burst: what it said, which photos, which button. The answer may come under another session. */
interface Draft {
  token: string;
  tripId: string;
  text: string;
  photoIds: string[];
  messageId?: string;
  at: number;
}

interface SaveToken {
  chatId: string;
  tripId: string;
  profile: string;
  language: PhotoLanguage;
  expiresAt: number;
  used: boolean;
}

export type GuardVerdict =
  | {
      kind: "deliver";
      replyMarkup?: InlineKeyboard;
      /** Told the Telegram id of the message once it has been sent, so a reply to it can be recognised. */
      sent?: (messageId: string) => void;
    }
  | { kind: "suppress"; reason: string };

/** The tap of a Save button, as dispatch hands it over. */
export interface SaveTap {
  chatId: string;
  token: string;
  fromId: string;
  fromName: string | null;
  language: PhotoLanguage;
}

/** The prefix every WhatsApp chat and sender alias carries (`src/identity.ts`, spec 625 "Chat ids"). */
const WHATSAPP_ALIAS_PREFIX = "wa_";

/**
 * Trip photos and moments are Telegram's (the photos spec puts WhatsApp out of scope). Read the turn's OWN platform field, never
 * `event.source.platform`: that one is stamped "telegram" on WhatsApp events (spec 625, AC-0). Anything that is not exactly
 * "telegram" - an unknown value included - is refused, and so is a turn whose chat or sender id is a WhatsApp alias.
 */
function isTelegramTurn(turn: InboundTurn): boolean {
  return turn.platform === "telegram"
    && !turn.chatId.startsWith(WHATSAPP_ALIAS_PREFIX)
    && !(turn.senderId ?? "").startsWith(WHATSAPP_ALIAS_PREFIX);
}

/** An image the relay may save: a photo, or a photo sent as a file. Never an SVG, a video or a document. */
export function isSavablePhoto(attachment: { kind: string; mime: string } | null | undefined): boolean {
  if (!attachment) return false;
  if (attachment.kind === "image") return true;
  return attachment.kind === "document" && /^image\/(?:jpeg|jpg|png|gif|webp|heic|heif)$/i.test(attachment.mime);
}

/** The draft, shown to the companion with the message that answers it (see `draftContext`). */
function draftBlock(draft: { text: string; photoIds: string[] }, minutesAgo: number): string {
  return [
    `[from the relay: a trip-moment draft you posted in this group ${minutesAgo} minute(s) ago is waiting for an answer; the message below may be it. Your trip-moments skill says what to do with a yes. Do not publish a draft that is more than a day old.]`,
    `[the draft you posted: ${JSON.stringify(draft.text)}]`,
    `[photo ids for add_moment: ${draft.photoIds.join(", ")}]`,
  ].join("\n");
}

export class TripMoments implements MomentsPort {
  readonly held: HeldPhotos;
  readonly saver: PhotoSaver;
  readonly bursts: PhotoBursts;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; ttl: number; value: MomentsConfig | null; failed: boolean }>();
  private readonly refreshing = new Map<string, Promise<MomentsConfig | null>>();
  private readonly drafts = new Map<string, Draft>();
  /** Trips whose group was told this process (the site's own flag is the durable one). */
  private readonly noticed = new Set<string>();
  private readonly dmQuestions = new Map<string, { photo: HeldPhoto; tripId: string; profile: string; at: number }>();
  private readonly turns = new Map<string, MomentTurn>();
  private readonly tokens = new Map<string, SaveToken>();

  constructor(private readonly deps: TripMomentsDeps) {
    this.now = deps.now ?? Date.now;
    this.held = new HeldPhotos(this.now);
    this.saver = new PhotoSaver({
      gateway: deps.gateway,
      fetchAttachment: deps.fetchAttachment,
      log: deps.log,
      now: this.now,
      ...(deps.autoRunSaver === false ? { autoRun: false } : {}),
      onSaved: (job, outcome) => this.photoSaved(job, outcome.photoId),
    });
    this.bursts = new PhotoBursts({
      groupContext: deps.groupContext,
      resolvePerson: (tripId, senderId) => this.person(tripId, senderId),
      flush: (burst, build) => this.flushBurst(burst, build),
      log: deps.log,
      now: this.now,
      ...(deps.quietMs !== undefined ? { quietMs: deps.quietMs } : {}),
      ...(deps.maxWaitMs !== undefined ? { maxWaitMs: deps.maxWaitMs } : {}),
    });
  }

  private async routeOf(chatId: string): Promise<{ kind: string; tripId?: string; hermesProfile?: string | null } | null> {
    try {
      return await (this.deps.routeOf ?? ((chat) => resolveChatRoute(this.deps.db, chat)))(chatId);
    } catch {
      return null;
    }
  }

  // ── Switches and settings ────────────────────────────────────────────────────

  /**
   * The trip's switches and settings, cached for a minute; null when neither switch is on (the trip behaves as it did before).
   *
   * Asked on the poll loop, so it never makes the loop wait long: a value that is a minute old is refreshed while the caller waits
   * AT MOST `CONFIG_WAIT_MS` (then the old value, or "off" if there is none, is what this message gets and the refresh finishes in
   * the background), and a trip whose site could not be read the last time is answered from what is held while it is asked again in
   * the background. A site that is down therefore costs a message at most a second and a half, once a minute, never a stall.
   */
  async config(tripId: string): Promise<MomentsConfig | null> {
    const cached = this.cache.get(tripId);
    if (cached && this.now() - cached.at < cached.ttl) return cached.value;
    const pending = this.refresh(tripId);
    if (cached?.failed) return cached.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      pending,
      new Promise<"slow">((resolve) => { timer = setTimeout(() => resolve("slow"), this.deps.configWaitMs ?? CONFIG_WAIT_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    return waited === "slow" ? cached?.value ?? null : waited;
  }

  private refresh(tripId: string): Promise<MomentsConfig | null> {
    const running = this.refreshing.get(tripId);
    if (running) return running;
    const task = this.readConfig(tripId)
      .catch((): MomentsConfig | null => null)
      .finally(() => { this.refreshing.delete(tripId); });
    this.refreshing.set(tripId, task);
    return task;
  }

  private async readConfig(tripId: string): Promise<MomentsConfig | null> {
    const read = this.deps.switchOn ?? ((trip, name) => featureEnabled(this.deps.db, trip, name, this.deps.log));
    const [photosSwitch, momentsSwitch] = await Promise.all([read(tripId, PHOTOS_SWITCH), read(tripId, MOMENTS_SWITCH)]);
    let value: MomentsConfig | null = null;
    let failed = false;
    if (photosSwitch || momentsSwitch) {
      const site = await this.deps.gateway.settings(tripId).catch(() => null);
      failed = !site;
      const language = photoLanguage(await (this.deps.languageOf ?? ((trip) => tripLanguage(this.deps.db, trip)))(tripId).catch(() => "en"));
      value = {
        photos: photosSwitch,
        // Exactly true from the control plane, from the site's own switch AND from the setting. A site that could not be read saves nothing.
        autosave: photosSwitch && site?.photosSwitch === true && site.autosave === true,
        moments: momentsSwitch && site?.momentsSwitch === true,
        mode: site?.mode ?? "organizer_draft",
        noticePending: site?.noticePending === true,
        language,
        participants: new Map((site?.participants ?? []).map((p) => [p.telegramId, p])),
      };
      if (!value.noticePending) this.noticed.delete(tripId);
    }
    this.cache.set(tripId, { at: this.now(), ttl: failed ? SETTINGS_RETRY_MS : SETTINGS_TTL_MS, value, failed });
    return value;
  }

  /**
   * Who a sender is on this trip: a participant the SITE maps by Telegram id (the one a photo is attributed by), else a person
   * the control plane itself knows (the organizer's own link). Null is nobody: a guest, or someone removed. Names come back in
   * the trip's language, for quoting by first name.
   */
  private async person(tripId: string, senderId: string): Promise<TripPerson | null> {
    const cfg = await this.config(tripId);
    const site = cfg?.participants.get(senderId);
    if (site) return { username: site.username, displayName: (cfg?.language === "he" ? site.name ?? site.nameEn : site.nameEn ?? site.name) ?? null };
    const known = await this.deps.resolvePerson(tripId, senderId).catch(() => null);
    return known ? { username: known.username, displayName: known.displayName } : null;
  }

  // ── The gate's questions ─────────────────────────────────────────────────────

  async unaddressed(turn: InboundTurn, route: RoutedCompanionRoute): Promise<{ reply?: string }> {
    // Telegram only (#670). Refused exactly as an absent port is: no hold, no fetch, no save, no notice.
    if (!isTelegramTurn(turn)) return {};
    if (turn.chatType === "dm") return {};
    const cfg = await this.config(route.tripId);
    if (!cfg) return {};
    if (cfg.photos && isSavablePhoto(turn.attachment)) this.notePhoto(turn, route, cfg, "auto");
    // L2: said once, to the group, when automatic saving is on and the group has not been told. The site holds the durable flag;
    // this process remembers having said it so an acknowledgement that fails does not say it again on the next message.
    if (cfg.autosave && cfg.noticePending && !this.noticed.has(route.tripId)) {
      this.noticed.add(route.tripId);
      void this.deps.gateway.ackNotice(route.tripId).then((ok) => {
        if (!ok) this.deps.log(structuredLog("warn", "relay.photo_notice_ack_failed", {}));
      }).catch(() => {});
      return { reply: photoText("autosaveNotice", cfg.language) };
    }
    return {};
  }

  async addressed(turn: InboundTurn, route: RoutedCompanionRoute, how: { explicit: boolean }): Promise<{ reply: string } | { context: string } | null> {
    // Telegram only (#670): null is what the gate gets from a port that is absent.
    if (!isTelegramTurn(turn)) return null;
    const cfg = await this.config(route.tripId);
    if (!cfg || !cfg.photos) return null;
    const senderId = turn.senderId;
    const plain = plainRequestText(turn.text, route.assistantNames);

    if (turn.chatType === "dm") {
      const key = turn.chatId;
      const question = this.dmQuestions.get(key);
      const live = question && this.now() - question.at < DM_QUESTION_TTL_MS ? question : null;
      if (question) this.dmQuestions.delete(key);
      if (live && !turn.attachment) {
        if (isYes(plain)) {
          this.queue(live.photo, { tripId: live.tripId, profile: live.profile }, "requested");
          return { reply: savingText(1, cfg.language) };
        }
        if (isNo(plain)) return { reply: photoText("declinedDm", cfg.language) };
        // Anything else is not an answer: the question is dropped and the message goes where it always went.
        return null;
      }
      // Only a real photo (not a document) in a private chat: a file sent to the companion keeps going to the companion.
      if (turn.attachment?.kind === "image" && senderId && (await this.person(route.tripId, senderId))) {
        const photo = this.heldFrom(turn, route);
        if (!photo) return null;
        if (parseSaveRequest(plain) === "this") {
          this.queue(photo, route, "requested");
          return { reply: savingText(1, cfg.language) };
        }
        if (!plain) {
          this.dmQuestions.set(key, { photo, tripId: route.tripId, profile: route.hermesProfile, at: this.now() });
          return { reply: photoText("askDm", cfg.language) };
        }
      }
      return null;
    }

    // A group. An addressed photo is a photo posted in the group like any other: kept, and saved when automatic saving is on.
    if (isSavablePhoto(turn.attachment)) this.notePhoto(turn, route, cfg, "auto");
    if (!how.explicit) return null;
    const request = parseSaveRequest(plain);
    // Not a request the relay knows. If the companion has a draft waiting for an answer in this group, this message may be the
    // answer ("yes", "change the title to ..."), and the answer arrives under the SENDER's session, which never saw the draft: so
    // it is shown the draft with the message. Nothing else about the turn changes.
    if (!request) {
      const context = this.draftContext(turn);
      return context ? { context } : null;
    }
    // Only someone the trip knows may ask the relay to save; anyone else's words go to the companion, which has its own rules.
    if (!senderId || !(await this.person(route.tripId, senderId))) return null;

    if (request === "this") {
      // "save this" written AS the caption of a photo is about that photo; otherwise it is about the photo it replies to.
      const own = isSavablePhoto(turn.attachment) ? this.heldFrom(turn, route) : null;
      const target = own ?? this.replyTarget(turn, route);
      if (target === "none") return null; // "save this" about words, not a photo: the companion's
      if (target === "too_old") return { reply: photoText("windowPast", cfg.language) };
      return this.requestSave([target], route, cfg.language);
    }
    const recent = this.held.recent(turn.chatId);
    if (recent.length === 0) return { reply: photoText("windowEmpty", cfg.language) };
    return this.requestSave(recent, route, cfg.language);
  }

  /** The photo a "save this" replies to: the held one, or the one the reply carries while it is inside the window. */
  private replyTarget(turn: InboundTurn, route: RoutedCompanionRoute): HeldPhoto | "none" | "too_old" {
    const replied = turn.repliedToAttachment;
    if (!turn.replyToMessageId || !replied || !isSavablePhoto(replied)) return "none";
    const known = this.held.find(turn.chatId, turn.replyToMessageId);
    if (known) return this.held.withinWindow(known.sentAtMs) ? known : "too_old";
    if (turn.repliedToSentAtMs === undefined || !this.held.withinWindow(turn.repliedToSentAtMs)) return "too_old";
    const photo: HeldPhoto = {
      chatId: turn.chatId,
      messageId: turn.replyToMessageId,
      fileId: replied.fileId,
      kind: replied.kind,
      mime: replied.mime,
      senderId: turn.repliedToSenderId ?? null,
      group: true,
      sentAtMs: turn.repliedToSentAtMs,
    };
    this.held.note(photo);
    void route;
    return photo;
  }

  private requestSave(photos: HeldPhoto[], route: RoutedCompanionRoute, language: PhotoLanguage): { reply: string } {
    const wanted = photos.filter((photo) => !photo.photoId && !this.saver.has(photo.chatId, photo.messageId));
    if (wanted.length === 0) return { reply: photoText("alreadySaved", language) };
    for (const photo of wanted) this.queue(photo, route, "requested");
    return { reply: savingText(wanted.length, language) };
  }

  // ── Holding and saving ───────────────────────────────────────────────────────

  private heldFrom(turn: InboundTurn, route: RoutedCompanionRoute): HeldPhoto | null {
    const attachment = turn.attachment;
    if (!attachment || !turn.messageId) return null;
    const photo: HeldPhoto = {
      chatId: turn.chatId,
      messageId: turn.messageId,
      fileId: attachment.fileId,
      kind: attachment.kind,
      mime: attachment.mime,
      senderId: turn.senderId,
      group: turn.chatType !== "dm",
      sentAtMs: turn.sentAtMs ?? this.now(),
    };
    void route;
    return photo;
  }

  private notePhoto(turn: InboundTurn, route: RoutedCompanionRoute, cfg: MomentsConfig, mode: "auto" | "requested"): void {
    const photo = this.heldFrom(turn, route);
    if (!photo) return;
    this.held.note(photo);
    if (cfg.autosave && mode === "auto") this.queue(photo, route, "auto");
  }

  private queue(photo: HeldPhoto, route: { tripId: string; profile?: string; hermesProfile?: string }, mode: "auto" | "requested"): void {
    this.held.note(photo);
    this.saver.enqueue({
      tripId: route.tripId,
      profile: route.profile ?? route.hermesProfile ?? "",
      chatId: photo.chatId,
      messageId: photo.messageId,
      fileId: photo.fileId,
      mime: photo.mime,
      sender: photo.senderId,
      group: photo.group,
      sentAtMs: photo.sentAtMs,
      mode,
    });
  }

  private async photoSaved(job: SaveJob, photoId: string): Promise<void> {
    this.held.markSaved(job.chatId, job.messageId, photoId);
    const cfg = await this.config(job.tripId);
    // A burst is for a moment, and a moment needs its own switch.
    if (!cfg?.moments || !job.profile || !job.group) return;
    this.bursts.add(job.chatId, job.tripId, job.profile, { photoId, senderId: job.sender, sentAtMs: job.sentAtMs });
  }

  // ── The moment turn ──────────────────────────────────────────────────────────

  /** Called on the relay's own beat. Sends the moment turn of every burst that has been quiet long enough. */
  async tick(): Promise<void> {
    this.prune();
    await this.bursts.flushDue();
  }

  private async flushBurst(burst: Burst, build: (mode: MomentMode) => Promise<WireMessageEvent>): Promise<void> {
    const cfg = await this.config(burst.tripId);
    // The switch or the site's choice changed while the burst was open: no turn, and nothing said anywhere.
    if (!cfg?.moments) {
      this.deps.log(structuredLog("info", "relay.moment_turn_skipped", { reason: "MOMENTS_OFF" }));
      return;
    }
    const route = await this.routeOf(burst.chatId);
    if (route?.kind !== "companion" || route.tripId !== burst.tripId || !route.hermesProfile) {
      this.deps.log(structuredLog("info", "relay.moment_turn_skipped", { reason: "CHAT_NOT_ROUTED_TO_TRIP" }));
      return;
    }
    const event = await build(cfg.mode);
    event.source.profile = route.hermesProfile;
    const turnId = event.message_id ?? "";
    this.turns.set(turnId, { chatId: burst.chatId, tripId: burst.tripId, profile: route.hermesProfile, mode: cfg.mode, language: cfg.language, photoIds: burst.photos.map((photo) => photo.photoId), sends: 0, at: this.now() });
    // Pushed directly, not as a decision the poller applies: a turn nobody asked for must never answer "the assistant is down"
    // into a family's group. Not explicit, so the companion may stay silent.
    const delivered = this.deps.pushInbound(event, { explicit: false });
    this.deps.log(structuredLog(delivered ? "info" : "warn", delivered ? "relay.moment_turn_sent" : "relay.moment_turn_undelivered", {
      photos: burst.photos.length,
      mode: cfg.mode,
    }));
    if (!delivered) this.turns.delete(turnId);
  }

  /**
   * What the companion may say to `chatId` right now, given the moment turn it was last handed there. Asked by the connector for
   * every send; for anything that is not tied to a moment turn the answer is `deliver` and nothing changes.
   *
   * TIED means the send's own `reply_to` names a moment turn. A send that names ANOTHER message is somebody else's answer and is
   * delivered, whatever just happened in the chat. Only a send that names nothing is tied to the latest turn forwarded to the chat,
   * and only for `UNNAMED_REPLY_MS` after a moment turn: a companion that does not echo `reply_to` still answers its turn at once.
   * Everything held back is logged by the connector.
   */
  guard(chatId: string, replyTo: string | undefined, latestTurnId: string | undefined, content = ""): GuardVerdict {
    let id: string | undefined;
    if (replyTo) id = this.turns.has(replyTo) ? replyTo : undefined;
    else if (latestTurnId && this.turns.has(latestTurnId)) id = latestTurnId;
    const turn = id ? this.turns.get(id) : undefined;
    if (!turn || turn.chatId !== chatId || this.now() - turn.at > TURN_GUARD_MS) return { kind: "deliver" };
    if (!replyTo && this.now() - turn.at > UNNAMED_REPLY_MS) return { kind: "deliver" };
    if (turn.mode !== "ask_in_chat") return { kind: "suppress", reason: `MODE_${turn.mode.toUpperCase()}_POSTS_NOTHING` };
    if (turn.sends > 0) return { kind: "suppress", reason: "ONE_DRAFT_PER_BURST" };
    turn.sends += 1;
    const token = randomBytes(8).toString("hex");
    this.tokens.set(token, { chatId, tripId: turn.tripId, profile: turn.profile, language: turn.language, expiresAt: this.now() + DRAFT_TTL_MS, used: false });
    while (this.tokens.size > TOKENS_MAX) {
      const oldest = this.tokens.keys().next();
      if (oldest.done) break;
      this.tokens.delete(oldest.value);
    }
    const draft: Draft = { token, tripId: turn.tripId, text: content.slice(0, DRAFT_TEXT_MAX), photoIds: turn.photoIds, at: this.now() };
    this.drafts.set(chatId, draft);
    return {
      kind: "deliver",
      replyMarkup: { inline_keyboard: [[{ text: photoText("saveButton", turn.language), callback_data: `mom:s:${token}` }]] },
      sent: (messageId) => { draft.messageId = messageId; },
    };
  }

  /**
   * The draft this chat's companion is waiting on, as a block to show it with the next message that could be its answer: the
   * draft's words and its photo ids. The answer comes from a person, under that person's session with the companion, which never
   * held the draft (the moment turn belongs to the relay, not to anyone); this is how it knows what "yes" is about.
   */
  private draftContext(turn: InboundTurn): string | null {
    const draft = this.drafts.get(turn.chatId);
    if (!draft) return null;
    const token = this.tokens.get(draft.token);
    const age = this.now() - draft.at;
    if (!token || token.used || age > DRAFT_TTL_MS) return null;
    const repliesToDraft = Boolean(draft.messageId) && turn.replyToMessageId === draft.messageId;
    if (!repliesToDraft && age > DRAFT_CONTEXT_MS) return null;
    return draftBlock(draft, Math.round(age / 60_000));
  }

  /**
   * A tap on a draft's Save button. The word of a person on the trip, same as typing "yes": it goes to the companion as a turn from
   * the tapper, and the companion publishes. The relay publishes nothing itself. Single use; a draft waits a day.
   */
  async onSaveTap(tap: SaveTap): Promise<{ text: string }> {
    const { language } = tap;
    // Telegram only (#670): a WhatsApp chat is never given a Save button, and an alias chat id is refused here too.
    if (tap.chatId.startsWith(WHATSAPP_ALIAS_PREFIX)) return { text: photoText("tapUnavailable", language) };
    const token = this.tokens.get(tap.token);
    if (!token || token.chatId !== tap.chatId || token.used || this.now() > token.expiresAt) {
      return { text: photoText("tapExpired", language) };
    }
    const cfg = await this.config(token.tripId);
    if (!cfg?.moments) return { text: photoText("tapUnavailable", language) };
    const person = await this.person(token.tripId, tap.fromId);
    if (!person) return { text: photoText("tapNotMember", language) };
    const route = await this.routeOf(tap.chatId);
    if (route?.kind !== "companion" || route.tripId !== token.tripId || !route.hermesProfile) return { text: photoText("tapUnavailable", language) };
    token.used = true;
    const draft = this.drafts.get(tap.chatId);
    const block = draft && draft.token === tap.token ? `\n\n${draftBlock(draft, Math.round((this.now() - draft.at) / 60_000))}` : "";
    const name = person.displayName ?? tap.fromName ?? person.username;
    const event: WireMessageEvent = {
      text: `${addressedMark(this.deps.botUsername?.())}\n\n[${name} tapped Save on your draft moment — read it as "yes, save it"]${block}`,
      message_type: "text",
      message_id: `ksave-${token.expiresAt.toString(36)}`,
      source: {
        platform: "telegram",
        chat_id: tap.chatId,
        chat_type: "group",
        chat_name: null,
        user_id: tap.fromId,
        user_name: name,
        thread_id: null,
        chat_topic: null,
        profile: route.hermesProfile,
      },
    };
    const delivered = this.deps.pushInbound(event, { explicit: true });
    if (!delivered) {
      token.used = false;
      return { text: photoText("tapUnavailable", language) };
    }
    return { text: photoText("tapSaved", language) };
  }

  /** The group moved to another trip: what was held for the old one is not the new one's. */
  clearChat(chatId: string): void {
    this.held.clearChat(chatId);
    this.saver.clearChat(chatId);
    this.bursts.clearChat(chatId);
    this.dmQuestions.delete(chatId);
  }

  stop(): void {
    this.saver.stop();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, turn] of this.turns) if (now - turn.at > TURN_GUARD_MS) this.turns.delete(id);
    while (this.turns.size > TURNS_MAX) {
      const oldest = this.turns.keys().next();
      if (oldest.done) break;
      this.turns.delete(oldest.value);
    }
    for (const [key, token] of this.tokens) if (now > token.expiresAt) this.tokens.delete(key);
    for (const [key, question] of this.dmQuestions) if (now - question.at > DM_QUESTION_TTL_MS) this.dmQuestions.delete(key);
  }
}
