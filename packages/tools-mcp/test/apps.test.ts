import { describe, expect, it } from "bun:test";
import { gatewayTransport } from "../src/apps.js";

function fakeFetch(statuses: number[]) {
  const seen: string[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method} ${String(url)}`);
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? '{"ok":true}' : "nope", { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("gatewayTransport", () => {
  it("calls the connector gateway URL with no credential of its own", async () => {
    const { impl, seen } = fakeFetch([200]);
    const t = gatewayTransport({ baseUrl: "https://api.sprites.dev/v1/gateway/composio/conn_1/", fetchImpl: impl });
    expect(await t.request({ method: "GET", path: "/api/v3.1/tools?x=1" })).toEqual({ ok: true });
    expect(seen).toEqual(["GET https://api.sprites.dev/v1/gateway/composio/conn_1/api/v3.1/tools?x=1"]);
  });

  it("stops at once on an expired connection", async () => {
    const { impl, seen } = fakeFetch([401, 200]);
    const t = gatewayTransport({ baseUrl: "https://g", fetchImpl: impl });
    await expect(t.request({ method: "GET", path: "/x" })).rejects.toThrow("reconnecting");
    expect(seen).toHaveLength(1);
  });

  it("retries a read on a 5xx but never resends a write", async () => {
    const read = fakeFetch([503, 200]);
    expect(await gatewayTransport({ baseUrl: "https://g", fetchImpl: read.impl }).request({ method: "GET", path: "/x" })).toEqual({ ok: true });
    expect(read.seen).toHaveLength(2);
    const write = fakeFetch([503, 200]);
    await expect(gatewayTransport({ baseUrl: "https://g", fetchImpl: write.impl }).request({ method: "POST", path: "/x", body: {} })).rejects.toThrow("503");
    expect(write.seen).toHaveLength(1);
  });
});
