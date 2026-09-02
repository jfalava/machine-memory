import {
  McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { embeddingSizeReport, validateEmbeddingText } from "./embedding";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5" as const;
const EMBEDDING_DIMENSIONS = 768;
const MAX_NAMESPACE_BYTES = 64;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 8;

const MEMORY_TYPES = [
  "decision",
  "convention",
  "gotcha",
  "preference",
  "constraint",
  "reference",
  "status",
] as const;

const CERTAINTY_LEVELS = ["verified", "inferred", "speculative"] as const;

const MEMORY_STATUSES = ["active", "deprecated", "superseded_by"] as const;

/** Raw Cloudflare bindings the MCP tools operate on. */
export type McpBindings = {
  readonly DB: D1Database;
  readonly VECTORIZE: Vectorize;
  readonly AI: Ai;
};

type MemoryRow = {
  readonly id: number;
  readonly repository: string;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: string;
  readonly status: string;
  readonly certainty: string;
};

type TextToolResult = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
};

type ErrorToolResult = TextToolResult & { readonly isError: true };

const ROW_SELECT =
  "id, repository, content, tags, context, memory_type, status, certainty";

function embeddingText(input: {
  content: string;
  tags: string;
  context: string;
  memory_type: string;
  status: string;
  certainty: string;
}): string {
  return [
    input.content,
    input.tags ? `Tags: ${input.tags}` : undefined,
    input.context ? `Context: ${input.context}` : undefined,
    `Memory type: ${input.memory_type}`,
    `Status: ${input.status}`,
    `Certainty: ${input.certainty}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

function assertMemoryEmbeddingBudget(input: {
  content: string;
  tags: string;
  context: string;
  memory_type: string;
  status: string;
  certainty: string;
}): ReturnType<typeof embeddingSizeReport> {
  const text = validateEmbeddingText(embeddingText(input), "Document text");
  return embeddingSizeReport(text);
}

function measureMemoryEmbeddingBudget(input: {
  content: string;
  tags: string;
  context: string;
  memory_type: string;
  status: string;
  certainty: string;
}): ReturnType<typeof embeddingSizeReport> {
  return embeddingSizeReport(embeddingText(input));
}

function validateNamespace(repository: string): void {
  if (new TextEncoder().encode(repository).byteLength > MAX_NAMESPACE_BYTES) {
    throw new Error(
      `repository must be at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes.`,
    );
  }
}

const EmbeddingOutputSchema = Schema.Struct({
  data: Schema.Array(Schema.Array(Schema.Number)),
});

async function embedText(ai: Ai, text: string): Promise<number[]> {
  const output = await ai.run(EMBEDDING_MODEL, { text: [text] });
  const parsed = Schema.decodeUnknownSync(EmbeddingOutputSchema)(output);
  const embedding = parsed.data[0];
  if (embedding === undefined || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Workers AI returned an embedding with an invalid dimension; expected ${EMBEDDING_DIMENSIONS}.`,
    );
  }
  return [...embedding];
}

async function rowById(
  db: D1Database,
  repository: string,
  id: number,
): Promise<MemoryRow | undefined> {
  const result = await db
    .prepare(
      `SELECT ${ROW_SELECT} FROM memories WHERE repository = ? AND id = ?`,
    )
    .bind(repository, id)
    .first<MemoryRow>();
  return result ?? undefined;
}

type InsertInput = {
  repository: string;
  content: string;
  tags: string;
  context: string;
  memory_type: string;
  status: string;
  certainty: string;
  source_agent: string;
  refs: string;
  expires_after_days: number | null;
};

async function insertMemory(
  db: D1Database,
  input: InsertInput,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO memories (
        repository, content, tags, context, memory_type, status,
        superseded_by, source_agent, last_updated_by, update_count,
        certainty, refs, expires_after_days, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      input.repository,
      input.content,
      input.tags,
      input.context,
      input.memory_type,
      input.status,
      input.source_agent,
      input.source_agent,
      input.certainty,
      input.refs,
      input.expires_after_days,
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function upsertVector(
  bindings: McpBindings,
  row: MemoryRow,
): Promise<void> {
  const values = await embedText(bindings.AI, embeddingText(row));
  await bindings.VECTORIZE.upsert([
    {
      id: String(row.id),
      namespace: row.repository,
      values,
      metadata: {
        status: row.status,
        memory_type: row.memory_type,
        certainty: row.certainty,
      },
    },
  ]);
}

const STOPWORDS = new Set([
  "the",
  "and",
  "with",
  "from",
  "that",
  "this",
  "into",
  "your",
  "have",
  "for",
  "are",
  "use",
  "uses",
  "using",
]);

function extractTerms(input: string): string[] {
  const tokens = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 2 && !STOPWORDS.has(token),
  );
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }
  return unique;
}

function buildFtsQuery(terms: string[]): string | undefined {
  const usable = terms.filter((term) => term.length > 0).slice(0, 12);
  if (usable.length === 0) {
    return undefined;
  }
  return usable.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

type SearchInput = {
  repository: string;
  query: string;
  limit: number;
  status?: string;
  memory_type?: string;
  certainty?: string;
};

async function keywordSearch(
  db: D1Database,
  input: SearchInput,
): Promise<MemoryRow[]> {
  const ftsQuery = buildFtsQuery(extractTerms(input.query));
  if (ftsQuery === undefined) {
    return [];
  }
  const clauses = ["repository = ?", "memories_fts MATCH ?"];
  const params: (string | number)[] = [input.repository, ftsQuery];
  if (input.status !== undefined) {
    clauses.push("status = ?");
    params.push(input.status);
  }
  if (input.memory_type !== undefined) {
    clauses.push("memory_type = ?");
    params.push(input.memory_type);
  }
  if (input.certainty !== undefined) {
    clauses.push("certainty = ?");
    params.push(input.certainty);
  }
  const result = await db
    .prepare(
      `SELECT m.${ROW_SELECT.split(", ").join(", m.")}
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY bm25(memories_fts)
       LIMIT ?`,
    )
    .bind(...params, input.limit)
    .all<MemoryRow>();
  return result.results ?? [];
}

function vectorizeFilter(input: SearchInput): VectorizeVectorMetadataFilter {
  const filter: VectorizeVectorMetadataFilter = {};
  if (input.status !== undefined) {
    filter.status = input.status;
  }
  if (input.memory_type !== undefined) {
    filter.memory_type = input.memory_type;
  }
  if (input.certainty !== undefined) {
    filter.certainty = input.certainty;
  }
  return filter;
}

async function semanticSearch(
  bindings: McpBindings,
  input: SearchInput,
): Promise<Array<MemoryRow & { score: number }>> {
  const values = await embedText(bindings.AI, input.query);
  const filter = vectorizeFilter(input);
  const queryOptions: VectorizeQueryOptions = {
    namespace: input.repository,
    topK: input.limit,
    returnMetadata: "all",
  };
  if (Object.keys(filter).length > 0) {
    queryOptions.filter = filter;
  }
  const matches = await bindings.VECTORIZE.query(values, queryOptions);
  const scored: Array<MemoryRow & { score: number }> = [];
  for (const match of matches.matches ?? []) {
    const id = Number(match.id);
    if (!Number.isInteger(id)) {
      continue;
    }
    const row = await rowById(bindings.DB, input.repository, id);
    if (!row) {
      continue;
    }
    scored.push({ ...row, score: match.score });
  }
  return scored;
}

function textResult(rows: unknown[]): TextToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
  };
}

function textMessage(message: string): TextToolResult {
  return {
    content: [{ type: "text", text: message }],
  };
}

function errorResult(cause: unknown): ErrorToolResult {
  return {
    content: [
      {
        type: "text",
        text: cause instanceof Error ? cause.message : "Internal server error.",
      },
    ],
    isError: true,
  };
}

/**
 * Bridge Effect Schema tool inputs into MCP's StandardSchemaWithJSON contract.
 * Effect exposes validate and JSON Schema via separate converters; MCP needs both
 * on the same `~standard` object.
 */
function mcpInputSchema<A>(
  schema: Schema.Top & { readonly Type: A },
): StandardSchemaWithJSON<A, A> {
  const standard = Schema.toStandardSchemaV1(
    // SAFETY: tool input structs are pure sync decoders with no services.
    schema as Schema.Top & { readonly DecodingServices: never },
  );
  // SAFETY: tool input structs are pure data schemas that satisfy Constraint for JSON Schema export.
  const json = Schema.toStandardJSONSchemaV1(
    schema as Schema.Top & Schema.Constraint,
  );
  // SAFETY: MCP needs validate + jsonSchema on one ~standard object; both halves come from the same schema.
  return {
    "~standard": {
      version: 1,
      vendor: "effect",
      validate: standard["~standard"].validate,
      jsonSchema: json["~standard"].jsonSchema,
    },
  } as StandardSchemaWithJSON<A, A>;
}

function describedString(description: string) {
  return Schema.NonEmptyString.annotate({ description });
}

function optionalString(description: string) {
  return Schema.optionalKey(Schema.String.annotate({ description }));
}

function optionalEnum<const L extends ReadonlyArray<string>>(
  literals: L,
  description: string,
) {
  return Schema.optionalKey(
    Schema.Literals(literals).annotate({ description }),
  );
}

function positiveInt(description: string) {
  return Schema.Int.check(Schema.isGreaterThan(0)).annotate({ description });
}

function searchLimitField(description: string) {
  return Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT }),
    ).annotate({ description }),
  );
}

const repositoryField = describedString(
  "The GitHub repository (owner/name) whose memories to operate on.",
);

const repositoryWriteField = describedString(
  "The GitHub repository (owner/name) to write this memory to. Required — no default. Call list_repositories to enumerate valid slugs before writing.",
);

const repositoryOwnedField = describedString(
  "The GitHub repository (owner/name) the memory belongs to. Required — no default. Call list_repositories to enumerate valid slugs before writing.",
);

const filterFields = {
  status: optionalEnum(MEMORY_STATUSES, "Filter by memory status."),
  memory_type: optionalEnum(MEMORY_TYPES, "Filter by memory type."),
  certainty: optionalEnum(CERTAINTY_LEVELS, "Filter by certainty level."),
};

const ListRepositoriesArgs = Schema.Struct({
  limit: searchLimitField("Maximum number of repository slugs to return."),
});
type ListRepositoriesArgs = Schema.Schema.Type<typeof ListRepositoriesArgs>;
const listRepositoriesInput = mcpInputSchema(ListRepositoriesArgs);

const MemoryQueryArgs = Schema.Struct({
  repository: repositoryField,
  query: describedString("The search query, e.g. 'deploy command'."),
  limit: searchLimitField("Maximum number of results to return."),
  mode: Schema.optionalKey(
    Schema.Literals(["keyword", "semantic", "hybrid"] as const).annotate({
      description: "Search mode; hybrid merges keyword and semantic results.",
    }),
  ),
  ...filterFields,
});
type MemoryQueryArgs = Schema.Schema.Type<typeof MemoryQueryArgs>;
const memoryQueryInput = mcpInputSchema(MemoryQueryArgs);

const MemoryGetArgs = Schema.Struct({
  repository: repositoryField,
  id: positiveInt("The numeric memory id to fetch."),
});
type MemoryGetArgs = Schema.Schema.Type<typeof MemoryGetArgs>;
const memoryGetInput = mcpInputSchema(MemoryGetArgs);

const MemoryListArgs = Schema.Struct({
  repository: repositoryField,
  limit: searchLimitField("Maximum number of results to return."),
  ...filterFields,
});
type MemoryListArgs = Schema.Schema.Type<typeof MemoryListArgs>;
const memoryListInput = mcpInputSchema(MemoryListArgs);

const MemoryAddArgs = Schema.Struct({
  repository: repositoryWriteField,
  content: describedString(
    "The canonical memory content. Put commands, paths, keys, and exact identifiers in the first sentence for retrieval.",
  ),
  tags: optionalString("Comma-separated tags, e.g. 'area:cli,topic:backend'."),
  context: optionalString("Supporting context for the memory."),
  memory_type: Schema.optionalKey(
    Schema.Literals(MEMORY_TYPES).annotate({ description: "Type of memory." }),
  ),
  certainty: Schema.optionalKey(
    Schema.Literals(CERTAINTY_LEVELS).annotate({
      description: "Certainty level.",
    }),
  ),
  status: Schema.optionalKey(
    Schema.Literals(MEMORY_STATUSES).annotate({
      description: "Memory status.",
    }),
  ),
  expires_after_days: Schema.optionalKey(
    positiveInt("Expire this status memory after N days."),
  ),
});
type MemoryAddArgs = Schema.Schema.Type<typeof MemoryAddArgs>;
const memoryAddInput = mcpInputSchema(MemoryAddArgs);

async function addMemory(
  bindings: McpBindings,
  args: MemoryAddArgs,
): Promise<{
  written_to: string;
  id: number;
  memory: MemoryRow;
  size: ReturnType<typeof embeddingSizeReport>;
}> {
  validateNamespace(args.repository);
  const memory_type = args.memory_type ?? "convention";
  const certainty = args.certainty ?? "inferred";
  const status = args.status ?? "active";
  if (args.expires_after_days !== undefined && memory_type !== "status") {
    throw new Error("expires_after_days is only valid for status memories.");
  }
  const tags = args.tags ?? "";
  const context = args.context ?? "";
  const prospective = {
    content: args.content,
    tags,
    context,
    memory_type,
    status,
    certainty,
  };
  const size = assertMemoryEmbeddingBudget(prospective);
  const id = await insertMemory(bindings.DB, {
    repository: args.repository,
    content: args.content,
    tags,
    context,
    memory_type,
    status,
    certainty,
    source_agent: "mcp",
    refs: "[]",
    expires_after_days: args.expires_after_days ?? null,
  });
  const row = await rowById(bindings.DB, args.repository, id);
  if (row) {
    await upsertVector(bindings, row).catch((cause) => {
      console.error(
        `memory ${id} saved but vector sync failed: ${String(cause)}`,
      );
    });
  }
  const created: MemoryRow = row ?? {
    id,
    repository: args.repository,
    content: args.content,
    tags,
    context,
    memory_type,
    status,
    certainty,
  };
  return {
    written_to: args.repository,
    id: created.id,
    memory: created,
    size,
  };
}

const MemoryUpdateArgs = Schema.Struct({
  repository: repositoryOwnedField,
  id: positiveInt("The numeric memory id to update."),
  content: Schema.optionalKey(describedString("New canonical content.")),
  tags: optionalString("New comma-separated tags."),
  context: optionalString("New supporting context."),
  memory_type: optionalEnum(MEMORY_TYPES, "New memory type."),
  certainty: optionalEnum(CERTAINTY_LEVELS, "New certainty level."),
  status: optionalEnum(MEMORY_STATUSES, "New status."),
});
type MemoryUpdateArgs = Schema.Schema.Type<typeof MemoryUpdateArgs>;
const memoryUpdateInput = mcpInputSchema(MemoryUpdateArgs);

const MemorySizeArgs = Schema.Struct({
  content: describedString(
    "The canonical memory content to measure. Put commands, paths, keys, and exact identifiers in the first sentence for retrieval.",
  ),
  tags: optionalString("Comma-separated tags, e.g. 'area:cli,topic:backend'."),
  context: optionalString("Supporting context for the memory."),
  memory_type: Schema.optionalKey(
    Schema.Literals(MEMORY_TYPES).annotate({ description: "Type of memory." }),
  ),
  certainty: Schema.optionalKey(
    Schema.Literals(CERTAINTY_LEVELS).annotate({
      description: "Certainty level.",
    }),
  ),
  status: Schema.optionalKey(
    Schema.Literals(MEMORY_STATUSES).annotate({
      description: "Memory status.",
    }),
  ),
});
type MemorySizeArgs = Schema.Schema.Type<typeof MemorySizeArgs>;
const memorySizeInput = mcpInputSchema(MemorySizeArgs);

const MemoryDeleteArgs = Schema.Struct({
  repository: repositoryOwnedField,
  id: positiveInt("The numeric memory id to delete."),
});
type MemoryDeleteArgs = Schema.Schema.Type<typeof MemoryDeleteArgs>;
const memoryDeleteInput = mcpInputSchema(MemoryDeleteArgs);

function searchInputFromArgs(args: {
  repository: string;
  query: string;
  limit: number;
  status?: string;
  memory_type?: string;
  certainty?: string;
}): SearchInput {
  return {
    repository: args.repository,
    query: args.query,
    limit: args.limit,
    status: args.status,
    memory_type: args.memory_type,
    certainty: args.certainty,
  };
}

async function hybridSearch(
  bindings: McpBindings,
  input: SearchInput,
): Promise<MemoryRow[]> {
  const [keyword, semantic] = await Promise.all([
    keywordSearch(bindings.DB, input),
    semanticSearch(bindings, {
      ...input,
      limit: Math.min(input.limit * 3, MAX_SEARCH_LIMIT),
    }),
  ]);
  const byId = new Map<number, MemoryRow & { score?: number }>();
  for (const row of keyword) {
    byId.set(row.id, row);
  }
  for (const row of semantic) {
    const existing = byId.get(row.id);
    byId.set(row.id, existing ? { ...existing, score: row.score } : row);
  }
  return [...byId.values()].slice(0, input.limit);
}

export function createMemoryServer(
  bindings: McpBindings,
  authenticatedLogin?: string,
): McpServer {
  const server = new McpServer({
    name: "machine-memory",
    version: "1.0.0",
  });

  const ownerHint = authenticatedLogin
    ? ` The authenticated GitHub user is '${authenticatedLogin}', so repositories under that owner (e.g. '${authenticatedLogin}/repo-name') are likely candidates. Call list_repositories first if unsure.`
    : " Call list_repositories first if you are unsure which repository slug to use.";

  server.registerTool(
    "list_repositories",
    {
      description:
        "List all repository slugs (owner/name) that have at least one memory stored. Call this before any mutating tool (memory_add, memory_update, memory_delete) when you are not certain which repository slug to use. Reads (memory_query, memory_list, memory_get) can proceed loosely — a wrong slug returns empty results and nothing is lost. Writes against a wrong slug corrupt data, so always confirm the slug first.",
      inputSchema: listRepositoriesInput,
    },
    async (args: ListRepositoriesArgs) => {
      try {
        const limit = args.limit ?? MAX_SEARCH_LIMIT;
        const result = await bindings.DB.prepare(
          `SELECT DISTINCT repository FROM memories ORDER BY repository LIMIT ?`,
        )
          .bind(limit)
          .all<{ repository: string }>();
        const repos = (result.results ?? []).map((r) => r.repository);
        return textResult(repos);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_query",
    {
      description:
        "Search project memories. Use this to recall facts, decisions, conventions, gotchas, and references recorded for a repository. Supports keyword (full-text) and semantic (embedding-based) search. This is a read-only tool — a wrong repository slug returns empty results; nothing is lost.",
      inputSchema: memoryQueryInput,
    },
    async (args: MemoryQueryArgs) => {
      try {
        validateNamespace(args.repository);
        const mode = args.mode ?? "hybrid";
        const input = searchInputFromArgs({
          repository: args.repository,
          query: args.query,
          limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
          status: args.status,
          memory_type: args.memory_type,
          certainty: args.certainty,
        });
        if (mode === "keyword") {
          return textResult(await keywordSearch(bindings.DB, input));
        }
        if (mode === "semantic") {
          return textResult(await semanticSearch(bindings, input));
        }
        return textResult(await hybridSearch(bindings, input));
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_get",
    {
      description:
        "Fetch a single memory by its numeric id from a repository's memory store. This is a read-only tool — a wrong repository slug returns 'No memory found'; nothing is lost.",
      inputSchema: memoryGetInput,
    },
    async (args: MemoryGetArgs) => {
      try {
        validateNamespace(args.repository);
        const row = await rowById(bindings.DB, args.repository, args.id);
        if (!row) {
          return textMessage(
            `No memory found with id ${args.id} in repository '${args.repository}'.`,
          );
        }
        return textResult([row]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      description:
        "List memories for a repository, optionally filtered by status, memory type, or certainty. This is a read-only tool — a wrong repository slug returns an empty list; nothing is lost.",
      inputSchema: memoryListInput,
    },
    async (args: MemoryListArgs) => {
      try {
        validateNamespace(args.repository);
        const clauses = ["repository = ?"];
        const params: (string | number)[] = [args.repository];
        if (args.status !== undefined) {
          clauses.push("status = ?");
          params.push(args.status);
        }
        if (args.memory_type !== undefined) {
          clauses.push("memory_type = ?");
          params.push(args.memory_type);
        }
        if (args.certainty !== undefined) {
          clauses.push("certainty = ?");
          params.push(args.certainty);
        }
        const result = await bindings.DB.prepare(
          `SELECT ${ROW_SELECT}
           FROM memories WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC LIMIT ?`,
        )
          .bind(...params, args.limit ?? DEFAULT_SEARCH_LIMIT)
          .all<MemoryRow>();
        return textResult(result.results ?? []);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_add",
    {
      description: `⚠️ WRITE OPERATION — a wrong repository slug will write to the wrong namespace. There is no default: repository is always required and must be an exact owner/name slug. Call list_repositories first if you are not certain.${ownerHint} Use this to record facts, decisions, conventions, gotchas, preferences, constraints, references, or status snapshots so future agent sessions can recall them. Rejects on flight when the composed embedding text exceeds the 512 byte+2 budget (same as CLI size / Worker REST); call memory_size to preflight.`,
      inputSchema: memoryAddInput,
    },
    async (args: MemoryAddArgs) => {
      try {
        return textResult([await addMemory(bindings, args)]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_update",
    {
      description: `⚠️ WRITE OPERATION — a wrong repository slug will return not-found rather than silently corrupt data (the WHERE clause scopes by repository AND id). There is no default: repository is always required. Call list_repositories first if unsure.${ownerHint} Re-embeds the vector so future semantic searches reflect the change. Rejects on flight when the resulting composed embedding text exceeds the 512 byte+2 budget; call memory_size to preflight.`,
      inputSchema: memoryUpdateInput,
    },
    async (args: MemoryUpdateArgs) => {
      try {
        validateNamespace(args.repository);
        const existing = await rowById(bindings.DB, args.repository, args.id);
        if (!existing) {
          return textMessage(
            `No memory found with id ${args.id} in repository '${args.repository}'. Verify the repository slug with list_repositories before retrying.`,
          );
        }
        const prospective = {
          content: args.content ?? existing.content,
          tags: args.tags ?? existing.tags,
          context: args.context ?? existing.context,
          memory_type: args.memory_type ?? existing.memory_type,
          status: args.status ?? existing.status,
          certainty: args.certainty ?? existing.certainty,
        };
        const size = assertMemoryEmbeddingBudget(prospective);
        const update = updateClause(args);
        if (update === null) {
          return textResult([{ ...existing, size }]);
        }
        await bindings.DB.prepare(
          `UPDATE memories SET ${update.sets.join(", ")} WHERE repository = ? AND id = ?`,
        )
          .bind(...update.params, args.repository, args.id)
          .run();
        const row = await rowById(bindings.DB, args.repository, args.id);
        if (row) {
          await upsertVector(bindings, row).catch((cause) => {
            console.error(
              `memory ${args.id} updated but vector sync failed: ${String(cause)}`,
            );
          });
        }
        return textResult([{ ...(row ?? existing), size }]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_size",
    {
      description:
        "Preflight the embedding budget for a prospective memory without writing. Uses the same conservative UTF-8 bytes+2 estimate the Worker enforces on every write (max 512). Mirrors CLI `machine-memory size` / add --dry-run size reporting. Call this before memory_add or memory_update when content may be long; oversize writes are rejected on flight.",
      inputSchema: memorySizeInput,
    },
    async (args: MemorySizeArgs) => {
      try {
        const size = measureMemoryEmbeddingBudget({
          content: args.content,
          tags: args.tags ?? "",
          context: args.context ?? "",
          memory_type: args.memory_type ?? "convention",
          status: args.status ?? "active",
          certainty: args.certainty ?? "inferred",
        });
        if (!size.within_budget) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify([{ size }], null, 2),
              },
            ],
            isError: true,
          };
        }
        return textResult([{ size }]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_delete",
    {
      description: `⚠️ WRITE OPERATION — deletion is permanent. There is no default: repository is always required and must be an exact owner/name slug. Call list_repositories first if unsure.${ownerHint} Also removes the vector embedding.`,
      inputSchema: memoryDeleteInput,
    },
    async (args: MemoryDeleteArgs) => {
      try {
        validateNamespace(args.repository);
        const existing = await rowById(bindings.DB, args.repository, args.id);
        const result = await bindings.DB.prepare(
          "DELETE FROM memories WHERE repository = ? AND id = ?",
        )
          .bind(args.repository, args.id)
          .run();
        await bindings.VECTORIZE.deleteByIds([String(args.id)]).catch(
          (cause) => {
            console.error(
              `memory ${args.id} deleted but vector cleanup failed: ${String(cause)}`,
            );
          },
        );
        return textResult([
          {
            deleted_from: args.repository,
            id: args.id,
            deleted: (result.meta.changes ?? 0) > 0,
            existed: existing !== undefined,
          },
        ]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  return server;
}

type UpdateClause = {
  sets: string[];
  params: (string | number)[];
};

function appendUpdate(
  clauses: UpdateClause,
  field: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    clauses.sets.push(`${field} = ?`);
    clauses.params.push(value);
  }
}

function updateClause(args: {
  content?: string;
  tags?: string;
  context?: string;
  memory_type?: string;
  certainty?: string;
  status?: string;
}): UpdateClause | null {
  const clauses: UpdateClause = { sets: [], params: [] };
  appendUpdate(clauses, "content", args.content);
  appendUpdate(clauses, "tags", args.tags);
  appendUpdate(clauses, "context", args.context);
  appendUpdate(clauses, "memory_type", args.memory_type);
  appendUpdate(clauses, "certainty", args.certainty);
  appendUpdate(clauses, "status", args.status);
  if (clauses.sets.length === 0) {
    return null;
  }
  clauses.sets.push("updated_at = datetime('now')");
  clauses.sets.push("update_count = COALESCE(update_count, 0) + 1");
  return clauses;
}

export { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT };
