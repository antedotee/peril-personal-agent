/**
 * Write-ahead receipts for tools that change the outside world. Local storage can prove a
 * call started, never that the remote side finished, so a call left `pending` by a crash is
 * "in doubt": it is never replayed automatically. The model is told to check the real state
 * (the Sent folder, the calendar) and ask the owner.
 *
 * A call is identified by its content (tool + canonical args), not by a transport id, because
 * Kiro may re-issue the same call with a new id after `session/load`.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type ReceiptStatus = "pending" | "parked" | "completed" | "failed";

export interface Receipt {
  callKey: string;
  toolName: string;
  intentSummary: string;
  status: ReceiptStatus;
  resultSummary: string | null;
  startedAt: string;
  completedAt: string | null;
}

/** What `begin` decided for this call. Only `run` lets the side effect happen. */
export type BeginOutcome =
  | { kind: "run"; callKey: string }
  | { kind: "already_done"; receipt: Receipt }
  | { kind: "in_doubt"; receipt: Receipt };

/** Completed receipts older than this no longer block an identical call. */
export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function callKeyFor(toolName: string, args: unknown): string {
  return createHash("sha256").update(`${toolName}\n${canonicalJson(args)}`).digest("hex").slice(0, 32);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

interface Row {
  call_key: string;
  tool_name: string;
  intent_summary: string;
  status: ReceiptStatus;
  result_summary: string | null;
  started_at: string;
  completed_at: string | null;
}

function fromRow(r: Row): Receipt {
  return {
    callKey: r.call_key,
    toolName: r.tool_name,
    intentSummary: r.intent_summary,
    status: r.status,
    resultSummary: r.result_summary,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

export class ReceiptStore {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(opts: { path: string; now?: () => Date }) {
    this.db = new Database(opts.path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS receipts (
      call_key TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      intent_summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','parked','completed','failed')),
      result_summary TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    )`);
    this.now = opts.now ?? (() => new Date());
  }

  get(callKey: string): Receipt | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM receipts WHERE call_key = ?").get(callKey);
    return row ? fromRow(row) : undefined;
  }

  /** Decide whether a side-effecting call may run, and record the intent before it does. */
  begin(opts: { toolName: string; args: unknown; intentSummary: string }): BeginOutcome {
    const callKey = callKeyFor(opts.toolName, opts.args);
    const existing = this.get(callKey);
    const startedAt = this.now().toISOString();
    if (existing) {
      if (existing.status === "pending") return { kind: "in_doubt", receipt: existing };
      const age = this.now().getTime() - Date.parse(existing.completedAt ?? existing.startedAt);
      if (existing.status === "completed" && age < REPLAY_WINDOW_MS) return { kind: "already_done", receipt: existing };
    }
    this.db
      .query("INSERT OR REPLACE INTO receipts (call_key, tool_name, intent_summary, status, result_summary, started_at, completed_at) VALUES (?, ?, ?, 'pending', NULL, ?, NULL)")
      .run(callKey, opts.toolName, opts.intentSummary, startedAt);
    return { kind: "run", callKey };
  }

  /** A call that paused before touching the network (waiting on an approval) can run later. */
  park(callKey: string): void {
    this.db.query("UPDATE receipts SET status = 'parked' WHERE call_key = ? AND status = 'pending'").run(callKey);
  }

  finish(opts: { callKey: string; ok: boolean; resultSummary: string }): void {
    this.db
      .query("UPDATE receipts SET status = ?, result_summary = ?, completed_at = ? WHERE call_key = ?")
      .run(opts.ok ? "completed" : "failed", opts.resultSummary.slice(0, 500), this.now().toISOString(), opts.callKey);
  }

  /** The owner checked the outside world and says what happened to an in-doubt call. */
  resolveInDoubt(opts: { callKey: string; happened: boolean; note: string }): void {
    if (opts.happened) this.finish({ callKey: opts.callKey, ok: true, resultSummary: opts.note });
    else this.db.query("DELETE FROM receipts WHERE call_key = ? AND status = 'pending'").run(opts.callKey);
  }

  inDoubt(): Receipt[] {
    return this.db.query<Row, []>("SELECT * FROM receipts WHERE status = 'pending' ORDER BY started_at").all().map(fromRow);
  }

  close(): void {
    this.db.close();
  }
}
