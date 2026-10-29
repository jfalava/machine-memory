import { Schema } from "effect";

import { MATCH_STRENGTHS, type MatchStrength } from "./literals";

export const MatchStrengthSchema = Schema.Literals(MATCH_STRENGTHS);

/**
 * Absolute relevance bars. Scores are batch-relative or prior-heavy, so these
 * thresholds are what tell an agent whether a result actually matches the
 * query. Semantic bars are calibrated for bge-base-en-v1.5 cosine similarity,
 * where unrelated memories commonly land between 0.52 and 0.65.
 */
export const MATCH_THRESHOLDS = {
  strongCoverage: 0.6,
  weakCoverage: 0.3,
  strongSemantic: 0.75,
  weakSemantic: 0.68,
} as const;

/** Relevance components dominate; recency, certainty, and churn only break ties. */
export const SEARCH_SCORE_WEIGHTS = {
  ftsRank: { multiplier: -10, minPoints: 0, maxPoints: 30 },
  termCoverage: { maxPoints: 30 },
  exactMatch: { pointsPerMatch: 15, maxMatchesCounted: 2 },
  tagMatch: { exact: 18, partial: 8 },
  recency: { maxPoints: 15, maxAgeDays: 180 },
  certainty: { verified: 10, inferred: 5, speculative: 1 },
  updateCount: { maxUpdatesCounted: 10, pointsPerUpdate: 1 },
} as const;

export type MatchAssessment = {
  readonly match_strength: MatchStrength;
  readonly term_coverage: number;
  readonly exact_matches: readonly string[];
};

const IDENTIFIER_EDGE_PUNCTUATION = /^[\s"'`([{<]+|[\s"'`)\]}>,;:!?.]+$/g;
const GENERIC_FILE_STEMS = new Set(["index", "main", "mod", "app"]);

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
  for (const raw of query.split(/[\s,]+/)) {
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
    push(file);
    const basename = file.split("/").pop() ?? "";
    const stem = basename.split(".")[0] ?? "";
    if (basename.includes(".") && !GENERIC_FILE_STEMS.has(stem.toLowerCase())) {
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

export function assessMatch(input: {
  readonly queryTerms: readonly string[];
  readonly identifiers: readonly string[];
  readonly text: string;
  readonly semanticScore?: number;
  readonly scope?: MatchScope;
}): MatchAssessment {
  const scope = input.scope ?? "query";
  const tokens = textTokens(input.text);
  const terms = [
    ...new Set(input.queryTerms.map((term) => term.toLowerCase())),
  ];
  const matchedTerms = terms.filter((term) => tokens.has(term)).length;
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

export function ftsRankPoints(ftsRank: number): number {
  if (!Number.isFinite(ftsRank)) {
    return 0;
  }
  const { multiplier, minPoints, maxPoints } = SEARCH_SCORE_WEIGHTS.ftsRank;
  return Number(
    Math.max(minPoints, Math.min(maxPoints, ftsRank * multiplier)).toFixed(3),
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

export function updateCountPoints(updateCount: number): number {
  if (!Number.isFinite(updateCount) || updateCount <= 0) {
    return 0;
  }
  const { maxUpdatesCounted, pointsPerUpdate } =
    SEARCH_SCORE_WEIGHTS.updateCount;
  return Math.min(updateCount, maxUpdatesCounted) * pointsPerUpdate;
}
