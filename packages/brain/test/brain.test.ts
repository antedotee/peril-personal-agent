import { describe, expect, it } from "bun:test";
import { Brain, type SessionRecord, type SessionStore } from "../src/brain.js";
import { fakeAgent, type FakeScript } from "../src/fake-agent.js";
import { permissionFor } from "../src/permissions.js";

class MemorySessions implements SessionStore {
  readonly map = new Map<string, SessionRecord>();
  get(key: string) { return this.map.get(key); }
  set(key: string, r: SessionRecord) { this.map.set(key, r); }
  delete(key: string) { this.map.delete(key); }
}

function makeBrain(script: FakeScript, opts: { sessions?: MemorySessions; tainted?: boolean; known?: Set<string> } = {}) {
  const sessions = opts.sessions ?? new MemorySessions();
  const agent = fakeAgent(script, undefined, opts.known);
  const brain = new Brain({
    spawn: agent.spawn,
    cwd: "/tmp",
    models: { chat: "fast-model", deep: "strong-model", event: "fast-model" },
    mcpUrl: "http://127.0.0.1:8080/mcp",
    sessions,
    isTainted: () => opts.tainted ?? false,
    perilToolNames: new Set(["memory_write"]),
    eventToolCallCap: 3,
  });
  return { brain, log: agent.log, sessions };
}

describe("Brain over ACP", () => {
  it("creates one session per key with the model for its kind, then reuses it", async () => {
    const { brain, log } = makeBrain({ reply: (t) => `echo ${t}` });
    const first = await brain.run({ key: "owner", kind: "chat", text: "hi peril" });
    expect(first).toMatchObject({ kind: "reply", text: "echo hi peril" });
    await brain.run({ key: "owner", kind: "chat", text: "again" });
    await brain.run({ key: "task:1", kind: "deep", text: "build it" });
    expect(log.newSessions.map((s) => s.modelId)).toEqual(["fast-model", "strong-model"]);
    expect(log.newSessions[0]?.mcpServers).toEqual([{ type: "http", name: "peril", url: "http://127.0.0.1:8080/mcp", headers: [{ name: "x-peril-scope", value: "owner" }] }]);
    expect(new Set(log.prompts.slice(0, 2).map((p) => p.sessionId)).size).toBe(1);
  });

  it("resumes a stored session with session/load after a restart", async () => {
    const sessions = new MemorySessions();
    const known = new Set<string>();
    const a = makeBrain({ reply: () => "ok" }, { sessions, known });
    await a.brain.run({ key: "owner", kind: "chat", text: "remember this" });
    a.brain.shutdown();
    const b = makeBrain({ reply: () => "still here" }, { sessions, known });
    const result = await b.brain.run({ key: "owner", kind: "chat", text: "and now?" });
    expect(result).toMatchObject({ kind: "reply", text: "still here" });
    expect(b.log.loads).toEqual([sessions.get("owner")!.sessionId]);
    expect(b.log.newSessions).toHaveLength(0);
  });

  it("starts a fresh session when the stored one cannot be loaded", async () => {
    const sessions = new MemorySessions();
    sessions.set("owner", { sessionId: "gone", kind: "chat" });
    const { brain, log } = makeBrain({ reply: () => "fresh" }, { sessions });
    expect(await brain.run({ key: "owner", kind: "chat", text: "hi" })).toMatchObject({ kind: "reply", text: "fresh" });
    expect(log.newSessions).toHaveLength(1);
    expect(sessions.get("owner")?.sessionId).not.toBe("gone");
  });

  it("reports auth_required so the server can text a fresh login code", async () => {
    const { brain } = makeBrain({ reply: () => "", authRequired: true });
    expect((await brain.run({ key: "owner", kind: "chat", text: "hi" })).kind).toBe("auth_required");
  });

  it("runs turns on one key in order", async () => {
    const { brain } = makeBrain({ reply: (t) => t, delayMs: 20 });
    const [a, b] = await Promise.all([
      brain.run({ key: "owner", kind: "chat", text: "one" }),
      brain.run({ key: "owner", kind: "chat", text: "two" }),
    ]);
    expect(a).toMatchObject({ text: "one" });
    expect(b).toMatchObject({ text: "two" });
  });

  it("cancels an event session that passes its tool-call cap", async () => {
    const { brain, log } = makeBrain({ reply: () => "done", toolCalls: 10 });
    const result = await brain.run({ key: "event:1", kind: "event", text: "check mail" });
    expect(result).toMatchObject({ kind: "reply", stopReason: "cancelled" });
    expect(log.cancels).toHaveLength(1);
  });

  it("refuses a shell call from the chat session and allows it in a clean deep session", async () => {
    const chat = makeBrain({ reply: () => "ok", permission: { title: "run_command", kind: "execute" } });
    await chat.brain.run({ key: "owner", kind: "chat", text: "rm -rf" });
    expect(chat.log.permissionOutcomes[0]).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    const deep = makeBrain({ reply: () => "ok", permission: { title: "run_command", kind: "execute" } });
    await deep.brain.run({ key: "task:1", kind: "deep", text: "build" });
    expect(deep.log.permissionOutcomes[0]).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("refuses a shell call in a deep session that read outside content", async () => {
    const { brain, log } = makeBrain({ reply: () => "ok", permission: { title: "run_command", kind: "execute" } }, { tainted: true });
    await brain.run({ key: "task:1", kind: "deep", text: "build" });
    expect(log.permissionOutcomes[0]).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });
});

describe("permissionFor", () => {
  it("always allows Peril's own MCP tools, which run their own policy guard", () => {
    expect(permissionFor({ session: "chat", tainted: true, toolKind: "execute", fromPerilMcp: true })).toBe("allow");
  });
  it("allows reads everywhere", () => {
    expect(permissionFor({ session: "event", tainted: true, toolKind: "read", fromPerilMcp: false })).toBe("allow");
  });
});
