import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentsMdContent } from "../../cli/src/cli/commands/agents-md-content.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const payload = Buffer.from(agentsMdContent("mcp")).toString("base64");
const wrappedPayload = `${payload.match(/.{1,76}/g)?.join("\n") ?? ""}\n`;

function splicePayload(
  filePath: string,
  openMarker: string,
  closeMarker: string,
): void {
  const content = readFileSync(filePath, "utf8");
  const start = content.indexOf(openMarker);
  if (start < 0) {
    throw new Error(`MCP installer open marker not found in ${filePath}`);
  }
  const payloadStart = start + openMarker.length;
  const end = content.indexOf(closeMarker, payloadStart);
  if (end < 0) {
    throw new Error(`MCP installer close marker not found in ${filePath}`);
  }
  writeFileSync(
    filePath,
    content.slice(0, payloadStart) + wrappedPayload + content.slice(end),
    "utf8",
  );
}

splicePayload(
  resolve(root, "docs/public/init-mcp"),
  "MEMORY_BLOCK_B64=\"$(cat <<'MM_B64'\n",
  '\nMM_B64\n)"',
);
splicePayload(
  resolve(root, "docs/public/init-mcp.ps1"),
  "$memoryBlockB64 = @'\n",
  "\n'@",
);
