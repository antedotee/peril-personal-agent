/**
 * Time rules in code: quiet hours, and the one wake-up Peril asks cron-job.org for. A
 * sleeping Sprite cannot wake itself, so instead of polling, Peril keeps exactly one
 * cron-job.org job pointed at its next due minute and moves it whenever that changes.
 */
import { localParts } from "@peril/core";

export interface QuietHours {
  start: number;
  end: number;
}

export function isQuiet(at: Date, tz: string, quiet: QuietHours): boolean {
  const { hour } = localParts(at, tz);
  return quiet.start > quiet.end ? hour >= quiet.start || hour < quiet.end : hour >= quiet.start && hour < quiet.end;
}

/** The first minute at or after `at` that is outside quiet hours. */
export function nextAwake(at: Date, tz: string, quiet: QuietHours): Date {
  let t = new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 24 * 60 && isQuiet(t, tz, quiet); i++) t = new Date(t.getTime() + 60_000);
  return t;
}

export interface CronJobApi {
  request(opts: { method: "GET" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown }): Promise<unknown>;
}

export function cronJobGateway(opts: { baseUrl: string; fetchImpl?: typeof fetch }): CronJobApi {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request({ method, path, body }) {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`cron-job.org ${res.status}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : {};
    },
  };
}

export interface WakeStore {
  get(): { jobId?: number; nextAt?: string };
  set(value: { jobId?: number; nextAt?: string }): void;
}

/** cron-job.org's schedule for one exact minute in `tz`. It repeats yearly, and Peril moves it after every fire. */
export function scheduleFor(at: Date, tz: string): Record<string, unknown> {
  const p = localParts(at, tz);
  return { timezone: tz, expiresAt: 0, hours: [p.hour], minutes: [p.minute], mdays: [p.dom], months: [p.month], wdays: [-1] };
}

export class WakePlanner {
  constructor(
    private readonly opts: { api: CronJobApi | undefined; store: WakeStore; tickUrl: string | undefined; tz: string; now?: () => Date },
  ) {}

  /** Point the single cron-job.org job at `next`, or disable it. Skips the API call when nothing changed. */
  async plan(next: Date | undefined): Promise<"unchanged" | "moved" | "disabled" | "unconfigured"> {
    const { api, store, tickUrl, tz } = this.opts;
    if (!api || !tickUrl) return "unconfigured";
    const now = (this.opts.now ?? (() => new Date()))();
    const target = next ? new Date(Math.max(Math.ceil(next.getTime() / 60_000) * 60_000, Math.ceil((now.getTime() + 1) / 60_000) * 60_000)) : undefined;
    const current = store.get();
    const targetIso = target?.toISOString();
    if (current.jobId !== undefined && current.nextAt === targetIso) return "unchanged";
    if (!target) {
      if (current.jobId !== undefined) await api.request({ method: "PATCH", path: `/jobs/${current.jobId}`, body: { job: { enabled: false } } });
      store.set({ ...(current.jobId !== undefined ? { jobId: current.jobId } : {}) });
      return "disabled";
    }
    const job = { url: tickUrl, enabled: true, saveResponses: false, title: "peril wake", requestTimeout: 30, schedule: scheduleFor(target, tz) };
    let jobId = current.jobId;
    if (jobId === undefined) {
      const created = (await api.request({ method: "PUT", path: "/jobs", body: { job } })) as { jobId?: number };
      jobId = created.jobId;
    } else {
      await api.request({ method: "PATCH", path: `/jobs/${jobId}`, body: { job } });
    }
    store.set({ ...(jobId !== undefined ? { jobId } : {}), nextAt: targetIso });
    return "moved";
  }
}
