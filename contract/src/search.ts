import { Schema } from "effect";

import { MATCH_STRENGTHS, type MatchStrength } from "./literals";

export const MatchStrengthSchema = Schema.Literals(MATCH_STRENGTHS);

/**
 * Absolute relevance bars. Scores are batch-relative or prior-heavy, so these
 * thresholds are what tell an agent whether a result actually matches the
 * query. Semantic bars are calibrated for bge-m3 cosine similarity on 184
 * records and one written question each (2026-11-14): the right record scored
 * 0.49-0.64 (p10-p90), the best wrong record 0.56 at the median and 0.61 at
 * p90, and unrelated questions peaked at 0.33-0.50. Re-measure when
 * EMBEDDING_MODEL changes.
 */
export const MATCH_THRESHOLDS = {
  strongCoverage: 0.6,
  weakCoverage: 0.3,
  strongSemantic: 0.63,
  weakSemantic: 0.55,
} as const;

/**
 * Relevance decides the order. Recency and certainty together add at most five
 * points, enough to order near-ties and never to lift a weaker match over a
 * better one. A status memory gives points back: it records where work stood,
 * so it ranks below a durable memory that matches as well.
 */
export const SEARCH_SCORE_WEIGHTS = {
  ftsRank: { maxPoints: 30 },
  termCoverage: { maxPoints: 30 },
  exactMatch: { pointsPerMatch: 15, maxMatchesCounted: 2 },
  tagMatch: { exact: 18, partial: 8 },
  recency: { maxPoints: 3, maxAgeDays: 180 },
  certainty: { verified: 2, inferred: 1, speculative: 0 },
  statusPenalty: 10,
} as const;

export type MatchAssessment = {
  readonly match_strength: MatchStrength;
  readonly term_coverage: number;
  readonly exact_matches: readonly string[];
  /** The query terms the memory holds. */
  readonly matched_terms: readonly string[];
  /** The fields that hold them, when the caller passed the fields. */
  readonly matched_in: readonly string[];
};

const IDENTIFIER_EDGE_PUNCTUATION = /^[\s"'`([{<]+|[\s"'`)\]}>,;:!?.]+$/g;
const GENERIC_FILE_STEMS = new Set(["index", "main", "mod", "app"]);
const GENERIC_FILE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lockb",
  "go.sum",
  "bunfig.toml",
]);

/**
 * Manifests and lockfiles change with almost every task and are named in
 * memories about unrelated things, so their names say nothing about the task.
 */
export function isGenericFile(path: string): boolean {
  const basename = (path.split("/").pop() ?? "").toLowerCase();
  return GENERIC_FILE_NAMES.has(basename) || basename.endsWith(".lock");
}

function isIdentifierToken(token: string): boolean {
  if (
    token.length < 3 ||
    /^\d+$/.test(token) ||
    /^[a-z]\.[a-z]$/i.test(token)
  ) {
    return false;
  }
  return (
    token.startsWith("--") ||
    /[a-z0-9][/._:][a-z0-9]/i.test(token) ||
    /[a-z0-9]-[a-z0-9]/i.test(token) ||
    /[a-z][A-Z]/.test(token)
  );
}

/**
 * Exact tokens worth matching literally: paths, flags, snake/kebab/camel case,
 * dotted names, and tag-like `area:cli` values. Returned lowercased.
 */
export function extractQueryIdentifiers(query: string): string[] {
  const identifiers: string[] = [];
  // `--local|--remote` lists alternatives; each one is its own identifier.
  for (const raw of query.split(/[\s,|]+/)) {
    const token = raw.replace(IDENTIFIER_EDGE_PUNCTUATION, "");
    const lower = token.toLowerCase();
    if (isIdentifierToken(token) && !identifiers.includes(lower)) {
      identifiers.push(lower);
    }
  }
  return identifiers;
}

/** Literal identifiers for file-scoped search: full paths plus specific basenames. */
export function fileIdentifiers(files: readonly string[]): string[] {
  const identifiers: string[] = [];
  const push = (value: string) => {
    const lower = value.toLowerCase();
    if (lower.length >= 3 && !identifiers.includes(lower)) {
      identifiers.push(lower);
    }
  };
  for (const file of files) {
    const basename = file.split("/").pop() ?? "";
    const generic = isGenericFile(file);
    // A generic file keeps its full path, which names one file, unless the
    // path is only the name.
    if (!generic || basename !== file) {
      push(file);
    }
    const stem = basename.split(".")[0] ?? "";
    if (
      !generic &&
      basename.includes(".") &&
      !GENERIC_FILE_STEMS.has(stem.toLowerCase())
    ) {
      push(basename);
    }
  }
  return identifiers;
}

/** Lowercased haystack used for coverage and exact-identifier checks. */
export function matchText(parts: readonly (string | undefined)[]): string {
  return parts
    .filter((part) => part !== undefined && part !== "")
    .join("\n")
    .toLowerCase();
}

function textTokens(text: string): Set<string> {
  return new Set(text.match(/[a-z0-9]+/g) ?? []);
}

/**
 * `query`: identifiers come from the search text, so every one must appear (or
 * one must appear alongside strong term coverage). `files`: identifiers are
 * suggested file paths, any one of which is decisive, while path-derived terms
 * are too generic to make a match strong on their own.
 */
export type MatchScope = "query" | "files";

function exactMatchIsStrong(
  scope: MatchScope,
  exactCount: number,
  identifierCount: number,
  strongCoverage: boolean,
): boolean {
  if (exactCount === 0) {
    return false;
  }
  return scope === "files" || exactCount === identifierCount || strongCoverage;
}

function matchedFields(
  fields: Readonly<Record<string, string>> | undefined,
  terms: readonly string[],
  identifiers: readonly string[],
): string[] {
  return Object.entries(fields ?? {})
    .filter(([, value]) => {
      const text = value.toLowerCase();
      const tokens = textTokens(text);
      return (
        terms.some((term) => tokens.has(term)) ||
        identifiers.some((identifier) => text.includes(identifier))
      );
    })
    .map(([name]) => name);
}

export function assessMatch(input: {
  readonly queryTerms: readonly string[];
  readonly identifiers: readonly string[];
  readonly text: string;
  readonly semanticScore?: number;
  readonly scope?: MatchScope;
  /** The same text by field name, to report where the terms matched. */
  readonly fields?: Readonly<Record<string, string>>;
}): MatchAssessment {
  const scope = input.scope ?? "query";
  const tokens = textTokens(input.text);
  const terms = [
    ...new Set(input.queryTerms.map((term) => term.toLowerCase())),
  ];
  const matched = terms.filter((term) => tokens.has(term));
  const matchedTerms = matched.length;
  const coverage =
    terms.length === 0 ? 0 : Number((matchedTerms / terms.length).toFixed(3));
  const exactMatches = input.identifiers.filter((identifier) =>
    input.text.includes(identifier),
  );
  const semantic = input.semanticScore ?? 0;
  const strongCoverage =
    coverage >= MATCH_THRESHOLDS.strongCoverage &&
    matchedTerms >= Math.min(2, terms.length);
  let strength: MatchStrength = "none";
  if (
    exactMatchIsStrong(
      scope,
      exactMatches.length,
      input.identifiers.length,
      strongCoverage,
    ) ||
    (scope === "query" && strongCoverage) ||
    semantic >= MATCH_THRESHOLDS.strongSemantic
  ) {
    strength = "strong";
  } else if (
    exactMatches.length > 0 ||
    coverage >= MATCH_THRESHOLDS.weakCoverage ||
    semantic >= MATCH_THRESHOLDS.weakSemantic
  ) {
    strength = "weak";
  }
  return {
    match_strength: strength,
    term_coverage: coverage,
    exact_matches: exactMatches,
    matched_terms: matched,
    matched_in: matchedFields(input.fields, matched, exactMatches),
  };
}

export function hasStrongMatch(
  rows: readonly { readonly match_strength: MatchStrength }[],
): boolean {
  return rows.some((row) => row.match_strength === "strong");
}

const MATCH_STRENGTH_ORDER = {
  strong: 2,
  weak: 1,
  none: 0,
} as const satisfies Record<MatchStrength, number>;

export function matchStrengthRank(strength: MatchStrength): number {
  return MATCH_STRENGTH_ORDER[strength];
}

/**
 * Stable tiering: strong results first, then weak, then none, keeping score
 * order inside each tier so a limit cannot drop a strong match for a weak one.
 */
export function orderByMatchStrength<
  T extends { readonly match_strength: MatchStrength },
>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        matchStrengthRank(right.row.match_strength) -
          matchStrengthRank(left.row.match_strength) ||
        left.index - right.index,
    )
    .map((entry) => entry.row);
}

/** The strongest full-text rank of a candidate set; bm25 is negative, lower is better. */
export function bestFtsRank(ranks: readonly number[]): number {
  return ranks.reduce(
    (best, rank) => (Number.isFinite(rank) && rank < best ? rank : best),
    0,
  );
}

/**
 * Full-text points relative to the best candidate of the same search. bm25
 * grows with the number of query terms and the size of the repository, so a
 * fixed scale gave every good candidate the maximum and left the order to
 * recency and certainty.
 */
export function ftsRankPoints(ftsRank: number, best: number): number {
  if (!(ftsRank < 0) || !(best < 0)) {
    return 0;
  }
  return Number(
    (
      SEARCH_SCORE_WEIGHTS.ftsRank.maxPoints * Math.min(1, ftsRank / best)
    ).toFixed(3),
  );
}

export function termCoveragePoints(coverage: number): number {
  return Number(
    (
      Math.max(0, Math.min(1, coverage)) *
      SEARCH_SCORE_WEIGHTS.termCoverage.maxPoints
    ).toFixed(3),
  );
}

export function exactMatchPoints(matchCount: number): number {
  const { pointsPerMatch, maxMatchesCounted } = SEARCH_SCORE_WEIGHTS.exactMatch;
  return Math.min(Math.max(0, matchCount), maxMatchesCounted) * pointsPerMatch;
}

export function tagMatchPoints(
  tags: readonly string[],
  queryTokens: readonly string[],
): number {
  if (tags.length === 0 || queryTokens.length === 0) {
    return 0;
  }
  const tagList = tags.map((tag) => tag.toLowerCase());
  const tokens = queryTokens.map((token) => token.toLowerCase());
  const tokenSet = new Set(tokens);
  if (tagList.some((tag) => tokenSet.has(tag))) {
    return SEARCH_SCORE_WEIGHTS.tagMatch.exact;
  }
  if (tagList.some((tag) => tokens.some((token) => tag.includes(token)))) {
    return SEARCH_SCORE_WEIGHTS.tagMatch.partial;
  }
  return 0;
}

export function recencyPoints(
  updatedAtMs: number | null,
  nowMs: number = Date.now(),
): number {
  if (updatedAtMs === null) {
    return 0;
  }
  const { maxPoints, maxAgeDays } = SEARCH_SCORE_WEIGHTS.recency;
  const ageDays = Math.max(0, (nowMs - updatedAtMs) / (1000 * 60 * 60 * 24));
  const capped = Math.min(ageDays, maxAgeDays);
  return Number((maxPoints * (1 - capped / maxAgeDays)).toFixed(3));
}

export function certaintyPoints(certainty: string): number {
  const weights = SEARCH_SCORE_WEIGHTS.certainty;
  if (certainty === "verified") {
    return weights.verified;
  }
  if (certainty === "inferred") {
    return weights.inferred;
  }
  return weights.speculative;
}

/**
 * SQL that is true for a status memory past its expiry. Searches leave these
 * out: the writer said the record stops describing the work after that many
 * days. `prefix` is the table alias with its dot, such as `m.`.
 */
export function expiredStatusSql(prefix = ""): string {
  return `(${prefix}memory_type = 'status' AND ${prefix}expires_after_days IS NOT NULL AND datetime(${prefix}updated_at, '+' || ${prefix}expires_after_days || ' days') <= datetime('now'))`;
}

/** The same rule for a row already read, such as a semantic match. */
export function isExpiredStatus(
  row: {
    readonly memory_type: string;
    readonly expires_after_days?: number | null | undefined;
  },
  updatedAtMs: number | null,
  nowMs: number = Date.now(),
): boolean {
  return (
    row.memory_type === "status" &&
    row.expires_after_days !== null &&
    row.expires_after_days !== undefined &&
    updatedAtMs !== null &&
    updatedAtMs + row.expires_after_days * 86_400_000 <= nowMs
  );
}

export function statusPenaltyPoints(memoryType: string): number {
  return memoryType === "status" ? SEARCH_SCORE_WEIGHTS.statusPenalty : 0;
}

export type ScoreBreakdown = {
  readonly fts_rank: number;
  readonly term_coverage: number;
  readonly exact_match: number;
  readonly tag_match: number;
  readonly recency: number;
  readonly certainty: number;
  readonly status_penalty: number;
  readonly total: number;
};

/** One candidate's rank score and its parts, the same for the CLI and the API. */
export function scoreCandidate(input: {
  readonly ftsRank: number;
  readonly bestFtsRank: number;
  readonly match: MatchAssessment;
  readonly tags: readonly string[];
  readonly queryTerms: readonly string[];
  readonly updatedAtMs: number | null;
  readonly certainty: string;
  readonly memoryType: string;
  readonly nowMs?: number;
}): ScoreBreakdown {
  const parts = {
    fts_rank: ftsRankPoints(input.ftsRank, input.bestFtsRank),
    term_coverage: termCoveragePoints(input.match.term_coverage),
    exact_match: exactMatchPoints(input.match.exact_matches.length),
    tag_match: tagMatchPoints(input.tags, input.queryTerms),
    recency: recencyPoints(input.updatedAtMs, input.nowMs),
    certainty: certaintyPoints(input.certainty),
    status_penalty: statusPenaltyPoints(input.memoryType),
  };
  return {
    ...parts,
    total: Number(
      (
        parts.fts_rank +
        parts.term_coverage +
        parts.exact_match +
        parts.tag_match +
        parts.recency +
        parts.certainty -
        parts.status_penalty
      ).toFixed(3),
    ),
  };
}
