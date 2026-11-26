import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateDir } from "@peril/core";
import { importanceOf, parseComposio, verifyComposio } from "../src/events.js";
import { WatcherStore, conditionHolds, extractValue, type PageFetcher } from "../src/watchers.js";

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
  function setup(pages: string[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "peril-watch-"));
    const state = new StateDir(root);
    state.ensure();
    let t = now;
    const fetched: string[] = [];
    const fetcher: PageFetcher = async (url) => {
      fetched.push(url);
      const next = pages.shift();
      return next === undefined ? { ok: false, reason: "offline" } : { ok: true, text: next };
    };
    const store = new WatcherStore(state, { fetcher, now: () => t });
    return { store, fetched, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
  }
  const price = (n: number) => `<html><body><h1>LG 27GP850</h1><span class="price">₹${n.toLocaleString("en-IN")}</span></body></html>`;
  const spec = { url: "https://shop.example/lg", extract: { kind: "regex" as const, pattern: "₹\\s*([\\d,]+)" }, condition: { op: "lt" as const, value: 20000 } };

  it("reads the value once on create, then wakes only when the condition holds and the value changed", async () => {
    const { store, advance } = setup([price(24999), price(24999), price(19499), price(19499)]);
    const { value } = await store.create({ description: "LG monitor under 20k", spec, everyMinutes: 60 });
    expect(value).toBe("24,999");
    advance(61 * 60_000);
    expect((await store.runDue()).map((o) => o.kind)).toEqual(["quiet"]);
    advance(61 * 60_000);
    const hit = await store.runDue();
    expect(hit.map((o) => o.kind)).toEqual(["hit"]);
    advance(61 * 60_000);
    expect((await store.runDue()).map((o) => o.kind)).toEqual(["quiet"]);
  });

  it("refuses a spec that matches nothing, and counts failures without waking anyone", async () => {
    const { store, advance } = setup(["<p>sold out</p>", price(1), ]);
    await expect(store.create({ description: "x", spec, everyMinutes: 60 })).rejects.toThrow("matched nothing");
    await store.create({ description: "x", spec, everyMinutes: 60 });
    advance(61 * 60_000);
    const [outcome] = await store.runDue();
    expect(outcome?.kind).toBe("failed");
    expect(store.list()[0]?.failures).toBe(1);
  });

  it("extracts from JSON by path and evaluates each condition", () => {
    const json = '{"data":{"price":"₹1,299","status":"In stock"}}';
    expect(extractValue({ url: "u", extract: { kind: "json", path: "data.price" }, condition: { op: "changed" } }, json)).toBe("₹1,299");
    const s = (op: "lt" | "gt" | "eq" | "contains" | "changed", value?: number | string) => ({ url: "u", extract: { kind: "text" as const }, condition: value === undefined ? { op } : { op, value } });
    expect(conditionHolds(s("lt", 1300), "₹1,299", undefined)).toBe(true);
    expect(conditionHolds(s("gt", 1300), "₹1,299", undefined)).toBe(false);
    expect(conditionHolds(s("contains", "in stock"), "In stock", undefined)).toBe(true);
    expect(conditionHolds(s("changed"), "b", "a")).toBe(true);
    expect(conditionHolds(s("changed"), "a", undefined)).toBe(false);
  });
});
