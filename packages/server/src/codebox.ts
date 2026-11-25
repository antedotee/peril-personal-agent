/**
 * One-time codes for logins. When a site asks for a code, Peril asks Kartik to text it.
 * The conductor catches that reply before Kiro sees it, and `fill_code` types it into the
 * page through agent-browser. The code lives in memory for a few minutes, never on disk,
 * never in the audit log, never in a prompt.
 */
import { Type } from "typebox";
import { defineTool, textResult, type RegisteredTool } from "@peril/core";

const WAIT_MS = 10 * 60 * 1000;
const CODE = /^\s*([0-9]{4,8}|[A-Z0-9]{6,8})\s*$/;

export class CodeBox {
  private waitingUntil = 0;
  private code: string | undefined;
  private site = "";

  constructor(private readonly now: () => number = () => Date.now()) {}

  expect(site: string): void {
    this.site = site;
    this.code = undefined;
    this.waitingUntil = this.now() + WAIT_MS;
  }

  /** True when the text was a code we were waiting for. The caller must not pass it on. */
  offer(text: string): boolean {
    if (this.now() >= this.waitingUntil) return false;
    const m = text.match(CODE);
    if (!m) return false;
    this.code = m[1];
    this.waitingUntil = 0;
    return true;
  }

  take(): string | undefined {
    const c = this.code;
    this.code = undefined;
    return c;
  }

  get waitingFor(): string {
    return this.site;
  }
}

export type BrowserFill = (opts: { ref: string; value: string }) => Promise<{ ok: boolean; detail: string }>;

export const agentBrowserFill: BrowserFill = async ({ ref, value }) => {
  const proc = Bun.spawn(["agent-browser", "fill", ref, value], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { ok: (await proc.exited) === 0, detail: out.replaceAll(value, "******").slice(0, 300) };
};

export function codeTools(deps: { codes: CodeBox; fill: BrowserFill; ask: (text: string) => Promise<void> }): RegisteredTool[] {
  const awaitCode = defineTool({
    name: "await_code",
    label: "Ask for a login code",
    description: "A site asked for a one-time code. Texts Kartik to send it. His reply never reaches you; call fill_code with the input's ref once he says he sent it, or when you next run.",
    parameters: Type.Object({ site: Type.String({ description: "Which site wants the code" }) }),
    meta: { capabilities: ["computer.use"], group: "computer", describe: (a) => `ask for code: ${String((a as { site?: unknown }).site ?? "")}` },
    execute: async ({ site }) => {
      deps.codes.expect(site);
      await deps.ask(`${site} sent you a code. text it to me and I'll type it in`);
      return textResult("Asked. End your turn; you'll get a message when the code arrives.");
    },
  });
  const fillCode = defineTool({
    name: "fill_code",
    label: "Type the code",
    description: "Type the code Kartik texted into the page input with this agent-browser ref (for example @e7). You never see the code.",
    parameters: Type.Object({ ref: Type.String() }),
    meta: { capabilities: ["computer.use"], group: "computer", describe: (a) => `fill code into ${String((a as { ref?: unknown }).ref ?? "")}` },
    execute: async ({ ref }) => {
      const code = deps.codes.take();
      if (!code) return { content: [{ type: "text", text: "No code has arrived yet." }], isError: true };
      const r = await deps.fill({ ref, value: code });
      return r.ok ? textResult("Code typed. Snapshot the page to check it worked.") : { content: [{ type: "text", text: `Could not type the code: ${r.detail}` }], isError: true };
    },
  });
  return [awaitCode, fillCode];
}
