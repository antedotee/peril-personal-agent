/**
 * Watchers: scripts a deep session writes once, then plain code runs on a schedule. A
 * watcher prints one JSON line `{"value": ..., "hit": bool, "summary": "..."}`. Kiro wakes
 * only when `hit` is true and the value changed since the last run.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool, resolveWorkspacePath, textResult, type RegisteredTool, type StateDir } from "@peril/core";

export interface Watcher {
  id: string;
  description: string;
  file: string;
  everyMinutes: number;
  nextRunAt: string;
  lastHash?: string;
  failures: number;
}

export type WatchOutcome =
  | { kind: "hit"; watcher: Watcher; summary: string }
  | { kind: "quiet"; watcher: Watcher }
  | { kind: "failed"; watcher: Watcher; error: string };

const FILE = "watchers.json";
const RUN_TIMEOUT_MS = 20_000;
const MIN_EVERY = 5;

export type ScriptRunner = (file: string, cwd: string) => Promise<{ code: number; stdout: string }>;

export const bunRunner: ScriptRunner = async (file, cwd) => {
  const proc = Bun.spawn(["bun", file], { cwd, stdout: "pipe", stderr: "ignore", timeout: RUN_TIMEOUT_MS });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
};

export function parseWatcherOutput(stdout: string): { value: unknown; hit: boolean; summary: string } | undefined {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as { value?: unknown; hit?: unknown; summary?: unknown };
    if (typeof parsed.hit !== "boolean") return undefined;
    return { value: parsed.value ?? null, hit: parsed.hit, summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : "" };
  } catch {
    return undefined;
  }
}

export class WatcherStore {
  constructor(
    private readonly state: StateDir,
    private readonly opts: { workspace: string; runner?: ScriptRunner; now?: () => Date },
  ) {}

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  list(): Watcher[] {
    return this.state.readJson<Watcher[]>(FILE, []);
  }

  private save(list: Watcher[]): void {
    this.state.writeJson(FILE, list);
  }

  register(input: { id: string; description: string; file: string; everyMinutes: number }): Watcher {
    const file = resolveWorkspacePath(this.opts.workspace, input.file);
    if (!file || !fs.existsSync(file)) throw new Error(`watcher script not found in the workspace: ${input.file}`);
    const watcher: Watcher = {
      id: input.id.replace(/[^\w-]/g, "").slice(0, 40) || `w${Date.now().toString(36)}`,
      description: input.description.slice(0, 200),
      file: path.relative(this.opts.workspace, file),
      everyMinutes: Math.max(MIN_EVERY, Math.round(input.everyMinutes)),
      nextRunAt: this.now().toISOString(),
      failures: 0,
    };
    this.save([...this.list().filter((w) => w.id !== watcher.id), watcher]);
    return watcher;
  }

  remove(id: string): boolean {
    const list = this.list();
    const next = list.filter((w) => w.id !== id);
    this.save(next);
    return next.length !== list.length;
  }

  nextDue(): Date | undefined {
    const times = this.list().map((w) => Date.parse(w.nextRunAt));
    return times.length ? new Date(Math.min(...times)) : undefined;
  }

  /** Run every due watcher. No model is involved here. */
  async runDue(): Promise<WatchOutcome[]> {
    const now = this.now();
    const runner = this.opts.runner ?? bunRunner;
    const list = this.list();
    const outcomes: WatchOutcome[] = [];
    for (const w of list) {
      if (Date.parse(w.nextRunAt) > now.getTime()) continue;
      w.nextRunAt = new Date(now.getTime() + w.everyMinutes * 60_000).toISOString();
      let result: { code: number; stdout: string };
      try {
        result = await runner(path.join(this.opts.workspace, w.file), this.opts.workspace);
      } catch (error) {
        result = { code: 1, stdout: error instanceof Error ? error.message : String(error) };
      }
      const parsed = result.code === 0 ? parseWatcherOutput(result.stdout) : undefined;
      if (!parsed) {
        w.failures += 1;
        outcomes.push({ kind: "failed", watcher: { ...w }, error: `exit ${result.code}: ${result.stdout.slice(0, 200)}` });
        continue;
      }
      w.failures = 0;
      const hash = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex").slice(0, 16);
      const changed = hash !== w.lastHash;
      w.lastHash = hash;
      outcomes.push(parsed.hit && changed ? { kind: "hit", watcher: { ...w }, summary: parsed.summary } : { kind: "quiet", watcher: { ...w } });
    }
    this.save(list);
    return outcomes;
  }
}

export function watcherTools(deps: { watchers: WatcherStore; startDeepTask: (o: { brief: string; tainted: boolean }) => string; checkpoint?: () => Promise<void> }): RegisteredTool[] {
  const create = defineTool({
    name: "create_watcher",
    label: "Watch something",
    description:
      "Watch a page, feed or API for a change Kartik cares about (a price under a number, a new item, a status change). Starts a deep session that writes and tests a script; afterwards it runs with no model and you hear back only when the condition is met.",
    parameters: Type.Object({
      what: Type.String({ description: "The condition in plain words, e.g. 'price of this monitor below ₹20000'" }),
      source: Type.String({ description: "URL or API to check" }),
      everyMinutes: Type.Number({ description: "How often to check, at least 5. Prefer 60 or more." }),
    }),
    meta: { capabilities: ["schedule.manage", "web.read"], group: "schedule", describe: (a) => `watch: ${String((a as { what?: unknown }).what ?? "")}` },
    execute: async ({ what, source, everyMinutes }) => {
      await deps.checkpoint?.();
      const id = `w${Date.now().toString(36)}`;
      const key = deps.startDeepTask({
        tainted: false,
        brief: [
          `Write a watcher script at watchers/${id}.ts in the workspace. Condition: ${what}. Source: ${source}.`,
          "The script uses only fetch and plain TypeScript (Bun runtime), finishes in under 15 seconds, and prints exactly one JSON line:",
          '{"value": <the extracted value>, "hit": <true when the condition is met>, "summary": "<one short sentence for Kartik>"}',
          `Run it once with \`bun watchers/${id}.ts\` and fix it until the output parses. Then call watcher_register with id "${id}", file "watchers/${id}.ts", everyMinutes ${Math.max(5, everyMinutes)} and a one-line description.`,
        ].join("\n"),
      });
      return textResult(`Writing the watcher in ${key}. Tell Kartik in a few words; he'll hear when it's live.`);
    },
  });
  const register = defineTool({
    name: "watcher_register",
    label: "Register a watcher",
    description: "Register a tested watcher script so it runs on a schedule with no model. Only for scripts you just wrote and ran.",
    parameters: Type.Object({ id: Type.String(), file: Type.String(), everyMinutes: Type.Number(), description: Type.String() }),
    meta: { capabilities: ["schedule.manage", "files.write"], group: "schedule", describe: (a) => `register watcher ${String((a as { id?: unknown }).id ?? "")}` },
    execute: async (args) => {
      const w = deps.watchers.register(args);
      return textResult(`Watcher ${w.id} runs every ${w.everyMinutes} min, first run now.`);
    },
  });
  const list = defineTool({
    name: "watcher_list",
    label: "List watchers",
    description: "List active watchers.",
    parameters: Type.Object({}),
    meta: { capabilities: ["schedule.manage"], group: "schedule" },
    execute: async () => textResult(deps.watchers.list().map((w) => `${w.id}: ${w.description} (every ${w.everyMinutes} min${w.failures ? `, ${w.failures} failures` : ""})`).join("\n") || "No watchers."),
  });
  const remove = defineTool({
    name: "watcher_remove",
    label: "Stop a watcher",
    description: "Stop and remove a watcher by id.",
    parameters: Type.Object({ id: Type.String() }),
    meta: { capabilities: ["schedule.manage"], group: "schedule" },
    execute: async ({ id }) => textResult(deps.watchers.remove(id) ? `Stopped ${id}.` : `No watcher ${id}.`),
  });
  return [create, register, list, remove];
}
