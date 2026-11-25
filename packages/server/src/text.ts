/**
 * How Peril texts: short bubbles, no markdown, links on their own line. Kiro writes the
 * words; this file only cleans up what a phone would render badly and pulls out the
 * markers Peril's steering asks for.
 */

export const NOTHING = "NOTHING";
const OPEN_MARKER = /^\s*\[open:\s*(.+?)\]\s*$/im;
const MAX_BUBBLES = 4;

export interface Cleaned {
  bubbles: string[];
  openLoop: string | undefined;
  silent: boolean;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1\n$2")
    .replace(/^\s*[-*]\s+/gm, "- ");
}

export function cleanReply(raw: string): Cleaned {
  const openMatch = raw.match(OPEN_MARKER);
  const body = stripMarkdown(raw.replace(OPEN_MARKER, "")).trim();
  if (!body || body === NOTHING) return { bubbles: [], openLoop: openMatch?.[1], silent: true };
  const parts: string[] = [];
  for (const para of body.split(/\n\s*\n/)) {
    const lines = para.split("\n");
    const links = lines.filter((l) => /^https?:\/\/\S+$/.test(l.trim()));
    const words = lines.filter((l) => !/^https?:\/\/\S+$/.test(l.trim())).join("\n").trim();
    if (words) parts.push(words);
    parts.push(...links.map((l) => l.trim()));
  }
  const bubbles = parts.length > MAX_BUBBLES ? [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join("\n\n")] : parts;
  return { bubbles, openLoop: openMatch?.[1], silent: false };
}

export function localTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(at);
}
