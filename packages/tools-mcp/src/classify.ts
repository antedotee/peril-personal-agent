import type { Capability } from "@peril/core";
import { classifyAppCall } from "./apps.js";
import type { CallTraits, Classifier } from "./guard.js";

type Row = Omit<CallTraits, "capabilities">;

const PLAIN: Row = { sideEffect: false, taints: false, blockedWhenTainted: false };

/** The only tools an event session (an email, a calendar change, a watcher hit) may call. */
const EVENT_TOOLS: ReadonlySet<string> = new Set(["memory_read", "memory_search", "apps_search", "apps_execute", "schedule_list", "watcher_list", "audit_read"]);

/** Tools whose behaviour differs from PLAIN. Capabilities come from each tool's own meta. */
const ROWS: Readonly<Record<string, Row>> = {
  web_fetch: { ...PLAIN, taints: true, source: "web" },
  web_search: { ...PLAIN, taints: true, source: "web search" },
  browser_open: { ...PLAIN, taints: true, source: "web page" },
  browser_snapshot: { ...PLAIN, taints: true, source: "web page" },
  browser_submit: { ...PLAIN, sideEffect: true },
  // Lasting writes that outside text could have shaped: the owner confirms them in a tainted session.
  memory_write: { ...PLAIN, askWhenTainted: true },
  journal_append: { ...PLAIN, askWhenTainted: true },
  schedule_create: { ...PLAIN, askWhenTainted: true },
  watcher_create: { ...PLAIN, askWhenTainted: true },
};

function field(args: unknown, key: string): string {
  const v = typeof args === "object" && args !== null ? (args as Record<string, unknown>)[key] : undefined;
  return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
}

/** The full payload of a lasting write, so the owner approves exactly what will be saved. */
function confirmText(name: string, args: unknown): string | undefined {
  switch (name) {
    case "memory_write":
      return `remember: "${field(args, "text")}"`;
    case "journal_append":
      return `add to the journal: "${field(args, "text")}"`;
    case "schedule_create":
      return `schedule "${field(args, "prompt")}" ${field(args, "cron") ? `on cron ${field(args, "cron")}` : `at ${field(args, "at")}`}${field(args, "tz") ? ` (${field(args, "tz")})` : ""}`;
    case "watcher_create":
      return `watch ${field(args, "spec")} every ${field(args, "everyMinutes")} min`;
    case "browser_submit":
      return `${field(args, "what")} (button "${field(args, "label")}" on ${field(args, "url")})`;
    default:
      return undefined;
  }
}

export function makeClassifier(opts: { toolkits: readonly string[] }): Classifier {
  return ({ name, args, tool }) => {
    const refuseIn = EVENT_TOOLS.has(name) ? undefined : (["event"] as const);
    const base = name === "apps_execute" ? classifyAppCall(args, opts.toolkits) : { ...(ROWS[name] ?? PLAIN), capabilities: [...tool.spec.meta.capabilities] as Capability[] };
    const approvalText = confirmText(name, args);
    return { ...base, ...(approvalText ? { approvalText } : {}), ...(refuseIn ? { refuseIn } : {}) };
  };
}

export const classify: Classifier = makeClassifier({ toolkits: ["gmail", "googlecalendar"] });
