import { Schema } from "effect";

import {
  EvidenceSchema,
  StoredEvidenceFieldsSchema,
  ValidationGapsSchema,
} from "./evidence";
import {
  CERTAINTY_LEVELS,
  MAX_NAMESPACE_BYTES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
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

export const SearchLimitSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: SEARCH_LIMIT_MAX }),
);

export const SearchLimitInputSchema = Schema.optionalKey(SearchLimitSchema);

export function normalizeSearchLimit(value: number | undefined): number {
  return value ?? SEARCH_LIMIT_DEFAULT;
}

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
  /** Kinds of evidence behind the claim; [] means unspecified. Not embedded. */
  evidence: EvidenceSchema,
  /** Known limits of the claim's validation. Not embedded. */
  validation_gaps: ValidationGapsSchema,
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
  ...StoredEvidenceFieldsSchema.fields,
});
export type StoredMemoryRow = typeof StoredMemoryRowSchema.Type;

export function normalizeStoredMemoryRow(row: StoredMemoryRow): MemoryRow {
  return {
    ...row,
    tags: row.tags ?? "",
    context: row.context ?? "",
    source_agent: row.source_agent ?? "",
    last_updated_by: row.last_updated_by ?? "",
    evidence: row.evidence ?? [],
    validation_gaps: row.validation_gaps ?? [],
  };
}
