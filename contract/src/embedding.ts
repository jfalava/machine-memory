import { Schema } from "effect";

import { MAX_EMBEDDING_TOKENS } from "./literals";

const SPECIAL_TOKEN_COUNT = 2;

/**
 * Workers AI does not expose the BGE tokenizer in the Worker binding. BGE uses
 * WordPiece tokenization, where each token accounts for at least one UTF-8
 * byte; reserving [CLS] and [SEP] makes bytes plus two a conservative upper
 * bound. This intentionally rejects some valid inputs to guarantee the model
 * input stays within its 512-token limit.
 */
export function estimateEmbeddingTokens(text: string): number {
  return new TextEncoder().encode(text).byteLength + SPECIAL_TOKEN_COUNT;
}

export const EmbeddingSizeReportSchema = Schema.Struct({
  source: Schema.Literal("bytes"),
  bytes_estimate: Schema.Number,
  max_bytes_estimate: Schema.Number,
  within_budget: Schema.Boolean,
  binding_limit: Schema.NullOr(Schema.Literal("bytes")),
  over_by_bytes: Schema.Number,
  remaining: Schema.Number,
  limits: Schema.Struct({
    bytes_estimate: Schema.Struct({
      value: Schema.Number,
      limit: Schema.Number,
      pass: Schema.Boolean,
    }),
  }),
});
export type EmbeddingSizeReport = typeof EmbeddingSizeReportSchema.Type;

/**
 * Reports the Worker's conservative byte+2 embedding budget for composed text.
 * Mirrors the CLI `size` / `--dry-run` payload shape that agents already parse.
 */
export function embeddingSizeReport(text: string): EmbeddingSizeReport {
  const bytesEstimate = estimateEmbeddingTokens(text);
  const overByBytes = Math.max(0, bytesEstimate - MAX_EMBEDDING_TOKENS);
  const withinBudget = overByBytes === 0;
  return {
    source: "bytes",
    bytes_estimate: bytesEstimate,
    max_bytes_estimate: MAX_EMBEDDING_TOKENS,
    within_budget: withinBudget,
    binding_limit: withinBudget ? null : "bytes",
    over_by_bytes: overByBytes,
    remaining: MAX_EMBEDDING_TOKENS - bytesEstimate,
    limits: {
      bytes_estimate: {
        value: bytesEstimate,
        limit: MAX_EMBEDDING_TOKENS,
        pass: withinBudget,
      },
    },
  };
}

export function validateEmbeddingText(text: string, label: string): string {
  if (estimateEmbeddingTokens(text) > MAX_EMBEDDING_TOKENS) {
    throw new Error(
      `${label} must be at most ${MAX_EMBEDDING_TOKENS} tokens for embedding.`,
    );
  }
  return text;
}

export type EmbeddingDocumentParts = {
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: string;
  readonly status: string;
  readonly certainty: string;
};

/** Compose the text that is embedded for a memory document (API + MCP). */
export function composeEmbeddingText(document: EmbeddingDocumentParts): string {
  return [
    document.content,
    document.tags ? `Tags: ${document.tags}` : undefined,
    document.context ? `Context: ${document.context}` : undefined,
    `Memory type: ${document.memory_type}`,
    `Status: ${document.status}`,
    `Certainty: ${document.certainty}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}
