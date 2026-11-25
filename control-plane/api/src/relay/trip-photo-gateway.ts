/**
 * The relay's way to a trip's site for photos (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B): through the runtime
 * gateway, which reaches the trip with the trip's OWN key (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, K2). The relay
 * holds the control-plane exchange key, as the portal and the group-line poller do, sends it to the gateway's origin and nowhere
 * else, and never sees a trip's key. It never names a username: it sends the sender's Telegram id and the site maps it.
 *
 *   POST <runtimeOrigin>/internal/t/<trip>/photos         one photo (bytes in base64, JSON)
 *   GET  <runtimeOrigin>/internal/t/<trip>/photo-settings the two organizer settings and whether the group was told
 *   POST <runtimeOrigin>/internal/t/<trip>/photo-notice   the group was told
 *
 * Every answer is classified, never thrown: a photo save is `saved`, `refused` (the site said no; retrying cannot change it) or
 * `unreachable` (a network failure, a timeout or a 5xx; retrying may). That split is what keeps the retry bounded and honest.
 */
import { structuredLog } from "../redaction.js";

export type MomentMode = "ask_in_chat" | "organizer_draft" | "publish";

/** A participant as the SITE maps them by Telegram id: the one definition of "someone on the trip" a photo is attributed by. */
export interface SiteParticipant {
  telegramId: string;
  username: string;
  name: string | null;
  nameEn: string | null;
}

/** What the site says about this trip's photos. Anything not exactly `true` reads as false; an unknown mode as organizer_draft. */
export interface SitePhotoSettings {
  photosSwitch: boolean;
  momentsSwitch: boolean;
  autosave: boolean;
  mode: MomentMode;
  noticePending: boolean;
  participants: SiteParticipant[];
}

export interface PhotoToSave {
  /** The sender's platform id (a Telegram user id), or null when the platform did not say. */
  sender: string | null;
  /** Chat id and message id: the site's idempotency key. */
  messageKey: string;
  /** `auto` is automatic saving; `requested` is somebody asking. The site enforces the setting against `auto`. */
  mode: "auto" | "requested";
  sentAtMs: number;
  mime: string;
  bytes: Buffer;
}

export type SaveOutcome =
  | { kind: "saved"; photoId: string; duplicate: boolean; guest: boolean }
  | { kind: "refused"; status: number; error: string }
  | { kind: "unreachable"; reason: string };

export interface TripPhotoGateway {
  settings(tripId: string): Promise<SitePhotoSettings | null>;
  savePhoto(tripId: string, photo: PhotoToSave): Promise<SaveOutcome>;
  ackNotice(tripId: string): Promise<boolean>;
}

const SETTINGS_TIMEOUT_MS = 5_000;
const SAVE_TIMEOUT_MS = 30_000;
const ANSWER_MAX_BYTES = 64 * 1024;

export interface HttpTripPhotoGatewayOptions {
  runtimeOrigin: string;
  exchangeKey: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

function readParticipants(value: unknown): SiteParticipant[] {
  if (!Array.isArray(value)) return [];
  const out: SiteParticipant[] = [];
  for (const entry of value.slice(0, 200)) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.telegram_id !== "string" || !/^\d{1,20}$/.test(row.telegram_id) || typeof row.username !== "string" || !row.username) continue;
    out.push({
      telegramId: row.telegram_id,
      username: row.username.slice(0, 64),
      name: typeof row.name === "string" ? row.name.slice(0, 80) : null,
      nameEn: typeof row.name_en === "string" ? row.name_en.slice(0, 80) : null,
    });
  }
  return out;
}

export class HttpTripPhotoGateway implements TripPhotoGateway {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(private readonly options: HttpTripPhotoGatewayOptions) {
    this.origin = options.runtimeOrigin.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
  }

  private url(tripId: string, route: string): string {
    return `${this.origin}/internal/t/${encodeURIComponent(tripId)}/${route}`;
  }

  /** One request, answer read no further than a small cap. A redirect is never followed: the key rides this request. */
  private async call(tripId: string, route: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number }): Promise<
    { ok: true; status: number; json: unknown } | { ok: false; unreachable: true; reason: string }
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(tripId, route), {
        method: init.method,
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs),
        headers: {
          "x-api-key": this.options.exchangeKey,
          accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      return { ok: false, unreachable: true, reason: error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK" };
    }
    let text = "";
    try {
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > ANSWER_MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
      } else {
        text = (await response.text()).slice(0, ANSWER_MAX_BYTES);
      }
    } catch {
      return { ok: false, unreachable: true, reason: "NETWORK" };
    }
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON answer is read by its status alone */ }
    if (response.status >= 300 && response.status < 400) return { ok: true, status: 502, json: { error: "UPSTREAM_REDIRECT" } };
    return { ok: true, status: response.status, json };
  }

  async settings(tripId: string): Promise<SitePhotoSettings | null> {
    const answer = await this.call(tripId, "photo-settings", { method: "GET", timeoutMs: SETTINGS_TIMEOUT_MS });
    if (!answer.ok || answer.status !== 200 || typeof answer.json !== "object" || answer.json === null) {
      this.log(structuredLog("warn", "relay.photo_settings_unreadable", { reason: answer.ok ? `HTTP_${answer.status}` : answer.reason }));
      return null;
    }
    const body = answer.json as Record<string, unknown>;
    const mode = body.moment_capture_mode;
    return {
      photosSwitch: body.chat_photos_to_album === true,
      momentsSwitch: body.trip_moments_capture === true,
      // The setting reads as ON only when the site says exactly true: a body that does not say is "do not save".
      autosave: body.group_photo_autosave === true,
      // The most restrictive mode for anything unrecognised (the site's own rule): nothing reaches the chat or the site unreviewed.
      mode: mode === "ask_in_chat" || mode === "publish" || mode === "organizer_draft" ? mode : "organizer_draft",
      noticePending: body.autosave_notice_pending === true,
      participants: readParticipants(body.participants),
    };
  }

  async savePhoto(tripId: string, photo: PhotoToSave): Promise<SaveOutcome> {
    const answer = await this.call(tripId, "photos", {
      method: "POST",
      timeoutMs: SAVE_TIMEOUT_MS,
      body: {
        tripId,
        sender: photo.sender,
        messageKey: photo.messageKey,
        mode: photo.mode,
        sentAt: new Date(photo.sentAtMs).toISOString(),
        mime: photo.mime,
        data: photo.bytes.toString("base64"),
      },
    });
    if (!answer.ok) return { kind: "unreachable", reason: answer.reason };
    const body = (typeof answer.json === "object" && answer.json !== null ? answer.json : {}) as Record<string, unknown>;
    if (answer.status === 200 && body.ok === true) {
      const saved = (typeof body.photo === "object" && body.photo !== null ? body.photo : {}) as Record<string, unknown>;
      if (typeof saved.id === "string" && saved.id) {
        return { kind: "saved", photoId: saved.id, duplicate: body.duplicate === true, guest: saved.guest === true };
      }
      return { kind: "refused", status: 200, error: "ANSWER_HAS_NO_PHOTO_ID" };
    }
    // A server fault, the gateway's 502/503/504 or its timeout: the site may be back in a minute.
    if (answer.status >= 500 || answer.status === 408 || answer.status === 429) return { kind: "unreachable", reason: `HTTP_${answer.status}` };
    const error = typeof body.error === "string" ? body.error.slice(0, 60) : `HTTP_${answer.status}`;
    return { kind: "refused", status: answer.status, error };
  }

  async ackNotice(tripId: string): Promise<boolean> {
    const answer = await this.call(tripId, "photo-notice", { method: "POST", timeoutMs: SETTINGS_TIMEOUT_MS, body: { tripId } });
    return answer.ok && answer.status === 200;
  }
}
