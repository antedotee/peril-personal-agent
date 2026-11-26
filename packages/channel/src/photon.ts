/**
 * Photon (Spectrum, Stable docs) adapter for the owner's iMessage line. Webhook mode only:
 * the Sprite sleeps between texts, so no long-lived stream is held open.
 */
import { Spectrum, attachment, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { InboundEvent, OwnerLine, ReplyLine } from "./types.js";

export interface PhotonCredentials {
  projectId: string;
  projectSecret: string;
  webhookSecret: string;
}

/** Messages we have seen, kept so tapbacks and read receipts can target them. */
const RECENT_LIMIT = 200;

export function toInboundEvent(space: Space, message: Message): InboundEvent | undefined {
  if (message.direction !== "inbound") return undefined;
  const base = { id: message.id, from: message.sender?.id ?? "", spaceId: space.id, at: message.timestamp };
  const content = message.content;
  switch (content.type) {
    case "text":
      return { ...base, kind: "text", text: content.text };
    case "reaction":
      return { ...base, kind: "tapback", emoji: content.emoji, targetId: content.target.id };
    case "attachment":
      return { ...base, kind: "file", name: content.name, mimeType: content.mimeType, voice: false, read: () => content.read() };
    case "voice":
      return { ...base, kind: "file", name: content.name ?? "voice-memo", mimeType: content.mimeType, voice: true, read: () => content.read() };
    default:
      return { ...base, kind: "other", contentType: content.type };
  }
}

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

export class PhotonLine implements OwnerLine, ReplyLine {
  private readonly recent = new Map<string, Message>();
  private readonly spaces = new Map<string, Space>();
  private ownerSpace: Space | undefined;

  private constructor(
    private readonly app: SpectrumApp,
    private readonly owner: { phone: string; spaceId?: string },
  ) {}

  static async connect(creds: PhotonCredentials, owner: { phone: string; spaceId?: string }): Promise<PhotonLine> {
    const app = await Spectrum({
      projectId: creds.projectId,
      projectSecret: creds.projectSecret,
      providers: [imessage.config()],
      webhookSecret: creds.webhookSecret,
      telemetry: false,
      signal: AbortSignal.timeout(20_000),
    });
    return new PhotonLine(app, owner);
  }

  /** Verify and parse one webhook delivery. `onEvent` runs after the response is sent. */
  handleWebhook(request: Request, onEvent: (event: InboundEvent) => Promise<void>): Promise<Response> {
    return this.app.webhook(request, async (space, message) => {
      const event = toInboundEvent(space, message);
      if (!event) return;
      this.remember(space, message);
      await onEvent(event);
    });
  }

  private remember(space: Space, message: Message): void {
    this.spaces.set(space.id, space);
    this.recent.set(message.id, message);
    if (this.recent.size > RECENT_LIMIT) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  /** Bind the owner's conversation once their first message arrives. */
  adoptOwnerSpace(spaceId: string): void {
    const space = this.spaces.get(spaceId);
    if (space) this.ownerSpace = space;
    this.owner.spaceId = spaceId;
  }

  private async space(): Promise<Space> {
    if (this.ownerSpace) return this.ownerSpace;
    const im = imessage(this.app);
    this.ownerSpace = this.owner.spaceId
      ? await im.space.get(this.owner.spaceId)
      : await im.space.create(await im.user(this.owner.phone));
    return this.ownerSpace;
  }

  private async message(id: string): Promise<Message | undefined> {
    return this.recent.get(id) ?? (await (await this.space()).getMessage(id));
  }

  async text(body: string, opts: { replyTo?: string } = {}): Promise<string | undefined> {
    const target = opts.replyTo ? await this.message(opts.replyTo) : undefined;
    const sent = target ? await target.reply(body) : await (await this.space()).send(body);
    return sent?.id;
  }

  async file(path: string, caption?: string): Promise<string | undefined> {
    const space = await this.space();
    const sent = await space.send(attachment(path));
    if (caption) await space.send(caption);
    return sent?.id;
  }

  async react(messageId: string, emoji: string): Promise<void> {
    await (await this.message(messageId))?.react(emoji);
  }

  async markRead(messageId: string): Promise<void> {
    await (await this.message(messageId))?.read();
  }

  async typing(on: boolean): Promise<void> {
    const space = await this.space();
    await (on ? space.startTyping() : space.stopTyping());
  }

  async replyTo(event: InboundEvent, body: string): Promise<void> {
    const space = this.spaces.get(event.spaceId);
    await space?.send(body);
  }
}
