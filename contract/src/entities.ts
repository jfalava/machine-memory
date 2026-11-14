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

const SLUG_SEGMENT = /^[A-Za-z0-9_.~-]+$/;

/**
 * Why `value` is not a repository slug, or undefined when it is one. A slug is
 * the remote's path: two or more `/`-separated segments, so a GitLab subgroup
 * keeps every segment, with an optional leading `@` (Amp namespaces).
 */
export function repositorySlugError(value: string): string | undefined {
  if (new TextEncoder().encode(value).byteLength > MAX_NAMESPACE_BYTES) {
    return `repository must be at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes.`;
  }
  const segments = value.replace(/^@/, "").split("/");
  if (
    segments.length < 2 ||
    !segments.every((segment) => SLUG_SEGMENT.test(segment))
  ) {
    return "repository must be a slug such as owner/name, @namespace/name or group/subgroup/name: letters, digits, '.', '_', '-' and '~' in two or more '/'-separated segments.";
  }
  return undefined;
}

/** Repository slug with the Worker namespace byte ceiling. */
export const RepositorySchema = Schema.String.check(
  Schema.makeFilter(
    (value: string) => repositorySlugError(value) === undefined,
    {
      expected: `a repository slug such as owner/name, @namespace/name or group/subgroup/name, at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes`,
    },
  ),
);
export type Repository = typeof RepositorySchema.Type;

const JUNK_CONTENT = new Set(["null", "undefined"]);

/**
 * Why `content` cannot be stored as a memory, or undefined when it can. Shells
 * and string coercion turn a missing value into the words null and undefined.
 */
export function memoryContentError(content: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed === "") {
    return "Memory content is empty.";
  }
  if (JUNK_CONTENT.has(trimmed.toLowerCase())) {
    return `Memory content is the literal '${trimmed}', which is a missing value, not a memory.`;
  }
  return undefined;
}

/** Memory content that is not blank and not a coerced missing value. */
export const MemoryContentSchema = Schema.String.check(
  Schema.makeFilter(
    (value: string) => memoryContentError(value) === undefined,
    { expected: "memory content that is not empty, 'null' or 'undefined'" },
  ),
);

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
  id: Schema.Finite,
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
