/**
 * Peril's own small tables in peril.db: webhook ids already handled, taint per session,
 * which iMessage carried which approval, open loops for follow-ups, and messages held
 * back by quiet hours. Each table is the single source of truth for its fact.
 */
import { Database } from "bun:sqlite";
import type { Scope, ScopeState, SessionKind } from "@peril/tools-mcp";

export interface OpenLoop {
  topic: string;
  at: string;
}

export interface Deferred {
  id: number;
  text: string;
  notBefore: string;
}

export class PerilStore implements ScopeState {
  private readonly db: Database;
  private readonly scopes = new Map<string, Scope>();

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS taint (scope TEXT PRIMARY KEY, source TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_messages (message_id TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_calls (token TEXT PRIMARY KEY, name TEXT NOT NULL, args TEXT NOT NULL, scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS open_loops (id INTEGER PRIMARY KEY, topic TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deferred (id INTEGER PRIMARY KEY, text TEXT NOT NULL, not_before TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  /** True the first time an id is seen. Webhooks deliver at least once. */
  firstSight(id: string, at: Date = new Date()): boolean {
    const result = this.db.query("INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)").run(id, at.toISOString());
    return result.changes > 0;
  }

  // Scopes -----------------------------------------------------------------

  setScope(scope: Scope): void {
    this.scopes.set(scope.key, scope);
  }

  get(key: string): Scope {
    return this.scopes.get(key) ?? { key, kind: kindOfKey(key), ownerTurn: false };
  }

  isTainted(key: string): boolean {
    return this.db.query("SELECT 1 FROM taint WHERE scope = ?").get(key) !== null;
  }

  taint(key: string, source: string): void {
    this.db.query("INSERT OR IGNORE INTO taint (scope, source, at) VALUES (?, ?, ?)").run(key, source, new Date().toISOString());
  }

  clearTaint(key: string): void {
    this.db.query("DELETE FROM taint WHERE scope = ?").run(key);
  }

  // Approvals by tapback -----------------------------------------------------

  linkApproval(messageId: string, token: string): void {
    this.db.query("INSERT OR REPLACE INTO approval_messages (message_id, token) VALUES (?, ?)").run(messageId, token);
  }

  approvalFor(messageId: string): string | undefined {
    const row = this.db.query<{ token: string }, [string]>("SELECT token FROM approval_messages WHERE message_id = ?").get(messageId);
    return row?.token;
  }

  /** The exact tool call an approval covers, so a 👍 runs it in code with no model. */
  rememberCall(token: string, call: { name: string; args: unknown; scope: string }): void {
    this.db.query("INSERT OR REPLACE INTO approval_calls (token, name, args, scope) VALUES (?, ?, ?, ?)").run(token, call.name, JSON.stringify(call.args ?? {}), call.scope);
  }

  callFor(token: string): { name: string; args: unknown; scope: string } | undefined {
    const row = this.db.query<{ name: string; args: string; scope: string }, [string]>("SELECT name, args, scope FROM approval_calls WHERE token = ?").get(token);
    return row ? { name: row.name, args: JSON.parse(row.args) as unknown, scope: row.scope } : undefined;
  }

  // Open loops -------------------------------------------------------------

  addOpenLoop(topic: string, at: Date): void {
    this.db.query("INSERT INTO open_loops (topic, at) VALUES (?, ?)").run(topic.slice(0, 200), at.toISOString());
  }

  openLoops(): OpenLoop[] {
    return this.db.query<OpenLoop, []>("SELECT topic, at FROM open_loops ORDER BY at").all();
  }

  clearOpenLoops(): void {
    this.db.exec("DELETE FROM open_loops");
  }

  // Quiet hours ------------------------------------------------------------

  defer(text: string, notBefore: Date): void {
    this.db.query("INSERT INTO deferred (text, not_before) VALUES (?, ?)").run(text, notBefore.toISOString());
  }

  dueDeferred(now: Date): Deferred[] {
    return this.db
      .query<{ id: number; text: string; not_before: string }, [string]>("SELECT id, text, not_before FROM deferred WHERE not_before <= ? ORDER BY id")
      .all(now.toISOString())
      .map((r) => ({ id: r.id, text: r.text, notBefore: r.not_before }));
  }

  nextDeferred(): Date | undefined {
    const row = this.db.query<{ t: string | null }, []>("SELECT MIN(not_before) AS t FROM deferred").get();
    return row?.t ? new Date(row.t) : undefined;
  }

  dropDeferred(id: number): void {
    this.db.query("DELETE FROM deferred WHERE id = ?").run(id);
  }

  // Small values -----------------------------------------------------------

  getValue(k: string): string | undefined {
    return this.db.query<{ v: string }, [string]>("SELECT v FROM kv WHERE k = ?").get(k)?.v;
  }

  setValue(k: string, v: string | undefined): void {
    if (v === undefined) this.db.query("DELETE FROM kv WHERE k = ?").run(k);
    else this.db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(k, v);
  }
}

export function kindOfKey(key: string): SessionKind {
  if (key.startsWith("task:")) return "deep";
  if (key.startsWith("event:")) return "event";
  return "chat";
}
