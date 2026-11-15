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

/**
 * What a claim rests on. Certainty says how sure; evidence says why. A record
 * can hold several kinds, and each kind covers only its own dimension.
 */
export const EVIDENCE_KINDS = [
  "user_requirement",
  "observed_implementation",
  "verified_mechanism",
  "tested_behavior",
] as const;

/** Validation gaps are short notes, not documents; they are never embedded. */
export const VALIDATION_GAPS_MAX = 16;
export const VALIDATION_GAP_MAX_CHARS = 300;

export const MEMORY_STATUSES = [
  "active",
  "deprecated",
  "superseded_by",
] as const;

export const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;

/** Absolute per-result relevance label, independent of batch-relative scores. */
export const MATCH_STRENGTHS = ["strong", "weak", "none"] as const;

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

/**
 * Upsert updates a match only when the new content restates it (similarity)
 * and the upsert query fits it (rank score). The best full-text candidate
 * scores 30 before anything else counts, so 50 also asks for most of the
 * query's terms. Measured on three repositories (2026-11-15): every query
 * written from a record's own words scored 53 or more for that record, and 59
 * of 75 queries taken from another repository scored below 50.
 */
export const UPSERT_MIN_SIMILARITY = 0.62;
export const UPSERT_DEFAULT_MIN_SCORE = 50;

/**
 * bge-m3 accepts 8,192 tokens and rejects longer input instead of truncating
 * it. Changing the model or its dimensions needs a new Vectorize index (see
 * vectorIndexName in iac) and a full reindex.
 */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3" as const;
export const EMBEDDING_DIMENSIONS = 1024;
/**
 * Cap on a memory's embedded text (content, tags and context) and on a search
 * query, in UTF-8 bytes. Far below what the model accepts on purpose: one
 * vector for a long, multi-topic record matches everything weakly.
 */
export const MAX_EMBEDDING_BYTES = 2000;

export const DEFAULT_MEMORY_TYPE = "convention" as const;
export const DEFAULT_MEMORY_STATUS = "active" as const;
export const DEFAULT_CERTAINTY = "inferred" as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Certainty = (typeof CERTAINTY_LEVELS)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type SearchMode = (typeof SEARCH_MODES)[number];
export type MatchStrength = (typeof MATCH_STRENGTHS)[number];
