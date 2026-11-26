#!/usr/bin/env bash
# The Sprite service entry point. The runtime restarts it on crash and on every cold boot.
set -euo pipefail
DATA="${PERIL_DATA_DIR:-$HOME/.peril}"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$(npm prefix -g 2>/dev/null)/bin:$PATH"
export PERIL_DATA_DIR="$DATA" PERIL_WORKSPACE="${PERIL_WORKSPACE:-$DATA/workspace}"
cd "$(dirname "$0")/../.."
# Bun parses peril.env as a dotenv file, so values with spaces (cron lines) need no quotes.
[ -f "$DATA/peril.env" ] && exec bun --env-file="$DATA/peril.env" packages/server/src/main.ts
exec bun packages/server/src/main.ts
