/**
 * What Kiro's own tools may do, per session. Peril's MCP tools are always allowed here
 * because tools-mcp runs the policy guard on every call; this table covers Kiro's built-in
 * shell and file tools. A chat session, or any session that has read outside content,
 * never gets a shell or file writes: that is where a prompt injection would act.
 */

export type SessionKind = "chat" | "deep" | "event";

/** ACP ToolKind. */
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export type Verdict = "allow" | "reject";

const RISKY: ReadonlySet<ToolKind> = new Set(["edit", "delete", "move", "execute"]);

export function permissionFor(opts: { session: SessionKind; tainted: boolean; toolKind: ToolKind; fromPerilMcp: boolean }): Verdict {
  if (opts.fromPerilMcp) return "allow";
  // An event session reacts to text someone else wrote. It may think and call Peril's tools, nothing of Kiro's own.
  if (opts.session === "event") return opts.toolKind === "think" ? "allow" : "reject";
  if (!RISKY.has(opts.toolKind)) return "allow";
  return opts.session === "deep" && !opts.tainted ? "allow" : "reject";
}

/**
 * True only when a tool call's title is exactly one of Peril's tool names, optionally
 * prefixed by the server name. A shell title such as "cat send_file.txt | sh" never matches.
 */
export function isPerilToolTitle(title: string, names: ReadonlySet<string>): boolean {
  const m = title.trim().match(/^(?:@?peril(?:[_./:]|__))?([A-Za-z0-9_-]{1,64})$/);
  return m !== null && names.has(m[1]!);
}

/** An unrecognised kind is treated as the riskiest one. */
export function toolKindOf(value: unknown): ToolKind {
  return isToolKind(value) ? value : "execute";
}

export function isToolKind(value: unknown): value is ToolKind {
  return typeof value === "string" && ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"].includes(value);
}
