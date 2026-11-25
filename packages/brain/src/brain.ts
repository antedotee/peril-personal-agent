/**
 * Kiro as Peril's brain, over the Agent Client Protocol. One `kiro-cli acp` process serves
 * every session. A session is keyed by Peril's conversation key and remembers its Kiro
 * session id on disk, so a cold wake resumes it with `session/load`.
 */
import { JsonRpcPeer, RpcError } from "./jsonrpc.js";
import { isToolKind, permissionFor, type SessionKind } from "./permissions.js";

export interface AgentProcess {
  stdin: { write(line: string): void };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface SessionRecord {
  sessionId: string;
  kind: SessionKind;
}

export interface SessionStore {
  get(key: string): SessionRecord | undefined;
  set(key: string, record: SessionRecord): void;
  delete(key: string): void;
}

export interface BrainConfig {
  spawn: () => AgentProcess;
  cwd: string;
  models: Record<SessionKind, string | undefined>;
  /** Peril's MCP endpoint, handed to every session with a scope header naming its key. */
  mcpUrl: string;
  sessions: SessionStore;
  isTainted: (key: string) => boolean;
  perilToolNames: ReadonlySet<string>;
  /** Event sessions stop after this many tool calls. */
  eventToolCallCap?: number;
}

export type TurnResult =
  | { kind: "reply"; text: string; stopReason: string; toolCalls: number }
  | { kind: "auth_required"; message: string }
  | { kind: "failed"; message: string };

interface Live {
  text: string[];
  toolCalls: number;
  key: string;
  kind: SessionKind;
}

const AUTH_REQUIRED = -32000;
const DEFAULT_EVENT_CAP = 12;

function textOf(params: unknown): { sessionId: string; update: Record<string, unknown> } | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const { sessionId, update } = params as { sessionId?: unknown; update?: unknown };
  if (typeof sessionId !== "string" || typeof update !== "object" || update === null) return undefined;
  return { sessionId, update: update as Record<string, unknown> };
}

export class Brain {
  private peer: JsonRpcPeer | undefined;
  private proc: AgentProcess | undefined;
  private ready: Promise<void> | undefined;
  private readonly live = new Map<string, Live>();
  private readonly loaded = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly config: BrainConfig) {}

  /** Run one turn on a conversation. Turns on the same key run one at a time, in order. */
  run(opts: { key: string; kind: SessionKind; text: string }): Promise<TurnResult> {
    const prev = this.queues.get(opts.key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.turn(opts));
    this.queues.set(opts.key, next);
    void next.finally(() => {
      if (this.queues.get(opts.key) === next) this.queues.delete(opts.key);
    });
    return next;
  }

  /** Stop the running turn on a key, if any. */
  cancel(key: string): void {
    const record = this.config.sessions.get(key);
    if (record && this.peer) this.peer.notify("session/cancel", { sessionId: record.sessionId });
  }

  /** End a session for good (event sessions are disposable). */
  forget(key: string): void {
    const record = this.config.sessions.get(key);
    if (record) {
      this.loaded.delete(record.sessionId);
      this.live.delete(record.sessionId);
    }
    this.config.sessions.delete(key);
  }

  shutdown(): void {
    this.peer?.close(new Error("shutdown"));
    this.proc?.kill();
    this.peer = undefined;
    this.proc = undefined;
    this.ready = undefined;
  }

  private async turn(opts: { key: string; kind: SessionKind; text: string }): Promise<TurnResult> {
    try {
      await this.connect();
      const sessionId = await this.session(opts.key, opts.kind);
      const live: Live = { text: [], toolCalls: 0, key: opts.key, kind: opts.kind };
      this.live.set(sessionId, live);
      try {
        const result = await this.peer!.request("session/prompt", { sessionId, prompt: [{ type: "text", text: opts.text }] });
        const stopReason = typeof result === "object" && result !== null && "stopReason" in result ? String(result.stopReason) : "end_turn";
        return { kind: "reply", text: live.text.join("").trim(), stopReason, toolCalls: live.toolCalls };
      } finally {
        this.live.delete(sessionId);
      }
    } catch (error) {
      if (error instanceof RpcError && (error.code === AUTH_REQUIRED || /auth/i.test(error.message))) {
        return { kind: "auth_required", message: error.message };
      }
      if (this.peer?.isClosed) this.shutdown();
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private connect(): Promise<void> {
    if (this.ready && this.peer && !this.peer.isClosed) return this.ready;
    const proc = this.config.spawn();
    const peer = new JsonRpcPeer((line) => proc.stdin.write(line), {
      onRequest: (method, params) => this.onAgentRequest(method, params),
      onNotification: (method, params) => this.onAgentNotification(method, params),
    });
    this.proc = proc;
    this.peer = peer;
    this.loaded.clear();
    void peer.pump(proc.stdout);
    void proc.exited.then(() => peer.close(new Error("kiro-cli exited")));
    this.ready = peer
      .request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "peril", version: "0.1.0" },
      })
      .then(() => undefined);
    return this.ready;
  }

  private mcpServers(key: string): unknown[] {
    return [{ type: "http", name: "peril", url: this.config.mcpUrl, headers: [{ name: "x-peril-scope", value: key }] }];
  }

  private async session(key: string, kind: SessionKind): Promise<string> {
    const peer = this.peer!;
    const known = this.config.sessions.get(key);
    if (known && this.loaded.has(known.sessionId)) return known.sessionId;
    if (known) {
      try {
        await peer.request("session/load", { sessionId: known.sessionId, cwd: this.config.cwd, mcpServers: this.mcpServers(key) });
        this.loaded.add(known.sessionId);
        return known.sessionId;
      } catch (error) {
        if (error instanceof RpcError && error.code === AUTH_REQUIRED) throw error;
        this.config.sessions.delete(key);
      }
    }
    const modelId = this.config.models[kind];
    const created = await peer.request("session/new", {
      cwd: this.config.cwd,
      mcpServers: this.mcpServers(key),
      ...(modelId ? { _meta: { kiro: { modelId } } } : {}),
    });
    const sessionId = typeof created === "object" && created !== null && "sessionId" in created ? String(created.sessionId) : "";
    if (!sessionId) throw new Error("session/new returned no sessionId");
    this.config.sessions.set(key, { sessionId, kind });
    this.loaded.add(sessionId);
    return sessionId;
  }

  private onAgentNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const parsed = textOf(params);
    if (!parsed) return;
    const live = this.live.get(parsed.sessionId);
    if (!live) return;
    const update = parsed.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && typeof content.text === "string") live.text.push(content.text);
    } else if (update.sessionUpdate === "tool_call") {
      live.toolCalls += 1;
      const cap = this.config.eventToolCallCap ?? DEFAULT_EVENT_CAP;
      if (live.kind === "event" && live.toolCalls > cap) this.peer?.notify("session/cancel", { sessionId: parsed.sessionId });
    }
  }

  private async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") throw new RpcError(-32601, `method not supported: ${method}`);
    const p = (params ?? {}) as { sessionId?: string; toolCall?: { title?: string; kind?: unknown }; options?: Array<{ optionId: string; kind: string }> };
    const live = p.sessionId ? this.live.get(p.sessionId) : undefined;
    const title = p.toolCall?.title ?? "";
    const fromPerilMcp = [...this.config.perilToolNames].some((name) => title.includes(name));
    const verdict = permissionFor({
      session: live?.kind ?? "chat",
      tainted: live ? this.config.isTainted(live.key) : true,
      toolKind: isToolKind(p.toolCall?.kind) ? p.toolCall.kind : "other",
      fromPerilMcp,
    });
    const wanted = verdict === "allow" ? "allow_once" : "reject_once";
    const option = p.options?.find((o) => o.kind === wanted) ?? p.options?.find((o) => o.kind.startsWith(verdict === "allow" ? "allow" : "reject"));
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }
}
