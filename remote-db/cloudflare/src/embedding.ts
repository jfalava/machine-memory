export const MAX_EMBEDDING_TOKENS = 512;

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

export function validateEmbeddingText(text: string, label: string): string {
  if (estimateEmbeddingTokens(text) > MAX_EMBEDDING_TOKENS) {
    throw new Error(
      `${label} must be at most ${MAX_EMBEDDING_TOKENS} tokens for embedding.`,
    );
  }
  return text;
}
