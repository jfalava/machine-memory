#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export NODE_PATH="${ROOT}/node_modules/.bun/satteri@0.9.5/node_modules:${ROOT}/node_modules/.bun/@bruits+satteri-darwin-arm64@0.9.5/node_modules${NODE_PATH:+:$NODE_PATH}"

# ---------------------------------------------------------------------------
# Sync base64 MCP block in public installer scripts
#
# The canonical content lives in cli/src/cli/commands/agents-md-content.ts.
# Both docs/public/init-mcp (bash) and docs/public/init-mcp.ps1 (PowerShell)
# embed a base64 snapshot that must stay in sync with agentsMdContent("mcp").
# This step regenerates and splices the payload before every Cloudflare build.
# bun is the only tool required — it already drives the rest of the build.
# ---------------------------------------------------------------------------

echo "build-cf: regenerating base64 MCP block from agents-md-content.ts …"

bun -e "
import { readFileSync, writeFileSync } from 'fs';
import { agentsMdContent } from '${ROOT}/cli/src/cli/commands/agents-md-content.ts';

const b64Raw = Buffer.from(agentsMdContent('mcp')).toString('base64');
// Wrap at 76 chars to match standard base64 line-wrapping.
const lines: string[] = [];
for (let i = 0; i < b64Raw.length; i += 76) lines.push(b64Raw.slice(i, i + 76));
const newB64 = lines.join('\n') + '\n';

function splice(
  filePath: string,
  openMarker: string,
  closeMarker: string,
): void {
  const text = readFileSync(filePath, 'utf8');
  const s = text.indexOf(openMarker);
  if (s < 0) throw new Error(\`build-cf: open marker not found in \${filePath}\`);
  const payloadStart = s + openMarker.length;
  const e = text.indexOf(closeMarker, payloadStart);
  if (e < 0) throw new Error(\`build-cf: close marker not found in \${filePath}\`);
  writeFileSync(filePath, text.slice(0, payloadStart) + newB64 + text.slice(e), 'utf8');
  console.log(\`build-cf: updated \${filePath}\`);
}

// docs/public/init-mcp  — bash heredoc between MM_B64 markers
splice(
  '${ROOT}/docs/public/init-mcp',
  \"MEMORY_BLOCK_B64=\\\"\$(cat <<'MM_B64'\n\",
  \"\nMM_B64\n)\\\"\",
);

// docs/public/init-mcp.ps1 — PowerShell here-string between @' and '@
splice(
  '${ROOT}/docs/public/init-mcp.ps1',
  \"\\\$memoryBlockB64 = @'\n\",
  \"\n'@\",
);
"

echo "build-cf: base64 sync complete."

# ---------------------------------------------------------------------------
# Run the Astro / Cloudflare build
# ---------------------------------------------------------------------------
cd "$(dirname "$0")/.."
exec bun run build
