/**
 * Gmail, Calendar and the rest of Composio, reached through the Sprites gateway so the
 * Composio key never sits on the Sprite. Two tools keep Kiro's tool list small: search for
 * a tool, then execute it. The guard classifies each execute by its slug and arguments.
 */
import { Type } from "typebox";
import { defineTool, textResult, type Capability, type RegisteredTool } from "@peril/core";
import { isReadSlug, perilCapabilitiesFor, toolkitOfSlug } from "./capabilities.js";
import type { CallTraits } from "./guard.js";

/** An HTTP answer from the far side. A 4xx means the call did not happen. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ComposioTransport {
  request(opts: { method: "GET" | "POST"; path: string; body?: unknown }): Promise<unknown>;
}

/** Calls go to the connector's gateway URL; the gateway attaches the credential. */
export function gatewayTransport(opts: { baseUrl: string; fetchImpl?: typeof fetch }): ComposioTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request({ method, path, body }) {
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(`${base}${path}`, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        if (res.ok) return text ? JSON.parse(text) : {};
        // An expired or revoked connection never fixes itself: stop and tell the owner.
        if (res.status === 401 || res.status === 403 || /invalid_grant|reconnect|expired/i.test(text)) {
          throw new HttpError(res.status, `the app connection needs reconnecting (${res.status}). Tell the owner once to reconnect it in Composio; do not retry.`);
        }
        const transient = res.status === 429 || res.status >= 500;
        // Only reads retry here. A failed write is left to the receipt, never resent blindly.
        if (!transient || method !== "GET" || attempt >= RETRY_DELAYS_MS.length) throw new HttpError(res.status, `Composio ${res.status}: ${text.slice(0, 300)}`);
        await Bun.sleep(RETRY_DELAYS_MS[attempt]!);
      }
    },
  };
}

export const API = "/api/v3.1";
const RETRY_DELAYS_MS = [1000, 3000];

/** Classify one apps_execute call by its slug and arguments. `toolkits` are the ones the owner connected. */
export function classifyAppCall(args: unknown, toolkits: readonly string[]): CallTraits {
  const record = typeof args === "object" && args !== null ? (args as { slug?: unknown; arguments?: unknown }) : {};
  const slug = typeof record.slug === "string" ? record.slug.trim().toUpperCase() : "";
  const normalized = { slug, arguments: record.arguments ?? {} };
  const base = { taints: false, blockedWhenTainted: false, source: slug || "composio", args: normalized };
  if (!slug) return { ...base, capabilities: ["apps.use"], sideEffect: false, refuse: "apps_execute needs a slug from apps_search." };
  if (slug.startsWith("COMPOSIO_")) return { ...base, capabilities: ["apps.use"], sideEffect: false, refuse: `${slug} runs other tools out of sight of the policy guard. Use one apps_execute call per tool.` };
  if (!toolkits.map((t) => t.toLowerCase()).includes(toolkitOfSlug(slug))) {
    return { ...base, capabilities: ["apps.use"], sideEffect: false, refuse: `${toolkitOfSlug(slug)} is not one of the connected toolkits (${toolkits.join(", ")}).` };
  }
  const caps = perilCapabilitiesFor(slug, normalized.arguments);
  const all: Capability[] = ["apps.use", ...caps.filter((c) => c !== "apps.use")];
  const read = isReadSlug(slug);
  return { ...base, capabilities: all, sideEffect: !read, taints: read };
}

interface ToolItem {
  slug?: string;
  name?: string;
  description?: string;
  input_parameters?: unknown;
}

function itemsOf(value: unknown): ToolItem[] {
  if (typeof value !== "object" || value === null) return [];
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? (items as ToolItem[]) : [];
}

export function appsTools(opts: { transport: ComposioTransport; userId: string; toolkits: string[] }): RegisteredTool[] {
  const { transport, userId } = opts;
  const search = defineTool({
    name: "apps_search",
    label: "Find an app tool",
    description: `Find the Composio tool for a job in the owner's connected apps (${opts.toolkits.join(", ")}). Returns slugs with their input schema. Then call apps_execute with the slug.`,
    parameters: Type.Object({
      query: Type.String({ description: "What you want to do, e.g. 'list today's calendar events' or 'send an email'" }),
      toolkit: Type.Optional(Type.String({ description: `One of ${opts.toolkits.join(", ")}` })),
    }),
    meta: { capabilities: ["apps.use"], group: "apps", describe: (a) => `search apps: ${String((a as { query?: unknown }).query ?? "")}` },
    execute: async ({ query, toolkit }) => {
      const kits = toolkit ? [toolkit] : opts.toolkits;
      const results: string[] = [];
      for (const kit of kits) {
        const params = new URLSearchParams({ toolkit_slug: kit.toLowerCase(), query, limit: "6" });
        const found = itemsOf(await transport.request({ method: "GET", path: `${API}/tools?${params}` }));
        for (const t of found) {
          results.push(`${t.slug}: ${(t.description ?? t.name ?? "").slice(0, 200)}\n  input: ${JSON.stringify(t.input_parameters ?? {}).slice(0, 900)}`);
        }
      }
      return textResult(results.length ? results.join("\n") : "No matching tool. Try other words or another toolkit.");
    },
  });
  const execute = defineTool({
    name: "apps_execute",
    label: "Run an app tool",
    description:
      "Run one Composio tool by slug on the owner's connected account. Reads run at once. Sending email, inviting people, RSVPs, deleting and paying wait for the owner's thumbs-up; holds on the owner's own calendar do not.",
    parameters: Type.Object({
      slug: Type.String({ description: "Tool slug from apps_search, e.g. GMAIL_FETCH_EMAILS" }),
      arguments: Type.Record(Type.String(), Type.Unknown(), { description: "Arguments matching the tool's input schema" }),
    }),
    meta: { capabilities: ["apps.use"], group: "apps", describe: (a) => describeAppCall(a) },
    execute: async ({ slug, arguments: args }) => {
      const out = await transport.request({ method: "POST", path: `${API}/tools/execute/${encodeURIComponent(slug.toUpperCase())}`, body: { user_id: userId, arguments: args } });
      const record = (out ?? {}) as { successful?: unknown; error?: unknown; data?: unknown };
      if (record.successful === false) return { content: [{ type: "text", text: `Tool error: ${String(record.error ?? "unknown")}` }], isError: true };
      return textResult(JSON.stringify(record.data ?? out).slice(0, 12_000));
    },
  });
  return [search, execute];
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

/** The approval text the owner reads: every recipient, the subject, the time and the start of the body. */
export function describeAppCall(args: unknown): string {
  const record = typeof args === "object" && args !== null ? (args as { slug?: unknown; arguments?: Record<string, unknown> }) : {};
  const slug = String(record.slug ?? "app call").toUpperCase();
  const a = record.arguments ?? {};
  const parts = [slug.toLowerCase().replace(/_/g, " ")];
  const to = a.recipient_email ?? a.to ?? a.attendees ?? a.attendee_emails ?? a.guests;
  if (to) parts.push(`to ${list(to)}`);
  for (const key of ["extra_recipients", "cc", "bcc"]) if (a[key] && list(a[key])) parts.push(`${key.replace("extra_recipients", "also to")} ${list(a[key])}`);
  const subject = a.subject ?? a.summary ?? a.title;
  if (subject) parts.push(`"${String(subject).slice(0, 80)}"`);
  const when = a.start_datetime ?? a.start_time ?? a.start;
  if (when) parts.push(`at ${typeof when === "object" ? JSON.stringify(when) : String(when)}`);
  const id = a.event_id ?? a.message_id ?? a.thread_id ?? a.id;
  if (id) parts.push(`(id ${String(id)})`);
  const body = a.body ?? a.message_body ?? a.description ?? a.text;
  if (body) parts.push(`saying: "${String(body).replace(/\s+/g, " ").slice(0, 160)}"`);
  return parts.join(" ");
}
