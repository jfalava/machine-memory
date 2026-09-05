import { Schema } from "effect";

import {
  CERTAINTY_LEVELS,
  DEFAULT_CERTAINTY,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_MEMORY_TYPE,
  MAX_NAMESPACE_BYTES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
} from "./literals";

export const MemoryTypeSchema = Schema.Literals(MEMORY_TYPES);
export const CertaintySchema = Schema.Literals(CERTAINTY_LEVELS);
export const MemoryStatusSchema = Schema.Literals(MEMORY_STATUSES);

const maxNamespaceBytes = Schema.makeFilter(
  (value: string) =>
    new TextEncoder().encode(value).byteLength <= MAX_NAMESPACE_BYTES,
  {
    expected: `repository must be at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes.`,
  },
);

/** Non-empty repository slug with the Worker namespace byte ceiling. */
export const RepositorySchema = Schema.NonEmptyString.check(maxNamespaceBytes);
export type Repository = typeof RepositorySchema.Type;

/**
 * Memory document fields used by vectorize upsert and shared product writes.
 * Wire keys are snake_case. Optional fields default when normalized.
 */
export const MemoryDocumentInputSchema = Schema.Struct({
  id: Schema.Union([Schema.NonEmptyString, Schema.Number]),
  repository: RepositorySchema,
  content: Schema.NonEmptyString,
  tags: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  status: Schema.optionalKey(MemoryStatusSchema),
  certainty: Schema.optionalKey(CertaintySchema),
});
export type MemoryDocumentInput = typeof MemoryDocumentInputSchema.Type;

export type MemoryDocument = {
  readonly id: string | number;
  readonly repository: string;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: MemoryType;
  readonly status: MemoryStatus;
  readonly certainty: Certainty;
};

export function normalizeMemoryDocument(
  input: MemoryDocumentInput,
): MemoryDocument {
  return {
    id: input.id,
    repository: input.repository,
    content: input.content,
    tags: input.tags ?? "",
    context: input.context ?? "",
    memory_type: input.memory_type ?? DEFAULT_MEMORY_TYPE,
    status: input.status ?? DEFAULT_MEMORY_STATUS,
    certainty: input.certainty ?? DEFAULT_CERTAINTY,
  };
}

/** Normalize the union id to a trimmed string after decode. */
export function memoryDocumentId(document: {
  readonly id: string | number;
}): string {
  return String(document.id).trim();
}

export const SearchLimitSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: SEARCH_LIMIT_MAX }),
);

export const SearchLimitInputSchema = Schema.optionalKey(SearchLimitSchema);

export function normalizeSearchLimit(value: number | undefined): number {
  return value ?? SEARCH_LIMIT_DEFAULT;
}

export const OptionalMemoryTypeSchema = Schema.optionalKey(MemoryTypeSchema);
export const OptionalCertaintySchema = Schema.optionalKey(CertaintySchema);
export const OptionalMemoryStatusSchema =
  Schema.optionalKey(MemoryStatusSchema);

export const OptionalTagsFilterSchema = Schema.optionalKey(Schema.String);

/** Memory fields returned in search summaries. */
export const MemorySummarySchema = Schema.Struct({
  id: Schema.Number,
  repository: Schema.String,
  content: Schema.String,
  tags: Schema.String,
  context: Schema.String,
  memory_type: MemoryTypeSchema,
  status: MemoryStatusSchema,
  certainty: CertaintySchema,
});
export type MemorySummary = typeof MemorySummarySchema.Type;

/** Full memory returned by get, list, and writes. refs is decoded JSON. */
export const MemoryRowSchema = Schema.Struct({
  ...MemorySummarySchema.fields,
  superseded_by: Schema.NullOr(Schema.Int),
  source_agent: Schema.String,
  last_updated_by: Schema.String,
  update_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  refs: Schema.Array(Schema.String),
  expires_after_days: Schema.NullOr(Schema.Int),
  created_at: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
});
export type MemoryRow = typeof MemoryRowSchema.Type;

/** SQLite stores refs as JSON text and allows null in optional text columns. */
export const StoredMemoryRowSchema = Schema.Struct({
  ...MemoryRowSchema.fields,
  tags: Schema.NullOr(Schema.String),
  context: Schema.NullOr(Schema.String),
  source_agent: Schema.NullOr(Schema.String),
  last_updated_by: Schema.NullOr(Schema.String),
  refs: Schema.fromJsonString(Schema.Array(Schema.String)),
});
export type StoredMemoryRow = typeof StoredMemoryRowSchema.Type;

export function normalizeStoredMemoryRow(row: StoredMemoryRow): MemoryRow {
  return {
    ...row,
    tags: row.tags ?? "",
    context: row.context ?? "",
    source_agent: row.source_agent ?? "",
    last_updated_by: row.last_updated_by ?? "",
  };
}
