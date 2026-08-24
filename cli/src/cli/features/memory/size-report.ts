import { Effect } from "effect";
import {
  analyzeBgeEmbedding,
  analyzeEmbeddingByBytes,
  BGE_MAX_EMBEDDING_TOKENS,
  assertBgeBreakdown,
  type BgeTokenBreakdown,
  type EmbeddingTextPart,
} from "../../../effect/bge-tokenizer";
import { commandError, type CommandError } from "../../../effect/errors";
import type { JsonObject } from "../../../json";

/**
 * Measures the composed embedding text with the real BGE tokenizer when it is
 * reachable and falls back to the Worker's conservative byte+2 estimate when
 * it is not. Never throws on oversize; callers decide whether to assert.
 */
export function measureEmbeddingFit(
  parts: readonly EmbeddingTextPart[],
): Effect.Effect<BgeTokenBreakdown, CommandError> {
  return Effect.tryPromise({
    try: async () => {
      try {
        return await analyzeBgeEmbedding(parts);
      } catch {
        return analyzeEmbeddingByBytes(parts);
      }
    },
    catch: (cause) =>
      commandError(
        "size",
        cause instanceof Error ? cause.message : "Embedding analysis failed.",
        cause,
      ),
  });
}

/** Asserts the measured text fits, throwing the corrected limit message. */
export function assertEmbeddingFit(
  breakdown: BgeTokenBreakdown,
  label: string,
): void {
  assertBgeBreakdown(breakdown, label);
}

export function embeddingSizeReport(breakdown: BgeTokenBreakdown): JsonObject {
  const report: JsonObject = {
    source: breakdown.source,
    total_tokens: breakdown.total_tokens,
    max_tokens: breakdown.max_tokens,
    bytes_estimate: breakdown.bytes_estimate,
    max_bytes_estimate: BGE_MAX_EMBEDDING_TOKENS,
    limits: {
      tokens: {
        value: breakdown.total_tokens,
        limit: "below 512",
        pass: breakdown.over_by_tokens === 0,
      },
      bytes_estimate: {
        value: breakdown.bytes_estimate,
        limit: BGE_MAX_EMBEDDING_TOKENS,
        pass: breakdown.over_by_bytes === 0,
      },
    },
    within_budget: breakdown.within_limit,
    binding_limit: breakdown.binding_limit,
    over_by_tokens: breakdown.over_by_tokens,
    over_by_bytes: breakdown.over_by_bytes,
  };
  if (breakdown.parts.length > 0) {
    Object.assign(report, { parts: breakdown.parts });
    if (breakdown.overhead > 0) {
      Object.assign(report, { overhead: breakdown.overhead });
    }
  }
  if (breakdown.largest_part) {
    Object.assign(report, { largest_part: breakdown.largest_part });
  }
  if (breakdown.trimmed_suggestion) {
    Object.assign(report, { trimmed_suggestion: breakdown.trimmed_suggestion });
  }
  return report;
}
