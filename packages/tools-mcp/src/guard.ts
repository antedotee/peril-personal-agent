/**
 * The only path from Kiro to a side effect. Every MCP tools/call runs here: policy, the
 * owner's approval, the taint rule, the write-ahead receipt, the audit entry. Kiro's own
 * permission prompts are a second check, never the only one.
 */
import { createHash } from "node:crypto";
import type {
  Approval,
  ApprovalStore,
  AuditLog,
  Capability,
  PolicyEngine,
  Principal,
  ReceiptStore,
  RegisteredTool,
  StateDir,
  ToolContext,
  ToolRegistry,
  ToolResultLike,
} from "@peril/core";
import { canonicalJson } from "@peril/core";
import type { McpBackend, McpCallResult, McpToolDescriptor } from "./mcp-http.js";
import { wrapExternal } from "./untrusted.js";

export type SessionKind = "chat" | "deep" | "event";

export interface Scope {
  key: string;
  kind: SessionKind;
  /** The current turn was started by the owner's own message, not an email, job or event. */
  ownerTurn: boolean;
}

export interface ScopeState {
  get(key: string): Scope;
  isTainted(key: string): boolean;
  taint(key: string, source: string): void;
}

/** What one call needs and does. Static tools have a fixed row; app calls are classified by slug and args. */
export interface CallTraits {
  capabilities: Capability[];
  /** Changes the outside world and cannot be safely replayed. Gets a write-ahead receipt. */
  sideEffect: boolean;
  /** Returns text someone other than the owner wrote. Taints the session. */
  taints: boolean;
  /** Refused in a tainted session, before any approval is created. */
  blockedWhenTainted: boolean;
  /** Where outside text came from, for the wrapper. */
  source?: string;
  /** Refuse the call outright, with this reason, before policy or approvals. */
  refuse?: string;
  /** In a tainted session the call asks the owner first (a lasting write the outside text may have shaped). */
  askWhenTainted?: boolean;
  /** Canonical arguments, used for approvals, receipts and execution. */
  args?: unknown;
  /** Session kinds that may never call this tool. Event sessions do not drive the browser. */
  refuseIn?: readonly SessionKind[];
}

export type Classifier = (opts: { name: string; args: unknown; tool: RegisteredTool }) => CallTraits;

export interface GuardDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
  approvals: ApprovalStore;
  audit: AuditLog;
  receipts: ReceiptStore;
  state: StateDir;
  scopes: ScopeState;
  owner: Principal;
  classify: Classifier;
  /** Text the owner an approval request. The server keeps the exact call so it can run it on 👍 without a model. */
  requestApproval: (approval: Approval, call: { name: string; args: unknown; scope: string }) => Promise<void>;
  now?: () => Date;
}

const CONSUMED_FILE = "approvals-consumed.json";
/** Longer than an approval lives (2 h), so an approval granted late is still usable once. */
const APPROVAL_USE_WINDOW_MS = 3 * 60 * 60 * 1000;
const SPEND: ReadonlySet<Capability> = new Set(["purchase", "travel.book"]);

export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? {})).digest("hex").slice(0, 16);
}

function toMcp(result: ToolResultLike, wrap?: (text: string) => string): McpCallResult {
  if (typeof result === "string") return { content: [{ type: "text", text: wrap ? wrap(result) : result }] };
  const content = result.content.map((c) => (c.type === "text" && wrap ? { type: "text" as const, text: wrap(c.text) } : c));
  return { content: content.length > 0 ? content : [{ type: "text", text: "" }], ...(result.isError ? { isError: true } : {}) };
}

function refuse(text: string): McpCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export class Guard implements McpBackend {
  private readonly now: () => Date;

  constructor(private readonly deps: GuardDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  list(): McpToolDescriptor[] {
    return this.deps.registry.all().map(({ spec }) => ({ name: spec.name, description: spec.description, inputSchema: spec.parameters }));
  }

  async call(opts: { name: string; args: unknown; scope: string }): Promise<McpCallResult> {
    const { registry, policy, audit, receipts, scopes, owner } = this.deps;
    const tool = registry.get(opts.name);
    if (!tool) return refuse(`No tool named ${opts.name}.`);
    const scope = scopes.get(opts.scope);
    const traits = this.deps.classify({ name: opts.name, args: opts.args, tool });
    const args = traits.args ?? opts.args;
    const describe = tool.spec.meta.describe?.(args) ?? opts.name;
    const tainted = scopes.isTainted(scope.key);

    if (traits.refuse) return refuse(traits.refuse);
    if (traits.refuseIn?.includes(scope.kind)) return refuse(`${opts.name} is not available in a ${scope.kind} session.`);
    if (traits.blockedWhenTainted && tainted) {
      audit.append({ kind: "policy", conversationKey: scope.key, principal: owner.id, detail: { tool: opts.name, outcome: "deny", reason: "tainted session" } });
      return refuse(`Blocked: this conversation has read outside content, so ${opts.name} is not allowed here. Ask the owner to request it in a fresh message.`);
    }

    const capabilities: Capability[] = traits.askWhenTainted && tainted ? [...traits.capabilities, "plans.commit"] : traits.capabilities;
    const meta = { ...tool.spec.meta, capabilities };
    const decision = policy.evaluate(owner, meta, args);
    audit.append({ kind: "policy", conversationKey: scope.key, principal: owner.id, detail: { tool: opts.name, outcome: decision.outcome, reason: decision.reason } });
    if (decision.outcome === "deny") return refuse(`Blocked by policy: ${decision.reason}. Do not retry.`);
    if (decision.outcome === "ask") {
      const hash = argsHash(args);
      const consumed = this.consumeApproval({ toolName: opts.name, argsHash: hash });
      if (!consumed) {
        const waiting = this.deps.approvals.findPending({ conversationKey: scope.key, toolName: opts.name, argsHash: hash });
        if (!waiting) {
          const approval = this.deps.approvals.create({
            conversationKey: scope.key,
            requestedBy: owner.id,
            summary: describe,
            capability:
              capabilities.find((c) => SPEND.has(c)) ??
              capabilities.find((c) => policy.permissionFor("owner", c) === "ask" || policy.permissionFor("owner", c) === "limit") ??
              capabilities[0] ??
              "converse",
            toolName: opts.name,
            argsHash: hash,
          });
          audit.append({ kind: "approval", conversationKey: scope.key, principal: owner.id, detail: { token: approval.token, status: "pending", summary: describe, tool: opts.name } });
          await this.deps.requestApproval(approval, { name: opts.name, args, scope: scope.key });
        }
        return {
          content: [
            {
              type: "text",
              text: `Waiting for the owner's thumbs-up on: ${describe}. Do not call ${opts.name} again now. Tell the owner in one short line what you are waiting on and end your turn. When they approve you will get a message starting "Owner approved".`,
            },
          ],
        };
      }
    }

    let callKey: string | undefined;
    if (traits.sideEffect) {
      const begun = receipts.begin({ toolName: opts.name, args, intentSummary: describe });
      if (begun.kind === "already_done") return { content: [{ type: "text", text: `Already done at ${begun.receipt.completedAt}: ${begun.receipt.resultSummary ?? describe}. Do not do it again.` }] };
      if (begun.kind === "in_doubt") {
        return refuse(
          `An identical call started at ${begun.receipt.startedAt} and Peril restarted before it finished, so it may already have happened. Do not retry. Check the real state first (for email, the Sent folder; for events, the calendar), tell the owner what you found, and ask before trying again.`,
        );
      }
      callKey = begun.callKey;
    }

    const ctx: ToolContext = { principal: owner, conversationKey: scope.key, channel: "imessage", ownerTurn: scope.ownerTurn, now: this.now };
    let result: ToolResultLike;
    try {
      result = await tool.spec.execute(args, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit.append({ kind: "error", conversationKey: scope.key, principal: owner.id, detail: { tool: opts.name, message } });
      const rejected = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status < 500;
      if (callKey && !rejected) {
        return refuse(`${opts.name} may or may not have gone through (${message}). Do not retry. Check the real state, tell the owner what you found, and ask before trying again.`);
      }
      if (callKey) receipts.finish({ callKey, ok: false, resultSummary: message });
      return refuse(`${opts.name} failed: ${message}`);
    }
    const isError = typeof result !== "string" && result.isError === true;
    if (callKey) receipts.finish({ callKey, ok: !isError, resultSummary: summaryOf(result) });
    audit.append({ kind: "tool_call", conversationKey: scope.key, principal: owner.id, detail: { tool: opts.name, isError, summary: describe } });
    if (traits.taints && !isError) {
      scopes.taint(scope.key, traits.source ?? opts.name);
      return toMcp(result, (text) => wrapExternal({ source: traits.source ?? opts.name, body: text }));
    }
    return toMcp(result);
  }

  /** Spend an approved approval for this exact call once. */
  private consumeApproval(match: { toolName: string; argsHash: string }): Approval | undefined {
    const { state, approvals } = this.deps;
    const consumed = new Set(state.readJson<string[]>(CONSUMED_FILE, []));
    const nowMs = this.now().getTime();
    const found = approvals.approved().find(
      (a) =>
        a.status === "approved" &&
        a.toolName === match.toolName &&
        a.argsHash === match.argsHash &&
        !consumed.has(a.token) &&
        Date.parse(a.createdAt) + APPROVAL_USE_WINDOW_MS > nowMs,
    );
    if (!found) return undefined;
    consumed.add(found.token);
    state.writeJson(CONSUMED_FILE, [...consumed].slice(-200));
    return found;
  }
}

function summaryOf(result: ToolResultLike): string {
  if (typeof result === "string") return result.slice(0, 300);
  return result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(" ").slice(0, 300);
}
