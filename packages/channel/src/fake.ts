import type { InboundEvent, OwnerLine, ReplyLine } from "./types.js";

export type FakeAction =
  | { kind: "text"; body: string; replyTo?: string; id: string }
  | { kind: "file"; path: string; caption?: string; id: string }
  | { kind: "react"; messageId: string; emoji: string }
  | { kind: "read"; messageId: string }
  | { kind: "typing"; on: boolean }
  | { kind: "reply"; to: string; body: string };

/** In-memory line for tests and local runs. Records every action in order. */
export class FakeLine implements OwnerLine, ReplyLine {
  readonly actions: FakeAction[] = [];
  private n = 0;

  async text(body: string, opts: { replyTo?: string } = {}): Promise<string> {
    const id = `out_${++this.n}`;
    this.actions.push({ kind: "text", body, id, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) });
    return id;
  }
  async file(path: string, caption?: string): Promise<string> {
    const id = `out_${++this.n}`;
    this.actions.push({ kind: "file", path, id, ...(caption ? { caption } : {}) });
    return id;
  }
  async react(messageId: string, emoji: string): Promise<void> {
    this.actions.push({ kind: "react", messageId, emoji });
  }
  async markRead(messageId: string): Promise<void> {
    this.actions.push({ kind: "read", messageId });
  }
  async typing(on: boolean): Promise<void> {
    this.actions.push({ kind: "typing", on });
  }
  async replyTo(event: InboundEvent, body: string): Promise<void> {
    this.actions.push({ kind: "reply", to: event.from, body });
  }

  texts(): string[] {
    return this.actions.flatMap((a) => (a.kind === "text" ? [a.body] : []));
  }
}
