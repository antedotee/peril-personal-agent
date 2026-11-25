/**
 * Newline-delimited JSON-RPC 2.0, the framing ACP uses over stdio. Small on purpose: Peril
 * needs requests, notifications and answering the agent's own requests, nothing else.
 */

export interface RpcHandlers {
  onRequest(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

type Incoming = {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function isIncoming(value: unknown): value is Incoming {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private closed = false;

  constructor(
    private readonly write: (line: string) => void,
    private readonly handlers: RpcHandlers,
  ) {}

  /** Feed raw stdout bytes from the agent. Resolves when the stream ends. */
  async pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = readable.getReader();
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.receive(line);
        nl = buffer.indexOf("\n");
      }
    }
    this.close(new Error("agent stream ended"));
  }

  receive(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!isIncoming(msg)) return;
    if (msg.method !== undefined) {
      if (msg.id === undefined || msg.id === null) {
        this.handlers.onNotification(msg.method, msg.params);
        return;
      }
      const id = msg.id;
      this.handlers.onRequest(msg.method, msg.params).then(
        (result) => this.send({ jsonrpc: "2.0", id, result: result ?? null }),
        (error: unknown) => {
          const rpc = error instanceof RpcError ? error : new RpcError(-32603, error instanceof Error ? error.message : String(error));
          this.send({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message } });
        },
      );
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else waiter.resolve(msg.result);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("agent connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  close(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(reason);
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private send(message: object): void {
    this.write(`${JSON.stringify(message)}\n`);
  }
}
