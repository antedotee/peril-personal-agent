/**
 * Tools only the server can provide, because they need the iMessage line or the brain:
 * sending a file to the owner and handing a long job to a deep session.
 */
import fs from "node:fs";
import { Type } from "typebox";
import { defineTool, resolveWorkspacePath, textResult, type RegisteredTool } from "@peril/core";
import type { OwnerLine } from "@peril/channel";
import type { ScopeState } from "@peril/tools-mcp";

export interface PerilToolDeps {
  line: OwnerLine;
  scopes: ScopeState;
  /** Directories Peril may send files from. */
  roots: string[];
  startDeepTask: (opts: { brief: string; tainted: boolean }) => string;
}

export function perilTools(deps: PerilToolDeps): RegisteredTool[] {
  const sendFile = defineTool({
    name: "send_file",
    label: "Send a file",
    description: "Send a file you made (PDF, CSV, image, HTML) to the owner as an iMessage attachment. Give a path inside the workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the workspace, or absolute inside it" }),
      caption: Type.Optional(Type.String({ description: "One short line sent after the file" })),
    }),
    meta: { capabilities: ["files.read", "owner.relay"], group: "files", describe: (a) => `send file ${String((a as { path?: unknown }).path ?? "")}` },
    execute: async ({ path, caption }) => {
      const resolved = deps.roots.map((root) => resolveWorkspacePath(root, path)).find((p) => p !== undefined && fs.existsSync(p));
      if (!resolved) return { content: [{ type: "text", text: `No such file in the workspace: ${path}` }], isError: true };
      await deps.line.file(resolved, caption);
      return textResult(`Sent ${path} to the owner.`);
    },
  });

  const deepTask = defineTool({
    name: "start_deep_task",
    label: "Start deep work",
    description:
      "Hand a long job (multi-step research, building a file or page, writing a watcher script) to a separate session on the strongest model. Returns at once; the result is texted to the owner when done. Keep chatting meanwhile.",
    parameters: Type.Object({ brief: Type.String({ description: "Everything the worker needs: goal, constraints, what to send back" }) }),
    meta: { capabilities: ["converse"], group: "system", describe: (a) => `deep task: ${String((a as { brief?: unknown }).brief ?? "").slice(0, 80)}` },
    execute: async ({ brief }, ctx) => {
      const key = deps.startDeepTask({ brief, tainted: deps.scopes.isTainted(ctx.conversationKey) });
      return textResult(`Started ${key}. Tell the owner in a few words that you're on it; the result arrives on its own.`);
    },
  });

  return [sendFile, deepTask];
}
