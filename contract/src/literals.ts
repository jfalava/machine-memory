/** Shared wire vocabulary and limits for API, CLI, and MCP. */

export const MEMORY_TYPES = [
  "decision",
  "convention",
  "gotcha",
  "preference",
  "constraint",
  "reference",
  "status",
] as const;

export const CERTAINTY_LEVELS = [
  "verified",
  "inferred",
  "speculative",
] as const;

export const MEMORY_STATUSES = [
  "active",
  "deprecated",
  "superseded_by",
] as const;

export const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;

export const QUERY_OPERATIONS = ["run", "get", "all"] as const;

export const MIGRATION_ITEM_STATUSES = ["inserted", "duplicate"] as const;

/** Product/API search ceiling (Worker + MCP product routes). */
export const SEARCH_LIMIT_MAX = 50;

/** Default top_k / limit when the client omits it. */
export const SEARCH_LIMIT_DEFAULT = 8;

/**
 * CLI local UI may accept --limit up to this value. Remote/product paths still
 * clamp to SEARCH_LIMIT_MAX.
 */
export const CLI_LIMIT_MAX = 100;

/** Vectorize namespace / repository slug UTF-8 byte ceiling. */
export const MAX_NAMESPACE_BYTES = 64;

export const MAX_MIGRATION_ROWS = 50;
export const MAX_MIGRATION_LINKS = 100;

/** Upsert is strong only when similarity and FTS score both clear these bars. */
export const UPSERT_MIN_SIMILARITY = 0.62;
export const UPSERT_DEFAULT_MIN_SCORE = 32;

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5" as const;
export const EMBEDDING_DIMENSIONS = 768;
export const MAX_EMBEDDING_TOKENS = 512;

export const DEFAULT_MEMORY_TYPE = "convention" as const;
export const DEFAULT_MEMORY_STATUS = "active" as const;
export const DEFAULT_CERTAINTY = "inferred" as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Certainty = (typeof CERTAINTY_LEVELS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type SearchMode = (typeof SEARCH_MODES)[number];
export type QueryOperation = (typeof QUERY_OPERATIONS)[number];
