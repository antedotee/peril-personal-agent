/**
 * A stateless MCP server over Streamable HTTP: each POST carries one JSON-RPC message and
 * gets one JSON response. Peril serves it from its own process, so the policy guard,
 * approvals and receipts live next to the state they protect.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpCallResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface McpBackend {
  list(scope: string): McpToolDescriptor[];
  call(opts: { name: string; args: unknown; scope: string }): Promise<McpCallResult>;
}

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

function isRpcMessage(value: unknown): value is RpcMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleMcp(request: Request, backend: McpBackend, opts: { serverName?: string } = {}): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  const scope = request.headers.get("x-peril-scope") ?? "owner";
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  if (!isRpcMessage(message) || typeof message.method !== "string") {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }, 400);
  }
  if (message.id === undefined || message.id === null) return new Response(null, { status: 202 });
  const id = message.id;
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id, result });
  const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.serverName ?? "peril", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: backend.list(scope) });
    case "tools/call": {
      if (typeof params.name !== "string") return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "tools/call needs a name" } });
      try {
        return reply(await backend.call({ name: params.name, args: params.arguments ?? {}, scope }));
      } catch (error) {
        return reply({ content: [{ type: "text", text: `Tool failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
      }
    }
    default:
      return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}
