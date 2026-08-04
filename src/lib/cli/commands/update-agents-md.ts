import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const MEMORY_BLOCK_START = "<!-- machine-memory:start -->";
const MEMORY_BLOCK_END = "<!-- machine-memory:end -->";

const AGENTS_MD_CONTENT = [
  MEMORY_BLOCK_START,
  "## Project memory",
  "",
  "This project uses `machine-memory` with its database at `.agents/memory.db`.",
  "",
  "Before editing, run exactly one focused retrieval command from the repository root:",
  "",
  '- Known files: `machine-memory suggest --files "path/a.ts,path/b.ts" --json-min`',
  '- Known topic: `machine-memory query "topic" --json-min`',
  '- Broad audit: `machine-memory list --tags "area:..." --json-min`',
  "",
  "Fetch full records only when the result looks relevant: `machine-memory get <id>` or `machine-memory get <id,id,...>`.",
  "",
  "At task end, persist only durable decisions, constraints, preferences, and non-obvious gotchas. Update an existing canonical record when possible; do not store obvious code facts, routine test results, or temporary progress. Use status memories only for short-lived work and give them an expiry.",
  "",
  "Use exact file paths and put filenames, keys, routes, thresholds, and other retrieval anchors in the first sentence. Prefer path-based tags with `--path` and `tag-map`; use `--upsert-match` only after checking that the match is the intended canonical record.",
  "",
  "Run `machine-memory doctor` during maintenance, not every task. Ensure both `.agents/` and `.agents/memory.db` are writable before memory writes.",
  MEMORY_BLOCK_END,
].join("\n");

function replaceMemoryBlock(content: string): string {
  const blockPattern = new RegExp(
    `${MEMORY_BLOCK_START}[\\s\\S]*?${MEMORY_BLOCK_END}`,
    "g",
  );
  if (blockPattern.test(content)) {
    return content.replace(blockPattern, AGENTS_MD_CONTENT);
  }
  const legacyStart = content.indexOf("# Project memory");
  if (legacyStart === 0) {
    const prefix = content.slice(0, legacyStart).trimEnd();
    return `${prefix ? `${prefix}\n\n` : ""}${AGENTS_MD_CONTENT}\n`;
  }
  return `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${AGENTS_MD_CONTENT}\n`;
}

export async function handleUpdateAgentsMdCommand() {
  const agentsMdPath = resolve(process.cwd(), "AGENTS.md");
  const existingContent = existsSync(agentsMdPath)
    ? await readFile(agentsMdPath, "utf-8")
    : "";
  await writeFile(agentsMdPath, replaceMemoryBlock(existingContent), "utf-8");
  console.info(
    "Updated AGENTS.md with recommendations on machine-memory usage",
  );
}
