/**
 * `bun run doctor`: one line per integration, with the next step when something is missing.
 * Runs inside the Sprite. Prints no secret values.
 */
import { loadEnv } from "./env.js";

type Check = { name: string; run: () => Promise<{ ok: boolean; detail: string }> };

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { code: await proc.exited, out: out.trim() };
  } catch (error) {
    return { code: 127, out: error instanceof Error ? error.message : String(error) };
  }
}

const env = loadEnv();

const checks: Check[] = [
  { name: "bun", run: async () => ({ ok: true, detail: Bun.version }) },
  {
    name: "kiro-cli",
    run: async () => {
      const r = await sh([env.kiroBin, "whoami"]);
      return r.code === 0 ? { ok: true, detail: r.out.split("\n")[0] ?? "signed in" } : { ok: false, detail: "run: kiro-cli login --use-device-flow (choose Your organization)" };
    },
  },
  {
    name: "agent-browser",
    run: async () => {
      const r = await sh(["agent-browser", "--version"]);
      return r.code === 0 ? { ok: true, detail: r.out } : { ok: false, detail: "run: npm i -g agent-browser && agent-browser install --with-deps" };
    },
  },
  { name: "owner phone", run: async () => (env.owner.phone ? { ok: true, detail: "set" } : { ok: false, detail: "set PERIL_OWNER_PHONE in peril.env" }) },
  { name: "public url", run: async () => {
      if (!env.publicUrl) return { ok: false, detail: "set PERIL_PUBLIC_URL from `sprite url -s peril`" };
      try {
        const res = await fetch(`${env.publicUrl}/health`);
        return { ok: res.ok, detail: `${env.publicUrl}/health -> ${res.status}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    } },
  { name: "photon", run: async () => (env.photon ? { ok: true, detail: `project ${env.photon.projectId}` } : { ok: false, detail: "set PERIL_PHOTON_PROJECT_ID and write secrets/photon-project-secret, secrets/photon-webhook-secret" }) },
  {
    name: "sprites connectors",
    run: async () => {
      try {
        const res = await fetch("https://api.sprites.dev/v1/gateway/list");
        const body = await res.text();
        return { ok: res.ok, detail: res.ok ? body.slice(0, 400) : `gateway list -> ${res.status} (works only inside a Sprite)` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  { name: "composio", run: async () => (env.composio ? { ok: true, detail: env.composio.gatewayUrl } : { ok: false, detail: "create the Composio connector, then set PERIL_COMPOSIO_GATEWAY" }) },
  { name: "cron-job.org", run: async () => (env.cronJob ? { ok: true, detail: env.cronJob.gatewayUrl } : { ok: false, detail: "create a Custom API connector for https://api.cron-job.org, then set PERIL_CRONJOB_GATEWAY" }) },
  { name: "tick key", run: async () => (env.tickKey ? { ok: true, detail: "set" } : { ok: false, detail: "rerun setup.sh to generate secrets/tick-key" }) },
  { name: "sprite tasks api", run: async () => (env.spriteSocket ? { ok: true, detail: env.spriteSocket } : { ok: false, detail: "not inside a Sprite; holds are disabled" }) },
];

let failed = 0;
for (const check of checks) {
  const result = await check.run();
  if (!result.ok) failed++;
  process.stdout.write(`${result.ok ? "ok  " : "MISS"} ${check.name.padEnd(20)} ${result.detail}\n`);
}
process.exit(failed === 0 ? 0 : 1);
