import { Schema } from "effect";

import type { MemoryType } from "./literals";
import { extractQueryIdentifiers } from "./search";

/**
 * What a replacement would lose from the stored content. An update replaces
 * the whole content, so unrelated valid details (paths, versions, caveats)
 * disappear unless the writer carries them over.
 */
export const DroppedDetailsSchema = Schema.Struct({
  identifiers: Schema.Array(Schema.String),
  sentences: Schema.Array(Schema.String),
});
export type DroppedDetails = typeof DroppedDetailsSchema.Type;

const MAX_DROPPED_IDENTIFIERS = 12;
const MAX_DROPPED_SENTENCES = 6;
const SENTENCE_HEAD_CHARS = 140;
/** A sentence counts as dropped when fewer than half its terms survive. */
const SENTENCE_KEPT_TERM_RATIO = 0.5;
const SENTENCE_MIN_TERMS = 3;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function sentenceHead(sentence: string): string {
  return sentence.length > SENTENCE_HEAD_CHARS
    ? `${sentence.slice(0, SENTENCE_HEAD_CHARS - 1)}…`
    : sentence;
}

export function droppedDetails(previous: string, next: string): DroppedDetails {
  const nextLower = next.toLowerCase();
  const nextTokens = new Set(nextLower.match(/[a-z0-9]+/g) ?? []);
  const previousLower = previous.toLowerCase();
  // Matching is case-insensitive; report identifiers as the writer spelled them.
  const identifiers = extractQueryIdentifiers(previous)
    .filter((identifier) => !nextLower.includes(identifier))
    .map((identifier) => {
      const at = previousLower.indexOf(identifier);
      return at < 0 ? identifier : previous.slice(at, at + identifier.length);
    });
  const dropped = sentences(previous).filter((sentence) => {
    const terms = [
      ...new Set(sentence.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []),
    ];
    if (terms.length < SENTENCE_MIN_TERMS) {
      return false;
    }
    const kept = terms.filter((term) => nextTokens.has(term)).length;
    return kept / terms.length < SENTENCE_KEPT_TERM_RATIO;
  });
  return {
    identifiers: identifiers.slice(0, MAX_DROPPED_IDENTIFIERS),
    sentences: dropped.slice(0, MAX_DROPPED_SENTENCES).map(sentenceHead),
  };
}

export function hasDroppedDetails(details: DroppedDetails): boolean {
  return details.identifiers.length > 0 || details.sentences.length > 0;
}

/**
 * Durable records are premises other records build on. Status snapshots are
 * transient, so changing one does not ask for dependent review.
 */
export function reviewsDependents(memoryType: MemoryType): boolean {
  return memoryType !== "status";
}

/**
 * Search input for records that may rely on a changed or retired premise.
 * Identifier terms come first so the capped full-text query keeps them.
 */
export type PremiseQuery = {
  readonly identifiers: string[];
  readonly leadingText: string;
};

export function premiseQuery(content: string): PremiseQuery {
  const identifiers = extractQueryIdentifiers(content);
  return {
    identifiers,
    leadingText: [...identifiers, content].join(" "),
  };
}

export const REVIEW_CANDIDATES_LIMIT = 5;

const GOTCHA_OVERLAP_MIN_SHARED = 2;
const GOTCHA_OVERLAP_MAX_FINDINGS = 50;

export type GotchaOverlap = {
  readonly ids: readonly [number, number];
  readonly shared_identifiers: string[];
};

/**
 * Active gotchas naming the same libraries, paths, or flags usually repeat a
 * workaround. Report them for consolidation; only a reviewer can merge them.
 */
export function gotchaOverlaps(
  rows: ReadonlyArray<{
    readonly id: number;
    readonly content: string;
    readonly memory_type: string;
  }>,
): GotchaOverlap[] {
  const gotchas = rows
    .filter((row) => row.memory_type === "gotcha")
    .map((row) => ({
      id: row.id,
      identifiers: new Set(extractQueryIdentifiers(row.content)),
    }));
  const overlaps: GotchaOverlap[] = [];
  for (const [index, left] of gotchas.entries()) {
    for (const right of gotchas.slice(index + 1)) {
      const shared = [...left.identifiers].filter((identifier) =>
        right.identifiers.has(identifier),
      );
      if (shared.length >= GOTCHA_OVERLAP_MIN_SHARED) {
        overlaps.push({
          ids: left.id < right.id ? [left.id, right.id] : [right.id, left.id],
          shared_identifiers: shared,
        });
      }
    }
  }
  return overlaps.slice(0, GOTCHA_OVERLAP_MAX_FINDINGS);
}
