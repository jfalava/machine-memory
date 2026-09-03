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

/**
 * CLI parity helpers. The CLI ships suggest / verify / diff / --match /
 * --upsert-match on top of the same D1 + FTS primitives; the ports below keep
 * MCP behavior identical (same stopwords, thresholds, and scoring weights).
 */

function sqliteDateToMs(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

const FACT_STOPWORDS = new Set([
  ...STOPWORDS,
  "src",
  "lib",
  "app",
  "test",
  "tests",
]);

function factTerms(input: string): Set<string> {
  const tokens = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 2 && !FACT_STOPWORDS.has(token),
  );
  return new Set(tokens);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : Number((intersection / union).toFixed(3));
}

function hasNegation(text: string): boolean {
  return /\b(not|no|never|without|cannot|can't)\b/.test(text.toLowerCase());
}

export type FactCheckResult = {
  readonly similarity: number;
  readonly conflict: boolean;
  readonly addedTerms: string[];
  readonly removedTerms: string[];
};

/** Port of the CLI verify/diff comparator: Jaccard similarity plus negation check. */
export function compareMemoryFact(
  stored: string,
  candidate: string,
): FactCheckResult {
  const storedTerms = factTerms(stored);
  const candidateTerms = factTerms(candidate);
  const similarity = jaccardSimilarity(storedTerms, candidateTerms);
  return {
    similarity,
    conflict:
      hasNegation(stored) !== hasNegation(candidate) || similarity < 0.35,
    addedTerms: [...candidateTerms]
      .filter((term) => !storedTerms.has(term))
      .slice(0, 12),
    removedTerms: [...storedTerms]
      .filter((term) => !candidateTerms.has(term))
      .slice(0, 12),
  };
}

function contentHead(text: string, maxChars = 120): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > maxChars
    ? `${flattened.slice(0, maxChars)}…`
    : flattened;
}

function certaintyPoints(certainty: string): number {
  if (certainty === "verified") {
    return 20;
  }
  if (certainty === "inferred") {
    return 10;
  }
  return 2;
}

function recencyPoints(updatedAt: string): number {
  const ms = sqliteDateToMs(updatedAt);
  if (ms === null) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - ms) / (1000 * 60 * 60 * 24));
  const capped = Math.min(ageDays, 180);
  return Number((30 * (1 - capped / 180)).toFixed(3));
}

function tagMatchPoints(tags: string, queryTokens: string[]): number {
  if (tags === "" || queryTokens.length === 0) {
    return 0;
  }
  const tagList = tags
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const tokenSet = new Set(queryTokens.map((token) => token.toLowerCase()));
  if (tagList.some((tag) => tokenSet.has(tag))) {
    return 18;
  }
  if (
    tagList.some((tag) =>
      queryTokens.some((token) => tag.includes(token.toLowerCase())),
    )
  ) {
    return 8;
  }
  return 0;
}

function updateCountPoints(updateCount: number): number {
  if (!Number.isFinite(updateCount) || updateCount <= 0) {
    return 0;
  }
  return Math.min(updateCount, 10) * 2;
}

function ftsRankPoints(ftsRank: number): number {
  if (!Number.isFinite(ftsRank)) {
    return 0;
  }
  return Number(Math.max(0, Math.min(30, ftsRank * -10)).toFixed(3));
}

/** D1 memory row plus the columns ranking needs. */
export type RankedMemoryRow = MemoryRow & {
  readonly updated_at: string;
  readonly update_count: number;
};

type FtsRankedMemoryRow = RankedMemoryRow & {
  readonly fts_rank: number;
};

export type ScoredMemoryRow = RankedMemoryRow & {
  readonly score: number;
};

/**
 * Port of the CLI result scorer (recency + certainty + tag match +
 * update count + FTS rank).
 */
export function scoreMemoryRows(
  rows: readonly FtsRankedMemoryRow[],
  queryTokens: string[],
): ScoredMemoryRow[] {
  return rows
    .map((row) => ({
      id: row.id,
      repository: row.repository,
      content: row.content,
      tags: row.tags,
      context: row.context,
      memory_type: row.memory_type,
      status: row.status,
      certainty: row.certainty,
      updated_at: row.updated_at,
      update_count: row.update_count,
      score: Number(
        (
          recencyPoints(row.updated_at) +
          certaintyPoints(row.certainty) +
          tagMatchPoints(row.tags, queryTokens) +
          updateCountPoints(row.update_count) +
          ftsRankPoints(row.fts_rank)
        ).toFixed(3),
      ),
    }))
    .sort((left, right) => right.score - left.score);
}

/** Project a ranked row onto the public memory shape plus its score. */
export function scoredResultRow(
  row: ScoredMemoryRow,
): MemoryRow & { score: number } {
  return {
    id: row.id,
    repository: row.repository,
    content: row.content,
    tags: row.tags,
    context: row.context,
    memory_type: row.memory_type,
    status: row.status,
    certainty: row.certainty,
    score: row.score,
  };
}

/** Port of the CLI `--match` resolver: best active FTS hit, scored like suggest. */
export async function findBestMemoryMatch(
  db: D1Database,
  repository: string,
  query: string,
): Promise<{ row: MemoryRow; score: number } | null> {
  const terms = extractTerms(query);
  const ftsQuery = buildFtsQuery(terms);
  if (ftsQuery === undefined) {
    return null;
  }
  const result = await db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.repository = ? AND m.status = 'active'
       ORDER BY bm25(memories_fts)
       LIMIT 5`,
    )
    .bind(ftsQuery, repository)
    .all<FtsRankedMemoryRow>();
  const best = scoreMemoryRows(result.results ?? [], terms)[0];
  if (!best) {
    return null;
  }
  return { row: scoredResultRow(best), score: best.score };
}

/** Port of the CLI add conflict detector: top scored active overlaps. */
export async function detectMemoryConflicts(
  db: D1Database,
  repository: string,
  payload: { content: string; tags: string; context: string },
  options: { excludeId?: number; limit?: number } = {},
): Promise<Array<MemoryRow & { score: number }>> {
  const terms = extractTerms(
    [payload.content, payload.tags, payload.context].join(" "),
  );
  const ftsQuery = buildFtsQuery(terms);
  if (ftsQuery === undefined) {
    return [];
  }
  const clauses = [
    "memories_fts MATCH ?",
    "m.repository = ?",
    "m.status = 'active'",
  ];
  const params: (string | number)[] = [ftsQuery, repository];
  if (options.excludeId !== undefined) {
    clauses.push("m.id != ?");
    params.push(options.excludeId);
  }
  const result = await db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY bm25(memories_fts)
       LIMIT ${Number(options.limit ?? 5)}`,
    )
    .bind(...params)
    .all<FtsRankedMemoryRow>();
  return scoreMemoryRows(result.results ?? [], terms).map(scoredResultRow);
}

type SuggestFilters = {
  repository: string;
  status?: string;
  memory_type?: string;
  certainty?: string;
  tags?: string;
};

function applySuggestFilters(
  clauses: string[],
  params: (string | number)[],
  filters: SuggestFilters,
  prefix: string,
): void {
  clauses.push(`${prefix}repository = ?`);
  params.push(filters.repository);
  if (filters.status !== undefined) {
    clauses.push(`${prefix}status = ?`);
    params.push(filters.status);
  }
  if (filters.memory_type !== undefined) {
    clauses.push(`${prefix}memory_type = ?`);
    params.push(filters.memory_type);
  }
  if (filters.certainty !== undefined) {
    clauses.push(`${prefix}certainty = ?`);
    params.push(filters.certainty);
  }
  if (filters.tags !== undefined) {
    clauses.push(`${prefix}tags LIKE ?`);
    params.push(`%${filters.tags}%`);
  }
}

async function suggestFtsRows(
  db: D1Database,
  filters: SuggestFilters,
  ftsQuery: string,
): Promise<FtsRankedMemoryRow[]> {
  const clauses = ["memories_fts MATCH ?"];
  const params: (string | number)[] = [ftsQuery];
  applySuggestFilters(clauses, params, filters, "m.");
  const result = await db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY bm25(memories_fts)
       LIMIT 100`,
    )
    .bind(...params)
    .all<FtsRankedMemoryRow>();
  return result.results ?? [];
}

async function suggestNeighborhoodRows(
  db: D1Database,
  filters: SuggestFilters,
  neighborhood: FileNeighborhood,
): Promise<FtsRankedMemoryRow[]> {
  const orClauses: string[] = [];
  const orParams: (string | number)[] = [];
  for (const tagHint of neighborhood.tagHints.slice(0, 10)) {
    orClauses.push("LOWER(m.tags) LIKE ?");
    orParams.push(`%${tagHint.toLowerCase()}%`);
  }
  for (const pathHint of neighborhood.pathHints.slice(0, 10)) {
    const lowered = `%${pathHint.toLowerCase()}%`;
    orClauses.push("LOWER(m.content) LIKE ?");
    orParams.push(lowered);
    orClauses.push("LOWER(m.context) LIKE ?");
    orParams.push(lowered);
    orClauses.push("LOWER(m.refs) LIKE ?");
    orParams.push(lowered);
  }
  if (orClauses.length === 0) {
    return [];
  }
  const clauses = [`(${orClauses.join(" OR ")})`];
  const params: (string | number)[] = [...orParams];
  applySuggestFilters(clauses, params, filters, "m.");
  const result = await db
    .prepare(
      `SELECT m.*, 0 AS fts_rank
       FROM memories m
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT 30`,
    )
    .bind(...params)
    .all<FtsRankedMemoryRow>();
  return result.results ?? [];
}

type SuggestRow = ScoredMemoryRow;

/** Port of the CLI suggestion merge: neighborhood hits get a +12 boost. */
function mergeSuggestRows(
  primary: SuggestRow[],
  secondary: SuggestRow[],
): SuggestRow[] {
  const byId = new Map<number, SuggestRow>();
  for (const row of primary) {
    byId.set(row.id, row);
  }
  for (const row of secondary) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, {
        ...row,
        score: Number((row.score + 12).toFixed(3)),
      });
      continue;
    }
    const nextScore = Math.max(existing.score, row.score + 12);
    byId.set(row.id, { ...existing, score: Number(nextScore.toFixed(3)) });
  }
  return [...byId.values()].sort((left, right) => right.score - left.score);
}

export function normalizeSuggestPath(value: string): string {
  const cleaned = value.trim().replaceAll("\\", "/");
  if (!cleaned) {
    return "";
  }
  return cleaned.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
}

export function parseSuggestFilesParam(files: string): string[] {
  const seen = new Set<string>();
  const parsed: string[] = [];
  for (const item of files.split(",")) {
    const normalized = normalizeSuggestPath(item);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      parsed.push(normalized);
    }
  }
  return parsed;
}

/** Port of the CLI path-term extractor: segments plus dot/dash/underscore pieces. */
export function extractPathTerms(paths: string[]): string[] {
  const terms: string[] = [];
  for (const path of paths) {
    for (const segment of normalizeSuggestPath(path)
      .split("/")
      .filter(Boolean)) {
      terms.push(segment);
      for (const piece of segment.split(/[._-]+/)) {
        if (piece) {
          terms.push(piece);
        }
      }
    }
  }
  return extractTerms(terms.join(" "));
}

export type FileNeighborhood = {
  readonly tagHints: string[];
  readonly pathHints: string[];
  readonly terms: string[];
};

const NEIGHBORHOOD_IGNORED_SEGMENTS = new Set([
  "src",
  "lib",
  "app",
  "apps",
  "test",
  "tests",
]);

function collectExtensionHint(
  directory: string,
  base: string,
  seenPaths: Set<string>,
  pathHints: string[],
): void {
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1) : "";
  if (!extension) {
    return;
  }
  const hint = `${directory}/%.${extension}`;
  if (!seenPaths.has(hint.toLowerCase())) {
    seenPaths.add(hint.toLowerCase());
    pathHints.push(hint);
  }
}

function collectFileHints(
  filePath: string,
  seenTags: Set<string>,
  seenPaths: Set<string>,
  tagHints: string[],
  pathHints: string[],
): void {
  const normalized = normalizeSuggestPath(filePath);
  const slash = normalized.lastIndexOf("/");
  const directory = slash < 0 ? "." : normalized.slice(0, slash);
  if (!directory || directory === ".") {
    return;
  }
  const lowerDir = directory.toLowerCase();
  if (!seenPaths.has(lowerDir)) {
    seenPaths.add(lowerDir);
    pathHints.push(`${directory}/`);
  }
  const base = normalized.slice(slash + 1);
  collectExtensionHint(directory, base, seenPaths, pathHints);
  for (const segment of directory.split("/").filter(Boolean)) {
    const lower = segment.toLowerCase();
    if (!NEIGHBORHOOD_IGNORED_SEGMENTS.has(lower) && !seenTags.has(lower)) {
      seenTags.add(lower);
      tagHints.push(segment);
    }
  }
}

/** Port of the CLI suggest neighborhood: directory tag hints + content path hints. */
export function deriveFileNeighborhood(files: string[]): FileNeighborhood {
  const tagHints: string[] = [];
  const pathHints: string[] = [];
  const seenTags = new Set<string>();
  const seenPaths = new Set<string>();
  for (const filePath of files) {
    collectFileHints(filePath, seenTags, seenPaths, tagHints, pathHints);
  }
  return {
    tagHints,
    pathHints,
    terms: extractTerms([...tagHints, ...pathHints].join(" ")),
  };
}

function uniqueLowerPreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const lower = value.toLowerCase();
    if (value && !seen.has(lower)) {
      seen.add(lower);
      unique.push(value);
    }
  }
  return unique;
}

type SearchInput = {
  repository: string;
  query: string;
  limit: number;
  status?: string;
  memory_type?: string;
  certainty?: string;
  tags?: string;
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

const tagsFilterField = {
  tags: optionalString(
    "Filter to memories whose tags contain this text (substring, case-insensitive).",
  ),
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
  ...tagsFilterField,
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
  ...tagsFilterField,
});
type MemoryListArgs = Schema.Schema.Type<typeof MemoryListArgs>;
const memoryListInput = mcpInputSchema(MemoryListArgs);

const MemorySuggestArgs = Schema.Struct({
  repository: repositoryField,
  files: describedString(
    "Comma-separated file paths to find relevant memories for, e.g. 'src/auth/jwt.ts,src/middleware/session.ts'.",
  ),
  query: optionalString(
    "Optional extra search terms scored together with the file-derived terms.",
  ),
  limit: searchLimitField("Maximum number of results to return."),
  ...filterFields,
  ...tagsFilterField,
});
type MemorySuggestArgs = Schema.Schema.Type<typeof MemorySuggestArgs>;
const memorySuggestInput = mcpInputSchema(MemorySuggestArgs);

const MemoryVerifyArgs = Schema.Struct({
  repository: repositoryField,
  id: positiveInt("The numeric memory id to check the fact against."),
  fact: describedString("The inferred fact to verify against the memory."),
});
type MemoryVerifyArgs = Schema.Schema.Type<typeof MemoryVerifyArgs>;
const memoryVerifyInput = mcpInputSchema(MemoryVerifyArgs);

const MemoryDiffArgs = Schema.Struct({
  repository: repositoryField,
  id: positiveInt("The numeric memory id to compare the new content against."),
  content: describedString("The proposed new content to diff."),
});
type MemoryDiffArgs = Schema.Schema.Type<typeof MemoryDiffArgs>;
const memoryDiffInput = mcpInputSchema(MemoryDiffArgs);

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
  upsert_match: optionalString(
    "Resolve an existing memory with this topic query first: a strong match is updated in place, otherwise a new record is created. A weak match refuses to create unless force is true.",
  ),
  force: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Create a new record even when upsert_match finds only a weak match.",
    }),
  ),
  upsert_threshold: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })).annotate({
      description:
        "Minimum match score (0-100, default 32) for an upsert_match hit to count as strong, alongside similarity >= 0.62.",
    }),
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
  potential_conflicts: Array<MemoryRow & { score: number }>;
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
  const potential_conflicts = await detectMemoryConflicts(
    bindings.DB,
    args.repository,
    { content: args.content, tags, context },
  );
  return {
    written_to: args.repository,
    id: created.id,
    memory: created,
    size,
    potential_conflicts,
  };
}

const UPSERT_MIN_SIMILARITY = 0.62;
const UPSERT_DEFAULT_MIN_SCORE = 32;

type UpsertMatchInfo = {
  readonly id: number;
  readonly score: number;
  readonly similarity: number;
  readonly memory_type: string;
  readonly status: string;
  readonly content_head: string;
};

export type MemoryWriteResult = {
  readonly mode?: string;
  readonly written_to: string;
  readonly id: number;
  readonly memory: MemoryRow;
  readonly size: ReturnType<typeof embeddingSizeReport>;
  readonly upsert_match?: UpsertMatchInfo;
  readonly potential_conflicts?: Array<MemoryRow & { score: number }>;
};

function upsertMatchInfo(
  row: MemoryRow,
  score: number,
  content: string,
  tags: string,
  context: string,
): UpsertMatchInfo {
  return {
    id: row.id,
    score,
    similarity: compareMemoryFact(
      [row.content, row.tags, row.context].join(" "),
      [content, tags, context].join(" "),
    ).similarity,
    memory_type: row.memory_type,
    status: row.status,
    content_head: contentHead(row.content),
  };
}

/**
 * Port of the CLI `add --upsert-match` flow: a strong match (similarity >=
 * 0.62 AND score >= threshold) is updated in place, otherwise a new record
 * is created. A weak match refuses to create unless `force` is true — the
 * MCP equivalent of the CLI's interactive confirm, since workers have no TTY.
 */
async function applyStrongUpsertUpdate(
  bindings: McpBindings,
  args: MemoryAddArgs,
  best: { row: MemoryRow; score: number },
  info: UpsertMatchInfo,
): Promise<MemoryWriteResult> {
  const prospective = {
    content: args.content,
    tags: args.tags ?? best.row.tags,
    context: args.context ?? best.row.context,
    memory_type: args.memory_type ?? best.row.memory_type,
    status: best.row.status,
    certainty: args.certainty ?? best.row.certainty,
  };
  const size = assertMemoryEmbeddingBudget(prospective);
  const update = updateClause({
    content: args.content,
    tags: args.tags,
    context: args.context,
    memory_type: args.memory_type,
    certainty: args.certainty,
    expires_after_days: args.expires_after_days,
    superseded_by: undefined,
  });
  if (update === null) {
    return {
      mode: "updated",
      id: best.row.id,
      written_to: args.repository,
      memory: best.row,
      size,
      upsert_match: info,
    };
  }
  await bindings.DB.prepare(
    `UPDATE memories SET ${update.sets.join(", ")} WHERE repository = ? AND id = ?`,
  )
    .bind(...update.params, args.repository, best.row.id)
    .run();
  const row = await rowById(bindings.DB, args.repository, best.row.id);
  if (row) {
    await upsertVector(bindings, row).catch((cause) => {
      console.error(
        `memory ${best.row.id} updated but vector sync failed: ${String(cause)}`,
      );
    });
  }
  return {
    mode: "updated",
    id: best.row.id,
    written_to: args.repository,
    memory: row ?? best.row,
    size,
    upsert_match: info,
  };
}

async function addMemoryUpsert(
  bindings: McpBindings,
  args: MemoryAddArgs,
  upsertQuery: string,
): Promise<MemoryWriteResult> {
  validateNamespace(args.repository);
  const minScore = args.upsert_threshold ?? UPSERT_DEFAULT_MIN_SCORE;
  const memory_type = args.memory_type ?? "convention";
  if (args.expires_after_days !== undefined && memory_type !== "status") {
    throw new Error("expires_after_days is only valid for status memories.");
  }
  const tags = args.tags ?? "";
  const context = args.context ?? "";
  const best = await findBestMemoryMatch(
    bindings.DB,
    args.repository,
    upsertQuery,
  );
  if (!best) {
    return addMemory(bindings, args);
  }
  const info = upsertMatchInfo(
    best.row,
    best.score,
    args.content,
    tags,
    context,
  );
  const strong =
    info.similarity >= UPSERT_MIN_SIMILARITY && best.score >= minScore;
  if (!strong && !args.force) {
    throw new Error(
      `Best match #${info.id} is not a strong upsert match (score ${info.score}, similarity ${info.similarity}; needs score >= ${minScore} AND similarity >= ${UPSERT_MIN_SIMILARITY}). ` +
        `Refusing to silently create a new record: inspect it with memory_get, rerun with force true to create anyway, or lower the bar with upsert_threshold 0-100. ` +
        `Match: ${JSON.stringify(info)}`,
    );
  }
  if (!strong) {
    return { ...(await addMemory(bindings, args)), upsert_match: info };
  }
  return applyStrongUpsertUpdate(bindings, args, best, info);
}

const MemoryUpdateArgs = Schema.Struct({
  repository: repositoryOwnedField,
  id: Schema.optionalKey(positiveInt("The numeric memory id to update.")),
  match: optionalString(
    "Resolve the update target with this topic query instead of id (exactly one of id or match is required). Errors when nothing active matches.",
  ),
  content: Schema.optionalKey(describedString("New canonical content.")),
  tags: optionalString("New comma-separated tags."),
  context: optionalString("New supporting context."),
  memory_type: optionalEnum(MEMORY_TYPES, "New memory type."),
  certainty: optionalEnum(CERTAINTY_LEVELS, "New certainty level."),
  status: optionalEnum(MEMORY_STATUSES, "New status."),
  expires_after_days: Schema.optionalKey(
    positiveInt("New expiry; only valid when the memory is a status memory."),
  ),
  superseded_by: Schema.optionalKey(
    positiveInt("Id of the memory that supersedes this one."),
  ),
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

type UpdateTarget =
  | { readonly kind: "id"; readonly targetId: number }
  | {
      readonly kind: "matched";
      readonly targetId: number;
      readonly matched: {
        readonly query: string;
        readonly id: number;
        readonly score: number;
      };
    }
  | { readonly kind: "rejection"; readonly message: string }
  | { readonly kind: "empty"; readonly message: string };

async function resolveUpdateTarget(
  db: D1Database,
  repository: string,
  id: number | undefined,
  match: string | undefined,
): Promise<UpdateTarget> {
  const matchQuery = match?.trim() || undefined;
  if (id !== undefined && matchQuery !== undefined) {
    return {
      kind: "rejection",
      message: "Provide either the numeric id or a match query, not both.",
    };
  }
  if (matchQuery !== undefined) {
    const best = await findBestMemoryMatch(db, repository, matchQuery);
    if (!best) {
      return {
        kind: "empty",
        message: `No active memory matched '${matchQuery}' in repository '${repository}'.`,
      };
    }
    return {
      kind: "matched",
      targetId: best.row.id,
      matched: { query: matchQuery, id: best.row.id, score: best.score },
    };
  }
  if (id === undefined) {
    return {
      kind: "rejection",
      message: "Provide either the numeric id or a match query.",
    };
  }
  return { kind: "id", targetId: id };
}

type ResolvedUpdateTarget = Extract<
  UpdateTarget,
  { kind: "id" } | { kind: "matched" }
>;

function updateGuardResult(
  existing: MemoryRow | undefined,
  args: MemoryUpdateArgs,
  targetId: number,
): TextToolResult | ErrorToolResult | null {
  if (!existing) {
    return textMessage(
      `No memory found with id ${targetId} in repository '${args.repository}'. Verify the repository slug with list_repositories before retrying.`,
    );
  }
  if (args.superseded_by !== undefined && args.superseded_by === targetId) {
    return errorResult(new Error("A memory cannot supersede itself."));
  }
  const prospectiveType = args.memory_type ?? existing.memory_type;
  if (args.expires_after_days !== undefined && prospectiveType !== "status") {
    return errorResult(
      new Error("expires_after_days is only valid for status memories."),
    );
  }
  return null;
}

type ProspectiveMemoryDocument = {
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: string;
  readonly status: string;
  readonly certainty: string;
};

function updateProspectiveDocument(
  existing: MemoryRow,
  args: MemoryUpdateArgs,
): ProspectiveMemoryDocument {
  return {
    content: args.content ?? existing.content,
    tags: args.tags ?? existing.tags,
    context: args.context ?? existing.context,
    memory_type: args.memory_type ?? existing.memory_type,
    status: args.status ?? existing.status,
    certainty: args.certainty ?? existing.certainty,
  };
}

async function applyMemoryUpdate(
  bindings: McpBindings,
  args: MemoryUpdateArgs,
  target: ResolvedUpdateTarget,
): Promise<TextToolResult | ErrorToolResult> {
  const targetId = target.targetId;
  const existing = await rowById(bindings.DB, args.repository, targetId);
  const guard = updateGuardResult(existing, args, targetId);
  if (guard) {
    return guard;
  }
  if (!existing) {
    return textMessage(
      `No memory found with id ${targetId} in repository '${args.repository}'.`,
    );
  }
  const size = assertMemoryEmbeddingBudget(
    updateProspectiveDocument(existing, args),
  );
  const update = updateClause(args);
  if (update === null) {
    return updateNoopResult(existing, size, target);
  }
  await bindings.DB.prepare(
    `UPDATE memories SET ${update.sets.join(", ")} WHERE repository = ? AND id = ?`,
  )
    .bind(...update.params, args.repository, targetId)
    .run();
  const row = await rowById(bindings.DB, args.repository, targetId);
  if (row) {
    await upsertVector(bindings, row).catch((cause) => {
      console.error(
        `memory ${targetId} updated but vector sync failed: ${String(cause)}`,
      );
    });
  }
  return updateNoopResult(row ?? existing, size, target);
}

function updateNoopResult(
  row: MemoryRow,
  size: ReturnType<typeof assertMemoryEmbeddingBudget>,
  target: ResolvedUpdateTarget,
): TextToolResult {
  if (target.kind === "matched") {
    return textResult([{ ...row, size, matched: target.matched }]);
  }
  return textResult([{ ...row, size }]);
}

function searchInputFromArgs(args: {
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
          tags: args.tags,
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
        if (args.tags !== undefined) {
          clauses.push("tags LIKE ?");
          params.push(`%${args.tags}%`);
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

  type SuggestSnapshot = {
    readonly files: string[];
    readonly pathTerms: string[];
    readonly scoreTerms: string[];
    readonly neighborhood: FileNeighborhood;
    readonly ftsQuery: string | undefined;
  };

  function buildSuggestSnapshot(args: MemorySuggestArgs): SuggestSnapshot {
    const files = parseSuggestFilesParam(args.files);
    const pathTerms = extractPathTerms(files);
    const neighborhood = deriveFileNeighborhood(files);
    const queryTerms = args.query ? extractTerms(args.query) : [];
    return {
      files,
      pathTerms,
      scoreTerms: uniqueLowerPreserveOrder([
        ...pathTerms,
        ...neighborhood.terms,
        ...queryTerms,
      ]),
      neighborhood,
      ftsQuery: buildFtsQuery(
        uniqueLowerPreserveOrder([...pathTerms, ...queryTerms]),
      ),
    };
  }

  type SuggestEnvelope = {
    readonly files: string[];
    readonly normalized_path_terms: string[];
    readonly derived_terms: string[];
    readonly neighborhood: {
      readonly tags: string[];
      readonly paths: string[];
    };
    readonly count: number;
    readonly results: Array<MemoryRow & { score: number }>;
  };

  async function runMemorySuggest(
    db: D1Database,
    args: MemorySuggestArgs,
  ): Promise<SuggestEnvelope> {
    validateNamespace(args.repository);
    const snapshot = buildSuggestSnapshot(args);
    if (snapshot.files.length === 0) {
      throw new Error(
        "Provide at least one file path in files, e.g. 'src/auth/jwt.ts,src/middleware/session.ts'.",
      );
    }
    const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
    const ftsRows =
      snapshot.ftsQuery === undefined
        ? []
        : await suggestFtsRows(db, args, snapshot.ftsQuery);
    const neighborhoodRows = await suggestNeighborhoodRows(
      db,
      args,
      snapshot.neighborhood,
    );
    const results = mergeSuggestRows(
      scoreMemoryRows(ftsRows, snapshot.scoreTerms),
      scoreMemoryRows(neighborhoodRows, snapshot.scoreTerms),
    ).slice(0, limit);
    return {
      files: snapshot.files,
      normalized_path_terms: snapshot.pathTerms,
      derived_terms: snapshot.scoreTerms,
      neighborhood: {
        tags: snapshot.neighborhood.tagHints,
        paths: snapshot.neighborhood.pathHints,
      },
      count: results.length,
      results: results.map(scoredResultRow),
    };
  }
  server.registerTool(
    "memory_suggest",
    {
      description:
        "Suggest memories relevant to file paths, e.g. the files about to be edited. Ports the CLI suggest command: full-text search over path-derived terms plus directory neighborhood matches (tags and content/context path hints), merged and scored. Use this for the pre-edit scan when touched paths are known.",
      inputSchema: memorySuggestInput,
    },
    async (args: MemorySuggestArgs) => {
      try {
        return textResult([await runMemorySuggest(bindings.DB, args)]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_verify",
    {
      description:
        "Verify an inferred fact against a stored memory. Ports the CLI verify command (Jaccard term similarity plus negation check): returns consistent or conflict with a similarity score. Re-read the memory with memory_get first when the inference may conflict.",
      inputSchema: memoryVerifyInput,
    },
    async (args: MemoryVerifyArgs) => {
      try {
        validateNamespace(args.repository);
        const row = await rowById(bindings.DB, args.repository, args.id);
        if (!row) {
          return textMessage(
            `No memory found with id ${args.id} in repository '${args.repository}'.`,
          );
        }
        const result = compareMemoryFact(row.content, args.fact);
        return textResult([
          result.conflict
            ? {
                id: args.id,
                ok: false,
                result: "conflict",
                warning: "Conflict",
                similarity: result.similarity,
              }
            : {
                id: args.id,
                ok: true,
                result: "consistent",
                similarity: result.similarity,
              },
        ]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_diff",
    {
      description:
        "Diff proposed new content against a stored memory. Ports the CLI diff command: returns whether the proposal conflicts plus similarity and added/removed terms. Use this before memory_update when wording must change and the inference may conflict.",
      inputSchema: memoryDiffInput,
    },
    async (args: MemoryDiffArgs) => {
      try {
        validateNamespace(args.repository);
        const row = await rowById(bindings.DB, args.repository, args.id);
        if (!row) {
          return textMessage(
            `No memory found with id ${args.id} in repository '${args.repository}'.`,
          );
        }
        const result = compareMemoryFact(row.content, args.content);
        return textResult([
          {
            id: args.id,
            conflict: result.conflict,
            similarity: result.similarity,
            added_terms: result.addedTerms,
            removed_terms: result.removedTerms,
          },
        ]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_add",
    {
      description: `⚠️ WRITE OPERATION — a wrong repository slug will write to the wrong namespace. There is no default: repository is always required and must be an exact owner/name slug. Call list_repositories first if you are not certain.${ownerHint} Use this to record facts, decisions, conventions, gotchas, preferences, constraints, references, or status snapshots so future agent sessions can recall them. With upsert_match, a strong existing match is updated in place (echoes mode and upsert_match); a weak match refuses to create unless force is true. New records echo potential_conflicts so near-duplicates stay visible. Rejects on flight when the composed embedding text exceeds the 512 byte+2 budget (same as CLI size / Worker REST); call memory_size to preflight.`,
      inputSchema: memoryAddInput,
    },
    async (args: MemoryAddArgs) => {
      try {
        const upsertQuery = args.upsert_match?.trim() || undefined;
        if (upsertQuery === undefined) {
          return textResult([await addMemory(bindings, args)]);
        }
        return textResult([await addMemoryUpsert(bindings, args, upsertQuery)]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_update",
    {
      description: `⚠️ WRITE OPERATION — a wrong repository slug will return not-found rather than silently corrupt data (the WHERE clause scopes by repository AND id). There is no default: repository is always required. Call list_repositories first if unsure.${ownerHint} Target by id, or by match (resolves the best active full-text match first; echoes it as matched). Only provided fields change. Re-embeds the vector so future semantic searches reflect the change. Rejects on flight when the resulting composed embedding text exceeds the 512 byte+2 budget; call memory_size to preflight.`,
      inputSchema: memoryUpdateInput,
    },
    async (args: MemoryUpdateArgs) => {
      try {
        validateNamespace(args.repository);
        const target = await resolveUpdateTarget(
          bindings.DB,
          args.repository,
          args.id,
          args.match,
        );
        if (target.kind === "rejection") {
          return errorResult(new Error(target.message));
        }
        if (target.kind === "empty") {
          return textMessage(target.message);
        }
        return applyMemoryUpdate(bindings, args, target);
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
  expires_after_days?: number;
  superseded_by?: number;
}): UpdateClause | null {
  const clauses: UpdateClause = { sets: [], params: [] };
  appendUpdate(clauses, "content", args.content);
  appendUpdate(clauses, "tags", args.tags);
  appendUpdate(clauses, "context", args.context);
  appendUpdate(clauses, "memory_type", args.memory_type);
  appendUpdate(clauses, "certainty", args.certainty);
  appendUpdate(clauses, "status", args.status);
  if (args.expires_after_days !== undefined) {
    clauses.sets.push("expires_after_days = ?");
    clauses.params.push(args.expires_after_days);
  }
  if (args.superseded_by !== undefined) {
    clauses.sets.push("superseded_by = ?");
    clauses.params.push(args.superseded_by);
  }
  if (clauses.sets.length === 0) {
    return null;
  }
  clauses.sets.push("updated_at = datetime('now')");
  clauses.sets.push("update_count = COALESCE(update_count, 0) + 1");
  return clauses;
}

export { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT };
