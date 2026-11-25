import type { Capability } from "@peril/core";
import { classifyAppCall } from "./apps.js";
import type { CallTraits, Classifier } from "./guard.js";

type Row = Omit<CallTraits, "capabilities">;

const PLAIN: Row = { sideEffect: false, taints: false, blockedWhenTainted: false };

/** Tools whose behaviour differs from PLAIN. Capabilities come from each tool's own meta. */
const ROWS: Readonly<Record<string, Row>> = {
  web_fetch: { ...PLAIN, taints: true, source: "web" },
  web_search: { ...PLAIN, taints: true, source: "web search" },
  create_watcher: { ...PLAIN, blockedWhenTainted: true },
  skill_install: { ...PLAIN, blockedWhenTainted: true },
};

export const classify: Classifier = ({ name, args, tool }) => {
  if (name === "apps_execute") return classifyAppCall(args);
  const row = ROWS[name] ?? PLAIN;
  const capabilities: Capability[] = [...tool.spec.meta.capabilities];
  return { ...row, capabilities };
};
