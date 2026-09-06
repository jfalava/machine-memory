const MEMORY_BLOCK_START = "<!-- machine-memory:start -->";
const MEMORY_BLOCK_END = "<!-- machine-memory:end -->";

export type AgentsMemoryBackend = "local" | "remote" | "mcp";

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
  mcp: [
    "This project uses `machine-memory` through the remote MCP server (OAuth to the Worker `/mcp` endpoint). No local CLI or `machine-memory.db` is required.",
    "All memory access goes through MCP tools: `list_repositories`, `memory_suggest`, `memory_query`, `memory_get`, `memory_list`, `memory_doctor`, `memory_stats`, `memory_gc`, `memory_verify`, `memory_diff`, `memory_size`, `memory_add`, `memory_update`, `memory_deprecate`, `memory_delete`, `memory_delete_many`.",
    "Repository scope: every tool that reads or writes a specific repo requires an exact `owner/name` slug. There is no default. Reads are loose — a wrong slug returns empty/not-found and nothing is lost. Writes are strict: confirm the slug with `list_repositories` before every write; derive it from `git remote get-url origin` when it matches a known entry. Deletion is permanent.",
    'Search policy: `memory_suggest` with `{ repository, files }` for file-scoped lookup; `memory_query` with `mode: "keyword"` for exact names, paths, commands, and identifiers, `mode: "semantic"` when the same concept may use different wording, `mode: "hybrid"` (default) for broad investigation. Filter with `tags` (substring) / `status` / `memory_type` / `certainty` and cap with `limit` (default 8, max 50). For `memory_list` and `list_repositories`, follow `offset` pages while `has_more` is true. D1 records are canonical and Vectorize is only a retrieval index.',
    "Mutations (`memory_add`, `memory_update`, `memory_deprecate`, `memory_delete`, `memory_delete_many`) require an explicit repository and echo `written_to` or `deleted_from`. `memory_add` also echoes `potential_conflicts`. Deletion is permanent; prefer `memory_deprecate` when audit history should remain. Embeddings re-sync to Vectorize automatically on add/update/deprecate.",
    "`memory_add` defaults to `memory_type: convention`, `certainty: inferred`, `status: active` — set them explicitly (`decision` / `reference` / `gotcha`; `verified` / `inferred`). `expires_after_days` is only valid for `status` memories. Prefer `memory_add` with `upsert_match` (strong matches update in place; weak matches refuse unless `force: true`) and `memory_update` with `match` over raw creates.",
  ],
} satisfies Record<AgentsMemoryBackend, string[]>;

function agentsMdSizeGuidance(backend: AgentsMemoryBackend): string {
  if (backend === "mcp") {
    return [
      "Memory size: the composed embedding text must stay within the Worker's conservative byte+2 budget (UTF-8 bytes + 2 ≤ 512).",
      "Preflight without writing: call `memory_size` with the prospective content/tags/context/type. It takes no repository and uses the same defaults as `memory_add`, so pass the type/certainty/status you intend to write.",
      "`memory_add` and `memory_update` reject on flight when over budget; oversize `memory_size` results set `isError` and include `over_by_bytes`.",
    ].join(" ");
  }
  return [
    "Memory size: the composed embedding text must stay below 512 BGE tokens AND within the embedding service's conservative byte+2 estimate (512 bytes).",
    'Preflight without writing: `machine-memory size "<text>"` or add/update `--dry-run` (both exit 1 when over budget); failures name the exact byte or token deficit.',
    "`--token-report` appends the per-part breakdown to real writes.",
  ].join(" ");
}

function agentsMdCliWorkflow(backendFlag: "--local" | "--remote"): string[] {
  return [
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
    `3. Maintain memory while implementing. Prefer \`machine-memory update --match "topic query" "new canonical content" ${backendFlag}\`; if no reliable match exists, use \`machine-memory add "..." --upsert-match "topic query" ${backendFlag}\`. Weak matches refuse to silently create: inspect with \`--dry-run\`, then pass \`--force\` if a new record is intended.`,
    "4. Write for retrieval. Put commands, API paths, file paths, keys, routes, thresholds, and exact feature keywords in the first sentence.",
    "5. Use path-driven tags. Prefer `--path` and `tag-map`; use scoped tags such as `area:cli,topic:backend,kind:decision` when no mapping exists.",
    "6. Capture third-party quirks. Always add a `--type gotcha` memory for surprising library or tool behavior, leading with the library name, behavior, and fix.",
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
  ];
}

const AGENTS_MD_MCP_WORKFLOW = [
  "Before touching code, complete this scan via MCP tools:",
  "",
  '- Known files: `memory_suggest` with `{ repository, files: "path/a.ts,path/b.ts" }`',
  '- Known topic: `memory_query` with `{ repository, query: "topic", mode: "hybrid" }`',
  "- Broad audit: `memory_list` with `{ repository }` (filter by `tags` / `memory_type` / `status` / `certainty`, following `offset` while `has_more` is true) or `memory_query` with tag-oriented keywords",
  "- Discover slug: `list_repositories` when the `owner/name` is not certain",
  "",
  "If results look relevant, fetch full records before editing: `memory_get` with `{ repository, id }` (one id per call).",
  "",
  "### One-sweep workflow (use this every task)",
  "",
  "1. Scan relevant context fast. Run exactly one focused `memory_suggest`, `memory_query`, or `memory_list` before code changes; repeat only if the touched paths or scope materially changes.",
  "2. Verify uncertain context before acting. Use `memory_verify` with `{ repository, id, fact }` or `memory_diff` with `{ repository, id, content }` when an inference may conflict with existing memory.",
  "3. Maintain memory while implementing. Prefer `memory_update` with `match` (or the exact `id`; only changed fields are needed); if no reliable match exists, use `memory_add` with `upsert_match`. Weak upsert matches refuse to silently create: inspect with `memory_get`, then pass `force: true` if a new record is intended. Call `memory_size` first when content may be long.",
  "4. Write for retrieval. Put commands, API paths, file paths, keys, routes, thresholds, and exact feature keywords in the first sentence of `content`.",
  "5. Use path-driven tags. There is no tag-map tool — tags are free-form comma-separated text, so use scoped tags such as `area:cli,topic:backend,kind:decision`. Filter them with the `tags` parameter on query/list/suggest.",
  '6. Capture third-party quirks. Always add a `memory_type: "gotcha"` memory for surprising library or tool behavior, leading with the library name, behavior, and fix.',
  "7. Keep status hygiene. Use `memory_doctor` during maintenance and `memory_gc` to preview expired status memories. Status memories should set `expires_after_days` and be updated rather than duplicated. Prefer `memory_deprecate` (with `superseded_by` when replaced) over permanent deletion.",
  "8. Separate durable and transient facts. Use `decision`, `reference`, or `gotcha` for reusable knowledge; use `status` only for short-lived snapshots.",
  "9. At task end, persist every durable decision, constraint, preference, non-obvious gotcha, and verified status future sessions need via `memory_add` / `memory_update`. Do not store obvious code facts, routine test results, temporary progress, or duplicates.",
  "",
  "### Checklist (verify before proceeding)",
  "",
  "- [ ] I ran `memory_suggest`, `memory_query`, or `memory_list` (and `list_repositories` if the slug was uncertain) for the files or feature I will touch",
  "- [ ] I reviewed the returned memory IDs and fetched full records with `memory_get` when relevant",
  "- [ ] I considered whether existing memories constrain the planned approach",
  "- [ ] I will document significant findings and decisions after completing the task",
];

export function agentsMdContent(backend: AgentsMemoryBackend): string {
  const workflow =
    backend === "mcp"
      ? AGENTS_MD_MCP_WORKFLOW
      : agentsMdCliWorkflow(backend === "remote" ? "--remote" : "--local");
  return [
    MEMORY_BLOCK_START,
    "## Project memory",
    "",
    ...AGENTS_MD_BACKEND_CONTENT[backend],
    agentsMdSizeGuidance(backend),
    "",
    "⚠️ MANDATORY: Complete the memory scan BEFORE any code changes. Skipping it causes rework, regressions, and duplicated decisions.",
    "",
    "### Required pre-workflow (DO NOT SKIP)",
    "",
    ...workflow,
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

/** Marker pair used by the public init-mcp script and CLI init --mcp. */
export const AGENTS_MD_MARKERS = {
  start: MEMORY_BLOCK_START,
  end: MEMORY_BLOCK_END,
} as const;
