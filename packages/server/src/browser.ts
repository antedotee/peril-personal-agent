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
export const COMMIT_LABEL = /\b(pay|place order|buy|purchase|checkout|check out|confirm|book|reserve|submit|send|delete|remove|cancel (my )?(order|booking|subscription)|subscribe|sign up|transfer|donate)\b/i;

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
        if (label.ok && COMMIT_LABEL.test(label.out)) {
          return { content: [{ type: "text", text: `"${label.out.slice(0, 60)}" commits Kartik. Use browser_submit with a description of what it does.` }], isError: true };
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
      description: "Press a key such as Escape or Tab. Enter in a form counts as a submit; use browser_submit for that.",
      parameters: Type.Object({ key: Type.String() }),
      meta: meta((a) => `press ${arg(a, "key")}`),
      execute: async ({ key }) => {
        if (/^enter$/i.test(key.trim())) return { content: [{ type: "text", text: "Enter can submit a form. Use browser_submit." }], isError: true };
        return out(await cli(["press", key]));
      },
    }),
    defineTool({
      name: "browser_submit",
      label: "Submit, book or pay",
      description: "Click the element that submits, books, pays or sends. Always waits for Kartik's thumbs-up on exactly what you describe: site, what happens, total price.",
      parameters: Type.Object({ ref: REF, what: Type.String({ description: "What clicking it does, with the price, e.g. 'place the Swiggy order for ₹438 incl. fees'" }) }),
      meta: { capabilities: ["computer.use", "plans.commit"], group: "computer", describe: (a) => arg(a, "what") },
      execute: async ({ ref }) => out(await cli(["click", ref]), `clicked ${ref}; snapshot to confirm what happened`),
    }),
  ];
}
