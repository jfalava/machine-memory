import { SEARCH_LIMIT_MAX } from "./literals";
import type { FactCheckResult } from "./product/results";

/**
 * Search-side helpers shared by the API worker and the CLI's local and remote
 * paths, so both rank the same data the same way.
 */

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

/** Lowercased, deduplicated search terms of at least two characters. */
export function extractTerms(input: string): string[] {
  const tokens = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 2 && !STOPWORDS.has(token),
  );
  return [...new Set(tokens)];
}

/** SQLite FTS5 OR-query over the first twelve terms; undefined when none remain. */
export function buildFtsQuery(terms: readonly string[]): string | undefined {
  const usable = terms.filter((term) => term.length > 0).slice(0, 12);
  if (usable.length === 0) {
    return undefined;
  }
  return usable.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/** Reciprocal-rank fusion constant; ranks matter, not each retriever's score scale. */
export const RRF_K = 60;

/** One retriever's contribution for a zero-based rank. */
export function reciprocalRankScore(rank: number): number {
  return 1 / (RRF_K + rank + 1);
}

/** Parses SQLite `YYYY-MM-DD HH:MM:SS` (UTC) or ISO timestamps. */
export function sqliteDateToMs(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

// Path segments say where a fact lives, not what it says.
const FACT_STOPWORDS = new Set([
  ...STOPWORDS,
  "src",
  "lib",
  "app",
  "test",
  "tests",
]);

/** Terms compared between two statements of a fact. */
export function factTerms(input: string): Set<string> {
  return new Set(
    (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
      (token) => token.length >= 2 && !FACT_STOPWORDS.has(token),
    ),
  );
}

export function jaccardSimilarity(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
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
    added_terms: [...candidateTerms]
      .filter((term) => !storedTerms.has(term))
      .slice(0, 12),
    removed_terms: [...storedTerms]
      .filter((term) => !candidateTerms.has(term))
      .slice(0, 12),
  };
}

export function normalizeSuggestPath(value: string): string {
  const cleaned = value.trim().replaceAll("\\", "/");
  if (!cleaned) {
    return "";
  }
  return cleaned.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
}

/** Search terms from path segments and their `.`/`_`/`-` pieces. */
export function extractPathTerms(paths: readonly string[]): string[] {
  const terms: string[] = [];
  for (const path of paths) {
    for (const segment of normalizeSuggestPath(path)
      .split("/")
      .filter(Boolean)) {
      terms.push(segment, ...segment.split(/[._-]+/).filter(Boolean));
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

/** Directory prefixes and directory-name tag hints for suggest's neighborhood search. */
export function deriveFileNeighborhood(
  files: readonly string[],
): FileNeighborhood {
  const tagHints: string[] = [];
  const pathHints: string[] = [];
  const seenTags = new Set<string>();
  const seenPaths = new Set<string>();
  for (const file of files) {
    const normalized = normalizeSuggestPath(file);
    const slash = normalized.lastIndexOf("/");
    const directory = slash < 0 ? "" : normalized.slice(0, slash);
    if (directory === "" || directory === ".") {
      continue;
    }
    if (!seenPaths.has(directory.toLowerCase())) {
      seenPaths.add(directory.toLowerCase());
      pathHints.push(`${directory}/`);
    }
    for (const segment of directory.split("/").filter(Boolean)) {
      const lower = segment.toLowerCase();
      if (!NEIGHBORHOOD_IGNORED_SEGMENTS.has(lower) && !seenTags.has(lower)) {
        seenTags.add(lower);
        tagHints.push(segment);
      }
    }
  }
  return {
    tagHints,
    pathHints,
    terms: extractTerms([...tagHints, ...pathHints].join(" ")),
  };
}

/** Full-text candidates scored per search before tiering and limiting. */
export const FTS_CANDIDATE_LIMIT = 100;
/** Neighborhood (same directory or tag) candidates fetched for suggest. */
export const SUGGEST_NEIGHBORHOOD_LIMIT = 30;
/** Score added to a memory that sits in a suggested file's neighborhood. */
export const SUGGEST_NEIGHBORHOOD_BOOST = 12;

/**
 * Vectorize candidates for semantic and hybrid search. Matches that fail the
 * tag or status filters are dropped afterwards, so fetch more than the limit.
 */
export function semanticCandidateCount(limit: number): number {
  return Math.min(limit * 3, SEARCH_LIMIT_MAX);
}

/**
 * Merges suggest's full-text rows with its neighborhood rows. A neighborhood
 * row scores its own score plus the boost, keeping the higher score when the
 * memory was also a full-text hit. Sorted by score; callers tier by match
 * strength before applying a limit.
 */
export function mergeSuggestCandidates<
  T extends { readonly id: number; readonly score: number },
>(primary: readonly T[], secondary: readonly T[]): T[] {
  const byId = new Map<number, T>(primary.map((row) => [row.id, row]));
  for (const row of secondary) {
    const boosted = Number((row.score + SUGGEST_NEIGHBORHOOD_BOOST).toFixed(3));
    const existing = byId.get(row.id);
    if (existing === undefined || boosted > existing.score) {
      byId.set(row.id, { ...(existing ?? row), score: boosted });
    }
  }
  return [...byId.values()].sort((left, right) => right.score - left.score);
}
