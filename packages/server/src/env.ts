/**
 * Everything Peril reads from its environment, parsed once at boot. Secrets are read from
 * mode-0600 files under the state dir, written by the owner's hidden prompt, never from
 * chat and never from the repo.
 */
import fs from "node:fs";
import path from "node:path";

export interface PerilEnv {
  dataDir: string;
  port: number;
  /** Public Sprite URL, e.g. https://peril-xxxx.sprites.app */
  publicUrl: string | undefined;
  owner: { name: string; phone: string; email: string | undefined; timezone: string };
  agentName: string;
  models: { chat: string | undefined; deep: string | undefined };
  kiroBin: string;
  /** Kiro workspace: steering, skills and the agent config live under its .kiro/. */
  workspace: string;
  photon: { projectId: string; projectSecret: string; webhookSecret: string } | undefined;
  composio: { gatewayUrl: string; userId: string; toolkits: string[] } | undefined;
  cronJob: { gatewayUrl: string } | undefined;
  /** Shared secret in the /tick URL that cron-job.org calls. */
  tickKey: string | undefined;
  /** Shared secret for Composio trigger webhooks. */
  composioWebhookSecret: string | undefined;
  quietHours: { start: number; end: number };
  briefingCron: string;
  nightlyCron: string;
  /** Use the Sprites Tasks API on /.sprite/api.sock. Off outside a Sprite. */
  spriteSocket: string | undefined;
}

function readSecret(dataDir: string, name: string): string | undefined {
  const file = path.join(dataDir, "secrets", name);
  if (!fs.existsSync(file)) return undefined;
  const value = fs.readFileSync(file, "utf8").trim();
  return value || undefined;
}

function hourRange(raw: string | undefined, fallback: { start: number; end: number }): { start: number; end: number } {
  const m = raw?.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return fallback;
  return { start: Number(m[1]) % 24, end: Number(m[2]) % 24 };
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): PerilEnv {
  const dataDir = env.PERIL_DATA_DIR ?? path.join(process.cwd(), ".peril");
  const secret = (name: string) => readSecret(dataDir, name) ?? env[`PERIL_${name.toUpperCase().replace(/-/g, "_")}`];
  const photonSecret = secret("photon-project-secret");
  const photonWebhook = secret("photon-webhook-secret");
  const composioGateway = env.PERIL_COMPOSIO_GATEWAY;
  const cronGateway = env.PERIL_CRONJOB_GATEWAY;
  const socket = env.PERIL_SPRITE_SOCKET ?? (fs.existsSync("/.sprite/api.sock") ? "/.sprite/api.sock" : undefined);
  return {
    dataDir,
    port: Number(env.PORT ?? 8080),
    publicUrl: env.PERIL_PUBLIC_URL?.replace(/\/+$/, ""),
    owner: {
      name: env.PERIL_OWNER_NAME ?? "Kartik",
      phone: env.PERIL_OWNER_PHONE ?? "",
      email: env.PERIL_OWNER_EMAIL,
      timezone: env.PERIL_TIMEZONE ?? "Asia/Kolkata",
    },
    agentName: env.PERIL_AGENT_NAME ?? "Peril",
    models: { chat: env.PERIL_CHAT_MODEL, deep: env.PERIL_DEEP_MODEL },
    kiroBin: env.PERIL_KIRO_BIN ?? "kiro-cli",
    workspace: env.PERIL_WORKSPACE ?? path.join(dataDir, "workspace"),
    photon: env.PERIL_PHOTON_PROJECT_ID && photonSecret && photonWebhook ? { projectId: env.PERIL_PHOTON_PROJECT_ID, projectSecret: photonSecret, webhookSecret: photonWebhook } : undefined,
    composio: composioGateway
      ? { gatewayUrl: composioGateway, userId: env.PERIL_COMPOSIO_USER_ID ?? "default", toolkits: (env.PERIL_COMPOSIO_TOOLKITS ?? "gmail,googlecalendar").split(",").map((s) => s.trim()).filter(Boolean) }
      : undefined,
    cronJob: cronGateway ? { gatewayUrl: cronGateway } : undefined,
    tickKey: secret("tick-key"),
    composioWebhookSecret: secret("composio-webhook-secret"),
    quietHours: hourRange(env.PERIL_QUIET_HOURS, { start: 21, end: 8 }),
    briefingCron: env.PERIL_BRIEFING_CRON ?? "30 8 * * *",
    nightlyCron: env.PERIL_NIGHTLY_CRON ?? "0 3 * * *",
    spriteSocket: socket,
  };
}
