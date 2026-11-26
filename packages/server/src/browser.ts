/**
 * The browser, behind the policy guard. Kiro drives agent-browser only through these tools,
 * so every page read taints the session and every commit (submit, pay, book, send) waits
 * for Kartik's thumbs-up. `browser_click` refuses an element whose label reads like a
 * commit and points Kiro at `browser_submit`, which always asks.
 */
import { Type } from "typebox";
import { defineTool, textResult, type RegisteredTool } from "@peril/core";

export type BrowserCli = (args: string[]) => Promise<{ ok: boolean; out: string }>;

export const agentBrowserCli: BrowserCli = async (args) => {
  const proc = Bun.spawn(["agent-browser", ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { ok: (await proc.exited) === 0, out: out.trim().slice(0, 15_000) };
};

/** Words on a button or link that commit Kartik to something. */
export const COMMIT_LABEL =
  /\b(pay|place order|order now|buy|purchase|checkout|check out|confirm|book|reserve|submit|send|post|publish|share|invite|delete|remove|cancel|subscribe|sign up|register|enroll|apply|transfer|donate|allow|authori[sz]e|approve|accept|agree|continue|proceed|join|follow|yes|ok|okay|save|done|finish|update|change|unsubscribe|archive|report|block)\b/i;
/** Cookie-banner dismissals that look like commits but only close the banner. */
const DISMISS_LABEL = /^\s*(accept all( cookies)?|accept cookies|got it|close|dismiss|no,? thanks|not now|reject all( cookies)?|maybe later)\s*$/i;

export function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
/** Keys that move around a page without submitting anything. */
const NAV_KEYS: ReadonlySet<string> = new Set(["escape", "tab", "shift+tab", "arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown", "home", "end"]);

const REF = Type.String({ description: "Element ref from the last snapshot, e.g. @e7" });

function out(r: { ok: boolean; out: string }, okText?: string) {
  return r.ok ? textResult(okText ?? (r.out || "done")) : { content: [{ type: "text" as const, text: `browser: ${r.out || "failed"}` }], isError: true };
}

export function browserTools(deps: { cli: BrowserCli }): RegisteredTool[] {
  const { cli } = deps;
  const meta = (describe: (a: unknown) => string) => ({ capabilities: ["computer.use" as const], group: "computer" as const, describe });
  const arg = (a: unknown, k: string) => String((a as Record<string, unknown>)[k] ?? "");
  return [
    defineTool({
      name: "browser_open",
      label: "Open a page",
      description: "Open a URL in Peril's Chrome (logins Kartik saved are kept). Then call browser_snapshot.",
      parameters: Type.Object({ url: Type.String() }),
      meta: meta((a) => `open ${arg(a, "url")}`),
      execute: async ({ url }) => {
        if (!/^https?:\/\//i.test(url)) return { content: [{ type: "text", text: "Only http and https URLs." }], isError: true };
        return out(await cli(["open", url]), `opened ${url}`);
      },
    }),
    defineTool({
      name: "browser_snapshot",
      label: "Read the page",
      description: "Read the current page as an accessibility tree. Each interactive element has a ref like @e3. Take a new snapshot after every change.",
      parameters: Type.Object({}),
      meta: meta(() => "snapshot"),
      execute: async () => out(await cli(["snapshot", "-i", "-c"])),
    }),
    defineTool({
      name: "browser_click",
      label: "Click",
      description: "Click an element that does not commit Kartik to anything (a tab, a filter, a date, Next). For anything that submits, pays, books or sends, use browser_submit.",
      parameters: Type.Object({ ref: REF }),
      meta: meta((a) => `click ${arg(a, "ref")}`),
      execute: async ({ ref }) => {
        const label = await cli(["get", "text", ref]);
        if (!label.ok || !normalizeLabel(label.out)) return { content: [{ type: "text", text: `${ref} has no readable label (an icon button?), so it is not clicked. If it commits, use browser_submit; otherwise describe it to Kartik.` }], isError: true };
        if (COMMIT_LABEL.test(label.out) && !DISMISS_LABEL.test(label.out)) {
          return { content: [{ type: "text", text: `"${label.out.slice(0, 60)}" commits Kartik. Use browser_submit with the page URL, this label and what it does.` }], isError: true };
        }
        return out(await cli(["click", ref]), `clicked ${ref}; snapshot to see the result`);
      },
    }),
    defineTool({
      name: "browser_fill",
      label: "Type into a field",
      description: "Type text into an input. Never type passwords or card numbers.",
      parameters: Type.Object({ ref: REF, text: Type.String() }),
      meta: meta((a) => `fill ${arg(a, "ref")}`),
      execute: async ({ ref, text }) => out(await cli(["fill", ref, text]), `filled ${ref}`),
    }),
    defineTool({
      name: "browser_press",
      label: "Press a key",
      description: "Press a navigation key: Escape, Tab, Shift+Tab, an arrow, PageUp, PageDown, Home or End. Keys that can submit (Enter, Space) are refused; use browser_submit.",
      parameters: Type.Object({ key: Type.String() }),
      meta: meta((a) => `press ${arg(a, "key")}`),
      execute: async ({ key }) => {
        if (!NAV_KEYS.has(key.trim().toLowerCase().replace(/\s+/g, ""))) return { content: [{ type: "text", text: `${key} can submit a form. Use browser_submit, or click the element.` }], isError: true };
        return out(await cli(["press", key]));
      },
    }),
    defineTool({
      name: "browser_submit",
      label: "Submit, book or pay",
      description:
        "Click the element that submits, books, pays or sends. Waits for Kartik's thumbs-up on exactly what you describe. Before clicking, Peril checks the page is still at `url` and the element still reads `label`.",
      parameters: Type.Object({
        ref: REF,
        url: Type.String({ description: "The current page URL, from the snapshot" }),
        label: Type.String({ description: "The element's exact visible text from the snapshot, e.g. 'Place Order ₹438'. Kartik sees it, and Peril clicks only if the element reads exactly this." }),
        what: Type.String({ description: "What clicking it does, with the price, e.g. 'place the Swiggy order for ₹438 incl. fees'" }),
      }),
      meta: { capabilities: ["computer.use", "plans.commit"], group: "computer", describe: (a) => arg(a, "what") },
      execute: async ({ ref, url, label }) => {
        const here = await cli(["get", "url"]);
        const text = await cli(["get", "text", ref]);
        if (!here.ok || here.out.trim() !== url.trim()) return { content: [{ type: "text", text: `The page moved (now ${here.out.slice(0, 120)}), so nothing was clicked. Ask again from the current page.` }], isError: true };
        const wanted = normalizeLabel(label);
        if (!wanted || !text.ok || normalizeLabel(text.out) !== wanted) {
          return { content: [{ type: "text", text: `${ref} reads "${normalizeLabel(text.out).slice(0, 80)}", not exactly "${label}", so nothing was clicked. Ask again with the element's exact text.` }], isError: true };
        }
        const clicked = await cli(["click", ref]);
        // A click that failed partway may still have landed: leave it in doubt rather than allow a retry.
        if (!clicked.ok) throw new Error(`click on ${ref} did not confirm: ${clicked.out.slice(0, 200)}`);
        return textResult(`clicked ${ref}; snapshot to confirm what happened`);
      },
    }),
  ];
}
