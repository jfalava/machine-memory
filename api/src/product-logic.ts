import {
  assessMatch,
  certaintyPoints,
  normalizeSuggestPath,
  normalizeTags,
  sqliteDateToMs,
  composeEmbeddingText,
  exactMatchPoints,
  ftsRankPoints,
  matchStrengthRank,
  matchText,
  recencyPoints,
  StoredMemoryRowSchema,
  MemorySummarySchema,
  normalizeStoredMemoryRow,
  tagMatchPoints,
  termCoveragePoints,
  updateCountPoints,
  type MatchAssessment,
  type MatchScope,
  type MemoryRow,
  type MemoryHistoryEntry,
  type MemorySummary,
  type ScoredMemoryRow,
  type MemoryStatsResult,
  jsonNumber,
  jsonString,
  type JsonObject,
} from "@machine-memory/contract";
import { Schema } from "effect";

export type RankedMemoryRow = MemorySummary & {
  readonly updated_at: string;
  readonly update_count: number;
  readonly refs: readonly string[];
};

export type FtsRankedMemoryRow = RankedMemoryRow & {
  readonly fts_rank: number;
};

/** Search terms plus literal identifiers used to assess absolute match strength. */
export type MatchQuery = {
  readonly terms: readonly string[];
  readonly identifiers: readonly string[];
  readonly scope?: MatchScope;
};

/** Decode at the database boundary; invalid stored enums must not become typed rows. */
export function toProductRow(value: JsonObject): MemoryRow {
  return normalizeStoredMemoryRow(
    Schema.decodeUnknownSync(StoredMemoryRowSchema)(value),
  );
}

export function toHistoryRow(value: JsonObject): MemoryHistoryEntry {
  const row = toProductRow({
    ...value,
    id: jsonNumber(value.memory_id) ?? 0,
    refs: jsonString(value.refs) ?? "[]",
  });
  return {
    ...row,
    revision_id: Number(value.revision_id),
    operation: jsonString(value.operation) ?? "update",
    snapshot_at: jsonString(value.snapshot_at) ?? "",
  };
}

export function toRankedRow(value: JsonObject): FtsRankedMemoryRow {
  const row = toProductRow(value);
  return {
    ...Schema.decodeSync(MemorySummarySchema)(row),
    updated_at: row.updated_at ?? "",
    update_count: row.update_count,
    refs: row.refs,
    fts_rank: Number(value.fts_rank ?? 0),
  };
}

export function assessRowMatch(
  row: Pick<MemorySummary, "content" | "tags" | "context"> & {
    readonly refs: readonly string[];
  },
  query: MatchQuery,
  semanticScore?: number,
): MatchAssessment {
  return assessMatch({
    queryTerms: query.terms,
    identifiers: query.identifiers,
    text: matchText([row.content, row.tags, row.context, ...row.refs]),
    semanticScore,
    scope: query.scope,
  });
}

/** Keeps the stronger assessment when one memory arrives from two retrievers. */
export function strongerMatch(
  left: MatchAssessment,
  right: MatchAssessment,
): MatchAssessment {
  return matchStrengthRank(right.match_strength) >
    matchStrengthRank(left.match_strength)
    ? right
    : left;
}

function rawString(row: JsonObject, key: string, fallback = ""): string {
  return jsonString(row[key]) ?? fallback;
}

function rawNumber(row: JsonObject, key: string): number | null {
  const value = row[key];
  const numeric = jsonNumber(value);
  if (numeric !== undefined && Number.isInteger(numeric)) {
    return numeric;
  }
  const text = jsonString(value);
  if (text !== undefined && text.trim() !== "") {
    const parsed = Number(text);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

type StatsOldest = { id: number; created_at: string | null; time: number };
type StatsAccumulator = {
  readonly byType: Record<string, number>;
  readonly byCertainty: Record<string, number>;
  readonly tagFrequency: Record<string, number>;
  active: number;
  deprecated: number;
  superseded: number;
  oldest: StatsOldest | null;
  stale: number;
  noTags: number;
};

function createStatsAccumulator(): StatsAccumulator {
  return {
    byType: {},
    byCertainty: {},
    tagFrequency: {},
    active: 0,
    deprecated: 0,
    superseded: 0,
    oldest: null,
    stale: 0,
    noTags: 0,
  };
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function ingestStatus(accumulator: StatsAccumulator, status: string): void {
  accumulator.active += status === "active" ? 1 : 0;
  accumulator.deprecated += status === "deprecated" ? 1 : 0;
  accumulator.superseded += status === "superseded_by" ? 1 : 0;
}

function ingestOldest(accumulator: StatsAccumulator, row: JsonObject): void {
  const createdAt = rawString(row, "created_at") || null;
  const time =
    createdAt === null
      ? Number.POSITIVE_INFINITY
      : (sqliteDateToMs(createdAt) ?? Number.POSITIVE_INFINITY);
  if (accumulator.oldest === null || time < accumulator.oldest.time) {
    accumulator.oldest = {
      id: rawNumber(row, "id") ?? 0,
      created_at: createdAt,
      time,
    };
  }
}

function ingestStatsRow(
  accumulator: StatsAccumulator,
  row: JsonObject,
  now: number,
): void {
  ingestStatus(accumulator, rawString(row, "status", "active"));
  incrementCount(
    accumulator.byType,
    rawString(row, "memory_type", "convention"),
  );
  incrementCount(
    accumulator.byCertainty,
    rawString(row, "certainty", "inferred"),
  );
  const tags = normalizeTags(rawString(row, "tags"));
  accumulator.noTags += tags.length === 0 ? 1 : 0;
  for (const tag of tags) {
    incrementCount(accumulator.tagFrequency, tag);
  }
  ingestOldest(accumulator, row);
  const updatedTime = sqliteDateToMs(rawString(row, "updated_at"));
  accumulator.stale +=
    updatedTime !== null && (now - updatedTime) / 86_400_000 > 90 ? 1 : 0;
}

export function summarizeMemoryStats(
  repository: string,
  rows: readonly JsonObject[],
  now = Date.now(),
): MemoryStatsResult {
  const accumulator = createStatsAccumulator();
  for (const row of rows) {
    ingestStatsRow(accumulator, row, now);
  }
  const oldest = accumulator.oldest;
  return {
    repository,
    total_memories: rows.length,
    active: accumulator.active,
    deprecated: accumulator.deprecated,
    superseded: accumulator.superseded,
    breakdown_by_memory_type: accumulator.byType,
    breakdown_by_certainty: accumulator.byCertainty,
    tag_frequency_map: accumulator.tagFrequency,
    oldest_memory:
      oldest === null ? null : { id: oldest.id, created_at: oldest.created_at },
    memories_not_updated_over_90_days: accumulator.stale,
    memories_with_no_tags: accumulator.noTags,
  };
}

export function contentHead(text: string, maxChars = 120): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > maxChars
    ? `${flattened.slice(0, maxChars)}…`
    : flattened;
}

export type ScoredRankedRow = RankedMemoryRow &
  MatchAssessment & { readonly score: number };

export function scoreMemoryRows(
  rows: readonly FtsRankedMemoryRow[],
  query: MatchQuery,
): ScoredRankedRow[] {
  return rows
    .map((row) => {
      const match = assessRowMatch(row, query);
      const score =
        ftsRankPoints(row.fts_rank) +
        termCoveragePoints(match.term_coverage) +
        exactMatchPoints(match.exact_matches.length) +
        tagMatchPoints(normalizeTags(row.tags), query.terms) +
        recencyPoints(sqliteDateToMs(row.updated_at)) +
        certaintyPoints(row.certainty) +
        updateCountPoints(row.update_count);
      return { ...row, ...match, score: Number(score.toFixed(3)) };
    })
    .sort(
      (left, right) =>
        matchStrengthRank(right.match_strength) -
          matchStrengthRank(left.match_strength) || right.score - left.score,
    );
}

export function scoredResultRow(
  row: MemorySummary & MatchAssessment & { readonly score: number },
): ScoredMemoryRow {
  return {
    id: row.id,
    repository: row.repository,
    content: row.content,
    tags: row.tags,
    context: row.context,
    memory_type: row.memory_type,
    status: row.status,
    certainty: row.certainty,
    evidence: row.evidence,
    validation_gaps: row.validation_gaps,
    score: row.score,
    match_strength: row.match_strength,
    term_coverage: row.term_coverage,
    exact_matches: row.exact_matches,
  };
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

export function uniqueLowerPreserveOrder(values: string[]): string[] {
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

export function embeddingTextForMemory(input: {
  content: string;
  tags: string;
  context: string;
  memory_type: string;
  status: string;
  certainty: string;
}): string {
  return composeEmbeddingText({
    content: input.content,
    tags: input.tags,
    context: input.context,
    memory_type: input.memory_type,
    status: input.status,
    certainty: input.certainty,
  });
}
