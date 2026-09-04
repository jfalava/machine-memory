import { SEARCH_LIMIT_DEFAULT } from "@machine-memory/contract";
import { validateNamespace } from "./db";
import { buildFtsQuery, extractTerms } from "./fts";
import { scoreMemoryRows, scoredResultRow } from "./scoring";
import type { FtsRankedMemoryRow, MemoryRow, ScoredMemoryRow } from "./types";
import type { MemorySuggestArgs } from "./tool-schemas";

export type SuggestFilters = {
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

export type SuggestSnapshot = {
  readonly files: string[];
  readonly pathTerms: string[];
  readonly scoreTerms: string[];
  readonly neighborhood: FileNeighborhood;
  readonly ftsQuery: string | undefined;
};

export function buildSuggestSnapshot(args: MemorySuggestArgs): SuggestSnapshot {
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

export type SuggestEnvelope = {
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

export async function runMemorySuggest(
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
  const limit = args.limit ?? SEARCH_LIMIT_DEFAULT;
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
