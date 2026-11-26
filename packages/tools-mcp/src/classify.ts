import type { Capability } from "@peril/core";
import { classifyAppCall } from "./apps.js";
import type { CallTraits, Classifier } from "./guard.js";

type Row = Omit<CallTraits, "capabilities">;

const PLAIN: Row = { sideEffect: false, taints: false, blockedWhenTainted: false };

/** Tools whose behaviour differs from PLAIN. Capabilities come from each tool's own meta. */
const ROWS: Readonly<Record<string, Row>> = {
  web_fetch: { ...PLAIN, taints: true, source: "web" },
  web_search: { ...PLAIN, taints: true, source: "web search" },
  browser_open: { ...PLAIN, taints: true, source: "web page" },
  browser_snapshot: { ...PLAIN, taints: true, source: "web page" },
  browser_click: { ...PLAIN, refuseIn: ["event"] },
  browser_fill: { ...PLAIN, refuseIn: ["event"] },
  browser_press: { ...PLAIN, refuseIn: ["event"] },
  browser_submit: { ...PLAIN, sideEffect: true, refuseIn: ["event"] },
  await_code: { ...PLAIN, refuseIn: ["event"] },
  fill_code: { ...PLAIN, refuseIn: ["event"] },
  // Lasting writes that outside text could have shaped: the owner confirms them in a tainted session.
  memory_write: { ...PLAIN, askWhenTainted: true },
  journal_append: { ...PLAIN, askWhenTainted: true },
  schedule_create: { ...PLAIN, askWhenTainted: true },
  watcher_create: { ...PLAIN, askWhenTainted: true },
};

export function makeClassifier(opts: { toolkits: readonly string[] }): Classifier {
  return ({ name, args, tool }) => {
    if (name === "apps_execute") return classifyAppCall(args, opts.toolkits);
    const row = ROWS[name] ?? PLAIN;
    const capabilities: Capability[] = [...tool.spec.meta.capabilities];
    return { ...row, capabilities };
  };
}

export const classify: Classifier = makeClassifier({ toolkits: ["gmail", "googlecalendar"] });
