/**
 * What the relay's router knows about one inbound message, reduced to the
 * assistant-event vocabulary — pure, and carried on a `DispatchDecision` so
 * `dispatch.ts` keeps its property of performing no I/O of its own beyond the
 * lookups it already makes. `poller.ts` does the emitting.
 *
 * **This records the relevance gate's result; it never re-decides it.**
 * `addressed` comes from dispatch, which got it from `addressing.ts` and the
 * reply-capture window. `classifyTrigger` only names WHICH of the gate's
 * reasons applied, using the gate's own exported predicates in the gate's own
 * order — so it cannot disagree with the gate about whether a message was
 * addressed, only (if the two ever drift) fail to name why, which it reports
 * as `unclassified` rather than guessing.
 */
import { mentionsName, mentionsUsername } from "../relay/addressing.js";
import {
  boundedCount,
  channelTypeOf,
  lengthBucketOf,
  mediaKindOf,
  requesterRoleOf,
  type ChannelType,
  type LengthBucket,
  type MediaKindClass,
  type RequesterRole,
  type TriggerType,
} from "./contract.js";

/** The analytics descriptor a decision carries when assistant events are on. */
export interface InboundFacts {
  tripId: string;
  channelType: ChannelType;
  triggerType: TriggerType;
  requesterRole: RequesterRole;
  mediaKind: MediaKindClass;
  lengthBucket: LengthBucket;
  /** An unaddressed document the router kept for its sender's next addressed message. */
  documentHeld?: boolean;
  /** Earlier documents this addressed message brought along (held + replied-to). */
  attachmentsJoined?: number;
  /** Documents the turn carries to its handler, joined ones included. */
  documents?: number;
}

export interface TriggerInput {
  /** The gate's verdict. Authoritative. */
  addressed: boolean;
  /** The one-shot reply window claimed this message (migration 0053). */
  capturedAsReply: boolean;
  /** The MAPPED wire type the gate itself saw (`dm`, `group`, …). */
  chatType: string | undefined;
  text: string;
  assistantNames: readonly string[];
  botUsername?: string;
  isReplyToAssistant: boolean;
}

/**
 * Which of the gate's reasons applied. A DM is `dm` even when a reply window
 * was open in it: the window changes nothing in a DM, which is addressed by
 * construction.
 */
export function classifyTrigger(input: TriggerInput): TriggerType {
  if (!input.addressed) return "not_addressed";
  if (input.chatType === "dm") return "dm";
  if (input.capturedAsReply) return "reply_window";
  if (input.isReplyToAssistant) return "reply_to_bot";
  if (mentionsUsername(input.text, input.botUsername)) return "mention";
  if (input.assistantNames.some((name) => mentionsName(input.text, name))) return "name";
  return "unclassified";
}

export interface FactsInput {
  tripId: string;
  /** Telegram's own `chat.type` (`private`, `group`, `supergroup`, …), NOT the mapped wire type — see channelTypeOf. */
  telegramChatType: string | undefined;
  trigger: TriggerType;
  /** `trip_person_links.role` for the sender, or null when they are not linked. */
  linkRole: string | null | undefined;
  /** The message's own attachment kind (`Attachment.kind`), or null. */
  attachmentKind: string | null | undefined;
  /** Length of what the person wrote — text or caption — before anything is prefixed to it. */
  textLength: number;
}

export function inboundFacts(input: FactsInput): InboundFacts {
  const requesterRole = requesterRoleOf(input.linkRole);
  return {
    tripId: input.tripId,
    channelType: channelTypeOf(input.telegramChatType, requesterRole),
    triggerType: input.trigger,
    requesterRole,
    mediaKind: mediaKindOf(input.attachmentKind),
    lengthBucket: lengthBucketOf(input.textLength),
  };
}

export { boundedCount };
