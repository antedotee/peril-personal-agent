import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPLAY_WINDOW_MS, ReceiptStore, callKeyFor } from "../src/receipts.js";

function dbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "peril-receipts-")), "peril.db");
}

const send = { toolName: "apps_execute", args: { slug: "GMAIL_SEND_EMAIL", arguments: { to: "rahul@example.com", body: "coffee?" } }, intentSummary: "email rahul" };

describe("ReceiptStore", () => {
  it("lets a fresh call run and returns the saved summary for a completed repeat", () => {
    const store = new ReceiptStore({ path: dbPath() });
    const first = store.begin(send);
    expect(first.kind).toBe("run");
    if (first.kind !== "run") return;
    store.finish({ callKey: first.callKey, ok: true, resultSummary: "sent, id 123" });
    const again = store.begin(send);
    expect(again.kind).toBe("already_done");
    if (again.kind === "already_done") expect(again.receipt.resultSummary).toBe("sent, id 123");
  });

  it("marks a call left pending by a crash as in doubt, across a reopen", () => {
    const p = dbPath();
    const before = new ReceiptStore({ path: p });
    expect(before.begin(send).kind).toBe("run");
    before.close();
    const after = new ReceiptStore({ path: p });
    const replay = after.begin(send);
    expect(replay.kind).toBe("in_doubt");
    expect(after.inDoubt()).toHaveLength(1);
  });

  it("lets a parked call run once approved", () => {
    const store = new ReceiptStore({ path: dbPath() });
    const first = store.begin(send);
    if (first.kind !== "run") throw new Error("expected run");
    store.park(first.callKey);
    expect(store.begin(send).kind).toBe("run");
  });

  it("allows an identical call again after the replay window", () => {
    let now = new Date("2026-11-26T10:00:00Z");
    const store = new ReceiptStore({ path: dbPath(), now: () => now });
    const first = store.begin(send);
    if (first.kind !== "run") throw new Error("expected run");
    store.finish({ callKey: first.callKey, ok: true, resultSummary: "sent" });
    now = new Date(now.getTime() + REPLAY_WINDOW_MS + 1);
    expect(store.begin(send).kind).toBe("run");
  });

  it("clears an in-doubt call the owner says never happened", () => {
    const store = new ReceiptStore({ path: dbPath() });
    const first = store.begin(send);
    if (first.kind !== "run") throw new Error("expected run");
    store.resolveInDoubt({ callKey: first.callKey, happened: false, note: "not in Sent" });
    expect(store.begin(send).kind).toBe("run");
  });

  it("keys calls by content, ignoring property order", () => {
    expect(callKeyFor("t", { a: 1, b: { c: 2, d: 3 } })).toBe(callKeyFor("t", { b: { d: 3, c: 2 }, a: 1 }));
    expect(callKeyFor("t", { a: 1 })).not.toBe(callKeyFor("u", { a: 1 }));
  });
});
