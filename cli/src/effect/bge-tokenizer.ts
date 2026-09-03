import { Tokenizer } from "@huggingface/tokenizers";
import { Schema } from "effect";

export const BGE_MAX_EMBEDDING_TOKENS = 512;
export const BGE_TOKENIZER_FETCH_TIMEOUT_MS = 5_000;

const BGE_TOKENIZER_REVISION = "a5beb1e3e68b9ab74eb54cfd186867f64f240e1a";
const DEFAULT_BGE_TOKENIZER_URL = `https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/${BGE_TOKENIZER_REVISION}/tokenizer.json`;
const DEFAULT_BGE_TOKENIZER_CONFIG_URL = `https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/${BGE_TOKENIZER_REVISION}/tokenizer_config.json`;

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

export type BgeLargestPart = {
  readonly part: string;
  readonly amount: number;
  readonly unit: "tokens" | "bytes";
};

export type BgeTokenBreakdown = {
  readonly source: "tokenizer" | "bytes";
  readonly total_tokens: number;
  readonly max_tokens: number;
  readonly bytes_estimate: number;
  readonly within_limit: boolean;
  /** Binding constraint(s) when over budget; null when within budget. */
  readonly binding_limit: "tokens" | "bytes" | "both" | null;
  readonly over_by: number;
  readonly over_by_tokens: number;
  readonly over_by_bytes: number;
  readonly remaining: number;
  readonly parts: BgeTokenPart[];
  /** Σ(parts) − total. Each part is tokenized on its own, so special tokens
   *  ([CLS]/[SEP]) are counted once per part even though the composed text
   *  carries them once. */
  readonly overhead: number;
  /** Present only when over budget: the heaviest slice of the composed text. */
  readonly largest_part?: BgeLargestPart;
  /** Present only when over budget: a concrete, mechanically derived
   *  truncation of the content that would fit (preview, not a rewrite). */
  readonly trimmed_suggestion?: string;
};

/** Largest UTF-8-safe prefix of `text` that fits in `maxBytes` bytes. */
export function sliceUtf8Safe(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}

const SUGGESTION_HEAD_CHARS = 120;

function previewHead(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  const head =
    flattened.length > SUGGESTION_HEAD_CHARS
      ? `${flattened.slice(0, SUGGESTION_HEAD_CHARS)}…`
      : flattened;
  return head.length > 0 ? head : "(empty)";
}

/**
 * Mechanically derives the largest content truncation that satisfies the
 * byte+2 estimate, or an approximation scaled to the token deficit when the
 * tokenizer binds. Returns undefined when nothing needs trimming.
 */
function buildTrimmedSuggestion(
  parts: readonly EmbeddingTextPart[],
  options: { overByBytes: number; overByTokens: number },
): string | undefined {
  if (options.overByBytes <= 0 && options.overByTokens <= 0) {
    return undefined;
  }
  const contentPart = parts.find(
    (entry) => entry.part === "content" && entry.text.length > 0,
  );
  if (!contentPart) {
    return undefined;
  }
  const contentBytes = new TextEncoder().encode(contentPart.text).byteLength;
  let candidate: string;
  let note: string;
  if (options.overByBytes > 0) {
    // Precise: shrink content until the whole composed text passes byte+2.
    const otherText = composeEmbeddingText(
      parts.filter((entry) => entry !== contentPart),
    );
    const otherBytes =
      new TextEncoder().encode(otherText).byteLength +
      (otherText.length > 0 ? 1 : 0);
    candidate = sliceUtf8Safe(
      contentPart.text,
      BGE_MAX_EMBEDDING_TOKENS - 2 - otherBytes,
    );
    note = `truncating content to ~${new TextEncoder().encode(candidate).byteLength} bytes makes the byte+2 estimate fit`;
  } else {
    // Approximate: scale content down by the ratio needed to reach 511 tokens.
    const keptRatio =
      (BGE_MAX_EMBEDDING_TOKENS - 1) /
      (BGE_MAX_EMBEDDING_TOKENS - 1 + options.overByTokens);
    candidate = sliceUtf8Safe(
      contentPart.text,
      Math.floor(contentBytes * keptRatio),
    );
    note = `approximate: shortening content to ~${candidate.length} characters should bring the token count near the limit`;
  }
  return `${previewHead(candidate)} … (${note})`;
}

function largestPartOf(
  tokenizer: ((text: string) => number) | undefined,
  parts: readonly EmbeddingTextPart[],
): BgeLargestPart | undefined {
  const measured = parts
    .filter((entry) => entry.text.length > 0)
    .map((entry) => ({
      part: entry.part,
      amount: tokenizer
        ? tokenizer(entry.text)
        : new TextEncoder().encode(entry.text).byteLength,
    }));
  if (measured.length === 0) {
    return undefined;
  }
  const largest = measured.reduce((a, b) => (b.amount > a.amount ? b : a));
  return {
    part: largest.part,
    amount: largest.amount,
    unit: tokenizer ? "tokens" : "bytes",
  };
}

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
 * (api/src/embedding.ts): UTF-8 bytes plus one [CLS]/[SEP]
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
  const overByBytes = Math.max(0, total - BGE_MAX_EMBEDDING_TOKENS);
  return {
    source: "bytes",
    total_tokens: total,
    max_tokens: BGE_MAX_EMBEDDING_TOKENS,
    bytes_estimate: total,
    within_limit: overByBytes === 0,
    binding_limit: overByBytes > 0 ? "bytes" : null,
    over_by: overByBytes,
    over_by_tokens: 0,
    over_by_bytes: overByBytes,
    remaining: BGE_MAX_EMBEDDING_TOKENS - total,
    parts: [],
    overhead: 0,
    largest_part: overByBytes > 0 ? largestPartOf(undefined, parts) : undefined,
    trimmed_suggestion:
      overByBytes > 0
        ? buildTrimmedSuggestion(parts, { overByBytes, overByTokens: 0 })
        : undefined,
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
  // The token rule is "below 512", so the deficit is measured against 511.
  const overByTokens =
    total >= BGE_MAX_EMBEDDING_TOKENS
      ? total - (BGE_MAX_EMBEDDING_TOKENS - 1)
      : 0;
  const overByBytes = Math.max(0, bytesEstimate - BGE_MAX_EMBEDDING_TOKENS);
  const withinLimit = overByTokens === 0 && overByBytes === 0;
  return {
    source: "tokenizer",
    total_tokens: total,
    max_tokens: BGE_MAX_EMBEDDING_TOKENS,
    bytes_estimate: bytesEstimate,
    within_limit: withinLimit,
    binding_limit: withinLimit
      ? null
      : overByTokens > 0 && overByBytes > 0
        ? "both"
        : overByBytes > 0
          ? "bytes"
          : "tokens",
    over_by: Math.max(overByTokens, overByBytes),
    over_by_tokens: overByTokens,
    over_by_bytes: overByBytes,
    remaining: BGE_MAX_EMBEDDING_TOKENS - 1 - total,
    parts: counted,
    overhead: partTotal - total,
    largest_part: withinLimit
      ? undefined
      : largestPartOf((text) => countTokens(tokenizer, text), parts),
    trimmed_suggestion: withinLimit
      ? undefined
      : buildTrimmedSuggestion(parts, { overByBytes, overByTokens }),
  };
}

/** Fetches the BGE tokenizer and returns a token-precise breakdown. */
export async function analyzeBgeEmbedding(
  parts: readonly EmbeddingTextPart[],
): Promise<BgeTokenBreakdown> {
  return analyzeBgeEmbeddingWith(await getBgeTokenizer(), parts);
}

function composedSizeLine(breakdown: BgeTokenBreakdown, label: string): string {
  if (breakdown.source === "tokenizer") {
    return `${label} has ${breakdown.total_tokens}/${breakdown.max_tokens} embedding tokens; the embedding service byte estimate is ${breakdown.bytes_estimate}/${breakdown.max_tokens}.`;
  }
  return `${label} has ${breakdown.total_tokens}/${breakdown.max_tokens} embedding tokens (conservative byte estimate; tokenizer unavailable).`;
}

function deficitLines(breakdown: BgeTokenBreakdown, label: string): string[] {
  const lines: string[] = [];
  if (breakdown.over_by_bytes > 0) {
    const tokenNote =
      breakdown.over_by_tokens > 0 ? "" : " — the token count itself fits";
    lines.push(
      `${label} is over the 512-byte embedding estimate by ${breakdown.over_by_bytes} bytes${tokenNote}.`,
    );
  }
  if (breakdown.over_by_tokens > 0) {
    lines.push(
      `${label} is over the ${breakdown.max_tokens}-token embedding limit by ${breakdown.over_by_tokens} tokens.`,
    );
  }
  if (breakdown.binding_limit === "both") {
    lines.push(
      "Both limits bind; trim until the byte+2 estimate is at most 512 AND the token count is below 512.",
    );
  } else if (breakdown.over_by_bytes > 0 && breakdown.over_by_tokens === 0) {
    lines.push(
      `Trim at least ${breakdown.over_by_bytes} byte(s) from the composed text.`,
    );
  } else if (breakdown.over_by_tokens > 0) {
    lines.push(
      `Trim at least ${breakdown.over_by_tokens} token(s) — content and context are usually the largest contributors.`,
    );
  }
  return lines;
}

export function bgeEmbeddingLimitMessage(
  breakdown: BgeTokenBreakdown,
  label: string,
): string {
  const lines: string[] = [composedSizeLine(breakdown, label)];
  if (breakdown.source === "tokenizer") {
    for (const entry of breakdown.parts) {
      lines.push(`  ${entry.part}: ${entry.tokens} tokens`);
    }
    if (breakdown.overhead > 0) {
      lines.push(
        `  overhead: ${breakdown.overhead} tokens (special tokens counted once per part)`,
      );
    }
  } else {
    lines.push(
      "  (tokenizer unavailable: conservative byte estimate used; rerun where the BGE tokenizer is reachable for a precise breakdown)",
    );
  }
  lines.push(...deficitLines(breakdown, label));
  if (breakdown.largest_part) {
    lines.push(
      `  Largest part: ${breakdown.largest_part.part} (${breakdown.largest_part.amount} ${breakdown.largest_part.unit}).`,
    );
  }
  if (breakdown.trimmed_suggestion) {
    lines.push(`  Suggestion: ${breakdown.trimmed_suggestion}`);
  }
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
