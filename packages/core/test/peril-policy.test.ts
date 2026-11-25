import { describe, expect, it } from "bun:test";
import { PolicyEngine } from "../src/policy.js";
import { perilPolicy } from "../src/peril-policy.js";
import { principalOf } from "./helpers.js";

const owner = principalOf("owner");
const engine = new PolicyEngine(perilPolicy());
const decide = (capabilities: Parameters<PolicyEngine["evaluate"]>[1]["capabilities"]) =>
  engine.evaluate(owner, { capabilities, group: "apps" }, {}).outcome;

describe("perilPolicy", () => {
  it("lets the owner's agent read, remind and hold time without asking", () => {
    expect(decide(["email.read"])).toBe("allow");
    expect(decide(["calendar.read"])).toBe("allow");
    expect(decide(["calendar.write"])).toBe("allow");
    expect(decide(["schedule.manage"])).toBe("allow");
    expect(decide(["memory.write"])).toBe("allow");
    expect(decide(["web.read"])).toBe("allow");
  });

  it("asks before anything leaves, commits, spends or deletes", () => {
    expect(decide(["email.send"])).toBe("ask");
    expect(decide(["plans.commit"])).toBe("ask");
    expect(decide(["purchase"])).toBe("ask");
    expect(decide(["data.delete"])).toBe("ask");
    expect(decide(["calendar.write", "plans.commit"])).toBe("ask");
  });

  it("denies strangers everything but an introduction", () => {
    const stranger = principalOf("stranger");
    expect(engine.evaluate(stranger, { capabilities: ["email.read"], group: "apps" }, {}).outcome).toBe("deny");
  });
});
