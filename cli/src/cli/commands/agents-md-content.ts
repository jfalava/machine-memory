const MEMORY_BLOCK_START = "<!-- machine-memory:start -->";
const MEMORY_BLOCK_END = "<!-- machine-memory:end -->";

export type AgentsMemoryBackend = "local" | "remote";

const AGENTS_MD_BACKEND_CONTENT = {
  local: [
    "This project uses `machine-memory` with a local SQLite database at `machine-memory.db`.",
    "Every database-backed command requires exactly one backend flag. For this one use `--local` for this repository.",
    "Run `machine-memory doctor` during maintenance, not every task. Ensure `machine-memory.db` is writable before memory writes.",
  ],
  remote: [
    "This project uses `machine-memory` with a shared remote Worker-backed database.",
    "Every database-backed command requires exactly one backend flag: use `--remote` for this repository.",
    "Run `machine-memory doctor` during maintenance, not every task. Do not create or rely on a local `machine-memory.db` for this repository.",
    'Search policy: use `machine-memory query "<term>" --remote` for exact names, paths, commands, and identifiers; use `--semantic --remote` when the same concept may use different wording; use `--hybrid --remote` for broad investigation or when recall matters more than exact matching.',
    "When unsure, start with `--hybrid`; add `--explain-score` when ranking needs inspection. D1 records are canonical and Vectorize is only a retrieval index.",
    "After adding or updating a memory, its Vectorize embedding is synchronized automatically. Run `machine-memory reindex --remote` only after provisioning, changing the embedding index or model, or repairing missing vectors.",
  ],
} satisfies Record<AgentsMemoryBackend, string[]>;

export function agentsMdContent(backend: AgentsMemoryBackend): string {
  const backendFlag = backend === "remote" ? "--remote" : "--local";
  return [
    MEMORY_BLOCK_START,
    "## Project memory",
    "",
    ...AGENTS_MD_BACKEND_CONTENT[backend],
    "Memory size: keep every memory below 512 tokens, including its content, tags, context, and metadata, so the embedding service can accept it.",
    "",
    "⚠️ MANDATORY: Complete the memory scan BEFORE any code changes. Skipping it causes rework, regressions, and duplicated decisions.",
    "",
    "### Required pre-workflow (DO NOT SKIP)",
    "",
    "Before touching code, complete this scan from the repository root. Every database command must include the backend flag shown below:",
    "",
    `- Known files: \`machine-memory suggest --files "path/a.ts,path/b.ts" ${backendFlag} --json-min\``,
    `- Known topic: \`machine-memory query "topic" ${backendFlag} --json-min\``,
    `- Broad audit: \`machine-memory list --tags "area:..." ${backendFlag} --json-min\``,
    "",
    `If results look relevant, fetch full records before editing: \`machine-memory get <id> ${backendFlag}\` or \`machine-memory get <id,id,...> ${backendFlag}\`.`,
    "",
    "### One-sweep workflow (use this every task)",
    "",
    "1. Scan relevant context fast. Run exactly one focused `suggest`, `query`, or `list` command before code changes; repeat only if the touched paths or scope materially changes.",
    `2. Verify uncertain context before acting. Use \`machine-memory verify <id> "<inferred fact>" ${backendFlag}\` or \`machine-memory diff <id> "<proposed updated wording>" ${backendFlag}\` when an inference may conflict with existing memory.`,
    `3. Maintain memory while implementing. Prefer \`machine-memory update --match "topic query" "new canonical content" ${backendFlag}\`; if no reliable match exists, use \`machine-memory add "..." --upsert-match "topic query" ${backendFlag}\`.`,
    `4. Write for retrieval. Put commands, API paths, file paths, keys, routes, thresholds, and exact feature keywords in the first sentence.`,
    "5. Use path-driven tags. Prefer `--path` and `tag-map`; use scoped tags such as `area:cli,topic:backend,kind:decision` when no mapping exists.",
    `6. Capture third-party quirks. Always add a \`--type gotcha\` memory for surprising library or tool behavior, leading with the library name, behavior, and fix.`,
    "7. Keep status hygiene. Status memories are for transient progress, should include `--expires-after-days`, and should be updated rather than duplicated. Review `doctor` suggestions semantically before applying deprecations or updates.",
    "8. Separate durable and transient facts. Use `decision`, `reference`, or `gotcha` for reusable knowledge; use `status` only for short-lived snapshots.",
    `9. At task end, persist every durable decision, constraint, preference, non-obvious gotcha, and verified status future sessions need. Use \`machine-memory add ... ${backendFlag}\` or update the canonical record with \`machine-memory update ... ${backendFlag}\`. Do not store obvious code facts, routine test results, temporary progress, or duplicates.`,
    "",
    "### Checklist (verify before proceeding)",
    "",
    `- [ ] I ran \`machine-memory suggest\`, \`query\`, or \`list\` with ${backendFlag} for the files or feature I will touch`,
    "- [ ] I reviewed the returned memory IDs and fetched full records when relevant",
    "- [ ] I considered whether existing memories constrain the planned approach",
    "- [ ] I will document significant findings and decisions after completing the task",
    "",
    "Project preference: replace obsolete systems when practical; preserve backwards compatibility only when it is explicitly required.",
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
