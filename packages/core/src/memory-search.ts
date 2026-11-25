/**
 * Full-text search over MEMORY.md and the journal with SQLite FTS5: porter stemming plus a
 * small synonym map, no embeddings, no third-party API. The index is rebuilt from the files,
 * which stay the source of truth.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { StateDir } from "./state.js";
import { defineTool, textResult, type RegisteredTool } from "./tools.js";

const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  mom: ["mother", "mum", "maa", "amma"],
  dad: ["father", "papa"],
  gf: ["girlfriend", "partner"],
  bf: ["boyfriend", "partner"],
  wife: ["partner", "spouse"],
  husband: ["partner", "spouse"],
  food: ["dining", "restaurant", "eat", "lunch", "dinner"],
  flight: ["flights", "airline", "fly", "travel"],
  doctor: ["dentist", "clinic", "appointment"],
  work: ["office", "job", "company"],
};

function expand(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set<string>();
  for (const w of words) {
    terms.add(w);
    if (w.length >= 7) terms.add(w.slice(0, w.length - 3));
    for (const [k, alts] of Object.entries(SYNONYMS)) {
      if (k === w || alts.includes(w)) {
        terms.add(k);
        for (const a of alts) terms.add(a);
      }
    }
  }
  return [...terms].map((t) => `"${t}"*`).join(" OR ");
}

export class MemoryIndex {
  private readonly db: Database;

  constructor(private readonly state: StateDir) {
    this.db = new Database(":memory:");
    this.db.exec("CREATE VIRTUAL TABLE docs USING fts5(source, line, tokenize = 'porter unicode61')");
  }

  private rebuild(): void {
    this.db.exec("DELETE FROM docs");
    const insert = this.db.query("INSERT INTO docs (source, line) VALUES (?, ?)");
    const add = (source: string, text: string) => {
      for (const line of text.split("\n")) if (line.trim() && !line.startsWith("#")) insert.run(source, line.trim());
    };
    add("memory", this.state.readText("memory/MEMORY.md"));
    const dir = this.state.path("memory", "journal");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort().slice(-60)) add(`journal ${f.replace(/\.md$/, "")}`, fs.readFileSync(path.join(dir, f), "utf8"));
    }
  }

  search(query: string, limit = 8): Array<{ source: string; line: string }> {
    const match = expand(query);
    if (!match) return [];
    this.rebuild();
    return this.db.query<{ source: string; line: string }, [string, number]>("SELECT source, line FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?").all(match, limit);
  }
}

export function memorySearchTool(index: MemoryIndex): RegisteredTool {
  return defineTool({
    name: "memory_search",
    label: "Search memory",
    description: "Search everything Peril remembers (durable memory and the last 60 days of journal) by words, nicknames or topics. Use before asking Kartik something he may have told you.",
    parameters: Type.Object({ query: Type.String() }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `search memory: ${String((a as { query?: unknown }).query ?? "")}` },
    execute: async ({ query }) => {
      const hits = index.search(query);
      return textResult(hits.length ? hits.map((h) => `[${h.source}] ${h.line}`).join("\n") : "Nothing in memory matches.");
    },
  });
}
