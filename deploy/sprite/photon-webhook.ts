/**
 * Register Peril's Photon webhook and save its signing secret, which Photon returns only
 * once. Any existing webhook for the same URL is deleted first, so this also rotates the
 * secret. The secret is written to a mode-600 file and never printed.
 *
 *   bun --env-file ~/.peril/peril.env deploy/sprite/photon-webhook.ts
 */
import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.PERIL_DATA_DIR ?? path.join(process.env.HOME ?? "", ".peril");
const projectId = process.env.PERIL_PHOTON_PROJECT_ID;
const secretFile = path.join(dataDir, "secrets", "photon-project-secret");
const webhookFile = path.join(dataDir, "secrets", "photon-webhook-secret");
const publicUrl = process.env.PERIL_PUBLIC_URL?.replace(/\/+$/, "");

if (!projectId || !publicUrl || !fs.existsSync(secretFile)) {
  console.error("Set PERIL_PHOTON_PROJECT_ID and PERIL_PUBLIC_URL in peril.env, and save secrets/photon-project-secret first.");
  process.exit(1);
}

const webhookUrl = `${publicUrl}/photon`;
const base = `https://spectrum.photon.codes/projects/${projectId}/webhooks/`;
const auth = `Basic ${Buffer.from(`${projectId}:${fs.readFileSync(secretFile, "utf8").trim()}`).toString("base64")}`;

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text.slice(0, 200);
  }
  return { status: res.status, json };
}

const listed = await call("GET", base);
if (listed.status === 401) {
  console.error("Photon rejected the project ID and secret (401). Fix secrets/photon-project-secret first.");
  process.exit(1);
}
const hooks = ((listed.json as { data?: Array<{ id: string; webhookUrl: string }> })?.data ?? []);
console.log(`registered webhooks: ${hooks.map((h) => h.webhookUrl).join(", ") || "none"}`);

for (const hook of hooks.filter((h) => h.webhookUrl.replace(/\/+$/, "") === webhookUrl)) {
  const del = await call("DELETE", `${base}${hook.id}/`);
  console.log(`deleted old webhook ${hook.id} -> ${del.status}`);
}

const created = await call("POST", base, { webhookUrl });
const secret = (created.json as { data?: { signingSecret?: string } })?.data?.signingSecret;
if (created.status !== 200 || !secret) {
  console.error(`register failed -> ${created.status}: ${JSON.stringify(created.json).slice(0, 300)}`);
  process.exit(1);
}
fs.writeFileSync(webhookFile, secret, { mode: 0o600 });
fs.chmodSync(webhookFile, 0o600);
console.log(`registered ${webhookUrl}; signing secret saved to ${webhookFile} (${secret.length} chars, not shown)`);
