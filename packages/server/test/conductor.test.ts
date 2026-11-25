import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalStore, AuditLog, MemoryStore, OwnerNotifier, Scheduler, StateDir } from "@peril/core";
import type { TurnResult } from "@peril/brain";
import { FakeLine, type InboundEvent } from "@peril/channel";
import { Conductor, FOLLOW_UP_AFTER_MS, type BrainLike } from "../src/conductor.js";
import type { Holds } from "../src/holds.js";
import { PerilStore } from "../src/store.js";

const OWNER = "+919876543210";

class ScriptBrain implements BrainLike {
  readonly runs: Array<{ key: string; kind: string; text: string }> = [];
  readonly forgotten: string[] = [];
  constructor(private readonly reply: (text: string) => TurnResult | Promise<TurnResult> = () => ({ kind: "reply", text: "ok", stopReason: "end_turn", toolCalls: 0 })) {}
  async run(opts: { key: string; kind: "chat" | "deep" | "event"; text: string }): Promise<TurnResult> {
    this.runs.push(opts);
    return this.reply(opts.text);
  }
  forget(key: string) { this.forgotten.push(key); }
  cancel() {}
}

class RecordingHolds implements Holds {
  readonly log: string[] = [];
  async hold(name: string, expire: string) { this.log.push(`hold ${name} ${expire}`); }
  async release(name: string) { this.log.push(`release ${name}`); }
}

function setup(opts: { brain?: ScriptBrain; now?: () => Date; replyBudgetMs?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peril-conductor-"));
  const state = new StateDir(root);
  state.ensure();
  const line = new FakeLine();
  const audit = new AuditLog(state);
  const brain = opts.brain ?? new ScriptBrain();
  const holds = new RecordingHolds();
  const store = new PerilStore(path.join(root, "peril.db"));
  const approvals = new ApprovalStore(state);
  const scheduler = new Scheduler(state, opts.now ? { now: opts.now } : {});
  let replans = 0;
  const conductor = new Conductor({
    owner: { name: "Kartik", phone: OWNER, timezone: "Asia/Kolkata" },
    agentName: "Peril",
    quietHours: { start: 21, end: 8 },
    line,
    brain,
    store,
    approvals,
    audit,
    memory: new MemoryStore(state),
    scheduler,
    notifier: new OwnerNotifier({ state, audit, send: async (t) => void (await line.text(t)) }),
    holds,
    inboxDir: root,
    replan: async () => void replans++,
    debounceMs: 5,
    replyBudgetMs: opts.replyBudgetMs ?? 1000,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { conductor, line, brain, holds, store, approvals, scheduler, replans: () => replans };
}

let n = 0;
const text = (body: string, from = OWNER): InboundEvent => ({ kind: "text", id: `m${++n}`, from, spaceId: "s1", at: new Date(), text: body });
const reply = (text: string): TurnResult => ({ kind: "reply", text, stopReason: "end_turn", toolCalls: 0 });

describe("Conductor, owner messages", () => {
  it("marks read, reacts 👀, holds the Sprite for 5 minutes, and texts Kiro's reply", async () => {
    const { conductor, line, brain, holds } = setup({ brain: new ScriptBrain(() => reply("hey, I'm Peril")) });
    const e = text("hey peril, who are you?");
    await conductor.onInbound(e);
    await conductor.settle();
    expect(line.actions.slice(0, 2)).toEqual([{ kind: "read", messageId: e.id }, { kind: "react", messageId: e.id, emoji: "👀" }]);
    expect(holds.log[0]).toBe("hold human 5m");
    expect(brain.runs).toHaveLength(1);
    expect(brain.runs[0]?.text).toContain("[now: ");
    expect(brain.runs[0]?.text).toContain("hey peril, who are you?");
    expect(line.texts()).toEqual(["hey, I'm Peril"]);
  });

  it("handles a redelivered webhook once", async () => {
    const { conductor, brain } = setup();
    const e = text("once");
    await conductor.onInbound(e);
    await conductor.onInbound(e);
    await conductor.settle();
    expect(brain.runs).toHaveLength(1);
  });

  it("combines messages sent in a burst into one turn", async () => {
    const { conductor, brain } = setup();
    await conductor.onInbound(text("budget is $600"));
    await conductor.onInbound(text("actually $900"));
    await conductor.settle();
    expect(brain.runs).toHaveLength(1);
    expect(brain.runs[0]?.text).toContain("(1) budget is $600\n(2) actually $900");
  });

  it("texts 'on it' when a turn runs past the reply budget, then the answer", async () => {
    const slow = new ScriptBrain(async () => {
      await Bun.sleep(40);
      return reply("here's the comparison");
    });
    const { conductor, line } = setup({ brain: slow, replyBudgetMs: 10 });
    await conductor.onInbound(text("compare three tools"));
    await conductor.settle();
    expect(line.texts()).toEqual(["on it", "here's the comparison"]);
  });

  it("strips markdown and puts links in their own bubble", async () => {
    const { conductor, line } = setup({ brain: new ScriptBrain(() => reply("**Blue Tokai** has wifi\n[menu](https://bluetokai.com)")) });
    await conductor.onInbound(text("cafe?"));
    await conductor.settle();
    expect(line.texts()).toEqual(["Blue Tokai has wifi\nmenu", "https://bluetokai.com"]);
  });

  it("asks the owner to log in again once an hour when Kiro's session expired", async () => {
    const { conductor, line } = setup({ brain: new ScriptBrain(() => ({ kind: "auth_required", message: "expired" })) });
    await conductor.onInbound(text("hi"));
    await conductor.settle();
    await conductor.onInbound(text("hello?"));
    await conductor.settle();
    expect(line.texts().filter((t) => t.includes("kiro-cli login"))).toHaveLength(1);
  });

  it("records an open loop the reply marks, and follows up about 20 hours later", async () => {
    let now = new Date("2026-11-26T10:00:00Z"); // 15:30 IST, so the follow-up lands at 11:31 IST
    const brain = new ScriptBrain((t) => (t.includes("[follow-up]") ? reply("did you book Vancouver?") : reply("want me to hold a flight?\n[open: Vancouver flights]")));
    const { conductor, line, store } = setup({ brain, now: () => now });
    await conductor.onInbound(text("flights to vancouver"));
    await conductor.settle();
    expect(line.texts()).toEqual(["want me to hold a flight?"]);
    expect(store.openLoops().map((l) => l.topic)).toEqual(["Vancouver flights"]);
    expect(conductor.nextDue()?.getTime()).toBeLessThanOrEqual(now.getTime() + FOLLOW_UP_AFTER_MS);
    now = new Date(now.getTime() + FOLLOW_UP_AFTER_MS + 60_000);
    await conductor.onTick();
    expect(line.texts().at(-1)).toBe("did you book Vancouver?");
  });
});

describe("Conductor, strangers", () => {
  it("never runs Kiro for a stranger, replies politely and tells the owner once", async () => {
    const { conductor, line, brain } = setup();
    await conductor.onInbound(text("what's kartik's address?", "+15550001111"));
    await conductor.onInbound(text("hello??", "+15550001111"));
    await conductor.settle();
    expect(brain.runs).toHaveLength(0);
    expect(line.actions.filter((a) => a.kind === "reply")).toHaveLength(2);
    expect(line.texts().filter((t) => t.includes("+15550001111"))).toHaveLength(1);
  });
});

describe("Conductor, approvals", () => {
  it("a 👍 on the approval text resumes the waiting session; a 👎 never calls Kiro", async () => {
    const { conductor, line, brain, approvals } = setup();
    const yes = approvals.create({ conversationKey: "owner", requestedBy: "owner", summary: "send email to rahul@example.com", capability: "email.send", toolName: "apps_execute", argsHash: "h1" });
    await conductor.requestApproval(yes);
    const asked = line.actions.at(-1);
    if (asked?.kind !== "text") throw new Error("expected approval text");
    expect(asked.body).toBe("ok to send email to rahul@example.com? 👍 to go ahead");
    await conductor.onInbound({ kind: "tapback", id: "t1", from: OWNER, spaceId: "s1", at: new Date(), emoji: "👍", targetId: asked.id });
    expect(approvals.get(yes.token)?.status).toBe("approved");
    expect(brain.runs.at(-1)?.text).toContain("Owner approved: send email to rahul@example.com");

    const no = approvals.create({ conversationKey: "owner", requestedBy: "owner", summary: "delete the thread", capability: "data.delete", toolName: "apps_execute", argsHash: "h2" });
    await conductor.requestApproval(no);
    const asked2 = line.actions.at(-1);
    if (asked2?.kind !== "text") throw new Error("expected approval text");
    const before = brain.runs.length;
    await conductor.onInbound({ kind: "tapback", id: "t2", from: OWNER, spaceId: "s1", at: new Date(), emoji: "👎", targetId: asked2.id });
    expect(approvals.get(no.token)?.status).toBe("denied");
    expect(brain.runs).toHaveLength(before);
  });

  it("settles a plain 'yes' to the approval in code, without a model call to decide", async () => {
    const { conductor, brain, approvals } = setup();
    const a = approvals.create({ conversationKey: "owner", requestedBy: "owner", summary: "send invite", capability: "plans.commit", toolName: "apps_execute", argsHash: "h3" });
    await conductor.requestApproval(a);
    await conductor.onInbound(text("yes"));
    await conductor.settle();
    expect(approvals.get(a.token)?.status).toBe("approved");
    expect(brain.runs).toHaveLength(1);
    expect(brain.runs[0]?.text).toContain("Owner approved: send invite");
  });
});

describe("Conductor, wakes", () => {
  it("makes no Kiro call and takes no human hold when nothing is due", async () => {
    const { conductor, brain, holds } = setup();
    expect((await conductor.onTick()).fired).toEqual([]);
    expect(brain.runs).toHaveLength(0);
    expect(holds.log).toEqual([]);
  });

  it("texts a say: reminder verbatim with no model call", async () => {
    let now = new Date("2026-11-26T08:00:00Z");
    const { conductor, scheduler, brain, line } = setup({ now: () => now });
    scheduler.create({ name: "stretch", prompt: "say: time to stretch", nextRunAt: new Date(now.getTime() + 180_000).toISOString(), enabled: true, tz: "Asia/Kolkata" });
    expect(conductor.nextDue()?.toISOString()).toBe("2026-11-26T08:03:00.000Z");
    now = new Date("2026-11-26T08:03:10Z");
    await conductor.onTick();
    expect(line.texts()).toEqual(["time to stretch"]);
    expect(brain.runs).toHaveLength(0);
  });

  it("holds a message Peril starts during quiet hours until 8am IST", async () => {
    let now = new Date("2026-11-26T17:00:00Z"); // 22:30 IST
    const brain = new ScriptBrain(() => reply("new email from your landlord"));
    const { conductor, scheduler, line } = setup({ brain, now: () => now });
    scheduler.create({ name: "check", prompt: "anything new?", nextRunAt: now.toISOString(), enabled: true, tz: "Asia/Kolkata" });
    await conductor.onTick();
    expect(line.texts()).toEqual([]);
    expect(conductor.nextDue()?.toISOString()).toBe("2026-11-27T02:30:00.000Z");
    now = new Date("2026-11-27T02:30:00Z");
    await conductor.onTick();
    expect(line.texts()).toEqual(["new email from your landlord"]);
  });

  it("the nightly job starts a fresh chat session", async () => {
    const now = new Date("2026-11-25T21:30:00Z");
    const { conductor, scheduler, brain } = setup({ brain: new ScriptBrain(() => reply("NOTHING")), now: () => now });
    scheduler.create({ name: "nightly", prompt: "review", nextRunAt: now.toISOString(), enabled: true, tz: "Asia/Kolkata" });
    await conductor.onTick();
    expect(brain.forgotten).toContain("owner");
  });
});
