/**
 * The conductor decides whether Kiro runs at all. Plain code handles everything it can:
 * duplicates, strangers, read receipts, tapback approvals, plain yes/no answers, verbatim
 * reminders and quiet hours. Kiro runs only when a message needs judgment.
 */
import type { Approval, ApprovalStore, AuditLog, MemoryStore, OwnerNotifier, ScheduleEntry, Scheduler } from "@peril/core";
import { normalizeEmail, normalizePhone } from "@peril/core";
import type { TurnResult } from "@peril/brain";
import { TAPBACK, isApprove, isDeny, type InboundEvent, type OwnerLine, type ReplyLine } from "@peril/channel";
import type { McpCallResult, SessionKind } from "@peril/tools-mcp";
import { HUMAN_LINGER, during, type Holds } from "./holds.js";
import { isQuiet, nextAwake, type QuietHours } from "./clock.js";
import type { PerilStore } from "./store.js";
import { cleanReply, localTime } from "./text.js";
import type { WatcherStore } from "./watchers.js";
import type { CodeBox } from "./codebox.js";
import { wrapExternal } from "@peril/tools-mcp";

export interface BrainLike {
  run(opts: { key: string; kind: SessionKind; text: string }): Promise<TurnResult>;
  forget(key: string): void;
  cancel(key: string): void;
}

export interface ConductorDeps {
  owner: { name: string; phone: string; email?: string | undefined; timezone: string };
  agentName: string;
  quietHours: QuietHours;
  line: OwnerLine & ReplyLine & { adoptOwnerSpace?: (spaceId: string) => void };
  brain: BrainLike;
  store: PerilStore;
  approvals: ApprovalStore;
  audit: AuditLog;
  memory: MemoryStore;
  scheduler: Scheduler;
  notifier: OwnerNotifier;
  holds: Holds;
  /** Recompute and set the next cron-job.org wake. */
  replan: () => Promise<void>;
  /** Run an approved tool call through the guard. */
  runApproved?: (call: { name: string; args: unknown; scope: string }) => Promise<McpCallResult>;
  /** Files the owner sends land here. */
  inboxDir: string;
  saveFile?: (path: string, data: Buffer) => Promise<void>;
  watchers?: WatcherStore;
  codes?: CodeBox;
  /** Turns a voice memo into text, when whisper is installed. */
  transcribe?: (path: string) => Promise<string | undefined>;
  now?: () => Date;
  replyBudgetMs?: number;
  debounceMs?: number;
}

export const OWNER_KEY = "owner";
export const FOLLOW_UP_AFTER_MS = 20 * 60 * 60 * 1000;
/** A scheduled prompt that starts with this is texted as is, with no model call. */
export const SAY_PREFIX = "say:";
const AUTH_NOTICE_KEY = "auth-notice-at";
const AUTH_NOTICE_EVERY_MS = 60 * 60 * 1000;

export type Proactive = "requested" | "initiative";

export class Conductor {
  private readonly now: () => Date;
  private buffer: string[] = [];
  private bufferTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private deepCounter = 0;
  private turnCounter = 0;
  private ticking: Promise<{ fired: string[] }> | undefined;
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly deps: ConductorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  isOwner(from: string): boolean {
    const phone = normalizePhone(from);
    if (phone && phone === normalizePhone(this.deps.owner.phone)) return true;
    const email = normalizeEmail(from);
    return Boolean(email && this.deps.owner.email && email === normalizeEmail(this.deps.owner.email));
  }

  /** Wait for debounced and background work. Tests and graceful shutdown use it. */
  async settle(): Promise<void> {
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = undefined;
      this.flushing = this.flushing.then(() => this.flush()).catch((e: unknown) => this.logError("flush", e));
    }
    await this.flushing;
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Text the owner. Anything but an approval text means a bare "yes" no longer refers to that approval. */
  private async text(body: string): Promise<string | undefined> {
    const id = await this.deps.line.text(body);
    this.deps.approvals.clearPrompted();
    return id;
  }

  private logError(where: string, error: unknown): void {
    this.deps.audit.append({ kind: "error", conversationKey: OWNER_KEY, detail: { where, message: error instanceof Error ? error.message : String(error) } });
  }

  // Inbound ------------------------------------------------------------------

  async onInbound(event: InboundEvent): Promise<void> {
    const { store, line, audit } = this.deps;
    if (!store.firstSight(`imessage:${event.id}`, this.now())) return;
    if (!this.isOwner(event.from)) return this.onStranger(event);
    // iMessage chat ids carry ";-;" for a one-to-one chat and ";+;" for a group.
    if (!event.spaceId.includes(";+;")) {
      line.adoptOwnerSpace?.(event.spaceId);
      store.setValue("owner-space", event.spaceId);
    }
    await this.deps.holds.hold("human", HUMAN_LINGER);
    audit.append({ kind: "inbound", conversationKey: OWNER_KEY, principal: "owner", detail: { kind: event.kind } });
    store.clearOpenLoops();
    switch (event.kind) {
      case "tapback":
        return this.onTapback(event.emoji, event.targetId);
      case "text": {
        await line.markRead(event.id);
        if (this.deps.codes?.offer(event.text)) {
          await line.react(event.id, TAPBACK.done);
          return this.enqueue(`(${this.deps.owner.name} sent the ${this.deps.codes.waitingFor} code. Call fill_code with the input's ref.)`);
        }
        const answered = this.deps.approvals.matchReply(event.text);
        if (answered && answered.approval.status !== "pending") return this.afterVerdict(answered.approval, answered.approved);
        if (/^\s*\/fresh\s*$/i.test(event.text)) return this.freshStart(event.id);
        await line.react(event.id, TAPBACK.seen);
        return this.enqueue(event.text);
      }
      case "file":
        await line.markRead(event.id);
        return this.onFile(event);
      case "other":
        await line.markRead(event.id);
        return;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private async onStranger(event: InboundEvent): Promise<void> {
    const { line, notifier } = this.deps;
    if (event.kind === "text" || event.kind === "file") {
      await line.replyTo(event, `Hi, this is ${this.deps.agentName}, ${this.deps.owner.name}'s assistant. I only take requests from ${this.deps.owner.name}, so I can't help here.`);
    }
    await notifier.notify({ conversationKey: `imessage:${event.from}`, principal: `stranger:${event.from}`, action: "talk to you through me", outcome: "declined" }, event.from || "Someone");
  }

  private async onTapback(emoji: string, targetId: string): Promise<void> {
    const token = this.deps.store.approvalFor(targetId);
    if (!token) return;
    const approved = isApprove(emoji) ? true : isDeny(emoji) ? false : undefined;
    if (approved === undefined || this.deps.approvals.get(token)?.status !== "pending") return;
    const resolved = this.deps.approvals.resolve(token, approved);
    if (resolved) await this.afterVerdict(resolved, approved);
  }

  private async afterVerdict(approval: Approval, approved: boolean): Promise<void> {
    this.deps.audit.append({ kind: "approval", conversationKey: approval.conversationKey, principal: "owner", detail: { token: approval.token, status: approval.status, summary: approval.summary } });
    if (!approved) {
      this.note(approval.conversationKey, `Owner declined: ${approval.summary}. Do not do it.`);
      return;
    }
    const call = this.deps.store.callFor(approval.token);
    if (call && this.deps.runApproved) {
      const result = await during(this.deps.holds, `approved-${approval.token}`, () => this.deps.runApproved!(call));
      const detail = result.content.map((c) => (c.type === "text" ? c.text : "")).join(" ").slice(0, 300);
      this.note(call.scope, `Owner approved and Peril ran: ${approval.summary}. Result: ${detail}`);
      await this.text(result.isError ? `couldn't do it: ${detail.slice(0, 160)}` : `done ✅ ${approval.summary.slice(0, 120)}`);
      return;
    }
    const key = approval.conversationKey;
    await this.turn({
      key,
      kind: kindFor(key),
      text: `Owner approved: ${approval.summary}. Do it now with exactly the same arguments, then confirm to the owner in one short line.`,
      ownerTurn: true,
      proactive: "requested",
    });
  }

  private async onFile(event: Extract<InboundEvent, { kind: "file" }>): Promise<void> {
    const { saveFile, transcribe, inboxDir } = this.deps;
    const safe = event.name.replace(/[^\w.-]/g, "_").slice(0, 80) || "file";
    const path = `${inboxDir}/${Date.now()}-${safe}`;
    const data = await event.read();
    await (saveFile ?? ((p, d) => Bun.write(p, d).then(() => undefined)))(path, data);
    if (event.voice && transcribe) {
      const text = await transcribe(path);
      if (text) return this.enqueue(`(voice memo) ${text}`);
    }
    return this.enqueue(`(${this.deps.owner.name} sent a file: ${path}, ${event.mimeType})`);
  }

  /** "/fresh" drops the chat session and its taint. Memory carries over. */
  private freshStart(messageId: string): Promise<void> {
    this.deps.brain.forget(OWNER_KEY);
    this.deps.store.clearTaint(OWNER_KEY);
    return this.deps.line.react(messageId, TAPBACK.done);
  }

  private enqueue(text: string): void {
    this.buffer.push(text);
    if (this.bufferTimer) clearTimeout(this.bufferTimer);
    this.bufferTimer = setTimeout(() => {
      this.bufferTimer = undefined;
      this.flushing = this.flushing.then(() => this.flush()).catch((e: unknown) => this.logError("flush", e));
    }, this.deps.debounceMs ?? 2000);
  }

  private async flush(): Promise<void> {
    const texts = this.buffer;
    this.buffer = [];
    if (texts.length === 0) return;
    const text = texts.length === 1 ? texts[0]! : texts.map((t, i) => `(${i + 1}) ${t}`).join("\n");
    await this.turn({ key: OWNER_KEY, kind: "chat", text, ownerTurn: true, proactive: "requested", ack: true });
  }

  // Turns --------------------------------------------------------------------

  private pendingNotes(key: string): string[] {
    const raw = this.deps.store.getValue(`notes:${key}`);
    this.deps.store.setValue(`notes:${key}`, undefined);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  private note(key: string, text: string): void {
    const raw = this.deps.store.getValue(`notes:${key}`);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    list.push(text);
    this.deps.store.setValue(`notes:${key}`, JSON.stringify(list.slice(-10)));
  }

  /** The context Peril adds in front of a prompt: time, new notes, and memory when it changed. */
  private header(key: string): string {
    const { memory, store, owner, approvals } = this.deps;
    const now = this.now();
    const lines = [`[now: ${localTime(now, owner.timezone)} (${owner.timezone})]`];
    const digest = memory.digest(4000, now);
    const hash = String(Bun.hash(digest));
    if (digest && store.getValue(`digest:${key}`) !== hash) {
      lines.push(`[memory]\n${digest}`);
      store.setValue(`digest:${key}`, hash);
    }
    const pending = approvals.pending().filter((a) => a.conversationKey === key);
    if (pending.length) lines.push(`[waiting on the owner: ${pending.map((a) => a.summary).join("; ")}]`);
    for (const n of this.pendingNotes(key)) lines.push(`[${n}]`);
    return lines.join("\n");
  }

  async turn(opts: { key: string; kind: SessionKind; text: string; ownerTurn: boolean; proactive: Proactive; ack?: boolean }): Promise<TurnResult> {
    const { brain, line, store } = this.deps;
    store.setScope({ key: opts.key, kind: opts.kind, ownerTurn: opts.ownerTurn });
    const prompt = `${this.header(opts.key)}\n\n${opts.text}`;
    const run = during(this.deps.holds, `turn-${++this.turnCounter}`, () => brain.run({ key: opts.key, kind: opts.kind, text: prompt }));
    let acked = false;
    const budget = opts.ack
      ? setTimeout(() => {
          acked = true;
          this.text("on it").catch((e: unknown) => this.logError("ack", e));
        }, this.deps.replyBudgetMs ?? 20_000)
      : undefined;
    if (opts.ack) void line.typing(true).catch(() => undefined);
    const result = await run.finally(() => {
      if (budget) clearTimeout(budget);
      if (opts.ack) void line.typing(false).catch(() => undefined);
    });
    store.setScope({ key: opts.key, kind: opts.kind, ownerTurn: false });
    try {
      await this.deliver(opts.key, result, opts.proactive, acked);
    } catch (error) {
      this.logError("deliver", error);
    } finally {
      await this.deps.replan();
    }
    return result;
  }

  private async deliver(key: string, result: TurnResult, proactive: Proactive, acked: boolean): Promise<void> {
    if (result.kind === "auth_required") return this.authNotice();
    if (result.kind === "failed") {
      this.deps.audit.append({ kind: "error", conversationKey: OWNER_KEY, principal: "owner", detail: { message: result.message } });
      if (proactive === "requested") await this.text("something broke on my end, give me a minute and ask again");
      return;
    }
    const cleaned = cleanReply(result.text);
    if (cleaned.openLoop && key === OWNER_KEY) this.deps.store.addOpenLoop(cleaned.openLoop, this.now());
    if (cleaned.silent) {
      if (acked) await this.text("done");
      return;
    }
    for (const bubble of cleaned.bubbles) await this.say(bubble, proactive);
  }

  /** Text the owner. Messages Peril starts on its own wait out quiet hours. */
  async say(text: string, proactive: Proactive): Promise<void> {
    const { owner, quietHours, store, line, audit } = this.deps;
    const now = this.now();
    if (proactive === "initiative" && isQuiet(now, owner.timezone, quietHours)) {
      store.defer(text, nextAwake(now, owner.timezone, quietHours));
      return;
    }
    await this.text(text);
    audit.append({ kind: "outbound", conversationKey: OWNER_KEY, principal: "owner", detail: { chars: text.length, proactive } });
  }

  private async authNotice(): Promise<void> {
    const last = Number(this.deps.store.getValue(AUTH_NOTICE_KEY) ?? 0);
    if (this.now().getTime() - last < AUTH_NOTICE_EVERY_MS) return;
    this.deps.store.setValue(AUTH_NOTICE_KEY, String(this.now().getTime()));
    await this.text("my Kiro login expired. on your laptop run sprite console -s peril, then kiro-cli login --use-device-flow, and approve the code on your phone");
  }

  /** Called by the guard when a tool needs the owner's thumbs-up. */
  async requestApproval(approval: Approval, call?: { name: string; args: unknown; scope: string }): Promise<void> {
    if (call) this.deps.store.rememberCall(approval.token, call);
    const id = await this.deps.line.text(`ok to ${approval.summary}? 👍 to go ahead`);
    if (id) this.deps.store.linkApproval(id, approval.token);
    this.deps.approvals.markPrompted(approval.token);
  }

  // Deep work --------------------------------------------------------------------

  /** Hand a long job to a deep session and keep chatting. The result is texted when done. */
  startDeepTask(opts: { brief: string; tainted: boolean }): string {
    const key = `task:${this.now().getTime().toString(36)}${++this.deepCounter}`;
    if (opts.tainted) this.deps.store.taint(key, "handed off from a session that read outside content");
    const work = this.turn({
      key,
      kind: "deep",
      text: `${opts.brief}\n\nWhen done, reply with one short text for ${this.deps.owner.name}. Send any file you made with send_file first.`,
      ownerTurn: false,
      proactive: "requested",
    })
      .catch((e: unknown) => this.logError("deep task", e))
      .finally(() => {
        this.deps.brain.forget(key);
        this.background.delete(work);
      });
    this.background.add(work);
    return key;
  }

  // Wakes ----------------------------------------------------------------------

  /** Everything due at this minute, checked in code before any model call. One tick at a time. */
  onTick(): Promise<{ fired: string[] }> {
    if (this.ticking) return this.ticking;
    this.ticking = during(this.deps.holds, "tick", () => this.tick()).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async tick(): Promise<{ fired: string[] }> {
    const { scheduler, store, owner, quietHours } = this.deps;
    const now = this.now();
    const fired: string[] = [];
    if (!isQuiet(now, owner.timezone, quietHours)) {
      for (const d of store.dueDeferred(now)) {
        store.dropDeferred(d.id);
        fired.push(`deferred:${d.id}`);
        await this.text(d.text).catch((e: unknown) => this.logError("deferred", e));
      }
    }
    try {
      for (const entry of scheduler.due(now)) {
        scheduler.markRan(entry.id, now);
        fired.push(`schedule:${entry.id}`);
        await this.fire(entry).catch((e: unknown) => this.logError(`schedule ${entry.id}`, e));
      }
    for (const outcome of (await this.deps.watchers?.runDue()) ?? []) {
      if (outcome.kind === "hit") {
        fired.push(`watcher:${outcome.watcher.id}`);
        await this.eventTurn({ id: `watch-${outcome.watcher.id}-${now.getTime()}`, source: `watcher ${outcome.watcher.id}`, body: `${outcome.watcher.description}\n${outcome.summary}`, instruction: "A watcher Kartik set up just matched. Text him one short message about it." });
      } else if (outcome.kind === "failed" && outcome.watcher.failures === 3) {
        this.note(OWNER_KEY, `Watcher ${outcome.watcher.id} (${outcome.watcher.description}) has failed 3 times: ${outcome.error}`);
      }
    }
    const loops = store.openLoops();
    const oldest = loops[0];
    if (oldest && now.getTime() - Date.parse(oldest.at) >= FOLLOW_UP_AFTER_MS) {
      store.clearOpenLoops();
      fired.push("follow-up");
      await this.turn({
        key: OWNER_KEY,
        kind: "chat",
        text: `[follow-up] About ${Math.round((now.getTime() - Date.parse(oldest.at)) / 3_600_000)} hours ago these were left open: ${loops.map((l) => l.topic).join("; ")}. If a check-in still makes sense, write one short text asking about it. Otherwise reply NOTHING.`,
        ownerTurn: false,
        proactive: "initiative",
      });
    }
    } finally {
      await this.deps.replan();
    }
    return { fired };
  }

  private async fire(entry: ScheduleEntry): Promise<void> {
    const prompt = entry.prompt.trim();
    if (prompt.toLowerCase().startsWith(SAY_PREFIX)) {
      await this.say(prompt.slice(SAY_PREFIX.length).trim(), "requested");
      return;
    }
    if (entry.name === "nightly") {
      this.deps.brain.forget(OWNER_KEY);
      this.deps.store.clearTaint(OWNER_KEY);
    }
    await this.turn({ key: OWNER_KEY, kind: "chat", text: `[scheduled: ${entry.name ?? entry.id}] ${prompt}`, ownerTurn: false, proactive: "initiative" });
  }

  /**
   * An outside event (watcher hit, important email, calendar change) gets a fresh,
   * disposable session with a tool-call cap, so the main conversation never sees the raw text.
   */
  async eventTurn(opts: { id: string; source: string; body: string; instruction: string }): Promise<void> {
    const key = `event:${opts.id}`;
    this.deps.store.taint(key, opts.source);
    try {
      await this.turn({
        key,
        kind: "event",
        text: `${opts.instruction} If he doesn't need to know now, reply NOTHING.\n\n${wrapExternal({ source: opts.source, body: opts.body, owner: this.deps.owner.name })}`,
        ownerTurn: false,
        proactive: "initiative",
      });
    } finally {
      this.deps.brain.forget(key);
    }
  }

  /** The earliest moment anything is due, for the wake planner. */
  nextDue(): Date | undefined {
    const { scheduler, store } = this.deps;
    const times: number[] = [];
    for (const e of scheduler.list()) if (e.enabled && e.nextRunAt) times.push(Date.parse(e.nextRunAt));
    const deferred = store.nextDeferred();
    if (deferred) times.push(deferred.getTime());
    const loop = store.openLoops()[0];
    if (loop) times.push(Date.parse(loop.at) + FOLLOW_UP_AFTER_MS);
    const watcher = this.deps.watchers?.nextDue();
    if (watcher) times.push(watcher.getTime());
    return times.length ? new Date(Math.min(...times)) : undefined;
  }
}

function kindFor(key: string): SessionKind {
  return key.startsWith("task:") ? "deep" : key.startsWith("event:") ? "event" : "chat";
}
