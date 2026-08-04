const MEMORY_BLOCK_START = "<!-- machine-memory:start -->";
const MEMORY_BLOCK_END = "<!-- machine-memory:end -->";

export type AgentsMemoryBackend = "local" | "remote";

const AGENTS_MD_BACKEND_CONTENT: Record<AgentsMemoryBackend, string[]> = {
  local: [
    "This project uses `machine-memory` with a local SQLite database at `machine-memory.db`.",
    "On first setup, `machine-memory update-agents-md` can initialize local memory, connect an existing remote Worker, or provision the Alchemy D1 stack. Remote provisioning accepts `--stack-name`, `--database-name`, and `--api-name` through `machine-memory remote provision`.",
    "Every database-backed command requires exactly one backend flag. Use `--local` for this repository and do not pass both flags.",
    "Run `machine-memory doctor` during maintenance, not every task. Ensure `machine-memory.db` is writable before memory writes.",
  ],
  remote: [
    "This project uses `machine-memory` with a shared remote Worker-backed database.",
    "Remote credentials are stored in the OS keychain. To change them, use `machine-memory remote setup`; to provision a new Alchemy D1 stack, use `machine-memory remote provision` with optional `--stack-name`, `--database-name`, and `--api-name`.",
    "Every database-backed command requires exactly one backend flag. Use `--remote` for this repository and do not pass both flags.",
    "Run `machine-memory doctor` during maintenance, not every task. Do not create or rely on a local `machine-memory.db` for this repository.",
  ],
};

export function agentsMdContent(backend: AgentsMemoryBackend): string {
  const backendFlag = backend === "remote" ? "--remote" : "--local";
  return [
    MEMORY_BLOCK_START,
    "## Project memory",
    "",
    ...AGENTS_MD_BACKEND_CONTENT[backend],
    "",
    "Before editing, run exactly one focused retrieval command from the repository root:",
    "",
    `- Known files: \`machine-memory suggest --files "path/a.ts,path/b.ts" ${backendFlag} --json-min\``,
    `- Known topic: \`machine-memory query "topic" ${backendFlag} --json-min\``,
    `- Broad audit: \`machine-memory list --tags "area:..." ${backendFlag} --json-min\``,
    "",
    `Fetch full records only when the result looks relevant: \`machine-memory get <id> ${backendFlag}\` or \`machine-memory get <id,id,...> ${backendFlag}\`.`,
    "",
    `At task end, persist only durable decisions, constraints, preferences, and non-obvious gotchas. Update an existing canonical record when possible; do not store obvious code facts, routine test results, or temporary progress. Use status memories only for short-lived work and give them an expiry. Persist with \`machine-memory add ... ${backendFlag}\` or update the canonical record with \`machine-memory update ... ${backendFlag}\`.`,
    "",
    "Use exact file paths and put filenames, keys, routes, thresholds, and other retrieval anchors in the first sentence. Prefer path-based tags with `--path` and `tag-map`; use `--upsert-match` only after checking that the match is the intended canonical record.",
    MEMORY_BLOCK_END,
  ].join("\n");
}

export function replaceMemoryBlock(
  content: string,
  backend: AgentsMemoryBackend,
): string {
  const managedContent = agentsMdContent(backend);
  const blockPattern = new RegExp(
    `${MEMORY_BLOCK_START}[\\s\\S]*?${MEMORY_BLOCK_END}`,
    "g",
  );
  if (blockPattern.test(content)) {
    return content.replace(blockPattern, managedContent);
  }
  const legacyStart = content.indexOf("# Project memory");
  if (legacyStart === 0) {
    const prefix = content.slice(0, legacyStart).trimEnd();
    return (prefix ? prefix.concat("\n\n") : "").concat(managedContent, "\n");
  }
  return `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${managedContent}\n`;
}
