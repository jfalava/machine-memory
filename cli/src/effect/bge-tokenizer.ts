import { Tokenizer } from "@huggingface/tokenizers";
import { Schema } from "effect";

export const BGE_MAX_EMBEDDING_TOKENS = 512;
export const BGE_TOKENIZER_FETCH_TIMEOUT_MS = 5_000;

const BGE_TOKENIZER_REVISION =
  "a5beb1e3e68b9ab74eb54cfd186867f64f240e1a";
const DEFAULT_BGE_TOKENIZER_URL =
  `https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/${BGE_TOKENIZER_REVISION}/tokenizer.json`;
const DEFAULT_BGE_TOKENIZER_CONFIG_URL =
  `https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/${BGE_TOKENIZER_REVISION}/tokenizer_config.json`;

/**
 * The BGE tokenizer and its config are fetched from Hugging Face at runtime.
 * These env overrides exist so tests and air-gapped deployments can point at a
 * mirror or embed the two JSON files locally.
 */
const BGE_TOKENIZER_URL =
  process.env["MACHINE_MEMORY_BGE_TOKENIZER_URL"] ?? DEFAULT_BGE_TOKENIZER_URL;
const BGE_TOKENIZER_CONFIG_URL =
  process.env["MACHINE_MEMORY_BGE_TOKENIZER_CONFIG_URL"] ??
  DEFAULT_BGE_TOKENIZER_CONFIG_URL;

let tokenizerPromise: Promise<Tokenizer> | undefined;

async function readJson(url: string, description: string): Promise<object> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    BGE_TOKENIZER_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `Could not load the BGE ${description} (HTTP ${response.status}).`,
      );
    }
    return Schema.decodeUnknownSync(
      Schema.Record(Schema.String, Schema.MutableJson),
    )(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function loadBgeTokenizer(): Promise<Tokenizer> {
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readJson(BGE_TOKENIZER_URL, "tokenizer definition"),
    readJson(BGE_TOKENIZER_CONFIG_URL, "tokenizer config"),
  ]);
  return new Tokenizer(tokenizerJson, tokenizerConfig);
}

function getBgeTokenizer(): Promise<Tokenizer> {
  return (tokenizerPromise ??= loadBgeTokenizer());
}

export function countTokens(tokenizer: Tokenizer, text: string): number {
  return tokenizer.encode(text).ids.length;
}

export function assertBgeTokenCount(tokenCount: number, label: string): void {
  if (tokenCount >= BGE_MAX_EMBEDDING_TOKENS) {
    throw new Error(
      `${label} must be below ${BGE_MAX_EMBEDDING_TOKENS} tokens for embedding (received ${tokenCount}). ` +
        `Trim at least ${tokenCount - (BGE_MAX_EMBEDDING_TOKENS - 1)} token(s) to fit.`,
    );
  }
}

export async function validateBgeEmbeddingText(
  text: string,
  label: string,
): Promise<void> {
  let tokenizer: Tokenizer;
  try {
    tokenizer = await getBgeTokenizer();
  } catch {
    assertBgeBreakdown(
      analyzeEmbeddingByBytes([{ part: "content", text }]),
      label,
    );
    return;
  }
  const tokenCount = countTokens(tokenizer, text);
  assertBgeTokenCount(tokenCount, label);
}

/**
 * A slice of the composed embedding text. The `text` for an optional slice
 * (tags, context) is the empty string when absent so it contributes nothing.
 */
export type EmbeddingTextPart = {
  readonly part: string;
  readonly text: string;
};

export type BgeTokenPart = {
  readonly part: string;
  readonly tokens: number;
};

export type BgeTokenBreakdown = {
  readonly source: "tokenizer" | "bytes";
  readonly total_tokens: number;
  readonly max_tokens: number;
  readonly bytes_estimate: number;
  readonly within_limit: boolean;
  readonly over_by: number;
  readonly remaining: number;
  readonly parts: BgeTokenPart[];
  /** Σ(parts) − total. Each part is tokenized on its own, so special tokens
   *  ([CLS]/[SEP]) are counted once per part even though the composed text
   *  carries them once. */
  readonly overhead: number;
};

/**
 * Composes the embedding text exactly like the embedding service sees it:
 * non-empty slices joined by newlines.
 */
export function composeEmbeddingText(
  parts: readonly EmbeddingTextPart[],
): string {
  return parts
    .filter((entry) => entry.text.length > 0)
    .map((entry) => entry.text)
    .join("\n");
}

/**
 * Conservative fallback mirroring the Worker's byte estimate
 * (remote-db/cloudflare/src/embedding.ts): UTF-8 bytes plus one [CLS]/[SEP]
 * reserve. Used when the real tokenizer cannot be fetched so offline writes
 * stay safe without blocking on the network.
 */
export function estimateEmbeddingBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength + 2;
}

export function analyzeEmbeddingByBytes(
  parts: readonly EmbeddingTextPart[],
): BgeTokenBreakdown {
  const total = estimateEmbeddingBytes(composeEmbeddingText(parts));
  return {
    source: "bytes",
    total_tokens: total,
    max_tokens: BGE_MAX_EMBEDDING_TOKENS,
    bytes_estimate: total,
    within_limit: total <= BGE_MAX_EMBEDDING_TOKENS,
    over_by: total > BGE_MAX_EMBEDDING_TOKENS ? total - BGE_MAX_EMBEDDING_TOKENS : 0,
    remaining: BGE_MAX_EMBEDDING_TOKENS - total,
    parts: [],
    overhead: 0,
  };
}

/**
 * Token-precise breakdown using a tokenizer that is already in hand.
 *
 * `within_limit` binds on BOTH the real token count (must stay below 512) and
 * the embedding service's conservative byte estimate (the Worker sums the
 * UTF-8 byte length plus one [CLS]/[SEP] reserve and rejects above 512). A
 * memory can fit the tokenizer yet still be rejected by the Worker (for
 * example long runs of short words), so the conservative bound is enforced
 * too. `over_by` reflects the binding constraint.
 */
export function analyzeBgeEmbeddingWith(
  tokenizer: Tokenizer,
  parts: readonly EmbeddingTextPart[],
): BgeTokenBreakdown {
  const composed = composeEmbeddingText(parts);
  const bytesEstimate = estimateEmbeddingBytes(composed);
  const total = countTokens(tokenizer, composed);
  const counted = parts
    .filter((entry) => entry.text.length > 0)
    .map((entry) => ({
      part: entry.part,
      tokens: countTokens(tokenizer, entry.text),
    }));
  const partTotal = counted.reduce((sum, entry) => sum + entry.tokens, 0);
  const tokenOver = total >= BGE_MAX_EMBEDDING_TOKENS
    ? total - (BGE_MAX_EMBEDDING_TOKENS - 1)
    : 0;
  const byteOver =
    bytesEstimate > BGE_MAX_EMBEDDING_TOKENS
      ? bytesEstimate - BGE_MAX_EMBEDDING_TOKENS
      : 0;
  return {
    source: "tokenizer",
    total_tokens: total,
    max_tokens: BGE_MAX_EMBEDDING_TOKENS,
    bytes_estimate: bytesEstimate,
    within_limit:
      total < BGE_MAX_EMBEDDING_TOKENS &&
      bytesEstimate <= BGE_MAX_EMBEDDING_TOKENS,
    over_by: Math.max(tokenOver, byteOver),
    remaining: BGE_MAX_EMBEDDING_TOKENS - 1 - total,
    parts: counted,
    overhead: partTotal - total,
  };
}

/** Fetches the BGE tokenizer and returns a token-precise breakdown. */
export async function analyzeBgeEmbedding(
  parts: readonly EmbeddingTextPart[],
): Promise<BgeTokenBreakdown> {
  return analyzeBgeEmbeddingWith(await getBgeTokenizer(), parts);
}

export function bgeEmbeddingLimitMessage(
  breakdown: BgeTokenBreakdown,
  label: string,
): string {
  const lines: string[] = [];
  if (breakdown.source === "tokenizer") {
    lines.push(
      `${label} has ${breakdown.total_tokens}/${breakdown.max_tokens} embedding tokens; the embedding service byte estimate is ${breakdown.bytes_estimate}/${breakdown.max_tokens}.`,
    );
    for (const entry of breakdown.parts) {
      lines.push(`  ${entry.part}: ${entry.tokens} tokens`);
    }
    if (breakdown.overhead > 0) {
      lines.push(
        `  overhead: ${breakdown.overhead} tokens (special tokens counted once per part)`,
      );
    }
    if (
      breakdown.bytes_estimate > breakdown.max_tokens &&
      breakdown.total_tokens < breakdown.max_tokens
    ) {
      lines.push(
        "  The token count fits, but the embedding service rejects text whose byte+2 estimate exceeds 512 — shorten the content.",
      );
    }
  } else {
    lines.push(
      `${label} has ${breakdown.total_tokens}/${breakdown.max_tokens} embedding tokens (conservative byte estimate; tokenizer unavailable).`,
    );
  }
  if (breakdown.source === "bytes") {
    lines.push(
      "  (tokenizer unavailable: conservative byte estimate used; rerun where the BGE tokenizer is reachable for a precise breakdown)",
    );
  }
  lines.push(
    `Trim at least ${breakdown.over_by} token(s) — content and context are usually the largest contributors.`,
  );
  return lines.join("\n");
}

export function assertBgeBreakdown(
  breakdown: BgeTokenBreakdown,
  label: string,
): void {
  if (!breakdown.within_limit) {
    throw new Error(bgeEmbeddingLimitMessage(breakdown, label));
  }
}
