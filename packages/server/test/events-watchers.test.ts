import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateDir } from "@peril/core";
import { importanceOf, parseComposio, verifyComposio } from "../src/events.js";
import { WatcherStore, parseWatcherOutput, type ScriptRunner } from "../src/watchers.js";

const now = new Date("2026-11-26T08:00:00Z");
const memory = "# Memory\n- Rahul Sharma (rahul@acme.in) is Kartik's cofounder.\n";

describe("Composio events", () => {
  it("verifies the Standard Webhooks signature and rejects stale or forged ones", () => {
    const secret = "whsec_test";
    const body = '{"type":"composio.trigger.message"}';
    const ts = String(Math.floor(now.getTime() / 1000));
    const sig = `v1,${createHmac("sha256", secret).update(`msg_1.${ts}.${body}`).digest("base64")}`;
    const nowS = Math.floor(now.getTime() / 1000);
    expect(verifyComposio({ secret, id: "msg_1", timestamp: ts, signature: sig, body, nowS })).toBe(true);
    expect(verifyComposio({ secret, id: "msg_1", timestamp: ts, signature: sig, body: `${body} `, nowS })).toBe(false);
    expect(verifyComposio({ secret, id: "msg_1", timestamp: ts, signature: sig, body, nowS: nowS + 600 })).toBe(false);
  });

  it("parses the V3 trigger payload", () => {
    const e = parseComposio(JSON.stringify({ type: "composio.trigger.message", metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" }, data: { subject: "hi" } }), "msg_1");
    expect(e).toEqual({ id: "msg_1", slug: "GMAIL_NEW_GMAIL_MESSAGE", data: { subject: "hi" } });
    expect(parseComposio('{"type":"composio.connection.expired"}', "x")).toBeUndefined();
  });

  it("wakes Kiro for mail from someone in memory or an urgent subject, not for bulk mail", () => {
    const mail = (sender: string, subject: string) => importanceOf({ id: "1", slug: "GMAIL_NEW_GMAIL_MESSAGE", data: { sender, subject, message_text: "..." } }, { memory, now });
    expect(mail("Rahul <rahul@acme.in>", "lunch?")?.reason).toContain("memory");
    expect(mail("Landlord <owner@flats.in>", "Rent payment due tomorrow")?.reason).toContain("urgent");
    expect(mail("Shop <noreply@shop.in>", "Flash sale today, 50% off")).toBeUndefined();
    expect(mail("Bank <alerts@bank.in>", "Your OTP for today")).toBeUndefined();
    expect(mail("Someone <someone@x.com>", "hello")).toBeUndefined();
  });

  it("wakes Kiro for a calendar change starting within a day only", () => {
    const cal = (start: string) => importanceOf({ id: "1", slug: "GOOGLECALENDAR_EVENT_CREATED", data: { summary: "sync", start: { dateTime: start } } }, { memory, now });
    expect(cal("2026-11-26T12:00:00Z")).toBeDefined();
    expect(cal("2026-11-29T12:00:00Z")).toBeUndefined();
  });
});

describe("watchers", () => {
  function setup(outputs: string[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "peril-watch-"));
    const state = new StateDir(root);
    state.ensure();
    fs.mkdirSync(path.join(root, "watchers"));
    fs.writeFileSync(path.join(root, "watchers", "w1.ts"), "// test");
    let t = now;
    const runner: ScriptRunner = async () => ({ code: 0, stdout: outputs.shift() ?? "" });
    const store = new WatcherStore(state, { workspace: root, runner, now: () => t });
    store.register({ id: "w1", description: "monitor price", file: "watchers/w1.ts", everyMinutes: 60 });
    return { store, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
  }

  it("reports a hit once, then stays quiet while the value is unchanged", async () => {
    const hit = '{"value": 19500, "hit": true, "summary": "₹19,500 now"}';
    const { store, advance } = setup([hit, hit, '{"value": 18900, "hit": true, "summary": "₹18,900"}']);
    expect((await store.runDue()).map((o) => o.kind)).toEqual(["hit"]);
    advance(30 * 60_000);
    expect(await store.runDue()).toEqual([]);
    advance(31 * 60_000);
    expect((await store.runDue()).map((o) => o.kind)).toEqual(["quiet"]);
    advance(61 * 60_000);
    expect((await store.runDue()).map((o) => o.kind)).toEqual(["hit"]);
  });

  it("counts failures instead of waking anyone", async () => {
    const { store } = setup(["not json"]);
    const [outcome] = await store.runDue();
    expect(outcome?.kind).toBe("failed");
    expect(store.list()[0]?.failures).toBe(1);
  });

  it("refuses a script outside the workspace", () => {
    const { store } = setup([]);
    expect(() => store.register({ id: "x", description: "x", file: "../../etc/passwd", everyMinutes: 5 })).toThrow();
  });

  it("parses only well-formed output", () => {
    expect(parseWatcherOutput('log line\n{"value":1,"hit":false}')).toEqual({ value: 1, hit: false, summary: "" });
    expect(parseWatcherOutput('{"value":1}')).toBeUndefined();
  });
});
