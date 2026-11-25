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
  if (!RISKY.has(opts.toolKind)) return "allow";
  return opts.session === "deep" && !opts.tainted ? "allow" : "reject";
}

export function isToolKind(value: unknown): value is ToolKind {
  return typeof value === "string" && ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"].includes(value);
}
