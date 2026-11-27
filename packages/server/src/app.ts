/**
 * Two HTTP surfaces. The public one sits behind the Sprite URL and takes only signed or
 * keyed webhooks. The local one (127.0.0.1) serves MCP to Kiro and is never reachable from
 * outside the Sprite.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { handleMcp, type McpBackend } from "@peril/tools-mcp";

export interface PublicDeps {
  agentName: string;
  photonStatus?: () => string;
  /** Verify and accept a Photon webhook. Undefined until Photon is configured. */
  photonWebhook: ((request: Request) => Promise<Response>) | undefined;
  tickKey: string | undefined;
  onTick: () => Promise<unknown>;
  appEvents: ((request: Request) => Promise<Response>) | undefined;
}

function sameSecret(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicApp(deps: PublicDeps): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, agent: deps.agentName, ...(deps.photonStatus ? { photon: deps.photonStatus() } : {}) }));
  app.post("/photon", async (c) => {
    if (!deps.photonWebhook) return c.text("photon not configured", 503);
    return deps.photonWebhook(c.req.raw);
  });
  // Answer at once: the tick holds the Sprite awake itself, and cron-job.org times out at 30 s.
  const tick = (c: { req: { query: (k: string) => string | undefined }; json: (v: unknown, s?: 202 | 401) => Response }) => {
    if (!sameSecret(c.req.query("key"), deps.tickKey)) return c.json({ ok: false }, 401);
    void deps.onTick().catch(() => undefined);
    return c.json({ ok: true }, 202);
  };
  app.get("/tick", tick);
  app.post("/tick", tick);
  app.post("/events/composio", async (c) => {
    if (!deps.appEvents) return c.text("events not configured", 503);
    return deps.appEvents(c.req.raw);
  });
  app.notFound((c) => c.text("not found", 404));
  return app;
}

export function localApp(backend: McpBackend, opts: { token?: string } = {}): Hono {
  const app = new Hono();
  app.post("/mcp", (c) => handleMcp(c.req.raw, backend, opts.token === undefined ? {} : { token: opts.token }));
  app.get("/mcp", () => new Response("method not allowed", { status: 405, headers: { allow: "POST" } }));
  return app;
}
