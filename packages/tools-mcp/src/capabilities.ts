// Adapted from open-instinct (https://github.com/mariagorskikh/open-instinct)
// Copyright (c) 2026 Maria Gorskikh. MIT License, see NOTICE.
import type { Capability, ToolMeta } from "@peril/core";

/**
 * Owner-only tag for the Composio meta tools and for toolkits this table does not
 * know. Core's tier table opens `apps.use` to staff, partner, family and friend (it is a
 * transport tag; the per-tool capability does the gating), so `apps.use` alone would
 * let a friend's Instinct manage the owner's OAuth connections or run any tool
 * through COMPOSIO_MULTI_EXECUTE_TOOL. Until core grows a dedicated `apps.manage`
 * capability, `trust.manage` (owner only) stands in: connecting an app or running an
 * untagged toolkit as the owner is a trust decision only the owner may take.
 */
export const APPS_MANAGE: readonly Capability[] = ["apps.use", "trust.manage"];

/**
 * Owner-only tag for Google Contacts write actions. Staff holds `contacts.read` and
 * partner holds it in part, which core treats as allow, so a read tag on
 * CREATE/UPDATE/DELETE would let a teammate's or partner's Instinct rewrite the owner's
 * address book. Until core grows
 * `contacts.write`, `memory.write` (owner only) stands in: the address book is the
 * owner's memory about people.
 */
export const CONTACTS_WRITE: readonly Capability[] = ["contacts.read", "memory.write"];

/**
 * Map a Composio tool slug (for example `GMAIL_SEND_EMAIL`) to the capabilities
 * a call needs. The policy engine checks every capability against the caller's
 * tier, so this table decides what staff, a partner or a friend can do through the
 * owner's connected apps. Keep it conservative: an unknown slug is owner-only.
 *
 * Gmail, Google Calendar and Google Contacts have exact rows. Every other toolkit
 * (Slack, Notion, Stripe, the Composio meta tools, ...) gets the owner-only
 * `APPS_MANAGE` pair, plus a stricter tag when the slug looks like it sends a
 * message, changes a calendar or moves money. The extra tag is what keeps a grant
 * on `apps.use` + `trust.manage` from quietly opening payments, and `purchase` puts
 * the owner's own calls under the spend policy, which asks when no amount is known.
 */
export function capabilitiesForSlug(slug: string): Capability[] {
  const s = slug.trim().toUpperCase();

  if (s.startsWith("GMAIL_")) {
    if (GMAIL_SEND.has(s) || s.startsWith("GMAIL_FORWARD")) return ["email.send"];
    return ["email.read"];
  }

  if (s.startsWith("GOOGLECALENDAR_")) {
    if (CALENDAR_FREEBUSY.has(s)) return ["calendar.freebusy"];
    if (CALENDAR_WRITE_PREFIXES.some((p) => s.startsWith(p))) return ["calendar.write"];
    return ["calendar.read"];
  }

  if (s.startsWith("GOOGLECONTACTS_")) {
    if (CONTACTS_WRITE_PREFIXES.some((p) => s.startsWith(p))) return [...CONTACTS_WRITE];
    return ["contacts.read"];
  }

  // Meta tools (manage connections, search, multi-execute) and every toolkit without
  // a row above are owner-only. COMPOSIO_MULTI_EXECUTE_TOOL can run any tool in one
  // call, so per-tool capabilities cannot be checked for it. See README.
  return [...sensitiveCapabilitiesForSlug(s), ...APPS_MANAGE];
}

/**
 * Stricter tags for a slug outside the Google rows, judged by the words in it.
 * Reads (GET, LIST, SEARCH, ...) get nothing. Writes get:
 * - `email.send` when the slug sends, replies, forwards or drafts a message;
 * - `calendar.write` when it creates, changes or cancels a calendar event or meeting;
 * - `purchase` when it pays, charges, refunds, transfers, checks out, or places an
 *   order, and for any write in a payment toolkit (Stripe, PayPal, ...).
 * The result is empty for an ordinary write such as NOTION_CREATE_PAGE.
 */
export function sensitiveCapabilitiesForSlug(slug: string): Capability[] {
  const tokens = slug.trim().toUpperCase().split("_").filter(Boolean);
  if (tokens.length < 2) return [];
  const toolkit = tokens[0] ?? "";
  const action = tokens.slice(1);
  if (action.some((t) => READ_VERBS.has(t))) return [];
  const has = (set: ReadonlySet<string>): boolean => action.some((t) => set.has(t));

  const out: Capability[] = [];
  if (has(SEND_VERBS) || (has(DRAFT_VERBS) && has(MAIL_NOUNS))) out.push("email.send");
  if (has(CALENDAR_NOUNS) && has(CALENDAR_WRITE_VERBS)) out.push("calendar.write");
  if (has(MONEY_WORDS) || (has(ORDER_NOUNS) && has(ORDER_VERBS)) || PAYMENT_TOOLKITS.has(toolkit)) out.push("purchase");
  return out;
}

const GMAIL_SEND: ReadonlySet<string> = new Set([
  "GMAIL_SEND_EMAIL",
  "GMAIL_REPLY_TO_THREAD",
  "GMAIL_CREATE_EMAIL_DRAFT",
]);

const CALENDAR_FREEBUSY: ReadonlySet<string> = new Set([
  "GOOGLECALENDAR_FIND_FREE_SLOTS",
  "GOOGLECALENDAR_FREEBUSY",
  "GOOGLECALENDAR_GET_FREE_BUSY",
]);

const CALENDAR_WRITE_PREFIXES: readonly string[] = [
  "GOOGLECALENDAR_CREATE",
  "GOOGLECALENDAR_UPDATE",
  "GOOGLECALENDAR_DELETE",
  "GOOGLECALENDAR_PATCH",
  "GOOGLECALENDAR_QUICK_ADD",
];

/** Google Contacts actions that change the owner's address book. Checked before the read fallback. */
export const CONTACTS_WRITE_PREFIXES: readonly string[] = [
  "GOOGLECONTACTS_CREATE",
  "GOOGLECONTACTS_UPDATE",
  "GOOGLECONTACTS_DELETE",
  "GOOGLECONTACTS_BATCH",
  "GOOGLECONTACTS_MODIFY",
  "GOOGLECONTACTS_ADD",
  "GOOGLECONTACTS_REMOVE",
  "GOOGLECONTACTS_PATCH",
  "GOOGLECONTACTS_COPY",
];

/** Composio meta tools the Tool Router adds to every session. */
export const COMPOSIO_META_TOOLS: readonly string[] = [
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
];

/** A slug with one of these words after the toolkit is a read; it gets no stricter tag. */
const READ_VERBS: ReadonlySet<string> = new Set(["GET", "LIST", "RETRIEVE", "SEARCH", "FETCH", "FIND", "READ", "DESCRIBE", "COUNT", "LOOKUP", "QUERY"]);
const SEND_VERBS: ReadonlySet<string> = new Set(["SEND", "REPLY", "FORWARD"]);
const DRAFT_VERBS: ReadonlySet<string> = new Set(["DRAFT", "COMPOSE"]);
const MAIL_NOUNS: ReadonlySet<string> = new Set(["EMAIL", "EMAILS", "MAIL", "MESSAGE", "MESSAGES"]);
const CALENDAR_NOUNS: ReadonlySet<string> = new Set(["CALENDAR", "EVENT", "EVENTS", "MEETING", "MEETINGS", "APPOINTMENT", "BOOKING"]);
const CALENDAR_WRITE_VERBS: ReadonlySet<string> = new Set(["CREATE", "UPDATE", "DELETE", "PATCH", "ADD", "CANCEL", "RESCHEDULE", "MOVE", "QUICK", "SCHEDULE", "BOOK"]);
const MONEY_WORDS: ReadonlySet<string> = new Set([
  "PAY", "PAYMENT", "PAYMENTS", "PAYOUT", "PAYOUTS", "CHARGE", "CHARGES", "REFUND", "REFUNDS",
  "TRANSFER", "TRANSFERS", "CHECKOUT", "PURCHASE", "PURCHASES", "BUY",
]);
const ORDER_NOUNS: ReadonlySet<string> = new Set(["ORDER", "ORDERS"]);
const ORDER_VERBS: ReadonlySet<string> = new Set(["CREATE", "PLACE", "SUBMIT", "UPDATE", "CANCEL", "FULFILL", "COMPLETE", "CAPTURE", "CLOSE"]);
/** Toolkits whose every write moves or touches money. Composio slugs, uppercased. */
export const PAYMENT_TOOLKITS: ReadonlySet<string> = new Set([
  "STRIPE", "PAYPAL", "SQUARE", "SQUAREUP", "BRAINTREE", "RAZORPAY", "ADYEN", "COINBASE", "WISE", "VENMO",
  "GUMROAD", "LEMONSQUEEZY", "CHARGEBEE", "RECURLY", "PADDLE", "MERCURY", "BREX", "RAMP", "REVOLUT",
]);

/** Toolkit slug of a Composio tool: the part before the first underscore, lowercased. */
export function toolkitOfSlug(slug: string): string {
  const upper = slug.trim().toUpperCase();
  const idx = upper.indexOf("_");
  return (idx === -1 ? upper : upper.slice(0, idx)).toLowerCase();
}

// ---------------------------------------------------------------------------
// Peril additions. The rows above are open-instinct's; these adjust them to Peril's
// Fo-style autonomy, where the decision depends on the arguments as well as the slug.
// ---------------------------------------------------------------------------

const DELETE_WORDS: ReadonlySet<string> = new Set(["DELETE", "TRASH", "REMOVE", "PURGE", "DESTROY"]);
const RSVP_WORDS: ReadonlySet<string> = new Set(["RSVP", "ACCEPT", "DECLINE", "RESPOND"]);
/** Saving a draft in the owner's own mailbox reaches nobody, so Peril does it without asking. */
const OWN_DRAFT_SLUGS: ReadonlySet<string> = new Set(["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_UPDATE_DRAFT"]);

function hasAttendees(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const record = args as Record<string, unknown>;
  const list = record.attendees ?? record.attendee_emails ?? record.attendeeEmails;
  return Array.isArray(list) ? list.length > 0 : typeof list === "string" && list.trim() !== "";
}

/** Capabilities for one call: open-instinct's slug table, then Peril's argument-aware rules. */
export function perilCapabilitiesFor(slug: string, args: unknown): Capability[] {
  const s = slug.trim().toUpperCase();
  if (OWN_DRAFT_SLUGS.has(s)) return ["email.read"];
  const caps = new Set<Capability>(capabilitiesForSlug(s));
  const tokens = s.split("_").slice(1);
  if (tokens.some((t) => DELETE_WORDS.has(t))) caps.add("data.delete");
  if (tokens.some((t) => RSVP_WORDS.has(t))) caps.add("plans.commit");
  if (caps.has("calendar.write") && hasAttendees(args)) caps.add("plans.commit");
  return [...caps];
}

export function metaFor(slug: string, capabilities: Capability[] = capabilitiesForSlug(slug)): ToolMeta {
  return { capabilities, group: "apps", describe: () => slug };
}
