/**
 * The relay's assistant-event emitter (#177).
 *
 * Three properties, each of which is a test:
 *
 *   1. **Off unless configured.** `ASSISTANT_EVENTS_ENABLED=1` turns it on;
 *      unset, empty, or anything else is OFF. This is deliberately the
 *      OPPOSITE of the `INTERPRET_*` flags in CLAUDE.md, where unset is a
 *      downgrade to be avoided. Here unset is the safe state: the code can
 *      ship to a deployment — a sprint-end upgrade included — without
 *      switching on the recording of when a family talks among themselves.
 *      Do not "fix" this into default-on. Turning it on anywhere real waits
 *      on retention being scheduled and on the family-notice step (#177's
 *      carry-forward).
 *
 *   2. **Fail open, off the decision path.** Every method the relay calls is
 *      synchronous, returns nothing to await, and never throws: it appends to
 *      a bounded in-memory queue and returns. A timer flushes the queue to the
 *      sink, one write at a time, each bounded by a timeout — and a write
 *      abandoned at its timeout still counts as the one write until it
 *      settles, so a hung database costs at most one pool connection, never a
 *      pile of them. A sink that throws, hangs or is slow costs dropped events
 *      — counted, and logged at most once a minute — never a delayed or
 *      missing reply (design §12). A log function that throws is swallowed.
 *
 *   3. **Nothing identifying leaves this module.** The relay hands over a chat
 *      id as a key so a reply can be matched to the request it answers; that
 *      key lives in memory maps here and is never a field of an event. What is
 *      queued is built field by field from the contract's closed vocabulary.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { structuredLog } from "../redaction.js";
import {
  boundedCount,
  lengthBucketOf,
  MAX_LATENCY_MS,
  validateAssistantEvent,
  type AssistantEvent,
  type EventMetadata,
  type EventType,
  type Outcome,
} from "./contract.js";
import type { InboundFacts } from "./relay-facts.js";
import { writeAssistantEvents, type WriteResult } from "./store.js";

/** Where flushed batches go. The database in production; anything in a test. */
export interface AssistantEventSink {
  write(events: AssistantEvent[]): Promise<unknown>;
}

/** What a companion reply looked like to the connector, and nothing more. */
export type ReplyDelivery = "delivered" | "failed" | "suppressed";

/**
 * The connector's view of the emitter: one synchronous call per companion
 * `send`, after Telegram has answered. Exported separately so the connector
 * depends on this, not on the class.
 */
export interface ReplyObserver {
  replySent(chatKey: string, delivery: ReplyDelivery, contentLength: number, replyTo?: string): void;
}

/** A request the relay handles itself; handed back when its tool finishes. */
export interface RelayTurn {
  turnId: string;
  at: number;
  facts: InboundFacts;
}

/** The substantive outcomes of the relay's own document read. */
export type RelayToolOutcome = Extract<Outcome, "failed_tool" | "blocked_by_policy" | "correction_proposed" | "no_new_information">;

export interface AssistantEventsOptions {
  sink: AssistantEventSink;
  log?: (line: string) => void;
  /** Milliseconds since the epoch. Injectable so a replay's latencies are exact. */
  now?: () => number;
  newId?: () => string;
  /** Events held while the sink is slow. Beyond this they are dropped and counted. */
  queueLimit?: number;
  batchSize?: number;
  /** 0 disables the timer; the caller flushes. */
  flushIntervalMs?: number;
  writeTimeoutMs?: number;
  /** An unanswered turn is forgotten after this; the table already shows it unanswered. */
  openTurnTtlMs?: number;
  /** Later messages of one multi-message answer are attributed to it within this window. */
  continuationMs?: number;
  /** Chats tracked for reply attribution. Oldest forgotten first. */
  maxChats?: number;
  maxOpenTurnsPerChat?: number;
}

export interface AssistantEventsStats {
  queued: number;
  /** Events lost to a full queue, a failed or timed-out write, or an emitter fault. */
  dropped: number;
  written: number;
  /** Refused by the contract — at enqueue or by the writer. A bug, not a load problem. */
  rejected: number;
  /** Delivered companion messages to a chat with no known trip — not recorded. */
  unattributedReplies: number;
  /** Sink writes ever started. */
  writesStarted: number;
  /** Whether a sink write — possibly one already abandoned — is still running. */
  writeOutstanding: boolean;
}

interface OpenTurn {
  turnId: string;
  at: number;
  facts: InboundFacts;
  messageId?: string;
}

interface ChatContext {
  tripId: string;
  channelType: InboundFacts["channelType"];
}

const LOG_EVERY_MS = 60_000;

export class RelayAssistantEvents implements ReplyObserver {
  private readonly sink: AssistantEventSink;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly queueLimit: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly writeTimeoutMs: number;
  private readonly openTurnTtlMs: number;
  private readonly continuationMs: number;
  private readonly maxChats: number;
  private readonly maxOpenTurnsPerChat: number;

  private readonly queue: AssistantEvent[] = [];
  private readonly openTurns = new Map<string, OpenTurn[]>();
  private readonly lastAnswered = new Map<string, { turn: OpenTurn; until: number }>();
  private readonly chats = new Map<string, ChatContext>();
  private inFlight: Promise<void> | null = null;
  /** The sink write still running, whether awaited (inFlight) or abandoned at its timeout. */
  private outstanding: Promise<void> | null = null;
  private writesStarted = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFailureLogAt = -Infinity;
  private readonly counters = { dropped: 0, written: 0, rejected: 0, unattributedReplies: 0 };

  constructor(options: AssistantEventsOptions) {
    this.sink = options.sink;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.queueLimit = options.queueLimit ?? 1_000;
    this.batchSize = options.batchSize ?? 200;
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 10_000;
    this.openTurnTtlMs = options.openTurnTtlMs ?? 30 * 60_000;
    this.continuationMs = options.continuationMs ?? 10 * 60_000;
    this.maxChats = options.maxChats ?? 1_000;
    this.maxOpenTurnsPerChat = options.maxOpenTurnsPerChat ?? 20;
  }

  get stats(): AssistantEventsStats {
    return {
      queued: this.queue.length,
      ...this.counters,
      writesStarted: this.writesStarted,
      writeOutstanding: this.outstanding !== null,
    };
  }

  // ── Inbound: called by poller.ts, synchronously, after the decision acted ──

  /**
   * A group message the relevance gate did not address to the assistant. No
   * chat key: the ignore decision carries none, and a chat that only ever
   * chatted has no request for a reply to be matched to.
   */
  notAddressed(facts: InboundFacts): void {
    this.guard(() => {
      this.enqueue("ignored_not_addressed", "ignored_not_addressed", facts, {
        metadata: facts.documentHeld ? { document_held: true } : {},
      });
    });
  }

  /**
   * A request pushed to the companion gateway — or not, when no socket took it
   * (`pushInbound` false: the turn is lost and the organizer is told so).
   */
  handedOff(chatKey: string, facts: InboundFacts, delivered: boolean, messageId?: string): void {
    this.guard(() => {
      this.rememberChat(chatKey, facts);
      if (!delivered) {
        this.enqueue("turn_lost", "lost_gateway_unavailable", facts, {});
        return;
      }
      const turn: OpenTurn = { turnId: this.newId(), at: this.now(), facts, ...(messageId ? { messageId } : {}) };
      const open = this.openTurns.get(chatKey) ?? [];
      open.push(turn);
      while (open.length > this.maxOpenTurnsPerChat) open.shift();
      this.touch(this.openTurns, chatKey, open);
      this.enqueue("request_forwarded", "dispatched", facts, {
        turnId: turn.turnId,
        metadata: {
          attachments_joined: boundedCount(facts.attachmentsJoined ?? 0),
          documents: boundedCount(facts.documents ?? 0),
        },
      });
    });
  }

  /** The chat's companion is not running, so the router answered for it. */
  companionUnreachable(chatKey: string, facts: InboundFacts): void {
    this.guard(() => {
      this.rememberChat(chatKey, facts);
      this.enqueue("turn_lost", "lost_companion_unreachable", facts, {});
    });
  }

  /** A request the relay takes itself (a document after confirmation). */
  toRelay(chatKey: string, facts: InboundFacts): RelayTurn | null {
    let turn: RelayTurn | null = null;
    this.guard(() => {
      this.rememberChat(chatKey, facts);
      turn = { turnId: this.newId(), at: this.now(), facts };
      this.enqueue("request_to_relay", "dispatched", facts, {
        turnId: turn.turnId,
        metadata: { documents: boundedCount(facts.documents ?? 0) },
      });
    });
    return turn;
  }

  /**
   * The relay's own tool finished. Here, and only here, the relay records a
   * SUBSTANTIVE outcome — it ran the read, so it knows whether the read worked.
   */
  relayToolCompleted(turn: RelayTurn | null, outcome: RelayToolOutcome, documents: number): void {
    if (!turn) return;
    this.guard(() => {
      this.enqueue("relay_tool_completed", outcome, turn.facts, {
        turnId: turn.turnId,
        latencyMs: this.now() - turn.at,
        metadata: { documents: boundedCount(documents) },
      });
    });
  }

  // ── Outbound: called by connector.ts after Telegram answered a `send` ─────

  replySent(chatKey: string, delivery: ReplyDelivery, contentLength: number, replyTo?: string): void {
    this.guard(() => {
      const now = this.now();
      const open = this.pruneOpenTurns(chatKey, now);
      const recent = this.lastAnswered.get(chatKey);
      const continuation = recent && now <= recent.until ? recent.turn : undefined;

      // Which request is this a reply to?
      //   With reply_to: the open request it names; else the request just
      //   answered, if it names that one (the rest of the same answer); else
      //   NOTHING — a reply_to naming neither is a reply to something this
      //   emitter is not tracking (an older answered turn, a pre-restart
      //   request), and claiming whichever request happens to be waiting
      //   would credit that request with an answer it never got.
      //   Without reply_to: the oldest request still waiting; else the answer
      //   still being written; else nothing — proactive.
      let turn: OpenTurn | undefined;
      let opensAnswer = false;
      if (replyTo) {
        const byReply = open.findIndex((t) => t.messageId === replyTo);
        if (byReply >= 0) {
          turn = open[byReply];
          opensAnswer = true;
        } else if (continuation?.messageId === replyTo) {
          turn = continuation;
        }
      } else if (open.length > 0) {
        turn = open[0];
        opensAnswer = true;
      } else {
        turn = continuation;
      }

      // Only a message Telegram accepted answers a request. A failed or
      // suppressed one is recorded against it and leaves it waiting.
      if (turn && opensAnswer && delivery === "delivered") {
        open.splice(open.indexOf(turn), 1);
        this.touch(this.lastAnswered, chatKey, { turn, until: now + this.continuationMs });
      }

      const context: ChatContext | undefined = turn
        ? { tripId: turn.facts.tripId, channelType: turn.facts.channelType }
        : this.chats.get(chatKey);
      if (!context) {
        if (delivery === "delivered") this.counters.unattributedReplies += 1;
        return;
      }
      this.push({
        event_id: this.newId(),
        trip_id: context.tripId,
        occurred_at: new Date(now).toISOString(),
        source_service: "relay",
        event_type: "reply_sent",
        turn_id: turn?.turnId ?? null,
        channel_type: context.channelType,
        trigger_type: turn?.facts.triggerType ?? null,
        requester_role: turn?.facts.requesterRole ?? null,
        outcome: delivery === "delivered" ? "reply_delivered" : delivery === "failed" ? "failed_delivery" : "reply_suppressed",
        response_latency_ms: turn ? clampLatency(now - turn.at) : null,
        message_length_bucket: lengthBucketOf(contentLength),
        media_kind: null,
        metadata: {},
      });
    });
  }

  // ── Flushing ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    // flush() never rejects, and the catch is belt and braces: an unhandled
    // rejection from a timer would take the relay process down.
    this.timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the timer and writes what is queued, batch by batch, within its own
   * deadline — shorter than a container's stop grace, so shutdown is never
   * held by analytics. Whatever is still queued at the deadline, or cannot be
   * written because an earlier write is still running, is counted as dropped.
   */
  async stop(deadlineMs = 2_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const end = Date.now() + deadlineMs;
    while (this.queue.length > 0 || this.inFlight) {
      const remaining = end - Date.now();
      if (remaining <= 0) break;
      if (this.inFlight) {
        await Promise.race([this.inFlight, sleep(remaining)]);
        continue;
      }
      if (this.outstanding) {
        // An abandoned write is still running. Starting another would be a
        // second connection; wait for it, within the deadline, instead.
        await Promise.race([this.outstanding, sleep(remaining)]);
        // Re-read: settling clears it (flush), which narrowing cannot see.
        if (this.stats.writeOutstanding) break;
        continue;
      }
      await this.flush(Math.min(this.writeTimeoutMs, remaining));
    }
    if (this.queue.length > 0) {
      const left = this.queue.length;
      this.queue.length = 0;
      this.drop(left, "STOP_DEADLINE");
    }
  }

  /**
   * Writes one batch.
   *
   * AT MOST ONE WRITE EXISTS AT A TIME — including one this emitter has
   * already given up on. A write that outlives its timeout is abandoned (its
   * events counted as dropped) but it is still running against the sink,
   * holding whatever it holds — on the database sink, a pool connection shared
   * with the relay's routing. So no new write starts until it settles; the
   * queue fills and drops instead, which is the cost this design chooses over
   * a pile-up of hung connections. (If an abandoned write lands after all, the
   * writer's idempotency on event_id means nothing is double-counted.)
   *
   * Never rejects.
   */
  flush(timeoutMs: number = this.writeTimeoutMs): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.outstanding) return Promise.resolve();
    if (this.queue.length === 0) return Promise.resolve();
    const batch = this.queue.splice(0, this.batchSize);
    const written = Promise.resolve().then(() => this.sink.write(batch));
    const settled: Promise<void> = written.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      if (this.outstanding === settled) this.outstanding = null;
    });
    this.outstanding = settled;
    this.writesStarted += 1;
    this.inFlight = (async () => {
      try {
        const result = await withTimeout(written, timeoutMs);
        const outcome = result as Partial<WriteResult> | undefined;
        if (outcome && typeof outcome.inserted === "number") {
          this.counters.written += outcome.inserted;
          this.counters.rejected += outcome.rejected?.length ?? 0;
          if ((outcome.rejected?.length ?? 0) > 0) {
            this.safeLog(structuredLog("warn", "relay.assistant_events_rejected", {
              rejected: outcome.rejected!.length,
              reasons: [...new Set(outcome.rejected!.map((r) => r.reason))].join(","),
            }));
          }
        } else {
          this.counters.written += batch.length;
        }
      } catch (error) {
        this.drop(batch.length, error instanceof TimeoutError ? "WRITE_TIMEOUT" : safeErrorCode(error));
      } finally {
        this.inFlight = null;
      }
    })().catch(() => {});
    return this.inFlight;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private enqueue(
    type: EventType,
    outcome: Outcome,
    facts: InboundFacts,
    extra: { turnId?: string; latencyMs?: number; metadata?: EventMetadata },
  ): void {
    this.push({
      event_id: this.newId(),
      trip_id: facts.tripId,
      occurred_at: new Date(this.now()).toISOString(),
      source_service: "relay",
      event_type: type,
      turn_id: extra.turnId ?? null,
      channel_type: facts.channelType,
      trigger_type: facts.triggerType,
      requester_role: facts.requesterRole,
      outcome,
      response_latency_ms: extra.latencyMs === undefined ? null : clampLatency(extra.latencyMs),
      message_length_bucket: facts.lengthBucket,
      media_kind: facts.mediaKind,
      metadata: extra.metadata ?? {},
    });
  }

  /** Validated before it is queued, so a malformed event is a logged bug here, not a failed batch later. */
  private push(event: AssistantEvent): void {
    const checked = validateAssistantEvent(event);
    if (!checked.ok) {
      this.counters.rejected += 1;
      this.safeLog(structuredLog("error", "relay.assistant_event_invalid", { reason: checked.reason }));
      return;
    }
    if (this.queue.length >= this.queueLimit) {
      this.drop(1, "QUEUE_FULL");
      return;
    }
    this.queue.push(checked.event);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.drop(1, safeErrorCode(error));
    }
  }

  private drop(count: number, reason: string): void {
    this.counters.dropped += count;
    const now = Date.now();
    if (now - this.lastFailureLogAt < LOG_EVERY_MS) return;
    this.lastFailureLogAt = now;
    this.safeLog(structuredLog("warn", "relay.assistant_events_dropped", {
      safe_error_code: reason,
      dropped_total: this.counters.dropped,
      queued: this.queue.length,
    }));
  }

  /** A log sink that throws must not turn into an exception on the relay's path, or an unhandled rejection. */
  private safeLog(line: string): void {
    try {
      this.log(line);
    } catch {
      // Nothing to do: the one place to report this is the thing that failed.
    }
  }

  private rememberChat(chatKey: string, facts: InboundFacts): void {
    this.touch(this.chats, chatKey, { tripId: facts.tripId, channelType: facts.channelType });
  }

  /**
   * The chat's open requests, expired ones removed — returned as THE stored
   * array, because the caller removes the request it answers from it. (Until
   * the rework round this returned a filtered copy, so an answered request
   * was never removed and stayed "the oldest waiting".)
   */
  private pruneOpenTurns(chatKey: string, now: number): OpenTurn[] {
    const open = this.openTurns.get(chatKey);
    if (!open) return [];
    const live = open.filter((t) => now - t.at <= this.openTurnTtlMs);
    this.openTurns.set(chatKey, live);
    return live;
  }

  /** Map insert that keeps recency order and forgets the least recent past the bound. */
  private touch<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.maxChats) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

/**
 * An error's class name, if it looks like one — never its message, which is
 * where a driver quotes the value it choked on.
 */
function safeErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "UNKNOWN";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function clampLatency(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), MAX_LATENCY_MS);
}

class TimeoutError extends Error {
  constructor() {
    super("assistant event write timed out");
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // NOT unref'd: a hung write must still time out when nothing else keeps
    // the event loop alive, or the batch is neither written nor counted.
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── Configuration ────────────────────────────────────────────────────────────

/** The one setting. Generic on purpose: it names no host, path or deployment. */
export const ASSISTANT_EVENTS_SETTING = "ASSISTANT_EVENTS_ENABLED";

/**
 * Whether assistant events are on. ONLY `1` enables them (surrounding
 * whitespace is ignored, as a hand-edited env file tends to carry some).
 *
 * Unset is OFF — the safe direction, and the opposite of `INTERPRET_*`. Any
 * other value is also off, and says so: a typo in the enabling direction
 * should be visible, not a silent no-op.
 */
export function assistantEventsSetting(env: NodeJS.ProcessEnv): { enabled: boolean; unrecognized: boolean } {
  const raw = (env[ASSISTANT_EVENTS_SETTING] ?? "").trim();
  if (raw === "1") return { enabled: true, unrecognized: false };
  const knownOff = raw === "" || raw === "0";
  return { enabled: false, unrecognized: !knownOff };
}

/** The production sink: the relay's own database. */
export function databaseEventSink(db: pg.Pool): AssistantEventSink {
  return { write: (events) => writeAssistantEvents(db, events) };
}

/**
 * The emitter the relay should run with, or `undefined` — the normal case.
 * Always logs which state it chose, so the relay's boot log says whether this
 * process records anything.
 */
export function assistantEventsFromEnv(
  env: NodeJS.ProcessEnv,
  db: pg.Pool | undefined,
  log: (line: string) => void,
  options: Omit<AssistantEventsOptions, "sink" | "log"> = {},
): RelayAssistantEvents | undefined {
  const setting = assistantEventsSetting(env);
  if (setting.unrecognized) {
    log(structuredLog("warn", "relay.assistant_events_setting_unrecognized", {
      setting: ASSISTANT_EVENTS_SETTING,
      hint: "only 1 enables assistant events; treating this as off",
    }));
  }
  if (!setting.enabled || !db) {
    log(structuredLog("info", "relay.assistant_events", { enabled: false }));
    return undefined;
  }
  const emitter = new RelayAssistantEvents({ ...options, sink: databaseEventSink(db), log });
  emitter.start();
  log(structuredLog("info", "relay.assistant_events", { enabled: true }));
  return emitter;
}
