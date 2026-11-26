#!/usr/bin/env bash
# The Sprite service entry point. The runtime restarts it on crash and on every cold boot.
set -euo pipefail
DATA="${PERIL_DATA_DIR:-$HOME/.peril}"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$(npm prefix -g 2>/dev/null)/bin:$PATH"
export PERIL_DATA_DIR="$DATA" PERIL_WORKSPACE="${PERIL_WORKSPACE:-$DATA/workspace}"
set -a
# shellcheck disable=SC1091
[ -f "$DATA/peril.env" ] && . "$DATA/peril.env"
set +a
cd "$(dirname "$0")/../.."
exec bun packages/server/src/main.ts
