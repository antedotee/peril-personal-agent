/**
 * Watchers: Kiro writes a small spec once (a URL, what to pull out, the condition), then
 * plain code checks it on a schedule. No model runs until the condition holds and the value
 * changed. A spec cannot run code, so a watcher shaped by outside text can at worst fetch a
 * public page.
 */
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { defineTool, fetchPublic, textResult, type RegisteredTool, type StateDir } from "@peril/core";

const Extract = Type.Union([
  Type.Object({ kind: Type.Literal("json"), path: Type.String({ description: "Dot path into the JSON, e.g. data.price or items.0.title" }) }),
  Type.Object({ kind: Type.Literal("regex"), pattern: Type.String({ description: "Regex with one capture group, run on the page text" }) }),
  Type.Object({ kind: Type.Literal("text") }),
]);

const Condition = Type.Object({
  op: Type.Union([Type.Literal("lt"), Type.Literal("gt"), Type.Literal("eq"), Type.Literal("contains"), Type.Literal("changed")]),
  value: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

export const WatchSpec = Type.Object({ url: Type.String(), extract: Extract, condition: Condition });
export type WatchSpec = Static<typeof WatchSpec>;

export interface Watcher {
  id: string;
  description: string;
  spec: WatchSpec;
  everyMinutes: number;
  nextRunAt: string;
  lastHash?: string;
  lastValue?: string;
  failures: number;
}

export type WatchOutcome =
  | { kind: "hit"; watcher: Watcher; summary: string }
  | { kind: "quiet"; watcher: Watcher }
  | { kind: "failed"; watcher: Watcher; error: string };

export type PageFetcher = (url: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;

const FILE = "watchers.json";
const MIN_EVERY = 5;
const BODY_CAP = 512 * 1024;

export const publicFetcher: PageFetcher = async (url) => {
  const result = await fetchPublic(fetch, url, { signal: AbortSignal.timeout(15_000) });
  if (!result.ok) return { ok: false, reason: result.reason };
  if (!result.res.ok) return { ok: false, reason: `HTTP ${result.res.status}` };
  return { ok: true, text: (await result.res.text()).slice(0, BODY_CAP) };
};

function pageText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function extractValue(spec: WatchSpec, body: string): string | undefined {
  switch (spec.extract.kind) {
    case "json": {
      let node: unknown;
      try {
        node = JSON.parse(body);
      } catch {
        return undefined;
      }
      for (const key of spec.extract.path.split(".").filter(Boolean)) {
        if (typeof node !== "object" || node === null) return undefined;
        node = (node as Record<string, unknown>)[key];
      }
      return node === undefined ? undefined : typeof node === "string" ? node : JSON.stringify(node);
    }
    case "regex": {
      const m = pageText(body).match(new RegExp(spec.extract.pattern, "i"));
      return m ? (m[1] ?? m[0]).trim() : undefined;
    }
    case "text":
      return pageText(body).slice(0, 4000);
    default: {
      const _exhaustive: never = spec.extract;
      return _exhaustive;
    }
  }
}

function asNumber(value: string): number {
  return Number(value.replace(/[^\d.-]/g, ""));
}

export function conditionHolds(spec: WatchSpec, value: string, previous: string | undefined): boolean {
  const { op, value: target } = spec.condition;
  switch (op) {
    case "lt":
      return asNumber(value) < Number(target);
    case "gt":
      return asNumber(value) > Number(target);
    case "eq":
      return value === String(target);
    case "contains":
      return value.toLowerCase().includes(String(target ?? "").toLowerCase());
    case "changed":
      return previous !== undefined && previous !== value;
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

export class WatcherStore {
  constructor(
    private readonly state: StateDir,
    private readonly opts: { fetcher?: PageFetcher; now?: () => Date } = {},
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

  /** Check the spec once, then save it. Returns the value it read, so Kiro can confirm it is the right one. */
  async create(input: { description: string; spec: WatchSpec; everyMinutes: number }): Promise<{ watcher: Watcher; value: string }> {
    if (input.spec.extract.kind === "regex") new RegExp(input.spec.extract.pattern);
    const page = await (this.opts.fetcher ?? publicFetcher)(input.spec.url);
    if (!page.ok) throw new Error(`could not read ${input.spec.url}: ${page.reason}`);
    const value = extractValue(input.spec, page.text);
    if (value === undefined) throw new Error("the extract matched nothing on the page; adjust the path or pattern");
    const watcher: Watcher = {
      id: `w${this.now().getTime().toString(36)}`,
      description: input.description.slice(0, 200),
      spec: input.spec,
      everyMinutes: Math.max(MIN_EVERY, Math.round(input.everyMinutes)),
      nextRunAt: new Date(this.now().getTime() + Math.max(MIN_EVERY, input.everyMinutes) * 60_000).toISOString(),
      lastHash: hashOf(value),
      lastValue: value.slice(0, 200),
      failures: 0,
    };
    this.save([...this.list(), watcher]);
    return { watcher, value };
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

  /** Check every due watcher. No model is involved here. */
  async runDue(): Promise<WatchOutcome[]> {
    const now = this.now();
    const fetcher = this.opts.fetcher ?? publicFetcher;
    const list = this.list();
    const outcomes: WatchOutcome[] = [];
    for (const w of list) {
      if (Date.parse(w.nextRunAt) > now.getTime()) continue;
      w.nextRunAt = new Date(now.getTime() + w.everyMinutes * 60_000).toISOString();
      const page = await fetcher(w.spec.url).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
      const value = page.ok ? extractValue(w.spec, page.text) : undefined;
      if (value === undefined) {
        w.failures += 1;
        outcomes.push({ kind: "failed", watcher: { ...w }, error: page.ok ? "extract matched nothing" : page.reason });
        continue;
      }
      w.failures = 0;
      const hash = hashOf(value);
      const changed = hash !== w.lastHash;
      const hit = changed && conditionHolds(w.spec, value, w.lastValue);
      w.lastHash = hash;
      w.lastValue = value.slice(0, 200);
      outcomes.push(hit ? { kind: "hit", watcher: { ...w }, summary: `now: ${value.slice(0, 200)}` } : { kind: "quiet", watcher: { ...w } });
    }
    this.save(list);
    return outcomes;
  }
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function watcherTools(deps: { watchers: WatcherStore }): RegisteredTool[] {
  const create = defineTool({
    name: "watcher_create",
    label: "Watch something",
    description:
      "Watch a public page or JSON API for a change Kartik cares about: a price under a number, a word appearing, any change. Give the URL, what to pull out (json path, regex with one capture group, or the page text) and the condition. It reads the page once now and returns the value it found; check that value is the right one. Afterwards it runs with no model and you hear back only when the condition holds.",
    parameters: Type.Object({
      description: Type.String({ description: "One line Kartik would recognise, e.g. 'LG monitor price on Croma'" }),
      spec: WatchSpec,
      everyMinutes: Type.Number({ description: "How often to check, at least 5. Prefer 60 or more." }),
    }),
    meta: { capabilities: ["schedule.manage", "web.read"], group: "schedule", describe: (a) => `watch: ${String((a as { description?: unknown }).description ?? "")}` },
    execute: async ({ description, spec, everyMinutes }) => {
      try {
        const { watcher, value } = await deps.watchers.create({ description, spec, everyMinutes });
        return textResult(`Watcher ${watcher.id} is live, every ${watcher.everyMinutes} min. It read: ${value.slice(0, 200)}`);
      } catch (error) {
        return { content: [{ type: "text", text: `Not saved: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });
  const list = defineTool({
    name: "watcher_list",
    label: "List watchers",
    description: "List active watchers.",
    parameters: Type.Object({}),
    meta: { capabilities: ["schedule.manage"], group: "schedule" },
    execute: async () => textResult(deps.watchers.list().map((w) => `${w.id}: ${w.description} (every ${w.everyMinutes} min, last ${w.lastValue ?? "?"}${w.failures ? `, ${w.failures} failures` : ""})`).join("\n") || "No watchers."),
  });
  const remove = defineTool({
    name: "watcher_remove",
    label: "Stop a watcher",
    description: "Stop and remove a watcher by id.",
    parameters: Type.Object({ id: Type.String() }),
    meta: { capabilities: ["schedule.manage"], group: "schedule" },
    execute: async ({ id }) => textResult(deps.watchers.remove(id) ? `Stopped ${id}.` : `No watcher ${id}.`),
  });
  return [create, list, remove];
}
