import { Database } from "bun:sqlite";
import {
  resolve,
  relative,
  sep,
  dirname as pathDirname,
  extname,
} from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { getFlagValue, hasFlag, printJson, usageError } from "../cli";
import {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type Certainty,
  type CommonFilters,
  type MemoryStatus,
  type MemoryType,
} from "../constants";
import { allWithRetry, getWithRetry } from "../db";

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

function isCertainty(value: string): value is Certainty {
  return (CERTAINTY_LEVELS as readonly string[]).includes(value);
}

const LEGACY_CERTAINTY_ALIASES: Record<string, Certainty> = {
  hard: "verified",
  soft: "inferred",
  uncertain: "speculative",
};

export function canonicalizeCertainty(raw: string): Certainty | undefined {
  if (isCertainty(raw)) {
    return raw;
  }
  return LEGACY_CERTAINTY_ALIASES[raw];
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
  value: unknown,
  fallback: Certainty = "inferred",
): Certainty {
  if (typeof value !== "string") {
    return fallback;
  }
  return canonicalizeCertainty(value) ?? fallback;
}

export function isMemoryStatus(value: string): value is MemoryStatus {
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
    printJson({
      error: `Invalid memory type '${raw}'. Expected one of: ${MEMORY_TYPES.join(", ")}`,
    });
    process.exit(1);
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
    printJson({
      error: `Invalid certainty '${raw}'. Expected one of: ${CERTAINTY_LEVELS.join(", ")}`,
    });
    process.exit(1);
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
    printJson({
      error: `Invalid status '${raw}'. Expected one of: ${MEMORY_STATUSES.join(", ")}`,
    });
    process.exit(1);
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
    printJson({ error: `Invalid integer for ${flag}: ${raw}` });
    process.exit(1);
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
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error("Expected JSON string array");
    }
    return (parsed as string[]).slice();
  } catch {
    const fallback = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (fallback.length === 0) {
      printJson({
        error:
          "Invalid --refs value. Provide a JSON array (e.g. '[\\\"https://...\\\"]') or comma-separated list.",
      });
      process.exit(1);
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

export function parseContentFromFileFlag(args: string[]): string | undefined {
  const path = getFlagValue(args, "--from-file");
  if (path === undefined) {
    return undefined;
  }
  const resolvedPath = assertFileExists(path);
  return readFileSync(resolvedPath, "utf-8");
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeSqliteRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") {
    return {};
  }
  const next = { ...(row as Record<string, unknown>) };
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

export function parseStoredRefs(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

export function sqliteDateToMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
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

function certaintyWeight(certainty: unknown): number {
  const normalized = normalizeCertaintyValue(certainty, "speculative");
  if (normalized === "verified") {
    return 20;
  }
  if (normalized === "inferred") {
    return 10;
  }
  return 2;
}

function recencyWeight(updatedAt: unknown): number {
  const ms = sqliteDateToMs(updatedAt);
  if (ms === null) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - ms) / (1000 * 60 * 60 * 24));
  const capped = Math.min(ageDays, 180);
  return Number((30 * (1 - capped / 180)).toFixed(3));
}

function tagExactnessWeight(tags: unknown, queryTokens: string[]): number {
  if (typeof tags !== "string" || queryTokens.length === 0) {
    return 0;
  }
  const tagList = parseTags(tags).map((tag) => tag.toLowerCase());
  const tokenSet = new Set(queryTokens.map((token) => token.toLowerCase()));
  if (tagList.some((tag) => tokenSet.has(tag))) {
    return 18;
  }
  if (tagList.some((tag) => queryTokens.some((token) => tag.includes(token)))) {
    return 8;
  }
  return 0;
}

function updateCountWeight(updateCount: unknown): number {
  const count = Number(updateCount ?? 0);
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return Math.min(count, 10) * 2;
}

function ftsWeight(ftsRank: unknown): number {
  const rank = Number(ftsRank);
  if (!Number.isFinite(rank)) {
    return 0;
  }
  const transformed = Math.max(0, Math.min(30, -rank * 10));
  return Number(transformed.toFixed(3));
}

function scoreMemory(
  row: Record<string, unknown>,
  queryTokens: string[],
): number {
  const score =
    recencyWeight(row.updated_at) +
    tagExactnessWeight(row.tags, queryTokens) +
    updateCountWeight(row.update_count) +
    certaintyWeight(row.certainty) +
    ftsWeight(row.fts_rank);
  return Number(score.toFixed(3));
}

export function shapeRowsWithScore(
  rows: unknown[],
  queryTokens: string[],
): Record<string, unknown>[] {
  const normalized = rows.map((row) => normalizeSqliteRow(row));
  const withScore = normalized.map((row) => ({
    ...row,
    score: scoreMemory(row, queryTokens),
  }));
  withScore.sort((a, b) => Number(b.score) - Number(a.score));
  return withScore.map((row) => {
    const rest = { ...(row as Record<string, unknown>) };
    delete rest.fts_rank;
    return rest;
  });
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

export type OutputMode = {
  brief: boolean;
  jsonMin: boolean;
  noConflicts: boolean;
  quiet: boolean;
};

export function parseOutputMode(args: string[]): OutputMode {
  return {
    brief: hasFlag(args, "--brief"),
    jsonMin: hasFlag(args, "--json-min"),
    noConflicts: hasFlag(args, "--no-conflicts"),
    quiet: hasFlag(args, "--quiet"),
  };
}

export function hasMinimalOutput(mode: OutputMode): boolean {
  return mode.brief || mode.jsonMin || mode.quiet;
}

function briefTagText(tags: unknown): string {
  const parsed = parseTags(stringValue(tags));
  if (parsed.length === 0) {
    return "(#none)";
  }
  return `(${parsed.map((tag) => `#${tag}`).join(" ")})`;
}

function formatBriefMemoryLine(row: Record<string, unknown>): string {
  const id = Number(row.id ?? 0);
  const certainty = normalizeCertaintyValue(row.certainty);
  const type = stringValue(row.memory_type, "convention");
  const content = stringValue(row.content).replace(/\s+/g, " ").trim();
  return `[${id}] <${certainty}> <${type}>: ${content} ${briefTagText(row.tags)}`;
}

export function printBriefLines(rows: Record<string, unknown>[]) {
  const lines = rows.map((row) => formatBriefMemoryLine(row));
  console.info(lines.join("\n"));
}

export function queryEmptyResultPayload(
  term: string,
  filters: CommonFilters,
  queryTokens: string[],
) {
  return {
    results: [],
    search_term: term,
    derived_terms: queryTokens,
    filters: {
      tags: filters.tag ?? null,
      type: filters.memoryType ?? null,
      certainty: filters.certainty ?? null,
      include_deprecated: filters.includeDeprecated,
    },
    hints: [
      "Try broader keywords or synonyms.",
      "Use --include-deprecated to include superseded/archived memories.",
      "Narrow with --tags/--type/--certainty when you know the scope.",
    ],
  };
}

export function applySqlFilters(
  clauses: string[],
  params: (string | number)[],
  filters: CommonFilters,
  options: { defaultActiveOnly?: boolean } = {},
) {
  if (filters.tag) {
    clauses.push("tags LIKE ?");
    params.push(`%${filters.tag}%`);
  }
  if (filters.memoryType) {
    clauses.push("memory_type = ?");
    params.push(filters.memoryType);
  }
  if (filters.certainty) {
    const variants = certaintyStorageVariants(filters.certainty);
    if (variants.length === 1) {
      clauses.push("certainty = ?");
      params.push(variants[0] ?? filters.certainty);
    } else {
      clauses.push(`certainty IN (${variants.map(() => "?").join(", ")})`);
      for (const variant of variants) {
        params.push(variant);
      }
    }
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  } else if (options.defaultActiveOnly ?? true) {
    if (!filters.includeDeprecated) {
      clauses.push("status = 'active'");
    }
  }
}

export function getMemoryById(
  database: Database,
  id: number,
): Record<string, unknown> | null {
  const row = getWithRetry(database, "SELECT * FROM memories WHERE id = ?", [
    id,
  ]);
  if (!row) {
    return null;
  }
  return normalizeSqliteRow(row);
}

export function findMemoryByMatch(
  database: Database,
  query: string,
): Record<string, unknown> | null {
  const terms = extractTerms(query);
  const ftsQuery = buildFtsQueryFromTerms(terms);
  if (!ftsQuery) {
    return null;
  }
  const rows = allWithRetry(
    database,
    `SELECT m.*, bm25(memories_fts) AS fts_rank
     FROM memories m
     JOIN memories_fts ON m.id = memories_fts.rowid
     WHERE memories_fts MATCH ?
       AND m.status = 'active'
     ORDER BY bm25(memories_fts)
     LIMIT 5`,
    [ftsQuery],
  ) as unknown[];
  const ranked = shapeRowsWithScore(rows, terms);
  return ranked[0] ?? null;
}

export function detectPotentialConflicts(
  database: Database,
  payload: { content: string; tags?: string; context?: string },
  options: { excludeId?: number; limit?: number } = {},
): Record<string, unknown>[] {
  const terms = extractTerms(
    [payload.content, payload.tags ?? "", payload.context ?? ""].join(" "),
  );
  const ftsQuery = buildFtsQueryFromTerms(terms);
  if (!ftsQuery) {
    return [];
  }

  const clauses = ["memories_fts MATCH ?", "m.status = 'active'"];
  const params: (string | number)[] = [ftsQuery];
  if (options.excludeId !== undefined) {
    clauses.push("m.id != ?");
    params.push(options.excludeId);
  }

  const rows = allWithRetry(
    database,
    `SELECT m.*, bm25(memories_fts) AS fts_rank
     FROM memories m
     JOIN memories_fts ON m.id = memories_fts.rowid
     WHERE ${clauses.join(" AND ")}
     ORDER BY bm25(memories_fts)
     LIMIT ${Number(options.limit ?? 5)}`,
    params,
  );

  return shapeRowsWithScore(rows as unknown[], terms);
}

export function findExactDuplicate(
  database: Database,
  payload: { content: string; tags?: string; context?: string },
): Record<string, unknown> | null {
  const row = getWithRetry(
    database,
    `SELECT * FROM memories
     WHERE status = 'active'
       AND content = ?
       AND tags = ?
       AND context = ?
     LIMIT 1`,
    [payload.content, payload.tags ?? "", payload.context ?? ""],
  );
  return row ? normalizeSqliteRow(row) : null;
}

export function collectDirectories(rootPath: string): string[] {
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

  function walk(current: string) {
    let entries:
      | {
          name: string;
          isDirectory(): boolean;
        }[]
      | undefined;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (ignoreNames.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const child = resolve(current, entry.name);
      const rel = relative(rootPath, child).split(sep).join("/");
      directories.push(`${rel}/`);
      walk(child);
    }
  }

  if (existsSync(rootPath) && statSync(rootPath).isDirectory()) {
    walk(rootPath);
  }
  directories.sort();
  return directories;
}

export function extractPathTermsFromFiles(paths: string[]): string[] {
  const terms: string[] = [];
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
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

function parseFileList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFileListJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error("Expected JSON string array");
    }
    return (parsed as string[]).map((item) => item.trim()).filter(Boolean);
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
  return filesJsonRaw
    ? parseFileListJson(filesJsonRaw)
    : parseFileList(filesRaw ?? "");
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

type FactCheckResult = {
  similarity: number;
  conflict: boolean;
  addedTerms: string[];
  removedTerms: string[];
};

function setFromTerms(input: string): Set<string> {
  return new Set(extractTerms(input));
}

function termsDifference(source: Set<string>, against: Set<string>): string[] {
  return [...source].filter((term) => !against.has(term));
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  const intersection = [...left].filter((term) => right.has(term)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : Number((intersection / union).toFixed(3));
}

function hasNegation(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(not|no|never|without|cannot|can't)\b/.test(lower);
}

export function compareFact(
  stored: string,
  candidate: string,
): FactCheckResult {
  const storedTerms = setFromTerms(stored);
  const candidateTerms = setFromTerms(candidate);
  const similarity = jaccardSimilarity(storedTerms, candidateTerms);
  const negationMismatch = hasNegation(stored) !== hasNegation(candidate);
  const addedTerms = termsDifference(candidateTerms, storedTerms).slice(0, 12);
  const removedTerms = termsDifference(storedTerms, candidateTerms).slice(
    0,
    12,
  );
  return {
    similarity,
    conflict: negationMismatch || similarity < 0.35,
    addedTerms,
    removedTerms,
  };
}

type SuggestNeighborhood = {
  tagHints: string[];
  pathHints: string[];
  terms: string[];
};

function normalizedPathForMatching(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
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
  database: Database,
  neighborhood: SuggestNeighborhood,
  filters: CommonFilters,
): Record<string, unknown>[] {
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
    return [];
  }

  const clauses = [`(${orClauses.join(" OR ")})`];
  applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });
  const rows = allWithRetry(
    database,
    `SELECT m.*, 0 AS fts_rank
     FROM memories m
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.updated_at DESC, m.id DESC
     LIMIT 30`,
    params,
  ) as unknown[];
  return shapeRowsWithScore(rows, neighborhood.terms);
}

export function mergeSuggestionResults(
  primary: Record<string, unknown>[],
  secondary: Record<string, unknown>[],
): Record<string, unknown>[] {
  const byId = new Map<number, Record<string, unknown>>();
  for (const row of primary) {
    byId.set(Number(row.id), row);
  }
  for (const row of secondary) {
    const id = Number(row.id);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...row, score: Number(row.score ?? 0) + 12 });
      continue;
    }
    const existingScore = Number(existing.score ?? 0);
    const nextScore = Math.max(existingScore, Number(row.score ?? 0) + 12);
    byId.set(id, { ...existing, score: Number(nextScore.toFixed(3)) });
  }
  return [...byId.values()]
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, 20);
}

export function findStatusCascadeCandidates(
  database: Database,
  tags: string,
  excludeId: number,
): Record<string, unknown>[] {
  const tagSet = new Set(parseTags(tags).map((tag) => tag.toLowerCase()));
  if (tagSet.size === 0) {
    return [];
  }
  const rows = allWithRetry(
    database,
    `SELECT * FROM memories
     WHERE status = 'active'
       AND memory_type = 'status'
       AND id != ?
     ORDER BY updated_at DESC, id DESC`,
    [excludeId],
  ) as unknown[];
  return rows
    .map((row) => normalizeSqliteRow(row))
    .filter((row) => {
      const memoryTags = parseTags(stringValue(row.tags)).map((tag) =>
        tag.toLowerCase(),
      );
      return memoryTags.some((tag) => tagSet.has(tag));
    });
}

export function parseSqliteErrorDetails(err: unknown): {
  kind: "fts_parse" | "sqlite" | "unknown";
  message: string;
  hint?: string;
} {
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
    printJson({ error: `Invalid --since date: ${value}` });
    process.exit(1);
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

export function assertFileExists(path: string): string {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    printJson({ error: `File not found: ${path}` });
    process.exit(1);
  }
  return resolved;
}

export const ADD_USAGE =
  "add (<content> | --from-file <path>) [--path <file_path>] [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--source-agent <name>] [--refs <json_or_csv>] [--expires-after-days <n>] [--no-conflicts] [--brief|--json-min|--quiet]";
export const UPDATE_USAGE =
  "update (<id|id,id,...> | --match <query>) (<content> | --from-file <path>) [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--updated-by <name>] [--refs <json_or_csv>] [--expires-after-days <n|null>]";
export const DEPRECATE_USAGE =
  "deprecate (<id|id,id,...> | --match <query>) [--superseded-by <id>] [--updated-by <name>]";

export const ADD_FLAGS_WITH_VALUES = [
  "--tags",
  "--context",
  "--path",
  "--type",
  "--certainty",
  "--source-agent",
  "--updated-by",
  "--refs",
  "--expires-after-days",
  "--from-file",
] as const;

export const UPDATE_FLAGS_WITH_VALUES = [
  "--tags",
  "--context",
  "--type",
  "--certainty",
  "--updated-by",
  "--refs",
  "--expires-after-days",
  "--from-file",
  "--match",
] as const;

export const DEPRECATE_FLAGS_WITH_VALUES = [
  "--superseded-by",
  "--updated-by",
  "--match",
] as const;
