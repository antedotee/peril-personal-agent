/**
 * Peril's autonomy, as owner-tier overrides on open-instinct's tier table. Like Fo, Peril
 * reads, reminds, drafts, holds time on the owner's own calendar and texts first without
 * asking. Anything that reaches another person, commits the owner, moves money or deletes
 * waits for a thumbs-up.
 */
import { defaultPolicy } from "./policy.js";
import type { Capability, Permission, Policy } from "./types.js";

export const OWNER_ASKS: Readonly<Partial<Record<Capability, Permission>>> = {
  "email.send": "ask",
  "plans.commit": "ask",
  purchase: "ask",
  "travel.book": "ask",
  "phone.call": "ask",
  "data.delete": "ask",
};

export function perilPolicy(): Policy {
  const policy = defaultPolicy();
  policy.tiers.owner = { ...OWNER_ASKS };
  return policy;
}
