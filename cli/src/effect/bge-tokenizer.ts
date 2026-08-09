import { Tokenizer } from "@huggingface/tokenizers";

export const BGE_MAX_EMBEDDING_TOKENS = 512;

const BGE_TOKENIZER_URL =
  "https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/tokenizer.json";
const BGE_TOKENIZER_CONFIG_URL =
  "https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/tokenizer_config.json";

let tokenizerPromise: Promise<Tokenizer> | undefined;

async function readJson(url: string, description: string): Promise<object> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not load the BGE ${description} (HTTP ${response.status}).`,
    );
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The BGE ${description} was not a JSON object.`);
  }
  return value as object;
}

async function loadBgeTokenizer(): Promise<Tokenizer> {
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readJson(BGE_TOKENIZER_URL, "tokenizer definition"),
    readJson(BGE_TOKENIZER_CONFIG_URL, "tokenizer config"),
  ]);
  return new Tokenizer(tokenizerJson, tokenizerConfig);
}

function getBgeTokenizer(): Promise<Tokenizer> {
  tokenizerPromise ??= loadBgeTokenizer().catch((cause: unknown) => {
    tokenizerPromise = undefined;
    throw cause;
  });
  return tokenizerPromise;
}

export function countTokens(tokenizer: Tokenizer, text: string): number {
  return tokenizer.encode(text).ids.length;
}

export function assertBgeTokenCount(tokenCount: number, label: string): void {
  if (tokenCount >= BGE_MAX_EMBEDDING_TOKENS) {
    throw new Error(
      `${label} must be below ${BGE_MAX_EMBEDDING_TOKENS} tokens for embedding (received ${tokenCount}).`,
    );
  }
}

export async function validateBgeEmbeddingText(
  text: string,
  label: string,
): Promise<void> {
  const tokenCount = countTokens(await getBgeTokenizer(), text);
  assertBgeTokenCount(tokenCount, label);
}
