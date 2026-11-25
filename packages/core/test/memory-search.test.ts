import { describe, expect, it } from "bun:test";
import { MemoryStore } from "../src/memory.js";
import { MemoryIndex } from "../src/memory-search.js";
import { tempState } from "./helpers.js";

describe("MemoryIndex", () => {
  const state = tempState();
  const memory = new MemoryStore(state);
  memory.appendDurable("- Mother: Sunita, lives in Jaipur, calls on Sundays.");
  memory.appendDurable("- Rahul Sharma (rahul@acme.in) is Kartik's cofounder at Acme.");
  memory.appendDurable("- Prefers window seats on flights; flies IndiGo.");
  memory.appendDurable("- Allergic to peanuts; loves South Indian breakfast.");
  memory.appendDurable("- Dentist: Dr. Mehta, Indiranagar, cleaning every 6 months.");
  memory.appendJournal("Booked dinner at Toit for Friday with Rahul.", new Date("2026-11-20T12:00:00Z"));
  const index = new MemoryIndex(state);
  const top = (q: string) => index.search(q, 3).map((h) => h.line).join(" | ");

  const cases: Array<[string, string]> = [
    ["mom", "Sunita"],
    ["mum's city", "Jaipur"],
    ["cofounder", "Rahul"],
    ["rahul email", "rahul@acme.in"],
    ["seat preference", "window"],
    ["flight", "IndiGo"],
    ["allergies", "peanuts"],
    ["breakfast", "South Indian"],
    ["doctor", "Dr. Mehta"],
    ["dinner friday", "Toit"],
  ];
  for (const [query, expected] of cases) {
    it(`finds "${expected}" for "${query}"`, () => {
      expect(top(query)).toContain(expected);
    });
  }
});
