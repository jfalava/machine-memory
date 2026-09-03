#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export NODE_PATH="${ROOT}/node_modules/.bun/satteri@0.9.5/node_modules:${ROOT}/node_modules/.bun/@bruits+satteri-darwin-arm64@0.9.5/node_modules${NODE_PATH:+:$NODE_PATH}"
cd "$(dirname "$0")/.."
exec bun run build
