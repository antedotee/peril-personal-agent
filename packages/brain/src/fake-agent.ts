/**
 * An in-process ACP agent for tests. It speaks the same NDJSON JSON-RPC as `kiro-cli acp`
 * and answers each prompt with a scripted reply, optionally asking for permission first.
 */
import type { AgentProcess } from "./brain.js";
import { JsonRpcPeer, RpcError } from "./jsonrpc.js";

export interface FakeScript {
  reply: (prompt: string, sessionId: string) => string;
  /** Ask the client for permission before replying. */
  permission?: { title: string; kind: string };
  /** Emit this many tool_call updates before replying. */
  toolCalls?: number;
  delayMs?: number;
  authRequired?: boolean;
}

export interface FakeAgentLog {
  newSessions: Array<{ modelId?: string; mcpServers: unknown }>;
  loads: string[];
  prompts: Array<{ sessionId: string; text: string }>;
  permissionOutcomes: unknown[];
  cancels: string[];
}

export function fakeAgent(script: FakeScript, log: FakeAgentLog = { newSessions: [], loads: [], prompts: [], permissionOutcomes: [], cancels: [] }, known: Set<string> = new Set()): { spawn: () => AgentProcess; log: FakeAgentLog } {
  let counter = known.size;
  const spawn = (): AgentProcess => {
    let toClient: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (toClient = c) });
    const enc = new TextEncoder();
    let exit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((r) => (exit = r));
    const cancelled = new Set<string>();
    const peer: JsonRpcPeer = new JsonRpcPeer((line) => toClient?.enqueue(enc.encode(line)), {
      onNotification: (method, params) => {
        if (method === "session/cancel") {
          const id = String((params as { sessionId: string }).sessionId);
          log.cancels.push(id);
          cancelled.add(id);
        }
      },
      onRequest: async (method, params) => {
        const p = (params ?? {}) as Record<string, unknown>;
        if (script.authRequired && method !== "initialize") throw new RpcError(-32000, "Authentication required");
        switch (method) {
          case "initialize":
            return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
          case "session/new": {
            const id = `sess_${++counter}`;
            known.add(id);
            const meta = p._meta as { kiro?: { modelId?: string } } | undefined;
            log.newSessions.push({ ...(meta?.kiro?.modelId ? { modelId: meta.kiro.modelId } : {}), mcpServers: p.mcpServers });
            return { sessionId: id };
          }
          case "session/load": {
            const id = String(p.sessionId);
            if (!known.has(id)) throw new RpcError(-32602, "unknown session");
            log.loads.push(id);
            return {};
          }
          case "session/prompt": {
            const sessionId = String(p.sessionId);
            const text = ((p.prompt as Array<{ text?: string }>)[0]?.text ?? "").toString();
            log.prompts.push({ sessionId, text });
            if (script.permission) {
              const outcome = await peer.request("session/request_permission", {
                sessionId,
                toolCall: { toolCallId: "tc1", title: script.permission.title, kind: script.permission.kind },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "reject", name: "Reject", kind: "reject_once" },
                ],
              });
              log.permissionOutcomes.push(outcome);
            }
            for (let i = 0; i < (script.toolCalls ?? 0); i++) {
              if (cancelled.has(sessionId)) return { stopReason: "cancelled" };
              peer.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: `t${i}`, title: "x", kind: "read" } });
              await Bun.sleep(1);
            }
            if (script.delayMs) await Bun.sleep(script.delayMs);
            if (cancelled.delete(sessionId)) return { stopReason: "cancelled" };
            for (const part of script.reply(text, sessionId).match(/.{1,8}/gs) ?? []) {
              peer.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } } });
            }
            return { stopReason: "end_turn" };
          }
          default:
            throw new RpcError(-32601, `unknown method ${method}`);
        }
      },
    });
    const stdinStream = { write: (line: string) => line.split("\n").filter(Boolean).forEach((l) => peer.receive(l)) };
    return { stdin: stdinStream, stdout, exited, kill: () => { toClient?.close(); exit(0); } };
  };
  return { spawn, log };
}
