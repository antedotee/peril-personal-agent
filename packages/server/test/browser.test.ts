import { describe, expect, it } from "bun:test";
import type { ToolContext } from "@peril/core";
import { browserTools, type BrowserCli } from "../src/browser.js";

const ctx: ToolContext = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Kartik" }, conversationKey: "owner", channel: "imessage", now: () => new Date() };

function tools(labels: Record<string, string>) {
  const calls: string[][] = [];
  const cli: BrowserCli = async (args) => {
    calls.push(args);
    if (args[0] === "get" && args[1] === "text") return { ok: true, out: labels[args[2]!] ?? "" };
    return { ok: true, out: "ok" };
  };
  const byName = new Map(browserTools({ cli }).map((t) => [t.spec.name, t.spec]));
  return { calls, run: (name: string, args: unknown) => byName.get(name)!.execute(args as never, ctx) };
}

describe("browser tools", () => {
  it("clicks an ordinary element but refuses one that commits, pointing at browser_submit", async () => {
    const { calls, run } = tools({ "@e1": "Next", "@e2": "Place order ₹438" });
    await run("browser_click", { ref: "@e1" });
    expect(calls.at(-1)).toEqual(["click", "@e1"]);
    const out = await run("browser_click", { ref: "@e2" });
    expect(JSON.stringify(out)).toContain("browser_submit");
    expect(calls.filter((c) => c[0] === "click")).toHaveLength(1);
  });

  it("refuses Enter, which can submit a form", async () => {
    const { calls, run } = tools({});
    const out = await run("browser_press", { key: "Enter" });
    expect(JSON.stringify(out)).toContain("browser_submit");
    expect(calls).toHaveLength(0);
  });

  it("asks the owner before browser_submit, through its plans.commit capability", () => {
    const submit = browserTools({ cli: async () => ({ ok: true, out: "" }) }).find((t) => t.spec.name === "browser_submit");
    expect(submit?.spec.meta.capabilities).toContain("plans.commit");
  });
});
