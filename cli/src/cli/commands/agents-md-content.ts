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
    "All memory access goes through MCP tools: `list_repositories`, `memory_suggest`, `memory_query`, `memory_get`, `memory_history`, `memory_list`, `memory_doctor`, `memory_stats`, `memory_gc`, `memory_verify`, `memory_diff`, `memory_size`, `memory_add`, `memory_update`, `memory_restore`, `memory_deprecate`, `memory_delete`, `memory_delete_many`.",
    "Repository scope: every tool that reads or writes a specific repo requires an exact `owner/name` slug. There is no default. Reads are loose — a wrong slug returns empty/not-found and nothing is lost. Writes are strict: confirm the slug with `list_repositories` before every write; derive it from `git remote get-url origin` when it matches a known entry. Deletion is permanent.",
    'Search policy: `memory_suggest` with `{ repository, files }` for file-scoped lookup; `memory_query` with `mode: "keyword"` for exact names, paths, commands, and identifiers, `mode: "semantic"` when the same concept may use different wording, `mode: "hybrid"` (default) for broad investigation. Filter with `tags` (substring) / `status` / `memory_type` / `certainty` and cap with `limit` (default 8, max 50). For `memory_list` and `list_repositories`, follow `offset` pages while `has_more` is true. D1 records are canonical and Vectorize is only a retrieval index.',
    "Mutations (`memory_add`, `memory_update`, `memory_restore`, `memory_deprecate`, `memory_delete`, `memory_delete_many`) require an explicit repository and echo `written_to` or `deleted_from`. `memory_add` also echoes `potential_conflicts`. Use `memory_history` before `memory_restore`; pass its revision_id and current_update_count so a newer write cannot be overwritten. Deletion is permanent; prefer `memory_deprecate` when audit history should remain. Embeddings re-sync to Vectorize automatically on add/update/restore/deprecate; history snapshots are not embedded.",
    "`memory_add` defaults to `memory_type: convention`, `certainty: inferred`, `status: active` — set them explicitly (`decision` / `reference` / `gotcha`; `verified` / `inferred`). `certainty: verified` requires a non-empty `evidence` array; `evidence` and `validation_gaps` are not embedded and do not count toward the size budget. `expires_after_days` is only valid for `status` memories. Prefer `memory_add` with `upsert_match` (strong matches update in place; weak matches refuse unless `force: true`) and `memory_update` with `match` over raw creates.",
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

function agentsMdRetrievalCaveat(preferred: string): string {
  return `Search results are ranked candidates, not an exhaustive or authoritative list. Scores only rank results within one response, so a high score does not prove a strong match. Use each result's \`match_strength\` (strong, weak, none) and \`exact_matches\` instead; when the response reports \`no_strong_match\`, nothing matched well. Prefer ${preferred} over broad queries, read full records before relying on them, and treat "nothing directly relevant" as a valid outcome instead of adopting the nearest hit.`;
}

function agentsMdDelegationSection(scan: string): string[] {
  return [
    "### Delegated work (parent and child agents)",
    "",
    `- The parent agent owns memory. It runs the scan once and passes relevant memory IDs and constraints to child agents; children skip the mandatory scan unless their scope differs, and then use focused ${scan} calls.`,
    "- Children do not write memory unless the parent explicitly delegates writes to exactly one child. Otherwise they return persistence candidates: the finding, its evidence (file paths, commands, versions, test output), the evidence kind, and related memory IDs.",
    "- The parent reconciles its own findings and every child candidate in the end-of-task checkpoint.",
  ];
}

function agentsMdCheckpointSection(
  add: string,
  update: string,
  deprecate: string,
): string[] {
  return [
    "### End-of-task checkpoint (before the final response)",
    "",
    "Collect every validated finding from the task, including child results and mechanisms discovered while investigating approaches that were later abandoned. A rejected remedy does not make the verified mechanism behind its failure disposable. Classify each finding:",
    "",
    `1. Already covered: cite the memory ID; change it with ${update} only when evidence, scope, or wording is wrong.`,
    `2. New durable knowledge: create a \`decision\`, \`constraint\`, \`preference\`, \`reference\`, or \`gotcha\` record with ${add}.`,
    `3. Superseded or conflicting: fix the affected records with ${update} or ${deprecate}, including records that depend on the old premise.`,
    "4. Transient delivery or verification status: add or update one expiring `status` record.",
    "5. Intentionally omitted: have a reason, such as obvious from code, routine test result, duplicate, or not reusable.",
    "",
    "Saved records keep their source and version evidence and their verification boundaries.",
  ];
}

const AGENTS_MD_CERTAINTY_STEP =
  "Set certainty from evidence, not from how accurately a record describes the code. Record the kinds of evidence behind each claim: `user_requirement` (an explicit user requirement or preference), `observed_implementation` (what the code currently does), `verified_mechanism` (a confirmed technical mechanism), `tested_behavior` (end-user behavior exercised in tests or real use). Observing that the code does X establishes only `observed_implementation`, not that X is intended or works on every platform. `verified` is rejected without at least one evidence kind. Record remaining limits (unconfirmed intent, untested platforms) as validation gaps, and keep sources and versions in refs or context.";

const AGENTS_MD_STATUS_STEP =
  "Durable mechanisms and decisions go in `decision`, `reference`, `gotcha`, `constraint`, or `preference` records. Implementation, delivery, and verification state goes in one `status` record that expires and is updated rather than duplicated. State exactly where work stands (local only, uncommitted, committed, pushed, deployed or active) and which verification remains; never describe local work as deployed. When a caveat leaves a durable record, keep it in a status record.";

const AGENTS_MD_RECONCILE_STEP =
  "Reconcile dependents. When a decision changes or is reversed, search for other active records that rely on the old premise and update or deprecate them. Consolidate overlapping records instead of adding a partially redundant one; isolate a version-specific limitation in its own record and reference the existing workaround rather than repeating it.";

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
    agentsMdRetrievalCaveat(
      "known IDs (`get`), file-scoped `suggest --files`, and `--tags` filters",
    ),
    "",
    `Recover accidental overwrites with \`machine-memory history <id> ${backendFlag}\`, then \`machine-memory restore <id> --revision <revision_id> --expected-update-count <current_update_count> ${backendFlag}\`. Use the current count from history, not the snapshot's count. Restore preserves the id and re-syncs only the current memory's vector; snapshots are not embedded. Delete is permanent and removes history.`,
    "",
    "### One-sweep workflow (use this every task)",
    "",
    "1. Scan relevant context fast. Run exactly one focused `suggest`, `query`, or `list` command before code changes; repeat only if the touched paths or scope materially changes.",
    `2. Verify uncertain context before acting. Use \`machine-memory verify <id> "<inferred fact>" ${backendFlag}\` or \`machine-memory diff <id> "<proposed updated wording>" ${backendFlag}\` when an inference may conflict with existing memory.`,
    `3. Maintain memory while implementing. Prefer \`machine-memory update --match "topic query" "new canonical content" ${backendFlag}\`; if no reliable match exists, use \`machine-memory add "..." --upsert-match "topic query" ${backendFlag}\`. Weak matches refuse to silently create: inspect with \`--dry-run\`, then pass \`--force\` if a new record is intended. An update replaces the whole content: read the current record first and carry over unrelated valid details such as source paths, versions, and caveats.`,
    `4. ${AGENTS_MD_RECONCILE_STEP} Use \`machine-memory deprecate <id> --superseded-by <id> ${backendFlag}\` when a record is replaced.`,
    "5. Write for retrieval. Put commands, API paths, file paths, keys, routes, thresholds, and exact feature keywords in the first sentence.",
    "6. Use path-driven tags. Prefer `--path` and `tag-map`; use scoped tags such as `area:cli,topic:backend,kind:decision` when no mapping exists.",
    "7. Capture third-party quirks. Always add a `--type gotcha` memory for surprising library or tool behavior, leading with the library name, version, behavior, and fix.",
    `8. ${AGENTS_MD_CERTAINTY_STEP} Use \`--certainty\`, \`--evidence <kinds>\` (comma-separated), \`--validation-gaps <text|json_array>\`, and \`--refs\` or \`--context\`. \`doctor\` lists legacy \`verified\` records without evidence as \`verified_without_evidence\`; review them instead of bulk-changing them.`,
    `9. Separate durable knowledge from delivery status. ${AGENTS_MD_STATUS_STEP} Set \`--expires-after-days\` on status records and review \`doctor\` suggestions semantically before applying deprecations or updates.`,
    "10. Run the end-of-task checkpoint below before the final response.",
    "",
    ...agentsMdDelegationSection("`suggest` or `query`"),
    "",
    ...agentsMdCheckpointSection(
      `\`machine-memory add ... ${backendFlag}\``,
      `\`machine-memory update ... ${backendFlag}\``,
      `\`machine-memory deprecate ... ${backendFlag}\``,
    ),
    "",
    "### Checklist (verify before proceeding)",
    "",
    `- [ ] I ran \`machine-memory suggest\`, \`query\`, or \`list\` with ${backendFlag} for the files or feature I will touch (or reused the parent agent's scan)`,
    "- [ ] I reviewed the returned memory IDs and fetched full records when relevant, without treating top results as exhaustive",
    "- [ ] I considered whether existing memories constrain the planned approach",
    "- [ ] I will run the end-of-task checkpoint, including child findings, before the final response",
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
  agentsMdRetrievalCaveat(
    "known IDs (`memory_get`), file-scoped `memory_suggest`, and `tags` filters",
  ),
  "",
  "### One-sweep workflow (use this every task)",
  "",
  "1. Scan relevant context fast. Run exactly one focused `memory_suggest`, `memory_query`, or `memory_list` before code changes; repeat only if the touched paths or scope materially changes.",
  "2. Verify uncertain context before acting. Use `memory_verify` with `{ repository, id, fact }` or `memory_diff` with `{ repository, id, content }` when an inference may conflict with existing memory.",
  "3. Maintain memory while implementing. Prefer `memory_update` with `match` (or the exact `id`; only changed fields are needed); if no reliable match exists, use `memory_add` with `upsert_match`. Weak upsert matches refuse to silently create: inspect with `memory_get`, then pass `force: true` if a new record is intended. Call `memory_size` first when content may be long. A new `content` replaces the whole content: read the current record first and carry over unrelated valid details such as source paths, versions, and caveats.",
  `4. ${AGENTS_MD_RECONCILE_STEP} Use \`memory_deprecate\` with \`superseded_by\` when a record is replaced.`,
  "5. Write for retrieval. Put commands, API paths, file paths, keys, routes, thresholds, and exact feature keywords in the first sentence of `content`.",
  "6. Use path-driven tags. There is no tag-map tool — tags are free-form comma-separated text, so use scoped tags such as `area:cli,topic:backend,kind:decision`. Filter them with the `tags` parameter on query/list/suggest.",
  '7. Capture third-party quirks. Always add a `memory_type: "gotcha"` memory for surprising library or tool behavior, leading with the library name, version, behavior, and fix.',
  `8. ${AGENTS_MD_CERTAINTY_STEP} Use the \`certainty\`, \`evidence\` (array of kinds), \`validation_gaps\` (array of strings), and \`context\` fields. \`memory_doctor\` lists legacy \`verified\` records without evidence as \`verified_without_evidence\`; review them instead of bulk-changing them.`,
  `9. Separate durable knowledge from delivery status. ${AGENTS_MD_STATUS_STEP} Set \`expires_after_days\` on status records. Use \`memory_doctor\` during maintenance and \`memory_gc\` to preview expired status memories. Prefer \`memory_deprecate\` over permanent deletion.`,
  "10. Run the end-of-task checkpoint below before the final response.",
  "",
  ...agentsMdDelegationSection("`memory_suggest` or `memory_query`"),
  "",
  ...agentsMdCheckpointSection(
    "`memory_add`",
    "`memory_update`",
    "`memory_deprecate`",
  ),
  "",
  "### Checklist (verify before proceeding)",
  "",
  "- [ ] I ran `memory_suggest`, `memory_query`, or `memory_list` (and `list_repositories` if the slug was uncertain) for the files or feature I will touch (or reused the parent agent's scan)",
  "- [ ] I reviewed the returned memory IDs and fetched full records with `memory_get` when relevant, without treating top results as exhaustive",
  "- [ ] I considered whether existing memories constrain the planned approach",
  "- [ ] I will run the end-of-task checkpoint, including child findings, before the final response",
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
