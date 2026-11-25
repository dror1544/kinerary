/**
 * Saving a group photo to the trip's album, off the poll loop (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B;
 * AC-8 and AC-15).
 *
 * The gate decides a photo is to be saved and calls `enqueue`; it never downloads or uploads, because the poll loop is the one
 * consumer of the bot's update stream and an upload is seconds. The saver does the download (the platform's own file, by
 * reference) and the post through the gateway, one photo at a time, on its own chain.
 *
 * BOUNDED, ON PURPOSE (AC-15). A failed save is retried only while the photo is still inside the media TTL of its own sent time
 * (`MEDIA_TTL_MS`, the same hour every other re-host in this relay lives by) and only while the site is unreachable, a 5xx, or the
 * download failed. After that, or on a refusal (the site said no; asking again cannot change it), the loss is logged and the
 * job is gone. The queue holds REFERENCES, never bytes, and has a count cap: a site that is down all day costs a log line per
 * lost photo and a bounded list, never memory. Nothing is ever parked for later.
 *
 * Each save is idempotent on the site (chat id + message id), so a timeout followed by a retry cannot save a photo twice.
 */
import { structuredLog } from "../redaction.js";
import { MEDIA_TTL_MS } from "./media-store.js";
import type { PhotoToSave, SaveOutcome, TripPhotoGateway } from "./trip-photo-gateway.js";

/** Telegram's own download limit for a bot; a photo larger than this is not fetchable at all. */
export const PHOTO_MAX_BYTES = 20 * 1024 * 1024;
export const SAVER_QUEUE_MAX = 200;
export const SAVER_RETRY_BASE_MS = 30_000;
export const SAVER_RETRY_MAX_MS = 10 * 60_000;

export interface SaveJob {
  tripId: string;
  /** The companion's profile for the chat when the photo was seen (what a moment turn for it is stamped with). */
  profile: string;
  /** Posted in a group. A photo saved from a private chat never joins a burst: a moment turn is for a group. */
  group: boolean;
  chatId: string;
  messageId: string;
  /** The platform's file id: what to download. */
  fileId: string;
  mime: string;
  sender: string | null;
  sentAtMs: number;
  mode: "auto" | "requested";
}

interface QueuedJob extends SaveJob {
  attempts: number;
  nextAt: number;
}

export interface PhotoSaverDeps {
  gateway: TripPhotoGateway;
  fetchAttachment(fileId: string, maxBytes: number): Promise<{ bytes: Buffer; mime?: string } | null>;
  /** Called once per photo that the site now has (saved or already there). */
  onSaved(job: SaveJob, outcome: Extract<SaveOutcome, { kind: "saved" }>): void | Promise<void>;
  log: (line: string) => void;
  now?: () => number;
  /**
   * Run the queue on its own chain as jobs arrive and retries fall due. Tests turn this off and call `runDue()` themselves
   * with their own clock, so a retry is a line in a test and not a wait.
   */
  autoRun?: boolean;
  queueMax?: number;
}

export class PhotoSaver {
  private readonly queue: QueuedJob[] = [];
  private readonly now: () => number;
  private readonly queueMax: number;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PhotoSaverDeps) {
    this.now = deps.now ?? Date.now;
    this.queueMax = deps.queueMax ?? SAVER_QUEUE_MAX;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Whether this message is already waiting to be saved (a request for a photo that is still in the queue adds nothing). */
  has(chatId: string, messageId: string): boolean {
    return this.queue.some((job) => job.chatId === chatId && job.messageId === messageId);
  }

  /** Queue one photo. False (and a logged loss) when the queue is full: the oldest wait is never extended past the cap. */
  enqueue(job: SaveJob): boolean {
    if (this.has(job.chatId, job.messageId)) return true;
    if (this.queue.length >= this.queueMax) {
      this.deps.log(structuredLog("warn", "relay.photo_save_lost", { reason: "QUEUE_FULL", mode: job.mode }));
      return false;
    }
    this.queue.push({ ...job, attempts: 0, nextAt: this.now() });
    this.kick();
    return true;
  }

  /** Drops what a chat had waiting (the group moved to another trip: its photos are not the new trip's). */
  clearChat(chatId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) if (this.queue[i]!.chatId === chatId) this.queue.splice(i, 1);
  }

  /** Stops the retry timer (the relay is shutting down). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs every job that is due now, one after another; returns when none is. Never throws. */
  async runDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.queue.find((candidate) => candidate.nextAt <= this.now());
        if (!job) return;
        this.queue.splice(this.queue.indexOf(job), 1);
        await this.attempt(job);
      }
    } finally {
      this.running = false;
    }
  }

  private kick(): void {
    if (this.deps.autoRun === false) return;
    void this.runDue().then(() => this.arm()).catch(() => {});
  }

  private arm(): void {
    if (this.deps.autoRun === false || this.timer || this.queue.length === 0) return;
    const next = Math.min(...this.queue.map((job) => job.nextAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(1_000, next - this.now()));
    this.timer.unref?.();
  }

  private async attempt(job: QueuedJob): Promise<void> {
    const { log } = this.deps;
    const deadline = job.sentAtMs + MEDIA_TTL_MS;
    if (this.now() > deadline) {
      // Past the media TTL of its own sent time: the loss is logged and the photo is let go.
      log(structuredLog("warn", "relay.photo_save_lost", { reason: "MEDIA_TTL_PASSED", mode: job.mode, attempts: job.attempts }));
      return;
    }
    let outcome: SaveOutcome | { kind: "unreachable"; reason: string };
    try {
      const file = await this.deps.fetchAttachment(job.fileId, PHOTO_MAX_BYTES);
      if (!file) {
        outcome = { kind: "unreachable", reason: "DOWNLOAD_FAILED" };
      } else {
        const photo: PhotoToSave = {
          sender: job.sender,
          messageKey: `${job.chatId}:${job.messageId}`,
          mode: job.mode,
          sentAtMs: job.sentAtMs,
          mime: file.mime || job.mime,
          bytes: file.bytes,
        };
        outcome = await this.deps.gateway.savePhoto(job.tripId, photo);
      }
    } catch (error) {
      outcome = { kind: "unreachable", reason: error instanceof Error ? error.name : "UNKNOWN" };
    }

    if (outcome.kind === "saved") {
      log(structuredLog("info", "relay.photo_saved", { mode: job.mode, duplicate: outcome.duplicate, guest: outcome.guest, attempts: job.attempts + 1 }));
      try { await this.deps.onSaved(job, outcome); } catch { /* the photo is saved; what hangs off it must not undo that */ }
      return;
    }
    if (outcome.kind === "refused") {
      // The site said no. 401/403 here is a configuration fault (the key, the trip id): loud, once per photo, and not retried.
      log(structuredLog("warn", "relay.photo_save_refused", { mode: job.mode, status: outcome.status, error: outcome.error }));
      return;
    }
    job.attempts += 1;
    const delay = Math.min(SAVER_RETRY_BASE_MS * 2 ** (job.attempts - 1), SAVER_RETRY_MAX_MS);
    if (this.now() + delay > deadline) {
      log(structuredLog("warn", "relay.photo_save_lost", { reason: `UNREACHABLE_UNTIL_TTL:${outcome.reason}`, mode: job.mode, attempts: job.attempts }));
      return;
    }
    job.nextAt = this.now() + delay;
    this.queue.push(job);
    log(structuredLog("info", "relay.photo_save_retry", { reason: outcome.reason, attempts: job.attempts, in_ms: delay }));
    this.arm();
  }
}
