/**
 * Boot Peril: one process, one SQLite file, one Kiro child. Run as a Sprite service; see
 * deploy/sprite/setup.sh.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ApprovalStore,
  AuditLog,
  MemoryStore,
  OwnerNotifier,
  PolicyEngine,
  ReceiptStore,
  Scheduler,
  StateDir,
  ToolRegistry,
  MemoryIndex,
  coreTools,
  memorySearchTool,
  defaultConfig,
  perilPolicy,
  type InstinctConfig,
  type Outbox,
} from "@peril/core";
import { Brain, FileSessionStore, spawnKiro } from "@peril/brain";
import { FakeLine, PhotonLine, type InboundEvent } from "@peril/channel";
import { Guard, appsTools, classify, gatewayTransport } from "@peril/tools-mcp";
import { localApp, publicApp } from "./app.js";
import { WakePlanner, cronJobGateway } from "./clock.js";
import { Conductor } from "./conductor.js";
import { loadEnv } from "./env.js";
import { noHolds, spriteHolds } from "./holds.js";
import { perilTools } from "./peril-tools.js";
import { PerilStore } from "./store.js";
import { WatcherStore, watcherTools } from "./watchers.js";
import { composioEventsHandler } from "./events.js";
import { CodeBox, agentBrowserFill, codeTools } from "./codebox.js";
import { whisperTranscriber } from "./voice.js";

const env = loadEnv();
const state = new StateDir(env.dataDir);
state.ensure();
const inboxDir = state.path("inbox");
for (const dir of [env.workspace, inboxDir]) fs.mkdirSync(dir, { recursive: true });

const dbPath = state.path("peril.db");
const store = new PerilStore(dbPath);
const receipts = new ReceiptStore({ path: dbPath });
const audit = new AuditLog(state);
const approvals = new ApprovalStore(state);
const memory = new MemoryStore(state);
const scheduler = new Scheduler(state);
const policy = new PolicyEngine(perilPolicy(), { spentTodayUsd: () => audit.spentTodayUsd(env.owner.timezone) });

const config: InstinctConfig = defaultConfig();
config.owner = { name: env.owner.name, phones: env.owner.phone ? [env.owner.phone] : [], emails: env.owner.email ? [env.owner.email] : [], timezone: env.owner.timezone };
config.agent = { name: env.agentName };

const ownerSpace = store.getValue("owner-space");
const line = env.photon
  ? await PhotonLine.connect(env.photon, { phone: env.owner.phone, ...(ownerSpace ? { spaceId: ownerSpace } : {}) })
  : new FakeLine();
if (line instanceof FakeLine) process.stderr.write("peril: Photon is not configured; owner texts go to the dev log only\n");

const outbox: Outbox = { send: async (msg) => void (await line.text(msg.text)) };
const notifier = new OwnerNotifier({ state, audit, send: async (text) => void (await line.text(text)) });
const holds = env.spriteSocket ? spriteHolds(env.spriteSocket) : noHolds;

const registry = new ToolRegistry();
let conductor: Conductor;
const watchers = new WatcherStore(state, { workspace: env.workspace });
const checkpoint = async () => {
  if (!env.spriteSocket) return;
  await Bun.spawn(["sprite-env", "checkpoints", "create"], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => undefined);
};
registry.registerMany(coreTools({ memory, scheduler, approvals, audit, config, outbox, workspaceDir: env.workspace }));
registry.register(memorySearchTool(new MemoryIndex(state)));
const codes = new CodeBox();
registry.registerMany(codeTools({ codes, fill: agentBrowserFill, ask: async (t) => void (await line.text(t)) }));
registry.registerMany(watcherTools({ watchers, startDeepTask: (o) => conductor.startDeepTask(o), checkpoint }));
registry.registerMany(perilTools({ line, scopes: store, roots: [env.workspace, inboxDir], startDeepTask: (o) => conductor.startDeepTask(o) }));
if (env.composio) {
  registry.registerMany(appsTools({ transport: gatewayTransport({ baseUrl: env.composio.gatewayUrl }), userId: env.composio.userId, toolkits: env.composio.toolkits }));
}

const mcpPort = env.port + 1;
const brain = new Brain({
  spawn: () => spawnKiro({ bin: env.kiroBin, cwd: env.workspace }),
  cwd: env.workspace,
  models: { chat: env.models.chat, deep: env.models.deep, event: env.models.chat },
  mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
  sessions: new FileSessionStore(state.path("sessions.json")),
  isTainted: (key) => store.isTainted(key),
  perilToolNames: new Set(registry.all().map((t) => t.spec.name)),
});

const owner = { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: env.owner.name };
const guard = new Guard({ registry, policy, approvals, audit, receipts, state, scopes: store, owner, classify, requestApproval: (a) => conductor.requestApproval(a) });

const tickUrl = env.publicUrl && env.tickKey ? `${env.publicUrl}/tick?key=${encodeURIComponent(env.tickKey)}` : undefined;
const planner = new WakePlanner({
  api: env.cronJob ? cronJobGateway({ baseUrl: env.cronJob.gatewayUrl }) : undefined,
  store: {
    get: () => JSON.parse(store.getValue("wake") ?? "{}") as { jobId?: number; nextAt?: string },
    set: (v) => store.setValue("wake", JSON.stringify(v)),
  },
  tickUrl,
  tz: env.owner.timezone,
});

conductor = new Conductor({
  owner: env.owner,
  agentName: env.agentName,
  quietHours: env.quietHours,
  line,
  brain,
  store,
  approvals,
  audit,
  memory,
  scheduler,
  notifier,
  holds,
  inboxDir,
  watchers,
  codes,
  ...(() => {
    const transcribe = whisperTranscriber({ whisperBin: process.env.PERIL_WHISPER_BIN ?? "whisper-cli", model: process.env.PERIL_WHISPER_MODEL ?? path.join(env.dataDir, "models", "ggml-base.bin") });
    return transcribe ? { transcribe } : {};
  })(),
  replan: async () => {
    try {
      await planner.plan(conductor.nextDue());
    } catch (error) {
      audit.append({ kind: "error", detail: { message: `wake planner: ${error instanceof Error ? error.message : String(error)}` } });
    }
  },
});

for (const seed of [
  { name: "briefing", cron: env.briefingCron, prompt: "Morning briefing. Check today's calendar and the email that matters, and anything left open. Send one short briefing, or NOTHING if the day is empty." },
  { name: "nightly", cron: env.nightlyCron, prompt: "Nightly review. Read today's journal and memory. Propose at most 3 memory changes as one short text the owner can thumbs-up, or reply NOTHING." },
]) {
  if (!scheduler.list().some((e) => e.name === seed.name)) scheduler.create({ ...seed, tz: env.owner.timezone, enabled: true });
}

const onEvent = (event: InboundEvent) => conductor.onInbound(event);
const pub = publicApp({
  agentName: env.agentName,
  photonWebhook: line instanceof PhotonLine ? (req) => line.handleWebhook(req, onEvent) : undefined,
  tickKey: env.tickKey,
  onTick: () => conductor.onTick(),
  appEvents: env.composioWebhookSecret
    ? composioEventsHandler({
        secret: env.composioWebhookSecret,
        firstSight: (id) => store.firstSight(id),
        memory: () => memory.readDurable(),
        onSkipped: (e) => audit.append({ kind: "inbound", detail: { appEvent: e.slug, skipped: true } }),
        onImportant: (e, why) =>
          conductor.eventTurn({ id: e.id, source: e.slug, body: why.body, instruction: `New ${e.slug.toLowerCase().replace(/_/g, " ")} (${why.reason}). Decide whether Kartik needs to know now; if so, write one short text.` }),
      })
    : undefined,
});
const local = localApp(guard);
local.post("/dev/say", async (c) => {
  const body = (await c.req.json()) as { text?: string };
  await onEvent({ kind: "text", id: `dev_${Date.now()}`, from: env.owner.phone, spaceId: "dev", at: new Date(), text: String(body.text ?? "") });
  await conductor.settle();
  return c.json({ sent: line instanceof FakeLine ? line.texts() : "via photon" });
});

Bun.serve({ port: env.port, hostname: "0.0.0.0", fetch: pub.fetch });
Bun.serve({ port: mcpPort, hostname: "127.0.0.1", fetch: local.fetch });
await conductor.onTick();
process.stderr.write(`peril: listening on :${env.port}, MCP on 127.0.0.1:${mcpPort}, workspace ${path.resolve(env.workspace)}\n`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    brain.shutdown();
    process.exit(0);
  });
}
