import { describe, expect, it } from "bun:test";
import { publicApp } from "../src/app.js";
import { WakePlanner, isQuiet, nextAwake, scheduleFor, type CronJobApi } from "../src/clock.js";

const quiet = { start: 21, end: 8 };
const tz = "Asia/Kolkata";

describe("quiet hours", () => {
  it("are 9pm to 8am IST", () => {
    expect(isQuiet(new Date("2026-11-26T15:29:00Z"), tz, quiet)).toBe(false); // 20:59 IST
    expect(isQuiet(new Date("2026-11-26T15:30:00Z"), tz, quiet)).toBe(true); // 21:00 IST
    expect(isQuiet(new Date("2026-11-27T02:29:00Z"), tz, quiet)).toBe(true); // 07:59 IST
    expect(nextAwake(new Date("2026-11-26T20:00:00Z"), tz, quiet).toISOString()).toBe("2026-11-27T02:30:00.000Z");
  });
});

describe("WakePlanner", () => {
  function fakeApi() {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const api: CronJobApi = {
      async request(r) {
        calls.push(r);
        return r.method === "PUT" ? { jobId: 42 } : {};
      },
    };
    return { api, calls };
  }

  it("creates one job for the next due minute in IST, then moves it, and skips unchanged plans", async () => {
    const { api, calls } = fakeApi();
    let saved: { jobId?: number; nextAt?: string } = {};
    const planner = new WakePlanner({ api, store: { get: () => saved, set: (v) => void (saved = v) }, tickUrl: "https://peril.example/tick?key=k", tz, now: () => new Date("2026-11-26T08:00:00Z") });
    expect(await planner.plan(new Date("2026-11-26T08:03:20Z"))).toBe("moved");
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/jobs" });
    expect((calls[0]?.body as { job: { schedule: unknown } }).job.schedule).toEqual({ timezone: tz, expiresAt: 0, hours: [13], minutes: [34], mdays: [26], months: [11], wdays: [-1] });
    expect(await planner.plan(new Date("2026-11-26T08:03:20Z"))).toBe("unchanged");
    expect(await planner.plan(new Date("2026-11-26T09:00:00Z"))).toBe("moved");
    expect(calls[1]).toMatchObject({ method: "PATCH", path: "/jobs/42" });
    expect(await planner.plan(undefined)).toBe("disabled");
    expect(calls).toHaveLength(3);
  });

  it("never schedules in the past", async () => {
    const { api, calls } = fakeApi();
    let saved: { jobId?: number; nextAt?: string } = {};
    const planner = new WakePlanner({ api, store: { get: () => saved, set: (v) => void (saved = v) }, tickUrl: "https://x/tick", tz, now: () => new Date("2026-11-26T08:00:30Z") });
    await planner.plan(new Date("2026-11-26T07:00:00Z"));
    expect(saved.nextAt).toBe("2026-11-26T08:01:00.000Z");
    expect(calls).toHaveLength(1);
  });

  it("does nothing until cron-job.org and the public URL are configured", async () => {
    const planner = new WakePlanner({ api: undefined, store: { get: () => ({}), set: () => undefined }, tickUrl: undefined, tz });
    expect(await planner.plan(new Date())).toBe("unconfigured");
  });

  it("builds a schedule cron-job.org accepts for a single minute", () => {
    expect(scheduleFor(new Date("2026-12-31T18:29:00Z"), tz)).toMatchObject({ hours: [23], minutes: [59], mdays: [31], months: [12] });
  });
});

describe("public routes", () => {
  const app = publicApp({ agentName: "Peril", photonWebhook: undefined, tickKey: "secret-key", onTick: async () => ({ fired: [] }), appEvents: undefined });

  it("answers /health", async () => {
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ ok: true, agent: "Peril" });
  });

  it("refuses /tick without the key", async () => {
    expect((await app.request("/tick")).status).toBe(401);
    expect((await app.request("/tick?key=wrong")).status).toBe(401);
    expect((await app.request("/tick?key=secret-key")).status).toBe(202);
  });

  it("exposes no MCP on the public port", async () => {
    expect((await app.request("/mcp", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
