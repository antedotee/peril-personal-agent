import fs from "node:fs";
import path from "node:path";
import type { AgentProcess, SessionRecord, SessionStore } from "./brain.js";

/** Spawn `kiro-cli acp`. setup.sh pins the V3 harness with `kiro-cli settings acp.agentEngine v3`. stderr goes to the service log. */
export function spawnKiro(opts: { bin?: string; cwd: string }): AgentProcess {
  const args = [opts.bin ?? "kiro-cli", "acp"];
  const proc = Bun.spawn(args, { cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  return {
    stdin: { write: (line) => void proc.stdin.write(line) },
    stdout: proc.stdout,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

/** Conversation key to Kiro session id, persisted so a cold wake can `session/load`. */
export class FileSessionStore implements SessionStore {
  private readonly map: Record<string, SessionRecord>;

  constructor(private readonly file: string) {
    this.map = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, SessionRecord>) : {};
  }

  get(key: string): SessionRecord | undefined {
    return this.map[key];
  }

  set(key: string, record: SessionRecord): void {
    this.map[key] = record;
    this.save();
  }

  delete(key: string): void {
    delete this.map[key];
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.map, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
