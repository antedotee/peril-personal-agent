/**
 * The owner's iMessage line, as the rest of Peril sees it. Photon is one implementation;
 * tests use FakeLine. Nothing outside this package imports spectrum-ts.
 */

interface InboundBase {
  /** Platform message id. Delivery is at-least-once, so callers dedupe on it. */
  id: string;
  /** Sender address (E.164 or email) as the platform reports it. */
  from: string;
  /** Platform conversation id, used to text the owner first later. */
  spaceId: string;
  at: Date;
}

export type InboundEvent =
  | (InboundBase & { kind: "text"; text: string })
  | (InboundBase & { kind: "tapback"; emoji: string; targetId: string })
  | (InboundBase & { kind: "file"; name: string; mimeType: string; voice: boolean; read: () => Promise<Buffer> })
  | (InboundBase & { kind: "other"; contentType: string });

export interface OwnerLine {
  /** Send text to the owner. Returns the sent message id when the platform reports one. */
  text(body: string, opts?: { replyTo?: string }): Promise<string | undefined>;
  file(path: string, caption?: string): Promise<string | undefined>;
  react(messageId: string, emoji: string): Promise<void>;
  markRead(messageId: string): Promise<void>;
  typing(on: boolean): Promise<void>;
}

/** Reply in whatever conversation an event came from. Used for strangers, who never reach the brain. */
export interface ReplyLine {
  replyTo(event: InboundEvent, body: string): Promise<void>;
}

export const TAPBACK = {
  seen: "👀",
  like: "👍",
  dislike: "👎",
  done: "✅",
  alarm: "⏰",
  research: "🔍",
} as const;

export function isApprove(emoji: string): boolean {
  return emoji === "👍" || emoji === "❤" || emoji === "❤️";
}

export function isDeny(emoji: string): boolean {
  return emoji === "👎";
}
