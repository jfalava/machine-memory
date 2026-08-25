import { Effect } from "effect";
import {
  resolve,
  relative,
  sep,
  dirname as pathDirname,
  extname,
} from "node:path";
import type { FileSystem } from "effect/FileSystem";
import { getFlagValue, hasFlag, usageError } from "../cli-utils";
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
import { CommandError, MemoryDatabaseError } from "../effect/errors";
import {
  jsonNumber,
  jsonObject,
  jsonString,
  jsonStringArray,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../json";
import { repositoryForCurrentDirectory } from "../repository";

export function isMemoryType(value: string): value is MemoryType {
  // SAFETY: MEMORY_TYPES is a const tuple; widening only enables includes().
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

function isCertainty(value: string): value is Certainty {
  // SAFETY: CERTAINTY_LEVELS is a const tuple; widening only enables includes().
  return (CERTAINTY_LEVELS as readonly string[]).includes(value);
}

export function canonicalizeCertainty(raw: string): Certainty | undefined {
  if (isCertainty(raw)) {
    return raw;
  }
  switch (raw) {
    case "hard":
      return "verified";
    case "soft":
      return "inferred";
    case "uncertain":
      return "speculative";
    default:
      return undefined;
  }
}

function certaintyStorageVariants(certainty: Certainty): string[] {
  switch (certainty) {
    case "verified":
      return ["verified", "hard"];
    case "inferred":
      return ["inferred", "soft"];
    case "speculative":
      return ["speculative", "uncertain"];
    default:
      return [certainty];
  }
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
  args: string[],
  flag = "--type",
): MemoryType | undefined {
  const raw = getFlagValue(args, flag);
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
  args: string[],
  flag = "--certainty",
): Certainty | undefined {
  const raw = getFlagValue(args, flag);
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
  args: string[],
  flag = "--status",
): MemoryStatus | undefined {
  const raw = getFlagValue(args, flag);
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
  args: string[],
  flag: string,
  options: { allowNullLiteral?: boolean } = {},
): number | null | undefined {
  const raw = getFlagValue(args, flag);
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

export function parseResultLimit(args: string[], fallback = 8): number {
  const parsed = parseIntegerFlag(args, "--limit");
  if (parsed === undefined || parsed === null) {
    return fallback;
  }
  if (parsed < 1 || parsed > 100) {
    usageError("--limit must be an integer between 1 and 100");
  }
  return parsed;
}

export function parseRefsFlag(args: string[]): string[] | undefined {
  const raw = getFlagValue(args, "--refs");
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

export function collectPositionalArgs(
  args: string[],
  flagsWithValues: readonly string[],
): string[] {
  const flags = new Set(flagsWithValues);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) {
      continue;
    }
    if (flags.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      continue;
    }
    positional.push(token);
  }
  return positional;
}

export function parseContentFromFileFlag(
  args: string[],
  fileSystem: FileSystem,
): Effect.Effect<string | undefined, CommandError> {
  const path = getFlagValue(args, "--from-file");
  if (path === undefined) {
    return Effect.succeed(undefined);
  }
  const resolvedPath = resolve(process.cwd(), path);
  return Effect.gen(function* () {
    if (!(yield* fileSystem.exists(resolvedPath))) {
      return yield* Effect.fail(
        new CommandError({
          message: `File not found: ${path}`,
          command: "cli",
          cause: undefined,
        }),
      );
    }
    const bytes = yield* fileSystem.readFile(resolvedPath);
    return new TextDecoder().decode(bytes);
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof CommandError
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
  next.refs = parseStoredRefs(next.refs);
  next.certainty = normalizeCertaintyValue(next.certainty);
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

export function parseStoredRefs(value: JsonValue | undefined): string[] {
  const array = jsonStringArray(value);
  if (array !== undefined) {
    return array;
  }
  const raw = jsonString(value);
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  try {
    return jsonStringArray(parseJson(raw)) ?? [];
  } catch {
    return [];
  }
}

export function sqliteDateToMs(value: JsonValue | undefined): number | null {
  const raw = jsonString(value);
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const normalized = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

export function extractTerms(input: string): string[] {
  const stopwords = new Set([
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
    "src",
    "lib",
    "app",
    "test",
    "tests",
  ]);

  const tokens = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 2 && !stopwords.has(token),
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

export function buildFtsQueryFromTerms(terms: string[]): string | undefined {
  const usable = terms.filter((term) => term.length > 0).slice(0, 12);
  if (usable.length === 0) {
    return undefined;
  }
  return usable.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export const SCORE_COMPONENT_WEIGHTS = {
  recency: { maxPoints: 30, maxAgeDays: 180 },
  certainty: { verified: 20, inferred: 10, speculative: 2 },
  tagMatch: { exact: 18, partial: 8 },
  updateCount: { maxUpdatesCounted: 10, pointsPerUpdate: 2 },
  ftsRank: { multiplier: -10, minPoints: 0, maxPoints: 30 },
} as const;

export const HYBRID_SCORE_WEIGHTS = {
  fts: 0.55,
  semantic: 0.45,
  scale: 100,
} as const;

export type ScoreBreakdown = {
  recency: number;
  certainty: number;
  tag_match: number;
  update_count: number;
  fts_rank: number;
  total: number;
};

type ScoreRowsOptions = {
  explainScore?: boolean;
};

function certaintyWeight(certainty: JsonValue | undefined): number {
  const normalized = normalizeCertaintyValue(certainty, "speculative");
  if (normalized === "verified") {
    return SCORE_COMPONENT_WEIGHTS.certainty.verified;
  }
  if (normalized === "inferred") {
    return SCORE_COMPONENT_WEIGHTS.certainty.inferred;
  }
  return SCORE_COMPONENT_WEIGHTS.certainty.speculative;
}

function recencyWeight(updatedAt: JsonValue | undefined): number {
  const ms = sqliteDateToMs(updatedAt);
  if (ms === null) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - ms) / (1000 * 60 * 60 * 24));
  const capped = Math.min(ageDays, SCORE_COMPONENT_WEIGHTS.recency.maxAgeDays);
  return Number(
    (
      SCORE_COMPONENT_WEIGHTS.recency.maxPoints *
      (1 - capped / SCORE_COMPONENT_WEIGHTS.recency.maxAgeDays)
    ).toFixed(3),
  );
}

function tagExactnessWeight(
  tags: JsonValue | undefined,
  queryTokens: string[],
): number {
  const rawTags = jsonString(tags);
  if (rawTags === undefined || queryTokens.length === 0) {
    return 0;
  }
  const tagList = parseTags(rawTags).map((tag) => tag.toLowerCase());
  const tokenSet = new Set(queryTokens.map((token) => token.toLowerCase()));
  if (tagList.some((tag) => tokenSet.has(tag))) {
    return SCORE_COMPONENT_WEIGHTS.tagMatch.exact;
  }
  if (tagList.some((tag) => queryTokens.some((token) => tag.includes(token)))) {
    return SCORE_COMPONENT_WEIGHTS.tagMatch.partial;
  }
  return 0;
}

function updateCountWeight(updateCount: JsonValue | undefined): number {
  const count = jsonNumber(updateCount) ?? 0;
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return (
    Math.min(count, SCORE_COMPONENT_WEIGHTS.updateCount.maxUpdatesCounted) *
    SCORE_COMPONENT_WEIGHTS.updateCount.pointsPerUpdate
  );
}

function ftsWeight(ftsRank: JsonValue | undefined): number {
  const rank = jsonNumber(ftsRank) ?? 0;
  if (!Number.isFinite(rank)) {
    return 0;
  }
  const transformed = Math.max(
    SCORE_COMPONENT_WEIGHTS.ftsRank.minPoints,
    Math.min(
      SCORE_COMPONENT_WEIGHTS.ftsRank.maxPoints,
      rank * SCORE_COMPONENT_WEIGHTS.ftsRank.multiplier,
    ),
  );
  return Number(transformed.toFixed(3));
}

function scoreBreakdown(
  row: JsonObject,
  queryTokens: string[],
): ScoreBreakdown {
  const recency = recencyWeight(row.updated_at);
  const tagMatch = tagExactnessWeight(row.tags, queryTokens);
  const updateCount = updateCountWeight(row.update_count);
  const certainty = certaintyWeight(row.certainty);
  const ftsRank = ftsWeight(row.fts_rank);
  const total = Number(
    (recency + tagMatch + updateCount + certainty + ftsRank).toFixed(3),
  );
  return {
    recency,
    certainty,
    tag_match: tagMatch,
    update_count: updateCount,
    fts_rank: ftsRank,
    total,
  };
}

export function scoreRowsWithDetails(
  rows: JsonValue[],
  queryTokens: string[],
  options: ScoreRowsOptions = {},
): JsonObject[] {
  const normalized = rows.map((row) => normalizeSqliteRow(row));
  const withScore = normalized.map((row) => {
    const breakdown = scoreBreakdown(row, queryTokens);
    const scored =
      jsonObject({
        ...row,
        score: breakdown.total,
      }) ?? {};
    if (options.explainScore) {
      Object.assign(scored, { score_breakdown: breakdown });
    }
    return scored;
  });
  withScore.sort((a, b) => Number(b.score) - Number(a.score));
  return withScore.map((row) => {
    const rest = jsonObject({ ...row }) ?? {};
    delete rest["fts_rank"];
    return rest;
  });
}

function normalizeHybridComponent(value: number, values: number[]): number {
  const finiteValues = values.filter((candidate) => Number.isFinite(candidate));
  if (finiteValues.length === 0 || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const max = Math.max(...finiteValues);
  const min = Math.min(...finiteValues);
  if (max <= 0) {
    return 0;
  }
  if (max === min) {
    return 1;
  }
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function combineHybridResults(
  ftsResults: JsonObject[],
  semanticResults: JsonObject[],
  limit: number,
  explainScore = false,
): JsonObject[] {
  const ftsById = new Map(
    ftsResults.map(
      (row) =>
        [
          jsonString(row.id) ?? jsonNumber(row.id)?.toString() ?? "",
          row,
        ] as const,
    ),
  );
  const semanticById = new Map(
    semanticResults.map(
      (row) =>
        [
          jsonString(row.id) ?? jsonNumber(row.id)?.toString() ?? "",
          row,
        ] as const,
    ),
  );
  const ids = [...new Set([...ftsById.keys(), ...semanticById.keys()])];
  const ftsValues = ids.map((id) => Number(ftsById.get(id)?.score ?? 0));
  const semanticValues = ids.map((id) =>
    Number(semanticById.get(id)?.semantic_score ?? 0),
  );

  const combined = ids.map((id) => {
    const ftsRow = ftsById.get(id);
    const semanticRow = semanticById.get(id);
    const ftsScore = Number(ftsRow?.score ?? 0);
    const semanticScore = Number(semanticRow?.semantic_score ?? 0);
    const normalizedFts = normalizeHybridComponent(ftsScore, ftsValues);
    const normalizedSemantic = normalizeHybridComponent(
      semanticScore,
      semanticValues,
    );
    const ftsContribution =
      normalizedFts * HYBRID_SCORE_WEIGHTS.fts * HYBRID_SCORE_WEIGHTS.scale;
    const semanticContribution =
      normalizedSemantic *
      HYBRID_SCORE_WEIGHTS.semantic *
      HYBRID_SCORE_WEIGHTS.scale;
    const hybridScore = Number(
      (ftsContribution + semanticContribution).toFixed(3),
    );
    const row =
      jsonObject({
        ...(ftsRow ?? semanticRow),
        score: hybridScore,
        fts_score: Number(ftsScore.toFixed(3)),
        semantic_score: Number(semanticScore.toFixed(6)),
        hybrid_score: hybridScore,
      }) ?? {};
    delete row["score_breakdown"];
    if (explainScore) {
      Object.assign(row, {
        score_breakdown: {
          fts: {
            raw: Number(ftsScore.toFixed(3)),
            normalized: Number(normalizedFts.toFixed(6)),
            weight: HYBRID_SCORE_WEIGHTS.fts,
            contribution: Number(ftsContribution.toFixed(3)),
          },
          semantic: {
            raw: Number(semanticScore.toFixed(6)),
            normalized: Number(normalizedSemantic.toFixed(6)),
            weight: HYBRID_SCORE_WEIGHTS.semantic,
            contribution: Number(semanticContribution.toFixed(3)),
          },
          total: hybridScore,
        },
      });
    }
    return row;
  });

  return sortByScoreThenRecency(combined).slice(0, limit);
}

export function sortByScoreThenRecency(rows: JsonObject[]): JsonObject[] {
  const indexed = rows.map((row, index) => ({
    index,
    row,
    score: Number(row.score ?? 0),
    updatedAt: sqliteDateToMs(row.updated_at) ?? 0,
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

export function parseCommonFilters(args: string[]): CommonFilters {
  return {
    tag: getFlagValue(args, "--tags"),
    memoryType: requireMemoryType(args),
    certainty: requireCertainty(args),
    status: requireStatus(args),
    includeDeprecated: hasFlag(args, "--include-deprecated"),
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
  const variants = certaintyStorageVariants(certainty);
  if (variants.length === 1) {
    clauses.push(`${prefix}certainty = ?`);
    params.push(variants[0] ?? certainty);
    return;
  }
  clauses.push(`${prefix}certainty IN (${variants.map(() => "?").join(", ")})`);
  for (const variant of variants) {
    params.push(variant);
  }
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
  const ftsQuery = buildFtsQueryFromTerms(terms);
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
  const ftsQuery = buildFtsQueryFromTerms(terms);
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

export function findExactDuplicate(
  database: MemoryDatabaseApi,
  payload: { content: string; tags?: string; context?: string },
): Effect.Effect<JsonObject | null, MemoryDatabaseError> {
  return database
    .get(
      `SELECT * FROM memories
       WHERE repository = ?
         AND status = 'active'
         AND content = ?
         AND tags = ?
         AND context = ?
       LIMIT 1`,
      [
        repositoryForCurrentDirectory(),
        payload.content,
        payload.tags ?? "",
        payload.context ?? "",
      ],
    )
    .pipe(Effect.map((row) => (row ? normalizeSqliteRow(row) : null)));
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
      cause instanceof CommandError
        ? cause
        : new CommandError({
            message: "Unable to inspect project directories.",
            command: "coverage",
            cause,
          }),
    ),
  );
}

export function extractPathTermsFromFiles(paths: string[]): string[] {
  const terms: string[] = [];
  for (const path of paths) {
    const normalized = normalizeFilePathInput(path);
    const segments = normalized.split("/").filter(Boolean);
    for (const segment of segments) {
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

export function normalizeFilePathInput(value: string): string {
  const cleaned = value.trim().replaceAll("\\", "/");
  if (!cleaned) {
    return "";
  }
  const withoutDotPrefix = cleaned.replace(/^\.\/+/, "");
  return withoutDotPrefix.replace(/\/{2,}/g, "/");
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
    .map((item) => normalizeFilePathInput(item))
    .filter(Boolean);
}

function parseFileListJson(raw: string): string[] {
  try {
    const parsed = jsonStringArray(parseJson(raw));
    if (parsed === undefined) {
      throw new Error("Expected JSON string array");
    }
    return parsed.map((item) => normalizeFilePathInput(item)).filter(Boolean);
  } catch {
    usageError(
      'Invalid --files-json value. Provide a JSON array of paths, e.g. --files-json \'["src/a.ts","src/b.ts"]\'.',
    );
  }
}

export function parseSuggestFiles(args: string[]): string[] {
  const filesRaw = getFlagValue(args, "--files");
  const filesJsonRaw = getFlagValue(args, "--files-json");
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

type SuggestNeighborhood = {
  tagHints: string[];
  pathHints: string[];
  terms: string[];
};

function normalizedPathForMatching(path: string): string {
  return normalizeFilePathInput(path);
}

export function deriveNeighborhoodFromFiles(
  files: string[],
): SuggestNeighborhood {
  const ignoredSegments = new Set([
    "src",
    "lib",
    "app",
    "apps",
    "test",
    "tests",
  ]);
  const tagHints: string[] = [];
  const pathHints: string[] = [];

  for (const filePath of files) {
    const normalized = normalizedPathForMatching(filePath);
    const directory = pathDirname(normalized).replaceAll("\\", "/");
    if (directory && directory !== ".") {
      pathHints.push(`${directory}/`);
      const extension = extname(normalized).replace(/^\./, "");
      if (extension) {
        pathHints.push(`${directory}/%.${extension}`);
      }
      const segments = directory.split("/").filter(Boolean);
      for (const segment of segments) {
        if (!ignoredSegments.has(segment.toLowerCase())) {
          tagHints.push(segment);
        }
      }
    }
  }

  const uniqueTagHints = uniqueLowerPreserveOrder(tagHints);
  const uniquePathHints = uniqueLowerPreserveOrder(pathHints);
  const terms = extractTerms([...uniqueTagHints, ...uniquePathHints].join(" "));
  return { tagHints: uniqueTagHints, pathHints: uniquePathHints, terms };
}

export function queryNeighborhoodMatches(
  database: MemoryDatabaseApi,
  neighborhood: SuggestNeighborhood,
  filters: CommonFilters,
  limit = 30,
): Effect.Effect<JsonObject[], MemoryDatabaseError> {
  const orClauses: string[] = [];
  const params: (string | number)[] = [];

  for (const tagHint of neighborhood.tagHints.slice(0, 10)) {
    orClauses.push("LOWER(m.tags) LIKE ?");
    params.push(`%${tagHint.toLowerCase()}%`);
  }
  for (const pathHint of neighborhood.pathHints.slice(0, 10)) {
    const lowered = `%${pathHint.toLowerCase()}%`;
    orClauses.push("LOWER(m.content) LIKE ?");
    params.push(lowered);
    orClauses.push("LOWER(m.context) LIKE ?");
    params.push(lowered);
    orClauses.push("LOWER(m.refs) LIKE ?");
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

export function mergeSuggestionResults(
  primary: JsonObject[],
  secondary: JsonObject[],
): JsonObject[] {
  const byId = new Map<number, JsonObject>();
  for (const row of primary) {
    byId.set(Number(row.id), row);
  }
  for (const row of secondary) {
    const id = Number(row.id);
    const existing = byId.get(id);
    if (!existing) {
      const boosted = {
        ...row,
        score: Number((Number(row.score ?? 0) + 12).toFixed(3)),
      };
      if ("score_breakdown" in boosted) {
        delete boosted.score_breakdown;
      }
      byId.set(id, boosted);
      continue;
    }
    const existingScore = Number(existing.score ?? 0);
    const nextScore = Math.max(existingScore, Number(row.score ?? 0) + 12);
    const merged = { ...existing, score: Number(nextScore.toFixed(3)) };
    if (nextScore !== existingScore && "score_breakdown" in merged) {
      delete merged.score_breakdown;
    }
    byId.set(id, merged);
  }
  return [...byId.values()]
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, 20);
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

type SqliteErrorDetails = {
  kind: "fts_parse" | "sqlite" | "unknown";
  message: string;
  hint?: string;
};

export function parseSqliteErrorDetails(
  err: Error | JsonValue,
): SqliteErrorDetails {
  if (!(err instanceof Error)) {
    return {
      kind: "unknown",
      message: "Unexpected failure while running command.",
    };
  }
  const lower = err.message.toLowerCase();
  if (
    lower.includes("no such column") ||
    lower.includes("no such table") ||
    lower.includes("fts5: syntax error") ||
    lower.includes("malformed match expression")
  ) {
    return {
      kind: "fts_parse",
      message: "Search query could not be parsed by SQLite FTS.",
      hint: "Try simpler terms without punctuation, or wrap file paths in --files-json for shell-safe input.",
    };
  }
  if (lower.includes("sqlite")) {
    return {
      kind: "sqlite",
      message: "SQLite command failed.",
      hint: "Retry once; if this persists, run `machine-memory migrate` and verify DB permissions/path.",
    };
  }
  return {
    kind: "unknown",
    message: err.message,
  };
}

export function parseSinceDate(args: string[]): string | undefined {
  const value = getFlagValue(args, "--since");
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

export {
  ADD_FLAGS_WITH_VALUES,
  ADD_USAGE,
  DEPRECATE_FLAGS_WITH_VALUES,
  DEPRECATE_USAGE,
  UPDATE_FLAGS_WITH_VALUES,
  UPDATE_USAGE,
} from "./features/memory/usage";
