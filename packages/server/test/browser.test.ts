import { describe, expect, it } from "bun:test";
import type { ToolContext } from "@peril/core";
import { browserTools, normalizeLabel, type BrowserCli } from "../src/browser.js";

const ctx: ToolContext = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Kartik" }, conversationKey: "owner", channel: "imessage", now: () => new Date() };

function tools(labels: Record<string, string>, opts: { url?: string; clickFails?: boolean } = {}) {
  const calls: string[][] = [];
  const cli: BrowserCli = async (args) => {
    calls.push(args);
    if (args[0] === "get" && args[1] === "text") return args[2]! in labels ? { ok: true, out: labels[args[2]!]! } : { ok: false, out: "no element" };
    if (args[0] === "get" && args[1] === "url") return { ok: true, out: opts.url ?? "https://swiggy.com/checkout" };
    if (args[0] === "click" && opts.clickFails) return { ok: false, out: "timeout" };
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

  it("presses only navigation keys", async () => {
    const { calls, run } = tools({});
    for (const key of ["Enter", "Space", "NumpadEnter", "Control+Enter", " "]) {
      expect(JSON.stringify(await run("browser_press", { key }))).toContain("browser_submit");
    }
    await run("browser_press", { key: "Escape" });
    expect(calls).toEqual([["press", "Escape"]]);
  });

  it("refuses to click an element whose label it cannot read, and buttons like Allow, Post and Continue", async () => {
    const { calls, run } = tools({ "@e0": "  ", "@e2": "Allow", "@e3": "Post", "@e4": "Continue to payment", "@e5": "Accept all", "@e6": "Yes", "@e7": "Save", "@e8": "Accept", "@e10": "Close account" });
    for (const ref of ["@e0", "@e1", "@e2", "@e3", "@e4", "@e6", "@e7", "@e8", "@e10"]) expect(JSON.stringify(await run("browser_click", { ref }))).toMatch(/browser_submit|not clicked/);
    await run("browser_click", { ref: "@e5" });
    expect(calls.filter((c) => c[0] === "click")).toEqual([["click", "@e5"]]);
  });

  it("browser_submit clicks only if the page and the label still match what Kartik approved", async () => {
    const moved = tools({ "@e9": "Place Order" }, { url: "https://evil.example/pay" });
    await moved.run("browser_submit", { ref: "@e9", url: "https://swiggy.com/checkout", label: "Place Order", what: "order" });
    expect(moved.calls.filter((c) => c[0] === "click")).toHaveLength(0);
    const relabeled = tools({ "@e9": "Delete account" });
    await relabeled.run("browser_submit", { ref: "@e9", url: "https://swiggy.com/checkout", label: "Place Order", what: "order" });
    expect(relabeled.calls.filter((c) => c[0] === "click")).toHaveLength(0);
    const partial = tools({ "@e9": "Pay ₹50,000 to Mallory" });
    for (const label of ["", "Pay"]) await partial.run("browser_submit", { ref: "@e9", url: "https://swiggy.com/checkout", label, what: "pay the ₹500 bill" });
    expect(partial.calls.filter((c) => c[0] === "click")).toHaveLength(0);
    const ok = tools({ "@e9": "Place  Order ₹438 " });
    await ok.run("browser_submit", { ref: "@e9", url: "https://swiggy.com/checkout", label: "Place Order ₹438", what: "order" });
    expect(ok.calls.filter((c) => c[0] === "click")).toEqual([["click", "@e9"]]);
  });

  it("browser_submit throws when the click does not confirm, so the guard leaves it in doubt", async () => {
    const { run } = tools({ "@e9": "Place Order" }, { clickFails: true });
    expect(normalizeLabel("  a \n b ")).toBe("a b");
    await expect(run("browser_submit", { ref: "@e9", url: "https://swiggy.com/checkout", label: "Place Order", what: "order" })).rejects.toThrow("did not confirm");
  });

  it("asks the owner before browser_submit, through its plans.commit capability", () => {
    const submit = browserTools({ cli: async () => ({ ok: true, out: "" }) }).find((t) => t.spec.name === "browser_submit");
    expect(submit?.spec.meta.capabilities).toContain("plans.commit");
  });
});
