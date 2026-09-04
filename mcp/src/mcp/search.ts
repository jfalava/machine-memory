import { SEARCH_LIMIT_MAX } from "@machine-memory/contract";
import { embedText, ROW_SELECT, rowById, validateNamespace } from "./db";
import { buildFtsQuery, extractTerms } from "./fts";
import type { McpBindings, MemoryRow } from "./types";
import type { MemoryQueryArgs } from "./tool-schemas";

export type SearchInput = {
  repository: string;
  query: string;
  limit: number;
  status?: string;
  memory_type?: string;
  certainty?: string;
  tags?: string;
};

export function searchInputFromArgs(args: {
  repository: string;
  query: string;
  limit: number;
  status?: string;
  memory_type?: string;
  certainty?: string;
  tags?: string;
}): SearchInput {
  return {
    repository: args.repository,
    query: args.query,
    limit: args.limit,
    status: args.status,
    memory_type: args.memory_type,
    certainty: args.certainty,
    tags: args.tags,
  };
}

export function queryArgsToSearchInput(
  args: MemoryQueryArgs,
  defaultLimit: number,
): SearchInput {
  return searchInputFromArgs({
    repository: args.repository,
    query: args.query,
    limit: args.limit ?? defaultLimit,
    status: args.status,
    memory_type: args.memory_type,
    certainty: args.certainty,
    tags: args.tags,
  });
}

export async function keywordSearch(
  db: D1Database,
  input: SearchInput,
): Promise<MemoryRow[]> {
  const ftsQuery = buildFtsQuery(extractTerms(input.query));
  if (ftsQuery === undefined) {
    return [];
  }
  const clauses = ["repository = ?", "memories_fts MATCH ?"];
  const params: (string | number)[] = [input.repository, ftsQuery];
  if (input.tags !== undefined) {
    clauses.push("m.tags LIKE ?");
    params.push(`%${input.tags}%`);
  }
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

export async function semanticSearch(
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
    if (
      input.tags !== undefined &&
      !row.tags.toLowerCase().includes(input.tags.toLowerCase())
    ) {
      continue;
    }
    scored.push({ ...row, score: match.score });
  }
  return scored;
}

export async function hybridSearch(
  bindings: McpBindings,
  input: SearchInput,
): Promise<MemoryRow[]> {
  const [keyword, semantic] = await Promise.all([
    keywordSearch(bindings.DB, input),
    semanticSearch(bindings, {
      ...input,
      limit: Math.min(input.limit * 3, SEARCH_LIMIT_MAX),
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

export function validateSearchRepository(repository: string): void {
  validateNamespace(repository);
}
