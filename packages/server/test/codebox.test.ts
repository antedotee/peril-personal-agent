import { describe, expect, it } from "bun:test";
import { CodeBox, codeTools } from "../src/codebox.js";
import type { ToolContext } from "@peril/core";

const ctx: ToolContext = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Kartik" }, conversationKey: "owner", channel: "imessage", now: () => new Date() };

describe("CodeBox", () => {
  it("takes a code only while one is expected, and only once", () => {
    let t = 0;
    const box = new CodeBox(() => t);
    expect(box.offer("483920")).toBe(false);
    box.expect("Swiggy");
    expect(box.offer("sure, one sec")).toBe(false);
    expect(box.offer(" 483920 ")).toBe(true);
    expect(box.take()).toBe("483920");
    expect(box.take()).toBeUndefined();
    box.expect("Swiggy");
    t = 11 * 60 * 1000;
    expect(box.offer("111222")).toBe(false);
  });

  it("fill_code types the code into the page without returning it to the model", async () => {
    const box = new CodeBox();
    const filled: string[] = [];
    const asked: string[] = [];
    const [awaitCode, fillCode] = codeTools({ codes: box, fill: async ({ value }) => (filled.push(value), { ok: true, detail: "" }), ask: async (t) => void asked.push(t) });
    await awaitCode!.spec.execute({ site: "Swiggy" }, ctx);
    expect(asked[0]).toContain("Swiggy");
    box.offer("483920");
    const out = await fillCode!.spec.execute({ ref: "@e7" }, ctx);
    expect(filled).toEqual(["483920"]);
    expect(JSON.stringify(out)).not.toContain("483920");
  });
});
