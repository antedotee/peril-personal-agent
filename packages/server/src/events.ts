/**
 * Composio trigger webhooks: a new Gmail message or a calendar change wakes the Sprite.
 * Plain code decides whether Kiro runs. Most email is not worth a model call.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface AppEvent {
  id: string;
  slug: string;
  data: Record<string, unknown>;
}

const REPLAY_WINDOW_S = 5 * 60;

export function verifyComposio(opts: { secret: string; id: string; timestamp: string; signature: string; body: string; nowS?: number }): boolean {
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > REPLAY_WINDOW_S) return false;
  const expected = createHmac("sha256", opts.secret).update(`${opts.id}.${opts.timestamp}.${opts.body}`).digest("base64");
  return opts.signature.split(" ").some((part) => {
    const received = part.includes(",") ? part.split(",")[1] ?? "" : part;
    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export function parseComposio(body: string, id: string): AppEvent | undefined {
  try {
    const payload = JSON.parse(body) as { type?: unknown; data?: unknown; metadata?: { trigger_slug?: unknown } };
    if (payload.type !== "composio.trigger.message") return undefined;
    const slug = payload.metadata?.trigger_slug;
    if (typeof slug !== "string") return undefined;
    const data = typeof payload.data === "object" && payload.data !== null ? (payload.data as Record<string, unknown>) : {};
    return { id, slug, data };
  } catch {
    return undefined;
  }
}

/** Why an event deserves a model call, or undefined when it doesn't. */
export type Importance = { reason: string; body: string } | undefined;

const URGENT = /\b(urgent|asap|today|tomorrow|deadline|overdue|invoice|payment due|cancel+ed|rescheduled?|interview|offer)\b/i;
const NOISE = /\b(newsletter|unsubscribe|no-?reply|promo|sale|% off|digest|verification code|one-time password|otp)\b/i;

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
}

export function emailAddressOf(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

/**
 * The check that runs before any model call. An email matters when its sender appears in
 * Peril's memory (Kartik told Peril about them) or its subject looks urgent and not like
 * bulk mail. A calendar change matters when it starts within a day.
 */
export function importanceOf(event: AppEvent, ctx: { memory: string; now: Date }): Importance {
  const slug = event.slug.toUpperCase();
  const d = event.data;
  if (slug.startsWith("GMAIL_")) {
    const from = str(d.sender ?? d.from);
    const subject = str(d.subject);
    const preview = str(d.message_text ?? d.preview ?? d.snippet).slice(0, 1500);
    const address = emailAddressOf(from);
    const memory = ctx.memory.toLowerCase();
    const local = address.split("@")[0] ?? "";
    const known = Boolean(address) && (memory.includes(address) || (local.length >= 4 && !/^(info|hello|support|team|noreply|no-reply|admin|notifications?)$/.test(local) && memory.includes(local)));
    const urgent = URGENT.test(subject) && !NOISE.test(`${from} ${subject}`);
    if (!known && !urgent) return undefined;
    return { reason: known ? `email from ${address}, who is in memory` : "urgent-looking subject", body: `From: ${from}\nSubject: ${subject}\n\n${preview}` };
  }
  if (slug.startsWith("GOOGLECALENDAR_")) {
    const start = Date.parse(str((d.start as { dateTime?: unknown } | undefined)?.dateTime ?? d.start_time ?? d.start));
    if (!Number.isFinite(start)) return undefined;
    const ahead = start - ctx.now.getTime();
    if (ahead < 0 || ahead > 24 * 60 * 60 * 1000) return undefined;
    return { reason: "calendar change within 24 hours", body: `Event: ${str(d.summary ?? d.title)}\nStarts: ${new Date(start).toISOString()}\nOrganizer: ${str(d.organizer)}\n${str(d.description).slice(0, 800)}` };
  }
  return undefined;
}

export interface EventHandlerDeps {
  secret: string;
  firstSight: (id: string) => boolean;
  memory: () => string;
  now?: () => Date;
  onImportant: (event: AppEvent, why: NonNullable<Importance>) => Promise<void>;
  onSkipped?: (event: AppEvent) => void;
}

/** The /events/composio route. It answers fast and runs the model, if at all, after. */
export function composioEventsHandler(deps: EventHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = await request.text();
    const id = request.headers.get("webhook-id") ?? "";
    const timestamp = request.headers.get("webhook-timestamp") ?? "";
    const signature = request.headers.get("webhook-signature") ?? "";
    if (!id || !verifyComposio({ secret: deps.secret, id, timestamp, signature, body })) return new Response("bad signature", { status: 401 });
    const event = parseComposio(body, id);
    if (!event || !deps.firstSight(`composio:${id}`)) return new Response("ok");
    const why = importanceOf(event, { memory: deps.memory(), now: (deps.now ?? (() => new Date()))() });
    if (!why) {
      deps.onSkipped?.(event);
      return new Response("ok");
    }
    void deps.onImportant(event, why).catch(() => undefined);
    return new Response("ok");
  };
}
