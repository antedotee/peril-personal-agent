/**
 * Gmail, Calendar and the rest of Composio, reached through the Sprites gateway so the
 * Composio key never sits on the Sprite. Two tools keep Kiro's tool list small: search for
 * a tool, then execute it. The guard classifies each execute by its slug and arguments.
 */
import { Type } from "typebox";
import { defineTool, textResult, type Capability, type RegisteredTool } from "@peril/core";
import { perilCapabilitiesFor } from "./capabilities.js";
import type { CallTraits } from "./guard.js";

export interface ComposioTransport {
  request(opts: { method: "GET" | "POST"; path: string; body?: unknown }): Promise<unknown>;
}

/** Calls go to the connector's gateway URL; the gateway attaches the credential. */
export function gatewayTransport(opts: { baseUrl: string; fetchImpl?: typeof fetch }): ComposioTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request({ method, path, body }) {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Composio ${res.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : {};
    },
  };
}

export const API = "/api/v3.1";

const SIDE_EFFECTS: ReadonlySet<Capability> = new Set(["email.send", "calendar.write", "plans.commit", "purchase", "travel.book", "data.delete"]);
const READS_OTHERS: ReadonlySet<Capability> = new Set(["email.read", "calendar.read", "contacts.read"]);

export function classifyAppCall(args: unknown): CallTraits {
  const record = typeof args === "object" && args !== null ? (args as { slug?: unknown; arguments?: unknown }) : {};
  const slug = typeof record.slug === "string" ? record.slug : "";
  const caps: Capability[] = slug ? perilCapabilitiesFor(slug, record.arguments) : ["trust.manage"];
  const all: Capability[] = ["apps.use", ...caps.filter((c) => c !== "apps.use")];
  return {
    capabilities: all,
    sideEffect: all.some((c) => SIDE_EFFECTS.has(c)),
    taints: all.some((c) => READS_OTHERS.has(c)),
    blockedWhenTainted: false,
    source: slug || "composio",
  };
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

function describeAppCall(args: unknown): string {
  const record = typeof args === "object" && args !== null ? (args as { slug?: unknown; arguments?: Record<string, unknown> }) : {};
  const slug = String(record.slug ?? "app call");
  const a = record.arguments ?? {};
  const to = a.recipient_email ?? a.to ?? a.attendees ?? a.attendee_emails;
  const subject = a.subject ?? a.summary ?? a.title;
  const when = a.start_datetime ?? a.start_time ?? a.start;
  const parts = [slug.toLowerCase().replace(/_/g, " ")];
  if (to) parts.push(`to ${Array.isArray(to) ? to.join(", ") : String(to)}`);
  if (subject) parts.push(`"${String(subject).slice(0, 80)}"`);
  if (when) parts.push(`at ${String(when)}`);
  return parts.join(" ");
}
