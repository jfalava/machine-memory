import { STOPWORDS } from "./fts";

/**
 * CLI parity helpers. The CLI ships suggest / verify / diff / --match /
 * --upsert-match on top of the same D1 + FTS primitives; the ports below keep
 * MCP behavior identical (same stopwords, thresholds, and scoring weights).
 */

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

export function contentHead(text: string, maxChars = 120): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > maxChars
    ? `${flattened.slice(0, maxChars)}…`
    : flattened;
}
