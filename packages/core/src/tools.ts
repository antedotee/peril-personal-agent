// Adapted from open-instinct (https://github.com/mariagorskikh/open-instinct)
// Copyright (c) 2026 Maria Gorskikh. MIT License, see NOTICE.
/**
 * Tool registry. Every tool the agent can call is a ToolSpec: a TypeBox schema, an
 * execute function and a ToolMeta tag with the capabilities it needs. The registry
 * is served to Kiro as MCP tools by @peril/tools-mcp.
 */
import type { Static, TSchema } from "typebox";
import type { Channel, Principal, ToolMeta } from "./types.js";

export interface ToolContext {
  principal: Principal;
  conversationKey: string;
  /** Channel address, distinct from a per-principal or per-task runtime key. */
  deliveryKey?: string;
  replyRef?: Record<string, string | undefined>;
  /** Bound by the runtime; worker tools never accept a model-selected task. */
  assertA2AActive?: () => Promise<void>;
  markA2AState?: (state: string) => void;
  channel: Channel;
  /**
   * True only while the current run was started by the owner's own direct message on a
   * carrier-bound or local channel (iMessage, SMS, chat). False for email, group threads,
   * delegated A2A results, scheduled jobs and resumed conversations, whose text the owner
   * did not write.
   */
  ownerTurn?: boolean;
  now(): Date;
}

export type ToolResultLike =
  | string
  | {
      content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      details?: unknown;
      isError?: boolean;
    };

export interface ToolSpec<T extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  meta: ToolMeta;
  execute: (args: Static<T>, ctx: ToolContext, signal?: AbortSignal) => Promise<ToolResultLike>;
}

export interface RegisteredTool {
  spec: ToolSpec<any>;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Wrap a spec so the generic parameter is inferred once and the schema stays typed. */
export function defineTool<T extends TSchema>(spec: ToolSpec<T>): RegisteredTool {
  if (!TOOL_NAME.test(spec.name)) {
    throw new Error(`Invalid tool name "${spec.name}": use [A-Za-z0-9_-], at most 64 characters`);
  }
  return { spec };
}

export function textResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }] };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    // Later registrations win so a package can override a core tool on purpose.
    this.tools.set(tool.spec.name, tool);
  }

  registerMany(tools: RegisteredTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  meta(name: string): ToolMeta | undefined {
    return this.tools.get(name)?.spec.meta;
  }
}
