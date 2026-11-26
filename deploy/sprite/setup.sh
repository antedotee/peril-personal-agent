#!/usr/bin/env bash
# Set up Peril inside a Sprite. Safe to run again: every step checks before it acts.
#   sprite exec -s peril -- bash -lc '~/peril-personal-agent/deploy/sprite/setup.sh'
set -euo pipefail

REPO="${PERIL_REPO:-$HOME/peril-personal-agent}"
DATA="${PERIL_DATA_DIR:-$HOME/.peril}"
WORKSPACE="$DATA/workspace"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

step() { printf '\n== %s\n' "$1"; }

step "bun"
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
bun --version

step "kiro-cli"
command -v kiro-cli >/dev/null || curl -fsSL https://cli.kiro.dev/install | bash
kiro-cli --version || true
kiro-cli settings acp.agentEngine v3 >/dev/null 2>&1 || true

step "agent-browser"
# npm 12 blocks install scripts by default; agent-browser's postinstall fetches its native binary.
export PATH="$(npm prefix -g)/bin:$PATH"
if ! agent-browser --version >/dev/null 2>&1; then
  npm install -g --allow-scripts=agent-browser agent-browser || npm install -g agent-browser
fi
if agent-browser --version >/dev/null 2>&1; then
  agent-browser install --with-deps >/dev/null 2>&1 || agent-browser install || echo "WARN: Chrome install failed; browser errands are off until it works"
  agent-browser --version
else
  echo "WARN: agent-browser is not installed; browser errands are off. Everything else still works."
fi

step "dependencies"
cd "$REPO"
bun install --frozen-lockfile

step "state and Kiro workspace"
mkdir -p "$DATA/secrets" "$DATA/inbox" "$WORKSPACE/.kiro/steering" "$WORKSPACE/.kiro/skills" "$WORKSPACE/.kiro/settings" "$WORKSPACE/watchers"
chmod 700 "$DATA/secrets"
cp "$REPO"/steering/*.md "$WORKSPACE/.kiro/steering/"
rm -rf "$WORKSPACE/.kiro/skills" && cp -R "$REPO/skills" "$WORKSPACE/.kiro/skills"
# Peril's MCP server reaches Kiro per session. The browser goes through Peril's guarded browser_* tools, never a direct MCP server.
rm -f "$WORKSPACE/.kiro/settings/mcp.json"
if [ ! -s "$DATA/secrets/tick-key" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' >"$DATA/secrets/tick-key"
  chmod 600 "$DATA/secrets/tick-key"
fi

step "environment"
ENV_FILE="$DATA/peril.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO/deploy/sprite/peril.env.example" "$ENV_FILE"
  echo "Wrote $ENV_FILE. Fill in the non-secret values, then rerun this script."
fi

step "service"
if sprite-env services list 2>/dev/null | grep -q '"peril"'; then
  sprite-env services restart peril >/dev/null 2>&1 || { sprite-env services stop peril || true; sprite-env services start peril; }
else
  sprite-env services create peril --cmd bash --args "$REPO/deploy/sprite/run.sh" --dir "$REPO" --http-port 8080
fi

step "doctor"
PERIL_DATA_DIR="$DATA" PERIL_WORKSPACE="$WORKSPACE" bun --env-file="$ENV_FILE" packages/server/src/doctor.ts || true
