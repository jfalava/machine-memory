import { resolve, relative, sep } from "node:path";

import {
  assessMatch,
  buildFtsQuery,
  CLI_LIMIT_MAX,
  certaintyPoints,
  extractTerms,
  mergeSuggestCandidates,
  normalizeSuggestPath,
  SUGGEST_NEIGHBORHOOD_LIMIT,
  reciprocalRankScore,
  RRF_K,
  sqliteDateToMs,
  type FileNeighborhood,
  exactMatchPoints,
  ftsRankPoints,
  MATCH_STRENGTHS,
  matchStrengthRank,
  matchText,
  orderByMatchStrength,
  premiseQuery,
  recencyPoints,
  REVIEW_CANDIDATES_LIMIT,
  reviewsDependents,
  SEARCH_LIMIT_DEFAULT,
  tagMatchPoints,
  termCoveragePoints,
  updateCountPoints,
  type MatchAssessment,
  type MatchScope,
  type MatchStrength,
} from "@machine-memory/contract";
import { Effect, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";

import {
  type CommandFlags,
  getFlagValue,
  hasFlag,
  usageError,
} from "../cli-utils";
import {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type Certainty,
  type CommonFilters,
  type MemoryStatus,
  type MemoryType,
} from "../constants";
import type { MemoryDatabaseApi } from "../effect/database";
import {
  CommandError,
  commandError,
  MemoryDatabaseError,
} from "../effect/errors";
import {
  jsonNumber,
  jsonObject,
  jsonString,
  jsonStringArray,
  parseJson,
  storedStringArray,
  type JsonObject,
  type JsonValue,
} from "../json";
import {
  activeRepositoryOverride,
  repositoryForCurrentDirectory,
} from "../repository";
import {
  parseStoredEvidence,
  parseStoredValidationGaps,
} from "./features/memory/evidence";

export function isMemoryType(value: string): value is MemoryType {
  // SAFETY: MEMORY_TYPES is a const tuple; widening only enables includes().
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

function isCertainty(value: string): value is Certainty {
  // SAFETY: CERTAINTY_LEVELS is a const tuple; widening only enables includes().
  return (CERTAINTY_LEVELS as readonly string[]).includes(value);
}

export function canonicalizeCertainty(raw: string): Certainty | undefined {
  return isCertainty(raw) ? raw : undefined;
}

export function normalizeCertaintyValue(
  value: JsonValue | undefined,
  fallback: Certainty = "inferred",
): Certainty {
  return canonicalizeCertainty(jsonString(value) ?? "") ?? fallback;
}

export function isMemoryStatus(value: string): value is MemoryStatus {
  // SAFETY: MEMORY_STATUSES is a const tuple; widening only enables includes().
  return (MEMORY_STATUSES as readonly string[]).includes(value);
}

export function requireMemoryType(
  flags: CommandFlags,
  flag = "--type",
): MemoryType | undefined {
  const raw = getFlagValue(flags, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (!isMemoryType(raw)) {
    usageError(
      `Invalid memory type '${raw}'. Expected one of: ${MEMORY_TYPES.join(", ")}`,
    );
  }
  return raw;
}

export function requireCertainty(
  flags: CommandFlags,
  flag = "--certainty",
): Certainty | undefined {
  const raw = getFlagValue(flags, flag);
  if (raw === undefined) {
    return undefined;
  }
  const normalized = canonicalizeCertainty(raw);
  if (!normalized) {
    usageError(
      `Invalid certainty '${raw}'. Expected one of: ${CERTAINTY_LEVELS.join(", ")}`,
    );
  }
  return normalized;
}

function requireStatus(
  flags: CommandFlags,
  flag = "--status",
): MemoryStatus | undefined {
  const raw = getFlagValue(flags, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (!isMemoryStatus(raw)) {
    usageError(
      `Invalid status '${raw}'. Expected one of: ${MEMORY_STATUSES.join(", ")}`,
    );
  }
  return raw;
}

export function parseIntegerFlag(
  flags: CommandFlags,
  flag: string,
  options: { allowNullLiteral?: boolean } = {},
): number | null | undefined {
  const raw = getFlagValue(flags, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (options.allowNullLiteral && raw.toLowerCase() === "null") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    usageError(`Invalid integer for ${flag}: ${raw}`);
  }
  return parsed;
}

export function parseResultLimit(
  flags: CommandFlags,
  fallback = SEARCH_LIMIT_DEFAULT,
): number {
  const parsed = parseIntegerFlag(flags, "--limit");
  if (parsed === undefined || parsed === null) {
    return fallback;
  }
  if (parsed < 1 || parsed > CLI_LIMIT_MAX) {
    usageError(`--limit must be an integer between 1 and ${CLI_LIMIT_MAX}`);
  }
  return parsed;
}

export function parseRefsFlag(flags: CommandFlags): string[] | undefined {
  const raw = getFlagValue(flags, "--refs");
  if (raw === undefined) {
    return undefined;
  }
  return parseRefsValue(raw);
}

function parseRefsValue(raw: string): string[] {
  try {
    const parsed = jsonStringArray(parseJson(raw));
    if (parsed === undefined) {
      throw new Error("Expected JSON string array");
    }
    return parsed.slice();
  } catch {
    const fallback = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (fallback.length === 0) {
      usageError(
        "Invalid --refs value. Provide a JSON array (e.g. '[\\\"https://...\\\"]') or comma-separated list.",
      );
    }
    return fallback;
  }
}

export function parseTags(tags: string): string[] {
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function uniqueLowerPreserveOrder(values: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) {
      continue;
    }
    const lowered = cleaned.toLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    unique.push(cleaned);
  }
  return unique;
}

export function mergeTagValues(
  explicitTags: string | undefined,
  mappedTags: string[],
) {
  const merged = uniqueLowerPreserveOrder([
    ...parseTags(explicitTags ?? ""),
    ...mappedTags,
  ]);
  return merged.join(",");
}

export function parseContentFromFileFlag(
  flags: CommandFlags,
  fileSystem: FileSystem,
): Effect.Effect<string | undefined, CommandError> {
  const path = getFlagValue(flags, "--from-file");
  if (path === undefined) {
    return Effect.void.pipe(Effect.as(undefined));
  }
  const resolvedPath = resolve(process.cwd(), path);
  return Effect.gen(function* () {
    if (!(yield* fileSystem.exists(resolvedPath))) {
      return yield* new CommandError({
        message: `File not found: ${path}`,
        command: "cli",
        cause: undefined,
      });
    }
    const bytes = yield* fileSystem.readFile(resolvedPath);
    return new TextDecoder().decode(bytes);
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(CommandError)(cause)
        ? cause
        : new CommandError({
            message: `Unable to read file: ${path}`,
            command: "cli",
            cause,
          }),
    ),
  );
}

export function stringValue(
  value: JsonValue | undefined,
  fallback = "",
): string {
  return jsonString(value) ?? fallback;
}

export function normalizeSqliteRow(row: JsonValue | undefined): JsonObject {
  const next = jsonObject(row) ?? {};
  next.refs = storedStringArray(next.refs);
  next.certainty = normalizeCertaintyValue(next.certainty);
  next.evidence = parseStoredEvidence(next.evidence);
  next.validation_gaps = parseStoredValidationGaps(next.validation_gaps);
  if (next.update_count !== undefined) {
    next.update_count = Number(next.update_count ?? 0);
  }
  if (next.superseded_by !== undefined && next.superseded_by !== null) {
    next.superseded_by = Number(next.superseded_by);
  }
  if (
    next.expires_after_days !== undefined &&
    next.expires_after_days !== null
  ) {
    next.expires_after_days = Number(next.expires_after_days);
  }
  return next;
}

/** Reported as `score_weights` for `query --hybrid --explain-score`. */
export const HYBRID_FUSION = {
  method: "reciprocal_rank",
  k: RRF_K,
} as const;

export type ScoreBreakdown = {
  fts_rank: number;
  term_coverage: number;
  exact_match: number;
  tag_match: number;
  recency: number;
  certainty: number;
  update_count: number;
  total: number;
};

/** Query terms plus literal identifiers used for absolute match strength. */
export type SearchMatchQuery = {
  terms: string[];
  identifiers: string[];
  scope?: MatchScope;
};

type ScoreRowsOptions = {
  explainScore?: boolean;
  identifiers?: string[];
  scope?: MatchScope;
};

export function assessRowMatch(
  row: JsonObject,
  query: SearchMatchQuery,
  semanticScore?: number,
): MatchAssessment {
  return assessMatch({
    queryTerms: query.terms,
    identifiers: query.identifiers,
    text: matchText([
      stringValue(row.content),
      stringValue(row.tags),
      stringValue(row.context),
      ...storedStringArray(row.refs),
    ]),
    semanticScore,
    scope: query.scope,
  });
}

function matchFields(match: MatchAssessment): JsonObject {
  return {
    match_strength: match.match_strength,
    term_coverage: match.term_coverage,
    exact_matches: [...match.exact_matches],
  };
}

/** Re-labels final rows against one query, using raw semantic similarity when present. */
export function annotateMatches(
  rows: JsonObject[],
  query: SearchMatchQuery,
): JsonObject[] {
  return rows.map((row) => ({
    ...row,
    ...matchFields(assessRowMatch(row, query, jsonNumber(row.semantic_score))),
  }));
}

export function hasStrongMatchRow(rows: JsonObject[]): boolean {
  return rows.some((row) => row.match_strength === "strong");
}

function rowMatchStrength(row: JsonObject): MatchStrength {
  const value = jsonString(row.match_strength);
  return MATCH_STRENGTHS.find((strength) => strength === value) ?? "none";
}

export function orderRowsByMatchStrength(rows: JsonObject[]): JsonObject[] {
  return orderByMatchStrength(
    rows.map((row) => ({ row, match_strength: rowMatchStrength(row) })),
  ).map((entry) => entry.row);
}

function scoreBreakdown(
  row: JsonObject,
  queryTokens: string[],
  match: MatchAssessment,
): ScoreBreakdown {
  const ftsRank = ftsRankPoints(jsonNumber(row.fts_rank) ?? 0);
  const termCoverage = termCoveragePoints(match.term_coverage);
  const exactMatch = exactMatchPoints(match.exact_matches.length);
  const tagMatch = tagMatchPoints(
    parseTags(stringValue(row.tags)),
    queryTokens,
  );
  const recency = recencyPoints(sqliteDateToMs(stringValue(row.updated_at)));
  const certainty = certaintyPoints(
    normalizeCertaintyValue(row.certainty, "speculative"),
  );
  const updateCount = updateCountPoints(jsonNumber(row.update_count) ?? 0);
  const total = Number(
    (
      ftsRank +
      termCoverage +
      exactMatch +
      tagMatch +
      recency +
      certainty +
      updateCount
    ).toFixed(3),
  );
  return {
    fts_rank: ftsRank,
    term_coverage: termCoverage,
    exact_match: exactMatch,
    tag_match: tagMatch,
    recency,
    certainty,
    update_count: updateCount,
    total,
  };
}

export function scoreRowsWithDetails(
  rows: JsonValue[],
  queryTokens: string[],
  options: ScoreRowsOptions = {},
): JsonObject[] {
  const query = {
    terms: queryTokens,
    identifiers: options.identifiers ?? [],
    scope: options.scope,
  };
  const normalized = rows.map((row) => normalizeSqliteRow(row));
  const withScore = normalized.map((row) => {
    const match = assessRowMatch(row, query);
    const breakdown = scoreBreakdown(row, queryTokens, match);
    const scored =
      jsonObject({
        ...row,
        ...matchFields(match),
        score: breakdown.total,
      }) ?? {};
    if (options.explainScore) {
      Object.assign(scored, { score_breakdown: breakdown });
    }
    return scored;
  });
  withScore.sort(
    (a, b) =>
      matchStrengthRank(rowMatchStrength(b)) -
        matchStrengthRank(rowMatchStrength(a)) ||
      Number(b.score) - Number(a.score),
  );
  return withScore.map((row) => {
    const rest = jsonObject({ ...row }) ?? {};
    delete rest["fts_rank"];
    return rest;
  });
}

function rowId(row: JsonObject): string {
  return jsonString(row.id) ?? jsonNumber(row.id)?.toString() ?? "";
}

type FusedRow = {
  row: JsonObject;
  ftsRank?: number;
  semanticRank?: number;
  score: number;
};

function rankBreakdown(rank: number | undefined): JsonObject {
  return rank === undefined
    ? { rank: null, contribution: 0 }
    : { rank: rank + 1, contribution: reciprocalRankScore(rank) };
}

/**
 * Reciprocal-rank fusion, as the API's product query does: each retriever adds
 * 1 / (k + rank), so ranks are compared instead of unrelated score scales.
 */
export function combineHybridResults(
  ftsResults: JsonObject[],
  semanticResults: JsonObject[],
  limit: number,
  explainScore = false,
  matchQuery?: SearchMatchQuery,
): JsonObject[] {
  const byId = new Map<string, FusedRow>();
  for (const [rank, row] of ftsResults.entries()) {
    byId.set(rowId(row), {
      row,
      ftsRank: rank,
      score: reciprocalRankScore(rank),
    });
  }
  for (const [rank, row] of semanticResults.entries()) {
    const existing = byId.get(rowId(row));
    byId.set(rowId(row), {
      row: existing?.row ?? row,
      ftsRank: existing?.ftsRank,
      semanticRank: rank,
      score: (existing?.score ?? 0) + reciprocalRankScore(rank),
    });
  }
  const semanticById = new Map(
    semanticResults.map((row) => [rowId(row), row] as const),
  );
  const combined = [...byId.entries()]
    .sort(
      ([leftId, left], [rightId, right]) =>
        right.score - left.score || Number(leftId) - Number(rightId),
    )
    .map(([id, fused]) => {
      const ftsScore =
        fused.ftsRank === undefined ? 0 : Number(fused.row.score ?? 0);
      const row: JsonObject = {
        ...fused.row,
        score: fused.score,
        fts_score: Number(ftsScore.toFixed(3)),
        semantic_score: Number(
          Number(semanticById.get(id)?.semantic_score ?? 0).toFixed(6),
        ),
        hybrid_score: fused.score,
      };
      delete row["score_breakdown"];
      if (explainScore) {
        row.score_breakdown = {
          fts: rankBreakdown(fused.ftsRank),
          semantic: rankBreakdown(fused.semanticRank),
          total: fused.score,
        };
      }
      return row;
    });
  if (matchQuery === undefined) {
    return combined.slice(0, limit);
  }
  return orderRowsByMatchStrength(annotateMatches(combined, matchQuery)).slice(
    0,
    limit,
  );
}

export function sortByScoreThenRecency(rows: JsonObject[]): JsonObject[] {
  const indexed = rows.map((row, index) => ({
    index,
    row,
    score: Number(row.score ?? 0),
    updatedAt: sqliteDateToMs(stringValue(row.updated_at)) ?? 0,
  }));
  indexed.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.index - right.index;
  });
  return indexed.map((entry) => entry.row);
}

export function parseCommonFilters(flags: CommandFlags): CommonFilters {
  return {
    tag: getFlagValue(flags, "--tags"),
    memoryType: requireMemoryType(flags),
    certainty: requireCertainty(flags),
    status: requireStatus(flags),
    includeDeprecated: hasFlag(flags, "--include-deprecated"),
  };
}

export type { OutputMode } from "./runtime/output";
export {
  hasMinimalOutput,
  minimalResultSummary,
  parseOutputMode,
  printBriefLines,
  queryEmptyResultPayload,
} from "./runtime/output";

function appendCertaintyFilter(
  clauses: string[],
  params: (string | number)[],
  certainty: Certainty,
  prefix: string,
) {
  clauses.push(`${prefix}certainty = ?`);
  params.push(certainty);
}

function appendStatusFilter(
  clauses: string[],
  params: (string | number)[],
  filters: CommonFilters,
  prefix: string,
  defaultActiveOnly: boolean,
) {
  if (filters.status) {
    clauses.push(`${prefix}status = ?`);
    params.push(filters.status);
    return;
  }
  if (defaultActiveOnly && !filters.includeDeprecated) {
    clauses.push(`${prefix}status = 'active'`);
  }
}

export function applySqlFilters(
  clauses: string[],
  params: (string | number)[],
  filters: CommonFilters,
  options: { defaultActiveOnly?: boolean; columnPrefix?: string } = {},
) {
  const prefix = options.columnPrefix ?? "";
  clauses.push(`${prefix}repository = ?`);
  params.push(repositoryForCurrentDirectory());
  if (filters.tag) {
    clauses.push(`${prefix}tags LIKE ?`);
    params.push(`%${filters.tag}%`);
  }
  if (filters.memoryType) {
    clauses.push(`${prefix}memory_type = ?`);
    params.push(filters.memoryType);
  }
  if (filters.certainty) {
    appendCertaintyFilter(clauses, params, filters.certainty, prefix);
  }
  appendStatusFilter(
    clauses,
    params,
    filters,
    prefix,
    options.defaultActiveOnly ?? true,
  );
}

export function getMemoryById(
  database: MemoryDatabaseApi,
  id: number,
): Effect.Effect<JsonObject | null, MemoryDatabaseError> {
  return database
    .get("SELECT * FROM memories WHERE repository = ? AND id = ?", [
      repositoryForCurrentDirectory(),
      id,
    ])
    .pipe(Effect.map((row) => (row ? normalizeSqliteRow(row) : null)));
}

export function findMemoryByMatch(
  database: MemoryDatabaseApi,
  query: string,
): Effect.Effect<JsonObject | null, MemoryDatabaseError> {
  const terms = extractTerms(query);
  const ftsQuery = buildFtsQuery(terms);
  if (!ftsQuery) {
    return Effect.succeed(null);
  }
  return database
    .all(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ?
         AND m.repository = ?
         AND m.status = 'active'
       ORDER BY bm25(memories_fts)
       LIMIT 5`,
      [ftsQuery, repositoryForCurrentDirectory()],
    )
    .pipe(Effect.map((rows) => scoreRowsWithDetails(rows, terms)[0] ?? null));
}

export function detectPotentialConflicts(
  database: MemoryDatabaseApi,
  payload: { content: string; tags?: string; context?: string },
  options: { excludeId?: number; limit?: number } = {},
): Effect.Effect<JsonObject[], MemoryDatabaseError> {
  const terms = extractTerms(
    [payload.content, payload.tags ?? "", payload.context ?? ""].join(" "),
  );
  const ftsQuery = buildFtsQuery(terms);
  if (!ftsQuery) {
    return Effect.succeed([]);
  }

  const clauses = [
    "memories_fts MATCH ?",
    "m.repository = ?",
    "m.status = 'active'",
  ];
  const params: (string | number)[] = [
    ftsQuery,
    repositoryForCurrentDirectory(),
  ];
  if (options.excludeId !== undefined) {
    clauses.push("m.id != ?");
    params.push(options.excludeId);
  }

  return database
    .all(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY bm25(memories_fts)
       LIMIT ${Number(options.limit ?? 5)}`,
      params,
    )
    .pipe(Effect.map((rows) => scoreRowsWithDetails(rows, terms)));
}

/**
 * Active records that may rely on a changed or retired premise. A shared
 * literal identifier makes a candidate strong; broad term overlap is weak.
 */
export function findReviewCandidates(
  database: MemoryDatabaseApi,
  premises: JsonObject[],
  alsoExclude: number[] = [],
): Effect.Effect<JsonObject[], MemoryDatabaseError> {
  const excluded = new Set([
    ...premises.map((premise) => Number(premise.id)),
    ...alsoExclude,
  ]);
  const durable = premises.filter((premise) => {
    const memoryType = stringValue(premise.memory_type, "convention");
    return isMemoryType(memoryType) && reviewsDependents(memoryType);
  });
  return Effect.forEach(durable, (premise) => {
    const query = premiseQuery(stringValue(premise.content));
    const terms = extractTerms(query.leadingText);
    const ftsQuery = buildFtsQuery(terms);
    if (!ftsQuery) {
      return Effect.succeed<JsonObject[]>([]);
    }
    return database
      .all(
        `SELECT m.*, bm25(memories_fts) AS fts_rank
         FROM memories m
         JOIN memories_fts ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.repository = ? AND m.status = 'active'
         ORDER BY bm25(memories_fts)
         LIMIT 20`,
        [ftsQuery, repositoryForCurrentDirectory()],
      )
      .pipe(
        Effect.map((rows) =>
          scoreRowsWithDetails(rows, terms, {
            identifiers: query.identifiers,
            scope: "files",
          }),
        ),
      );
  }).pipe(
    Effect.map((groups) => {
      const byId = new Map<number, JsonObject>();
      for (const row of groups.flat()) {
        const id = Number(row.id);
        if (
          !excluded.has(id) &&
          !byId.has(id) &&
          row.match_strength !== "none"
        ) {
          byId.set(id, row);
        }
      }
      return orderRowsByMatchStrength([...byId.values()]).slice(
        0,
        REVIEW_CANDIDATES_LIMIT,
      );
    }),
  );
}

/**
 * A mistyped --repo would silently start a new namespace, so creating records
 * there requires --allow-new-repo until the repository has memories.
 */
export function assertWritableRepository(
  database: MemoryDatabaseApi,
  command: string,
): Effect.Effect<void, MemoryDatabaseError | CommandError> {
  const override = activeRepositoryOverride();
  if (override === undefined || override.allowNew) {
    return Effect.void;
  }
  return database
    .get("SELECT 1 AS found FROM memories WHERE repository = ? LIMIT 1", [
      override.slug,
    ])
    .pipe(
      Effect.flatMap((row) =>
        row
          ? Effect.void
          : Effect.fail(
              commandError(
                command,
                `Repository '${override.slug}' has no memories. Check the --repo slug, or pass --allow-new-repo to start it.`,
              ),
            ),
      ),
    );
}

export function collectDirectoriesEffect(
  rootPath: string,
  fileSystem: FileSystem,
): Effect.Effect<string[], CommandError> {
  const directories: string[] = [];
  const ignoreNames = new Set([
    ".git",
    ".agents",
    "node_modules",
    "dist",
    ".next",
    ".turbo",
    ".idea",
    ".vscode",
  ]);

  return Effect.gen(function* () {
    const walk = (current: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const entries = yield* fileSystem.readDirectory(current);
        for (const name of entries) {
          if (ignoreNames.has(name) || name.startsWith(".")) {
            continue;
          }
          const child = resolve(current, name);
          const info = yield* fileSystem.stat(child);
          if (info.type !== "Directory") {
            continue;
          }
          const rel = relative(rootPath, child).split(sep).join("/");
          directories.push(`${rel}/`);
          yield* walk(child);
        }
      });
    if (
      (yield* fileSystem.exists(rootPath)) &&
      (yield* fileSystem.stat(rootPath)).type === "Directory"
    ) {
      yield* walk(rootPath);
    }
    directories.sort();
    return directories;
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(CommandError)(cause)
        ? cause
        : new CommandError({
            message: "Unable to inspect project directories.",
            command: "coverage",
            cause,
          }),
    ),
  );
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function parseFileList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => normalizeSuggestPath(item))
    .filter(Boolean);
}

function parseFileListJson(raw: string): string[] {
  try {
    const parsed = jsonStringArray(parseJson(raw));
    if (parsed === undefined) {
      throw new Error("Expected JSON string array");
    }
    return parsed.map((item) => normalizeSuggestPath(item)).filter(Boolean);
  } catch {
    usageError(
      'Invalid --files-json value. Provide a JSON array of paths, e.g. --files-json \'["src/a.ts","src/b.ts"]\'.',
    );
  }
}

export function parseSuggestFiles(flags: CommandFlags): string[] {
  const filesRaw = getFlagValue(flags, "--files");
  const filesJsonRaw = getFlagValue(flags, "--files-json");
  if (!filesRaw && !filesJsonRaw) {
    usageError(
      'Usage: suggest --files "src/auth/jwt.ts,src/middleware/session.ts" OR --files-json \'["src/auth/jwt.ts","src/middleware/session.ts"]\'',
    );
  }
  if (filesRaw && filesJsonRaw) {
    usageError("Use either --files or --files-json, not both.");
  }
  const parsed = filesJsonRaw
    ? parseFileListJson(filesJsonRaw)
    : parseFileList(filesRaw ?? "");
  return uniquePreserveOrder(parsed);
}

export function parseIdSpec(raw: string): number[] {
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.length === 0) {
    usageError(`Invalid id: ${raw}`);
  }
  const parsed = values.map((entry) => Number(entry));
  if (parsed.some((id) => !Number.isInteger(id) || id <= 0)) {
    usageError(`Invalid id list: ${raw}`);
  }
  return uniqueLowerPreserveOrder(parsed.map((id) => String(id))).map((id) =>
    Number(id),
  );
}

export function queryNeighborhoodMatches(
  database: MemoryDatabaseApi,
  neighborhood: FileNeighborhood,
  filters: CommonFilters,
  limit = SUGGEST_NEIGHBORHOOD_LIMIT,
): Effect.Effect<JsonObject[], MemoryDatabaseError> {
  const orClauses: string[] = [];
  const params: (string | number)[] = [];

  for (const tagHint of neighborhood.tagHints.slice(0, 10)) {
    orClauses.push("INSTR(LOWER(m.tags), ?) > 0");
    params.push(tagHint.toLowerCase());
  }
  for (const pathHint of neighborhood.pathHints.slice(0, 10)) {
    const lowered = pathHint.toLowerCase();
    orClauses.push("INSTR(LOWER(m.content), ?) > 0");
    params.push(lowered);
    orClauses.push("INSTR(LOWER(m.context), ?) > 0");
    params.push(lowered);
    orClauses.push("INSTR(LOWER(m.refs), ?) > 0");
    params.push(lowered);
  }
  if (orClauses.length === 0) {
    return Effect.succeed([]);
  }

  const clauses = [`(${orClauses.join(" OR ")})`];
  applySqlFilters(clauses, params, filters, {
    defaultActiveOnly: true,
    columnPrefix: "m.",
  });
  return database
    .all(
      `SELECT m.*, 0 AS fts_rank
       FROM memories m
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT ${limit}`,
      params,
    )
    .pipe(Effect.map((rows) => scoreRowsWithDetails(rows, neighborhood.terms)));
}

/** Wraps contract's suggest merge; a boosted row's score breakdown no longer adds up. */
export function mergeSuggestionResults(
  primary: JsonObject[],
  secondary: JsonObject[],
): JsonObject[] {
  const scored = (rows: JsonObject[]) =>
    rows.map((row) => ({
      id: Number(row.id),
      score: Number(row.score ?? 0),
      row,
    }));
  return mergeSuggestCandidates(scored(primary), scored(secondary)).map(
    ({ score, row }) => {
      if (score === Number(row.score ?? 0)) {
        return row;
      }
      const merged: JsonObject = { ...row, score };
      delete merged.score_breakdown;
      return merged;
    },
  );
}

export function findStatusCascadeCandidates(
  database: MemoryDatabaseApi,
  tags: string,
  excludeId: number,
): Effect.Effect<JsonObject[], MemoryDatabaseError> {
  const tagSet = new Set(parseTags(tags).map((tag) => tag.toLowerCase()));
  if (tagSet.size === 0) {
    return Effect.succeed([]);
  }
  return database
    .all(
      `SELECT * FROM memories
       WHERE repository = ?
         AND status = 'active'
         AND memory_type = 'status'
         AND id != ?
       ORDER BY updated_at DESC, id DESC`,
      [repositoryForCurrentDirectory(), excludeId],
    )
    .pipe(
      Effect.map((rows) =>
        rows
          .map((row) => normalizeSqliteRow(row))
          .filter((row) => {
            const memoryTags = parseTags(stringValue(row.tags)).map((tag) =>
              tag.toLowerCase(),
            );
            return memoryTags.some((tag) => tagSet.has(tag));
          }),
      ),
    );
}

export function parseSinceDate(flags: CommandFlags): string | undefined {
  const value = getFlagValue(flags, "--since");
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    usageError(`Invalid --since date: ${value}`);
  }
  return value;
}

export function sqliteDateForComparison(isoLike: string): string {
  const ms = Date.parse(isoLike);
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
