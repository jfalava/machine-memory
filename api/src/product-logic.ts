import {
  composeEmbeddingText,
  jsonString,
  UPSERT_DEFAULT_MIN_SCORE,
  UPSERT_MIN_SIMILARITY,
  type Certainty,
  type JsonObject,
  type MemoryStatus,
  type MemoryType,
} from "@machine-memory/contract";

export const PRODUCT_ROUTES = [
  "query",
  "get",
  "list",
  "suggest",
  "add",
  "update",
  "delete",
  "verify",
  "diff",
  "size",
  "list-repositories",
] as const;

export type ProductRoute = (typeof PRODUCT_ROUTES)[number];

export function productRoutePath(route: ProductRoute): string {
  return `/product/${route}`;
}

/** Accepts the legacy underscore alias for list-repositories. */
export function normalizeProductRoute(url: string): ProductRoute | undefined {
  if (url === "/product/list_repositories") {
    return "list-repositories";
  }
  const match = PRODUCT_ROUTES.find((route) => url === `/product/${route}`);
  return match;
}

export type ProductMemoryRow = {
  readonly id: number;
  readonly repository: string;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: MemoryType;
  readonly status: MemoryStatus;
  readonly certainty: Certainty;
};

export type RankedMemoryRow = ProductMemoryRow & {
  readonly updated_at: string;
  readonly update_count: number;
};

export type FtsRankedMemoryRow = RankedMemoryRow & {
  readonly fts_rank: number;
};

export type ScoredMemoryRow = ProductMemoryRow & {
  readonly score: number;
};

export function toProductRow(value: JsonObject): ProductMemoryRow {
  // SAFETY: memories table constrains these columns to the contract vocabularies.
  const memory_type = (jsonString(value.memory_type) ?? "convention") as MemoryType;
  // SAFETY: memories table constrains these columns to the contract vocabularies.
  const status = (jsonString(value.status) ?? "active") as MemoryStatus;
  // SAFETY: memories table constrains these columns to the contract vocabularies.
  const certainty = (jsonString(value.certainty) ?? "inferred") as Certainty;
  return {
    id: Number(value.id),
    repository: jsonString(value.repository) ?? "",
    content: jsonString(value.content) ?? "",
    tags: jsonString(value.tags) ?? "",
    context: jsonString(value.context) ?? "",
    memory_type,
    status,
    certainty,
  };
}

export function toRankedRow(value: JsonObject): FtsRankedMemoryRow {
  return {
    ...toProductRow(value),
    updated_at: jsonString(value.updated_at) ?? "",
    update_count: Number(value.update_count ?? 0),
    fts_rank: Number(value.fts_rank ?? 0),
  };
}

export function toScoredRow(row: RankedMemoryRow, score: number): ScoredMemoryRow {
  return {
    id: row.id,
    repository: row.repository,
    content: row.content,
    tags: row.tags,
    context: row.context,
    memory_type: row.memory_type,
    status: row.status,
    certainty: row.certainty,
    score,
  };
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

export function extractTerms(input: string): string[] {
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

export function buildFtsQuery(terms: string[]): string | undefined {
  const usable = terms.filter((term) => term.length > 0).slice(0, 12);
  if (usable.length === 0) {
    return undefined;
  }
  return usable.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

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

export type ProductFactCheck = {
  readonly similarity: number;
  readonly conflict: boolean;
  readonly added_terms: string[];
  readonly removed_terms: string[];
};

export function compareMemoryFact(
  stored: string,
  candidate: string,
): ProductFactCheck {
  const storedTerms = factTerms(stored);
  const candidateTerms = factTerms(candidate);
  const similarity = jaccardSimilarity(storedTerms, candidateTerms);
  return {
    similarity,
    conflict:
      hasNegation(stored) !== hasNegation(candidate) || similarity < 0.35,
    added_terms: [...candidateTerms]
      .filter((term) => !storedTerms.has(term))
      .slice(0, 12),
    removed_terms: [...storedTerms]
      .filter((term) => !candidateTerms.has(term))
      .slice(0, 12),
  };
}

export function contentHead(text: string, maxChars = 120): string {
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

export function scoreMemoryRows(
  rows: readonly FtsRankedMemoryRow[],
  queryTokens: string[],
): Array<RankedMemoryRow & { score: number }> {
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

export function scoredResultRow(row: RankedMemoryRow & { score: number }): ScoredMemoryRow {
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

function mergeSuggestRows(
  primary: Array<RankedMemoryRow & { score: number }>,
  secondary: Array<RankedMemoryRow & { score: number }>,
): Array<RankedMemoryRow & { score: number }> {
  const byId = new Map<number, RankedMemoryRow & { score: number }>();
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

export function mergeScoredSuggestRows(
  primary: ScoredMemoryRow[],
  secondaryRanks: Array<RankedMemoryRow & { score: number }>,
): ScoredMemoryRow[] {
  const primaryRanks = primary.map((row) => ({
    ...row,
    updated_at: "",
    update_count: 0,
  }));
  return mergeSuggestRows(primaryRanks, secondaryRanks).map(scoredResultRow);
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

function collectDirectoryTags(
  directory: string,
  seenTags: Set<string>,
  tagHints: string[],
): void {
  for (const segment of directory.split("/").filter(Boolean)) {
    const lower = segment.toLowerCase();
    if (!NEIGHBORHOOD_IGNORED_SEGMENTS.has(lower) && !seenTags.has(lower)) {
      seenTags.add(lower);
      tagHints.push(segment);
    }
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
  collectExtensionHint(directory, normalized.slice(slash + 1), seenPaths, pathHints);
  collectDirectoryTags(directory, seenTags, tagHints);
}

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

export type UpsertStrength = {
  readonly strong: boolean;
  readonly similarity: number;
  readonly score: number;
};

export function upsertStrength(
  stored: { content: string; tags: string; context: string },
  candidate: { content: string; tags: string; context: string },
  score: number,
  threshold: number = UPSERT_DEFAULT_MIN_SCORE,
): UpsertStrength {
  const similarity = compareMemoryFact(
    [stored.content, stored.tags, stored.context].join(" "),
    [candidate.content, candidate.tags, candidate.context].join(" "),
  ).similarity;
  return {
    strong:
      similarity >= UPSERT_MIN_SIMILARITY && score >= threshold,
    similarity,
    score,
  };
}

export { UPSERT_DEFAULT_MIN_SCORE, UPSERT_MIN_SIMILARITY };
