import { extractTerms } from "../../shared";

export type FactCheckResult = {
  similarity: number;
  conflict: boolean;
  addedTerms: string[];
  removedTerms: string[];
};

export function setFromTerms(input: string): Set<string> {
  return new Set(extractTerms(input));
}

function termsDifference(source: Set<string>, against: Set<string>): string[] {
  return [...source].filter((term) => !against.has(term));
}

export function jaccardSimilarity(
  left: Set<string>,
  right: Set<string>,
): number {
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
